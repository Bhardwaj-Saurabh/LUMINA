/**
 * RED — providers/embeddings/port.ts: the dimension guard every embedding batch passes
 * through before it reaches Mongo (ARCHITECTURE.md §2.2 providers/embeddings/*).
 *
 * The adapter itself is excluded from unit TDD (lumina-tdd taxonomy: thin SDK translation),
 * but this guard is pure, cheap and load-bearing:
 *   the Azure deployment is text-embedding-3-large, whose NATIVE size is 3072. Forget the
 *   `dimensions: 1536` request parameter and the call still succeeds — it just returns
 *   3072-long vectors that the Atlas `memories_vector` / `chunks_vector` indexes (declared at
 *   EMBEDDING_DIMS) silently refuse, so recall goes quietly empty instead of failing loud.
 *   The guard turns that into a loud error at the boundary.
 *
 * INVENTED shape (implementer builds to match — flagged in the report):
 *   export function assertDims(vectors: number[][], dims: number): number[][]
 *     - returns the same array it was given (so adapters can `return assertDims(vecs, EMBEDDING_DIMS)`)
 *     - throws an Error naming the expected and the actual length when any vector is off
 *   (`dims` is an explicit parameter, never a hardcoded 1536; callers pass the contract's
 *    EMBEDDING_DIMS.)
 */
import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMS } from '@lumina/contract';
import { assertDims } from './port.js';

/** Deterministic filler — values are irrelevant to the guard, only the length is. */
const vec = (len: number, fill = 0.1): number[] => new Array<number>(len).fill(fill);

/** text-embedding-3-large's native size: what you get when `dimensions` is omitted. */
const LARGE_NATIVE_DIMS = 3072;

describe('assertDims', () => {
  it('accepts a batch whose vectors are exactly EMBEDDING_DIMS long, and returns it for chaining', () => {
    const batch = [vec(EMBEDDING_DIMS), vec(EMBEDDING_DIMS, 0.2)];

    expect(() => assertDims(batch, EMBEDDING_DIMS)).not.toThrow();
    expect(assertDims(batch, EMBEDDING_DIMS)).toBe(batch);
  });

  it('throws naming the expected and the actual length when a vector is the wrong size', () => {
    // The exact failure mode of a missing `dimensions` parameter on text-embedding-3-large.
    const batch = [vec(LARGE_NATIVE_DIMS)];

    let message = '';
    try {
      assertDims(batch, EMBEDDING_DIMS);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).not.toBe('');
    expect(message).toContain(String(EMBEDDING_DIMS));
    expect(message).toContain(String(LARGE_NATIVE_DIMS));
  });

  it('validates every vector in the batch, not just the first', () => {
    // First two are fine; the last is one element short — an off-by-one truncation upstream.
    const batch = [vec(EMBEDDING_DIMS), vec(EMBEDDING_DIMS), vec(EMBEDDING_DIMS - 1)];

    let message = '';
    try {
      assertDims(batch, EMBEDDING_DIMS);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain(String(EMBEDDING_DIMS));
    expect(message).toContain(String(EMBEDDING_DIMS - 1));
  });

  it('rejects an empty vector — a provider returning [] must not be written to the index', () => {
    expect(() => assertDims([vec(EMBEDDING_DIMS), []], EMBEDDING_DIMS)).toThrow();
  });

  it('honours the dims argument rather than a hardcoded size', () => {
    // Same batch: legal at its own width, illegal at the contract's width.
    const batch = [vec(LARGE_NATIVE_DIMS)];

    expect(() => assertDims(batch, LARGE_NATIVE_DIMS)).not.toThrow();
    expect(() => assertDims(batch, EMBEDDING_DIMS)).toThrow();
  });
});
