/**
 * RED — http/app.ts: `makeAgentApp(deps)` express app factory (ARCHITECTURE.md §2.2
 * http/routes/*; the composition root index.ts will call this with real repos/ports).
 *
 * INVENTED deps shape (implementer builds repos/wiring to match — flagged in the report):
 *   makeAgentApp({
 *     threads:  { insert(row): Promise<void>, findById(threadId): Promise<ThreadRow | null> }
 *                where ThreadRow = { threadId, userId, title, createdAt }
 *     messages: { listByThread(threadId): Promise<ThreadMessage[]> }
 *     runAsk:   ({ body, threadId, userId, emitter }) => Promise<void>
 *                body = AskBody parsed output (mode/depth defaulted); emitter = AskEmitter
 *                (the route builds it over the Response via sseSink) — route ends the
 *                stream after runAsk resolves
 *     health:   () => Promise<HealthResponse>  (keeps the factory free of env/db)
 *   })
 *
 * Assertions parse every response body with the contract zod schemas.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  CreateThreadResponse,
  DoneEvent,
  ErrorBody,
  GetThreadResponse,
  HealthResponse,
  SourcesEvent,
  USER_HEADER,
  type ThreadMessage
} from '@lumina/contract';
import type { AskEmitter } from '../testing/fakes.js';
import { makeAgentApp } from './app.js';

// ---------------------------------------------------------------- fakes

interface ThreadRow {
  threadId: string;
  userId: string;
  title: string;
  createdAt: string;
}

function fakeThreadsRepo(rows: ThreadRow[] = []) {
  const inserted: ThreadRow[] = [];
  return {
    inserted,
    async insert(row: ThreadRow): Promise<void> {
      inserted.push(row);
      rows.push(row);
    },
    async findById(threadId: string): Promise<ThreadRow | null> {
      return rows.find((r) => r.threadId === threadId) ?? null;
    }
  };
}

function fakeMessagesRepo(byThread: Record<string, ThreadMessage[]> = {}) {
  return {
    async listByThread(threadId: string): Promise<ThreadMessage[]> {
      return byThread[threadId] ?? [];
    }
  };
}

interface RunAskArgs {
  body: { query: string; mode: string; depth: string; spaceId?: string };
  threadId: string;
  userId: string;
  emitter: AskEmitter;
}

/** Scripted runAsk: records the wiring inputs, then drives the emitter it was given. */
function fakeRunAsk(script?: (emitter: AskEmitter) => Promise<void> | void) {
  const calls: RunAskArgs[] = [];
  return {
    calls,
    async run(args: RunAskArgs): Promise<void> {
      calls.push(args);
      await script?.(args.emitter);
    }
  };
}

const healthBody: HealthResponse = {
  status: 'ok',
  model: 'claude-sonnet-5',
  searchProvider: 'tavily',
  vectorStore: 'mongo-cosine-scan',
  db: 'ok'
};

const doneData: DoneEvent = {
  answerId: 'ans_test1',
  latencyMs: 12,
  ttftMs: 5,
  model: 'claude-sonnet-5',
  tokens: { in: 10, out: 4 },
  costUsd: 0.001,
  searchCached: false,
  terminated: 'done',
  depth: 'quick'
};

const sourcesData: SourcesEvent = [
  { n: 1, kind: 'web', title: 'Example', snippet: 'a grounding passage', url: 'https://example.com/' }
];

const OWNED: ThreadRow = {
  threadId: 'thr_abc123',
  userId: 'u_alice',
  title: 'First thread',
  createdAt: '2026-09-12T00:00:00.000Z'
};

function makeApp(overrides: Partial<Parameters<typeof makeAgentApp>[0]> = {}): {
  app: express.Express;
  threads: ReturnType<typeof fakeThreadsRepo>;
  runAsk: ReturnType<typeof fakeRunAsk>;
} {
  const threads = fakeThreadsRepo([{ ...OWNED }]);
  const runAsk = fakeRunAsk((emitter) => {
    emitter.sources(sourcesData);
    emitter.done(doneData);
  });
  const app = makeAgentApp({
    threads,
    messages: fakeMessagesRepo({
      [OWNED.threadId]: [{ role: 'user', content: 'hello from history' }]
    }),
    runAsk: runAsk.run,
    health: async () => healthBody,
    ...overrides
  });
  return { app, threads, runAsk };
}

