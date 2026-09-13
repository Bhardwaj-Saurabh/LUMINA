/**
 * EmbeddingsPort — neutral batch-embedding shape the tools and the ingest worker consume;
 * only providers/embeddings/* may import an SDK (ARCHITECTURE.md §2.2).
 */

export interface EmbeddingsPort {
  /** One vector per input text, order preserved. */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Width guard at the provider boundary. The Azure deployment is text-embedding-3-large,
 * whose NATIVE width is 3072: omit the `dimensions` request parameter and the call still
 * succeeds, returning vectors the Atlas indexes (declared at EMBEDDING_DIMS) silently
 * refuse — recall then goes quietly empty instead of failing. Returns its argument so an
 * adapter can `return assertDims(vectors, EMBEDDING_DIMS)`.
 */
export function assertDims(vectors: number[][], dims: number): number[][] {
  for (const [i, vector] of vectors.entries()) {
    if (vector.length !== dims) {
      throw new Error(
        `embeddings: expected ${dims}-dimensional vectors, got ${vector.length} at index ${i}`
      );
    }
  }
  return vectors;
}
