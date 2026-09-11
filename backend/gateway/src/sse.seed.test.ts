import { describe, expect, it } from 'vitest';
import { sseHeaders, sseSend } from './sse.js';

type Written = { headers: Record<string, string>; chunks: string[]; flushedHeaders: boolean };

const fakeRes = () => {
  const state: Written = { headers: {}, chunks: [], flushedHeaders: false };
  const res = {
    setHeader: (k: string, v: string) => void (state.headers[k.toLowerCase()] = v),
    flushHeaders: () => void (state.flushedHeaders = true),
    write: (chunk: string) => (state.chunks.push(chunk), true)
  };
  return { res: res as never, state };
};

// Seed suite: the provided SSE helpers are the transport contract the ask proxy relies on.
describe('provided sse helpers', () => {
  it('sets the anti-buffering headers and flushes them immediately', () => {
    const { res, state } = fakeRes();
    sseHeaders(res);
    expect(state.headers['content-type']).toContain('text/event-stream');
    expect(state.headers['cache-control']).toContain('no-transform');
    expect(state.headers['x-accel-buffering']).toBe('no');
    expect(state.flushedHeaders).toBe(true);
  });

  it('writes frames in the event/data wire format the provided UI parses', () => {
    const { res, state } = fakeRes();
    sseSend(res, 'token', { text: 'hi' });
    expect(state.chunks).toEqual(['event: token\ndata: {"text":"hi"}\n\n']);
  });
});
