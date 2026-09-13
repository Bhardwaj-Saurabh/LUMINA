/**
 * Hybrid retrieval — SPEC 5.4 / ARCHITECTURE.md §2: $vectorSearch + Atlas $search (BM25),
 * fused with RRF. spaceId/userId are passed into both halves so the vector filter can live
 * INSIDE the $vectorSearch stage (a later $match leaks across Spaces). Both halves must
 * succeed: a "hybrid" retriever that silently degrades to vector-only is worse than an error.
 *
 * Deliberate omission: no cross-encoder re-rank. There is no reranker deployment available to
 * this project, and SPEC allows skipping it with a stated reason — RRF over two independent
 * rankers is the documented substitute.
 */
import type { Locator } from '@lumina/contract';
import type { EmbeddingsPort } from '../../providers/embeddings/port.js';
import { rrfFuse } from './rrf.js';

export interface RetrievedChunk {
  chunkId: string;
  docId: string;
  title: string;
  text: string;
  locator: Locator;
  ord: number;
  /** The retriever's own score, carried for debugging; fusion uses rank, not score. */
  score: number;
}

export interface ChunkSearchPort {
  vector(args: {
    embedding: number[];
    spaceId: string;
    userId: string;
    limit: number;
    numCandidates: number;
  }): Promise<RetrievedChunk[]>;
  text(args: {
    query: string;
    spaceId: string;
    userId: string;
    limit: number;
  }): Promise<RetrievedChunk[]>;
}

export interface RetrieveConfig {
  topK: number;
  /** Per-half candidate depth; fusion needs more candidates than it returns. */
  candidateK: number;
  numCandidates: number;
  rrfK: number;
}

export interface RetrieveDeps {
  embeddings: EmbeddingsPort;
  chunks: ChunkSearchPort;
  config: RetrieveConfig;
}

export interface RetrieveQuery {
  query: string;
  spaceId: string;
  userId: string;
}

export async function retrieveChunks(
  ask: RetrieveQuery,
  deps: RetrieveDeps
): Promise<RetrievedChunk[]> {
  const { config } = deps;
  const [embedding] = await deps.embeddings.embed([ask.query]);
  if (!embedding) throw new Error('retrieveChunks: embeddings returned no vector');

  // Both dispatched before either is awaited: the two halves overlap in time.
  const dense = deps.chunks.vector({
    embedding,
    spaceId: ask.spaceId,
    userId: ask.userId,
    limit: config.candidateK,
    numCandidates: config.numCandidates
  });
  const lexical = deps.chunks.text({
    query: ask.query,
    spaceId: ask.spaceId,
    userId: ask.userId,
    limit: config.candidateK
  });

  const [vectorHits, textHits] = await Promise.all([dense, lexical]);
  return rrfFuse([vectorHits, textHits], {
    key: (hit) => hit.chunkId,
    k: config.rrfK,
    limit: config.topK
  });
}
