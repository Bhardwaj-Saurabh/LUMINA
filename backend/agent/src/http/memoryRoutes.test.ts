/**
 * RED — http/app.ts memory routes (contract ROUTES: `GET /memory`, `DELETE /memory/:memoryId`,
 * both auth:true; ARCHITECTURE.md §2.2 http/routes/memory.ts).
 *
 * EXTENDS the makeAgentApp deps shape with ONE new, OPTIONAL member (optional so the existing
 * routes.test.ts builds the app without it and stays green):
 *   memories?: {
 *     list(userId): Promise<MemoryRow[]>                          // MemoryRow = { memoryId, userId, text, createdAt, sourceThread? }
 *     delete({ userId, memoryId }): Promise<boolean>              // true = a row was removed, false = nothing matched
 *     insert(doc) / searchByVector(...)                           // used by the tools, not by these routes
 *   }
 * The repo is the userId boundary: both calls take the caller's id so Atlas filters inside the
 * query (same rule as `$vectorSearch`'s in-index filter), never after the fact in the route.
 *
 * Ownership semantics mirror threads: a foreign row is UNKNOWN — 404, never 403, so the API
 * never confirms that someone else's memoryId exists.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  ErrorBody,
  ListMemoryResponse,
  USER_HEADER,
  type HealthResponse,
  type ThreadMessage
} from '@lumina/contract';
import { fakeMemoriesRepo, type MemoryRow, type RecordingMemoriesRepo } from '../testing/fakes.js';
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

const ALICE_ROW: MemoryRow = {
  memoryId: 'mem_alice_1',
  userId: OWNER,
  text: 'alice prefers metric units',
  createdAt: '2026-09-12T00:00:00.000Z',
  sourceThread: 'thr_abc123'
};

const BOB_ROW: MemoryRow = {
  memoryId: 'mem_bob_1',
  userId: OTHER,
  text: 'bob is allergic to peanuts',
  createdAt: '2026-09-12T01:00:00.000Z'
};

function makeApp(rows: MemoryRow[] = [{ ...ALICE_ROW }, { ...BOB_ROW }]): {
  app: ReturnType<typeof makeAgentApp>;
  memories: RecordingMemoriesRepo;
} {
  const memories = fakeMemoriesRepo(rows);
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
    memories,
    runAsk: async (): Promise<void> => {},
    health: async () => healthBody
  });
  return { app, memories };
}

describe('GET /memory', () => {
  it('returns the caller memories as a ListMemoryResponse', async () => {
    const { app } = makeApp();

    const res = await request(app).get('/memory').set(USER_HEADER, OWNER);

    expect(res.status).toBe(200);
    const body = ListMemoryResponse.parse(res.body);
    expect(body.memories).toHaveLength(1);
    expect(body.memories[0]).toMatchObject({
      id: ALICE_ROW.memoryId,
      text: ALICE_ROW.text,
      sourceThread: ALICE_ROW.sourceThread,
      createdAt: ALICE_ROW.createdAt
    });
  });

  it('never lists another user memories', async () => {
    const { app } = makeApp();

    const res = await request(app).get('/memory').set(USER_HEADER, OWNER);

    const body = ListMemoryResponse.parse(res.body);
    expect(body.memories.map((m) => m.id)).not.toContain(BOB_ROW.memoryId);
    expect(JSON.stringify(body)).not.toContain(BOB_ROW.text);
  });

  it('scopes the read in the repo query, passing the caller id', async () => {
    const { app, memories } = makeApp();

    await request(app).get('/memory').set(USER_HEADER, OWNER);

    expect(memories.listCalls).toEqual([OWNER]);
  });

  it('is 401 without the user header', async () => {
    const { app, memories } = makeApp();

    const res = await request(app).get('/memory');

    expect(res.status).toBe(401);
    expect(ErrorBody.parse(res.body).status).toBe(401);
    expect(memories.listCalls).toHaveLength(0);
  });

  it('returns an empty list, not a 404, when the user has no memories', async () => {
    const { app } = makeApp([{ ...BOB_ROW }]);

    const res = await request(app).get('/memory').set(USER_HEADER, OWNER);

    expect(res.status).toBe(200);
    expect(ListMemoryResponse.parse(res.body).memories).toEqual([]);
  });
});

describe('DELETE /memory/:memoryId', () => {
  it('is 204 with an empty body when the caller owns the memory', async () => {
    const { app, memories } = makeApp();

    const res = await request(app).delete(`/memory/${ALICE_ROW.memoryId}`).set(USER_HEADER, OWNER);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(memories.rows.map((r) => r.memoryId)).not.toContain(ALICE_ROW.memoryId);
  });

  it('deletes with BOTH the memoryId and the caller id, so ownership is enforced in the query', async () => {
    const { app, memories } = makeApp();

    await request(app).delete(`/memory/${ALICE_ROW.memoryId}`).set(USER_HEADER, OWNER);

    expect(memories.deleteCalls).toEqual([{ userId: OWNER, memoryId: ALICE_ROW.memoryId }]);
  });

  it('is 404, never 403, for a memory belonging to another user', async () => {
    const { app, memories } = makeApp();

    const res = await request(app).delete(`/memory/${BOB_ROW.memoryId}`).set(USER_HEADER, OWNER);

    expect(res.status).toBe(404);
    expect(ErrorBody.parse(res.body).status).toBe(404);
    // The foreign row survives: a 404 must not be a delete that happened anyway.
    expect(memories.rows.map((r) => r.memoryId)).toContain(BOB_ROW.memoryId);
  });

  it('is 404 for an unknown memory id', async () => {
    const { app } = makeApp();

    const res = await request(app).delete('/memory/mem_does_not_exist').set(USER_HEADER, OWNER);

    expect(res.status).toBe(404);
    expect(ErrorBody.parse(res.body).status).toBe(404);
  });

  it('is 401 without the user header, and touches nothing', async () => {
    const { app, memories } = makeApp();

    const res = await request(app).delete(`/memory/${ALICE_ROW.memoryId}`);

    expect(res.status).toBe(401);
    expect(ErrorBody.parse(res.body).status).toBe(401);
    expect(memories.deleteCalls).toHaveLength(0);
    expect(memories.rows.map((r) => r.memoryId)).toContain(ALICE_ROW.memoryId);
  });
});
