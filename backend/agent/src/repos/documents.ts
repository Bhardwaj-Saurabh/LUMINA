/**
 * documents repo — ARCHITECTURE.md §2.2. Holds the ingestion state machine's persisted
 * side: `pending → parsing → embedding → indexed | failed` plus the `pct` the UI renders.
 * `setStatus` is what the worker calls at every stage boundary, so it is deliberately the
 * only write path for status — nothing else may declare a document indexed.
 */
import type { Db } from 'mongodb';
import { COLLECTIONS, type DocStatus, type DocumentDoc } from '@lumina/contract';
import type { DocumentsStore } from '../core/rag/ingest.js';

/** The shape `GET /spaces/:id/documents` returns (the contract's DocumentRow). */
export interface DocumentRowOut {
  docId: string;
  title: string;
  status: DocStatus;
  pct: number;
  pages?: number;
  chunks?: number;
  error?: string;
}

export interface DocumentsRepo extends DocumentsStore {
  insert(doc: DocumentDoc): Promise<void>;
  /**
   * Fail a document that is still mid-flight, keeping the `pct` it reached. The worker's
   * last resort for failures that happen before the pipeline starts; it must not overwrite
   * a richer error the pipeline itself already recorded.
   */
  failIfUnfinished(docId: string, error: string): Promise<void>;
  listBySpace(args: { spaceId: string; userId: string }): Promise<DocumentRowOut[]>;
  findById(docId: string): Promise<DocumentDoc | null>;
}

export function makeDocumentsRepo(db: Db): DocumentsRepo {
  const col = db.collection<DocumentDoc>(COLLECTIONS.documents);
  return {
    async insert(doc) {
      await col.insertOne(doc);
    },

    async setStatus(docId, patch) {
      // `error` is unset on every non-failed transition: a document that failed, was
      // re-uploaded and succeeded must not keep showing the old error in the UI.
      const unset = patch.error === undefined ? { $unset: { error: '' as const } } : {};
      await col.updateOne({ _id: docId }, { $set: { ...patch }, ...unset });
    },

    async failIfUnfinished(docId, error) {
      await col.updateOne(
        { _id: docId, status: { $nin: ['indexed', 'failed'] } },
        { $set: { status: 'failed', error } }
      );
    },

    async listBySpace({ spaceId, userId }) {
      const docs = await col
        .find({ spaceId, userId })
        .sort({ createdAt: 1 })
        .toArray();
      return docs.map((d) => ({
        docId: d._id,
        title: d.title,
        status: d.status,
        pct: d.pct,
        ...(d.pages !== undefined ? { pages: d.pages } : {}),
        ...(d.chunks !== undefined ? { chunks: d.chunks } : {}),
        ...(d.error !== undefined ? { error: d.error } : {})
      }));
    },

    async findById(docId) {
      return col.findOne({ _id: docId });
    }
  };
}
