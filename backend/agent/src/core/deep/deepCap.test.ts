/**
 * M8 batch A — the deep daily-cap ledger (`core/deep/deepCap.ts`).
 *
 * DEEP_DAILY_CAP per user, enforced in the AGENT (a cap on the edge is bypassable by hitting
 * the agent directly). The window is the UTC day; admission is a pure function of an injected
 * `now` and an injected store — never the real clock, never Mongo.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { admitDeep, dayStartIso, resetsAtIso, type DeepUsageStore } from './deepCap.js';

/** In-memory usage ledger that filters exactly as the Mongo query will: userId + atIso >= since. */
function fakeUsageStore(seed: Array<{ userId: string; atIso: string }> = []): DeepUsageStore & {
  rows: Array<{ userId: string; atIso: string }>;
  countCalls: Array<{ userId: string; sinceIso: string }>;
  recordCalls: Array<{ userId: string; atIso: string }>;
} {
  const rows = [...seed];
  const countCalls: Array<{ userId: string; sinceIso: string }> = [];
  const recordCalls: Array<{ userId: string; atIso: string }> = [];
  return {
    rows,
    countCalls,
    recordCalls,
    async countSince(args) {
      countCalls.push({ ...args });
      return rows.filter((r) => r.userId === args.userId && r.atIso >= args.sinceIso).length;
    },
    async record(args) {
      recordCalls.push({ ...args });
      rows.push({ ...args });
    }
  };
}

const NOON = Date.UTC(2026, 8, 13, 12, 0, 0); // 2026-09-13T12:00:00Z

describe('admitDeep', () => {
  it('admits under the cap, counts the remaining allowance down, and records the use', async () => {
    const store = fakeUsageStore([{ userId: 'u1', atIso: '2026-09-13T09:00:00.000Z' }]);

    const first = await admitDeep({ userId: 'u1', now: NOON, cap: 3, store });

    expect(first).toEqual({ ok: true, used: 2, remaining: 1 });
    expect(store.recordCalls).toHaveLength(1);

    // The recorded use is visible to the next admission — the ledger is the state of record.
    const second = await admitDeep({ userId: 'u1', now: NOON, cap: 3, store });
    expect(second).toEqual({ ok: true, used: 3, remaining: 0 });
  });

  it('refuses at exactly the cap with a resetsAt and records nothing for the refused request', async () => {
    // A refused request must not consume allowance, or the user loses a day to a 429.
    const store = fakeUsageStore([
      { userId: 'u1', atIso: '2026-09-13T01:00:00.000Z' },
      { userId: 'u1', atIso: '2026-09-13T02:00:00.000Z' }
    ]);

    const admission = await admitDeep({ userId: 'u1', now: NOON, cap: 2, store });

    expect(admission.ok).toBe(false);
    expect(admission).toMatchObject({ ok: false, used: 2, remaining: 0 });
    expect(admission.ok === false && admission.resetsAt).toBeTruthy();
    expect(store.recordCalls).toEqual([]);
    expect(store.rows).toHaveLength(2);
  });

  it('reports resetsAt as a valid ISO datetime strictly after now', async () => {
    const store = fakeUsageStore([{ userId: 'u1', atIso: '2026-09-13T01:00:00.000Z' }]);

    const admission = await admitDeep({ userId: 'u1', now: NOON, cap: 1, store });

    expect(admission.ok).toBe(false);
    if (admission.ok) throw new Error('expected a refusal');
    z.string().datetime().parse(admission.resetsAt);
    expect(Date.parse(admission.resetsAt)).toBeGreaterThan(NOON);
  });

  it('scopes the window to the UTC day, so 23:59Z and 00:01Z the next day are different windows', async () => {
    const lateOnThe13th = Date.UTC(2026, 8, 13, 23, 59, 0);
    const earlyOnThe14th = Date.UTC(2026, 8, 14, 0, 1, 0);
    const store = fakeUsageStore([
      { userId: 'u1', atIso: '2026-09-13T08:00:00.000Z' },
      { userId: 'u1', atIso: '2026-09-13T20:00:00.000Z' }
    ]);

    const atNight = await admitDeep({ userId: 'u1', now: lateOnThe13th, cap: 2, store });
    expect(atNight).toMatchObject({ ok: false, used: 2, remaining: 0 });

    const afterMidnight = await admitDeep({ userId: 'u1', now: earlyOnThe14th, cap: 2, store });
    expect(afterMidnight).toEqual({ ok: true, used: 1, remaining: 1 });
    expect(store.countCalls.at(-1)!.sinceIso).toBe('2026-09-14T00:00:00.000Z');
  });

  it('brackets now with a dayStart and a resetsAt exactly 24 hours apart', () => {
    const start = dayStartIso(NOON);
    const reset = resetsAtIso(NOON);

    expect(start).toBe('2026-09-13T00:00:00.000Z');
    expect(reset).toBe('2026-09-14T00:00:00.000Z');
    expect(Date.parse(reset) - Date.parse(start)).toBe(24 * 60 * 60 * 1000);
    expect(Date.parse(start)).toBeLessThanOrEqual(NOON);
    expect(Date.parse(reset)).toBeGreaterThan(NOON);
  });

  it('caps per user, so one user exhausting the day does not refuse another', async () => {
    const store = fakeUsageStore([
      { userId: 'u1', atIso: '2026-09-13T01:00:00.000Z' },
      { userId: 'u1', atIso: '2026-09-13T02:00:00.000Z' }
    ]);

    const exhausted = await admitDeep({ userId: 'u1', now: NOON, cap: 2, store });
    const other = await admitDeep({ userId: 'u2', now: NOON, cap: 2, store });

    expect(exhausted.ok).toBe(false);
    expect(other).toEqual({ ok: true, used: 1, remaining: 1 });
    expect(store.countCalls.map((c) => c.userId)).toEqual(['u1', 'u2']);
    expect(store.recordCalls).toEqual([{ userId: 'u2', atIso: '2026-09-13T12:00:00.000Z' }]);
  });

  it('fails closed on a zero, negative or NaN cap rather than admitting everyone', async () => {
    // This is the spend gate: a misconfigured cap must refuse, not open the doors.
    for (const cap of [0, -5, Number.NaN]) {
      const store = fakeUsageStore();
      const admission = await admitDeep({ userId: 'u1', now: NOON, cap, store });
      expect(admission).toMatchObject({ ok: false, used: 0, remaining: 0 });
      expect(store.recordCalls).toEqual([]);
    }
  });
});
