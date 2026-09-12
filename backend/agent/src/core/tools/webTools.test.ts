/**
 * RED — core/tools/webTools.ts (ARCHITECTURE.md §2.2 tools/webSearch.ts + tools/fetchPage.ts,
 * built as one module here): factories that turn injected ports + the per-request
 * SourceCollector into registry ToolDefs.
 *
 *   makeWebSearchTool({ search, collector })                → ToolDef 'web_search'
 *   makeFetchPageTool({ fetchPage, vet, collector, maxChars? }) → ToolDef 'fetch_page'
 *
 * Taxonomy: scripted SearchPort/FetchPagePort fakes, a recording vet fn, and the REAL
 * SourceCollector (never mock what we own). The loop JSON.stringifies whatever execute
 * returns (loop.ts:124), so "model-readable content" is pinned on the stringified result.
 */
import { describe, expect, it } from 'vitest';
import { Source } from '@lumina/contract';
import { SourceCollector } from '../sourceCollector.js';
import {
  scriptedFetchPage,
  scriptedSearch,
  type FetchedPage,
  type SearchResult
} from '../../testing/fakes.js';
import type { VettedUrl } from '../../guards/ssrf.js';
import type { ToolContext } from '../registry.js';
import { makeFetchPageTool, makeWebSearchTool } from './webTools.js';

const ctx: ToolContext = { depth: 'quick' };

/** What the loop hands the model: execute's return, stringified (loop.ts tool_results). */
const asModelContent = (result: unknown): string =>
  typeof result === 'string' ? result : JSON.stringify(result);

const RESULTS: SearchResult[] = [
  {
    url: 'https://example.com/paris',
    title: 'Paris — capital of France',
    snippet: 'Paris has been the capital of France since 987.'
  },
  {
    url: 'https://example.org/geo',
    title: 'French geography',
    snippet: 'France is administered from Paris.'
  }
];

describe('makeWebSearchTool', () => {
  it('exposes name web_search, a description, and a zod schema requiring query and reason', () => {
    const tool = makeWebSearchTool({ search: scriptedSearch([]), collector: new SourceCollector() });
    expect(tool.name).toBe('web_search');
    expect(typeof tool.description).toBe('string');
    expect(tool.description.length).toBeGreaterThan(0);

    expect(tool.schema.safeParse({}).success).toBe(false);
    expect(tool.schema.safeParse({ query: 'capital of france' }).success).toBe(false);
    expect(tool.schema.safeParse({ reason: 'need the capital' }).success).toBe(false);

    const parsed = tool.schema.parse({ query: 'capital of france', reason: 'need the capital' });
    expect(parsed).toMatchObject({ query: 'capital of france', reason: 'need the capital' });
  });

  it('executes the injected SearchPort with the query and registers every result with the collector as web sources', async () => {
    const search = scriptedSearch([RESULTS]);
    const collector = new SourceCollector();
    const tool = makeWebSearchTool({ search, collector });

    await tool.execute(
      tool.schema.parse({ query: 'capital of france', reason: 'need the capital' }),
      ctx
    );

    expect(search.calls).toHaveLength(1);
    expect(search.calls[0]!.query).toBe('capital of france');

    const sources = collector.finalize().map((s) => Source.parse(s));
    expect(sources.map((s) => s.n)).toEqual([1, 2]);
    expect(sources.map((s) => s.kind)).toEqual(['web', 'web']);
    expect(sources.map((s) => s.url)).toEqual([RESULTS[0]!.url, RESULTS[1]!.url]);
    expect(sources.map((s) => s.title)).toEqual([RESULTS[0]!.title, RESULTS[1]!.title]);
    expect(sources.map((s) => s.snippet)).toEqual([RESULTS[0]!.snippet, RESULTS[1]!.snippet]);
  });

  it('returns model-readable content carrying the assigned [n] numbers and the snippets', async () => {
    const collector = new SourceCollector();
    const tool = makeWebSearchTool({ search: scriptedSearch([RESULTS]), collector });

    const result = await tool.execute(
      tool.schema.parse({ query: 'capital of france', reason: 'need the capital' }),
      ctx
    );

    const content = asModelContent(result);
    expect(content).toContain('[1]');
    expect(content).toContain('[2]');
    expect(content).toContain(RESULTS[0]!.snippet);
    expect(content).toContain(RESULTS[1]!.snippet);
  });
});

const PAGE: FetchedPage = {
  url: 'https://example.com/paris',
  title: 'Paris — capital of France',
  text: 'Paris has been the capital of France since 987. It sits on the Seine.'
};

