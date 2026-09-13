/**
 * Test-only scripted double for the single seam to the agent service
 * (ARCHITECTURE.md §2.1 `proxy/client.ts`). No network, no SDK, no env: every gateway test
 * scripts this fake instead of inventing its own.
 *
 * The types below are the *shape the implementer must satisfy* in `proxy/client.ts`; the fake
 * is structurally compatible, so `makeGatewayApp({ agent })` typechecks once the real
 * `AgentClient` interface exists.
 */
import type { HealthResponse } from '@lumina/contract';

export type AgentJsonRequest = {
  method: 'GET' | 'POST' | 'DELETE';
  /** Agent-side path, already param-substituted, e.g. '/threads' or '/memory/mem_1'. */
  path: string;
  /** Parsed JSON body for POST/DELETE; undefined for GET. */
  body?: unknown;
  /** Headers the gateway forwards upstream — at minimum x-user-id and x-request-id. */
  headers: Record<string, string>;
  query?: Record<string, string>;
};

export type AgentJsonResponse = { status: number; body: unknown };

export type AgentAskRequest = {
  threadId: string;
  /** The validated AskBody. */
  body: unknown;
  headers: Record<string, string>;
  /** Aborted when the browser disconnects. */
  signal?: AbortSignal;
};

/**
 * The ask response is deliberately *not* parsed by the gateway: `stream` is piped through
 * byte for byte, so the fake can script raw SSE frames without any HTTP.
 */
export type AgentAskResponse = {
  status: number;
  headers: Record<string, string>;
  stream: AsyncIterable<Uint8Array | string>;
};

/**
 * A document upload. The gateway must PIPE the request body upstream rather than buffer it
 * (a 25 MB PDF in memory on the edge is the thing this shape exists to prevent), so the
 * body is the raw readable, not a parsed form.
 */
export type AgentUploadRequest = {
  spaceId: string;
  /** The untouched request stream, forwarded with its multipart boundary intact. */
  body: AsyncIterable<Uint8Array>;
  headers: Record<string, string>;
  signal?: AbortSignal;
};

export type AgentClient = {
  health(): Promise<HealthResponse>;
  json(req: AgentJsonRequest): Promise<AgentJsonResponse>;
  ask(req: AgentAskRequest): Promise<AgentAskResponse>;
  upload(req: AgentUploadRequest): Promise<AgentJsonResponse>;
};

export type AgentScript = {
  health?: () => HealthResponse | Promise<HealthResponse>;
  json?: (req: AgentJsonRequest) => AgentJsonResponse | Promise<AgentJsonResponse>;
  ask?: (req: AgentAskRequest) => AgentAskResponse | Promise<AgentAskResponse>;
  upload?: (req: AgentUploadRequest) => AgentJsonResponse | Promise<AgentJsonResponse>;
};

export type ScriptedAgent = {
  client: AgentClient;
  calls: {
    health: number;
    json: AgentJsonRequest[];
    ask: AgentAskRequest[];
    upload: AgentUploadRequest[];
  };
};

export const okHealth: HealthResponse = {
  status: 'ok',
  model: 'claude-sonnet-5',
  searchProvider: 'tavily',
  vectorStore: 'atlas-vector-search',
  db: 'ok'
};

/** A recording, scripted AgentClient. Unscripted methods answer a harmless default. */
export function fakeAgent(script: AgentScript = {}): ScriptedAgent {
  const calls: ScriptedAgent['calls'] = { health: 0, json: [], ask: [], upload: [] };

  const client: AgentClient = {
    async health() {
      calls.health += 1;
      return script.health ? script.health() : okHealth;
    },
    async json(req) {
      calls.json.push(req);
      return script.json ? script.json(req) : { status: 200, body: {} };
    },
    async ask(req) {
      calls.ask.push(req);
      if (!script.ask) throw new Error('fakeAgent: ask was not scripted');
      return script.ask(req);
    },
    async upload(req) {
      calls.upload.push(req);
      return script.upload
        ? script.upload(req)
        : { status: 202, body: { docId: 'doc_fake1', status: 'pending' } };
    }
  };

  return { client, calls };
}

/** Turn literal SSE frames into the async iterable the ask proxy pipes. */
export function framesToStream(frames: readonly string[]): AsyncIterable<Uint8Array | string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) yield frame;
    }
  };
}
