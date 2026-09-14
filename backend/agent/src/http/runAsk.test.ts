import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourcesEvent, type ThreadMessage } from '@lumina/contract';
import { makeRunAsk as makeRunAskDefault, type RunAskDeps } from './runAsk.js';
import { createSearchLru } from '../providers/search/cached.js';
import type { SearchCacheDoc } from '@lumina/contract';
import type { ChunkSearchPort } from '../core/rag/retrieve.js';
import type { LlmPort, RunTurnInput } from '../providers/llm/port.js';
import { env } from '../env.js';
import {
  collectingEmitter,
  deterministicEmbeddings,
  scriptedLlm,
  type CollectingEmitter,
  type ScriptedTurn,
  type SearchResult
} from '../testing/fakes.js';

/**
 * runAsk request assembly — two TTFT levers (ARCHITECTURE §2.2 orchestrator, §3 loop):
 *
 *   H2  `recall_memory` is a tool the model may spend a round trip on. When the user has
 *       nothing stored there is nothing to recall, so the tool must not be OFFERED — the
 *       toolset is filtered structurally (same discipline as depth/mode), not by prompt.
 *       `memories.hasAny(userId)` is the one cheap question that decides it, asked once.
 *
 *   H3  Speculative web search for the user's literal query, overlapped with the model's
 *       first turn, only when `env.searchPrefetch` is ON and only where it cannot be wasted:
 *       fresh `web` request with no history. It shares the cached port so the model's own
 *       identical search JOINS the in-flight call (one inner hit), and it never mints
 *       sources — only the model's call does. Default is ON (proven live); `SEARCH_PREFETCH=0` disables.
 *
 * Fakes only: scripted LLM, recording inner SearchPort, in-memory L2 store, real LRU/
 * collector/budget. The flag lives on `env` (evaluated at module load), so the ON cases
 * reset the module registry, set the variable, and import runAsk fresh — no module mocks.
 */

const USER = 'u_t';
const THREAD = 'thr_t';
const QUERY = 'What is RRF?';
const ONE_RESULT: SearchResult[] = [
  { url: 'https://example.com/rrf', title: 'Reciprocal rank fusion', snippet: 'RRF fuses rankings.' }
];

type MakeRunAsk = typeof makeRunAskDefault;

interface RecordingSearch {
  calls: string[];
  search(query: string, opts?: { maxResults?: number }): Promise<SearchResult[]>;
}

interface Harness {
  deps: RunAskDeps;
  llm: ReturnType<typeof scriptedLlm>;
  search: RecordingSearch;
  /** Interleaving of inner-search calls and model turns, in the order they happened. */
  order: string[];
  hasAnyCalls: string[];
  emitter: CollectingEmitter;
  runsUpserted: Record<string, unknown>[];
  requestsInserted: Record<string, unknown>[];
}

interface HarnessOptions {
  turns: ScriptedTurn[];
  hasAny?: boolean;
  history?: ThreadMessage[];
  withChunks?: boolean;
}

const emptyChunks: ChunkSearchPort = {
  async vector() {
    return [];
  },
  async text() {
    return [];
  }
};

