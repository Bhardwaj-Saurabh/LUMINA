import type { Db } from 'mongodb';
import { COLLECTIONS } from '@lumina/contract';
import type { ThreadRow, ThreadsRepo } from '../http/app.js';

export function makeThreadsRepo(db: Db): ThreadsRepo {
  const col = db.collection<ThreadRow & { _id: string }>(COLLECTIONS.threads);
  return {
    async insert(row) {
      await col.insertOne({ _id: row.threadId, ...row });
    },
    async findById(threadId) {
      const doc = await col.findOne({ _id: threadId });
      if (!doc) return null;
      const { _id, ...row } = doc;
      void _id;
      return row;
    }
  };
}
