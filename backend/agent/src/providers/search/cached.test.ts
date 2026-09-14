import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SearchCacheDoc } from '@lumina/contract';
import type { SearchResult } from './port.js';
import { createSearchLru, makeCachedSearch, searchCacheKey } from './cached.js';

/**
 * Two-tier search cache — ARCHITECTURE.md §2.2 (`search/cached.ts`: L1 in-process LRU →
 * L2 `searchCache` collection, sha256(normalized query + provider), expiry also checked in
 * code because Mongo's TTL sweeper runs ~1/min, in-flight same-key dedupe, "no searches →
 * searchCached false") and §9 ("Cache hit >= 50 %", time-sensitive queries bypass).
 *
 * No Mongo, no network, no real clock: the L2 store is an injected recording fake and time
 * comes from an injected `now()`.
 */

// 2026-01-15T00:00:00Z — every deadline/expiry/"current year" in this file derives from it.
const NOW = Date.UTC(2026, 0, 15);
const TTL_SECONDS = 6 * 60 * 60;

const results = (...urls: string[]): SearchResult[] =>
  urls.map((url) => ({ url, title: `Title of ${url}`, snippet: `Snippet of ${url}` }));

/** Minimal L2 port: the Mongo repo implements this shape later. Records every touch. */
interface StoreFake {
  gets: string[];
  writes: SearchCacheDoc[];
  get(key: string): Promise<SearchCacheDoc | null>;
  set(doc: SearchCacheDoc): Promise<void>;
}

function recordingStore(seed: SearchCacheDoc[] = []): StoreFake {
  const rows = new Map<string, SearchCacheDoc>(seed.map((doc) => [doc._id, doc]));
  const gets: string[] = [];
  const writes: SearchCacheDoc[] = [];
  return {
    gets,
    writes,
    async get(key) {
      gets.push(key);
      return rows.get(key) ?? null;
    },
    async set(doc) {
      writes.push(doc);
      rows.set(doc._id, doc);
    }
  };
}

/** Inner SearchPort fake: records queries, returns a fixed set, resolves only when released. */
function gatedSearch(fixed: SearchResult[]): {
  calls: string[];
  release: () => void;
  search(query: string): Promise<SearchResult[]>;
} {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    calls,
    release,
    async search(query: string) {
      calls.push(query);
      await gate;
      return fixed;
    }
  };
}

/** Inner SearchPort fake that resolves immediately; every call is recorded. */
function recordingSearch(fixed: SearchResult[]): { calls: string[]; search(q: string): Promise<SearchResult[]> } {
  const calls: string[] = [];
  return {
    calls,
    async search(query: string) {
      calls.push(query);
      return fixed;
    }
  };
}

const cacheRow = (key: string, rows: SearchResult[], expiresAtMs: number): SearchCacheDoc =>
  SearchCacheDoc.parse({
    _id: key,
    provider: 'tavily',
    query: 'cached query',
    results: rows,
    expiresAt: new Date(expiresAtMs).toISOString(),
    createdAt: new Date(expiresAtMs - TTL_SECONDS * 1000).toISOString()
  });

