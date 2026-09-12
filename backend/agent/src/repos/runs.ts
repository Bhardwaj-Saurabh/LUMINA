import type { Db, Document } from 'mongodb';
import { COLLECTIONS } from '@lumina/contract';

/** Durable run-log store: Cloud Run's filesystem dies with the instance; Mongo does not. */
export function makeRunsRepo(db: Db) {
  const col = db.collection(COLLECTIONS.runs);
  return {
    async upsert(doc: Record<string, unknown>): Promise<void> {
      const { requestId, ...rest } = doc as { requestId: string } & Document;
      await col.updateOne(
        { requestId },
        { $set: { ...rest, requestId }, $setOnInsert: { createdAt: new Date().toISOString() } },
        { upsert: true }
      );
    }
  };
}

export function makeRequestsRepo(db: Db) {
  const col = db.collection(COLLECTIONS.requests);
  return {
    async insert(doc: Record<string, unknown>): Promise<void> {
      await col.insertOne({ ...doc, createdAt: new Date().toISOString() });
    }
  };
}
