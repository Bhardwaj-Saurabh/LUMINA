/**
 * RED — M10 Cloud Run IAM: the gateway mints ID tokens for the private agent from the
 * GCE metadata server (ARCHITECTURE.md §6.1). Time is injected (`now`), the network is a
 * captured fake `fetch`; nothing here touches a real clock or a real metadata endpoint.
 *
 * Why cache to `exp - 60s` and not `exp`: a token that is valid when minted can expire in
 * transit; a minute of slack is the standard Google client behaviour. Why in-flight dedupe:
 * a cold gateway receives a burst and must not fan out N metadata calls for one token.
 */
import { describe, expect, it } from 'vitest';
import { makeMetadataIdToken } from './idToken.js';

const AUDIENCE = 'https://lumina-agent-abc123-nw.a.run.app';
const METADATA_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity' +
  `?audience=${encodeURIComponent(AUDIENCE)}&format=full`;

const b64url = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj)).toString('base64url');

/** `header.payload.sig` with a real base64url JSON payload; the signature is opaque bytes. */
const fakeJwt = (expSeconds: number): string =>
  `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    aud: AUDIENCE,
    iss: 'https://accounts.google.com',
    exp: expSeconds
  })}.sig`;

type Call = { url: string; init: RequestInit | undefined };

interface FakeMetadata {
  fetch: typeof globalThis.fetch;
  calls: Call[];
  /** Resolves the next fetch with this response (queue; last one repeats). */
  respond(res: () => Response): void;
}

function fakeMetadata(): FakeMetadata {
  const calls: Call[] = [];
  const queue: Array<() => Response> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (!next) throw new Error('fake metadata: no response scripted');
    return next();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, respond: (r) => queue.push(r) };
}

const tokenResponse = (jwt: string) =>
  () => new Response(jwt, { status: 200, headers: { 'content-type': 'text/plain' } });

const T0_MS = 1_800_000_000_000; // fixed instant; only differences matter
const T0_S = T0_MS / 1000;

describe('makeMetadataIdToken', () => {
  it('fetches the identity endpoint once with the encoded audience and Metadata-Flavor header, returning the raw JWT', async () => {
    const md = fakeMetadata();
    const jwt = fakeJwt(T0_S + 3600);
    md.respond(tokenResponse(jwt));
    const idToken = makeMetadataIdToken({ audience: AUDIENCE, fetch: md.fetch, now: () => T0_MS });

    const tok = await idToken();

    expect(tok).toBe(jwt);
    expect(md.calls).toHaveLength(1);
    expect(md.calls[0]?.url).toBe(METADATA_URL);
    const headers = new Headers(md.calls[0]?.init?.headers);
    expect(headers.get('metadata-flavor')).toBe('Google');
  });

  it('serves the second call within validity from cache without fetching again', async () => {
    const md = fakeMetadata();
    const jwt = fakeJwt(T0_S + 3600);
    md.respond(tokenResponse(jwt));
    let now = T0_MS;
    const idToken = makeMetadataIdToken({ audience: AUDIENCE, fetch: md.fetch, now: () => now });

    const first = await idToken();
    now = T0_MS + 30 * 60 * 1000; // 30 min later, well inside the hour
    const second = await idToken();

    expect(second).toBe(first);
    expect(md.calls).toHaveLength(1);
  });

  it('mints a fresh token once the clock passes exp - 60s', async () => {
    const md = fakeMetadata();
    const stale = fakeJwt(T0_S + 3600);
    const fresh = fakeJwt(T0_S + 7200);
    md.respond(tokenResponse(stale));
    md.respond(tokenResponse(fresh));
    let now = T0_MS;
    const idToken = makeMetadataIdToken({ audience: AUDIENCE, fetch: md.fetch, now: () => now });

    expect(await idToken()).toBe(stale);
    // One second short of the refresh boundary: still cached.
    now = T0_MS + (3600 - 61) * 1000;
    expect(await idToken()).toBe(stale);
    expect(md.calls).toHaveLength(1);
    // At exp - 60s the token is treated as expired and re-minted.
    now = T0_MS + (3600 - 60) * 1000;
    expect(await idToken()).toBe(fresh);
    expect(md.calls).toHaveLength(2);
  });

  it('rejects, naming the status, when the metadata server answers non-OK (fail loud, never proxy unauthenticated)', async () => {
    const md = fakeMetadata();
    md.respond(() => new Response('forbidden', { status: 403 }));
    const idToken = makeMetadataIdToken({ audience: AUDIENCE, fetch: md.fetch, now: () => T0_MS });

    await expect(idToken()).rejects.toThrow(/403/);
  });

  it('shares one in-flight fetch between two concurrent first calls', async () => {
    const md = fakeMetadata();
    const jwt = fakeJwt(T0_S + 3600);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    md.respond(() => {
      // Body only becomes readable after the test lets it go, so both callers are truly
      // waiting at the same time.
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await gate;
          controller.enqueue(new TextEncoder().encode(jwt));
          controller.close();
        }
      });
      return new Response(stream, { status: 200 });
    });
    const idToken = makeMetadataIdToken({ audience: AUDIENCE, fetch: md.fetch, now: () => T0_MS });

    const a = idToken();
    const b = idToken();
    release?.();
    const [ta, tb] = await Promise.all([a, b]);

    expect(ta).toBe(jwt);
    expect(tb).toBe(jwt);
    expect(md.calls).toHaveLength(1);
  });
});