/** Recording vet + fetchPage sharing one order log, so before/after is provable. */
function fetchRig(opts: { page?: FetchedPage; vetRejects?: Error } = {}) {
  const order: string[] = [];
  const port = scriptedFetchPage(opts.page ? [opts.page] : []);
  const vet = async (url: string): Promise<VettedUrl> => {
    order.push(`vet:${url}`);
    if (opts.vetRejects) throw opts.vetRejects;
    return { url, address: '93.184.216.34' };
  };
  const fetchPage = {
    calls: port.calls,
    async fetchPage(url: string) {
      order.push(`fetch:${url}`);
      return port.fetchPage(url);
    }
  };
  return { order, vet, fetchPage };
}

describe('makeFetchPageTool', () => {
  it('exposes name fetch_page and a zod schema requiring url and reason', () => {
    const { vet, fetchPage } = fetchRig({ page: PAGE });
    const tool = makeFetchPageTool({ fetchPage, vet, collector: new SourceCollector() });
    expect(tool.name).toBe('fetch_page');
    expect(tool.description.length).toBeGreaterThan(0);

    expect(tool.schema.safeParse({}).success).toBe(false);
    expect(tool.schema.safeParse({ url: PAGE.url }).success).toBe(false);
    expect(tool.schema.safeParse({ reason: 'verify the claim' }).success).toBe(false);

    const parsed = tool.schema.parse({ url: PAGE.url, reason: 'verify the claim' });
    expect(parsed).toMatchObject({ url: PAGE.url, reason: 'verify the claim' });
  });

  it('vets the url through the injected vet fn before calling fetchPage', async () => {
    const { order, vet, fetchPage } = fetchRig({ page: PAGE });
    const tool = makeFetchPageTool({ fetchPage, vet, collector: new SourceCollector() });

    await tool.execute(tool.schema.parse({ url: PAGE.url, reason: 'verify the claim' }), ctx);

    expect(order).toEqual([`vet:${PAGE.url}`, `fetch:${PAGE.url}`]);
  });

  it('a vet rejection makes execute throw and fetchPage is never called', async () => {
    const { order, vet, fetchPage } = fetchRig({
      vetRejects: new Error('ssrf: private/reserved address 127.0.0.1 refused')
    });
    const tool = makeFetchPageTool({ fetchPage, vet, collector: new SourceCollector() });

    await expect(
      tool.execute(tool.schema.parse({ url: 'http://127.0.0.1/admin', reason: 'probe' }), ctx)
    ).rejects.toThrow(/ssrf/);

    expect(fetchPage.calls).toHaveLength(0);
    expect(order).toEqual(['vet:http://127.0.0.1/admin']);
  });

  it('truncates the fetched text to an explicit maxChars', async () => {
    const page: FetchedPage = { ...PAGE, text: 'B'.repeat(50) + 'TAILMARKER' };
    const { vet, fetchPage } = fetchRig({ page });
    const tool = makeFetchPageTool({
      fetchPage,
      vet,
      collector: new SourceCollector(),
      maxChars: 50
    });

    const result = await tool.execute(
      tool.schema.parse({ url: page.url, reason: 'verify' }),
      ctx
    );

    const content = asModelContent(result);
    expect(content).toContain('B'.repeat(50));
    expect(content).not.toContain('TAILMARKER');
  });

  it('defaults maxChars to 8000 when not given', async () => {
    const page: FetchedPage = { ...PAGE, text: 'A'.repeat(8000) + 'OVERFLOWTAIL' };
    const { vet, fetchPage } = fetchRig({ page });
    const tool = makeFetchPageTool({ fetchPage, vet, collector: new SourceCollector() });

    const result = await tool.execute(
      tool.schema.parse({ url: page.url, reason: 'verify' }),
      ctx
    );

    const content = asModelContent(result);
    expect(content).toContain('A'.repeat(100));
    expect(content).not.toContain('OVERFLOWTAIL');
  });

  it('wraps the page text in an untrusted framing that names the url', async () => {
    const { vet, fetchPage } = fetchRig({ page: PAGE });
    const tool = makeFetchPageTool({ fetchPage, vet, collector: new SourceCollector() });

    const result = await tool.execute(
      tool.schema.parse({ url: PAGE.url, reason: 'verify the claim' }),
      ctx
    );

    const content = asModelContent(result);
    expect(content).toContain('<untrusted_source');
    expect(content).toContain(PAGE.url);
  });

  it('registers the fetched page with the collector so its snippet can ground citations', async () => {
    const { vet, fetchPage } = fetchRig({ page: PAGE });
    const collector = new SourceCollector();
    const tool = makeFetchPageTool({ fetchPage, vet, collector });

    await tool.execute(tool.schema.parse({ url: PAGE.url, reason: 'verify the claim' }), ctx);

    const sources = collector.finalize().map((s) => Source.parse(s));
    expect(sources).toHaveLength(1);
    const src = sources[0]!;
    expect(src.kind).toBe('web');
    expect(src.url).toBe(PAGE.url);
    // The grounding check looks for the snippet inside the fetched text — it must be
    // real page material, not an invented summary.
    expect(src.snippet.length).toBeGreaterThan(0);
    expect(PAGE.text).toContain(src.snippet);
  });
});
