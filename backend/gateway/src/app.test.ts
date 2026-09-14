import type express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  ErrorBody,
  HealthResponse,
  ListThreadsResponse,
  REQUEST_HEADER,
  MAX_UPLOAD_BYTES,
  ROUTES,
  UploadDocumentResponse,
  USER_HEADER
} from '@lumina/contract';
import { makeGatewayApp } from './app.js';
import { fakeAgent, framesToStream, okHealth } from './testing/fakeAgent.js';

/**
 * The gateway edge contract: request id, 401, 400, verbatim JSON proxying, 502 on upstream
 * failure, byte-level SSE pass-through and truthful health (ARCHITECTURE.md §2.1, §5 rows
 * 1/9/12). Every dependency is injected, so these tests touch no network and no env.
 */

const passThroughRateLimit: express.RequestHandler = (_req, _res, next) => next();

type Deps = Parameters<typeof makeGatewayApp>[0];

const buildApp = (agent: ReturnType<typeof fakeAgent>, extra: Partial<Deps> = {}) =>
  makeGatewayApp({ agent: agent.client, rateLimit: passThroughRateLimit, ...extra } as Deps);

/** Concrete ids for the route table's params, so a looped request is still a plausible URL. */
const PARAMS: Record<string, string> = {
  threadId: 'thr_test1',
  spaceId: 'spc_test1',
  memoryId: 'mem_test1'
};
const concretePath = (path: string) => path.replace(/:(\w+)/g, (_m, name: string) => PARAMS[name] ?? 'x');

// ---------------------------------------------------------------- request id

describe('gateway request id', () => {
  it('echoes an inbound x-request-id back unchanged', async () => {
    const agent = fakeAgent();
    const res = await request(buildApp(agent)).get('/health').set(REQUEST_HEADER, 'req_caller123');

    expect(res.headers[REQUEST_HEADER]).toBe('req_caller123');
  });

  it('mints a non-empty x-request-id when the caller sent none', async () => {
    const agent = fakeAgent();
    const res = await request(buildApp(agent)).get('/health');

    expect(res.headers[REQUEST_HEADER]).toBeDefined();
    expect(String(res.headers[REQUEST_HEADER]).length).toBeGreaterThan(0);
  });

  it('carries x-request-id on an error response too, so a failed request stays greppable', async () => {
    const agent = fakeAgent();
    const res = await request(buildApp(agent)).get('/threads').set(REQUEST_HEADER, 'req_err1');

    expect(res.status).toBe(401);
    expect(res.headers[REQUEST_HEADER]).toBe('req_err1');
  });
});

// ---------------------------------------------------------------- auth

describe('gateway auth', () => {
  const authed = ROUTES.filter((r) => r.auth);
  const anonymous = ROUTES.filter((r) => !r.auth);

  it.each(authed.map((r) => [`${r.method} ${r.path}`, r] as const))(
    '%s returns 401 with a contract ErrorBody when x-user-id is missing',
    async (_label, route) => {
      const agent = fakeAgent();
      const method = route.method.toLowerCase() as 'get' | 'post' | 'delete';
      const res = await request(buildApp(agent))[method](concretePath(route.path));

      expect(res.status).toBe(401);
      const body = ErrorBody.parse(res.body);
      expect(body.status).toBe(401);
      expect(body.error).toMatch(/x-user-id/i);
      expect(agent.calls.json).toHaveLength(0);
      expect(agent.calls.ask).toHaveLength(0);
    }
  );

  it.each(anonymous.map((r) => [`${r.method} ${r.path}`, r] as const))(
    '%s does not require x-user-id',
    async (_label, route) => {
      const agent = fakeAgent();
      const method = route.method.toLowerCase() as 'get' | 'post' | 'delete';
      const res = await request(buildApp(agent))[method](concretePath(route.path));

      expect(res.status).not.toBe(401);
    }
  );
});

// ---------------------------------------------------------------- validation