/** Parse `event:`/`data:` frames out of a raw SSE body, ignoring keepalive comments. */
function sseFrames(text: string): Array<{ event: string; data: unknown }> {
  return [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => ({
    event: m[1]!,
    data: JSON.parse(m[2]!) as unknown
  }));
}

// ---------------------------------------------------------------- threads

describe('POST /threads', () => {
  it('creates a thread for the caller: 201 with a CreateThreadResponse and a thr_-prefixed id', async () => {
    const { app, threads } = makeApp();
    const res = await request(app)
      .post('/threads')
      .set(USER_HEADER, 'u_alice')
      .send({ title: 'My thread' });

    expect(res.status).toBe(201);
    const body = CreateThreadResponse.parse(res.body);
    expect(body.threadId.startsWith('thr_')).toBe(true);
    // Ownership is stored at creation — GET's foreign-id-404 depends on it.
    expect(threads.inserted).toHaveLength(1);
    expect(threads.inserted[0]!.userId).toBe('u_alice');
    expect(threads.inserted[0]!.threadId).toBe(body.threadId);
  });

  it('rejects a missing x-user-id with 401 and an ErrorBody (agent re-validates, defense in depth)', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/threads').send({});
    expect(res.status).toBe(401);
    ErrorBody.parse(res.body);
  });
});

describe('GET /threads/:threadId', () => {
  it('answers 404 with an ErrorBody for an unknown thread id', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/threads/thr_missing').set(USER_HEADER, 'u_alice');
    expect(res.status).toBe(404);
    ErrorBody.parse(res.body);
  });

  it('returns 200 with a GetThreadResponse including the thread messages for the owner', async () => {
    const { app } = makeApp();
    const res = await request(app).get(`/threads/${OWNED.threadId}`).set(USER_HEADER, 'u_alice');
    expect(res.status).toBe(200);
    const body = GetThreadResponse.parse(res.body);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ role: 'user', content: 'hello from history' });
  });

  it("treats another user's thread as unknown: foreign id answers 404, not 403", async () => {
    const { app } = makeApp();
    const res = await request(app).get(`/threads/${OWNED.threadId}`).set(USER_HEADER, 'u_mallory');
    expect(res.status).toBe(404);
    ErrorBody.parse(res.body);
  });
});

// ---------------------------------------------------------------- ask wiring

describe('POST /threads/:threadId/ask', () => {
  it('rejects an invalid body (empty {}) with 400 and never invokes runAsk', async () => {
    const { app, runAsk } = makeApp();
    const res = await request(app)
      .post(`/threads/${OWNED.threadId}/ask`)
      .set(USER_HEADER, 'u_alice')
      .send({});
    expect(res.status).toBe(400);
    ErrorBody.parse(res.body);
    expect(runAsk.calls).toHaveLength(0);
  });

  it('answers 404 for an unknown thread and never invokes runAsk', async () => {
    const { app, runAsk } = makeApp();
    const res = await request(app)
      .post('/threads/thr_missing/ask')
      .set(USER_HEADER, 'u_alice')
      .send({ query: 'what is up' });
    expect(res.status).toBe(404);
    ErrorBody.parse(res.body);
    expect(runAsk.calls).toHaveLength(0);
  });

  it('hands runAsk the validated AskBody with depth defaulted to quick plus the thread/user context', async () => {
    const { app, runAsk } = makeApp();
    await request(app)
      .post(`/threads/${OWNED.threadId}/ask`)
      .set(USER_HEADER, 'u_alice')
      .send({ query: 'what is up' });

    expect(runAsk.calls).toHaveLength(1);
    const call = runAsk.calls[0]!;
    expect(call.body).toMatchObject({ query: 'what is up', depth: 'quick', mode: 'auto' });
    expect(call.threadId).toBe(OWNED.threadId);
    expect(call.userId).toBe('u_alice');
  });

  it('streams SSE: text/event-stream with the sources frame before done, both contract-parseable', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post(`/threads/${OWNED.threadId}/ask`)
      .set(USER_HEADER, 'u_alice')
      .send({ query: 'what is up' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const frames = sseFrames(res.text);
    const names = frames.map((f) => f.event);
    expect(names.indexOf('sources')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('done')).toBeGreaterThan(names.indexOf('sources'));
    SourcesEvent.parse(frames[names.indexOf('sources')]!.data);
    DoneEvent.parse(frames[names.indexOf('done')]!.data);
  });
});

// ---------------------------------------------------------------- health

describe('GET /health', () => {
  it('still answers 200 with a HealthResponse through the app factory (skeleton behavior survives)', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    HealthResponse.parse(res.body);
  });
});
