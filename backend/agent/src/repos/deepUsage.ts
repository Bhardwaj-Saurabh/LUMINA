/**
 * The deep-search ledger — SPEC 5.5's spend gate, made durable.
 *
 * Admission is recorded BEFORE the search runs, not after it finishes. Counting completed
 * deep searches would let a user start `cap + 1` of them at once and only discover the cap
 * afterwards, which is the one moment a spend gate is supposed to work.
 *
 * The rows live in `requests` under their own route marker rather than a new collection:
 * one ledger row per admitted deep search, separate from the row the finished answer
 * writes, so neither count contaminates the other.
 */
import type { Db } from 'mongodb';
import { COLLECTIONS, newId } from '@lumina/contract';
import type { DeepUsageStore } from '../core/deep/deepCap.js';

/** Not a real route: a marker that distinguishes a ledger row from an answer's row. */
export const DEEP_ADMISSION_ROUTE = 'deep-admission';

export function makeDeepUsageStore(db: Db): DeepUsageStore {
  const col = db.collection(COLLECTIONS.requests);
  return {
    async countSince({ userId, sinceIso }) {
      // ISO-8601 UTC strings compare lexicographically, and `requests` is indexed on createdAt.
      return col.countDocuments({
        userId,
        route: DEEP_ADMISSION_ROUTE,
        createdAt: { $gte: sinceIso }
      });
    },

    async record({ userId, atIso }) {
      await col.insertOne({
        requestId: newId('req'),
        userId,
        route: DEEP_ADMISSION_ROUTE,
        status: 202,
        ms: 0,
        depth: 'deep',
        createdAt: atIso
      });
    }
  };
}