describe('searchCacheKey derivation', () => {
  it('is the sha256 of the normalized query joined to the provider name', () => {
    const expected = createHash('sha256').update('what is tavily?|tavily').digest('hex');
    expect(searchCacheKey('what is tavily?', 'tavily')).toBe(expected);
  });

  it('normalizes case, surrounding space and repeated inner whitespace to one key', () => {
    expect(searchCacheKey('  What IS   Tavily? ', 'tavily')).toBe(
      searchCacheKey('what is tavily?', 'tavily')
    );
  });

  it('keys the same query under a different provider separately', () => {
    expect(searchCacheKey('what is tavily?', 'serpapi')).not.toBe(
      searchCacheKey('what is tavily?', 'tavily')
    );
  });

  it('is a 64-character lowercase hex digest', () => {
    expect(searchCacheKey('  What IS   Tavily? ', 'tavily')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('cached search — L1 (in-process LRU)', () => {
  it('serves a repeated query from L1: the provider is called once and the store is not touched again', async () => {
    const inner = recordingSearch(results('https://a.example/1'));
    const store = recordingStore();
    const cached = makeCachedSearch({
      inner,
      store,
      ttlSeconds: TTL_SECONDS,
      now: () => NOW,
      provider: 'tavily'
    });

    const first = await cached.search('what is tavily?');
    const getsAfterMiss = store.gets.length;
    const writesAfterMiss = store.writes.length;
    const second = await cached.search('what is tavily?');

    expect(second).toEqual(first);
    expect(inner.calls).toHaveLength(1);
    expect(store.gets).toHaveLength(getsAfterMiss);
    expect(store.writes).toHaveLength(writesAfterMiss);
  });

  it('does not serve an L1 entry past its TTL — the lookup falls through to L2', async () => {
    let clock = NOW;
    const inner = recordingSearch(results('https://fresh.example/1'));
    const key = searchCacheKey('what is tavily?', 'tavily');
    const store = recordingStore();
    const cached = makeCachedSearch({
      inner,
      store,
      ttlSeconds: TTL_SECONDS,
      now: () => clock,
      provider: 'tavily'
    });

    await cached.search('what is tavily?');
    expect(inner.calls).toHaveLength(1);

    // L1 entry is now stale; L2 holds a row that is still valid at the new clock.
    clock = NOW + TTL_SECONDS * 1000 + 1;
    await store.set(cacheRow(key, results('https://from-l2.example/1'), clock + 60_000));

    const served = await cached.search('what is tavily?');
    expect(inner.calls).toHaveLength(1);
    expect(served).toEqual(results('https://from-l2.example/1'));
  });
});

describe('cached search — L2 (searchCache collection)', () => {
  it('serves a cold-L1 query from the store without calling the provider', async () => {
    const inner = recordingSearch(results('https://provider.example/1'));
    const key = searchCacheKey('what is tavily?', 'tavily');
    const store = recordingStore([cacheRow(key, results('https://stored.example/1'), NOW + 60_000)]);
    const cached = makeCachedSearch({
      inner,
      store,
      ttlSeconds: TTL_SECONDS,
      now: () => NOW,
      provider: 'tavily'
    });

    const served = await cached.search('what is tavily?');

    expect(served).toEqual(results('https://stored.example/1'));
    expect(inner.calls).toHaveLength(0);
    expect(store.writes).toHaveLength(0);
  });

  it('promotes an L2 hit into L1, so the next repeat touches neither tier', async () => {
    const inner = recordingSearch(results('https://provider.example/1'));
    const key = searchCacheKey('what is tavily?', 'tavily');
    const store = recordingStore([cacheRow(key, results('https://stored.example/1'), NOW + 60_000)]);
    const cached = makeCachedSearch({
      inner,
      store,
      ttlSeconds: TTL_SECONDS,
      now: () => NOW,
      provider: 'tavily'
    });

    await cached.search('what is tavily?');
    const getsAfterL2Hit = store.gets.length;
    const served = await cached.search('what is tavily?');

    expect(served).toEqual(results('https://stored.example/1'));
    expect(store.gets).toHaveLength(getsAfterL2Hit);
    expect(inner.calls).toHaveLength(0);
  });

  it('treats a store row whose expiresAt has passed as a miss and refreshes it', async () => {
    const inner = recordingSearch(results('https://provider.example/1'));
    const key = searchCacheKey('what is tavily?', 'tavily');
    const store = recordingStore([cacheRow(key, results('https://stale.example/1'), NOW - 1)]);
    const cached = makeCachedSearch({
      inner,
      store,
      ttlSeconds: TTL_SECONDS,
      now: () => NOW,
      provider: 'tavily'
    });

    const served = await cached.search('what is tavily?');

    expect(inner.calls).toHaveLength(1);
    expect(served).toEqual(results('https://provider.example/1'));
    expect(store.writes).toHaveLength(1);
    const written = SearchCacheDoc.parse(store.writes[0]);
    expect(new Date(written.expiresAt).getTime()).toBe(NOW + TTL_SECONDS * 1000);
  });
});

describe('cached search — miss writes through to the provider and the store', () => {
  it('calls the provider once and writes one row keyed by the derived cache key', async () => {
    const inner = recordingSearch(results('https://provider.example/1', 'https://provider.example/2'));
    const store = recordingStore();
    const cached = makeCachedSearch({
      inner,
      store,
      ttlSeconds: TTL_SECONDS,
      now: () => NOW,
      provider: 'tavily'
    });

    const served = await cached.search('  What IS   Tavily? ');

    expect(inner.calls).toHaveLength(1);
    expect(served).toEqual(results('https://provider.example/1', 'https://provider.example/2'));
    expect(store.writes).toHaveLength(1);
    const written = SearchCacheDoc.parse(store.writes[0]);
    expect(written._id).toBe(searchCacheKey('what is tavily?', 'tavily'));
    expect(written.provider).toBe('tavily');
    expect(written.results).toEqual(results('https://provider.example/1', 'https://provider.example/2'));
    expect(new Date(written.expiresAt).getTime()).toBe(NOW + TTL_SECONDS * 1000);
  });

  it('passes the caller query through to the provider unchanged', async () => {
    const inner = recordingSearch(results('https://provider.example/1'));
    const store = recordingStore();
    const cached = makeCachedSearch({
      inner,
      store,
      ttlSeconds: TTL_SECONDS,
      now: () => NOW,
      provider: 'tavily'
    });

    await cached.search('  What IS   Tavily? ');

    expect(inner.calls).toEqual(['  What IS   Tavily? ']);
  });
});

describe('cached search — in-flight dedupe', () => {
  it('collapses two concurrent identical searches into a single provider call', async () => {
    const inner = gatedSearch(results('https://provider.example/1'));
    const store = recordingStore();
    const cached = makeCachedSearch({
      inner,
      store,
      ttlSeconds: TTL_SECONDS,
      now: () => NOW,
      provider: 'tavily'
    });

    const first = cached.search('what is tavily?');
    const second = cached.search('what is tavily?');
    inner.release();
    const [a, b] = await Promise.all([first, second]);

    expect(inner.calls).toHaveLength(1);
    expect(a).toEqual(results('https://provider.example/1'));
    expect(b).toEqual(a);
  });
});

describe('cached search — hit/miss accounting', () => {
  it('reports allHits false when no search has been performed at all', () => {
    const cached = makeCachedSearch({
      inner: recordingSearch([]),
      store: recordingStore(),
      ttlSeconds: TTL_SECONDS,
      now: () => NOW,
      provider: 'tavily'
    });

    expect(cached.stats()).toEqual({ hits: 0, misses: 0, allHits: false, prefetch: { issued: 0, joined: 0 } });
  });

  it('reports allHits false when a miss preceded a hit', async () => {
    const inner = recordingSearch(results('https://provider.example/1'));
    const cached = makeCachedSearch({
      inner,
      store: recordingStore(),
      ttlSeconds: TTL_SECONDS,
      now: () => NOW,
      provider: 'tavily'
    });

    await cached.search('what is tavily?');
    await cached.search('what is tavily?');

    expect(cached.stats()).toEqual({ hits: 1, misses: 1, allHits: false, prefetch: { issued: 0, joined: 0 } });
  });

  it('reports allHits true only when every search so far was served from cache', async () => {
    const inner = recordingSearch(results('https://provider.example/1'));
    const key = searchCacheKey('what is tavily?', 'tavily');
    const store = recordingStore([cacheRow(key, results('https://stored.example/1'), NOW + 60_000)]);
    const cached = makeCachedSearch({
      inner,
      store,
      ttlSeconds: TTL_SECONDS,
      now: () => NOW,
      provider: 'tavily'
    });

    await cached.search('what is tavily?');
    await cached.search('what is tavily?');

    expect(cached.stats()).toEqual({ hits: 2, misses: 0, allHits: true, prefetch: { issued: 0, joined: 0 } });
  });
});

describe('cached search — time-sensitive queries bypass the cache read', () => {
  const warmCached = (query: string, inner: { search(q: string): Promise<SearchResult[]> }) => {
    const key = searchCacheKey(query, 'tavily');
    const store = recordingStore([cacheRow(key, results('https://stored.example/1'), NOW + 60_000)]);
    const cached = makeCachedSearch({
      inner,
      store,
      ttlSeconds: TTL_SECONDS,
      now: () => NOW,
      provider: 'tavily'
    });
    return { cached, store };
  };

  it('bypasses a warm cache for a query containing "today"', async () => {
    const inner = recordingSearch(results('https://live.example/1'));
    const { cached } = warmCached('what is the news today', inner);

    const served = await cached.search('what is the news today');

    expect(inner.calls).toHaveLength(1);
    expect(served).toEqual(results('https://live.example/1'));
  });

  it('bypasses a warm cache for a query containing "latest"', async () => {
    const inner = recordingSearch(results('https://live.example/1'));
    const { cached } = warmCached('latest tavily pricing', inner);

    const served = await cached.search('latest tavily pricing');

    expect(inner.calls).toHaveLength(1);
    expect(served).toEqual(results('https://live.example/1'));
  });

  it('bypasses a warm cache for a query naming the current year or later', async () => {
    const inner = recordingSearch(results('https://live.example/1'));
    // NOW is in 2026, so 2026 is not a historical year.
    const { cached } = warmCached('best search apis 2026', inner);

    const served = await cached.search('best search apis 2026');

    expect(inner.calls).toHaveLength(1);
    expect(served).toEqual(results('https://live.example/1'));
  });

  it('still serves an ordinary query naming a past year from cache', async () => {
    const inner = recordingSearch(results('https://live.example/1'));
    const { cached } = warmCached('what happened in the summer of 1999', inner);

    const served = await cached.search('what happened in the summer of 1999');

    expect(inner.calls).toHaveLength(0);
    expect(served).toEqual(results('https://stored.example/1'));
  });
});

/**
 * H3 — speculative search prewarm. TTFT is lost because the model's `web_search` runs
 * serially after LLM turn 1; `prewarm(userQuery)` starts the search during turn 1 and the
 * model's later `search(sameQuery)` joins the in-flight promise via the same `inFlight` map.
 *
 * Structural safety, no test needed: `prewarm` returns void, so it can never mint a source
 * the citation collector sees — only a `search()` the model actually issued can. And a join
 * is NOT a cache hit: `searchCached` / the >= 50 % hit SLA must not be inflatable by prewarming.
 */
describe('cached search — speculative prewarm (H3)', () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  /** Inner SearchPort fake that rejects immediately; every call is recorded. */
  function rejectingSearch(error: Error): { calls: string[]; search(q: string): Promise<SearchResult[]> } {
    const calls: string[] = [];
    return {
      calls,
      async search(query: string) {
        calls.push(query);
        throw error;
      }
    };
  }

  /** Inner SearchPort fake that rejects with `error` only once released; every call is recorded. */
  function gatedRejectingSearch(error: Error): {
    calls: string[];
    release: () => void;
    search(query: string): Promise<SearchResult[]>;
  } {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      calls,
      release,
      async search(query: string) {
        calls.push(query);
        await gate;
        throw error;
      }
    };
  }

  const make = (
    inner: { search(q: string): Promise<SearchResult[]> },
    store: StoreFake = recordingStore(),
    lru = createSearchLru()
  ) =>
    makeCachedSearch({
      inner,
      store,
      ttlSeconds: TTL_SECONDS,
      now: () => NOW,
      provider: 'tavily',
      lru
    });

  it('lets the model search join a prewarm of the same query: the provider is called once and the join counts as a miss, not a hit', async () => {
    const inner = gatedSearch(results('https://provider.example/1'));
    const cached = make(inner);

    cached.prewarm('what is tavily?');
    const served = cached.search('what is tavily?');
    inner.release();

    expect(await served).toEqual(results('https://provider.example/1'));
    expect(inner.calls).toHaveLength(1);
    expect(cached.stats()).toEqual({
      hits: 0,
      misses: 1,
      allHits: false,
      prefetch: { issued: 1, joined: 1 }
    });
  });

  it('never counts a prewarm on its own as a hit or a miss', async () => {
    const inner = recordingSearch(results('https://provider.example/1'));
    const cached = make(inner);

    cached.prewarm('what is tavily?');
    await flush();

    expect(inner.calls).toHaveLength(1);
    expect(cached.stats()).toEqual({
      hits: 0,
      misses: 0,
      allHits: false,
      prefetch: { issued: 1, joined: 0 }
    });
  });

  it('does not join a rephrased query to an earlier prewarm — the provider is called for each', async () => {
    const inner = gatedSearch(results('https://provider.example/1'));
    const cached = make(inner);

    cached.prewarm('what is rrf?');
    const served = cached.search('explain rrf');
    inner.release();
    await served;

    expect(inner.calls).toHaveLength(2);
    expect(cached.stats()).toEqual({
      hits: 0,
      misses: 1,
      allHits: false,
      prefetch: { issued: 1, joined: 0 }
    });
  });

  it('joins on the normalized key, so case and whitespace differences still coalesce onto the prewarm', async () => {
    const inner = gatedSearch(results('https://provider.example/1'));
    const cached = make(inner);

    cached.prewarm('What is RRF?');
    const served = cached.search('  what is rrf?  ');
    inner.release();

    expect(await served).toEqual(results('https://provider.example/1'));
    expect(inner.calls).toHaveLength(1);
    expect(cached.stats().prefetch).toEqual({ issued: 1, joined: 1 });
  });

  it('turns the repeat request on a fresh instance over the shared tiers into a real hit', async () => {
    const inner = recordingSearch(results('https://provider.example/1'));
    const store = recordingStore();
    const lru = createSearchLru();

    const requestA = make(inner, store, lru);
    requestA.prewarm('what is tavily?');
    await requestA.search('what is tavily?');
    expect(inner.calls).toHaveLength(1);

    const requestB = make(inner, store, lru);
    const served = await requestB.search('what is tavily?');

    expect(served).toEqual(results('https://provider.example/1'));
    expect(inner.calls).toHaveLength(1);
    expect(requestB.stats()).toEqual({
      hits: 1,
      misses: 0,
      allHits: true,
      prefetch: { issued: 0, joined: 0 }
    });
  });

  it('swallows a prewarm whose provider rejects when nobody joined it — no throw, no unhandled rejection', async () => {
    const inner = rejectingSearch(new Error('tavily down'));
    const cached = make(inner);

    expect(() => cached.prewarm('what is tavily?')).not.toThrow();
    // Vitest fails the run on any unhandled rejection surfacing during this tick.
    await flush();

    expect(inner.calls).toHaveLength(1);
    expect(cached.stats()).toEqual({
      hits: 0,
      misses: 0,
      allHits: false,
      prefetch: { issued: 1, joined: 0 }
    });
  });

  it('rejects the joining search with the provider error when the prewarm it joined fails — fail loud, not a plausible empty result', async () => {
    const inner = gatedRejectingSearch(new Error('tavily down'));
    const cached = make(inner);

    cached.prewarm('what is tavily?');
    const served = cached.search('what is tavily?');
    inner.release();

    await expect(served).rejects.toThrow('tavily down');
    expect(inner.calls).toHaveLength(1);
    expect(cached.stats()).toEqual({
      hits: 0,
      misses: 1,
      allHits: false,
      prefetch: { issued: 1, joined: 1 }
    });
  });

  it('joins an in-flight prewarm before reading L2, so the joining search never pays a store round trip', async () => {
    const inner = gatedSearch(results('https://provider.example/1'));
    const store = recordingStore();
    const cached = make(inner, store);

    cached.prewarm('what is tavily?');
    await flush(); // the prewarm's own L1 → L2 lookup has completed and the provider call is gated
    expect(store.gets).toHaveLength(1);

    const served = cached.search('what is tavily?');
    await flush();
    expect(store.gets).toHaveLength(1);

    inner.release();
    expect(await served).toEqual(results('https://provider.example/1'));
    expect(inner.calls).toHaveLength(1);
    expect(store.gets).toHaveLength(1);
  });

  it('still coalesces a time-sensitive query onto its prewarm via in-flight dedupe, and still reports allHits false', async () => {
    const inner = gatedSearch(results('https://live.example/1'));
    const key = searchCacheKey('latest tavily pricing', 'tavily');
    const store = recordingStore([cacheRow(key, results('https://stored.example/1'), NOW + 60_000)]);
    const cached = make(inner, store);

    cached.prewarm('latest tavily pricing');
    const served = cached.search('latest tavily pricing');
    inner.release();

    expect(await served).toEqual(results('https://live.example/1'));
    expect(inner.calls).toHaveLength(1);
    expect(cached.stats()).toEqual({
      hits: 0,
      misses: 1,
      allHits: false,
      prefetch: { issued: 1, joined: 1 }
    });
  });
});
