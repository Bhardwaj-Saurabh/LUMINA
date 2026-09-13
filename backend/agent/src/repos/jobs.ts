/**
 * jobs repo — ARCHITECTURE.md §4 (job state machine). The claim is a single atomic
 * findOneAndUpdate, which is what stops two workers doing the same job; nothing here
 * reads-then-writes.
 *
 * A worker killed mid-job leaves a `running` row with a stale `claimedAt`. `sweepStale`
 * is the other half of that story: it returns those rows to `pending` so the work resumes
 * instead of sitting there forever looking busy. A row that is `running` with NO claim
 * timestamp is corrupt and is swept too — never stuck.
 */
import type { Db } from 'mongodb';
import { COLLECTIONS, type JobDoc } from '@lumina/contract';

export interface JobsRepo {
  enqueue(job: JobDoc): Promise<void>;
  /** Atomically take the oldest pending job. Returns null when the queue is empty. */
  claim(workerId: string, now: number): Promise<JobDoc | null>;
  /** Merge progress into the job payload so a resumed attempt skips finished stages. */
  checkpoint(jobId: string, patch: Record<string, unknown>): Promise<void>;
  finish(jobId: string): Promise<void>;
  fail(jobId: string, error: string): Promise<void>;
  sweepStale(args: { leaseMs: number; now: number }): Promise<number>;
}

export function makeJobsRepo(db: Db): JobsRepo {
  const col = db.collection<JobDoc>(COLLECTIONS.jobs);
  return {
    async enqueue(job) {
      await col.insertOne(job);
    },

    async claim(workerId, now) {
      const claimed = await col.findOneAndUpdate(
        { status: 'pending' },
        {
          $set: { status: 'running', claimedAt: new Date(now).toISOString(), workerId },
          $inc: { attempts: 1 }
        },
        { sort: { createdAt: 1 }, returnDocument: 'after' }
      );
      return claimed ?? null;
    },

    async checkpoint(jobId, patch) {
      const set = Object.fromEntries(Object.entries(patch).map(([k, v]) => [`payload.${k}`, v]));
      await col.updateOne({ _id: jobId }, { $set: set });
    },

    async finish(jobId) {
      await col.updateOne({ _id: jobId }, { $set: { status: 'done' }, $unset: { error: '' } });
    },

    async fail(jobId, error) {
      await col.updateOne({ _id: jobId }, { $set: { status: 'failed', error } });
    },

    async sweepStale({ leaseMs, now }) {
      // ISO-8601 UTC strings compare lexicographically, so this is an index-friendly range.
      const cutoff = new Date(now - leaseMs).toISOString();
      const res = await col.updateMany(
        {
          status: 'running',
          $or: [{ claimedAt: { $lt: cutoff } }, { claimedAt: { $exists: false } }]
        },
        { $set: { status: 'pending' }, $unset: { claimedAt: '', workerId: '' } }
      );
      return res.modifiedCount;
    }
  };
}
