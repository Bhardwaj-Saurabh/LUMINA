/**
 * Ingestion pipeline — ARCHITECTURE.md §4 / SPEC 5.4: GridFS read → parse → chunk → embed →
 * upsert → READ-YOUR-WRITE PROBE → indexed. `indexed` is unreachable without a probe that
 * found the chunks we just wrote (Atlas Search is eventually consistent, so "upserted" is not
 * "searchable"). Every failure writes `failed` with the real message and RETHROWS, so the
 * worker can mark the job row — never a quiet half-indexed document (rule A1).
 */
import type { ChunkDoc, DocStatus } from '@lumina/contract';
import type { EmbeddingsPort } from '../../providers/embeddings/port.js';
import {
  chunkPages,
  chunkText,
  type Chunk,
  type ChunkerOptions,
  type PageText
} from './chunker.js';
import { pctFor } from './jobState.js';

export type ParsedDoc =
  | { kind: 'pages'; pages: PageText[] }
  | { kind: 'text'; text: string };

export interface IngestJob {
  docId: string;
  spaceId: string;
  userId: string;
  fileId: string;
  mimeType: string;
  title: string;
}

export interface DocStatusPatch {
  status: DocStatus;
  pct: number;
  pages?: number;
  chunks?: number;
  error?: string;
}

/** The narrow ports ingestion needs; the adapters live in infra/, providers/ and repos/. */
export interface FileStore {
  read(fileId: string): Promise<Uint8Array>;
}

export interface ParsePort {
  parse(bytes: Uint8Array, mimeType: string): Promise<ParsedDoc>;
}

export interface DocumentsStore {
  setStatus(docId: string, patch: DocStatusPatch): Promise<void>;
}

export interface ChunksStore {
  deleteByDoc(docId: string): Promise<void>;
  upsertMany(chunks: ChunkDoc[]): Promise<void>;
  probe(args: {
    docId: string;
    spaceId: string;
    userId: string;
    vector: number[];
  }): Promise<boolean>;
}

export interface IngestDeps {
  files: FileStore;
  parse: ParsePort;
  embeddings: EmbeddingsPort;
  documents: DocumentsStore;
  chunks: ChunksStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  batchSize?: number;
  probeAttempts?: number;
  probeDelayMs?: number;
  /** Chunk size/overlap come from env, not constants: retuning recall is a config change. */
  chunkOptions?: ChunkerOptions;
}

export interface IngestResult {
  chunks: number;
  pages?: number;
}

const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_PROBE_ATTEMPTS = 10;
const DEFAULT_PROBE_DELAY_MS = 1500;

export async function ingestDocument(job: IngestJob, deps: IngestDeps): Promise<IngestResult> {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const probeAttempts = deps.probeAttempts ?? DEFAULT_PROBE_ATTEMPTS;
  const probeDelayMs = deps.probeDelayMs ?? DEFAULT_PROBE_DELAY_MS;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Carried into the failure path so `failed` keeps the progress actually reached.
  let pct = pctFor('parsing');

  try {
    await deps.documents.setStatus(job.docId, { status: 'parsing', pct });

    const bytes = await deps.files.read(job.fileId);
    const parsed = await deps.parse.parse(bytes, job.mimeType);
    const pieces =
      parsed.kind === 'pages'
        ? chunkPages(parsed.pages, deps.chunkOptions)
        : chunkText(parsed.text, deps.chunkOptions);
    const pages = parsed.kind === 'pages' ? parsed.pages.length : undefined;
    if (pieces.length === 0) {
      throw new Error(`ingest: no extractable text in "${job.title}"`);
    }

    // Before the first write: a shorter re-upload must not leave orphan chunks behind.
    await deps.chunks.deleteByDoc(job.docId);

    let probeVector: number[] | undefined;
    for (let start = 0; start < pieces.length; start += batchSize) {
      const batch = pieces.slice(start, start + batchSize);
      const vectors = await deps.embeddings.embed(batch.map((piece) => piece.text));
      const docs = batch.map((piece, i) => {
        const embedding = vectors[i];
        if (!embedding) {
          throw new Error(
            `ingest: embeddings returned ${vectors.length} vectors for ${batch.length} chunks`
          );
        }
        return toChunkDoc(job, piece, embedding, now);
      });
      await deps.chunks.upsertMany(docs);
      probeVector ??= docs[0]?.embedding;
      pct = pctFor('embedding', (start + batch.length) / pieces.length);
      await deps.documents.setStatus(job.docId, { status: 'embedding', pct });
    }

    await probeUntilSearchable({
      job,
      deps,
      vector: probeVector ?? [],
      attempts: probeAttempts,
      delayMs: probeDelayMs,
      sleep
    });

    pct = pctFor('indexed');
    await deps.documents.setStatus(job.docId, {
      status: 'indexed',
      pct,
      ...(pages === undefined ? {} : { pages }),
      chunks: pieces.length
    });
    return pages === undefined ? { chunks: pieces.length } : { chunks: pieces.length, pages };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.documents.setStatus(job.docId, { status: 'failed', pct, error: message });
    throw error;
  }
}

/** Deterministic id: a re-run after a crash overwrites its own chunks instead of duplicating. */
const toChunkDoc = (
  job: IngestJob,
  piece: Chunk,
  embedding: number[],
  now: () => number
): ChunkDoc => ({
  _id: `${job.docId}:${piece.ord}`,
  docId: job.docId,
  spaceId: job.spaceId,
  userId: job.userId,
  text: piece.text,
  locator: piece.locator,
  ord: piece.ord,
  embedding,
  createdAt: new Date(now()).toISOString()
});

/** The chunks are probed with a vector we just wrote, so a hit proves the index is queryable. */
async function probeUntilSearchable(args: {
  job: IngestJob;
  deps: IngestDeps;
  vector: number[];
  attempts: number;
  delayMs: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<void> {
  for (let attempt = 1; attempt <= args.attempts; attempt += 1) {
    if (attempt > 1) await args.sleep(args.delayMs);
    const found = await args.deps.chunks.probe({
      docId: args.job.docId,
      spaceId: args.job.spaceId,
      userId: args.job.userId,
      vector: args.vector
    });
    if (found) return;
  }
  throw new Error(
    `ingest: probe found no searchable chunk for ${args.job.docId} after ${args.attempts} attempts; the vector index is not queryable`
  );
}
