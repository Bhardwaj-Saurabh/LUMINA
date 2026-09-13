/**
 * RED — http/app.ts Spaces routes (contract ROUTES: `POST /spaces`, `GET /spaces`,
 * `GET /spaces/:spaceId/documents`, all auth:true; ARCHITECTURE.md §2.2 http/routes/spaces.ts).
 *
 * EXTENDS the makeAgentApp deps shape with OPTIONAL members (optional so routes.test.ts keeps
 * building the app without them and the unbuilt routes keep answering 501):
 *   spaces?: SpacesRepo
 *   documents?: Pick<DocumentsRepo, 'listBySpace'>
 *   uploadDocument?: express.RequestHandler        // exercised in uploadRoute.test.ts
 *
 * The repo is the userId boundary: `listByUser`/`findOwned` take the caller's id so Mongo
 * filters inside the query, never after the fact in the route. Ownership semantics mirror
 * threads and memories: a foreign Space is UNKNOWN — 404, never 403 — and the documents read
 * must not happen at all until ownership is proven.
 */
import type express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  ErrorBody,
  ListDocumentsResponse,
  ListSpacesResponse,
  CreateSpaceResponse,
  SpaceId,
  USER_HEADER,
  type DocStatus,
  type HealthResponse,
  type ThreadMessage
} from '@lumina/contract';
import { makeAgentApp } from './app.js';

const OWNER = 'u_alice';
const OTHER = 'u_bob';

const healthBody: HealthResponse = {
  status: 'ok',
  model: 'claude-sonnet-5',
  searchProvider: 'tavily',
  vectorStore: 'mongo-cosine-scan',
  db: 'ok'
};

// ---- the repo shapes the green phase must implement (kept local: test-owned contract) ----

export interface SpaceRow {
  spaceId: string;
  userId: string;
  name: string;
  createdAt: string;
}

interface SpacesRepo {
  insert(row: SpaceRow): Promise<void>;
  listByUser(userId: string): Promise<SpaceRow[]>;
  findOwned(args: { spaceId: string; userId: string }): Promise<SpaceRow | null>;
}

interface DocumentRowOut {
  docId: string;
  title: string;
  status: DocStatus;
  pct: number;
  pages?: number;
  chunks?: number;
  error?: string;
}

interface RecordingSpacesRepo extends SpacesRepo {
  rows: SpaceRow[];
  insertCalls: SpaceRow[];
  listByUserCalls: string[];
  findOwnedCalls: Array<{ spaceId: string; userId: string }>;
}

interface RecordingDocumentsRepo {
  listBySpace(args: { spaceId: string; userId: string }): Promise<DocumentRowOut[]>;
  listBySpaceCalls: Array<{ spaceId: string; userId: string }>;
}

const ALICE_SPACE: SpaceRow = {
  spaceId: 'spc_alice1',
  userId: OWNER,
  name: 'Q3 board pack',
  createdAt: '2026-09-12T00:00:00.000Z'
};

const BOB_SPACE: SpaceRow = {
  spaceId: 'spc_bob1',
  userId: OTHER,
  name: 'bob private deal room',
  createdAt: '2026-09-12T01:00:00.000Z'
};

const PARSING_DOC: DocumentRowOut = {
  docId: 'doc_midflight',
  title: 'board-pack.pdf',
  status: 'parsing',
  pct: 10
};

const INDEXED_DOC: DocumentRowOut = {
  docId: 'doc_finished',
  title: 'minutes.md',
  status: 'indexed',
  pct: 100,
  pages: 12,
  chunks: 84
};

function fakeSpacesRepo(seed: SpaceRow[]): RecordingSpacesRepo {
  const repo: RecordingSpacesRepo = {
    rows: seed.map((r) => ({ ...r })),
    insertCalls: [],
    listByUserCalls: [],
    findOwnedCalls: [],
    async insert(row) {
      repo.insertCalls.push({ ...row });
      repo.rows.push({ ...row });
    },
    async listByUser(userId) {
      repo.listByUserCalls.push(userId);
      return repo.rows.filter((r) => r.userId === userId).map((r) => ({ ...r }));
    },
    async findOwned({ spaceId, userId }) {
      repo.findOwnedCalls.push({ spaceId, userId });
      const hit = repo.rows.find((r) => r.spaceId === spaceId && r.userId === userId);
      return hit ? { ...hit } : null;
    }
  };
  return repo;
}

function fakeDocumentsRepo(docs: DocumentRowOut[]): RecordingDocumentsRepo {
  const repo: RecordingDocumentsRepo = {
    listBySpaceCalls: [],
    async listBySpace(args) {
      repo.listBySpaceCalls.push({ ...args });
      return docs.map((d) => ({ ...d }));
    }
  };
  return repo;
}

