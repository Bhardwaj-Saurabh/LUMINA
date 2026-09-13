/**
 * RED — M8 deep search (ARCHITECTURE §3.2 / SPEC 5.5): plan BEFORE any retrieval, fan out
 * over the sub-questions, merge every result into ONE contiguous citation numbering, then
 * synthesise.
 *
 * The properties pinned here are the ones that separate deep search from a slow quick
 * search, and each maps to a graded cap:
 *   - the plan is the first frame on the wire and precedes every retrieval  (deepPlan)
 *   - every retrieval step AND every source carries its subQuestion         (deepAttribution)
 *   - one shared budget across the whole fan-out, honest `cap`              (deepBudget)
 *   - one merged, contiguous numbering with no duplicates                   (the contract)
 *
 * REAL Budget and REAL SourceCollector throughout — never mock what we own.
 */
import { describe, expect, it } from 'vitest';
import { AskStreamEvent, DoneEvent, PlanEvent, SourcesEvent, TraceEvent } from '@lumina/contract';
import { z } from 'zod';
import { Budget } from '../budget.js';
import { SourceCollector } from '../sourceCollector.js';
import { ToolRegistry } from '../registry.js';
import { runDeep } from './orchestrator.js';
import {
  collectingEmitter,
  scriptedLlm,
  type CollectingEmitter,
  type LlmUsage,
  type ScriptedTurn
} from '../../testing/fakes.js';

// --- helpers -------------------------------------------------------------------------

const fakeClock = (start = 0) => {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    }
  };
};

const deepBudget = (clock: { now: () => number }, overrides: Record<string, unknown> = {}) =>
  new Budget({
    maxToolCalls: 24,
    deadlineMs: 240_000,
    maxUsd: 0.35,
    maxTokens: 180_000,
    synthesisAllowance: { ms: 0, usd: 0 },
    now: clock.now,
    ...overrides
  });

const PRICE = (usage: LlmUsage) => usage.in * 1e-6 + usage.out * 2e-6;

const PLAN: PlanEvent = {
  subQuestions: [
    { i: 1, question: 'What does it cost at our scale?', reason: 'cost dominates the decision' },
    { i: 2, question: 'Does it support page-level citations?', reason: 'we cite pages' },
    { i: 3, question: 'What is the migration cost?', reason: 'switching is not free' }
  ]
};

const framesOf = (e: CollectingEmitter, name: string) => e.events.filter((f) => f.event === name);
const eventNames = (e: CollectingEmitter) => e.events.map((f) => f.event);
const answerText = (e: CollectingEmitter) =>
  framesOf(e, 'token')
    .map((f) => (f.data as { text: string }).text)
    .join('');

/**
 * A web_search whose results are a function of the sub-question, so merged numbering and
 * per-sub-question attribution are both observable. `shared` appears for every
 * sub-question, which is what exercises dedupe across the fan-out.
 */
function registryFactory(collector: SourceCollector, opts: { fail?: number; hang?: boolean } = {}) {
  return (subQuestion: number): ToolRegistry => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'web_search',
      description: 'Search the public web',
      schema: z.object({ query: z.string(), reason: z.string() }),
      execute: async () => {
        if (opts.fail === subQuestion) throw new Error(`upstream 503 for sub-question ${subQuestion}`);
        if (opts.hang) await new Promise(() => {});
        for (const url of [`https://example.com/sq${subQuestion}`, 'https://example.com/shared']) {
          collector.register(
            { kind: 'web', url, title: `Result for ${subQuestion}`, snippet: 'a passage' },
            { subQuestion }
          );
        }
        return { results: ['ok'] };
      }
    });
    return registry;
  };
}

/** One research turn per sub-question, then the synthesis turn. */
const researchThenAnswer = (subQuestions: number, deltas: string[]): ScriptedTurn[] => [
  ...Array.from({ length: subQuestions }, (_, i) => ({
    toolCalls: [{ id: `c${i}`, name: 'web_search', input: { query: `q${i}`, reason: 'r' } }],
    usage: { in: 100, out: 20 }
  })),
  { deltas, usage: { in: 400, out: 90 } }
];

/** Retrieval steps only — the planning step is traced too, and is not attributable. */
const retrievalTraces = (e: CollectingEmitter) =>
  framesOf(e, 'trace')
    .map((f) => TraceEvent.parse(f.data))
    .filter((t) => t.tool !== 'plan_research');

interface DeepHarness {
  emitter: CollectingEmitter;
  collector: SourceCollector;
  budget: Budget;
  clock: ReturnType<typeof fakeClock>;
}

