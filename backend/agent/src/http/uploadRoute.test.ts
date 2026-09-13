/**
 * RED — http/uploadRoute.ts: `makeUploadDocumentHandler` (contract ROUTE
 * `POST /spaces/:spaceId/documents`, auth:true; ARCHITECTURE.md §2.2 http/routes/spaces.ts +
 * the async ingestion rule: 202 in <300 ms → jobs row → worker).
 *
 * The handler is mounted here in a bare express app so the multipart path is exercised
 * directly (makeAgentApp only mounts the handler it is given).
 *
 * Deps (the seam the green phase must implement):
 *   spaces:    Pick<SpacesRepo, 'findOwned'>
 *   documents: { insert(doc: DocumentDoc): Promise<void> }
 *   jobs:      { enqueue(job: JobDoc): Promise<void> }
 *   files:     { openUploadStream(filename, metadata): { fileId, stream } }   // GridFS seam
 *   now():     number
 *   maxBytes?: number                                                        // default MAX_UPLOAD_BYTES
 *
 * NOTE the absence of any parse/embed/chunk seam: it is the structural proof that no parsing
 * happens in the request path — the enqueued job is the only handoff.
 */
import { Writable } from 'node:stream';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  DocId,
  DocumentDoc,
  ErrorBody,
  JobDoc,
  MAX_UPLOAD_BYTES,
  USER_HEADER,
  UploadDocumentResponse
} from '@lumina/contract';
import { makeUploadDocumentHandler } from './uploadRoute.js';

const OWNER = 'u_alice';
const OTHER = 'u_bob';
const SPACE = 'spc_alice1';
const NOW = Date.parse('2026-09-13T10:00:00.000Z');
const NOW_ISO = '2026-09-13T10:00:00.000Z';
const FILE_ID = 'gridfs_0001';

interface SpaceRow {
  spaceId: string;
  userId: string;
  name: string;
  createdAt: string;
}

interface Recorder {
  calls: string[];
  documents: unknown[];
  jobs: unknown[];
  written: Buffer[];
  openArgs: Array<{ filename: string; metadata: Record<string, unknown> }>;
  findOwnedCalls: Array<{ spaceId: string; userId: string }>;
}

function makeDeps(rows: SpaceRow[] = [{ spaceId: SPACE, userId: OWNER, name: 'Q3', createdAt: NOW_ISO }]): {
  deps: Record<string, unknown>;
  rec: Recorder;
} {
  const rec: Recorder = {
    calls: [],
    documents: [],
    jobs: [],
    written: [],
    openArgs: [],
    findOwnedCalls: []
  };
  const deps = {
    spaces: {
      async findOwned({ spaceId, userId }: { spaceId: string; userId: string }): Promise<SpaceRow | null> {
        rec.findOwnedCalls.push({ spaceId, userId });
        const hit = rows.find((r) => r.spaceId === spaceId && r.userId === userId);
        return hit ? { ...hit } : null;
      }
    },
    documents: {
      async insert(doc: unknown): Promise<void> {
        rec.calls.push('documents.insert');
        rec.documents.push(doc);
      }
    },
    jobs: {
      async enqueue(job: unknown): Promise<void> {
        rec.calls.push('jobs.enqueue');
        rec.jobs.push(job);
      }
    },
    files: {
      openUploadStream(filename: string, metadata: Record<string, unknown>) {
        rec.calls.push('files.open');
        rec.openArgs.push({ filename, metadata });
        const stream = new Writable({
          write(chunk: Buffer, _enc, cb) {
            rec.written.push(Buffer.from(chunk));
            cb();
          }
        });
        stream.on('finish', () => rec.calls.push('files.finish'));
        return { fileId: FILE_ID, stream };
      }
    },
    now: () => NOW
  };
  return { deps, rec };
}

function mount(deps: Record<string, unknown>): express.Express {
  const app = express();
  const requireUserStub: express.RequestHandler = (req, res, next) => {
    const userId = req.header(USER_HEADER);
    if (!userId) {
      res.status(401).json({ error: 'x-user-id header required', status: 401 });
      return;
    }
    res.locals.userId = userId;
    next();
  };
  app.post(
    '/spaces/:spaceId/documents',
    requireUserStub,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    makeUploadDocumentHandler(deps as any)
  );
  return app;
}

