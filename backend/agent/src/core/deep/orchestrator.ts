/**
 * Deep search — ARCHITECTURE.md §3.2 / SPEC 5.5. Plan, fan out, merge, synthesise.
 *
 * The shape is deliberate. Deep is not "quick with a bigger budget": it commits to a
 * decomposition BEFORE it retrieves anything, and that commitment is streamed so a reader
 * can judge it while the search runs. Everything after the plan is attributable to one of
 * its sub-questions — a merged source list nobody can trace back to a question is a pile.
 *
 * Three properties are structural rather than prompt-level:
 *   - the `plan` frame is emitted before the first retrieval, always;
 *   - each sub-question researches through its OWN registry, whose tools close over that
 *     sub-question's index, so a source cannot be minted without its attribution;
 *   - all sub-questions share ONE SourceCollector and ONE Budget, so the merged numbering
 *     is contiguous and deduped, and the fan-out cannot spend more than the gear allows.
 *
 * One research turn per sub-question, on purpose: the model may ask for several tools in
 * that turn and they run concurrently, but a sub-question cannot recurse into its own
 * research loop. Six sub-questions × unbounded rounds is how a deep search quietly becomes
 * a $5 answer; the cap exists to be reached rarely, not routinely.
 */
import {
  unresolvedCitations,
  type DoneEvent,
  type PlanEvent,
  type SourcesEvent,
  type Terminated,
  type TraceEvent
} from '@lumina/contract';
import type {
  LlmMessage,
  LlmPort,
  LlmToolSpec,
  LlmUsage,
  ToolCallRequest
} from '../../providers/llm/port.js';
import type { Budget } from '../budget.js';
import type { SourceCollector } from '../sourceCollector.js';
import type { ToolDef, ToolRegistry } from '../registry.js';
import type { AskEmitter } from '../loop.js';

export interface RunDeepInput {
  llm: LlmPort;
  /** One registry per sub-question; its tools tag everything they mint with that index. */
  registryFor: (subQuestion: number) => ToolRegistry;
  budget: Budget;
  collector: SourceCollector;
  emitter: AskEmitter;
  query: string;
  history?: LlmMessage[];
  now: () => number;
  answerId: string;
  model: string;
  price: (usage: LlmUsage) => number;
  searchCached: () => boolean;
  /** Injected so the orchestrator is testable without a provider (see planner.ts). */
  planner: (query: string) => Promise<PlanEvent>;
  /** Sub-questions in flight at once. Three balances wall-clock against provider limits. */
  concurrency?: number;
  makeSignal?: (ms: number) => AbortSignal;
}

export interface RunDeepOutcome {
  terminated: Terminated;
}

const RESEARCH_PROMPT =
  'You are LUMINA researching ONE sub-question of a larger deep search. Call the tools you ' +
  "need to gather evidence for it — nothing else. Use the sub-question's own wording as the " +
  'search query unless it is too vague to search. Do not write prose: this turn is for ' +
  'retrieval only, and another turn will write the answer.';

const SYNTHESIS_PROMPT =
  'You are LUMINA, a grounded answer engine, writing the final answer of a DEEP search. ' +
  'You are given the plan you committed to and the evidence each sub-question turned up, ' +
  'already numbered. Write a structured answer that addresses the sub-questions and cites ' +
  'ONLY those numbers as [n]. Every [n] you write must be one of the numbers listed. If a ' +
  'sub-question turned up nothing, say so plainly rather than filling the gap from memory.';

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.trim() || 'unknown error';
}

const toToolSpec = (def: ToolDef): LlmToolSpec => ({
  name: def.name,
  description: def.description,
  inputSchema: def.inputJsonSchema ?? { type: 'object' }
});

