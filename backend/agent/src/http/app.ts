/**
 * makeAgentApp — express app factory over injected repos/ports (ARCHITECTURE.md §2.2
 * http/routes/*). The composition root (index.ts) supplies real Mongo repos, the ask
 * strategy and the env-backed health fn; tests supply fakes. Contract ROUTES drive both
 * the x-user-id gate and the 501 placeholders for routes not built yet.
 */
import express from 'express';
import {
  AskBody,
  CreateSpaceBody,
  CreateThreadBody,
  newId,
  ROUTES,
  USER_HEADER,
  type ErrorBody,
  type HealthResponse,
  type CreateSpaceResponse,
  type CreateThreadResponse,
  type GetThreadResponse,
  type ListDocumentsResponse,
  type ListMemoryResponse,
  type ListSpacesResponse,
  type StatsResponse,
  type ThreadMessage
} from '@lumina/contract';
import type { z } from 'zod';
import type { AskEmitter } from '../core/loop.js';
import type { DeepAdmission } from '../core/deep/deepCap.js';
import type { DocumentsRepo } from '../repos/documents.js';
import type { MemoriesRepo } from '../repos/memories.js';
import type { SpacesRepo } from '../repos/spaces.js';
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
  /** Gateway-forwarded x-request-id when present; runAsk mints one otherwise. */
  requestId?: string;
}

export interface AgentAppDeps {
  threads: ThreadsRepo;
  messages: MessagesRepo;
  /** Absent until wired: the memory routes stay 501 rather than pretending to be empty. */
  memories?: Pick<MemoriesRepo, 'list' | 'delete'>;
  /** Same rule for Spaces: no dep, no empty-but-successful answer. */
  spaces?: SpacesRepo;
  documents?: Pick<DocumentsRepo, 'listBySpace'>;
  /** The multipart upload route, built by makeUploadDocumentHandler. */
  uploadDocument?: express.RequestHandler;
  runAsk(input: RunAskInput): Promise<void>;
  health(): Promise<HealthResponse>;
  /**
   * The deep spend gate (SPEC 5.5). Absent ⇒ deep runs unrationed, which is the honest
   * behaviour for a local dev process; in a deploy the composition root always wires it.
   */
  admitDeep?(userId: string): Promise<DeepAdmission>;
  /** Absent until wired: `/stats` stays 501 rather than reporting zeroes that look real. */
  stats?(userId: string): Promise<StatsResponse>;
  /**
   * The published evals report (ARCHITECTURE §8.1): a READ of an operator-published
   * artifact, never a computation. Public by contract (ROUTES marks it auth:false) — the UI's
   * /evals page and the grader both fetch it without a user.
   */
  evalsReport?: { get(): Promise<{ json: unknown; etag: string; publishedAt: string } | null> };
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
      // The spend gate runs AFTER ownership (probing a foreign thread must not burn the
      // prober's allowance) and BEFORE the sink: once the stream is open the request has
      // been accepted, and a refusal could only arrive as an error frame nobody asked for.
      if (parsed.data.depth === 'deep' && deps.admitDeep) {
        const admission = await deps.admitDeep(userOf(res));
        if (!admission.ok) {
          res.status(429).json({
            ...errorBody(429, `deep search daily cap reached (${admission.used} used)`),
            resetsAt: admission.resetsAt
          });
          return;
        }
      }
      const sink = createSseSink(res);
      try {
        const inboundRequestId = req.header('x-request-id');
        await deps.runAsk({
          body: parsed.data,
          threadId: thread.threadId,
          userId: userOf(res),
          emitter: sink,
          ...(inboundRequestId ? { requestId: inboundRequestId } : {})
        });
      } finally {
        sink.close();
        res.end();
      }
    }
  };

  const evalsReport = deps.evalsReport;
  if (evalsReport) {
    handlers['GET /evals/report.json'] = async (req, res) => {
      const report = await evalsReport.get();
      if (!report) {
        // Unpublished is a clear state — never an empty report that looks like a bad score.
        res.status(404).json(errorBody(404, 'no evals report has been published yet'));
        return;
      }
      const etag = `"${report.etag}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Published-At', report.publishedAt);
      if (req.header('if-none-match') === etag) {
        res.status(304).end();
        return;
      }
      res.status(200).json(report.json);
    };
  }

  const stats = deps.stats;
  if (stats) {
    handlers['GET /stats'] = async (_req, res) => {
      res.status(200).json(await stats(userOf(res)));
    };
  }

  const memories = deps.memories;
  if (memories) {
    handlers['GET /memory'] = async (_req, res) => {
      const rows = await memories.list(userOf(res));
      const body: ListMemoryResponse = {
        memories: rows.map((r) => ({
          id: r.memoryId,
          text: r.text,
          ...(r.sourceThread ? { sourceThread: r.sourceThread } : {}),
          createdAt: r.createdAt
        }))
      };
      res.status(200).json(body);
    };

    handlers['DELETE /memory/:memoryId'] = async (req, res) => {
      const memoryId = req.params.memoryId!;
      // Ownership lives in the repo filter; a foreign row is indistinguishable from an
      // unknown one — 404, never 403 (same rule as threads).
      const removed = await memories.delete({ userId: userOf(res), memoryId });
      if (!removed) {
        res.status(404).json(errorBody(404, `no memory ${memoryId}`));
        return;
      }
      res.status(204).end();
    };
  }

  const spaces = deps.spaces;
  const documents = deps.documents;
  if (spaces) {
    handlers['POST /spaces'] = async (req, res) => {
      const parsed = CreateSpaceBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json(errorBody(400, parsed.error.message));
        return;
      }
      const row = {
        spaceId: newId('spc'),
        userId: userOf(res),
        name: parsed.data.name,
        createdAt: new Date().toISOString()
      };
      await spaces.insert(row);
      const body: CreateSpaceResponse = { spaceId: row.spaceId, name: row.name };
      res.status(201).json(body);
    };

    handlers['GET /spaces'] = async (_req, res) => {
      const rows = await spaces.listByUser(userOf(res));
      const body: ListSpacesResponse = {
        spaces: rows.map((r) => ({ spaceId: r.spaceId, name: r.name, createdAt: r.createdAt }))
      };
      res.status(200).json(body);
    };

  }

  if (spaces && documents) {
    handlers['GET /spaces/:spaceId/documents'] = async (req, res) => {
      const spaceId = req.params.spaceId!;
      // Ownership before the read: a foreign Space is unknown — 404, never 403 — and its
      // documents are never queried.
      const owned = await spaces.findOwned({ spaceId, userId: userOf(res) });
      if (!owned) {
        res.status(404).json(errorBody(404, `no space ${spaceId}`));
        return;
      }
      const body: ListDocumentsResponse = {
        documents: await documents.listBySpace({ spaceId, userId: userOf(res) })
      };
      res.status(200).json(body);
    };
  }

  /** Routes whose handler is a middleware, not a Handler (multipart streaming). */
  const middleware: Record<string, express.RequestHandler> = deps.uploadDocument
    ? { 'POST /spaces/:spaceId/documents': deps.uploadDocument }
    : {};

  for (const route of ROUTES) {
    const method = route.method.toLowerCase() as 'get' | 'post' | 'delete';
    const key = `${route.method} ${route.path}`;
    const handler =
      handlers[key] ??
      (async (_req: express.Request, res: express.Response) => {
        res.status(501).json(errorBody(501, `not implemented yet: ${key}`));
      });
    const mounted = middleware[key] ?? wrap(handler);
    const chain = route.auth ? [requireUser, mounted] : [mounted];
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
