/**
 * The jobs worker — ARCHITECTURE.md §4. Its own PROCESS, not a background promise: a
 * 60-page pdfjs parse and a 1536-dim embedding batch are CPU work, and doing them on the
 * thread that is streaming somebody's answer is exactly what the bench's
 * `search_p95_during_ingest_ratio` measures. The agent container supervises this as a
 * child (index.ts), and `npm run worker` runs it standalone.
 *
 * Claim → work → finish, with two recovery rules that differ on purpose:
 *
 *   - a CRASH (process killed mid-job) leaves a `running` row with a stale claim; the
 *     sweeper returns it to `pending` and the work resumes. Chunk ids are deterministic,
 *     so a re-run overwrites rather than duplicating.
 *   - an ERROR (corrupt PDF, provider rejection) is final and visible: the document ends
 *     `failed` carrying the real message. Silently retrying a genuine failure is how a
 *     broken document ends up looking merely slow (rule A1).
 *
 * `attempts` still guards the crash path: a job that kills the worker every time it is
 * claimed is a poison pill, and after `workerMaxAttempts` it is failed rather than left
 * to loop forever.
 */
import { hostname } from 'node:os';
import pino from 'pino';
import { JobDoc } from '@lumina/contract';
import { env, secrets } from './env.js';
import { db } from './db.js';
import { ingestDocument, type IngestJob } from './core/rag/ingest.js';
import { dispositionFor } from './core/rag/jobState.js';
import { makeAzureOpenAiEmbeddings } from './providers/embeddings/azureOpenai.js';
import { makeDocumentParser } from './providers/parse/pdf.js';
import { makeFileBucket } from './infra/gridfs.js';
import { makeDocumentsRepo } from './repos/documents.js';
import { makeChunksRepo } from './repos/chunks.js';
import { makeJobsRepo } from './repos/jobs.js';

const log = pino({ level: env.logLevel, name: 'worker' });
const workerId = `${hostname()}:${process.pid}`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The payload the upload route wrote. Anything else is a job we cannot run. */
function toIngestJob(job: JobDoc): IngestJob {
  const p = job.payload as Partial<IngestJob>;
  const missing = (['docId', 'spaceId', 'userId', 'fileId', 'mimeType', 'title'] as const).filter(
    (k) => typeof p[k] !== 'string'
  );
  if (missing.length > 0) throw new Error(`job ${job._id}: payload is missing ${missing.join(', ')}`);
  return p as IngestJob;
}

async function main(): Promise<void> {
  const database = await db();
  const jobs = makeJobsRepo(database);
  const documents = makeDocumentsRepo(database);
  const chunks = makeChunksRepo(database);
  const files = makeFileBucket(database);
  const parse = makeDocumentParser();
  const embeddings = makeAzureOpenAiEmbeddings({
    endpoint: env.azureOpenaiEndpoint,
    apiKey: secrets.azureOpenai,
    apiVersion: env.azureOpenaiApiVersion,
    deployment: env.azureEmbeddingDeployment || env.embeddingModel
  });

  let running = true;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.info({ signal }, 'worker draining — finishing the current job, then exiting');
      running = false;
    });
  }

  log.info({ workerId, pollMs: env.workerPollMs, leaseMs: env.workerLeaseMs }, 'jobs worker up');

  let lastSweep = 0;
  while (running) {
    const now = Date.now();
    if (now - lastSweep > env.workerLeaseMs / 2) {
      lastSweep = now;
      const reclaimed = await jobs.sweepStale({ leaseMs: env.workerLeaseMs, now });
      if (reclaimed > 0) log.warn({ reclaimed }, 'returned stale running jobs to pending');
    }

    const job = await jobs.claim(workerId, now);
    if (!job) {
      await sleep(env.workerPollMs);
      continue;
    }

    const started = Date.now();
    try {
      if (dispositionFor({ attempts: job.attempts, maxAttempts: env.workerMaxAttempts }) === 'fail') {
        throw new Error(`abandoned after ${job.attempts} attempts (worker keeps dying on this job)`);
      }
      const ingest = toIngestJob(job);
      const out = await ingestDocument(ingest, {
        files,
        parse,
        embeddings,
        documents,
        chunks,
        now: Date.now,
        sleep,
        probeAttempts: env.probeAttempts,
        probeDelayMs: env.probeDelayMs,
        batchSize: env.embedBatchSize,
        chunkOptions: {
          targetChars: env.chunkTargetChars,
          overlapChars: env.chunkOverlapChars
        }
      });
      await jobs.finish(job._id);
      log.info({ jobId: job._id, ...out, ms: Date.now() - started }, 'document indexed');
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await jobs.fail(job._id, error);
      // The two failures that happen BEFORE ingestDocument runs — a poison pill and an
      // unreadable payload — would otherwise leave the document `pending` forever behind a
      // dead job: a progress bar that never moves and never explains itself. The document
      // is the surface the user watches, so it has to carry the bad news too.
      const docId = typeof job.payload.docId === 'string' ? job.payload.docId : undefined;
      if (docId) await documents.failIfUnfinished(docId, error);
      log.error({ jobId: job._id, docId, error, ms: Date.now() - started }, 'job failed');
    }
  }

  log.info('worker stopped');
  process.exit(0);
}

void main();
