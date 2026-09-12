/**
 * makeAgentApp — express app factory over injected repos/ports (ARCHITECTURE.md §2.2
 * http/routes/*). The composition root (index.ts) supplies real Mongo repos, the ask
 * strategy and the env-backed health fn; tests supply fakes. Contract ROUTES drive both
 * the x-user-id gate and the 501 placeholders for routes not built yet.
 */
import express from 'express';
import {
  AskBody,
  CreateThreadBody,
  newId,
  ROUTES,
  USER_HEADER,
  type ErrorBody,
  type HealthResponse,
  type CreateThreadResponse,
  type GetThreadResponse,
  type ThreadMessage
} from '@lumina/contract';
import type { z } from 'zod';
import type { AskEmitter } from '../core/loop.js';
import { createSseSink } from './sseSink.js';

export interface ThreadRow {
  threadId: string;
  userId: string;
  title: string;
  createdAt: string;
}

export interface ThreadsRepo {
  insert(row: ThreadRow): Promise<void>;
  findById(threadId: string): Promise<ThreadRow | null>;
}

export interface MessagesRepo {
  listByThread(threadId: string): Promise<ThreadMessage[]>;
}

export interface RunAskInput {
  body: z.output<typeof AskBody>;
  threadId: string;
  userId: string;
  emitter: AskEmitter;
}

export interface AgentAppDeps {
  threads: ThreadsRepo;
  messages: MessagesRepo;
  runAsk(input: RunAskInput): Promise<void>;
  health(): Promise<HealthResponse>;
}

type Handler = (req: express.Request, res: express.Response) => Promise<void>;

const errorBody = (status: number, error: string): ErrorBody => ({ error, status });

/** Express 4 drops async rejections — forward them to the error middleware (fail loud). */
const wrap =
  (fn: Handler): express.RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const requireUser: express.RequestHandler = (req, res, next) => {
  const userId = req.header(USER_HEADER);
  if (!userId) {
    res.status(401).json(errorBody(401, `${USER_HEADER} header required`));
    return;
  }
  res.locals.userId = userId;
  next();
};

export function makeAgentApp(deps: AgentAppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) =>
    req.path.endsWith('/documents') && req.method === 'POST'
      ? next()
      : express.json({ limit: '1mb' })(req, res, next)
  );

  const userOf = (res: express.Response): string => res.locals.userId as string;

  /** Ownership check treats a foreign thread as unknown: 404, never 403. */
  const ownedThread = async (threadId: string, userId: string): Promise<ThreadRow | null> => {
    const thread = await deps.threads.findById(threadId);
    return thread !== null && thread.userId === userId ? thread : null;
  };

  const handlers: Record<string, Handler> = {
    'GET /health': async (_req, res) => {
      const body = await deps.health();
      res.status(body.db === 'ok' ? 200 : 503).json(body);
    },

    'POST /threads': async (req, res) => {
      const parsed = CreateThreadBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json(errorBody(400, parsed.error.message));
        return;
      }
      const row: ThreadRow = {
        threadId: newId('thr'),
        userId: userOf(res),
        title: parsed.data.title ?? 'New thread',
        createdAt: new Date().toISOString()
      };
      await deps.threads.insert(row);
      const body: CreateThreadResponse = { threadId: row.threadId };
      res.status(201).json(body);
    },

    'GET /threads/:threadId': async (req, res) => {
      const thread = await ownedThread(req.params.threadId!, userOf(res));
      if (!thread) {
        res.status(404).json(errorBody(404, `no thread ${req.params.threadId}`));
        return;
      }
      const body: GetThreadResponse = {
        threadId: thread.threadId,
        title: thread.title,
        messages: await deps.messages.listByThread(thread.threadId)
      };
      res.status(200).json(body);
    },

    'POST /threads/:threadId/ask': async (req, res) => {
      const parsed = AskBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(errorBody(400, parsed.error.message));
        return;
      }
      const thread = await ownedThread(req.params.threadId!, userOf(res));
      if (!thread) {
        res.status(404).json(errorBody(404, `no thread ${req.params.threadId}`));
        return;
      }
      const sink = createSseSink(res);
      try {
        await deps.runAsk({
          body: parsed.data,
          threadId: thread.threadId,
          userId: userOf(res),
          emitter: sink
        });
      } finally {
        sink.close();
        res.end();
      }
    }
  };

  for (const route of ROUTES) {
    if (route.path === '/evals/report.json') continue; // published artifact, later milestone
    const method = route.method.toLowerCase() as 'get' | 'post' | 'delete';
    const key = `${route.method} ${route.path}`;
    const handler =
      handlers[key] ??
      (async (_req: express.Request, res: express.Response) => {
        res.status(501).json(errorBody(501, `not implemented yet: ${key}`));
      });
    const chain = route.auth ? [requireUser, wrap(handler)] : [wrap(handler)];
    app[method](route.path, ...chain);
  }

  app.use((req, res) => res.status(404).json(errorBody(404, `no route ${req.method} ${req.path}`)));

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Fail loud (A1): a thrown error is a 502, or a visibly dead stream if headers went out.
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(502).json(errorBody(502, err.message));
  });

  return app;
}