function makeApp(
  opts: { spaces?: SpaceRow[]; documents?: DocumentRowOut[]; withSpacesDep?: boolean } = {}
): {
  app: ReturnType<typeof makeAgentApp>;
  spaces: RecordingSpacesRepo;
  documents: RecordingDocumentsRepo;
} {
  const spaces = fakeSpacesRepo(opts.spaces ?? [{ ...ALICE_SPACE }, { ...BOB_SPACE }]);
  const documents = fakeDocumentsRepo(opts.documents ?? [{ ...PARSING_DOC }, { ...INDEXED_DOC }]);
  const wired = opts.withSpacesDep !== false;
  const app = makeAgentApp({
    threads: {
      async insert(): Promise<void> {},
      async findById(): Promise<null> {
        return null;
      }
    },
    messages: {
      async listByThread(): Promise<ThreadMessage[]> {
        return [];
      }
    },
    ...(wired ? { spaces, documents } : {}),
    runAsk: async (): Promise<void> => {},
    health: async () => healthBody
  } as Parameters<typeof makeAgentApp>[0]);
  return { app, spaces, documents };
}

describe('POST /spaces', () => {
  it('creates a Space and answers 201 with a CreateSpaceResponse', async () => {
    const { app } = makeApp();

    const res = await request(app).post('/spaces').set(USER_HEADER, OWNER).send({ name: 'Q3 board pack' });

    expect(res.status).toBe(201);
    const body = CreateSpaceResponse.parse(res.body);
    expect(body.name).toBe('Q3 board pack');
  });

  it('inserts the row under the calling user with a spc_-prefixed id', async () => {
    const { app, spaces } = makeApp();

    const res = await request(app).post('/spaces').set(USER_HEADER, OWNER).send({ name: 'Q3 board pack' });

    expect(spaces.insertCalls).toHaveLength(1);
    const row = spaces.insertCalls[0]!;
    expect(row.userId).toBe(OWNER);
    expect(row.name).toBe('Q3 board pack');
    expect(SpaceId.parse(row.spaceId)).toBe(row.spaceId);
    expect(res.body.spaceId).toBe(row.spaceId);
  });

  it('is 400 for a missing name, and inserts nothing', async () => {
    const { app, spaces } = makeApp();

    const res = await request(app).post('/spaces').set(USER_HEADER, OWNER).send({});

    expect(res.status).toBe(400);
    expect(ErrorBody.parse(res.body).status).toBe(400);
    expect(spaces.insertCalls).toHaveLength(0);
  });

  it('is 400 for an empty name, and inserts nothing', async () => {
    const { app, spaces } = makeApp();

    const res = await request(app).post('/spaces').set(USER_HEADER, OWNER).send({ name: '' });

    expect(res.status).toBe(400);
    expect(ErrorBody.parse(res.body).status).toBe(400);
    expect(spaces.insertCalls).toHaveLength(0);
  });

  it('is 401 without the user header, and inserts nothing', async () => {
    const { app, spaces } = makeApp();

    const res = await request(app).post('/spaces').send({ name: 'Q3 board pack' });

    expect(res.status).toBe(401);
    expect(ErrorBody.parse(res.body).status).toBe(401);
    expect(spaces.insertCalls).toHaveLength(0);
  });

  it('still answers 501 while the spaces dep is absent, rather than pretending to succeed', async () => {
    const { app } = makeApp({ withSpacesDep: false });

    const res = await request(app).post('/spaces').set(USER_HEADER, OWNER).send({ name: 'Q3 board pack' });

    expect(res.status).toBe(501);
    expect(ErrorBody.parse(res.body).status).toBe(501);
  });
});

describe('POST /spaces/:spaceId/documents wiring', () => {
  it('mounts the injected uploadDocument handler behind the user gate, instead of the 501 placeholder', async () => {
    const seen: Array<{ spaceId: string; userId: string }> = [];
    const app = makeAgentApp({
      threads: {
        async insert(): Promise<void> {},
        async findById(): Promise<null> {
          return null;
        }
      },
      messages: {
        async listByThread(): Promise<ThreadMessage[]> {
          return [];
        }
      },
      spaces: fakeSpacesRepo([{ ...ALICE_SPACE }]),
      documents: fakeDocumentsRepo([]),
      uploadDocument: ((req: express.Request, res: express.Response) => {
        seen.push({ spaceId: req.params.spaceId as string, userId: res.locals.userId as string });
        res.status(202).json({ docId: 'doc_stub', status: 'pending' });
      }) as unknown,
      runAsk: async (): Promise<void> => {},
      health: async () => healthBody
    } as Parameters<typeof makeAgentApp>[0]);

    const res = await request(app).post(`/spaces/${ALICE_SPACE.spaceId}/documents`).set(USER_HEADER, OWNER);

    expect(res.status).toBe(202);
    expect(seen).toEqual([{ spaceId: ALICE_SPACE.spaceId, userId: OWNER }]);
  });
});

