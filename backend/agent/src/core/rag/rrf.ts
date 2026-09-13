/**
 * Reciprocal Rank Fusion — ARCHITECTURE.md §2 (hybrid retrieval: $vectorSearch + Atlas $search
 * fused with RRF). Score = sum over lists of 1/(k + rank), rank 1-based: mutual agreement across
 * independent retrievers outranks one retriever's confidence, and no score normalisation is needed.
 */

export interface RrfOptions<T> {
  /** Identity of an item across lists (chunkId, url, …) — fusion dedupes on it. */
  key: (item: T) => string;
  k?: number;
  /** Truncation applied after fusion, so it reflects fused scores, not input order. */
  limit?: number;
}

interface Fused<T> {
  item: T;
  score: number;
  bestRank: number;
  bestList: number;
  firstSeen: number;
}

export function rrfFuse<T>(lists: readonly T[][], options: RrfOptions<T>): T[] {
  const k = options.k ?? 60;
  const byKey = new Map<string, Fused<T>>();
  let seen = 0;

  for (let listIndex = 0; listIndex < lists.length; listIndex += 1) {
    const list = lists[listIndex] ?? [];
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      if (item === undefined) continue;
      const rank = i + 1;
      const id = options.key(item);
      const existing = byKey.get(id);
      if (!existing) {
        byKey.set(id, {
          item,
          score: 1 / (k + rank),
          bestRank: rank,
          bestList: listIndex,
          firstSeen: seen++
        });
        continue;
      }
      existing.score += 1 / (k + rank);
      // The surviving copy is the one from the list where the key ranked best; earliest list wins ties.
      if (rank < existing.bestRank) {
        existing.item = item;
        existing.bestRank = rank;
        existing.bestList = listIndex;
      }
    }
  }

  const fused = [...byKey.values()].sort(
    (a, b) => b.score - a.score || a.bestRank - b.bestRank || a.firstSeen - b.firstSeen
  );
  const limited = options.limit === undefined ? fused : fused.slice(0, options.limit);
  return limited.map((entry) => entry.item);
}
