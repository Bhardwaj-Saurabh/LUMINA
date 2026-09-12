/**
 * AgentLoop — ARCHITECTURE.md §3.1: research (tool-use turns) → validated sources →
 * guarded streaming synthesis. Owns the semantics (budget admission, trace/source/token
 * ordering, explicit `terminated` at every exit); the HTTP route owns transport.
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

export async function runLoop(input: RunLoopInput): Promise<RunLoopOutcome> {
  const { llm, registry, depth, budget, collector, emitter, now, price } = input;
  const startedAt = now();
  const tools = registry.forDepth(depth).map(toToolSpec);
  const messages: LlmMessage[] = [...(input.history ?? []), { role: 'user', content: input.query }];

  // --- research: tool-use turns until natural end_turn or refused admission (cap) ------
  let terminated: Terminated = 'done';
  let step = 0;
  const makeSignal = input.makeSignal ?? ((ms: number) => AbortSignal.timeout(ms));

  research: for (;;) {
    // §3.1: a hung provider call must not outlive the request budget (found live: a turn
    // that ran 295 s on a 90 s quick cap because nothing aborted it).
    const remaining = budget.remainingMs();
    if (remaining <= 0) {
      terminated = 'cap';
      break research;
    }
    const signal = makeSignal(remaining);
    let turn;
    try {
      turn = await llm.runTurn({ system: SYSTEM_PROMPT, messages, tools, signal });
    } catch (err) {
      if (signal.aborted) {
        terminated = 'cap'; // the budget ended the turn, not the provider
        break research;
      }
      emitter.error({ status: 502, error: errorText(err) });
      return { terminated: 'error' };
    }
    budget.recordUsage({ tokensIn: turn.usage.in, tokensOut: turn.usage.out, costUsd: price(turn.usage) });
    messages.push({
      role: 'assistant',
      content: turn.text ?? '',
      ...(turn.toolCalls.length > 0 ? { toolCalls: turn.toolCalls } : {})
    });
    if (turn.stopReason === 'end_turn') break; // natural finish — done even if now exhausted

    // Reserve before dispatch; a refusal while the model still wanted the tool is a cap.
    const admitted = [];
    for (const call of turn.toolCalls) {
      if (!budget.tryReserveToolCall()) {
        terminated = 'cap';
        break;
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
        const reason = typeof call.input.reason === 'string' ? { reason: call.input.reason } : {};
        try {
          const result = await registry.dispatch(call.name, call.input, { depth });
          emitter.trace({ step: stepN, tool, input: call.input, ok: true, ms: now() - t0, ...reason });
          return { toolCallId: call.id, ok: true, content: JSON.stringify(result) };
        } catch (err) {
          // A1: the failure is visibly a failure, to the reader and to the model alike.
          const error = errorText(err);
          emitter.trace({ step: stepN, tool, input: call.input, ok: false, ms: now() - t0, error, ...reason });
          return { toolCallId: call.id, ok: false, content: error };
        }
      })
    );
    if (terminated === 'cap') break research; // honest partial from evidence already collected
    messages.push({ role: 'tool_results', results });
  }

  // --- grounding boundary: freeze the collector, sources strictly before token #1 ------
  const sources = collector.finalize();
  emitter.sources(sources);

  let fullText = '';
  let ttftMs: number | undefined;
  const synthesisMs = budget.remainingMs();
  if (synthesisMs <= 0) {
    // §3.1 "reserve the finish": no generation allowance left — a deterministic,
    // clearly incomplete summary, without another provider call. No [n] → audit passes.
    const partial =
      'The time budget was exhausted before an answer could be synthesized. ' +
      (sources.length > 0
        ? 'The sources listed were retrieved but not yet read into an answer.'
        : 'No evidence was retrieved.');
    emitter.token({ text: partial });
    fullText = partial;
    terminated = 'cap';
  } else {
    const signal = makeSignal(synthesisMs);
    try {
      const synthesis = llm.streamText({ system: SYSTEM_PROMPT, messages, signal });
      for await (const delta of synthesis.stream) {
        if (ttftMs === undefined) ttftMs = now() - startedAt;
        emitter.token({ text: delta });
        fullText += delta;
      }
      const usage = await synthesis.usage();
      budget.recordUsage({ tokensIn: usage.in, tokensOut: usage.out, costUsd: price(usage) });
    } catch (err) {
      if (!signal.aborted) {
        emitter.error({ status: 502, error: errorText(err) });
        return { terminated: 'error' };
      }
      // Budget cut synthesis short: the visible answer is incomplete and says so via
      // terminated:'cap' — provided its citations still resolve (checked below).
      terminated = 'cap';
    }
  }

  const dangling = unresolvedCitations(fullText, sources);
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
