/**
 * GridFS seam — ARCHITECTURE.md §2.2 (infra/). The upload route pipes the request body
 * straight in, so a 25 MB PDF is never held in the service's heap; the worker reads it
 * back by id when it gets round to the job.
 *
 * Narrow on purpose: two methods, no bucket object escaping into routes or core.
 */
import { GridFSBucket, ObjectId, type Db } from 'mongodb';
import type { Writable } from 'node:stream';
import { GRIDFS_BUCKETS } from '@lumina/contract';
import type { FileStore } from '../core/rag/ingest.js';

export interface FileBucket extends FileStore {
  /** `fileId` is available immediately; the bytes are not written until the stream ends. */
  openUploadStream(
    filename: string,
    metadata: Record<string, unknown>
  ): { fileId: string; stream: Writable };
  delete(fileId: string): Promise<void>;
}

export function makeFileBucket(db: Db): FileBucket {
  const bucket = new GridFSBucket(db, { bucketName: GRIDFS_BUCKETS.uploads });
  return {
    openUploadStream(filename, metadata) {
      const stream = bucket.openUploadStream(filename, { metadata });
      return { fileId: stream.id.toHexString(), stream };
    },

    async read(fileId) {
      const chunks: Buffer[] = [];
      const download = bucket.openDownloadStream(new ObjectId(fileId));
      for await (const chunk of download) chunks.push(chunk as Buffer);
      return new Uint8Array(Buffer.concat(chunks));
    },

    async delete(fileId) {
      await bucket.delete(new ObjectId(fileId));
    }
  };
}