function makeDeps(opts: HarnessOptions): Harness {
  const order: string[] = [];
  const inner = scriptedLlm(opts.turns);
  // Observe the model boundary: 'llm:turn' when the model is invoked, 'llm:result' when its
  // completed turn (tool calls / stop reason) is available to the loop.
  const llm: LlmPort & { streamTurnCalls: RunTurnInput[] } = {
    streamTurnCalls: inner.streamTurnCalls,
    runTurn: (input) => inner.runTurn(input),
    streamTurn(input) {
      order.push('llm:turn');
      const turn = inner.streamTurn(input);
      return {
        stream: turn.stream,
        result: async () => {
          const r = await turn.result();
          order.push('llm:result');
          return r;
        }
      };
    }
  };

  const search: RecordingSearch = {
    calls: [],
    async search(query) {
      order.push('search');
      search.calls.push(query);
      return ONE_RESULT;
    }
  };

  const rows = new Map<string, SearchCacheDoc>();
  const searchCache = {
    async get(key: string) {
      return rows.get(key) ?? null;
    },
    async set(doc: SearchCacheDoc) {
      rows.set(doc._id, doc);
    }
  };

  const hasAnyCalls: string[] = [];
  const memories = {
    async insert() {},
    async searchByVector() {
      return [];
    },
    async hasAny(userId: string) {
      hasAnyCalls.push(userId);
      return opts.hasAny ?? false;
    }
  };

  const runsUpserted: Record<string, unknown>[] = [];
  const requestsInserted: Record<string, unknown>[] = [];
  const history = opts.history ?? [];

  const deps: RunAskDeps = {
    llm,
    search,
    searchCache,
    searchLru: createSearchLru(),
    fetchPage: {
      async fetchPage() {
        throw new Error('fetchPage must not be called in these tests');
      }
    },
    embeddings: deterministicEmbeddings(1536),
    memories,
    ...(opts.withChunks ? { chunks: emptyChunks } : {}),
    messages: {
      async listByThread() {
        return history;
      },
      async insertMany() {}
    } as unknown as RunAskDeps['messages'],
    runs: {
      async upsert(doc) {
        runsUpserted.push(doc);
      }
    },
    requests: {
      async insert(doc) {
        requestsInserted.push(doc);
      }
    }
  };

  return {
    deps,
    llm: inner,
    search,
    order,
    hasAnyCalls,
    emitter: collectingEmitter(),
    runsUpserted,
    requestsInserted
  };
}

// `runlog.persist` writes runs/<requestId>.json under env.runsDir, and quality/check.mjs
// reads that directory — so every test names its run and removes the file afterwards.
let seq = 0;
const written: string[] = [];
const nextRequestId = (): string => {
  const id = `req_runask_test_${++seq}`;
  written.push(join(env.runsDir, `${id}.json`));
  return id;
};

afterEach(async () => {
  await Promise.all(written.splice(0).map((p) => rm(p, { force: true })));
});

const toolNames = (llm: { streamTurnCalls: RunTurnInput[] }, turn: number): string[] =>
  llm.streamTurnCalls[turn]!.tools.map((t) => t.name);

async function run(
  makeRunAsk: MakeRunAsk,
  h: Harness,
  body: Record<string, unknown> = { query: QUERY, mode: 'web', depth: 'quick' }
): Promise<void> {
  await makeRunAsk(h.deps)({
    body: body as never,
    threadId: THREAD,
    userId: USER,
    emitter: h.emitter,
    requestId: nextRequestId()
  });
}

const answerTurn = (text: string): ScriptedTurn => ({ deltas: [text] });
const webSearchTurn = (query: string): ScriptedTurn => ({
  toolCalls: [{ id: 'call_1', name: 'web_search', input: { query, reason: 'look it up' } }]
});

/** Flag ON: reset the registry so `env` re-reads the variable, then import runAsk fresh. */
/** `env` is evaluated at module load, so a flag variant needs a fresh import of runAsk. */
async function importWithPrefetch(value: '0' | '1'): Promise<MakeRunAsk> {
  const previous = process.env.SEARCH_PREFETCH;
  vi.resetModules();
  process.env.SEARCH_PREFETCH = value;
  try {
    const mod = await import('./runAsk.js');
    return mod.makeRunAsk;
  } finally {
    if (previous === undefined) delete process.env.SEARCH_PREFETCH;
    else process.env.SEARCH_PREFETCH = previous;
    vi.resetModules();
  }
}
const importWithPrefetchOn = () => importWithPrefetch('1');

describe('runAsk — H2: recall_memory is offered only when there is something to recall', () => {
  it('does not advertise recall_memory on turn 1 when the user has no stored memories, while keeping save_memory and web_search', async () => {
    const h = makeDeps({ turns: [answerTurn('RRF fuses ranked lists.')], hasAny: false });

    await run(makeRunAskDefault, h);

    const names = toolNames(h.llm, 0);
    expect(names).not.toContain('recall_memory');
    expect(names).toContain('save_memory');
    expect(names).toContain('web_search');
    expect(h.hasAnyCalls).toEqual([USER]);
  });

  it('advertises recall_memory on turn 1 when the user has stored memories', async () => {
    const h = makeDeps({ turns: [answerTurn('RRF fuses ranked lists.')], hasAny: true });

    await run(makeRunAskDefault, h);

    expect(toolNames(h.llm, 0)).toContain('recall_memory');
  });

  it('asks memories.hasAny exactly once per request, about the requesting user', async () => {
    const h = makeDeps({ turns: [answerTurn('RRF fuses ranked lists.')], hasAny: true });

    await run(makeRunAskDefault, h);

    expect(h.hasAnyCalls).toHaveLength(1);
    expect(h.hasAnyCalls[0]).toBe(USER);
  });
});

