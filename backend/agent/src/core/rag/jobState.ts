/**
 * Ingestion job state machine — ARCHITECTURE.md §2 (job state machine) and the async ingestion
 * rule: pending → parsing → embedding → indexed, `indexed` only reachable after the
 * read-your-write probe. Pure predicates: the clock is injected, nothing here touches Mongo.
 */
import type { DocStatus } from '@lumina/contract';

/** Forward-only; `indexed`/`failed` are terminal and appear in no `from` position. */
const NEXT: Record<DocStatus, readonly DocStatus[]> = {
  pending: ['parsing', 'failed'],
  parsing: ['embedding', 'failed'],
  embedding: ['indexed', 'failed'],
  indexed: [],
  failed: []
};

export function canTransition(from: DocStatus, to: DocStatus): boolean {
  return NEXT[from].includes(to);
}

const EMBEDDING_FLOOR = 10;
const EMBEDDING_CEILING = 90;

/** Contract bound: DocumentRow.pct is 0..100, so a degenerate ratio is clamped, never passed on. */
export function pctFor(status: DocStatus, ratio?: number): number {
  switch (status) {
    case 'pending':
      return 0;
    case 'parsing':
      return EMBEDDING_FLOOR;
    case 'indexed':
      return 100;
    case 'embedding': {
      const safe = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio as number)) : 0;
      return EMBEDDING_FLOOR + (EMBEDDING_CEILING - EMBEDDING_FLOOR) * safe;
    }
    case 'failed':
      return 0;
  }
}

/** A `running` row with no claim timestamp is unattributable, so the sweeper may always reclaim it. */
export function isLeaseExpired(args: { claimedAt?: string; now: number; leaseMs: number }): boolean {
  if (!args.claimedAt) return true;
  const claimed = Date.parse(args.claimedAt);
  if (Number.isNaN(claimed)) return true;
  return args.now - claimed > args.leaseMs;
}

export type Disposition = 'requeue' | 'fail';

/** A poison document fails instead of looping forever. */
export function dispositionFor(args: { attempts: number; maxAttempts: number }): Disposition {
  return args.attempts >= args.maxAttempts ? 'fail' : 'requeue';
}
