import { describe, expect, it } from 'vitest';
import { DoneEvent, Source, TraceEvent } from '@lumina/contract';

// Seed suite: pins the contract behaviors the loop must satisfy before any loop exists.
describe('contract invariants the agent service builds against', () => {
  it('rejects a failed trace step without an error string (rule A1 lives in the schema)', () => {
    const failed = { step: 1, tool: 'web_search', input: {}, ok: false, ms: 120 };
    expect(TraceEvent.safeParse(failed).success).toBe(false);
    expect(TraceEvent.safeParse({ ...failed, error: '503 from provider' }).success).toBe(true);
  });

  it('requires url on web sources and docId on doc sources', () => {
    const web = { n: 1, kind: 'web', title: 't', snippet: 's' };
    expect(Source.safeParse(web).success).toBe(false);
    expect(Source.safeParse({ ...web, url: 'https://example.com' }).success).toBe(true);

    const doc = { n: 2, kind: 'doc', title: 'a.pdf', snippet: 's', locator: { page: 3 } };
    expect(Source.safeParse(doc).success).toBe(false);
    expect(Source.safeParse({ ...doc, docId: 'doc_x1' }).success).toBe(true);
  });

  it('only admits done|cap|error as terminated', () => {
    const done = {
      answerId: 'ans_1',
      latencyMs: 10,
      ttftMs: 5,
      model: 'm',
      tokens: { in: 1, out: 1 },
      costUsd: 0,
      searchCached: false,
      terminated: 'gave-up',
      depth: 'quick'
    };
    expect(DoneEvent.safeParse(done).success).toBe(false);
    expect(DoneEvent.safeParse({ ...done, terminated: 'cap' }).success).toBe(true);
  });
});
