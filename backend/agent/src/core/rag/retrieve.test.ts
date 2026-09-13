/**
 * RED — M7 hybrid retrieval (SPEC 5.4): $vectorSearch + Atlas $search (BM25) fused with
 * reciprocal rank fusion. The port boundary is where `spaceId`/`userId` must be available
 * to go INSIDE the vector stage; these tests pin that they are passed to both halves, that
 * the two halves overlap in time, and that a half-failure is loud rather than silently
 * degrading a "hybrid" answer to vector-only.
 */
import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMS } from '@lumina/contract';
import {
  retrieveChunks,
  type ChunkSearchPort,
  type RetrieveConfig,
  type RetrieveDeps,
  type RetrievedChunk
} from './retrieve.js';

const CONFIG: RetrieveConfig = { topK: 5, candidateK: 20, numCandidates: 200, rrfK: 60 };

const chunk = (id: string, score = 0.5): RetrievedChunk => ({
  chunkId: id,
  docId: 'doc_1',
  title: 'retrieval-basics.pdf',
  text: `text of ${id}`,
  locator: { page: 1 },
  ord: 0,
  score
});

interface Spy {
  vectorArgs: Parameters<ChunkSearchPort['vector']>[0][];
  textArgs: Parameters<ChunkSearchPort['text']>[0][];
  embedCalls: string[][];
  order: string[];
}

function makeDeps(opts: {
  vector?: RetrievedChunk[];
  text?: RetrievedChunk[];
  vectorError?: Error;
  textError?: Error;
  /** Resolve the vector half late so concurrency is observable. */
  vectorDelay?: boolean;
}): { deps: RetrieveDeps; spy: Spy } {
  const spy: Spy = { vectorArgs: [], textArgs: [], embedCalls: [], order: [] };
  const deps: RetrieveDeps = {
    embeddings: {
      async embed(texts) {
        spy.embedCalls.push(texts);
        return texts.map(() => new Array<number>(EMBEDDING_DIMS).fill(0.1));
      }
    },
    chunks: {
      async vector(args) {
        spy.vectorArgs.push(args);
        spy.order.push('vector:start');
        if (opts.vectorDelay) await new Promise((r) => setTimeout(r, 15));
        if (opts.vectorError) throw opts.vectorError;
        spy.order.push('vector:end');
        return opts.vector ?? [];
      },
      async text(args) {
        spy.textArgs.push(args);
        spy.order.push('text:start');
        if (opts.textError) throw opts.textError;
        spy.order.push('text:end');
        return opts.text ?? [];
      }
    },
    config: CONFIG
  };
  return { deps, spy };
}

const ASK = { query: 'what is the default k1 in BM25', spaceId: 'spc_one', userId: 'u1' };

describe('retrieveChunks', () => {
  it('embeds the query exactly once and sends that vector to the vector half', async () => {
    const { deps, spy } = makeDeps({ vector: [chunk('a')] });
    await retrieveChunks(ASK, deps);

    expect(spy.embedCalls).toEqual([[ASK.query]]);
    expect(spy.vectorArgs[0]?.embedding).toHaveLength(EMBEDDING_DIMS);
  });

  it('runs both halves concurrently rather than one after the other', async () => {
    const { deps, spy } = makeDeps({ vectorDelay: true, vector: [chunk('a')], text: [chunk('b')] });
    await retrieveChunks(ASK, deps);

    // The text half must have STARTED before the slow vector half resolved.
    expect(spy.order.indexOf('text:start')).toBeLessThan(spy.order.indexOf('vector:end'));
  });

  it('passes spaceId AND userId into both halves, so the vector filter can live inside the stage', async () => {
    const { deps, spy } = makeDeps({});
    await retrieveChunks(ASK, deps);

    expect(spy.vectorArgs[0]).toMatchObject({ spaceId: 'spc_one', userId: 'u1' });
    expect(spy.textArgs[0]).toMatchObject({ spaceId: 'spc_one', userId: 'u1' });
  });

  it('takes its limits from config, never from hard-coded numbers', async () => {
    const { deps, spy } = makeDeps({});
    await retrieveChunks(ASK, deps);

    expect(spy.vectorArgs[0]?.limit).toBe(CONFIG.candidateK);
    expect(spy.vectorArgs[0]?.numCandidates).toBe(CONFIG.numCandidates);
    expect(spy.textArgs[0]?.limit).toBe(CONFIG.candidateK);
  });

  it('ranks a chunk both retrievers agree on above one that only a single retriever found', async () => {
    const { deps } = makeDeps({
      // `agreed` is 2nd for the vector half and 2nd for BM25; `dense-only` is 1st for one half.
      vector: [chunk('dense-only'), chunk('agreed')],
      text: [chunk('lexical-only'), chunk('agreed')]
    });

    const out = await retrieveChunks(ASK, deps);

    expect(out[0]?.chunkId).toBe('agreed');
    expect(out.map((c) => c.chunkId)).toHaveLength(3);
  });

  it('returns each chunk once and truncates to topK after fusing, not before', async () => {
    const many = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => chunk(`${prefix}${i}`));
    const { deps } = makeDeps({ vector: many('v', 8), text: [...many('v', 3), ...many('t', 5)] });

    const out = await retrieveChunks(ASK, deps);

    expect(out).toHaveLength(CONFIG.topK);
    expect(new Set(out.map((c) => c.chunkId)).size).toBe(out.length);
  });

  it('fails loud when the vector half rejects', async () => {
    const { deps } = makeDeps({ vectorError: new Error('vector index not queryable') });
    await expect(retrieveChunks(ASK, deps)).rejects.toThrow('vector index not queryable');
  });

  it('fails loud when the BM25 half rejects — a silent vector-only answer is not hybrid', async () => {
    const { deps } = makeDeps({ textError: new Error('no chunks_text index') });
    await expect(retrieveChunks(ASK, deps)).rejects.toThrow('no chunks_text index');
  });

  it('returns an empty list when the Space holds nothing, instead of erroring', async () => {
    const { deps } = makeDeps({ vector: [], text: [] });
    await expect(retrieveChunks(ASK, deps)).resolves.toEqual([]);
  });
});
