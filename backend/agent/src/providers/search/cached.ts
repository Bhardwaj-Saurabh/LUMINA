/**
 * Two-tier search cache (ARCHITECTURE §2.2): L1 in-process LRU → L2 `searchCache` collection
 * → provider. Expiry is enforced in code at both tiers because Mongo's TTL sweeper only runs
 * about once a minute, so an expired row stays readable well past its `expiresAt`.
 *
 * H3 speculative prewarm: the model's `web_search` runs serially after LLM turn 1, so TTFT
 * pays for both. `prewarm(userQuery)` runs the same L1 → L2 → provider chain during turn 1 and
 * parks it in `inFlight`; a later `search(sameQuery)` joins it instead of dispatching. It
 * returns void and never touches a SourceCollector, so it cannot mint a source — only a
 * `search()` the model actually issued can. A join is counted as a miss, never a hit: the
 * >= 50 % cache-hit SLA must not be inflatable by prewarming.
 */
import { createHash } from 'node:crypto';
import type { SearchCacheDoc } from '@lumina/contract';
import { createLru, type Lru } from '../../infra/lru.js';
import {
  QUICK_DEPTH,
  QUICK_MAX_RESULTS,
  type SearchOptions,
  type SearchPort,
  type SearchResult
} from './port.js';

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
  /** `issued`: prewarm calls; `joined`: model searches that attached to an in-flight prewarm. */
  prefetch: { issued: number; joined: number };
}

export interface CachedSearch extends SearchPort {
  /** Fire-and-forget; see the header. Never throws, never rejects unobserved. */
  prewarm(rawQuery: string, opts?: SearchOptions): void;
  stats(): CachedSearchStats;
}

interface InFlight {
  promise: Promise<SearchResult[]>;
  speculative: boolean;
}

const L1_MAX_ENTRIES = 512;

/** One L1 per process, shared by every request; the cached port itself is per request. */
export const createSearchLru = (): Lru<CachedSearchEntry> =>
  createLru<CachedSearchEntry>(L1_MAX_ENTRIES);

// The contract's iso fields accept a string or a Date; the driver may hand back either.
const millis = (iso: string | Date): number =>
  iso instanceof Date ? iso.getTime() : Date.parse(iso);

const normalizeQuery = (query: string): string => query.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The search SHAPE is part of the identity of a cached result: the deep gear asks Tavily for
 * more results and a deeper crawl, so the same query returns a different set. Without this,
 * a quick 5-result row would be served to a deep search and deep would silently inherit
 * quick's retrieval. The quick defaults contribute nothing, so keys written before the deep
 * gear had its own shape stay valid.
 */
const shapeOf = (opts?: SearchOptions): string => {
  const maxResults = opts?.maxResults ?? QUICK_MAX_RESULTS;
  const depth = opts?.depth ?? QUICK_DEPTH;
  return maxResults === QUICK_MAX_RESULTS && depth === QUICK_DEPTH
    ? ''
    : `|r${maxResults}|d${depth}`;
};

export function searchCacheKey(query: string, provider: string, opts?: SearchOptions): string {
  return createHash('sha256')
    .update(`${normalizeQuery(query)}|${provider}${shapeOf(opts)}`)
    .digest('hex');
}

/** SPEC 5.2: "today"/"latest"/a current-or-future year make a cached answer stale by definition. */
function isTimeSensitive(normalizedQuery: string, at: number): boolean {
  if (normalizedQuery.includes('today') || normalizedQuery.includes('latest')) return true;
  const currentYear = new Date(at).getUTCFullYear();
  return (normalizedQuery.match(/\b\d{4}\b/g) ?? []).some((year) => Number(year) >= currentYear);
}

export function makeCachedSearch(opts: CachedSearchOptions): CachedSearch {
  const { inner, store, ttlSeconds, now, provider } = opts;
  const lru = opts.lru ?? createLru<CachedSearchEntry>(L1_MAX_ENTRIES);
  const inFlight = new Map<string, InFlight>();
  let hits = 0;
  let misses = 0;
  let issued = 0;
  let joined = 0;

  const fresh = (expiresAt: number, at: number): boolean => expiresAt > at;

  const readL1 = (key: string, at: number): SearchResult[] | undefined => {
    const entry = lru.get(key);
    return entry && fresh(entry.expiresAt, at) ? entry.results : undefined;
  };

  async function readL2(key: string, at: number): Promise<SearchResult[] | undefined> {
    const row = await store.get(key);
    if (!row || !fresh(millis(row.expiresAt), at)) return undefined;
    const results = row.results as unknown as SearchResult[];
    lru.set(key, { results, expiresAt: millis(row.expiresAt) });
    return results;
  }

  async function fetchAndStore(
    key: string,
    rawQuery: string,
    normalized: string,
    searchOpts: SearchOptions | undefined
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

  /** Registers synchronously so a `search()` on the very next line can join. */
  function track(key: string, work: Promise<SearchResult[]>, speculative: boolean): Promise<SearchResult[]> {
    const promise = work.finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, { promise, speculative });
    return promise;
  }

  // A join is a miss whatever it joined: the provider is doing the work, not the cache.
  function join(key: string): Promise<SearchResult[]> | undefined {
    const pending = inFlight.get(key);
    if (!pending) return undefined;
    misses += 1;
    if (pending.speculative) joined += 1;
    return pending.promise;
  }

  return {
    async search(rawQuery, searchOpts) {
      const normalized = normalizeQuery(rawQuery);
      const key = searchCacheKey(rawQuery, provider, searchOpts);
      const at = now();

      // A bypassed search still writes through, refreshing the TTL window for later callers,
      // and counts as a miss: `searchCached` must mean every search came from cache.
      const bypass = isTimeSensitive(normalized, at);
      if (!bypass) {
        const l1 = readL1(key, at);
        if (l1) {
          hits += 1;
          return l1;
        }
      }
      // Before L2: a joiner must never pay a store round trip the in-flight call already paid.
      const early = join(key);
      if (early) return early;
      if (!bypass) {
        const l2 = await readL2(key, at);
        if (l2) {
          hits += 1;
          return l2;
        }
      }
      // Something may have dispatched while L2 was in flight.
      const late = join(key);
      if (late) return late;

      misses += 1;
      return track(key, fetchAndStore(key, rawQuery, normalized, searchOpts), false);
    },
    prewarm(rawQuery, searchOpts) {
      issued += 1;
      const normalized = normalizeQuery(rawQuery);
      const key = searchCacheKey(rawQuery, provider, searchOpts);
      if (inFlight.has(key)) return;
      const at = now();
      const run = async (): Promise<SearchResult[]> => {
        if (!isTimeSensitive(normalized, at)) {
          const cached = readL1(key, at) ?? (await readL2(key, at));
          if (cached) return cached;
        }
        return fetchAndStore(key, rawQuery, normalized, searchOpts);
      };
      // Nobody may ever join: swallow here so a provider failure cannot surface as an unhandled
      // rejection. The tracked promise itself still rejects, so a joiner sees the real error.
      track(key, run(), true).catch(() => undefined);
    },
    stats: () => ({
      hits,
      misses,
      allHits: hits > 0 && misses === 0,
      prefetch: { issued, joined }
    })
  };
}
