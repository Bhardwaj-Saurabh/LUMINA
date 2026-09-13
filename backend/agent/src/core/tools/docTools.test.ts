/**
 * RED — M7 `search_documents` (SPEC 5.4 / bench caps `pageLocator`, `routerPicksDocs`).
 *
 * Two properties are structural rather than prompt-level, exactly as in memoryTools:
 *   - `spaceId` comes from the injected request scope; the schema strips a model-supplied one,
 *     so no prompt injection can read another Space.
 *   - doc sources are minted ONLY through the per-request SourceCollector, so every [n] in
 *     the answer resolves to a chunk retrieved in THIS request.
 */
import { describe, expect, it } from 'vitest';
import { SourcesEvent } from '@lumina/contract';
import { SourceCollector } from '../sourceCollector.js';
import { ToolRegistry } from '../registry.js';
import type { RetrievedChunk } from '../rag/retrieve.js';
import { makeSearchDocumentsTool } from './docTools.js';

const CTX = { depth: 'quick' };

const chunk = (over: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
  chunkId: 'c1',
  docId: 'doc_1',
  title: 'retrieval-basics.pdf',
  text: 'BM25 has two parameters. The common default is 1.2 for k1 and 0.75 for b.',
  locator: { page: 1 },
  ord: 0,
  score: 0.9,
  ...over
});

function setup(chunks: RetrievedChunk[]) {
  const collector = new SourceCollector();
  const queries: string[] = [];
  const tool = makeSearchDocumentsTool({
    retrieve: async (q: string) => {
      queries.push(q);
      return chunks;
    },
    collector,
    spaceId: 'spc_mine'
  });
  return { tool, collector, queries };
}

describe('search_documents', () => {
  it('mints a contract-valid doc source per retrieved chunk and hands the model its [n]', async () => {
    const { tool, collector } = setup([
      chunk(),
      chunk({ chunkId: 'c2', ord: 1, locator: { page: 2 }, text: 'Dense retrieval embeds meaning.' })
    ]);

    const out = (await tool.execute(
      { query: 'bm25 defaults', reason: 'the Space covers retrieval' },
      CTX
    )) as { results: Array<{ citation: string; title: string; locator: unknown; text: string }> };

    expect(out.results.map((r) => r.citation)).toEqual(['[1]', '[2]']);

    const sources = SourcesEvent.parse(collector.finalize());
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.n)).toEqual([1, 2]);
    for (const source of sources) {
      expect(source.kind).toBe('doc');
      expect(source.docId).toBe('doc_1');
      expect(source.title).toBe('retrieval-basics.pdf');
    }
    // The page locator is what makes a citation render as "file.pdf, p. 2".
    expect(sources[1]?.locator).toEqual({ page: 2 });
  });

  it('uses the chunk text verbatim as the snippet, because the grader looks for its anchor inside it', async () => {
    const text = 'The common default is 1.2 for k1. ' + 'Length normalization matters. '.repeat(20);
    const { tool, collector } = setup([chunk({ text })]);

    await tool.execute({ query: 'k1 default', reason: 'gold question' }, CTX);

    const [source] = collector.finalize();
    expect(source?.snippet).toBe(text);
    expect(source?.snippet).toContain('The common default is 1.2');
  });

  it('ignores a model-supplied spaceId: the Space comes from the request, never the prompt', async () => {
    const { tool, queries } = setup([chunk()]);

    const parsed = tool.schema.parse({
      query: 'secrets',
      reason: 'probing',
      spaceId: 'spc_someone_else'
    }) as Record<string, unknown>;
    expect(parsed.spaceId).toBeUndefined();

    await tool.execute(parsed, CTX);
    expect(queries).toEqual(['secrets']);
  });

  it('dedupes chunks that share a docId and locator, keeping the numbering contiguous', async () => {
    const { tool, collector } = setup([
      chunk({ chunkId: 'c1', locator: { page: 3 } }),
      chunk({ chunkId: 'c2', ord: 1, locator: { page: 3 } }),
      chunk({ chunkId: 'c3', ord: 2, locator: { page: 4 } })
    ]);

    await tool.execute({ query: 'q', reason: 'r' }, CTX);

    const sources = collector.finalize();
    expect(sources.map((s) => s.n)).toEqual([1, 2]);
    expect(sources.map((s) => s.locator)).toEqual([{ page: 3 }, { page: 4 }]);
  });

  it('mints nothing when the Space has no match, so the answer has to say it found nothing', async () => {
    const { tool, collector } = setup([]);

    const out = (await tool.execute({ query: 'unrelated', reason: 'checking' }, CTX)) as {
      results: unknown[];
    };

    expect(out.results).toEqual([]);
    expect(collector.finalize()).toEqual([]);
  });

  it('is available in the quick gear — RAG is not a deep-only capability', () => {
    const { tool } = setup([]);
    const registry = new ToolRegistry();
    registry.register(tool);

    expect(registry.forDepth('quick').map((t) => t.name)).toContain('search_documents');
  });
});
