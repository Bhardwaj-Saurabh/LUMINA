/**
 * makeGatewayApp — the edge, as an env-free factory over injected deps (ARCHITECTURE.md §2.1).
 * Transport and policy only, zero AI: request id → CORS → rate limit → auth (from the contract's
 * ROUTES) → zod validation → proxy. JSON routes map the upstream status verbatim; the ask route
 * pipes bytes and never interprets a frame. A failure before headers is a 502; after headers the
 * stream simply ends — JSON is never injected into an SSE body (guardrail 12).
 */
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import {
  AskBody,
  HealthResponse,
  REQUEST_HEADER,
  ROUTES,
  USER_HEADER,
  MAX_UPLOAD_BYTES,
  type ErrorBody
} from '@lumina/contract';
import type { AgentClient, AgentJsonRequest } from './proxy/client.js';

export interface GatewayAppDeps {
  agent: AgentClient;
  /** Absolute path to the built UI; when set the gateway serves / and /evals from one origin. */
  webDist?: string;
  rateLimit?: express.RequestHandler;
  /** cors `origin` value; permissive by default so the factory stays env-free. */
  corsOrigins?: string[] | boolean;
  /** Extra middleware (the pino request log) injected by the composition root. */
  requestLog?: express.RequestHandler;
}

type Handler = (req: express.Request, res: express.Response) => Promise<void>;

const requestIdOf = (res: express.Response): string => String(res.locals.requestId);

const errorBody = (res: express.Response, status: number, error: string): ErrorBody => ({
  error,
  status,
  requestId: requestIdOf(res)
});

/** Express 4 drops async rejections — forward them to the error middleware (fail loud). */
const wrap =
  (fn: Handler): express.RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const forwardedHeaders = (req: express.Request, res: express.Response): Record<string, string> => {
  const headers: Record<string, string> = { [REQUEST_HEADER]: requestIdOf(res) };
  const userId = req.header(USER_HEADER);
  if (userId) headers[USER_HEADER] = userId;
  return headers;
};

const queryOf = (req: express.Request): Record<string, string> =>
  Object.fromEntries(
    Object.entries(req.query).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : []))
  );

