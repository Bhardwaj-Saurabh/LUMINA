import type { Db } from 'mongodb';
import { COLLECTIONS, type ThreadMessage } from '@lumina/contract';
import type { MessagesRepo } from '../http/app.js';

interface MessageDoc extends ThreadMessage {
  threadId: string;
  userId: string;
  createdAt: string;
}

export interface MessagesWriter extends MessagesRepo {
  insertMany(threadId: string, userId: string, messages: ThreadMessage[]): Promise<void>;
}

export function makeMessagesRepo(db: Db): MessagesWriter {
  const col = db.collection<MessageDoc>(COLLECTIONS.messages);
  return {
    async listByThread(threadId) {
      const docs = await col.find({ threadId }).sort({ createdAt: 1 }).toArray();
      return docs.map(({ role, content, sources, answerId, done, createdAt }) => ({
        role,
        content,
        ...(sources ? { sources } : {}),
        ...(answerId ? { answerId } : {}),
        ...(done ? { done } : {}),
        ...(createdAt ? { createdAt } : {})
      }));
    },
    async insertMany(threadId, userId, messages) {
      if (messages.length === 0) return;
      const at = Date.now();
      await col.insertMany(
        // Preserve ordering under a same-millisecond insert: offset each createdAt by index.
        messages.map((m, i) => ({ ...m, threadId, userId, createdAt: new Date(at + i).toISOString() }))
      );
    }
  };
}
