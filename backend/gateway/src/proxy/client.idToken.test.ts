/**
 * RED — M10: every call the gateway makes to the agent carries the IAM ID token when one
 * is configured — including `health()`. Against a `--no-allow-unauthenticated` agent an
 * unauthenticated health probe is a 403, and the gateway's own `/health` would report the
 * agent down while asks succeed; nobody would know why.
 */
import { describe, expect, it } from 'vitest';
import type { HealthResponse } from '@lumina/contract';
import { makeAgentClient } from './client.js';

const healthBody: HealthResponse = {
  status: 'ok',
  model: 'gpt-5.4-mini',
  searchProvider: 'tavily',
  vectorStore: 'atlas-vector-search',
  db: 'ok',
  ai: { status: 'ok' }
};

type Call = { url: string; headers: Headers };

function fakeAgent(): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    if (url.endsWith('/ask')) {
      return new Response('event: done\ndata: {}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      });
    }
    return new Response(JSON.stringify(healthBody), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const clientWithToken = (fetch: typeof globalThis.fetch) =>
  makeAgentClient({ baseUrl: 'https://agent.internal', fetch, idToken: async () => 'tok' });

describe('AgentClient with idToken configured', () => {
  it('health() sends Authorization: Bearer <token> to the agent', async () => {
    const agent = fakeAgent();
    const client = clientWithToken(agent.fetch);

    const health = await client.health();

    expect(health).toEqual(healthBody);
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]?.url).toBe('https://agent.internal/health');
    expect(agent.calls[0]?.headers.get('authorization')).toBe('Bearer tok');
  });

  it('json() sends Authorization: Bearer <token>', async () => {
    const agent = fakeAgent();
    const client = clientWithToken(agent.fetch);

    await client.json({ method: 'GET', path: '/stats', headers: { 'x-user-id': 'u_alice' } });

    expect(agent.calls[0]?.headers.get('authorization')).toBe('Bearer tok');
    // The caller's identity header still rides alongside the IAM token.
    expect(agent.calls[0]?.headers.get('x-user-id')).toBe('u_alice');
  });

  it('ask() sends Authorization: Bearer <token>', async () => {
    const agent = fakeAgent();
    const client = clientWithToken(agent.fetch);

    await client.ask({
      threadId: 'thr_1',
      body: { query: 'q', depth: 'quick' },
      headers: { 'x-user-id': 'u_alice' }
    });

    expect(agent.calls[0]?.url).toBe('https://agent.internal/threads/thr_1/ask');
    expect(agent.calls[0]?.headers.get('authorization')).toBe('Bearer tok');
  });

  it('sends no Authorization header at all when idToken is unset (local dev)', async () => {
    const agent = fakeAgent();
    const client = makeAgentClient({ baseUrl: 'https://agent.internal', fetch: agent.fetch });

    await client.health();

    expect(agent.calls[0]?.headers.has('authorization')).toBe(false);
  });
});
