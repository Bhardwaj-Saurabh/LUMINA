/**
 * RED — M10 `GET /evals/report.json` on the agent (contract ROUTES: `auth: false`).
 *
 * The graded `/evals` page and `bench.mjs` probe this route with NO user identity — the
 * bench sends an empty `x-user-id` and asserts the answer is not 401. So the route sits
 * outside the identity gate, and the three states it can be in are each a distinct HTTP
 * status: published (200 + ETag, 304 on revalidation), unpublished (404 — never a fake
 * empty report), not wired (501 — "not implemented", not "no such route").
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ErrorBody, USER_HEADER, type HealthResponse } from '@lumina/contract';
import { makeAgentApp, type AgentAppDeps } from './app.js';

const healthBody: HealthResponse = {
  status: 'ok',
  model: 'gpt-5.4-mini',
  searchProvider: 'tavily',
  vectorStore: 'atlas-vector-search',
  db: 'ok',
  ai: { status: 'ok' }
};

const REPORT = {
  generatedAt: '2026-09-14T09:00:00.000Z',
  gates: [
    { id: 'G1', name: 'contract', pass: true },
    { id: 'G2', name: 'smoke', pass: true }
  ],
  summary: { passed: 2, failed: 0 }
};
const ETAG = 'a1b2c3d4e5f6';
const PUBLISHED_AT = '2026-09-14T09:05:00.000Z';

function appWith(over: Partial<AgentAppDeps> = {}): ReturnType<typeof makeAgentApp> {
  return makeAgentApp({
    threads: {
      insert: async () => {},
      findById: async () => null
    },
    messages: { listByThread: async () => [] },
    runAsk: async () => {},
    health: async () => healthBody,
    ...over
  });
}

const publishedApp = () =>
  appWith({
    evalsReport: {
      get: async () => ({ json: REPORT, etag: ETAG, publishedAt: PUBLISHED_AT })
    }
  });

describe('GET /evals/report.json', () => {
  it('serves the published report as JSON with its ETag and no-cache, without any user header', async () => {
    const res = await request(publishedApp()).get('/evals/report.json');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual(REPORT);
    // Quoted or unquoted, the entity tag the publisher minted must be what clients see.
    expect(res.headers.etag).toContain(ETAG);
    expect(res.headers['cache-control']).toMatch(/no-cache/);
  });

  it('is still 200 when the caller sends an EMPTY x-user-id (the bench probe shape)', async () => {
    const res = await request(publishedApp()).get('/evals/report.json').set(USER_HEADER, '');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(REPORT);
  });

  it('answers 304 with an empty body when If-None-Match carries the current ETag', async () => {
    const app = publishedApp();
    const first = await request(app).get('/evals/report.json');
    const etagHeader = String(first.headers.etag ?? '');
    expect(etagHeader).toContain(ETAG);

    const res = await request(app).get('/evals/report.json').set('If-None-Match', etagHeader);

    expect(res.status).toBe(304);
    expect(res.text ?? '').toBe('');
  });

  it('is 404 with an ErrorBody saying the report is not published when get() resolves null', async () => {
    const app = appWith({ evalsReport: { get: async () => null } });

    const res = await request(app).get('/evals/report.json');

    expect(res.status).toBe(404);
    const body = ErrorBody.parse(res.body);
    expect(body.status).toBe(404);
    // Unpublished is a clear state; a fake empty report would grade as a real (empty) run.
    expect(body.error).toMatch(/published/i);
  });

  it('stays 501 while no report source is wired, rather than vanishing as a 404 route', async () => {
    const res = await request(appWith({})).get('/evals/report.json');
    expect(res.status).toBe(501);
  });

  it('is never 401 — the route is auth: false in the contract', async () => {
    const statuses = await Promise.all([
      request(publishedApp()).get('/evals/report.json'),
      request(publishedApp()).get('/evals/report.json').set(USER_HEADER, ''),
      request(appWith({ evalsReport: { get: async () => null } })).get('/evals/report.json'),
      request(appWith({})).get('/evals/report.json')
    ]);
    for (const res of statuses) expect(res.status).not.toBe(401);
  });
});
