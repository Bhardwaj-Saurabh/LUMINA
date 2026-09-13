/**
 * Two-tier search cache (ARCHITECTURE §2.2): L1 in-process LRU → L2 `searchCache` collection
 * → provider. Expiry is enforced in code at both tiers because Mongo's TTL sweeper only runs
 * about once a minute, so an expired row stays readable well past its `expiresAt`.
 */
import { createHash } from 'node:crypto';
import type { SearchCacheDoc } from '@lumina/contract';
import { createLru, type Lru } from '../../infra/lru.js';
import type { SearchPort, SearchResult } from './port.js';

export interface SearchCacheStore {
  get(key: string): Promise<SearchCacheDoc | null>;
  set(doc: SearchCacheDoc): Promise<void>;
}

/** L1 value: results plus their own deadline, since the LRU itself has no notion of time. */
export interface CachedSearchEntry {
  results: SearchResult[];
  expiresAt: number;
}

export interface CachedSearchOptions {
  inner: SearchPort;
  store: SearchCacheStore;
  ttlSeconds: number;
  now: () => number;
  provider: SearchCacheDoc['provider'];
  /** Shared across requests: an L1 scoped to one request would never hit. */
  lru?: Lru<CachedSearchEntry>;
}

export interface CachedSearchStats {
  hits: number;
  misses: number;
  /** Never true for zero searches: an answer that searched nothing cannot claim a cache hit. */
  allHits: boolean;
}

const L1_MAX_ENTRIES = 512;

/** One L1 per process, shared by every request; the cached port itself is per request. */
export const createSearchLru = (): Lru<CachedSearchEntry> =>
  createLru<CachedSearchEntry>(L1_MAX_ENTRIES);

// The contract's iso fields accept a string or a Date; the driver may hand back either.
const millis = (iso: string | Date): number =>
  iso instanceof Date ? iso.getTime() : Date.parse(iso);

const normalizeQuery = (query: string): string => query.trim().toLowerCase().replace(/\s+/g, ' ');

export function searchCacheKey(query: string, provider: string): string {
  return createHash('sha256').update(`${normalizeQuery(query)}|${provider}`).digest('hex');
}

/** SPEC 5.2: "today"/"latest"/a current-or-future year make a cached answer stale by definition. */
function isTimeSensitive(normalizedQuery: string, at: number): boolean {
  if (normalizedQuery.includes('today') || normalizedQuery.includes('latest')) return true;
  const currentYear = new Date(at).getUTCFullYear();
  return (normalizedQuery.match(/\b\d{4}\b/g) ?? []).some((year) => Number(year) >= currentYear);
}

export function makeCachedSearch(
  opts: CachedSearchOptions
): SearchPort & { stats(): CachedSearchStats } {
  const { inner, store, ttlSeconds, now, provider } = opts;
  const lru = opts.lru ?? createLru<CachedSearchEntry>(L1_MAX_ENTRIES);
  const inFlight = new Map<string, Promise<SearchResult[]>>();
  let hits = 0;
  let misses = 0;

  const fresh = (expiresAt: number, at: number): boolean => expiresAt > at;

  async function fetchAndStore(
    key: string,
    rawQuery: string,
    normalized: string,
    searchOpts: { maxResults?: number } | undefined
  ): Promise<SearchResult[]> {
    // The provider sees the caller's query verbatim; normalization only derives the key.
    const results = await inner.search(rawQuery, searchOpts);
    const at = now();
    const expiresAt = at + ttlSeconds * 1000;
    lru.set(key, { results, expiresAt });
    await store.set({
      _id: key,
      provider,
      query: normalized, // the string the key was derived from, so a key is reproducible
      results: results.map((r) => ({ ...r })),
      expiresAt: new Date(expiresAt).toISOString(),
      createdAt: new Date(at).toISOString()
    });
    return results;
  }

  return {
    async search(rawQuery, searchOpts) {
      const normalized = normalizeQuery(rawQuery);
      const key = searchCacheKey(rawQuery, provider);
      const at = now();

      // A bypassed search still writes through, refreshing the TTL window for later callers,
      // and counts as a miss: `searchCached` must mean every search came from cache.
      if (!isTimeSensitive(normalized, at)) {
        const l1 = lru.get(key);
        if (l1 && fresh(l1.expiresAt, at)) {
          hits += 1;
          return l1.results;
        }
        const row = await store.get(key);
        if (row && fresh(millis(row.expiresAt), at)) {
          const results = row.results as unknown as SearchResult[];
          lru.set(key, { results, expiresAt: millis(row.expiresAt) });
          hits += 1;
          return results;
        }
      }

      misses += 1;
      const pending = inFlight.get(key);
      if (pending) return pending;
      const call = fetchAndStore(key, rawQuery, normalized, searchOpts).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, call);
      return call;
    },
    stats: () => ({ hits, misses, allHits: hits > 0 && misses === 0 })
  };
}
