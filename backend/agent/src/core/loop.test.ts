import { describe, expect, it } from 'vitest';
import {
  AskStreamEvent,
  DoneEvent,
  SourcesEvent,
  StreamErrorEvent,
  TraceEvent,
  unresolvedCitations
} from '@lumina/contract';
import { z } from 'zod';
import { runLoop } from './loop.js';
import { ToolRegistry } from './registry.js';
import { Budget } from './budget.js';
import { SourceCollector } from './sourceCollector.js';
import {
  collectingEmitter,
  scriptedLlm,
  scriptedSearch,
  type CollectingEmitter,
  type LlmMessage,
  type LlmUsage,
  type ScriptedLlm,
  type ScriptedSynthesis,
  type ScriptedTurn
} from '../testing/fakes.js';

/**
 * AgentLoop — ARCHITECTURE.md §3.1. Research (tool-use turns) → validated sources →
 * guarded streaming synthesis, with the REAL Budget and REAL SourceCollector (never mock
 * what we own); only the LlmPort and the tool executes are scripted fakes. Every emitted
 * frame is verified with the real contract schemas.
 *
 * Invented API pinned here (flagged for green — `runLoop`, a function, was chosen over an
 * AgentLoop class):
 *
 *   runLoop({
 *     llm,                 LlmPort (see src/testing/fakes.ts for the neutral shape)
 *     registry,            the full ToolRegistry; the loop advertises registry.forDepth(depth)
 *                          and dispatches with ctx.depth so R2 holds at both ends
 *     depth,               'quick' | 'deep' — reported verbatim in done.depth
 *     budget,              REAL Budget (clock injected)
 *     collector,           REAL SourceCollector (the only mint for sources)
 *     emitter,             AskEmitter
 *     query,               the user question
 *     history?,            prior thread turns (unused in these tests)
 *     now,                 the same injected clock the Budget uses
 *     answerId,            minted by the route; echoed in done.answerId
 *     model,               reported in done.model
 *     price,               (usage: {in, out}) => USD for one call — obs/cost owns rates in green
 *     searchCached,        () => boolean, evaluated at done-time (cached decorator reports hits)
 *   }): Promise<{ terminated: 'done' | 'cap' | 'error' }>
 *
 *   In-band failures (provider throw, dangling citation) RESOLVE with terminated:'error'
 *   after emitting the SSE error frame — the loop never throws for them; the HTTP route
 *   maps outcome to transport status.
 */

// ---------------------------------------------------------------------------
// deterministic helpers
// ---------------------------------------------------------------------------

function fakeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    }
  };
}

function quickBudget(clock: { now: () => number }, overrides: Record<string, unknown> = {}) {
  return new Budget({
    maxToolCalls: 8,
    deadlineMs: 90_000,
    maxUsd: 0.05,
    maxTokens: 180_000,
    synthesisAllowance: { ms: 0, usd: 0 },
    now: clock.now,
    ...overrides
  });
}

const PRICE = (usage: LlmUsage) => usage.in * 1e-6 + usage.out * 2e-6;

interface Harness {
  llm: ScriptedLlm;
  registry: ToolRegistry;
  budget: Budget;
  collector: SourceCollector;
  emitter: CollectingEmitter;
  clock: ReturnType<typeof fakeClock>;
}

function harness(
  turns: ScriptedTurn[],
  synthesis: ScriptedSynthesis,
  opts: { budgetOverrides?: Record<string, unknown>; registry?: (h: Omit<Harness, 'registry'>) => ToolRegistry } = {}
): Harness {
  const clock = fakeClock();
  const budget = quickBudget(clock, opts.budgetOverrides);
  const collector = new SourceCollector();
  const llm = scriptedLlm(turns, synthesis);
  const emitter = collectingEmitter();
  const partial = { llm, budget, collector, emitter, clock };
  const registry = opts.registry ? opts.registry(partial) : defaultRegistry(collector);
  return { ...partial, registry };
}

/**
 * web_search backed by the scripted SearchPort fake; fetch_page registers the fetched URL.
 * Both close over the REAL collector — nothing else in the test knows how sources appear.
 */
