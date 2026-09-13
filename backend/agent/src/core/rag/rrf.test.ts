import { describe, expect, it } from 'vitest';
import { rrfFuse } from './rrf.js';

/**
 * rrfFuse — ARCHITECTURE.md §2 (hybrid retrieval: $vectorSearch + Atlas $search fused with RRF).
 * Score = sum over lists of 1/(k + rank), rank 1-based, k default 60. The point of RRF is that
 * mutual agreement across retrievers beats a single retriever's confidence, so the arithmetic
 * is asserted explicitly rather than "trust the ordering".
 */

interface Hit {
  id: string;
  score: number;
}

const hit = (id: string, score = 0): Hit => ({ id, score });
const key = (h: Hit) => h.id;
const ids = (hits: Hit[]) => hits.map((h) => h.id);

describe('rrfFuse ranking', () => {
  it('ranks an item found first by both retrievers above an item found first by only one', () => {
    const vector = [hit('both'), hit('vector-only')];
    const text = [hit('both'), hit('text-only')];

    const fused = rrfFuse([vector, text], { key });

    expect(fused[0]?.id).toBe('both');
  });

  it('lets an item ranked #3 in both lists outrank an item ranked #1 in a single list', () => {
    // 2/(60+3) = 0.031746… > 1/(60+1) = 0.016393… — mutual agreement is why RRF is used.
    expect(2 / (60 + 3)).toBeGreaterThan(1 / (60 + 1));

    const vector = [hit('solo'), hit('filler-a'), hit('agreed')];
    const text = [hit('filler-b'), hit('filler-c'), hit('agreed')];

    const fused = rrfFuse([vector, text], { key });

    expect(fused[0]?.id).toBe('agreed');
    expect(ids(fused).indexOf('agreed')).toBeLessThan(ids(fused).indexOf('solo'));
  });

  it('honours a custom k, which flattens the penalty for a deep rank', () => {
    const vector = [hit('solo'), hit('filler-a'), hit('agreed')];
    const text = [hit('filler-b'), hit('filler-c'), hit('agreed')];

    const fused = rrfFuse([vector, text], { key, k: 0 });

    // k=0: agreed scores 1/3 + 1/3 = 0.666…, solo scores 1/1 = 1, so solo now wins.
    expect(fused[0]?.id).toBe('solo');
  });
});

describe('rrfFuse dedupe', () => {
  it('emits each key exactly once even when every list returns it', () => {
    const a = [hit('dup'), hit('a1')];
    const b = [hit('dup'), hit('b1')];
    const c = [hit('dup'), hit('c1')];

    const fused = rrfFuse([a, b, c], { key });

    expect(fused.filter((h) => h.id === 'dup')).toHaveLength(1);
    expect(new Set(ids(fused)).size).toBe(fused.length);
    expect(ids(fused).sort()).toEqual(['a1', 'b1', 'c1', 'dup']);
  });

  it('keeps the copy from the list where the key achieved its best (lowest) rank', () => {
    const vector = [hit('filler-a'), hit('dup', 0.11)]; // rank 2
    const text = [hit('dup', 0.99), hit('filler-b')]; // rank 1 — this copy survives

    const fused = rrfFuse([vector, text], { key });
    const survivor = fused.find((h) => h.id === 'dup');

    expect(survivor?.score).toBe(0.99);
  });

  it('breaks a best-rank tie between copies in favour of the earliest list', () => {
    const vector = [hit('dup', 0.11)]; // rank 1 in list 0
    const text = [hit('dup', 0.99)]; // rank 1 in list 1

    const fused = rrfFuse([vector, text], { key });

    expect(fused.find((h) => h.id === 'dup')?.score).toBe(0.11);
  });
});

describe('rrfFuse limit and edge cases', () => {
  it('applies limit after fusion, so the truncation reflects fused scores not list order', () => {
    const vector = [hit('solo-a'), hit('solo-b'), hit('agreed')];
    const text = [hit('solo-c'), hit('solo-d'), hit('agreed')];

    const fused = rrfFuse([vector, text], { key, limit: 2 });

    expect(fused).toHaveLength(2);
    expect(fused[0]?.id).toBe('agreed');
  });

  it('returns an empty array when every list is empty, and when there are no lists at all', () => {
    expect(rrfFuse<Hit>([], { key })).toEqual([]);
    expect(rrfFuse<Hit>([[], []], { key })).toEqual([]);
  });

  it('preserves the original order when only one list is supplied', () => {
    const only = [hit('first'), hit('second'), hit('third')];

    const fused = rrfFuse([only], { key });

    expect(ids(fused)).toEqual(['first', 'second', 'third']);
  });

  it('orders equal-scoring items by best rank then first appearance, identically on every run', () => {
    const vector = [hit('v1'), hit('v2'), hit('v3')];
    const text = [hit('t1'), hit('t2'), hit('t3')];

    const first = rrfFuse([vector, text], { key });
    const second = rrfFuse([vector, text], { key });

    // No key appears in both lists: v_i and t_i tie at rank i, and list order decides.
    expect(ids(first)).toEqual(['v1', 't1', 'v2', 't2', 'v3', 't3']);
    expect(ids(second)).toEqual(ids(first));
  });
});