describe('gateway body validation', () => {
  it('rejects POST /threads/:id/ask with an empty body as 400 carrying the zod message', async () => {
    const agent = fakeAgent();
    const res = await request(buildApp(agent))
      .post('/threads/thr_test1/ask')
      .set(USER_HEADER, 'u_alice')
      .send({});

    expect(res.status).toBe(400);
    const body = ErrorBody.parse(res.body);
    expect(body.status).toBe(400);
    expect(body.error).toMatch(/query/i);
  });

  it('never calls the agent when the ask body fails validation', async () => {
    const agent = fakeAgent();
    await request(buildApp(agent)).post('/threads/thr_test1/ask').set(USER_HEADER, 'u_alice').send({});

    expect(agent.calls.ask).toHaveLength(0);
    expect(agent.calls.json).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- JSON proxying

describe('gateway JSON proxying', () => {
  it('returns the agent status and body verbatim for GET /threads', async () => {
    const upstream = {
      threads: [{ threadId: 'thr_one', title: 'First', createdAt: '2026-09-13T10:00:00.000Z' }]
    };
    const agent = fakeAgent({ json: () => ({ status: 200, body: upstream }) });

    const res = await request(buildApp(agent)).get('/threads').set(USER_HEADER, 'u_alice');

    expect(res.status).toBe(200);
    expect(ListThreadsResponse.parse(res.body)).toEqual(upstream);
  });

  it('maps an upstream 404 verbatim instead of normalising it', async () => {
    const agent = fakeAgent({
      json: () => ({ status: 404, body: { error: 'no thread thr_test1', status: 404 } })
    });

    const res = await request(buildApp(agent)).get('/threads/thr_test1').set(USER_HEADER, 'u_alice');

    expect(res.status).toBe(404);
    expect(ErrorBody.parse(res.body).error).toBe('no thread thr_test1');
  });

  it('forwards x-user-id and x-request-id upstream', async () => {
    const agent = fakeAgent({ json: () => ({ status: 200, body: { threads: [] } }) });

    await request(buildApp(agent))
      .get('/threads')
      .set(USER_HEADER, 'u_alice')
      .set(REQUEST_HEADER, 'req_fwd1');

    expect(agent.calls.json).toHaveLength(1);
    const forwarded = agent.calls.json[0]!.headers;
    expect(forwarded[USER_HEADER]).toBe('u_alice');
    expect(forwarded[REQUEST_HEADER]).toBe('req_fwd1');
  });

  it('answers 502 with the requestId when the agent call fails before headers, never a 2xx', async () => {
    const agent = fakeAgent({
      json: () => {
        throw new Error('ECONNREFUSED 127.0.0.1:8000');
      }
    });

    const res = await request(buildApp(agent))
      .get('/threads')
      .set(USER_HEADER, 'u_alice')
      .set(REQUEST_HEADER, 'req_boom1');

    expect(res.status).toBe(502);
    const body = ErrorBody.parse(res.body);
    expect(body.status).toBe(502);
    expect(body.requestId).toBe('req_boom1');
  });
});

// ---------------------------------------------------------------- SSE pass-through

/** Deliberately awkward: double spaces, NBSP, em dash, tab escape, emoji, and a comment line. */
const SOURCES_FRAME = 'event: sources\ndata: {"sources":[{"n":1,"title":"A   B","url":"https://x.test/a"}]}\n\n';
const TOKEN_FRAME = 'event: token\ndata: {"text":"   café — ok\\t✅  "}\n\n';
const COMMENT_FRAME = ': keep-alive\n\n';
const DONE_FRAME = 'event: done\ndata: {"terminated":"done","answerId":"ans_1"}\n\n';

const askApp = () =>
  fakeAgent({
    ask: () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      stream: framesToStream([SOURCES_FRAME, TOKEN_FRAME, COMMENT_FRAME, DONE_FRAME])
    })
  });

describe('gateway SSE pass-through', () => {
  it('answers text/event-stream for a valid ask', async () => {
    const agent = askApp();
    const res = await request(buildApp(agent))
      .post('/threads/thr_test1/ask')
      .set(USER_HEADER, 'u_alice')
      .send({ query: 'who runs lumina?' })
      .buffer(true);

    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/event-stream');
  });

  it('streams the agent frames in order: sources before token before done', async () => {
    const agent = askApp();
    const res = await request(buildApp(agent))
      .post('/threads/thr_test1/ask')
      .set(USER_HEADER, 'u_alice')
      .send({ query: 'who runs lumina?' })
      .buffer(true);

    const text = String(res.text ?? '');
    const sourcesAt = text.indexOf('event: sources');
    const tokenAt = text.indexOf('event: token');
    const doneAt = text.indexOf('event: done');
    expect(sourcesAt).toBeGreaterThanOrEqual(0);
    expect(sourcesAt).toBeLessThan(tokenAt);
    expect(tokenAt).toBeLessThan(doneAt);
  });

  it('does not parse or re-serialize frames: an awkward payload survives byte-identical', async () => {
    const agent = askApp();
    const res = await request(buildApp(agent))
      .post('/threads/thr_test1/ask')
      .set(USER_HEADER, 'u_alice')
      .send({ query: 'who runs lumina?' })
      .buffer(true);

    const text = String(res.text ?? '');
    expect(text).toContain(TOKEN_FRAME);
    expect(text).toContain(COMMENT_FRAME);
    expect(text).toBe(SOURCES_FRAME + TOKEN_FRAME + COMMENT_FRAME + DONE_FRAME);
  });

  it('forwards the thread id, validated body and identity headers to the agent ask call', async () => {
    const agent = askApp();
    await request(buildApp(agent))
      .post('/threads/thr_test1/ask')
      .set(USER_HEADER, 'u_alice')
      .set(REQUEST_HEADER, 'req_ask1')
      .send({ query: 'who runs lumina?', depth: 'deep' })
      .buffer(true);

    expect(agent.calls.ask).toHaveLength(1);
    const call = agent.calls.ask[0]!;
    expect(call.threadId).toBe('thr_test1');
    expect(call.headers[USER_HEADER]).toBe('u_alice');
    expect(call.headers[REQUEST_HEADER]).toBe('req_ask1');
    expect(call.body).toMatchObject({ query: 'who runs lumina?', depth: 'deep' });
  });

  it('answers 502 JSON when the agent ask fails before any frame is written', async () => {
    const agent = fakeAgent({
      ask: () => {
        throw new Error('agent unreachable');
      }
    });

    const res = await request(buildApp(agent))
      .post('/threads/thr_test1/ask')
      .set(USER_HEADER, 'u_alice')
      .send({ query: 'who runs lumina?' })
      .buffer(true);

    expect(res.status).toBe(502);
    expect(String(res.headers['content-type'])).toContain('application/json');
  });
});

// ---------------------------------------------------------------- health

describe('gateway health', () => {
  it('nests the agent health and returns 200 when the agent is ok', async () => {
    const agent = fakeAgent({ health: () => okHealth });

    const res = await request(buildApp(agent)).get('/health');

    expect(res.status).toBe(200);
    const body = HealthResponse.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.ai?.status).toBe('ok');
    expect(body.model).toBe('claude-sonnet-5');
    expect(agent.calls.health).toBe(1);
  });

  it('tells the truth when the agent health call throws: 503 with ai.status down', async () => {
    const agent = fakeAgent({
      health: () => {
        throw new Error('agent down');
      }
    });

    const res = await request(buildApp(agent)).get('/health');

    expect(res.status).toBe(503);
    const body = HealthResponse.parse(res.body);
    expect(body.status).toBe('degraded');
    expect(body.ai?.status).toBe('down');
  });
});

// ---------------------------------------------------------------- slow upstream
/**
 * REGRESSION (found live 2026-09-13): the ask returned 502 "This operation was aborted"
 * in 0 ms against the real agent. The gateway aborted the upstream from req.on('close'),
 * which in Node >= 16 fires when the REQUEST BODY finishes being read — not when the
 * client disconnects. A synchronous fake stream hid it; a real ~9 s upstream never won
 * the race. Client-disconnect detection belongs on the response, not the request.
 */
describe('gateway SSE pass-through with a slow upstream', () => {
  it('streams every frame when the first byte arrives after the request body is consumed', async () => {
    const FRAMES = ['event: sources\ndata: []\n\n', 'event: token\ndata: {"text":"hi"}\n\n', 'event: done\ndata: {"terminated":"done"}\n\n'];
    // The real client hands the signal to fetch, so an abort kills the upstream. The fake
    // must do the same or it cannot reproduce an over-eager abort.
    const slowStream = (signal?: AbortSignal): AsyncIterable<Uint8Array | string> => ({
      async *[Symbol.asyncIterator]() {
        await new Promise((r) => setTimeout(r, 25)); // a real upstream is not synchronous
        if (signal?.aborted) throw new Error('This operation was aborted');
        for (const frame of FRAMES) yield frame;
      }
    });
    const agent = fakeAgent({
      ask: async (req) => ({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        stream: slowStream(req.signal)
      })
    });

    const res = await request(buildApp(agent))
      .post('/threads/thr_test1/ask')
      .set(USER_HEADER, 'dev')
      .send({ query: 'what is lumina?' })
      .buffer(true);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toBe(FRAMES.join(''));
  });
});

// ---------------------------------------------------------------- document upload
/**
 * The upload proxy (ARCHITECTURE §2.1 `proxy/uploadProxy.ts`). The gateway must forward the
 * multipart body as a STREAM — buffering a 25 MB PDF on the edge is exactly what the
 * contract's size cap exists to prevent — and must answer 413 from the declared limit
 * without troubling the agent.
 */
describe('gateway document upload', () => {
  it('forwards a multipart upload and returns the agent 202 verbatim', async () => {
    const agent = fakeAgent({
      upload: async () => ({ status: 202, body: { docId: 'doc_abc1', status: 'pending' } })
    });

    const res = await request(buildApp(agent))
      .post('/spaces/spc_test1/documents')
      .set(USER_HEADER, 'dev')
      .attach('file', Buffer.from('%PDF-1.4 fake pdf bytes'), 'paper.pdf');

    expect(res.status).toBe(202);
    expect(UploadDocumentResponse.parse(res.body).docId).toBe('doc_abc1');
    expect(agent.calls.upload).toHaveLength(1);
    expect(agent.calls.upload[0]!.spaceId).toBe('spc_test1');
    // The multipart boundary must survive, or the agent cannot parse the form.
    expect(agent.calls.upload[0]!.headers['content-type']).toContain('multipart/form-data');
    expect(agent.calls.upload[0]!.headers[USER_HEADER]).toBe('dev');
  });

  it('rejects an over-sized upload with 413 without calling the agent', async () => {
    const agent = fakeAgent();
    const res = await request(buildApp(agent))
      .post('/spaces/spc_test1/documents')
      .set(USER_HEADER, 'dev')
      .set('content-length', String(MAX_UPLOAD_BYTES + 1))
      .set('content-type', 'multipart/form-data; boundary=xyz')
      .send('ignored');

    expect(res.status).toBe(413);
    expect(ErrorBody.parse(res.body).status).toBe(413);
    expect(agent.calls.upload).toHaveLength(0);
  });
});

// ------------------------------------------------- upstream response headers

/**
 * The JSON proxy used to answer with `res.status(...).json(body)`, which throws away every
 * header the agent set. That made the agent's `/evals/report.json` caching contract — a strong
 * ETag over the published artifact, `X-Published-At`, and the 304 revalidation the agent tests
 * pin — dead on arrival in the deployed stack: the browser saw Express's own weak ETag and no
 * provenance at all. Found on the deployed gateway, 2026-09-14.
 */
describe('gateway JSON proxy — caching and provenance headers survive the hop', () => {
  const reportHeaders = {
    etag: '"fa5bad40570f55fff0297da57dff01c4"',
    'cache-control': 'no-cache',
    'x-published-at': '2026-09-14T11:05:00.000Z'
  };

  it('passes the agent ETag, Cache-Control and X-Published-At through to the caller', async () => {
    const agent = fakeAgent({
      json: () => ({ status: 200, body: { assignment: 'lumina' }, headers: reportHeaders })
    });

    const res = await request(buildApp(agent)).get('/evals/report.json');

    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe(reportHeaders.etag);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['x-published-at']).toBe(reportHeaders['x-published-at']);
  });

  it('forwards If-None-Match upstream so the agent can answer 304 itself', async () => {
    const agent = fakeAgent({ json: () => ({ status: 200, body: {}, headers: reportHeaders }) });

    await request(buildApp(agent))
      .get('/evals/report.json')
      .set('If-None-Match', reportHeaders.etag);

    expect(agent.calls.json[0]!.headers['if-none-match']).toBe(reportHeaders.etag);
  });

  it('relays a 304 as a 304 with no body', async () => {
    const agent = fakeAgent({
      json: () => ({ status: 304, body: undefined, headers: { etag: reportHeaders.etag } })
    });

    const res = await request(buildApp(agent))
      .get('/evals/report.json')
      .set('If-None-Match', reportHeaders.etag);

    expect(res.status).toBe(304);
    expect(res.text).toBeFalsy();
  });

  it('does not leak hop-by-hop or length headers that would corrupt the re-serialized body', async () => {
    // The gateway re-encodes the JSON, so the agent's content-length is a lie here.
    const agent = fakeAgent({
      json: () => ({
        status: 200,
        body: { ok: true },
        headers: { 'content-length': '999999', connection: 'close', etag: '"keep-me"' }
      })
    });

    const res = await request(buildApp(agent)).get('/evals/report.json');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers.etag).toBe('"keep-me"');
    expect(res.headers['content-length']).not.toBe('999999');
  });
});
