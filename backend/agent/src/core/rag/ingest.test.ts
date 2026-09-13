/**
 * RED — M7 ingestion pipeline (ARCHITECTURE §4 / SPEC 5.4): GridFS read → parse → chunk →
 * embed → upsert → READ-YOUR-WRITE PROBE → indexed.
 *
 * Everything here runs on fake ports: no Mongo, no pdfjs, no network, no real clock. The
 * properties under test are the ones a passing unit suite cannot fake later — the ORDER of
 * status writes, that `indexed` is unreachable without a successful probe, that a vector
 * lands on the chunk it was computed from, and that a failure is loud (rule A1).
 */
import { describe, expect, it } from 'vitest';
import { ChunkDoc, EMBEDDING_DIMS, type DocStatus } from '@lumina/contract';
import { ingestDocument, type IngestDeps, type IngestJob, type ParsedDoc } from './ingest.js';

// --- fakes ---------------------------------------------------------------------------

/** A vector that ENCODES its input, so a mis-paired embedding is detectable. */
const vectorFor = (text: string): number[] => {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 1_000_003;
  const v = new Array<number>(EMBEDDING_DIMS).fill(0);
  v[0] = h;
  return v;
};

type Call = string;

interface Recorder {
  calls: Call[];
  statuses: Array<{ status: DocStatus; pct: number; pages?: number; chunks?: number; error?: string }>;
  upserted: unknown[];
  embedBatches: string[][];
  sleeps: number[];
  deletes: string[];
}

const PAGES: ParsedDoc = {
  kind: 'pages',
  pages: [
    { page: 1, text: 'BM25 is a lexical ranking function. The common default for k1 is 1.2.' },
    { page: 2, text: 'Dense retrieval embeds text into vectors. Cosine similarity compares direction.' }
  ]
};

const JOB: IngestJob = {
  docId: 'doc_abc',
  spaceId: 'spc_one',
  userId: 'u1',
  fileId: 'file_1',
  mimeType: 'application/pdf',
  title: 'retrieval-basics.pdf'
};

interface Scenario {
  parsed?: ParsedDoc;
  parseError?: Error;
  embedError?: Error;
  /** Probe verdicts consumed in order; the last one repeats. */
  probes?: boolean[];
  batchSize?: number;
  probeAttempts?: number;
  probeDelayMs?: number;
}

function makeDeps(s: Scenario = {}): { deps: IngestDeps; rec: Recorder } {
  const rec: Recorder = {
    calls: [],
    statuses: [],
    upserted: [],
    embedBatches: [],
    sleeps: [],
    deletes: []
  };
  const probes = [...(s.probes ?? [true])];
  const deps: IngestDeps = {
    files: {
      async read(fileId) {
        rec.calls.push(`read:${fileId}`);
        return new Uint8Array([1, 2, 3]);
      }
    },
    parse: {
      async parse() {
        rec.calls.push('parse');
        if (s.parseError) throw s.parseError;
        return s.parsed ?? PAGES;
      }
    },
    embeddings: {
      async embed(texts) {
        rec.calls.push(`embed:${texts.length}`);
        rec.embedBatches.push(texts);
        if (s.embedError) throw s.embedError;
        return texts.map(vectorFor);
      }
    },
    documents: {
      async setStatus(_docId, patch) {
        rec.calls.push(`status:${patch.status}`);
        rec.statuses.push(patch);
      }
    },
    chunks: {
      async deleteByDoc(docId) {
        rec.calls.push('deleteByDoc');
        rec.deletes.push(docId);
      },
      async upsertMany(chunks) {
        rec.calls.push(`upsert:${chunks.length}`);
        rec.upserted.push(...chunks);
      },
      async probe() {
        rec.calls.push('probe');
        return probes.length > 1 ? (probes.shift() as boolean) : (probes[0] ?? true);
      }
    },
    now: () => 1_700_000_000_000,
    async sleep(ms) {
      rec.sleeps.push(ms);
    },
    ...(s.batchSize !== undefined ? { batchSize: s.batchSize } : {}),
    ...(s.probeAttempts !== undefined ? { probeAttempts: s.probeAttempts } : {}),
    ...(s.probeDelayMs !== undefined ? { probeDelayMs: s.probeDelayMs } : {})
  };
  return { deps, rec };
}

