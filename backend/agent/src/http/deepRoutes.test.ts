/**
 * RED — M8 spend gate and `/stats` (SPEC 5.5 / bench caps `deepCap429`, `statsReconciles`).
 *
 * The daily cap has to be an HTTP status, not an SSE frame: by the time the stream is open
 * the request has already been accepted, and a client that asked for a deep search would
 * have to parse an error frame to discover it never got one. So admission happens in the
 * route, before the sink exists — and after ownership, so probing someone else's thread
 * cannot burn your own allowance.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ErrorBody, StatsResponse, USER_HEADER, type HealthResponse } from '@lumina/contract';
import { makeAgentApp, type AgentAppDeps, type RunAskInput, type ThreadRow } from './app.js';

const healthBody: HealthResponse = {
  status: 'ok',
  model: 'gpt-5.4-mini',
  searchProvider: 'tavily',
  vectorStore: 'atlas-vector-search',
  db: 'ok',
  ai: { status: 'ok' }
};

const OWNER = 'u_alice';
const THREAD: ThreadRow = {
  threadId: 'thr_alice1',
  userId: OWNER,
  title: 'deep',
  createdAt: '2026-09-13T00:00:00.000Z'
};

const STATS: StatsResponse = {
  requests: 42,
  answers: 40,
  searchCacheHitRatePct: 62.5,
  ttftP95Ms: 2100,
  costUsdToday: 0.048,
  deepToday: 2,
  deepDailyCap: 5
};

interface Spy {
  asked: RunAskInput[];
  admitted: string[];
  statsFor: string[];
}

function appWith(
  over: Partial<AgentAppDeps> = {}
): { app: ReturnType<typeof makeAgentApp>; spy: Spy } {
  const spy: Spy = { asked: [], admitted: [], statsFor: [] };
  const app = makeAgentApp({
    threads: {
      insert: async () => {},
      findById: async (id) => (id === THREAD.threadId ? THREAD : null)
    },
    messages: { listByThread: async () => [] },
    runAsk: async (input) => {
      spy.asked.push(input);
    },
    health: async () => healthBody,
    ...over
  });
  return { app, spy };
}

const askDeep = (app: ReturnType<typeof makeAgentApp>, userId = OWNER) =>
  request(app)
    .post(`/threads/${THREAD.threadId}/ask`)
    .set(USER_HEADER, userId)
    .send({ query: 'should we move off Atlas Vector Search?', depth: 'deep' });

describe('deep daily cap', () => {
  it('answers 429 with a contract-valid body carrying resetsAt when the cap is spent', async () => {
    const resetsAt = '2026-09-14T00:00:00.000Z';
    const { app, spy } = appWith({
      admitDeep: async (userId) => {
        spy.admitted.push(userId);
        return { ok: false, used: 5, remaining: 0, resetsAt };
      }
    });

    const res = await askDeep(app);

    expect(res.status).toBe(429);
    const body = ErrorBody.parse(res.body);
    expect(body.status).toBe(429);
    // Without resetsAt a client is told to stop and given no way to know when to resume.
    expect(body.resetsAt).toBe(resetsAt);
    expect(body.error).toMatch(/deep/i);
    // Refused before any spend: the loop never ran.
    expect(spy.asked).toHaveLength(0);
    expect(spy.admitted).toEqual([OWNER]);
  });

  it('runs the ask when the cap admits it', async () => {
    const { app, spy } = appWith({
      admitDeep: async () => ({ ok: true, used: 1, remaining: 4 })
    });

    const res = await askDeep(app);

    expect(res.status).toBe(200);
    expect(spy.asked).toHaveLength(1);
    expect(spy.asked[0]?.body.depth).toBe('deep');
  });

  it('never consults the cap for a quick search — quick is not rationed', async () => {
    const { app, spy } = appWith({
      admitDeep: async (userId) => {
        spy.admitted.push(userId);
        return { ok: true, used: 1, remaining: 4 };
      }
    });

    await request(app)
      .post(`/threads/${THREAD.threadId}/ask`)
      .set(USER_HEADER, OWNER)
      .send({ query: 'anything', depth: 'quick' });

    expect(spy.admitted).toEqual([]);
    expect(spy.asked).toHaveLength(1);
  });

  it('checks thread ownership BEFORE the cap, so probing a foreign thread cannot burn allowance', async () => {
    const { app, spy } = appWith({
      admitDeep: async (userId) => {
        spy.admitted.push(userId);
        return { ok: true, used: 1, remaining: 4 };
      }
    });

    const res = await askDeep(app, 'u_mallory');

    expect(res.status).toBe(404);
    expect(spy.admitted).toEqual([]);
    expect(spy.asked).toHaveLength(0);
  });

  it('runs deep unrationed when no cap is wired, rather than refusing everything', async () => {
    const { app, spy } = appWith({});
    const res = await askDeep(app);
    expect(res.status).toBe(200);
    expect(spy.asked).toHaveLength(1);
  });
});

describe('GET /stats', () => {
  it('returns a contract-valid StatsResponse for the calling user', async () => {
    const { app, spy } = appWith({
      stats: async (userId) => {
        spy.statsFor.push(userId);
        return STATS;
      }
    });

    const res = await request(app).get('/stats').set(USER_HEADER, OWNER);

    expect(res.status).toBe(200);
    expect(StatsResponse.parse(res.body)).toEqual(STATS);
    // deepToday/deepDailyCap are per user: the cap probe reads the limit from here.
    expect(spy.statsFor).toEqual([OWNER]);
  });

  it('is 401 without a user header', async () => {
    const { app } = appWith({ stats: async () => STATS });
    expect((await request(app).get('/stats')).status).toBe(401);
  });

  it('stays 501 while stats are not wired, rather than reporting zeroes that look real', async () => {
    const { app } = appWith({});
    const res = await request(app).get('/stats').set(USER_HEADER, OWNER);
    expect(res.status).toBe(501);
  });
});
