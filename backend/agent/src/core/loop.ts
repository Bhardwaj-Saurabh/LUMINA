/**
 * AgentLoop — ARCHITECTURE.md §3.1: research (tool-use turns) → validated sources →
 * the answer. Optimistic streaming: the answer IS a turn, so a turn that emits text before
 * asking for a tool is the synthesis — one provider round trip per turn, including the last.
 * Owns the semantics (budget admission, trace/source/token ordering, explicit `terminated`
 * at every exit); the HTTP route owns transport.
 *
 * In-band failures (provider throw, dangling citation) RESOLVE with terminated:'error'
 * after emitting the SSE error frame — runLoop never throws for them.
 */
import {
  unresolvedCitations,
  type Depth,
  type DoneEvent,
  type PlanEvent,
  type SourcesEvent,
  type StreamErrorEvent,
  type Terminated,
  type TokenEvent,
  type TraceEvent
} from '@lumina/contract';
import type {
  LlmMessage,
  LlmPort,
  LlmToolSpec,
  LlmUsage,
  RunTurnResult,
  ToolCallRequest,
  ToolResultPart
} from '../providers/llm/port.js';
import type { Budget } from './budget.js';
import type { SourceCollector } from './sourceCollector.js';
import type { ToolDef, ToolRegistry } from './registry.js';

/** §3.1 "SSE decoupling": the loop receives this, never an Express Response. */
export interface AskEmitter {
  plan(data: PlanEvent): void;
  trace(data: TraceEvent): void;
  sources(data: SourcesEvent): void;
  token(data: TokenEvent): void;
  done(data: DoneEvent): void;
  error(data: StreamErrorEvent): void;
}

export interface RunLoopInput {
  llm: LlmPort;
  registry: ToolRegistry;
  depth: Depth;
  budget: Budget;
  collector: SourceCollector;
  emitter: AskEmitter;
  query: string;
  history?: LlmMessage[];
  now: () => number;
  answerId: string;
  model: string;
  price: (usage: LlmUsage) => number;
  /** Evaluated at done-time; true only when every search in the request was a cache hit. */
  searchCached: () => boolean;
  /**
   * Deadline signal factory (default AbortSignal.timeout) — injectable so tests control
   * time. An abort fired by this signal is a BUDGET event and maps to cap, never error.
   */
  makeSignal?: (ms: number) => AbortSignal;
}

export interface RunLoopOutcome {
  terminated: Terminated;
}

const SYSTEM_PROMPT =
  'You are LUMINA, a grounded answer engine. Research with the provided tools, then ' +
  'answer citing only sources retrieved in this request as [n]. If nothing was ' +
  'retrieved, answer honestly without citations.';

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.trim() || 'unknown error';
}

function toToolSpec(def: ToolDef): LlmToolSpec {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputJsonSchema ?? { type: 'object' }
  };
}

type TurnOutcome =
  | { kind: 'turn'; result: RunTurnResult; answered: boolean }
  | { kind: 'cap' }
  | { kind: 'error'; err: unknown };

