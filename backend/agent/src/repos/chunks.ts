/**
 * chunks repo — ARCHITECTURE.md §2.2 / SPEC 5.4. One collection for every Space, with the
 * two halves of hybrid retrieval on it: `chunks_vector` ($vectorSearch) and `chunks_text`
 * (Atlas $search / BM25).
 *
 * The load-bearing detail is that BOTH filters live INSIDE their search stage. A later
 * $match filters the neighbours the index already chose, so another Space's chunks crowd
 * out this one's and recall goes quietly empty instead of failing — scripts/indexes.json
 * declares `spaceId` and `userId` as filter fields precisely so this is possible.
 *
 * The title a citation renders ("retrieval-basics.pdf, p. 2") lives on the document, not
 * the chunk, so it is joined here rather than denormalised — the join runs on at most
 * `limit` rows, after the index has already done the work.
 */
import type { Db } from 'mongodb';
import { COLLECTIONS, SEARCH_INDEXES, type ChunkDoc, type Locator } from '@lumina/contract';
import type { ChunksStore } from '../core/rag/ingest.js';
import type { ChunkSearchPort, RetrievedChunk } from '../core/rag/retrieve.js';

export type ChunksRepo = ChunksStore & ChunkSearchPort;

/** What the aggregation projects: the chunk, its score, and the joined document title. */
interface Hit {
  _id: string;
  docId: string;
  text: string;
  locator: Locator;
  ord: number;
  score: number;
  title?: string;
}

const toRetrieved = (h: Hit): RetrievedChunk => ({
  chunkId: h._id,
  docId: h.docId,
  title: h.title ?? h.docId,
  text: h.text,
  locator: h.locator,
  ord: h.ord,
  score: h.score
});

/** Join the document title and drop the 1536-float embedding before it crosses the wire. */
const withTitle = (scoreExpr: Record<string, unknown>) => [
  {
    $lookup: {
      from: COLLECTIONS.documents,
      localField: 'docId',
      foreignField: '_id',
      as: 'doc',
      pipeline: [{ $project: { title: 1 } }]
    }
  },
  {
    $project: {
      _id: 1,
      docId: 1,
      text: 1,
      locator: 1,
      ord: 1,
      score: scoreExpr,
      title: { $first: '$doc.title' }
    }
  }
];

export function makeChunksRepo(db: Db): ChunksRepo {
  const col = db.collection<ChunkDoc>(COLLECTIONS.chunks);
  return {
    async deleteByDoc(docId) {
      await col.deleteMany({ docId });
    },

    async upsertMany(chunks) {
      if (chunks.length === 0) return;
      // Deterministic _id (docId:ord) makes a re-ingest after a crash idempotent.
      await col.bulkWrite(
        chunks.map((chunk) => ({
          replaceOne: { filter: { _id: chunk._id }, replacement: chunk, upsert: true }
        })),
        { ordered: false }
      );
    },

    /**
     * Read-your-write: ask the vector INDEX (not the collection) for the chunk we just
     * wrote. "Upserted" is not "searchable" — Atlas Search is eventually consistent, and
     * this is the only evidence that a document is genuinely queryable.
     */
    async probe({ docId, spaceId, userId, vector }) {
      const hits = await col
        .aggregate<{ docId: string }>([
          {
            $vectorSearch: {
              index: SEARCH_INDEXES.chunksVector,
              path: 'embedding',
              queryVector: vector,
              numCandidates: 100,
              limit: 10,
              filter: { spaceId, userId }
            }
          },
          { $project: { docId: 1 } }
        ])
        .toArray();
      return hits.some((h) => h.docId === docId);
    },

    async vector({ embedding, spaceId, userId, limit, numCandidates }) {
      const hits = await col
        .aggregate<Hit>([
          {
            $vectorSearch: {
              index: SEARCH_INDEXES.chunksVector,
              path: 'embedding',
              queryVector: embedding,
              numCandidates,
              limit,
              filter: { spaceId, userId }
            }
          },
          ...withTitle({ $meta: 'vectorSearchScore' })
        ])
        .toArray();
      return hits.map(toRetrieved);
    },

    async text({ query, spaceId, userId, limit }) {
      const hits = await col
        .aggregate<Hit>([
          {
            $search: {
              index: SEARCH_INDEXES.chunksText,
              compound: {
                must: [{ text: { query, path: 'text' } }],
                // `token`-mapped fields: exact-match filter, scored 0, so BM25 ranking is
                // unaffected by the scoping.
                filter: [
                  { equals: { path: 'spaceId', value: spaceId } },
                  { equals: { path: 'userId', value: userId } }
                ]
              }
            }
          },
          { $limit: limit },
          ...withTitle({ $meta: 'searchScore' })
        ])
        .toArray();
      return hits.map(toRetrieved);
    }
  };
}
