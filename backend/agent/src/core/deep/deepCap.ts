/**
 * DEEP_DAILY_CAP — the per-user spend gate (ARCHITECTURE.md §3.2, SPEC: deep over cap → 429).
 *
 * It lives in the AGENT, not the gateway: a cap on the edge is bypassed by calling the agent
 * directly. The window is the UTC day, and both `now` and the ledger are injected — admission
 * is a pure function of its arguments, never of the wall clock or of Mongo.
 */

export interface DeepUsageStore {
  countSince(args: { userId: string; sinceIso: string }): Promise<number>;
  record(args: { userId: string; atIso: string }): Promise<void>;
}

export type DeepAdmission =
  | { ok: true; used: number; remaining: number }
  | { ok: false; used: number; remaining: 0; resetsAt: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Most recent UTC midnight at or before `now`. */
export function dayStartIso(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/** The next UTC midnight — when the refused user gets their allowance back. */
export function resetsAtIso(now: number): string {
  return new Date(Date.parse(dayStartIso(now)) + DAY_MS).toISOString();
}

export async function admitDeep(args: {
  userId: string;
  now: number;
  cap: number;
  store: DeepUsageStore;
}): Promise<DeepAdmission> {
  const { userId, now, store } = args;
  // Fail CLOSED on a misconfigured cap: a broken spend gate must refuse, not open the doors.
  const cap = Number.isFinite(args.cap) ? Math.max(0, Math.floor(args.cap)) : 0;
  if (cap === 0) return { ok: false, used: 0, remaining: 0, resetsAt: resetsAtIso(now) };

  const prior = await store.countSince({ userId, sinceIso: dayStartIso(now) });
  // A refused request records nothing — losing a day's allowance to a 429 is not a cap.
  if (prior >= cap) return { ok: false, used: prior, remaining: 0, resetsAt: resetsAtIso(now) };

  const atIso = new Date(now).toISOString();
  await store.record({ userId, atIso });
  const used = prior + 1;
  return { ok: true, used, remaining: cap - used };
}
