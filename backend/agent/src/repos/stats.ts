/**
 * `GET /stats` — ARCHITECTURE.md §10. Computed from the `requests` rows every answer
 * writes, so the numbers are the same evidence the run logs and the gateway log carry,
 * not a second set of counters that can drift from them.
 *
 * Scope is deliberately mixed, and the contract says why: the totals are INSTANCE-WIDE for
 * today (a dashboard answering "what has this deployment done today"), while `deepToday` is
 * this user's own spend against their own cap. Making the totals per-user would also make
 * them unreconcilable with any run that touched more than one user id.
 */
import type { Db } from 'mongodb';
import { COLLECTIONS, type StatsResponse } from '@lumina/contract';
import { dayStartIso } from '../core/deep/deepCap.js';
import type { DeepUsageStore } from '../core/deep/deepCap.js';
import { DEEP_ADMISSION_ROUTE } from './deepUsage.js';

/** The route an answer records itself under; ledger rows are excluded from the totals. */
const ASK_ROUTE = 'POST /threads/:threadId/ask';

interface RequestRow {
  status: number;
  costUsd?: number;
  ttftMs?: number;
  searchCached?: boolean;
  terminated?: string;
  depth?: string;
}

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank, the same definition benchmark/lib.mjs uses.
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? 0;
};

export function makeStatsReader(
  db: Db,
  deps: { deepDailyCap: number; deepUsage: Pick<DeepUsageStore, 'countSince'>; now?: () => number }
) {
  const col = db.collection(COLLECTIONS.requests);
  const now = deps.now ?? Date.now;

  return async function readStats(userId: string): Promise<StatsResponse> {
    const sinceIso = dayStartIso(now());
    const [rows, deepToday] = await Promise.all([
      col
        .find<RequestRow>(
          { route: ASK_ROUTE, createdAt: { $gte: sinceIso } },
          { projection: { status: 1, costUsd: 1, ttftMs: 1, searchCached: 1, terminated: 1, depth: 1 } }
        )
        .toArray(),
      deps.deepUsage.countSince({ userId, sinceIso })
    ]);

    const answered = rows.filter((r) => r.terminated !== undefined);
    // TTFT and cache-hit rate are the QUICK gear's numbers — the SLA defines them that way,
    // and a deep search's 12 s first paint averaged in would make the quick figure a fiction.
    const quick = rows.filter((r) => r.depth !== 'deep');
    const withCacheInfo = quick.filter((r) => typeof r.searchCached === 'boolean');
    const ttfts = quick.map((r) => r.ttftMs).filter((v): v is number => typeof v === 'number');

    return {
      requests: rows.length,
      answers: answered.length,
      searchCacheHitRatePct: withCacheInfo.length
        ? (withCacheInfo.filter((r) => r.searchCached).length / withCacheInfo.length) * 100
        : 0,
      ttftP95Ms: percentile(ttfts, 95),
      costUsdToday: rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
      deepToday,
      deepDailyCap: deps.deepDailyCap
    };
  };
}

export { DEEP_ADMISSION_ROUTE, ASK_ROUTE };