export function makeGatewayApp(deps: GatewayAppDeps): express.Express {
  const { agent } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.use(
    cors({ origin: deps.corsOrigins ?? true, credentials: false, exposedHeaders: [REQUEST_HEADER] })
  );

  // One request id, reused if the caller sent one, minted if not, echoed on every response
  // (including error paths) and forwarded upstream. This makes one request greppable end to end.
  app.use((req, res, next) => {
    const inbound = req.header(REQUEST_HEADER)?.trim();
    const id = inbound && inbound.length > 0 ? inbound : `req_${randomUUID().slice(0, 12)}`;
    res.locals.requestId = id;
    res.setHeader(REQUEST_HEADER, id);
    next();
  });

  if (deps.requestLog) app.use(deps.requestLog);
  if (deps.rateLimit) app.use(deps.rateLimit);

  // JSON everywhere except the multipart upload route, whose proxy owns the raw body.
  app.use((req, res, next) =>
    req.path.endsWith('/documents') && req.method === 'POST'
      ? next()
      : express.json({ limit: '1mb' })(req, res, next)
  );

  const requireUser: express.RequestHandler = (req, res, next) => {
    if (!req.header(USER_HEADER)) {
      res.status(401).json(errorBody(res, 401, `${USER_HEADER} header required`));
      return;
    }
    next();
  };

  const health: Handler = async (_req, res) => {
    try {
      const upstream = await agent.health();
      // An agent that reports its own trouble is relayed as trouble, never relabelled ok.
      const live = upstream.status === 'ok' && upstream.db === 'ok';
      const body: HealthResponse = {
        ...upstream,
        status: live ? 'ok' : 'degraded',
        ai: { ...upstream, status: live ? 'ok' : 'down' }
      };
      res.status(live ? 200 : 503).json(body);
    } catch (err) {
      // Health tells the truth about a dead dependency. It never pretends.
      const body: HealthResponse = {
        status: 'degraded',
        model: 'unset',
        searchProvider: 'unknown',
        vectorStore: 'unknown',
        db: 'down',
        ai: { status: 'down', error: (err as Error).message }
      };
      res.status(503).json(body);
    }
  };

  const jsonProxy =
    (method: AgentJsonRequest['method']): Handler =>
    async (req, res) => {
      const query = queryOf(req);
      const upstream = await agent.json({
        method,
        path: req.path,
        headers: forwardedHeaders(req, res),
        ...(method === 'GET' ? {} : { body: req.body }),
        ...(Object.keys(query).length > 0 ? { query } : {})
      });
      res.status(upstream.status).json(upstream.body);
    };

  const ask: Handler = async (req, res) => {
    const parsed = AskBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(errorBody(res, 400, parsed.error.message));
      return;
    }

    // Client-disconnect detection belongs on the RESPONSE. `req.on('close')` fires when the
    // request body finishes being read (Node >= 16), which for a POST is immediately — it
    // aborted every real upstream before the first byte. `res.on('close')` fires only when
    // the connection goes away, and `writableEnded` distinguishes that from a clean finish.
    const aborter = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) aborter.abort();
    });

    const upstream = await agent.ask({
      threadId: String(req.params.threadId),
      body: parsed.data,
      headers: forwardedHeaders(req, res),
      signal: aborter.signal
    });

    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers['content-type'] ?? 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Byte-level pass-through with backpressure: no parsing, no re-serialising, no buffering.
    for await (const chunk of upstream.stream) {
      if (!res.write(chunk)) await once(res, 'drain');
    }
    res.end();
  };

  /**
   * Multipart upload: the request stream is piped upstream, never buffered — a 25 MB PDF
   * must not land in edge memory. The declared cap is enforced here from Content-Length so
   * an over-sized upload costs the agent nothing; the agent re-checks the real byte count.
   */
  const upload: Handler = async (req, res) => {
    const declared = Number(req.header('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      res.status(413).json(errorBody(res, 413, `file too large: limit ${MAX_UPLOAD_BYTES} bytes`));
      return;
    }
    const aborter = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) aborter.abort();
    });
    const contentType = req.header('content-type');
    const upstream = await agent.upload({
      spaceId: String(req.params.spaceId),
      body: req,
      // The multipart boundary lives in content-type: drop it and the agent cannot parse the form.
      headers: {
        ...forwardedHeaders(req, res),
        ...(contentType ? { 'content-type': contentType } : {})
      },
      signal: aborter.signal
    });
    res.status(upstream.status).json(upstream.body);
  };

  const handlers: Record<string, Handler> = {
    'GET /health': health,
    'POST /threads/:threadId/ask': ask,
    'POST /spaces/:spaceId/documents': upload
  };

  for (const route of ROUTES) {
    const key = `${route.method} ${route.path}`;
    const method = route.method.toLowerCase() as 'get' | 'post' | 'delete';
    const handler = handlers[key] ?? jsonProxy(route.method);
    const chain = route.auth ? [requireUser, wrap(handler)] : [wrap(handler)];
    app[method](route.path, ...chain);
  }

  // In production the gateway serves the built UI, so / and /evals come from one origin.
  // /evals/report.json is already proxied above; everything else falls back to the SPA shell
  // so a hard refresh on /evals works (the skeleton's fallback regex excluded it — a bug).
  if (deps.webDist) {
    const webDist = deps.webDist;
    app.use(express.static(webDist));
    app.get(/^(?!\/(health|stats|threads|memory|spaces)(\/|$)).*/, (_req, res) => {
      res.sendFile(join(webDist, 'index.html'));
    });
  }

  app.use((req, res) =>
    res.status(404).json(errorBody(res, 404, `no route ${req.method} ${req.path}`))
  );

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Fail loud (A1): a thrown error is a 502 with the request id, never a 2xx with a plausible
    // body. Once bytes are on the wire the only honest move is to end the stream (guardrail 12).
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(502).json(errorBody(res, 502, err.message));
  });

  return app;
}