const PDF_BYTES = Buffer.from('%PDF-1.7\nfake board pack bytes\n');

const upload = (
  app: express.Express,
  opts: {
    user?: string;
    space?: string;
    buffer?: Buffer;
    filename?: string;
    contentType?: string;
  } = {}
): request.Test => {
  const req = request(app).post(`/spaces/${opts.space ?? SPACE}/documents`);
  if (opts.user !== undefined) req.set(USER_HEADER, opts.user);
  return req.attach('file', opts.buffer ?? PDF_BYTES, {
    filename: opts.filename ?? 'board-pack.pdf',
    contentType: opts.contentType ?? 'application/pdf'
  });
};

describe('POST /spaces/:spaceId/documents (upload)', () => {
  it('accepts a pdf with 202 and an UploadDocumentResponse in pending state', async () => {
    const { deps } = makeDeps();

    const res = await upload(mount(deps), { user: OWNER });

    expect(res.status).toBe(202);
    const body = UploadDocumentResponse.parse(res.body);
    expect(body.status).toBe('pending');
    expect(DocId.parse(body.docId)).toBe(body.docId);
  });

  it('inserts a DocumentDoc carrying the caller, the space, the filename, the byte count and the GridFS id', async () => {
    const { deps, rec } = makeDeps();

    const res = await upload(mount(deps), { user: OWNER });

    expect(rec.documents).toHaveLength(1);
    const doc = DocumentDoc.parse(rec.documents[0]);
    expect(doc).toMatchObject({
      _id: res.body.docId,
      spaceId: SPACE,
      userId: OWNER,
      title: 'board-pack.pdf',
      mimeType: 'application/pdf',
      bytes: PDF_BYTES.byteLength,
      status: 'pending',
      pct: 0,
      fileId: FILE_ID,
      createdAt: NOW_ISO
    });
  });

  it('enqueues an index_document job pointing at the doc, so parsing never runs in the request path', async () => {
    const { deps, rec } = makeDeps();

    const res = await upload(mount(deps), { user: OWNER });

    expect(rec.jobs).toHaveLength(1);
    const raw = rec.jobs[0] as Record<string, unknown>;
    expect(raw.attempts).toBe(0);
    const job = JobDoc.parse(raw);
    expect(job.kind).toBe('index_document');
    expect(job.status).toBe('pending');
    expect(job.userId).toBe(OWNER);
    expect(job.payload).toMatchObject({ docId: res.body.docId });
  });

  it('pipes the uploaded bytes into the GridFS writable', async () => {
    const { deps, rec } = makeDeps();

    await upload(mount(deps), { user: OWNER });

    expect(Buffer.concat(rec.written).equals(PDF_BYTES)).toBe(true);
    expect(rec.openArgs[0]?.filename).toBe('board-pack.pdf');
  });

  it('inserts the document only after the file stream has finished, never pointing at a half-written file', async () => {
    const { deps, rec } = makeDeps();

    await upload(mount(deps), { user: OWNER });

    expect(rec.calls).toEqual(['files.open', 'files.finish', 'documents.insert', 'jobs.enqueue']);
  });

  it('accepts text/markdown', async () => {
    const { deps, rec } = makeDeps();

    const res = await upload(mount(deps), {
      user: OWNER,
      buffer: Buffer.from('# minutes\n'),
      filename: 'minutes.md',
      contentType: 'text/markdown'
    });

    expect(res.status).toBe(202);
    expect(rec.documents).toHaveLength(1);
  });

  it('accepts text/plain', async () => {
    const { deps, rec } = makeDeps();

    const res = await upload(mount(deps), {
      user: OWNER,
      buffer: Buffer.from('plain notes'),
      filename: 'notes.txt',
      contentType: 'text/plain'
    });

    expect(res.status).toBe(202);
    expect(rec.documents).toHaveLength(1);
  });

  it('rejects an image with 415 and writes nothing anywhere', async () => {
    const { deps, rec } = makeDeps();

    const res = await upload(mount(deps), {
      user: OWNER,
      buffer: Buffer.from('\x89PNG\r\n'),
      filename: 'diagram.png',
      contentType: 'image/png'
    });

    expect(res.status).toBe(415);
    expect(ErrorBody.parse(res.body).status).toBe(415);
    expect(rec.documents).toHaveLength(0);
    expect(rec.jobs).toHaveLength(0);
    expect(rec.written).toHaveLength(0);
  });

  it('rejects a zip with 415 and writes nothing anywhere', async () => {
    const { deps, rec } = makeDeps();

    const res = await upload(mount(deps), {
      user: OWNER,
      buffer: Buffer.from('PK\x03\x04'),
      filename: 'bundle.zip',
      contentType: 'application/zip'
    });

    expect(res.status).toBe(415);
    expect(ErrorBody.parse(res.body).status).toBe(415);
    expect(rec.documents).toHaveLength(0);
    expect(rec.jobs).toHaveLength(0);
    expect(rec.written).toHaveLength(0);
  });

  it('rejects a payload over the size cap with 413 and writes no rows', async () => {
    const { deps, rec } = makeDeps();

    const res = await upload(mount({ ...deps, maxBytes: 1024 }), {
      user: OWNER,
      buffer: Buffer.alloc(4096, 0x41),
      filename: 'huge.pdf'
    });

    expect(res.status).toBe(413);
    expect(ErrorBody.parse(res.body).status).toBe(413);
    expect(rec.documents).toHaveLength(0);
    expect(rec.jobs).toHaveLength(0);
  });

  it('defaults the size cap to the contract MAX_UPLOAD_BYTES, so an ordinary file passes', async () => {
    const { deps, rec } = makeDeps();
    const oneMb = Buffer.alloc(1024 * 1024, 0x42);
    expect(oneMb.byteLength).toBeLessThan(MAX_UPLOAD_BYTES);

    const res = await upload(mount(deps), { user: OWNER, buffer: oneMb });

    expect(res.status).toBe(202);
    expect(rec.documents).toHaveLength(1);
  });

  it('is 400 when the request carries no file part', async () => {
    const { deps, rec } = makeDeps();

    const res = await request(mount(deps))
      .post(`/spaces/${SPACE}/documents`)
      .set(USER_HEADER, OWNER)
      .field('title', 'no file here');

    expect(res.status).toBe(400);
    expect(ErrorBody.parse(res.body).status).toBe(400);
    expect(rec.documents).toHaveLength(0);
    expect(rec.jobs).toHaveLength(0);
  });

  it('is 404, never 403, for a space owned by another user, and ingests nothing', async () => {
    const { deps, rec } = makeDeps([
      { spaceId: SPACE, userId: OTHER, name: 'bob deal room', createdAt: NOW_ISO }
    ]);

    const res = await upload(mount(deps), { user: OWNER });

    expect(res.status).toBe(404);
    expect(ErrorBody.parse(res.body).status).toBe(404);
    expect(rec.documents).toHaveLength(0);
    expect(rec.jobs).toHaveLength(0);
    expect(rec.written).toHaveLength(0);
  });

  it('is 404 for an unknown space, and ingests nothing', async () => {
    const { deps, rec } = makeDeps();

    const res = await upload(mount(deps), { user: OWNER, space: 'spc_doesnotexist' });

    expect(res.status).toBe(404);
    expect(ErrorBody.parse(res.body).status).toBe(404);
    expect(rec.documents).toHaveLength(0);
    expect(rec.jobs).toHaveLength(0);
    expect(rec.written).toHaveLength(0);
  });

  it('checks ownership with the caller id before ingesting', async () => {
    const { deps, rec } = makeDeps();

    await upload(mount(deps), { user: OWNER });

    expect(rec.findOwnedCalls).toEqual([{ spaceId: SPACE, userId: OWNER }]);
  });

  it('has no parse or embeddings seam among its deps: the job is the only handoff', async () => {
    const { deps } = makeDeps();

    const res = await upload(mount(deps), { user: OWNER });

    expect(res.status).toBe(202);
    expect(Object.keys(deps).sort()).toEqual(['documents', 'files', 'jobs', 'now', 'spaces']);
  });
});