function defaultRegistry(collector: SourceCollector): ToolRegistry {
  const searchPort = scriptedSearch([
    [{ url: 'https://example.com/a', title: 'Example A', snippet: 'a passage the claim rests on' }],
    [{ url: 'https://example.org/b', title: 'Example B', snippet: 'another passage entirely' }]
  ]);
  const registry = new ToolRegistry();
  registry.register({
    name: 'web_search',
    description: 'Search the public web',
    schema: z.object({ query: z.string(), reason: z.string() }),
    execute: async (input: { query: string; reason: string }) => {
      const results = await searchPort.search(input.query);
      for (const r of results) {
        collector.register({ kind: 'web', url: r.url, title: r.title, snippet: r.snippet });
      }
      return results;
    }
  });
  registry.register({
    name: 'fetch_page',
    description: 'Fetch a page and extract its text',
    schema: z.object({ url: z.string(), reason: z.string() }),
    execute: async (input: { url: string; reason: string }) => {
      collector.register({
        kind: 'web',
        url: input.url,
        title: 'Example A',
        snippet: 'the fetched passage the claim rests on'
      });
      return { url: input.url, text: 'full fetched page text' };
    }
  });
  return registry;
}

function loopInput(h: Harness, overrides: Record<string, unknown> = {}) {
  return {
    llm: h.llm,
    registry: h.registry,
    depth: 'quick' as const,
    budget: h.budget,
    collector: h.collector,
    emitter: h.emitter,
    query: 'what is lumina?',
    now: h.clock.now,
    answerId: 'ans_test1',
    model: 'claude-sonnet-5',
    price: PRICE,
    searchCached: () => false,
    ...overrides
  };
}

const eventNames = (e: CollectingEmitter) => e.events.map((f) => f.event);
const framesOf = (e: CollectingEmitter, name: string) => e.events.filter((f) => f.event === name);
const answerText = (e: CollectingEmitter) =>
  framesOf(e, 'token')
    .map((f) => (f.data as { text: string }).text)
    .join('');
const parseAllFrames = (e: CollectingEmitter) => {
  for (const frame of e.events) AskStreamEvent.parse(frame);
};
const toolResultMessages = (messages: LlmMessage[]) =>
  messages.filter((m): m is Extract<LlmMessage, { role: 'tool_results' }> => m.role === 'tool_results');

// ---------------------------------------------------------------------------
// a. happy path
// ---------------------------------------------------------------------------

describe('runLoop happy path (quick)', () => {
  const turns: ScriptedTurn[] = [
    {
      stopReason: 'tool_use',
      toolCalls: [{ id: 't1', name: 'web_search', input: { query: 'lumina', reason: 'find candidate pages' } }],
      usage: { in: 100, out: 20 }
    },
    {
      stopReason: 'tool_use',
      toolCalls: [
        { id: 't2', name: 'fetch_page', input: { url: 'https://example.com/a', reason: 'read the top result in full' } }
      ],
      usage: { in: 120, out: 25 }
    },
    { stopReason: 'end_turn', usage: { in: 50, out: 10 } }
  ];
  const synthesis: ScriptedSynthesis = {
    deltas: ['LUMINA is', ' an answer engine [1]', '.'],
    usage: { in: 200, out: 40 }
  };

  it('emits traces, then ONE sources event, then tokens, then done — in exactly that order', async () => {
    const h = harness(turns, synthesis);
    await runLoop(loopInput(h));

    parseAllFrames(h.emitter);
    const names = eventNames(h.emitter);
    expect(names.slice(0, 3)).toEqual(['trace', 'trace', 'sources']);
    expect(names[names.length - 1]).toBe('done');
    // Everything between sources and done is answer text; sources strictly precedes token #1.
    expect(names.slice(3, -1).every((n) => n === 'token')).toBe(true);
    expect(names.filter((n) => n === 'sources')).toHaveLength(1);
    expect(names.filter((n) => n === 'token').length).toBeGreaterThan(0);
    expect(answerText(h.emitter)).toBe('LUMINA is an answer engine [1].');
  });

  it('emits a contract-valid trace per tool call with step numbering, ok:true, ms, and the model-supplied reason', async () => {
    const h = harness(turns, synthesis);
    await runLoop(loopInput(h));

    const traces = framesOf(h.emitter, 'trace').map((f) => TraceEvent.parse(f.data));
    expect(traces).toHaveLength(2);

    expect(traces[0]).toMatchObject({
      step: 1,
      tool: 'web_search',
      ok: true,
      input: { query: 'lumina', reason: 'find candidate pages' },
      reason: 'find candidate pages'
    });
    expect(traces[1]).toMatchObject({
      step: 2,
      tool: 'fetch_page',
      ok: true,
      input: { url: 'https://example.com/a', reason: 'read the top result in full' },
      reason: 'read the top result in full'
    });
  });

  it('emits the REAL collector output as sources: deduped by URL, contiguous numbering from 1', async () => {
    const h = harness(turns, synthesis);
    await runLoop(loopInput(h));

    const sources = SourcesEvent.parse(framesOf(h.emitter, 'sources')[0]!.data);
    // web_search registered example.com/a; fetch_page registered the same URL → one source.
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ n: 1, kind: 'web', url: 'https://example.com/a' });
  });

  it('reports done with terminated done, quick depth, and token/cost totals reconciled from the real budget', async () => {
    const h = harness(turns, synthesis);
    await runLoop(loopInput(h));

    const done = DoneEvent.parse(framesOf(h.emitter, 'done')[0]!.data);
    expect(done.terminated).toBe('done');
    expect(done.depth).toBe('quick');
    expect(done.answerId).toBe('ans_test1');
    expect(done.model).toBe('claude-sonnet-5');
    // Every usage response reconciled: 3 research turns + synthesis.
    expect(done.tokens).toEqual({ in: 470, out: 95 });
    expect(done.costUsd).toBeCloseTo(PRICE({ in: 470, out: 95 }), 10);
    // The done frame is fed by the SAME Budget instance the test holds.
    expect(done.tokens).toEqual(h.budget.snapshot().tokens);
    expect(done.costUsd).toBeCloseTo(h.budget.snapshot().costUsd, 10);
  });
});

