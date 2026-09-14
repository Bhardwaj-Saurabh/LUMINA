/**
 * THE single seam to the agent service (ARCHITECTURE.md §2.1 `proxy/client.ts`): base URL,
 * header forwarding, and the one place Cloud Run IAM ID tokens plug in (§6.1). It forwards
 * bytes and stays ignorant of SSE semantics — `ask` hands back the raw body stream, never a
 * parsed frame. A network failure throws; the app maps it to 502 (fail loud, rule A1).
 */
import { HealthResponse } from '@lumina/contract';

export type AgentJsonRequest = {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  headers: Record<string, string>;
  query?: Record<string, string>;
};

export type AgentJsonResponse = { status: number; body: unknown };

export type AgentAskRequest = {
  threadId: string;
  body: unknown;
  headers: Record<string, string>;
  signal?: AbortSignal;
};

export type AgentAskResponse = {
  status: number;
  headers: Record<string, string>;
  stream: AsyncIterable<Uint8Array | string>;
};

/**
 * A document upload. The body is the raw request stream: the gateway pipes it upstream
 * rather than buffering, so a 25 MB PDF never lands in edge memory.
 */
export type AgentUploadRequest = {
  spaceId: string;
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

export interface AgentClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  /** Cloud Run IAM seam: when set, its token rides as `Authorization: Bearer`. Unset locally. */
  idToken?: () => Promise<string | undefined>;
}

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding']);

const forwardable = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).filter(([k, v]) => v !== undefined && !HOP_BY_HOP.has(k.toLowerCase()))
  );

const headersToObject = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
};

/** A web ReadableStream is async-iterable on Node 20, but the types lag; adapt explicitly. */
const toAsyncIterable = (body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    if (!body) return;
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
});

export function makeAgentClient({
  baseUrl,
  fetch: doFetch = globalThis.fetch,
  idToken
}: AgentClientOptions): AgentClient {
  const root = baseUrl.replace(/\/+$/, '');

  const authHeaders = async (): Promise<Record<string, string>> => {
    const token = await idToken?.();
    return token ? { authorization: `Bearer ${token}` } : {};
  };

  return {
    async health() {
      // The one call that used to go out without the IAM token — against a gated agent the
      // gateway's own health proxy would have 403'd, and /health would have read "agent down".
      const res = await doFetch(`${root}/health`, {
        headers: await authHeaders(),
        signal: AbortSignal.timeout(3000)
      });
      return HealthResponse.parse(await res.json());
    },

    async json(req) {
      const query = new URLSearchParams(req.query ?? {}).toString();
      const url = `${root}${req.path}${query ? `?${query}` : ''}`;
      const hasBody = req.method !== 'GET' && req.body !== undefined;
      const res = await doFetch(url, {
        method: req.method,
        headers: {
          ...forwardable(req.headers),
          ...(await authHeaders()),
          ...(hasBody ? { 'content-type': 'application/json' } : {})
        },
        ...(hasBody ? { body: JSON.stringify(req.body) } : {})
      });
      // Upstream status is mapped verbatim, never normalised.
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as unknown) : {} };
    },

    async ask(req) {
      const res = await doFetch(`${root}/threads/${req.threadId}/ask`, {
        method: 'POST',
        headers: {
          ...forwardable(req.headers),
          ...(await authHeaders()),
          'content-type': 'application/json',
          accept: 'text/event-stream'
        },
        body: JSON.stringify(req.body),
        ...(req.signal ? { signal: req.signal } : {})
      });
      return {
        status: res.status,
        headers: headersToObject(res.headers),
        stream: toAsyncIterable(res.body)
      };
    },

    async upload(req) {
      const res = await doFetch(`${root}/spaces/${req.spaceId}/documents`, {
        method: 'POST',
        headers: {
          // The multipart boundary lives in content-type and must survive untouched.
          ...forwardable(req.headers),
          ...(await authHeaders())
        },
        // A Node Readable is a valid streaming body for undici; the DOM lib's BodyInit
        // (which this tsconfig does not load) cannot express it.
        body: req.body as unknown,
        // Streaming a request body requires half-duplex; without it undici buffers.
        duplex: 'half',
        ...(req.signal ? { signal: req.signal } : {})
      } as RequestInit);
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as unknown) : undefined };
    }
  };
}
