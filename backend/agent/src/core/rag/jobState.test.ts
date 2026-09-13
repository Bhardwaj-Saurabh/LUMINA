import { describe, expect, it } from 'vitest';
import { DocStatus, DocumentRow } from '@lumina/contract';
import { canTransition, dispositionFor, isLeaseExpired, pctFor } from './jobState.js';

/**
 * jobState — ARCHITECTURE.md §2 (job state machine) and the async ingestion rule in CLAUDE.md:
 * pending → parsing → embedding → indexed, `indexed` only after the read-your-write probe;
 * a stale `running` claim is reclaimed by the sweeper; a poison document fails instead of
 * looping forever. Pure predicates — no clock, no Mongo: `now` is injected.
 */

const NON_TERMINAL: DocStatus[] = ['pending', 'parsing', 'embedding'];
const ALL: DocStatus[] = ['pending', 'parsing', 'embedding', 'indexed', 'failed'];

describe('canTransition pipeline order', () => {
  it('allows each hop of the forward path pending → parsing → embedding → indexed', () => {
    expect(canTransition('pending', 'parsing')).toBe(true);
    expect(canTransition('parsing', 'embedding')).toBe(true);
    expect(canTransition('embedding', 'indexed')).toBe(true);
  });

  it('refuses to rewind the pipeline or to restate the current status', () => {
    expect(canTransition('embedding', 'parsing')).toBe(false);
    expect(canTransition('indexed', 'embedding')).toBe(false);
    expect(canTransition('parsing', 'pending')).toBe(false);
    for (const status of ALL) expect(canTransition(status, status)).toBe(false);
  });

  it('refuses to skip a stage, which is what makes the read-your-write probe unskippable', () => {
    expect(canTransition('pending', 'indexed')).toBe(false);
    expect(canTransition('pending', 'embedding')).toBe(false);
    expect(canTransition('parsing', 'indexed')).toBe(false);
  });

  it('lets any non-terminal status fail', () => {
    for (const status of NON_TERMINAL) expect(canTransition(status, 'failed')).toBe(true);
  });

  it('treats indexed and failed as terminal, so nothing leaves them', () => {
    for (const to of ALL) {
      expect(canTransition('failed', to)).toBe(false);
      expect(canTransition('indexed', to)).toBe(false);
    }
    // A retry creates a fresh attempt; it never rewinds the document.
    expect(canTransition('failed', 'pending')).toBe(false);
    expect(canTransition('indexed', 'failed')).toBe(false);
  });
});

describe('pctFor progress', () => {
  it('reports the fixed milestones: pending 0, parsing 10, indexed 100', () => {
    expect(pctFor('pending')).toBe(0);
    expect(pctFor('parsing')).toBe(10);
    expect(pctFor('indexed')).toBe(100);
  });

  it('interpolates embedding between 10 and 90 with the embedded ratio', () => {
    expect(pctFor('embedding', 0)).toBe(10);
    expect(pctFor('embedding', 0.5)).toBe(50);
    expect(pctFor('embedding', 1)).toBe(90);
  });

  it('never returns a pct outside the contract bound of 0..100', () => {
    const values = [
      pctFor('pending'),
      pctFor('parsing'),
      pctFor('indexed'),
      pctFor('embedding'),
      ...[0, 0.25, 0.5, 0.75, 1, -1, 2, Number.NaN].map((ratio) => pctFor('embedding', ratio))
    ];

    for (const pct of values) {
      const parsed = DocumentRow.safeParse({ docId: 'doc_1', title: 'x', status: 'embedding', pct });
      expect(parsed.success).toBe(true);
    }
  });
});

describe('isLeaseExpired sweeper signal', () => {
  const leaseMs = 60_000;
  const now = Date.parse('2026-09-13T12:00:00.000Z');

  it('reports a claim older than the lease as expired', () => {
    const claimedAt = new Date(now - leaseMs - 1).toISOString();
    expect(isLeaseExpired({ claimedAt, now, leaseMs })).toBe(true);
  });

  it('reports a claim still inside the lease window as live', () => {
    const claimedAt = new Date(now - leaseMs + 1_000).toISOString();
    expect(isLeaseExpired({ claimedAt, now, leaseMs })).toBe(false);
  });

  it('treats a running row with no claim timestamp as expired, so it can never stick forever', () => {
    expect(isLeaseExpired({ now, leaseMs })).toBe(true);
    expect(isLeaseExpired({ claimedAt: undefined, now, leaseMs })).toBe(true);
  });
});

describe('dispositionFor retry policy', () => {
  it('requeues an attempt below the maximum', () => {
    expect(dispositionFor({ attempts: 0, maxAttempts: 3 })).toBe('requeue');
    expect(dispositionFor({ attempts: 2, maxAttempts: 3 })).toBe('requeue');
  });

  it('fails a poison document at or beyond the maximum instead of looping forever', () => {
    expect(dispositionFor({ attempts: 3, maxAttempts: 3 })).toBe('fail');
    expect(dispositionFor({ attempts: 9, maxAttempts: 3 })).toBe('fail');
  });
});
