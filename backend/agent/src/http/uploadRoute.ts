/**
 * makeUploadDocumentHandler — `POST /spaces/:spaceId/documents` (ARCHITECTURE.md §2.2
 * http/routes/spaces.ts + §4 async ingestion). The request path does no parsing, chunking
 * or embedding: bytes stream straight into GridFS and the enqueued job is the only handoff,
 * which is what keeps the 202 inside 300 ms and a 25 MB PDF out of the heap.
 */
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import multer from 'multer';
import {
  ACCEPTED_UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
  newId,
  type DocumentDoc,
  type ErrorBody,
  type JobDoc,
  type UploadDocumentResponse
} from '@lumina/contract';
import type { FileBucket } from '../infra/gridfs.js';
import type { SpacesRepo } from '../repos/spaces.js';

export interface UploadDeps {
  spaces: Pick<SpacesRepo, 'findOwned'>;
  documents: { insert(doc: DocumentDoc): Promise<void> };
  jobs: { enqueue(job: JobDoc): Promise<void> };
  files: Pick<FileBucket, 'openUploadStream'>;
  now(): number;
  /** Defaults to the contract's MAX_UPLOAD_BYTES; injectable so tests need not build 25 MB. */
  maxBytes?: number;
}

const errorBody = (status: number, error: string): ErrorBody => ({ error, status });

/** Distinguishable from a MulterError so the mapper can answer 415 rather than 400/502. */
class UnsupportedTypeError extends Error {}

const accepted = new Set<string>(ACCEPTED_UPLOAD_TYPES);

/** `text/plain; charset=utf-8` is still text/plain. */
const baseType = (mimetype: string): string => (mimetype.split(';')[0] ?? '').trim().toLowerCase();

interface StoredFile {
  fileId: string;
  bytes: number;
  mimeType: string;
  filename: string;
}

/**
 * StorageEngine that pipes the part into the GridFS seam — never memoryStorage, never a
 * temp file. `_removeFile` cannot unlink the GridFS file through this narrow seam, so an
 * aborted upload may leave an orphan blob; it is never referenced by a document row.
 */
function gridfsStorage(
  files: Pick<FileBucket, 'openUploadStream'>,
  userId: string,
  spaceId: string
): multer.StorageEngine {
  return {
    _handleFile(_req, file, cb) {
      const mimeType = baseType(file.mimetype);
      const { fileId, stream } = files.openUploadStream(file.originalname, {
        userId,
        spaceId,
        mimeType
      });
      let bytes = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, next) {
          bytes += chunk.length;
          next(null, chunk);
        }
      });
      pipeline(file.stream, counter, stream).then(
        () => {
          const stored: StoredFile = { fileId, bytes, mimeType, filename: file.originalname };
          cb(null, stored as unknown as Partial<Express.Multer.File>);
        },
        (err: Error) => cb(err)
      );
    },

    _removeFile(_req, _file, cb) {
      cb(null);
    }
  };
}

export function makeUploadDocumentHandler(deps: UploadDeps): express.RequestHandler {
  const maxBytes = deps.maxBytes ?? MAX_UPLOAD_BYTES;

  return (req, res, next) => {
    const spaceId = req.params.spaceId!;
    const userId = res.locals.userId as string;

    // Ownership first: a foreign or unknown Space is a 404 before a single byte is read.
    deps.spaces
      .findOwned({ spaceId, userId })
      .then((space) => {
        if (!space) {
          res.status(404).json(errorBody(404, `no space ${spaceId}`));
          return;
        }

        const accept = multer({
          storage: gridfsStorage(deps.files, userId, spaceId),
          limits: { fileSize: maxBytes, files: 1 },
          fileFilter: (_req, file, cb) => {
            if (!accepted.has(baseType(file.mimetype))) {
              cb(new UnsupportedTypeError(`unsupported content type ${file.mimetype}`));
              return;
            }
            cb(null, true);
          }
        }).single('file');

        // Multer reports size/type problems as an error on the middleware; each has its own
        // status, and anything else fails loud through the app's error handler.
        accept(req, res, (err?: unknown) => {
          if (err instanceof UnsupportedTypeError) {
            res.status(415).json(errorBody(415, `${err.message}; accepted: ${ACCEPTED_UPLOAD_TYPES.join(', ')}`));
            return;
          }
          if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json(errorBody(413, `file exceeds ${maxBytes} bytes`));
            return;
          }
          if (err) {
            next(err);
            return;
          }
          ingest(req, res).catch(next);
        });
      })
      .catch(next);
  };

  async function ingest(req: express.Request, res: express.Response): Promise<void> {
    const stored = req.file as unknown as StoredFile | undefined;
    if (!stored) {
      res.status(400).json(errorBody(400, 'file part required'));
      return;
    }

    // The row is written only now, after the stream finished: a document pointing at a
    // half-written file is unrecoverable.
    const docId = newId('doc');
    const createdAt = new Date(deps.now()).toISOString();
    const doc: DocumentDoc = {
      _id: docId,
      spaceId: req.params.spaceId!,
      userId: res.locals.userId as string,
      title: stored.filename,
      mimeType: stored.mimeType,
      bytes: stored.bytes,
      status: 'pending',
      pct: 0,
      fileId: stored.fileId,
      createdAt
    };
    await deps.documents.insert(doc);

    // One index job per document, so a retried enqueue collides on _id instead of
    // duplicating the work.
    const job: JobDoc = {
      _id: `job_${docId.slice('doc_'.length)}`,
      kind: 'index_document',
      status: 'pending',
      attempts: 0,
      userId: doc.userId,
      createdAt,
      payload: {
        docId,
        spaceId: doc.spaceId,
        userId: doc.userId,
        fileId: doc.fileId,
        mimeType: doc.mimeType,
        title: doc.title
      }
    };
    await deps.jobs.enqueue(job);

    const body: UploadDocumentResponse = { docId, status: 'pending' };
    res.status(202).json(body);
  }
}