/** Bounded-concurrency map; the whole of our p-limit need, without the dependency. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      out[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function runDeep(input: RunDeepInput): Promise<RunDeepOutcome> {
  const { llm, budget, collector, emitter, now, price } = input;
  const startedAt = now();
  const makeSignal = input.makeSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const depth = 'deep' as const;

  let step = 0;
  let capped = false;
  const nextStep = () => ++step;

  const fail = (err: unknown): RunDeepOutcome => {
    emitter.error({ status: 502, error: errorText(err) });
    return { terminated: 'error' };
  };

  // --- 1. the plan, before anything is retrieved -------------------------------------
  let plan: PlanEvent;
  const planStartedAt = now();
  try {
    plan = await input.planner(input.query);
  } catch (err) {
    // No plan means no deep search. Emitting a plan frame we did not earn, or silently
    // degrading to a quick search the user did not ask for, would both be lies.
    return fail(err);
  }
  emitter.plan(plan);
  emitter.trace({
    step: nextStep(),
    tool: 'plan_research',
    input: { query: input.query },
    ok: true,
    ms: now() - planStartedAt
  });

  // --- 2. the fan-out ----------------------------------------------------------------
  const dispatchWithDeadline = async (
    registry: ToolRegistry,
    call: ToolCallRequest
  ): Promise<unknown> => {
    const signal = makeSignal(Math.max(budget.remainingMs(), 0));
    const abandoned = new Promise<never>((_, reject) => {
      const giveUp = () =>
        reject(new Error(`${call.name} abandoned: it outlived the request budget`));
      if (signal.aborted) giveUp();
      else signal.addEventListener('abort', giveUp, { once: true });
    });
    abandoned.catch(() => undefined);
    return Promise.race([registry.dispatch(call.name, call.input, { depth, signal }), abandoned]);
  };

  /**
   * Why each sub-question produced nothing, if it produced nothing. A fan-out where every
   * branch failed is NOT an answer with no sources — it is a failed request, and saying so
   * is the difference between an honest empty answer and a laundered provider exception.
   */
  const failures = new Map<number, string>();

  const researchOne = async (sub: PlanEvent['subQuestions'][number]): Promise<void> => {
    const registry = input.registryFor(sub.i);
    const tools = registry.forDepth(depth).map(toToolSpec);
    if (tools.length === 0) {
      failures.set(sub.i, 'no retrieval tool was available for this request');
      return;
    }

    const remaining = budget.remainingMs();
    if (remaining <= 0) {
      capped = true;
      failures.set(sub.i, 'the request budget ran out before this sub-question was researched');
      return;
    }
    const signal = makeSignal(remaining);
    const messages: LlmMessage[] = [{ role: 'user', content: sub.question }];

    let result;
    try {
      // Retrieval only: `required` because a research turn that declines to retrieve has
      // spent a provider call to say nothing.
      const turn = llm.streamTurn({
        system: RESEARCH_PROMPT,
        messages,
        tools,
        toolChoice: 'required',
        signal
      });
      // A research turn should not speak; anything it says here is drained and discarded
      // rather than leaked into the answer, which has not begun streaming yet. The stream
      // must still be consumed before result() — the provider sends usage last.
      for await (const delta of turn.stream) void delta;
      result = await turn.result();
      budget.recordUsage({
        tokensIn: result.usage.in,
        tokensOut: result.usage.out,
        costUsd: price(result.usage)
      });
    } catch (err) {
      if (signal.aborted) {
        capped = true;
        failures.set(sub.i, 'abandoned: the request budget ran out mid-turn');
        return;
      }
      // One sub-question's provider failure is not the whole search's failure: the others
      // finish and the answer is an honest partial. It is recorded rather than traced
      // because the failure was in the LLM TURN, before any tool ran — the run log is
      // graded evidence, and a `web_search` that never happened must not appear in it.
      // Where it does surface: the evidence digest below names the sub-question, so the
      // answer discloses it; and if EVERY sub-question ends up here, the run fails loud.
      failures.set(sub.i, errorText(err));
      return;
    }

    await Promise.all(
      result.toolCalls.map(async (call) => {
        const tool = call.name as TraceEvent['tool'];
        const reason = typeof call.input.reason === 'string' ? { reason: call.input.reason } : {};
        if (capped || !budget.tryReserveToolCall()) {
          capped = true;
          emitter.trace({
            step: nextStep(),
            tool,
            input: call.input,
            ok: false,
            ms: 0,
            error: 'not executed: the request budget was exhausted',
            subQuestion: sub.i,
            ...reason
          });
          return;
        }
        const stepN = nextStep();
        const t0 = now();
        try {
          await dispatchWithDeadline(registry, call);
          emitter.trace({
            step: stepN,
            tool,
            input: call.input,
            ok: true,
            ms: now() - t0,
            subQuestion: sub.i,
            ...reason
          });
        } catch (err) {
          emitter.trace({
            step: stepN,
            tool,
            input: call.input,
            ok: false,
            ms: now() - t0,
            error: errorText(err),
            subQuestion: sub.i,
            ...reason
          });
        }
      })
    );
  };

  await mapWithConcurrency(plan.subQuestions, input.concurrency ?? 3, researchOne);

  // Every branch failed: there is no partial answer to give, only a failure to report. The
  // budget running out is a different thing — that IS an honest partial, and stays `cap`.
  if (failures.size === plan.subQuestions.length && !capped) {
    return fail(
      new Error(
        `every sub-question failed to retrieve: ${[...failures.entries()]
          .map(([i, why]) => `sub-question ${i}: ${why}`)
          .join('; ')}`
      )
    );
  }

  // --- 3. merge and synthesise -------------------------------------------------------
  // One collector across the whole fan-out, so this IS the merged numbering: deduped by
  // URL / docId+locator, contiguous from 1, each source keeping the sub-question that
  // first found it.
  const sources: SourcesEvent = collector.finalize();
  emitter.sources(sources);

  let fullText = '';
  let ttftMs: number | undefined;
  const emitToken = (text: string) => {
    if (ttftMs === undefined) ttftMs = now() - startedAt;
    emitter.token({ text });
    fullText += text;
  };

  const evidence = sources.length
    ? sources
        .map(
          (s) =>
            `[${s.n}] (sub-question ${s.subQuestion ?? '-'}) ${s.title}${s.url ? ` — ${s.url}` : ''}\n${s.snippet}`
        )
        .join('\n\n')
    : 'Nothing was retrieved for any sub-question.';
  const planText = plan.subQuestions
    .map((s) => {
      const why = failures.get(s.i);
      // A sub-question that turned up nothing is named as such, so the answer can say so
      // instead of quietly covering the gap from the model's own knowledge.
      return `${s.i}. ${s.question}${s.reason ? ` — ${s.reason}` : ''}${
        why ? `  [RETRIEVED NOTHING: ${why}]` : ''
      }`;
    })
    .join('\n');

  const synthesisMessages: LlmMessage[] = [
    ...(input.history ?? []),
    {
      role: 'user',
      content: `Question: ${input.query}\n\nPlan:\n${planText}\n\nEvidence:\n${evidence}`
    }
  ];

  const synthesisRemaining = budget.remainingMs();
  if (synthesisRemaining <= 0) {
    capped = true;
    emitToken(
      'The time budget was exhausted before the findings could be written up. ' +
        (sources.length > 0
          ? 'The sources listed were retrieved but not yet read into an answer.'
          : 'No evidence was retrieved.')
    );
  } else {
    const signal = makeSignal(synthesisRemaining);
    try {
      const turn = llm.streamTurn({
        system: SYNTHESIS_PROMPT,
        messages: synthesisMessages,
        tools: [],
        signal
      });
      for await (const delta of turn.stream) emitToken(delta);
      const result = await turn.result();
      budget.recordUsage({
        tokensIn: result.usage.in,
        tokensOut: result.usage.out,
        costUsd: price(result.usage)
      });
      if (!fullText && result.text) emitToken(result.text);
    } catch (err) {
      if (signal.aborted) capped = true;
      else return fail(err);
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

  const terminated: Terminated = capped ? 'cap' : 'done';
  const { tokens, costUsd } = budget.snapshot();
  const done: DoneEvent = {
    answerId: input.answerId,
    latencyMs: now() - startedAt,
    ttftMs: ttftMs ?? now() - startedAt,
    model: input.model,
    tokens,
    costUsd,
    searchCached: input.searchCached(),
    terminated,
    depth
  };
  emitter.done(done);
  return { terminated };
}