function deepInput(
  turns: ScriptedTurn[],
  opts: {
    plan?: PlanEvent;
    planError?: Error;
    registry?: (collector: SourceCollector) => (sq: number) => ToolRegistry;
    budgetOverrides?: Record<string, unknown>;
    concurrency?: number;
    planCalls?: string[];
  } = {}
): { input: Record<string, unknown>; h: DeepHarness } {
  const clock = fakeClock();
  const collector = new SourceCollector();
  const emitter = collectingEmitter();
  const budget = deepBudget(clock, opts.budgetOverrides ?? {});
  const make = (opts.registry ?? registryFactory)(collector);
  const input = {
    llm: scriptedLlm(turns),
    registryFor: make,
    budget,
    collector,
    emitter,
    query: 'should we move our RAG stack off Atlas Vector Search?',
    now: clock.now,
    answerId: 'ans_deep1',
    model: 'gpt-5.4-mini',
    price: PRICE,
    searchCached: () => false,
    planner: async (q: string) => {
      opts.planCalls?.push(q);
      if (opts.planError) throw opts.planError;
      return opts.plan ?? PLAN;
    },
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {})
  };
  return { input, h: { emitter, collector, budget, clock } };
}

// --- the plan comes first ------------------------------------------------------------

describe('runDeep plan-first', () => {
  it('emits the plan as the very first frame, before any retrieval has happened', async () => {
    const { input, h } = deepInput(researchThenAnswer(3, ['Deep answer [1]']));

    await runDeep(input as never);

    expect(eventNames(h.emitter)[0]).toBe('plan');
    const firstTrace = eventNames(h.emitter).indexOf('trace');
    expect(firstTrace).toBeGreaterThan(0); // something was retrieved, and it came after the plan
    const plan = PlanEvent.parse(framesOf(h.emitter, 'plan')[0]!.data);
    expect(plan.subQuestions).toHaveLength(3);
  });

  it('emits exactly one plan frame, whatever the fan-out does', async () => {
    const { input, h } = deepInput(researchThenAnswer(3, ['answer']));
    await runDeep(input as never);
    expect(framesOf(h.emitter, 'plan')).toHaveLength(1);
  });

  it('passes the user question to the planner verbatim', async () => {
    const planCalls: string[] = [];
    const { input } = deepInput(researchThenAnswer(3, ['answer']), { planCalls });
    await runDeep(input as never);
    expect(planCalls).toEqual(['should we move our RAG stack off Atlas Vector Search?']);
  });

  it('fails loud when planning fails, with no plan frame and nothing retrieved', async () => {
    const { input, h } = deepInput(researchThenAnswer(3, ['answer']), {
      planError: new Error('planner returned no sub-questions')
    });

    const outcome = await runDeep(input as never);

    expect(outcome.terminated).toBe('error');
    expect(framesOf(h.emitter, 'plan')).toHaveLength(0);
    expect(framesOf(h.emitter, 'trace')).toHaveLength(0);
    expect(framesOf(h.emitter, 'token')).toHaveLength(0);
    const error = framesOf(h.emitter, 'error')[0]!.data as { status: number; error: string };
    expect(error.status).toBe(502);
    expect(error.error).toMatch(/sub-question|plan/i);
  });
});

// --- attribution ---------------------------------------------------------------------

describe('runDeep attribution', () => {
  it('tags every retrieval trace step with the sub-question it served', async () => {
    const { input, h } = deepInput(researchThenAnswer(3, ['Deep answer [1]']));

    await runDeep(input as never);

    const traces = framesOf(h.emitter, 'trace').map((f) => TraceEvent.parse(f.data));
    const retrieval = traces.filter((t) => t.tool === 'web_search');
    expect(retrieval).toHaveLength(3);
    for (const step of retrieval) expect(Number.isInteger(step.subQuestion)).toBe(true);
    expect(new Set(retrieval.map((t) => t.subQuestion))).toEqual(new Set([1, 2, 3]));
  });

  it('tags every merged source with the sub-question that found it', async () => {
    const { input, h } = deepInput(researchThenAnswer(3, ['Deep answer [1]']));

    await runDeep(input as never);

    const sources = SourcesEvent.parse(framesOf(h.emitter, 'sources')[0]!.data);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) expect(Number.isInteger(source.subQuestion)).toBe(true);
  });

  it('merges the fan-out into ONE contiguous numbering, deduped across sub-questions', async () => {
    const { input, h } = deepInput(researchThenAnswer(3, ['Deep answer [1]']));

    await runDeep(input as never);

    const sources = SourcesEvent.parse(framesOf(h.emitter, 'sources')[0]!.data);
    // three unique per-sub-question urls + one shared url registered by all three
    expect(sources).toHaveLength(4);
    expect(sources.map((s) => s.n)).toEqual([1, 2, 3, 4]);
    expect(new Set(sources.map((s) => s.url)).size).toBe(4);
    // The shared source keeps the FIRST sub-question that found it, not the last.
    const shared = sources.find((s) => s.url === 'https://example.com/shared');
    expect(shared?.subQuestion).toBe(1);
  });

  it('emits sources exactly once, before the first token', async () => {
    const { input, h } = deepInput(researchThenAnswer(3, ['Deep ', 'answer [1]']));

    await runDeep(input as never);

    expect(framesOf(h.emitter, 'sources')).toHaveLength(1);
    const names = eventNames(h.emitter);
    expect(names.indexOf('sources')).toBeLessThan(names.indexOf('token'));
    expect(answerText(h.emitter)).toBe('Deep answer [1]');
  });
});

