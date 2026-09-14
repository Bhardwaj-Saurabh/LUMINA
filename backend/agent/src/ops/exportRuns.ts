/**
 * Operator CLI — ARCHITECTURE.md §8.1 step 3: pull the deployed instance's run logs out of
 * the Mongo `runs` collection into `runs/<requestId>.json`, so the trajectory gate
 * (quality/check.mjs, eval gate 3) can read what Cloud Run's tmpfs never kept.
 *
 *   node dist/ops/exportRuns.js [--since <ISO>] [--limit <n>] [--out <dir>]
 *
 * Exists because the PROVIDED scripts/export-runs.mjs writes only five fields and drops
 * `depth` — which rule R2 (a quick run must never call plan_research) needs — and that
 * script is a red line we do not edit. Every exported file is re-validated with the
 * contract's RunLog so the gate reads exactly what the agent wrote.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { COLLECTIONS, RunLog } from '@lumina/contract';
import { db } from '../db.js';

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const since = arg('--since');
const limit = Number(arg('--limit') ?? 2000);
const out = resolve(process.cwd(), arg('--out') ?? '../../runs');
mkdirSync(out, { recursive: true });

const database = await db();
const docs = await database
  .collection(COLLECTIONS.runs)
  .find(since ? { createdAt: { $gte: since } } : {}, { sort: { createdAt: -1 }, limit })
  .toArray();

let written = 0;
let invalid = 0;
for (const doc of docs) {
  const { _id, requestId, createdAt, ...rest } = doc as Record<string, unknown> & { requestId?: string };
  void _id;
  void createdAt;
  const parsed = RunLog.safeParse(rest);
  if (!parsed.success || typeof requestId !== 'string') {
    invalid += 1;
    continue;
  }
  writeFileSync(join(out, `${requestId}.json`), JSON.stringify(parsed.data, null, 2), 'utf8');
  written += 1;
}
console.log(`exported ${written} run(s) to ${out}${invalid ? ` · ${invalid} skipped as not RunLog-shaped` : ''}`);
process.exit(0);
