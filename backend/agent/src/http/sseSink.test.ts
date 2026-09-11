import { describe, expect, it } from 'vitest';
import { createSseSink } from './sseSink.js';

type FakeRes = {
  headers: Record<string, string>;
  chunks: string[];
  flushedHeaders: boolean;
  flushes: number;
};

const fakeRes = () => {
  const state: FakeRes = { headers: {}, chunks: [], flushedHeaders: false, flushes: 0 };
  const res = {
    setHeader: (k: string, v: string) => void (state.headers[k.toLowerCase()] = v),
    flushHeaders: () => void (state.flushedHeaders = true),
    write: (chunk: string) => (state.chunks.push(chunk), true),
    flush: () => void (state.flushes += 1)
  };
  return { res: res as never, state };
};

/** Injectable scheduler: capture the keepalive callback, fire it manually, count cancels. */
const fakeScheduler = () => {
  const calls: Array<{ fn: () => void; ms: number }> = [];
  let cancels = 0;
  return {
    schedule: (fn: () => void, ms: number) => {
      calls.push({ fn, ms });
      return () => void (cancels += 1);
    },
    calls,
    cancelled: () => cancels
  };
};

const doneData = {
  answerId: 'ans_1',
  latencyMs: 100,
  ttftMs: 40,
  model: 'gpt-5.4-mini',
  tokens: { in: 10, out: 5 },
  costUsd: 0.001,
  searchCached: false,
  terminated: 'done' as const,
  depth: 'quick' as const
};

describe('createSseSink', () => {
  it('sets the anti-buffering SSE headers and flushes them on creation', () => {
    const { res, state } = fakeRes();
    createSseSink(res, { schedule: fakeScheduler().schedule });
    expect(state.headers['content-type']).toContain('text/event-stream');
    expect(state.headers['cache-control']).toContain('no-transform');
    expect(state.headers['x-accel-buffering']).toBe('no');
    expect(state.flushedHeaders).toBe(true);
  });

  it('writes each emitter method as one event/data frame and flushes per frame', () => {
    const { res, state } = fakeRes();
    const sink = createSseSink(res, { schedule: fakeScheduler().schedule });
    sink.trace({ step: 1, tool: 'web_search', input: { query: 'q', reason: 'r' }, ok: true, ms: 12 });
    sink.sources([]);
    sink.token({ text: 'hi' });
    expect(state.chunks[0]).toBe(
      `event: trace\ndata: ${JSON.stringify({ step: 1, tool: 'web_search', input: { query: 'q', reason: 'r' }, ok: true, ms: 12 })}\n\n`
    );
    expect(state.chunks[1]).toBe('event: sources\ndata: []\n\n');
    expect(state.chunks[2]).toBe('event: token\ndata: {"text":"hi"}\n\n');
    expect(state.flushes).toBe(3);
  });

  it('schedules a keepalive at 15000 ms that writes a comment frame when fired', () => {
    const { res, state } = fakeRes();
    const sched = fakeScheduler();
    createSseSink(res, { schedule: sched.schedule });
    expect(sched.calls).toHaveLength(1);
    expect(sched.calls[0]!.ms).toBe(15000);
    sched.calls[0]!.fn();
    expect(state.chunks).toContain(': keepalive\n\n');
  });

  it('done stops the keepalive and ignores anything emitted afterwards', () => {
    const { res, state } = fakeRes();
    const sched = fakeScheduler();
    const sink = createSseSink(res, { schedule: sched.schedule });
    sink.done(doneData);
    expect(sched.cancelled()).toBe(1);
    const after = state.chunks.length;
    sink.token({ text: 'late' });
    sink.trace({ step: 9, tool: 'web_search', input: {}, ok: true, ms: 1 });
    expect(state.chunks).toHaveLength(after);
  });

  it('error stops the keepalive and closes the stream to further frames', () => {
    const { res, state } = fakeRes();
    const sched = fakeScheduler();
    const sink = createSseSink(res, { schedule: sched.schedule });
    sink.error({ status: 502, error: 'search provider 503' });
    expect(sched.cancelled()).toBe(1);
    const after = state.chunks.length;
    sink.token({ text: 'late' });
    expect(state.chunks).toHaveLength(after);
    expect(state.chunks[after - 1]).toBe('event: error\ndata: {"status":502,"error":"search provider 503"}\n\n');
  });

  it('close() (client disconnect) cancels the keepalive and suppresses further writes', () => {
    const { res, state } = fakeRes();
    const sched = fakeScheduler();
    const sink = createSseSink(res, { schedule: sched.schedule });
    sink.close();
    expect(sched.cancelled()).toBe(1);
    const after = state.chunks.length;
    sink.token({ text: 'late' });
    sink.done(doneData);
    expect(state.chunks).toHaveLength(after);
  });
});