// --- the fan-out --------------------------------------------------------------------

describe('runDeep fan-out', () => {
  it('researches every sub-question in the plan', async () => {
    const { input, h } = deepInput(researchThenAnswer(3, ['answer']));

    await runDeep(input as never);

    expect(retrievalTraces(h.emitter).filter((t) => t.ok)).toHaveLength(3);
  });

  it('keeps at most `concurrency` sub-questions in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const collectorRef = { current: undefined as SourceCollector | undefined };
    const slowRegistry = (collector: SourceCollector) => {
      collectorRef.current = collector;
      return (subQuestion: number): ToolRegistry => {
        const registry = new ToolRegistry();
        registry.register({
          name: 'web_search',
          description: 'Search the public web',
          schema: z.object({ query: z.string(), reason: z.string() }),
          execute: async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight -= 1;
            collector.register(
              { kind: 'web', url: `https://example.com/sq${subQuestion}`, title: 't', snippet: 's' },
              { subQuestion }
            );
            return { results: ['ok'] };
          }
        });
        return registry;
      };
    };
    const plan: PlanEvent = {
      subQuestions: Array.from({ length: 6 }, (_, i) => ({ i: i + 1, question: `q${i + 1}` }))
    };
    const { input } = deepInput(researchThenAnswer(6, ['answer']), {
      plan,
      registry: slowRegistry,
      concurrency: 2
    });

    await runDeep(input as never);

    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1); // it IS parallel, not a disguised sequential loop
  });

  it('carries on when one sub-question fails, and says so in its trace (A1)', async () => {
    const { input, h } = deepInput(researchThenAnswer(3, ['Partial deep answer [1]']), {
      registry: (collector) => registryFactory(collector, { fail: 2 })
    });

    const outcome = await runDeep(input as never);

    const traces = retrievalTraces(h.emitter);
    const failed = traces.find((t) => t.ok === false);
    expect(failed?.subQuestion).toBe(2);
    expect(failed?.error).toContain('upstream 503');
    // The other two still produced evidence, and the answer still lands.
    expect(traces.filter((t) => t.ok)).toHaveLength(2);
    expect(outcome.terminated).toBe('done');
    expect(SourcesEvent.parse(framesOf(h.emitter, 'sources')[0]!.data).length).toBeGreaterThan(0);
  });
});

// --- one budget for the whole run ----------------------------------------------------

describe('runDeep budget', () => {
  it('spends ONE shared budget across the fan-out and reports cap honestly when it runs out', async () => {
    // Two tool calls allowed, three sub-questions want one each.
    const { input, h } = deepInput(researchThenAnswer(3, ['Honest partial.']), {
      budgetOverrides: { maxToolCalls: 2 }
    });

    const outcome = await runDeep(input as never);

    expect(outcome.terminated).toBe('cap');
    const done = DoneEvent.parse(framesOf(h.emitter, 'done')[0]!.data);
    expect(done.terminated).toBe('cap');
    expect(done.depth).toBe('deep');
    expect(retrievalTraces(h.emitter).filter((t) => t.ok)).toHaveLength(2);
  });

  it('reports depth deep and the run totals on done', async () => {
    const { input, h } = deepInput(researchThenAnswer(3, ['Deep answer [1]']));

    await runDeep(input as never);

    const done = DoneEvent.parse(framesOf(h.emitter, 'done')[0]!.data);
    expect(done.depth).toBe('deep');
    expect(done.answerId).toBe('ans_deep1');
    expect(done.model).toBe('gpt-5.4-mini');
    expect(done.terminated).toBe('done');
    expect(done.tokens.in).toBeGreaterThan(0);
  });

  it('emits frames the contract accepts, in a legal order, on the happy path', async () => {
    const { input, h } = deepInput(researchThenAnswer(3, ['Deep answer [1]']));

    await runDeep(input as never);

    for (const frame of h.emitter.events) AskStreamEvent.parse(frame);
    const names = eventNames(h.emitter);
    expect(names[0]).toBe('plan');
    expect(names.at(-1)).toBe('done');
    expect(names.indexOf('sources')).toBeLessThan(names.indexOf('token'));
  });

  it('refuses to let a dangling citation through, exactly as the quick gear does', async () => {
    const { input, h } = deepInput(researchThenAnswer(3, ['Answer citing [99]']));

    const outcome = await runDeep(input as never);

    expect(outcome.terminated).toBe('error');
    const error = framesOf(h.emitter, 'error')[0]!.data as { error: string };
    expect(error.error).toMatch(/\[99\]/);
    expect(framesOf(h.emitter, 'done')).toHaveLength(0);
  });
});

