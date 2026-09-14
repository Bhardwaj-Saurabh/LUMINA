/**
 * The published evals report — ARCHITECTURE.md §8.1. `GET /evals/report.json` is a READ of
 * the active artifact, never a computation: the report is built offline from the deployed
 * run's evidence (bench, quality, gates, run logs, DESIGN.md), validated against the
 * contract's EvalsReport, and published by an operator CLI (ops/publishReport.ts) as an
 * immutable version. No public HTTP write path exists.
 *
 * Versions are kept; exactly one is `active`. The ETag is the sha256 of the JSON text, so a
 * republish with identical content is a no-op to caches and a different one is not.
 */
import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';

/** Our own collection, not in the contract's COLLECTIONS: the report is an operator artifact. */
export const REPORTS_COLLECTION = 'evalsReports';

export interface PublishedReport {
  json: unknown;
  etag: string;
  publishedAt: string;
}

interface ReportDoc {
  _id: string;
  json: unknown;
  etag: string;
  publishedAt: string;
  active: boolean;
  /** Where the evidence came from, for the operator's own audit trail. */
  source: { benchRanAt?: string; target?: string };
}

export interface ReportsRepo {
  /** The active report, or null when nothing has been published. */
  get(): Promise<PublishedReport | null>;
  /** Publish a new version and make it the only active one. Returns its etag. */
  publish(json: unknown, source: ReportDoc['source'], now?: () => number): Promise<string>;
}

export const etagOf = (json: unknown): string =>
  createHash('sha256').update(JSON.stringify(json)).digest('hex').slice(0, 32);

export function makeReportsRepo(db: Db): ReportsRepo {
  const col = db.collection<ReportDoc>(REPORTS_COLLECTION);
  return {
    async get() {
      const doc = await col.findOne({ active: true }, { sort: { publishedAt: -1 } });
      return doc ? { json: doc.json, etag: doc.etag, publishedAt: doc.publishedAt } : null;
    },

    async publish(json, source, now = Date.now) {
      const etag = etagOf(json);
      const publishedAt = new Date(now()).toISOString();
      // Deactivate first, then insert: a reader in between sees "unpublished" for a moment,
      // never two active reports.
      await col.updateMany({ active: true }, { $set: { active: false } });
      await col.insertOne({ _id: `rpt_${publishedAt}_${etag.slice(0, 8)}`, json, etag, publishedAt, active: true, source });
      return etag;
    }
  };
}
