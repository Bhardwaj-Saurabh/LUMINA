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
  type RunTurnInput,
  type ScriptedLlm,
  type ScriptedTurn,
  type TurnStream
} from '../testing/fakes.js';

/**
 * AgentLoop — ARCHITECTURE.md §3.1. Optimistic streaming: research (tool-use turns) →
 * validated sources → the answer, where the ANSWER IS A TURN, not a separate synthesis
 * call. The REAL Budget and REAL SourceCollector are used (never mock what we own); only
 * the LlmPort and the tool executes are scripted fakes. Every emitted frame is verified
 * with the real contract schemas.
 *
 * Invented API pinned here (flagged for green — `runLoop`, a function, was chosen over an
 * AgentLoop class):
 *
 *   runLoop({
 *     llm,                 LlmPort + streamTurn (see src/testing/fakes.ts for the shape)
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
 *
 * TTFT (measured 8.2 s against a 2.5 s SLA, 5.6 s of it LLM round trips): the loop must
 * make ONE provider call per turn, including the turn that answers. The old shape ran a
 * non-streaming turn to `end_turn`, threw that turn's generated text away, and paid for a
 * second call to stream the same answer. `streamTurn` is that round trip removed:
 *
 *   - a turn that yields deltas before any tool call IS the answer → finalize the
 *     collector, emit `sources` once, then stream every delta as a token frame;
 *   - a turn that yields no deltas and resolves with toolCalls is research → dispatch, loop;
 *   - tool calls arriving AFTER deltas began are ignored and recorded as a visible
 *     trace with ok:false (fail-visible, never silent).
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
  opts: { budgetOverrides?: Record<string, unknown>; registry?: (h: Omit<Harness, 'registry'>) => ToolRegistry } = {}
): Harness {
  const clock = fakeClock();
  const budget = quickBudget(clock, opts.budgetOverrides);
  const collector = new SourceCollector();
  const llm = scriptedLlm(turns);
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
const tokenTexts = (e: CollectingEmitter) => framesOf(e, 'token').map((f) => (f.data as { text: string }).text);
const answerText = (e: CollectingEmitter) => tokenTexts(e).join('');
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
      toolCalls: [{ id: 't1', name: 'web_search', input: { query: 'lumina', reason: 'find candidate pages' } }],
      usage: { in: 100, out: 20 }
    },
    {
      toolCalls: [
        { id: 't2', name: 'fetch_page', input: { url: 'https://example.com/a', reason: 'read the top result in full' } }
      ],
      usage: { in: 120, out: 25 }
    },
    // The turn that answers: deltas, no tool calls. This IS the synthesis — no second call.
    { deltas: ['LUMINA is', ' an answer engine [1]', '.'], usage: { in: 200, out: 40 } }
  ];

  it('emits traces, then ONE sources event, then tokens, then done — in exactly that order', async () => {
    const h = harness(turns);
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
    const h = harness(turns);
    await runLoop(loopInput(h));

    // Two research turns + the answering turn — every one of them a streamTurn.
    expect(h.llm.streamTurnCalls).toHaveLength(3);
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
    const h = harness(turns);
    await runLoop(loopInput(h));

    expect(h.llm.streamTurnCalls).toHaveLength(3);
    const sources = SourcesEvent.parse(framesOf(h.emitter, 'sources')[0]!.data);
    // web_search registered example.com/a; fetch_page registered the same URL → one source.
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ n: 1, kind: 'web', url: 'https://example.com/a' });
  });

  it('reports done with terminated done, quick depth, and token/cost totals reconciled from the real budget', async () => {
    const h = harness(turns);
    await runLoop(loopInput(h));

    const done = DoneEvent.parse(framesOf(h.emitter, 'done')[0]!.data);
    expect(done.terminated).toBe('done');
    expect(done.depth).toBe('quick');
    expect(done.answerId).toBe('ans_test1');
    expect(done.model).toBe('claude-sonnet-5');
    // Every usage response reconciled: 2 research turns + the answering turn. Three calls,
    // not four — the answering turn's text is streamed, not generated twice.
    expect(h.llm.streamTurnCalls).toHaveLength(3);
    expect(done.tokens).toEqual({ in: 420, out: 85 });
    expect(done.costUsd).toBeCloseTo(PRICE({ in: 420, out: 85 }), 10);
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
    const h = harness([
      {
        toolCalls: [
          { id: 't1', name: 'web_search', input: { query: 'lumina pricing', reason: 'first angle' } },
          { id: 't2', name: 'web_search', input: { query: 'lumina reviews', reason: 'second angle' } }
        ],
        usage: { in: 100, out: 30 }
      },
      { deltas: ['Both angles agree [1][2].'], usage: { in: 90, out: 15 } }
    ]);
    await runLoop(loopInput(h));

    parseAllFrames(h.emitter);
    const traces = framesOf(h.emitter, 'trace').map((f) => TraceEvent.parse(f.data));
    expect(traces.map((t) => t.step).sort()).toEqual([1, 2]);
    expect(traces.every((t) => t.ok)).toBe(true);
    // Two distinct scripted result sets were consumed → two sources registered.
    expect(SourcesEvent.parse(framesOf(h.emitter, 'sources')[0]!.data)).toHaveLength(2);

    // The llm's second turn received EXACTLY ONE new tool_results message holding both results.
    expect(h.llm.streamTurnCalls).toHaveLength(2);
    expect(toolResultMessages(h.llm.streamTurnCalls[0]!.messages)).toHaveLength(0);
    const followUps = toolResultMessages(h.llm.streamTurnCalls[1]!.messages);
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
          toolCalls: [{ id: 't1', name: 'web_search', input: { query: 'lumina', reason: 'try the web' } }],
          usage: { in: 80, out: 20 }
        },
        { deltas: ['I could not retrieve evidence for this.'], usage: { in: 60, out: 12 } }
      ],
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
    expect(h.llm.streamTurnCalls).toHaveLength(2);
    const followUps = toolResultMessages(h.llm.streamTurnCalls[1]!.messages);
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
    const h = harness([{ throws: new Error('provider melted: 500') }]);
    const outcome = await runLoop(loopInput(h));

    // The first and only frame is the terminal error — no done, ever.
    expect(eventNames(h.emitter)).toEqual(['error']);
    const err = StreamErrorEvent.parse(framesOf(h.emitter, 'error')[0]!.data);
    expect(err.status).toBe(502);
    expect(err.error.length).toBeGreaterThan(0);

    expect(h.llm.streamTurnCalls).toHaveLength(1);
    expect(outcome.terminated).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// e. cap = refused admission while the model still wanted tools
// ---------------------------------------------------------------------------

describe('runLoop cap on refused admission', () => {
  it('stops research when the budget refuses the reservation, streams an honest partial from a tool-free finish turn, and reports terminated cap — never done', async () => {
    let fetchExecuted = false;
    const h = harness(
      [
        {
          toolCalls: [{ id: 't1', name: 'web_search', input: { query: 'lumina', reason: 'first search' } }],
          usage: { in: 100, out: 20 }
        },
        {
          // The model still wants more research; the budget must refuse this one.
          toolCalls: [
            { id: 't2', name: 'fetch_page', input: { url: 'https://example.com/a', reason: 'read it in full' } }
          ],
          usage: { in: 90, out: 18 }
        },
        // The capped finish: one more turn, offered no tools, so it can only answer.
        { deltas: ['Partial: only the initial search evidence [1].'], usage: { in: 70, out: 14 } }
      ],
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

    // The finish turn advertises NO tools: once capped, a tool the budget cannot admit
    // must not even be offered (otherwise the loop can only refuse it again).
    expect(h.llm.streamTurnCalls).toHaveLength(3);
    expect(h.llm.streamTurnCalls[2]!.tools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// f. natural exhaustion after an answering turn is NOT a cap (A2 honesty distinction)
// ---------------------------------------------------------------------------

describe('runLoop natural exhaustion', () => {
  it('reports terminated done when the model uses exactly the call cap and then answers on its own', async () => {
    const h = harness(
      [
        {
          toolCalls: [{ id: 't1', name: 'web_search', input: { query: 'lumina', reason: 'search first' } }],
          usage: { in: 100, out: 20 }
        },
        {
          toolCalls: [
            { id: 't2', name: 'fetch_page', input: { url: 'https://example.com/a', reason: 'then read the page' } }
          ],
          usage: { in: 90, out: 18 }
        },
        { deltas: ['A complete answer [1].'], usage: { in: 40, out: 8 } }
      ],
      { budgetOverrides: { maxToolCalls: 2 } }
    );
    const outcome = await runLoop(loopInput(h));

    parseAllFrames(h.emitter);
    // Two research turns and the answer the model volunteered — no forced finish turn.
    expect(h.llm.streamTurnCalls).toHaveLength(3);
    expect(answerText(h.emitter)).toBe('A complete answer [1].');
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
  it('terminates with an error frame and no done when the answer cites [2] but only source 1 exists', async () => {
    const fullText = 'Claims rest on [1] and on [2].';
    const h = harness([
      {
        toolCalls: [{ id: 't1', name: 'web_search', input: { query: 'lumina', reason: 'the only retrieval' } }],
        usage: { in: 100, out: 20 }
      },
      { deltas: ['Claims rest on [1]', ' and on [2].'], usage: { in: 70, out: 14 } }
    ]);
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
    const h = harness([
      { deltas: ['I found nothing to cite; answering from general knowledge, uncited.'], usage: { in: 50, out: 10 } }
    ]);
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

// ---------------------------------------------------------------------------
// i. REGRESSION (found live 2026-09-12): a hung provider turn must not outlive
// the budget — the deadline signal aborts it and the abort maps to cap, not error.
// A quick run once ran 295 s against the 90 s cap because nothing aborted the call.
// ---------------------------------------------------------------------------

describe('runLoop deadline signal', () => {
  it('aborts a hung research turn at the deadline and finishes as an honest cap, never error', async () => {
    const h = harness([
      {
        deltas: ['Cut short by the time budget: partial answer from evidence gathered so far.'],
        usage: { in: 10, out: 5 }
      }
    ]);
    let captured: AbortController | undefined;
    let calls = 0;
    const hangingLlm = {
      streamTurn: (input: RunTurnInput): TurnStream => {
        calls += 1;
        // Only the first (research) turn hangs; the capped finish turn is scripted.
        if (calls > 1) return h.llm.streamTurn(input);
        const hung = new Promise<never>((_, reject) => {
          input.signal?.addEventListener('abort', () => reject(new Error('request aborted')));
        });
        hung.catch(() => undefined); // the loop attaches the real handler; keep node quiet
        return {
          // eslint-disable-next-line require-yield
          stream: (async function* (): AsyncGenerator<string> {
            await hung;
          })(),
          result: () => hung
        };
      },
      runTurn: h.llm.runTurn.bind(h.llm),
      streamText: h.llm.streamText.bind(h.llm)
    };
    const makeSignal = (_ms: number) => {
      captured = new AbortController();
      return captured.signal;
    };

    const run = runLoop(loopInput(h, { llm: hangingLlm, makeSignal }) as never);
    // Let the loop reach the hung turn, then fire the deadline.
    await new Promise((r) => setTimeout(r, 0));
    expect(captured).toBeDefined();
    captured!.abort();
    const outcome = await run;

    expect(outcome.terminated).toBe('cap');
    expect(framesOf(h.emitter, 'error')).toHaveLength(0);
    const names = eventNames(h.emitter);
    expect(names[0]).toBe('sources'); // sources still precede the (partial) answer
    const done = DoneEvent.parse(framesOf(h.emitter, 'done')[0]!.data);
    expect(done.terminated).toBe('cap');
    expect(answerText(h.emitter).length).toBeGreaterThan(0); // honest partial, visibly there
  });
});

// ---------------------------------------------------------------------------
// j. OPTIMISTIC STREAMING — a research turn produces no visible answer yet
// ---------------------------------------------------------------------------

describe('runLoop research turn', () => {
  it('emits no token frames and has not emitted sources while a research turn is still dispatching tools', async () => {
    let seenAtDispatch: string[] = [];
    const h = harness(
      [
        {
          toolCalls: [{ id: 't1', name: 'web_search', input: { query: 'lumina', reason: 'the only retrieval' } }],
          usage: { in: 100, out: 20 }
        },
        { deltas: ['LUMINA is an answer engine [1].'], usage: { in: 80, out: 16 } }
      ],
      {
        registry: ({ collector, emitter }) => {
          const registry = new ToolRegistry();
          registry.register({
            name: 'web_search',
            description: 'search',
            schema: z.object({ query: z.string(), reason: z.string() }),
            execute: async () => {
              // The grounding boundary has NOT been crossed yet: no sources, no tokens.
              seenAtDispatch = emitter.events.map((f) => f.event);
              collector.register({
                kind: 'web',
                url: 'https://example.com/a',
                title: 'Example A',
                snippet: 'a passage the claim rests on'
              });
              return [{ url: 'https://example.com/a' }];
            }
          });
          return registry;
        }
      }
    );
    await runLoop(loopInput(h));

    parseAllFrames(h.emitter);
    expect(seenAtDispatch).not.toContain('sources');
    expect(seenAtDispatch).not.toContain('token');
    // The research turn contributed no answer text; only the answering turn's delta did.
    expect(tokenTexts(h.emitter)).toEqual(['LUMINA is an answer engine [1].']);
    expect(eventNames(h.emitter)).toEqual(['trace', 'sources', 'token', 'done']);
  });
});

// ---------------------------------------------------------------------------
// k. OPTIMISTIC STREAMING — the answering turn is the answer, streamed verbatim
// ---------------------------------------------------------------------------

describe('runLoop answering turn', () => {
  const turns: ScriptedTurn[] = [
    {
      toolCalls: [{ id: 't1', name: 'web_search', input: { query: 'lumina', reason: 'the only retrieval' } }],
      usage: { in: 100, out: 20 }
    },
    { deltas: ['LUMINA is', ' an answer engine [1]', ' for the web.'], usage: { in: 80, out: 16 } }
  ];

  it('emits sources exactly once immediately before the first token, and one token per delta in order', async () => {
    const h = harness(turns);
    await runLoop(loopInput(h));

    parseAllFrames(h.emitter);
    const names = eventNames(h.emitter);
    expect(names.filter((n) => n === 'sources')).toHaveLength(1);
    const sourcesAt = names.indexOf('sources');
    const firstTokenAt = names.indexOf('token');
    expect(firstTokenAt).toBeGreaterThan(-1);
    expect(sourcesAt).toBe(firstTokenAt - 1);
    // The first delta is buffered while the decision is made, then emitted — never dropped,
    // never merged with the next one.
    expect(tokenTexts(h.emitter)).toEqual(['LUMINA is', ' an answer engine [1]', ' for the web.']);
  });

  it('spends exactly ONE llm call on the turn that answers — no separate synthesis round trip', async () => {
    const h = harness(turns);
    await runLoop(loopInput(h));

    // One search + one answer = two provider calls. The old shape cost four: a
    // non-streaming end_turn whose generated text was billed and thrown away, then a
    // streamText that regenerated it.
    expect(h.llm.streamTurnCalls).toHaveLength(2);
    expect(h.llm.streamTextCalls).toHaveLength(0);
    expect(h.llm.runTurnCalls).toHaveLength(0);
    expect(DoneEvent.parse(framesOf(h.emitter, 'done')[0]!.data).terminated).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// l. OPTIMISTIC STREAMING — a turn that mixes narration with a tool call
// ---------------------------------------------------------------------------

describe('runLoop mixed narration and tool call', () => {
  it('ignores a tool call that arrives after the answer began, records it as a visible ok:false trace, and still finishes done', async () => {
    let fetchExecuted = false;
    const h = harness(
      [
        {
          toolCalls: [{ id: 't1', name: 'web_search', input: { query: 'lumina', reason: 'the only retrieval' } }],
          usage: { in: 100, out: 20 }
        },
        {
          // The model narrated AND asked for another tool in the same turn. The deltas
          // stream first; the tool call is only visible once the turn resolves — by which
          // time sources are frozen and tokens are on the wire.
          deltas: ['LUMINA is an answer engine [1].'],
          toolCalls: [
            { id: 't2', name: 'fetch_page', input: { url: 'https://example.com/a', reason: 'read it in full' } }
          ],
          usage: { in: 80, out: 16 }
        }
      ],
      {
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
    // The post-answer tool call is dropped — the answer already rests on frozen sources.
    expect(fetchExecuted).toBe(false);
    // …but never silently: A1 says the drop is visible as a failure, with a reason.
    const traces = framesOf(h.emitter, 'trace').map((f) => TraceEvent.parse(f.data));
    expect(traces).toHaveLength(2);
    expect(traces[0]).toMatchObject({ step: 1, tool: 'web_search', ok: true });
    expect(traces[1]!.tool).toBe('fetch_page');
    expect(traces[1]!.ok).toBe(false);
    expect(traces[1]!.step).toBe(2);
    expect((traces[1]!.error ?? '').trim().length).toBeGreaterThan(0);

    // The answer itself still completes, over the sources it was actually grounded in.
    expect(answerText(h.emitter)).toBe('LUMINA is an answer engine [1].');
    expect(SourcesEvent.parse(framesOf(h.emitter, 'sources')[0]!.data)).toHaveLength(1);
    const done = DoneEvent.parse(framesOf(h.emitter, 'done')[0]!.data);
    expect(done.terminated).toBe('done');
    expect(outcome.terminated).toBe('done');
    // No extra turn was requested after the answer.
    expect(h.llm.streamTurnCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// k. RETRIEVAL IS NOT OPTIONAL — the first turn may not answer from memory alone
// ---------------------------------------------------------------------------

describe('runLoop retrieval enforcement', () => {
  /**
   * Found live: asked a gold question whose answer sat in an indexed Space, the model
   * called recall_memory and then answered from its own weights — `sources: []`, a
   * confident ungrounded answer, and a run that fails the rubric's minRetrievalRate (every
   * answer must have called a retrieval tool). Optimistic streaming means the first text
   * delta is already on the wire, so this cannot be caught after the fact: the only place
   * to enforce it is the request itself. Tools advertised ⇒ the first turn MUST call one.
   */
  it('requires a RETRIEVAL tool on the first turn so an answer can never skip retrieval', async () => {
    const h = harness([
      { toolCalls: [{ id: 'c1', name: 'web_search', input: { query: 'lumina', reason: 'r' } }] },
      { deltas: ['Grounded ', 'answer [1]'] }
    ]);

    await runLoop(loopInput(h) as never);

    const first = h.llm.streamTurnCalls[0];
    expect(first?.toolChoice).toBe('required');
    // Everything stays on offer, so the model can retrieve AND recall in the same turn
    // rather than paying a whole extra round trip for memory (measured: +1.5s of TTFT).
    expect(first?.tools.map((t) => t.name)).toEqual(['web_search', 'fetch_page']);

    // Evidence is in: the model is free again, including free to answer.
    expect(h.llm.streamTurnCalls[1]?.toolChoice).toBe('auto');
  });

  it('narrows the offer to retrieval tools only after a forced turn dodged retrieval', async () => {
    // Measured live: offered everything and told to pick something, the model called the
    // cheapest tool it had (recall_memory) and answered from its own weights — sources [],
    // a confidently ungrounded answer. Nothing has streamed yet at that point, so the loop
    // can still insist; the second attempt has nothing but retrieval to choose from.
    const h = harness(
      [
        { toolCalls: [{ id: 'c1', name: 'recall_memory', input: { query: 'prefs', reason: 'r' } }] },
        { toolCalls: [{ id: 'c2', name: 'web_search', input: { query: 'lumina', reason: 'r' } }] },
        { deltas: ['Grounded answer [1]'] }
      ],
      {
        registry: (partial) => {
          const registry = defaultRegistry(partial.collector);
          registry.register({
            name: 'recall_memory',
            description: 'Recall what this user told you before. Not a citable source.',
            schema: z.object({ query: z.string(), reason: z.string() }),
            execute: async () => ({ memories: [] })
          });
          return registry;
        }
      }
    );

    await runLoop(loopInput(h) as never);

    expect(h.llm.streamTurnCalls[0]?.tools.map((t) => t.name)).toContain('recall_memory');
    const second = h.llm.streamTurnCalls[1];
    expect(second?.toolChoice).toBe('required');
    expect(second?.tools.map((t) => t.name)).toEqual(['web_search']);
    // And once it has actually retrieved, the restriction lifts.
    expect(h.llm.streamTurnCalls[2]?.toolChoice).toBe('auto');
  });

  it('forces nothing when there are no tools to force, so the capped finish can still answer', async () => {
    // Budget refuses the second tool call; the finish turn advertises [] and must be able
    // to answer with no tools at all — demanding a tool call there would deadlock the run.
    const h = harness(
      [
        { toolCalls: [{ id: 'c1', name: 'web_search', input: { query: 'a', reason: 'r' } }] },
        { toolCalls: [{ id: 'c2', name: 'web_search', input: { query: 'b', reason: 'r' } }] },
        { deltas: ['Partial answer.'] }
      ],
      { budgetOverrides: { maxToolCalls: 1 } }
    );

    await runLoop(loopInput(h) as never);

    const finish = h.llm.streamTurnCalls.at(-1);
    expect(finish?.tools).toEqual([]);
    expect(finish?.toolChoice).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// l. TOOL CALLS ARE BOUNDED TOO — the budget covers the whole turn, not just the LLM
// ---------------------------------------------------------------------------

describe('runLoop tool deadline', () => {
  /**
   * Found live: a Mongo pool reset made web_search hang, and the request streamed its
   * first token 230 SECONDS into a 90-second quick gear. The provider call had a deadline
   * (test i); the tool dispatch did not, so nothing in the request was actually bounded.
   * A budget that only covers the parts that were already fast is not a budget.
   */
  it('abandons a tool call that outlives the request budget, visibly and with an honest error', async () => {
    const controllers: AbortController[] = [];
    const makeSignal = (_ms: number) => {
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    };

    const h = harness(
      [
        { toolCalls: [{ id: 'c1', name: 'web_search', input: { query: 'q', reason: 'r' } }] },
        { deltas: ['Answering from what little arrived.'] }
      ],
      {
        registry: () => {
          const registry = new ToolRegistry();
          registry.register({
            name: 'web_search',
            description: 'never resolves',
            schema: z.object({ query: z.string(), reason: z.string() }),
            // Never settles on its own: only the deadline can end this call.
            execute: () => new Promise<never>(() => {})
          });
          return registry;
        }
      }
    );

    const run = runLoop(loopInput(h, { makeSignal }) as never);
    // Let the loop reach the hung dispatch, then fire every live deadline.
    await new Promise((r) => setTimeout(r, 0));
    for (const controller of controllers) controller.abort();
    const outcome = await run;

    const traces = framesOf(h.emitter, 'trace').map((f) => TraceEvent.parse(f.data));
    const hung = traces.find((t) => t.tool === 'web_search');
    expect(hung?.ok).toBe(false);
    expect(hung?.error).toMatch(/budget|deadline|abandoned/i);
    // It resolves rather than hanging forever, and never claims the tool succeeded.
    expect(['cap', 'done', 'error']).toContain(outcome.terminated);
  });
});

// ---------------------------------------------------------------------------
// m. TIMINGS — TTFT is attributable, not one opaque number
// ---------------------------------------------------------------------------

describe('runLoop timings', () => {
  /**
   * TTFT p95 is the one red SLA and nothing times an LLM turn today: `ttftMs` is stamped at the
   * first delta and tools carry `ms`, but "how long did turn 1 take" cannot be answered. The
   * outcome grows an OPTIONAL `timings` block — off the SSE contract, off the run log — so each
   * experiment against TTFT can be attributed to the decision turn, the tools, or the answer
   * turn's prefill.
   */
  it('reports one timing per LLM turn, the tool phase, and which turn answered', async () => {
    const h = harness([
      {
        toolCalls: [{ id: 't1', name: 'web_search', input: { query: 'lumina', reason: 'r' } }],
        usage: { in: 100, out: 20 }
      },
      { deltas: ['LUMINA is', ' an answer engine [1]'], usage: { in: 200, out: 40 } }
    ]);

    const outcome = await runLoop(loopInput(h) as never);

    const timings = outcome.timings!;
    expect(timings.turnCount).toBe(2);
    expect(timings.turns).toHaveLength(2);
    // Turn 1: forced retrieval, called web_search, spoke no text.
    expect(timings.turns[0]).toMatchObject({
      index: 1,
      toolChoice: 'required',
      toolCalls: ['web_search'],
      usage: { in: 100, out: 20 }
    });
    expect(timings.turns[0]?.firstDeltaMs).toBeUndefined();
    expect(timings.turns[0]?.advertised).toContain('web_search');
    // Turn 2: free choice, answered — so it has a first-delta stamp.
    expect(timings.turns[1]).toMatchObject({ index: 2, toolChoice: 'auto', toolCalls: [] });
    expect(typeof timings.turns[1]?.firstDeltaMs).toBe('number');
    // Roll-ups the aggregator reads directly.
    expect(typeof timings.turn1Ms).toBe('number');
    expect(typeof timings.answerFirstDeltaMs).toBe('number');
    expect(timings.toolPhases).toHaveLength(1);
    expect(timings.toolPhases[0]).toMatchObject({ turn: 1, tools: ['web_search'] });
    expect(typeof timings.toolsMs).toBe('number');
  });

  it('counts the three-turn shape honestly when the first turn dodged retrieval', async () => {
    // recall_memory only on turn 1 → a forced second retrieval turn → the answer. This is the
    // "recall in a separate turn" shape that costs a whole extra round trip (p50 2215 ms).
    const h = harness(
      [
        { toolCalls: [{ id: 'c1', name: 'recall_memory', input: { query: 'prefs', reason: 'r' } }] },
        { toolCalls: [{ id: 'c2', name: 'web_search', input: { query: 'lumina', reason: 'r' } }] },
        { deltas: ['Grounded [1]'] }
      ],
      {
        registry: (partial) => {
          const registry = defaultRegistry(partial.collector);
          registry.register({
            name: 'recall_memory',
            description: 'Recall what this user told you before.',
            schema: z.object({ query: z.string(), reason: z.string() }),
            execute: async () => ({ memories: [] })
          });
          return registry;
        }
      }
    );

    const outcome = await runLoop(loopInput(h) as never);

    expect(outcome.timings?.turnCount).toBe(3);
    expect(outcome.timings?.turns.map((t) => t.toolCalls)).toEqual([['recall_memory'], ['web_search'], []]);
  });
});
