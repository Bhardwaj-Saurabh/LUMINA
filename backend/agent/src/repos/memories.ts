import type { Db } from 'mongodb';
import { COLLECTIONS, SEARCH_INDEXES, type MemoryDoc } from '@lumina/contract';

/** A stored memory as the repo hands it back — the embedding is projected away. */
export interface MemoryRow {
  memoryId: string;
  userId: string;
  text: string;
  createdAt: string;
  sourceThread?: string;
}

/** One $vectorSearch hit; `score` is the index similarity, carried for ranking only. */
export interface MemoryMatch {
  memoryId: string;
  text: string;
  score: number;
}

export interface MemoriesRepo {
  insert(doc: MemoryDoc): Promise<void>;
  searchByVector(args: { userId: string; vector: number[]; limit: number }): Promise<MemoryMatch[]>;
  list(userId: string): Promise<MemoryRow[]>;
  delete(args: { userId: string; memoryId: string }): Promise<boolean>;
}

/** Atlas guidance: candidates well above the requested limit, or recall degrades. */
const CANDIDATE_FACTOR = 10;

export function makeMemoriesRepo(db: Db): MemoriesRepo {
  const col = db.collection<MemoryDoc>(COLLECTIONS.memories);
  return {
    async insert(doc) {
      await col.insertOne(doc);
    },

    async searchByVector({ userId, vector, limit }) {
      const hits = await col
        .aggregate<{ _id: string; text: string; score: number }>([
          {
            $vectorSearch: {
              index: SEARCH_INDEXES.memoriesVector,
              path: 'embedding',
              queryVector: vector,
              numCandidates: limit * CANDIDATE_FACTOR,
              limit,
              // The userId filter MUST live inside the stage: a later $match filters the
              // already-chosen nearest neighbours, so another user's vectors crowd out
              // this user's and recall silently empties (scripts/indexes.json says the same).
              filter: { userId }
            }
          },
          { $project: { _id: 1, text: 1, score: { $meta: 'vectorSearchScore' } } }
        ])
        .toArray();
      return hits.map((h) => ({ memoryId: h._id, text: h.text, score: h.score }));
    },

    async list(userId) {
      const docs = await col
        .find({ userId }, { projection: { embedding: 0 } })
        .sort({ createdAt: -1 })
        .toArray();
      return docs.map((d) => ({
        memoryId: d._id,
        userId: d.userId,
        text: d.text,
        ...(d.sourceThread ? { sourceThread: d.sourceThread } : {}),
        // MemoryDoc.createdAt is iso-string-or-Date; the HTTP Memory schema is string only.
        createdAt: typeof d.createdAt === 'string' ? d.createdAt : d.createdAt.toISOString()
      }));
    },

    async delete({ userId, memoryId }) {
      // Ownership is part of the filter, never a read-then-check.
      const res = await col.deleteOne({ _id: memoryId, userId });
      return res.deletedCount === 1;
    }
  };
}