// --- the planning step is itself visible ---------------------------------------------

describe('runDeep planning trace', () => {
  it('traces the planning step so a reader can see what it cost, unattributed to any sub-question', async () => {
    const { input, h } = deepInput(researchThenAnswer(3, ['Deep answer [1]']));

    await runDeep(input as never);

    const traces = framesOf(h.emitter, 'trace').map((f) => TraceEvent.parse(f.data));
    const planning = traces.filter((t) => t.tool === 'plan_research');
    expect(planning).toHaveLength(1);
    // plan_research serves the WHOLE question, so it carries no subQuestion — the graded
    // attribution check excludes it for exactly this reason.
    expect(planning[0]?.subQuestion).toBeUndefined();
    expect(planning[0]?.ok).toBe(true);
    // And it is the first step, because nothing may be retrieved before the plan exists.
    expect(traces[0]?.tool).toBe('plan_research');
  });
});

// --- a fan-out that retrieved nothing is not a completed answer ----------------------

describe('runDeep total retrieval failure', () => {
  /**
   * Caught in review: one sub-question failing is an honest partial, but if EVERY
   * sub-question's provider turn throws — the correlated failure, an Azure 429 or a network
   * reset, not an exotic one — the old shape emitted `sources: []`, let the model write its
   * "nothing was retrieved" prose, and reported `terminated: "done"` with a 200. That is a
   * provider exception converted into a plausible answer, which is the one thing rule A1
   * exists to prevent.
   */
  const alwaysThrows = (_collector: SourceCollector) => (_sq: number): ToolRegistry => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'web_search',
      description: 'Search the public web',
      schema: z.object({ query: z.string(), reason: z.string() }),
      execute: async () => ({ results: [] })
    });
    return registry;
  };

  it('fails loud when every sub-question failed, instead of reporting an empty answer as done', async () => {
    // Every research turn throws; the synthesis turn is never reached.
    const { input, h } = deepInput(
      [
        { throws: new Error('azure 503 upstream') },
        { throws: new Error('azure 503 upstream') },
        { throws: new Error('azure 503 upstream') }
      ],
      { registry: alwaysThrows }
    );

    const outcome = await runDeep(input as never);

    expect(outcome.terminated).toBe('error');
    expect(framesOf(h.emitter, 'done')).toHaveLength(0);
    const error = framesOf(h.emitter, 'error')[0]!.data as { status: number; error: string };
    expect(error.status).toBe(502);
    expect(error.error).toMatch(/sub-question/i);
    expect(error.error).toContain('azure 503 upstream');
  });

  it('still answers when only SOME sub-questions failed — a partial is honest, an empty one is not', async () => {
    const { input, h } = deepInput(
      [
        { throws: new Error('azure 503 upstream') },
        { toolCalls: [{ id: 'c1', name: 'web_search', input: { query: 'q', reason: 'r' } }] },
        { toolCalls: [{ id: 'c2', name: 'web_search', input: { query: 'q', reason: 'r' } }] },
        { deltas: ['Partial but grounded [1]'] }
      ],
      {}
    );

    const outcome = await runDeep(input as never);

    expect(outcome.terminated).toBe('done');
    expect(SourcesEvent.parse(framesOf(h.emitter, 'sources')[0]!.data).length).toBeGreaterThan(0);
  });

  it('does not invent a tool call in the trace when the failure was in the LLM turn', async () => {
    // The run log is graded evidence. A research turn that threw before any tool ran must
    // not be recorded as a `web_search` that happened and failed.
    const { input, h } = deepInput(
      [
        { throws: new Error('azure 503 upstream') },
        { toolCalls: [{ id: 'c1', name: 'web_search', input: { query: 'q', reason: 'r' } }] },
        { toolCalls: [{ id: 'c2', name: 'web_search', input: { query: 'q', reason: 'r' } }] },
        { deltas: ['Partial but grounded [1]'] }
      ],
      {}
    );

    await runDeep(input as never);

    // Exactly the two searches that really ran; the failed turn invents nothing.
    const searches = retrievalTraces(h.emitter).filter((t) => t.tool === 'web_search');
    expect(searches).toHaveLength(2);
    expect(searches.every((t) => t.ok)).toBe(true);
  });
});