export async function runLoop(input: RunLoopInput): Promise<RunLoopOutcome> {
  const { llm, registry, depth, budget, collector, emitter, now, price } = input;
  const startedAt = now();
  const tools = registry.forDepth(depth).map(toToolSpec);
  const messages: LlmMessage[] = [...(input.history ?? []), { role: 'user', content: input.query }];
  const makeSignal = input.makeSignal ?? ((ms: number) => AbortSignal.timeout(ms));

  let terminated: Terminated = 'done';
  let step = 0;
  let sources: SourcesEvent | undefined;
  let fullText = '';
  let ttftMs: number | undefined;

  /** The grounding boundary: freeze the collector once, strictly before token #1. */
  const openAnswer = (): SourcesEvent => {
    if (!sources) {
      sources = collector.finalize();
      emitter.sources(sources);
    }
    return sources;
  };
  const emitToken = (text: string) => {
    openAnswer();
    if (ttftMs === undefined) ttftMs = now() - startedAt;
    emitter.token({ text });
    fullText += text;
  };
  const fail = (err: unknown): RunLoopOutcome => {
    emitter.error({ status: 502, error: errorText(err) });
    return { terminated: 'error' };
  };
  const reasonOf = (call: ToolCallRequest) =>
    typeof call.input.reason === 'string' ? { reason: call.input.reason } : {};

  /**
   * ONE provider round trip. Deltas become tokens as they arrive — a turn that speaks
   * before it asks for a tool IS the answer, so there is no second synthesis call. The
   * stream must be drained before `result()`, which the provider only sends last.
   */
  const streamTurn = async (advertised: LlmToolSpec[]): Promise<TurnOutcome> => {
    // §3.1: a hung provider call must not outlive the request budget (found live: a turn
    // that ran 295 s on a 90 s quick cap because nothing aborted it).
    const remaining = budget.remainingMs();
    if (remaining <= 0) return { kind: 'cap' };
    const signal = makeSignal(remaining);
    let answered = false;
    try {
      const turn = llm.streamTurn({ system: SYSTEM_PROMPT, messages, tools: advertised, signal });
      for await (const delta of turn.stream) {
        answered = true;
        emitToken(delta);
      }
      const result = await turn.result();
      budget.recordUsage({ tokensIn: result.usage.in, tokensOut: result.usage.out, costUsd: price(result.usage) });
      return { kind: 'turn', result, answered };
    } catch (err) {
      if (signal.aborted) return { kind: 'cap' }; // the budget ended the turn, not the provider
      return { kind: 'error', err };
    }
  };

  // --- turns until the model answers, or admission is refused (cap) --------------------
  let capped = false;
  research: for (;;) {
    const outcome = await streamTurn(tools);
    if (outcome.kind === 'error') return fail(outcome.err);
    if (outcome.kind === 'cap') {
      terminated = 'cap';
      capped = true;
      break research;
    }
    const { result, answered } = outcome;

    if (answered) {
      // Sources are frozen and tokens are on the wire: a tool call arriving with the result
      // is too late to ground anything. Dropped — but visibly, with a reason (A1).
      for (const call of result.toolCalls) {
        emitter.trace({
          step: ++step,
          tool: call.name as TraceEvent['tool'],
          input: call.input,
          ok: false,
          ms: 0,
          error: `not executed: ${call.name} was requested after the answer had begun streaming`,
          ...reasonOf(call)
        });
      }
      break research;
    }
    if (result.toolCalls.length === 0) break research; // said nothing, asked for nothing

    messages.push({ role: 'assistant', content: result.text ?? '', toolCalls: result.toolCalls });

    // Reserve before dispatch; a refusal while the model still wanted the tool is a cap.
    const admitted: ToolCallRequest[] = [];
    const refused: ToolCallRequest[] = [];
    for (const call of result.toolCalls) {
      if (capped || !budget.tryReserveToolCall()) {
        capped = true;
        refused.push(call);
        continue;
      }
      admitted.push(call);
    }

    // All admitted calls of one turn run concurrently and return as ONE tool_results message.
    const results: ToolResultPart[] = await Promise.all(
      admitted.map(async (call) => {
        const stepN = ++step;
        const t0 = now();
        // TraceEvent.tool is the contract enum; a hallucinated name is rejected by dispatch
        // (registry lookup) and the contract cannot represent its trace frame.
        const tool = call.name as TraceEvent['tool'];
        try {
          const dispatched = await registry.dispatch(call.name, call.input, { depth });
          emitter.trace({ step: stepN, tool, input: call.input, ok: true, ms: now() - t0, ...reasonOf(call) });
          return { toolCallId: call.id, ok: true, content: JSON.stringify(dispatched) };
        } catch (err) {
          // A1: the failure is visibly a failure, to the reader and to the model alike.
          const error = errorText(err);
          emitter.trace({ step: stepN, tool, input: call.input, ok: false, ms: now() - t0, error, ...reasonOf(call) });
          return { toolCallId: call.id, ok: false, content: error };
        }
      })
    );
    for (const call of refused) {
      results.push({ toolCallId: call.id, ok: false, content: 'not executed: the request budget was exhausted' });
    }
    messages.push({ role: 'tool_results', results });
    if (capped) {
      terminated = 'cap'; // honest partial from evidence already collected
      break research;
    }
  }

  // --- the capped finish: the answer the model never got to give -----------------------
  if (capped && ttftMs === undefined) {
    const remaining = budget.remainingMs();
    if (remaining <= 0) {
      // §3.1 "reserve the finish": no allowance left for another call — a deterministic,
      // clearly incomplete summary. No [n] → the citation audit passes.
      const frozen = openAnswer();
      emitToken(
        'The time budget was exhausted before an answer could be synthesized. ' +
          (frozen.length > 0
            ? 'The sources listed were retrieved but not yet read into an answer.'
            : 'No evidence was retrieved.')
      );
    } else {
      // Advertise NO tools: once the budget has refused a call, offering more only invites
      // one it must refuse again. Tool-free, this turn can only answer.
      const finish = await streamTurn([]);
      if (finish.kind === 'error') return fail(finish.err);
    }
  }

  // Sources precede done on every path, including empty retrieval and a silent turn.
  const dangling = unresolvedCitations(fullText, openAnswer());
  if (dangling.length > 0) {
    emitter.error({
      status: 502,
      error: `grounding failure: citations ${dangling.map((n) => `[${n}]`).join(' ')} resolve to no source`
    });
    return { terminated: 'error' };
  }

  const { tokens, costUsd } = budget.snapshot();
  emitter.done({
    answerId: input.answerId,
    latencyMs: now() - startedAt,
    ttftMs: ttftMs ?? now() - startedAt,
    model: input.model,
    tokens,
    costUsd,
    searchCached: input.searchCached(),
    terminated,
    depth
  });
  return { terminated };
}
