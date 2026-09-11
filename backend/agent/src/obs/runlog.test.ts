import { describe, expect, it } from 'vitest';
import { RunLog } from '@lumina/contract';
import { createRunLog } from './runlog.js';

const clock = (start: number) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
};

describe('createRunLog', () => {
  it('builds a contract-valid RunLog with ordered tool calls and summed token total', () => {
    const c = clock(1_000);
    const log = createRunLog({ depth: 'quick', now: c.now });
    log.toolCall({ name: 'web_search', ok: true, ms: 812 });
    log.toolCall({ name: 'fetch_page', ok: false, error: '403 from publisher', ms: 40 });
    log.toolCall({ name: 'fetch_page', ok: true, ms: 610 });
    c.advance(6_400);
    log.finish({ tokensIn: 18_000, tokensOut: 240, costUsd: 0.021, terminated: 'done' });

    const built = log.build();
    const parsed = RunLog.parse(built);
    expect(parsed.toolCalls.map((t) => t.name)).toEqual(['web_search', 'fetch_page', 'fetch_page']);
    expect(parsed.toolCalls[1]!.error).toBe('403 from publisher');
    expect(parsed.tokens).toBe(18_240); // single in+out total, NOT the {in,out} split
    expect(parsed.wallClockSec).toBeCloseTo(6.4, 5); // seconds from the injected clock
    expect(parsed.terminated).toBe('done');
    expect(parsed.depth).toBe('quick');
  });

  it('refuses to build when a failed call carries no error string (A1)', () => {
    const c = clock(0);
    const log = createRunLog({ depth: 'quick', now: c.now });
    log.toolCall({ name: 'web_search', ok: false, ms: 5 });
    log.finish({ tokensIn: 1, tokensOut: 1, costUsd: 0, terminated: 'error' });
    expect(() => log.build()).toThrow();
  });

  it('persist() hands the built log to injected writeFile and upsert seams', async () => {
    const c = clock(0);
    const log = createRunLog({ depth: 'deep', now: c.now });
    log.toolCall({ name: 'plan_research', ok: true, ms: 900 });
    c.advance(42_000);
    log.finish({ tokensIn: 90_000, tokensOut: 2_000, costUsd: 0.19, terminated: 'done' });

    const writes: Array<{ path: string; content: string }> = [];
    const upserts: Array<Record<string, unknown>> = [];
    await log.persist({
      requestId: 'req_abc123',
      writeFile: async (path, content) => void writes.push({ path, content }),
      upsert: async (doc) => void upserts.push(doc)
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]!.path.endsWith('runs/req_abc123.json')).toBe(true);
    expect(() => RunLog.parse(JSON.parse(writes[0]!.content))).not.toThrow();
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.requestId).toBe('req_abc123');
    expect(RunLog.parse(upserts[0]).depth).toBe('deep');
  });
});
