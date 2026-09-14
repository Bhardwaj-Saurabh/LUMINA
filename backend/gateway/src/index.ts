/**
 * LUMINA gateway — the software backend and the only service the browser talks to.
 * Composition root only (ARCHITECTURE.md §2.1): env → agent client → rate limit → app → listen.
 * All edge behaviour lives in `app.ts` and `middleware/`, which are env-free and unit tested.
 * No provider key is ever read here.
 */
import { pinoHttp } from 'pino-http';
import pino from 'pino';
import { existsSync } from 'node:fs';
import { REQUEST_HEADER, USER_HEADER } from '@lumina/contract';
import { makeGatewayApp } from './app.js';
import { makeRateLimit } from './middleware/rateLimit.js';
import { makeMetadataIdToken } from './proxy/idToken.js';
import { makeAgentClient } from './proxy/client.js';
import { env } from './env.js';

/** Guardrail 9 (ARCHITECTURE.md §5): steady rate from env, short burst for a page's first paint. */
const RATE_LIMIT_BURST = 60;
/** An answer and an ingest do real work; a status poll or a thread read does not. */
const EXPENSIVE_COST = 5;
const isExpensive = (req: { method: string; path: string }): boolean =>
  req.method === 'POST' && (req.path.endsWith('/ask') || req.path.endsWith('/documents'));

const log = pino({ level: env.logLevel });

const app = makeGatewayApp({
  agent: makeAgentClient({
    baseUrl: env.agentUrl,
    // Cloud Run: the agent is --no-allow-unauthenticated and only this service account may
    // invoke it. The token seam is the one place the deployment's trust boundary shows.
    ...(env.agentAudience ? { idToken: makeMetadataIdToken({ audience: env.agentAudience }) } : {})
  }),
  rateLimit: makeRateLimit({
    perMinute: env.rateLimitPerMinute,
    burst: RATE_LIMIT_BURST,
    now: Date.now,
    cost: (req) => (isExpensive(req) ? EXPENSIVE_COST : 1)
  }),
  corsOrigins: env.corsOrigins,
  ...(existsSync(env.webDist) ? { webDist: env.webDist } : {}),
  requestLog: pinoHttp({
    logger: log,
    genReqId: (_req, res) => String(res.locals.requestId),
    customProps: (req, res) => ({
      requestId: res.locals.requestId,
      userId: req.header(USER_HEADER) ?? null
    }),
    // The ask route is a stream; one line when it closes is the useful line.
    autoLogging: true
  })
});

app.listen(env.port, () => {
  log.info(
    {
      port: env.port,
      agentUrl: env.agentUrl,
      cors: env.corsOrigins,
      rateLimitPerMinute: env.rateLimitPerMinute,
      webDist: existsSync(env.webDist) ? env.webDist : null,
      requestHeader: REQUEST_HEADER
    },
    'gateway up — edge live: 401/400/429, JSON proxy and SSE pass-through to the agent'
  );
});