const longPages = (count: number): ParsedDoc => ({
  kind: 'pages',
  pages: Array.from({ length: count }, (_, i) => ({
    page: i + 1,
    // Comfortably over the default 1200-char target so each page yields >= 1 chunk.
    text: `Page ${i + 1}. ${'sentence about retrieval and ranking. '.repeat(60)}`
  }))
});

// --- the pipeline --------------------------------------------------------------------

describe('ingestDocument', () => {
  it('walks the document through parsing → embedding → indexed with monotonic pct ending at 100', async () => {
    const { deps, rec } = makeDeps();
    await ingestDocument(JOB, deps);

    expect(rec.statuses.map((s) => s.status)).toEqual(['parsing', 'embedding', 'indexed']);
    const pcts = rec.statuses.map((s) => s.pct);
    expect(pcts).toEqual([...pcts].sort((a, b) => a - b));
    expect(pcts.at(-1)).toBe(100);
  });

  it('writes indexed only AFTER the read-your-write probe has come back true', async () => {
    const { deps, rec } = makeDeps();
    await ingestDocument(JOB, deps);

    expect(rec.calls).toContain('probe');
    expect(rec.calls.indexOf('probe')).toBeLessThan(rec.calls.lastIndexOf('status:indexed'));
  });

  it('fails the document when the probe never finds the chunks it just wrote', async () => {
    const { deps, rec } = makeDeps({ probes: [false], probeAttempts: 3 });

    await expect(ingestDocument(JOB, deps)).rejects.toThrow(/probe|searchable|index/i);

    expect(rec.statuses.map((s) => s.status)).not.toContain('indexed');
    const failed = rec.statuses.at(-1);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toMatch(/probe|searchable|index/i);
  });

  it('retries the probe, because an Atlas Search index is eventually consistent', async () => {
    const { deps, rec } = makeDeps({ probes: [false, false, true], probeDelayMs: 250 });

    await ingestDocument(JOB, deps);

    expect(rec.calls.filter((c) => c === 'probe')).toHaveLength(3);
    expect(rec.sleeps).toEqual([250, 250]);
    expect(rec.statuses.at(-1)?.status).toBe('indexed');
  });

  it('writes chunks the contract accepts, with contiguous ord and truthful page locators', async () => {
    const { deps, rec } = makeDeps();
    await ingestDocument(JOB, deps);

    expect(rec.upserted.length).toBeGreaterThan(0);
    const parsed = rec.upserted.map((c) => ChunkDoc.parse(c));
    expect(parsed.map((c) => c.ord)).toEqual(parsed.map((_, i) => i));
    for (const chunk of parsed) {
      expect(chunk.docId).toBe(JOB.docId);
      expect(chunk.spaceId).toBe(JOB.spaceId);
      expect(chunk.userId).toBe(JOB.userId);
      expect(chunk.text.trim().length).toBeGreaterThan(0);
      expect(chunk.embedding).toHaveLength(EMBEDDING_DIMS);
      expect(chunk.locator.page).toBeGreaterThan(0);
    }
    // A page-1 chunk must never carry page 2's number — that is a wrong citation.
    const first = parsed[0]!;
    expect(first.locator.page).toBe(1);
    expect(first.text).toContain('BM25');
  });

  it('gives each chunk a deterministic id, so a re-run after a crash overwrites instead of duplicating', async () => {
    const a = makeDeps();
    await ingestDocument(JOB, a.deps);
    const b = makeDeps();
    await ingestDocument(JOB, b.deps);

    const ids = (r: Recorder) => r.upserted.map((c) => ChunkDoc.parse(c)._id);
    expect(ids(b.rec)).toEqual(ids(a.rec));
    expect(new Set(ids(a.rec)).size).toBe(ids(a.rec).length);
  });

  it('clears the document old chunks before writing new ones, so a shorter re-upload leaves no orphans', async () => {
    const { deps, rec } = makeDeps();
    await ingestDocument(JOB, deps);

    const firstUpsert = rec.calls.findIndex((c) => c.startsWith('upsert:'));
    expect(rec.deletes).toEqual([JOB.docId]);
    expect(rec.calls.indexOf('deleteByDoc')).toBeLessThan(firstUpsert);
  });

  it('embeds in batches and lands every vector on the chunk it was computed from', async () => {
    const { deps, rec } = makeDeps({ parsed: longPages(10), batchSize: 4 });
    await ingestDocument(JOB, deps);

    const chunks = rec.upserted.map((c) => ChunkDoc.parse(c));
    expect(chunks.length).toBeGreaterThan(4);
    expect(rec.embedBatches.length).toBe(Math.ceil(chunks.length / 4));
    for (const batch of rec.embedBatches) expect(batch.length).toBeLessThanOrEqual(4);
    // The pairing check: a shuffled batch response would silently destroy recall.
    for (const chunk of chunks) expect(chunk.embedding[0]).toBe(vectorFor(chunk.text)[0]);
  });

  it('records the real page and chunk counts on the document', async () => {
    const { deps, rec } = makeDeps({ parsed: longPages(3) });
    await ingestDocument(JOB, deps);

    const written = rec.upserted.length;
    const indexed = rec.statuses.at(-1)!;
    expect(indexed.pages).toBe(3);
    expect(indexed.chunks).toBe(written);
  });

  it('fails loud when the embeddings provider throws: document failed, promise rejected, nothing indexed', async () => {
    const { deps, rec } = makeDeps({ embedError: new Error('azure 429 rate limited') });

    await expect(ingestDocument(JOB, deps)).rejects.toThrow('azure 429 rate limited');

    const last = rec.statuses.at(-1)!;
    expect(last.status).toBe('failed');
    expect(last.error).toContain('azure 429 rate limited');
    expect(rec.statuses.map((s) => s.status)).not.toContain('indexed');
  });

  it('fails a document with no extractable text instead of indexing zero chunks', async () => {
    const { deps, rec } = makeDeps({ parsed: { kind: 'pages', pages: [{ page: 1, text: '   \n  ' }] } });

    await expect(ingestDocument(JOB, deps)).rejects.toThrow(/text/i);

    expect(rec.upserted).toHaveLength(0);
    expect(rec.statuses.at(-1)?.status).toBe('failed');
  });

  it('fails loud when the parse throws', async () => {
    const { deps, rec } = makeDeps({ parseError: new Error('not a PDF') });

    await expect(ingestDocument(JOB, deps)).rejects.toThrow('not a PDF');
    expect(rec.statuses.at(-1)?.status).toBe('failed');
    expect(rec.statuses.at(-1)?.error).toContain('not a PDF');
  });

  it('ingests markdown through the text chunker, carrying heading and line locators', async () => {
    const { deps, rec } = makeDeps({
      parsed: {
        kind: 'text',
        text: '# Chunking\n\nChunks need locators.\n\n## Overlap\n\nOverlap keeps straddling sentences retrievable.\n'
      }
    });
    await ingestDocument({ ...JOB, mimeType: 'text/markdown', title: 'notes.md' }, deps);

    const chunks = rec.upserted.map((c) => ChunkDoc.parse(c));
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.locator.page).toBeUndefined();
      expect(chunk.locator.line).toBeGreaterThan(0);
    }
    expect(chunks.map((c) => c.locator.heading)).toContain('Chunking');
    expect(rec.statuses.at(-1)?.pages).toBeUndefined();
  });

  it('returns the counts it actually wrote', async () => {
    const { deps, rec } = makeDeps({ parsed: longPages(4) });
    const out = await ingestDocument(JOB, deps);

    expect(out.chunks).toBe(rec.upserted.length);
    expect(out.pages).toBe(4);
  });
});
