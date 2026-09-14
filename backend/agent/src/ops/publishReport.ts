/**
 * Operator CLI — ARCHITECTURE.md §8.1 step 6-7: publish the evals report built by
 * `node eval/build-report.mjs` so the deployed agent serves it at GET /evals/report.json.
 *
 *   node dist/ops/publishReport.js [path/to/report.json]     (default ../../reports/report.json)
 *
 * The file is validated against the contract's EvalsReport BEFORE it is stored: a report
 * that does not parse is refused here, not discovered by the grader's browser. Publication
 * is an operator action with Mongo credentials; there is no HTTP write path.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EvalsReport } from '@lumina/contract';
import { env } from '../env.js';
import { db } from '../db.js';
import { makeReportsRepo } from '../repos/reports.js';

const path = resolve(process.cwd(), process.argv[2] ?? '../../reports/report.json');
const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
const parsed = EvalsReport.safeParse(raw);
if (!parsed.success) {
  console.error(`refusing to publish ${path}: it is not a valid EvalsReport\n${parsed.error.message}`);
  process.exit(2);
}
const report = parsed.data as unknown as Record<string, unknown>;
const database = await db();
const etag = await makeReportsRepo(database).publish(parsed.data, {
  ...(typeof report.ranAt === 'string' ? { benchRanAt: report.ranAt } : {}),
  ...(typeof report.target === 'string' ? { target: report.target } : {})
});
console.log(`published ${path} to ${env.mongoDb} as the active evals report (etag ${etag})`);
process.exit(0);
