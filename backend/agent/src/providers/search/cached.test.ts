import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SearchCacheDoc } from '@lumina/contract';
import type { SearchResult } from './port.js';
import { makeCachedSearch, searchCacheKey } from './cached.js';

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

    expect(cached.stats()).toEqual({ hits: 0, misses: 0, allHits: false });
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

    expect(cached.stats()).toEqual({ hits: 1, misses: 1, allHits: false });
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

    expect(cached.stats()).toEqual({ hits: 2, misses: 0, allHits: true });
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