// ---------------------------------------------------------------------------
// b. parallel tool execution
// ---------------------------------------------------------------------------

describe('runLoop parallel tool calls in one turn', () => {
  it('executes both calls (both traces) and returns both results to the llm in ONE follow-up message', async () => {
    const h = harness(
      [
        {
          stopReason: 'tool_use',
          toolCalls: [
            { id: 't1', name: 'web_search', input: { query: 'lumina pricing', reason: 'first angle' } },
            { id: 't2', name: 'web_search', input: { query: 'lumina reviews', reason: 'second angle' } }
          ],
          usage: { in: 100, out: 30 }
        },
        { stopReason: 'end_turn', usage: { in: 40, out: 10 } }
      ],
      { deltas: ['Both angles agree [1][2].'], usage: { in: 90, out: 15 } }
    );
    await runLoop(loopInput(h));

    parseAllFrames(h.emitter);
    const traces = framesOf(h.emitter, 'trace').map((f) => TraceEvent.parse(f.data));
    expect(traces.map((t) => t.step).sort()).toEqual([1, 2]);
    expect(traces.every((t) => t.ok)).toBe(true);
    // Two distinct scripted result sets were consumed → two sources registered.
    expect(SourcesEvent.parse(framesOf(h.emitter, 'sources')[0]!.data)).toHaveLength(2);

    // The llm's second turn received EXACTLY ONE new tool_results message holding both results.
    expect(h.llm.runTurnCalls).toHaveLength(2);
    expect(toolResultMessages(h.llm.runTurnCalls[0]!.messages)).toHaveLength(0);
    const followUps = toolResultMessages(h.llm.runTurnCalls[1]!.messages);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]!.results.map((r) => r.toolCallId).sort()).toEqual(['t1', 't2']);
    expect(followUps[0]!.results.every((r) => r.ok)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// c. failed tool call is recoverable
// ---------------------------------------------------------------------------

describe('runLoop failed tool call', () => {
  it('emits trace ok:false with a non-empty error, surfaces the failure to the llm, and continues to an honest done', async () => {
    const h = harness(
      [
        {
          stopReason: 'tool_use',
          toolCalls: [{ id: 't1', name: 'web_search', input: { query: 'lumina', reason: 'try the web' } }],
          usage: { in: 80, out: 20 }
        },
        { stopReason: 'end_turn', usage: { in: 40, out: 10 } }
      ],
      { deltas: ['I could not retrieve evidence for this.'], usage: { in: 60, out: 12 } },
      {
        registry: ({ collector }) => {
          void collector;
          const registry = new ToolRegistry();
          registry.register({
            name: 'web_search',
            description: 'a search backend that is down',
            schema: z.object({ query: z.string(), reason: z.string() }),
            execute: async () => {
              throw new Error('search backend down');
            }
          });
          return registry;
        }
      }
    );
    const outcome = await runLoop(loopInput(h));

    parseAllFrames(h.emitter);
    // A1: the failure is visibly a failure — TraceEvent's superRefine enforces the error string.
    const trace = TraceEvent.parse(framesOf(h.emitter, 'trace')[0]!.data);
    expect(trace.ok).toBe(false);
    expect(trace.error).toContain('search backend down');

    // Recoverable: the loop went back to the model instead of dying.
    expect(h.llm.runTurnCalls).toHaveLength(2);
    const followUps = toolResultMessages(h.llm.runTurnCalls[1]!.messages);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]!.results[0]).toMatchObject({ toolCallId: 't1', ok: false });
    expect(followUps[0]!.results[0]!.content).toContain('search backend down');

    // Nothing was retrieved, so the honest answer is uncited over empty sources — still done.
    expect(SourcesEvent.parse(framesOf(h.emitter, 'sources')[0]!.data)).toEqual([]);
    expect(DoneEvent.parse(framesOf(h.emitter, 'done')[0]!.data).terminated).toBe('done');
    expect(outcome.terminated).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// d. provider failure is terminal
// ---------------------------------------------------------------------------

describe('runLoop provider failure', () => {
  it('emits a 502 error frame, never done, makes no further llm calls, and reports terminated error', async () => {
    const h = harness([{ throws: new Error('provider melted: 500') }], { deltas: ['never streamed'] });
    const outcome = await runLoop(loopInput(h));

    // The first and only frame is the terminal error — no done, ever.
    expect(eventNames(h.emitter)).toEqual(['error']);
    const err = StreamErrorEvent.parse(framesOf(h.emitter, 'error')[0]!.data);
    expect(err.status).toBe(502);
    expect(err.error.length).toBeGreaterThan(0);

    expect(h.llm.runTurnCalls).toHaveLength(1);
    expect(h.llm.streamTextCalls).toHaveLength(0);
    expect(outcome.terminated).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// e. cap = refused admission while the model still wanted tools
// ---------------------------------------------------------------------------

describe('runLoop cap on refused admission', () => {
  it('stops research when the budget refuses the reservation, synthesizes an honest partial, and reports terminated cap — never done', async () => {
    let fetchExecuted = false;
    const h = harness(
      [
        {
          stopReason: 'tool_use',
          toolCalls: [{ id: 't1', name: 'web_search', input: { query: 'lumina', reason: 'first search' } }],
          usage: { in: 100, out: 20 }
        },
        {
          // The model still wants more research; the budget must refuse this one.
          stopReason: 'tool_use',
          toolCalls: [
            { id: 't2', name: 'fetch_page', input: { url: 'https://example.com/a', reason: 'read it in full' } }
          ],
          usage: { in: 90, out: 18 }
        }
      ],
      { deltas: ['Partial: only the initial search evidence [1].'], usage: { in: 70, out: 14 } },
      {
        budgetOverrides: { maxToolCalls: 1 },
        registry: ({ collector }) => {
          const registry = new ToolRegistry();
          registry.register({
            name: 'web_search',
            description: 'search',
            schema: z.object({ query: z.string(), reason: z.string() }),
            execute: async () => {
              collector.register({
                kind: 'web',
                url: 'https://example.com/a',
                title: 'Example A',
                snippet: 'a passage the claim rests on'
              });
              return [{ url: 'https://example.com/a' }];
            }
          });
          registry.register({
            name: 'fetch_page',
            description: 'fetch',
            schema: z.object({ url: z.string(), reason: z.string() }),
            execute: async () => {
              fetchExecuted = true;
              return { text: 'should never run' };
            }
          });
          return registry;
        }
      }
    );
    const outcome = await runLoop(loopInput(h));

    parseAllFrames(h.emitter);
    // The refused call never dispatched.
    expect(fetchExecuted).toBe(false);
    const okTraces = framesOf(h.emitter, 'trace')
      .map((f) => TraceEvent.parse(f.data))
      .filter((t) => t.ok);
    expect(okTraces.map((t) => t.tool)).toEqual(['web_search']);

    // Honest partial from evidence already collected: sources → tokens → done(cap).
    expect(SourcesEvent.parse(framesOf(h.emitter, 'sources')[0]!.data)).toHaveLength(1);
    expect(answerText(h.emitter)).toBe('Partial: only the initial search evidence [1].');
    const done = DoneEvent.parse(framesOf(h.emitter, 'done')[0]!.data);
    expect(done.terminated).toBe('cap');
    expect(outcome.terminated).toBe('cap');
  });
});

// ---------------------------------------------------------------------------
// f. natural exhaustion after end_turn is NOT a cap (A2 honesty distinction)
// ---------------------------------------------------------------------------

describe('runLoop natural exhaustion', () => {
  it('reports terminated done when the model uses exactly the call cap and then ends its turn on its own', async () => {
    const h = harness(
      [
        {
          stopReason: 'tool_use',
          toolCalls: [{ id: 't1', name: 'web_search', input: { query: 'lumina', reason: 'search first' } }],
          usage: { in: 100, out: 20 }
        },
        {
          stopReason: 'tool_use',
          toolCalls: [
            { id: 't2', name: 'fetch_page', input: { url: 'https://example.com/a', reason: 'then read the page' } }
          ],
          usage: { in: 90, out: 18 }
        },
        { stopReason: 'end_turn', usage: { in: 40, out: 8 } }
      ],
      { deltas: ['A complete answer [1].'], usage: { in: 70, out: 14 } },
      { budgetOverrides: { maxToolCalls: 2 } }
    );
    const outcome = await runLoop(loopInput(h));

    parseAllFrames(h.emitter);
    // The budget IS exhausted on the toolCalls dimension…
    expect(h.budget.exceededReason()).toBe('toolCalls');
    // …but the model finished naturally, so this is done, not cap (budget.ts's recorded rule).
    const done = DoneEvent.parse(framesOf(h.emitter, 'done')[0]!.data);
    expect(done.terminated).toBe('done');
    expect(outcome.terminated).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// g. dangling citation is a grounding failure, not a shippable answer
// ---------------------------------------------------------------------------

describe('runLoop dangling citation', () => {
  it('terminates with an error frame and no done when the synthesis cites [2] but only source 1 exists', async () => {
    const fullText = 'Claims rest on [1] and on [2].';
    const h = harness(
      [
        {
          stopReason: 'tool_use',
          toolCalls: [{ id: 't1', name: 'web_search', input: { query: 'lumina', reason: 'the only retrieval' } }],
          usage: { in: 100, out: 20 }
        },
        { stopReason: 'end_turn', usage: { in: 40, out: 8 } }
      ],
      { deltas: ['Claims rest on [1]', ' and on [2].'], usage: { in: 70, out: 14 } }
    );
    const outcome = await runLoop(loopInput(h));

    // The emitted sources are what the contract's own helper judges the text against.
    const sources = SourcesEvent.parse(framesOf(h.emitter, 'sources')[0]!.data);
    expect(sources).toHaveLength(1);
    expect(unresolvedCitations(fullText, sources)).toEqual([2]);

    // Grounding failure → terminal error frame, never a done.
    expect(framesOf(h.emitter, 'done')).toHaveLength(0);
    const errFrames = framesOf(h.emitter, 'error');
    expect(errFrames).toHaveLength(1);
    const err = StreamErrorEvent.parse(errFrames[0]!.data);
    expect(err.status).toBe(502);
    expect(outcome.terminated).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// h. empty retrieval still satisfies sources-before-token
// ---------------------------------------------------------------------------

describe('runLoop empty retrieval', () => {
  it('emits an empty sources event before any token and finishes as done when the model calls no tools', async () => {
    const h = harness(
      [{ stopReason: 'end_turn', usage: { in: 60, out: 12 } }],
      { deltas: ['I found nothing to cite; answering from general knowledge, uncited.'], usage: { in: 50, out: 10 } }
    );
    const outcome = await runLoop(loopInput(h));

    parseAllFrames(h.emitter);
    const names = eventNames(h.emitter);
    expect(names[0]).toBe('sources');
    expect(names[names.length - 1]).toBe('done');
    expect(names.slice(1, -1).every((n) => n === 'token')).toBe(true);
    expect(names.slice(1, -1).length).toBeGreaterThan(0);

    expect(SourcesEvent.parse(framesOf(h.emitter, 'sources')[0]!.data)).toEqual([]);
    expect(DoneEvent.parse(framesOf(h.emitter, 'done')[0]!.data).terminated).toBe('done');
    expect(outcome.terminated).toBe('done');
  });
});