describe('GET /spaces', () => {
  it('lists the caller spaces as a ListSpacesResponse', async () => {
    const { app } = makeApp();

    const res = await request(app).get('/spaces').set(USER_HEADER, OWNER);

    expect(res.status).toBe(200);
    const body = ListSpacesResponse.parse(res.body);
    expect(body.spaces).toEqual([
      { spaceId: ALICE_SPACE.spaceId, name: ALICE_SPACE.name, createdAt: ALICE_SPACE.createdAt }
    ]);
  });

  it('never leaks another user spaces', async () => {
    const { app } = makeApp();

    const res = await request(app).get('/spaces').set(USER_HEADER, OWNER);

    const body = ListSpacesResponse.parse(res.body);
    expect(body.spaces.map((s) => s.spaceId)).not.toContain(BOB_SPACE.spaceId);
    expect(JSON.stringify(body)).not.toContain(BOB_SPACE.name);
  });

  it('scopes the read in the repo query, passing the caller id', async () => {
    const { app, spaces } = makeApp();

    await request(app).get('/spaces').set(USER_HEADER, OWNER);

    expect(spaces.listByUserCalls).toEqual([OWNER]);
  });

  it('is 401 without the user header, and queries nothing', async () => {
    const { app, spaces } = makeApp();

    const res = await request(app).get('/spaces');

    expect(res.status).toBe(401);
    expect(ErrorBody.parse(res.body).status).toBe(401);
    expect(spaces.listByUserCalls).toHaveLength(0);
  });
});

describe('GET /spaces/:spaceId/documents', () => {
  it('returns in-flight and finished documents with their progress as a ListDocumentsResponse', async () => {
    const { app } = makeApp();

    const res = await request(app).get(`/spaces/${ALICE_SPACE.spaceId}/documents`).set(USER_HEADER, OWNER);

    expect(res.status).toBe(200);
    const body = ListDocumentsResponse.parse(res.body);
    expect(body.documents).toEqual([
      { docId: PARSING_DOC.docId, title: PARSING_DOC.title, status: 'parsing', pct: 10 },
      {
        docId: INDEXED_DOC.docId,
        title: INDEXED_DOC.title,
        status: 'indexed',
        pct: 100,
        pages: 12,
        chunks: 84
      }
    ]);
  });

  it('reads the documents scoped to both the space and the caller', async () => {
    const { app, documents } = makeApp();

    await request(app).get(`/spaces/${ALICE_SPACE.spaceId}/documents`).set(USER_HEADER, OWNER);

    expect(documents.listBySpaceCalls).toEqual([{ spaceId: ALICE_SPACE.spaceId, userId: OWNER }]);
  });

  it('is 404, never 403, for a space owned by another user, and never reads its documents', async () => {
    const { app, documents } = makeApp();

    const res = await request(app).get(`/spaces/${BOB_SPACE.spaceId}/documents`).set(USER_HEADER, OWNER);

    expect(res.status).toBe(404);
    expect(ErrorBody.parse(res.body).status).toBe(404);
    expect(documents.listBySpaceCalls).toHaveLength(0);
  });

  it('is 404 for an unknown space, and never reads its documents', async () => {
    const { app, documents } = makeApp();

    const res = await request(app).get('/spaces/spc_doesnotexist/documents').set(USER_HEADER, OWNER);

    expect(res.status).toBe(404);
    expect(ErrorBody.parse(res.body).status).toBe(404);
    expect(documents.listBySpaceCalls).toHaveLength(0);
  });

  it('checks ownership before the documents read, passing the caller id to the spaces repo', async () => {
    const { app, spaces } = makeApp();

    await request(app).get(`/spaces/${ALICE_SPACE.spaceId}/documents`).set(USER_HEADER, OWNER);

    expect(spaces.findOwnedCalls).toEqual([{ spaceId: ALICE_SPACE.spaceId, userId: OWNER }]);
  });

  it('is 401 without the user header, and touches neither repo', async () => {
    const { app, spaces, documents } = makeApp();

    const res = await request(app).get(`/spaces/${ALICE_SPACE.spaceId}/documents`);

    expect(res.status).toBe(401);
    expect(ErrorBody.parse(res.body).status).toBe(401);
    expect(spaces.findOwnedCalls).toHaveLength(0);
    expect(documents.listBySpaceCalls).toHaveLength(0);
  });
});