describe('runAsk — H3: speculative search is on by default, switchable, and never wasted', () => {
  it('is ON by default: measured 2026-09-14, cold-web TTFT p50 3465 → 2431 ms with 10/10 reuse', () => {
    expect(env.searchPrefetch).toBe(true);
  });

  it('with the flag OFF calls the inner search port only once and only after the model asked for it', async () => {
    const makeRunAsk = await importWithPrefetch('0');
    const h = makeDeps({
      turns: [webSearchTurn(QUERY), answerTurn('RRF fuses ranked lists [1].')]
    });

    await run(makeRunAsk, h);

    expect(h.search.calls).toEqual([QUERY]);
    // No prefetch: the only inner call sits after turn 1 completed, before turn 2 began.
    expect(h.order).toEqual(['llm:turn', 'llm:result', 'search', 'llm:turn', 'llm:result']);
  });

  it('with the flag ON, a fresh web request prefetches the user query before the model turn-1 result, the model identical search joins it (one inner call), and only the model call mints sources', async () => {
    const makeRunAsk = await importWithPrefetchOn();
    const h = makeDeps({
      turns: [webSearchTurn(QUERY), answerTurn('RRF fuses ranked lists [1].')]
    });

    await run(makeRunAsk, h);

    // Prefetched for the literal user query, before the model's first turn came back...
    expect(h.search.calls).toEqual([QUERY]);
    expect(h.order.indexOf('search')).toBeGreaterThanOrEqual(0);
    expect(h.order.indexOf('search')).toBeLessThan(h.order.indexOf('llm:result'));
    // ...and the model's own web_search for the same query joined it: still ONE inner call.
    expect(h.search.calls).toHaveLength(1);

    // Sources are minted by the model's tool call only — exactly the one result, never more.
    const sourcesFrames = h.emitter.events.filter((e) => e.event === 'sources');
    expect(sourcesFrames).toHaveLength(1);
    const sources = SourcesEvent.parse(sourcesFrames[0]!.data);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ kind: 'web', url: ONE_RESULT[0]!.url });
  });

  it('with the flag ON but mode "docs", never calls the inner web search (no prefetch, no web tool)', async () => {
    const makeRunAsk = await importWithPrefetchOn();
    const h = makeDeps({ turns: [answerTurn('From your documents: nothing yet.')], withChunks: true });

    await run(makeRunAsk, h, { query: QUERY, mode: 'docs', depth: 'quick', spaceId: 'spc_t' });

    expect(h.search.calls).toEqual([]);
    expect(toolNames(h.llm, 0)).not.toContain('web_search');
  });

  it('with the flag ON but a non-empty thread history, does not prefetch', async () => {
    const makeRunAsk = await importWithPrefetchOn();
    const h = makeDeps({
      turns: [answerTurn('As I said, RRF fuses ranked lists.')],
      history: [
        { role: 'user', content: 'What is hybrid retrieval?' },
        { role: 'assistant', content: 'Vector plus BM25, fused.' }
      ]
    });

    await run(makeRunAsk, h);

    expect(h.search.calls).toEqual([]);
    expect(h.order).not.toContain('search');
  });

  it('with the flag ON but mode "auto" with a Space attached, does not prefetch', async () => {
    const makeRunAsk = await importWithPrefetchOn();
    const h = makeDeps({ turns: [answerTurn('Your Space does not cover this.')], withChunks: true });

    await run(makeRunAsk, h, { query: QUERY, mode: 'auto', depth: 'quick', spaceId: 'spc_t' });

    expect(h.search.calls).toEqual([]);
    expect(h.order).not.toContain('search');
  });
});
