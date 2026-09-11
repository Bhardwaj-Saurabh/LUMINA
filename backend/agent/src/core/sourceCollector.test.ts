import { describe, expect, it } from 'vitest';
import { Source, SourcesEvent } from '@lumina/contract';
import { SourceCollector } from './sourceCollector.js';

/**
 * SourceCollector — ARCHITECTURE.md §2 ("the ONLY mint for sources") and §5 guardrail 5:
 * per-request registry of retrieved material; dedupe by normalized URL / docId+locator;
 * contiguous unique numbering from 1; frozen after finalize. Shapes are asserted with the
 * real contract schemas, not hand-matched fields.
 */

const web = (url: string, extra: Record<string, unknown> = {}) => ({
  kind: 'web' as const,
  url,
  title: 'Example page',
  snippet: 'a passage the claim rests on',
  ...extra
});

describe('SourceCollector registration', () => {
  it('returns a provisional source with a positive citation number for a web result', () => {
    const collector = new SourceCollector();
    const provisional = collector.register(web('https://example.com/a'));
    expect(provisional.n).toBe(1);
  });

  it('finalizes exactly the registered material — nothing more, nothing less', () => {
    const collector = new SourceCollector();
    collector.register(web('https://example.com/a'));
    collector.register(web('https://example.org/b', { title: 'Other page' }));
    const sources = collector.finalize();
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.url).sort()).toEqual([
      'https://example.com/a',
      'https://example.org/b'
    ]);
  });
});

describe('SourceCollector URL dedupe', () => {
  it('gives the same n to the same URL registered twice', () => {
    const collector = new SourceCollector();
    const first = collector.register(web('https://example.com/a'));
    const again = collector.register(web('https://example.com/a'));
    expect(again.n).toBe(first.n);
    expect(collector.finalize()).toHaveLength(1);
  });

  it('treats a URL as the same source when only the fragment differs', () => {
    const collector = new SourceCollector();
    const first = collector.register(web('https://example.com/a'));
    const again = collector.register(web('https://example.com/a#section-3'));
    expect(again.n).toBe(first.n);
  });

  it('treats a URL as the same source when only utm_* tracking params differ', () => {
    const collector = new SourceCollector();
    const first = collector.register(web('https://example.com/a?x=1'));
    const again = collector.register(
      web('https://example.com/a?utm_source=tw&utm_medium=social&x=1')
    );
    expect(again.n).toBe(first.n);
  });

  it('keeps genuinely different query strings as different sources', () => {
    const collector = new SourceCollector();
    const first = collector.register(web('https://example.com/a?page=1'));
    const second = collector.register(web('https://example.com/a?page=2'));
    expect(second.n).not.toBe(first.n);
    expect(collector.finalize()).toHaveLength(2);
  });
});

describe('SourceCollector document sources', () => {
  it('registers a doc result and preserves its locator through finalize', () => {
    const collector = new SourceCollector();
    collector.register({
      kind: 'doc',
      docId: 'doc_abc123',
      title: 'quarterly-report.pdf',
      snippet: 'revenue grew 12% year over year',
      locator: { page: 7 }
    });
    const sources = collector.finalize();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.kind).toBe('doc');
    expect(sources[0]!.docId).toBe('doc_abc123');
    expect(sources[0]!.locator).toEqual({ page: 7 });
  });
});

describe('SourceCollector finalize', () => {
  it('emits contiguous unique numbering from 1 even after duplicate registrations', () => {
    const collector = new SourceCollector();
    collector.register(web('https://example.com/a'));
    collector.register(web('https://example.org/b', { title: 'B' }));
    collector.register(web('https://example.com/a')); // duplicate
    collector.register({
      kind: 'doc',
      docId: 'doc_abc123',
      title: 'notes.pdf',
      snippet: 'a passage',
      locator: { page: 2 }
    });
    const ns = collector.finalize().map((s) => s.n);
    expect(ns).toEqual([1, 2, 3]);
  });

  it('emits sources that all parse with the contract Source schema (web needs url, doc needs docId)', () => {
    const collector = new SourceCollector();
    collector.register(web('https://example.com/a'));
    collector.register({
      kind: 'doc',
      docId: 'doc_abc123',
      title: 'notes.pdf',
      snippet: 'a passage',
      locator: { heading: 'Findings' }
    });
    const sources = collector.finalize();
    expect(SourcesEvent.safeParse(sources).success).toBe(true);
    for (const source of sources) {
      expect(Source.safeParse(source).success).toBe(true);
    }
  });

  it('finalizes empty retrieval to a contract-valid empty list and still freezes', () => {
    const collector = new SourceCollector();
    const sources = collector.finalize();
    // "Empty retrieval → cite nothing" is a graded Must: [] is a legitimate outcome,
    // so finalize() must not promise a non-empty result at the type level either.
    expect(sources).toEqual([]);
    expect(SourcesEvent.safeParse(sources).success).toBe(true);
    expect(() => collector.register(web('https://example.com/late'))).toThrow();
  });

  it('is frozen after finalize: a further register() throws', () => {
    const collector = new SourceCollector();
    collector.register(web('https://example.com/a'));
    collector.finalize();
    expect(() => collector.register(web('https://example.org/late'))).toThrow();
  });
});

describe('SourceCollector subQuestion tagging (deep search)', () => {
  it('carries the subQuestion tag through to the finalized source', () => {
    const collector = new SourceCollector();
    collector.register(web('https://example.com/a'), { subQuestion: 2 });
    const sources = collector.finalize();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.subQuestion).toBe(2);
    expect(Source.safeParse(sources[0]).success).toBe(true);
  });

  it('keeps one deterministic subQuestion when two sub-questions find the same URL: first registrant wins', () => {
    const collector = new SourceCollector();
    collector.register(web('https://example.com/shared'), { subQuestion: 1 });
    collector.register(web('https://example.com/shared'), { subQuestion: 3 });
    const sources = collector.finalize();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.subQuestion).toBe(1);
  });
});
