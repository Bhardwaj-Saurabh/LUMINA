import { describe, expect, it } from 'vitest';
import { Locator } from '@lumina/contract';
import { chunkPages, chunkText } from './chunker.js';

/**
 * chunker — ARCHITECTURE.md §2 (RAG: "chunk with locators {page|heading|line}").
 * A locator is a promise to the reader: "this sentence is on page 4". A chunk that merges
 * two pages makes that promise a lie and the citation unverifiable, so page boundaries are
 * hard boundaries here. Locator shapes are asserted with the real contract schema.
 *
 * Defaults: targetChars 1200, overlapChars 150, minChars 80.
 */

const TARGET = 1200;
const OVERLAP = 150;

/**
 * A paragraph of at least `n` chars made of whole words, so "did it cut mid-word?" is
 * observable: any token that is not the vocabulary word came from the chunker, not the input.
 */
const words = (n: number, word = 'lumina'): string => {
  const unit = `${word} `;
  return unit.repeat(Math.ceil(n / unit.length)).trim();
};

/** A single unbroken token of `n` chars: no whitespace anywhere to split on. */
const unbroken = (n: number): string => 'x'.repeat(n);

/** Every whitespace-separated token must be a whole word from the vocabulary; a mid-word cut
 * leaves a fragment like "alph" that is not in it. Independent of where the chunk sits. */
const hasWordFragment = (chunk: string, vocabulary: readonly string[]): boolean =>
  chunk
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .some((token) => !vocabulary.includes(token));

describe('chunkPages page fidelity', () => {
  it('never merges text across a page boundary, so a {page} locator stays truthful', () => {
    const chunks = chunkPages([
      { page: 1, text: 'Alpha lives on the first page.' },
      { page: 2, text: 'Beta lives on the second page.' }
    ]);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.locator).toEqual({ page: 1 });
    expect(chunks[1]?.locator).toEqual({ page: 2 });
    expect(chunks[0]?.text).toContain('Alpha');
    expect(chunks[0]?.text).not.toContain('Beta');
    expect(chunks[1]?.text).toContain('Beta');
    expect(chunks[1]?.text).not.toContain('Alpha');
  });

  it('numbers ord contiguously from 0 across the whole document, not per page', () => {
    const chunks = chunkPages([
      { page: 1, text: words(TARGET * 2) },
      { page: 2, text: words(TARGET * 2) }
    ]);

    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.map((c) => c.ord)).toEqual(chunks.map((_, i) => i));
  });

  it('splits a page longer than targetChars into several chunks that all carry that page number', () => {
    const chunks = chunkPages([{ page: 7, text: words(TARGET * 3) }]);

    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.locator).toEqual({ page: 7 });
  });

  it('overlaps consecutive chunks of the same page so a sentence straddling the cut is still retrievable', () => {
    const chunks = chunkPages([{ page: 1, text: words(TARGET * 3) }]);

    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i + 1 < chunks.length; i += 1) {
      const previous = chunks[i]!.text;
      const next = chunks[i + 1]!.text;
      const tail = previous.slice(-Math.min(OVERLAP, previous.length));
      const sharedPrefix = next.slice(0, Math.min(OVERLAP, next.length));
      expect(tail.includes(sharedPrefix) || previous.includes(sharedPrefix)).toBe(true);
    }
  });

  it('prefers paragraph and sentence boundaries, so no chunk ends mid-word', () => {
    const vocabulary = ['alpha', 'bravo', 'charlie', 'delta'];
    const text = vocabulary.map((word) => words(500, word)).join('\n\n');
    const chunks = chunkPages([{ page: 1, text }]);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(hasWordFragment(chunk.text, vocabulary)).toBe(false);
  });

  it('hard-splits a single unbroken run rather than dropping it or emitting an oversized chunk', () => {
    const chunks = chunkPages([{ page: 1, text: unbroken(TARGET * 4) }]);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(TARGET + OVERLAP);
    expect(chunks.map((c) => c.text).join('')).toContain(unbroken(TARGET));
  });

  it('emits no chunk and consumes no ord for a whitespace-only or empty page', () => {
    const chunks = chunkPages([
      { page: 1, text: 'Real content on page one.' },
      { page: 2, text: '   \n\t  \n ' },
      { page: 3, text: '' },
      { page: 4, text: 'Real content on page four.' }
    ]);

    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.ord)).toEqual([0, 1]);
    expect(chunks.map((c) => c.locator)).toEqual([{ page: 1 }, { page: 4 }]);
  });

  it('emits only chunks with non-empty trimmed text, as ChunkDoc requires text.min(1)', () => {
    const chunks = chunkPages([
      { page: 1, text: `${words(TARGET * 2)}\n\n\n\n   \n\n` },
      { page: 2, text: '\n\n   \n\n' },
      { page: 3, text: 'short tail' }
    ]);

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(chunk.text.trim().length).toBeGreaterThan(0);
  });

  it('merges a trailing fragment shorter than minChars into the previous chunk of the same page', () => {
    const text = `${words(TARGET + 40)}\n\n${words(30, 'tail')}`;
    const chunks = chunkPages([{ page: 1, text }]);

    expect(chunks.length).toBeGreaterThan(1);
    const last = chunks[chunks.length - 1]!;
    expect(last.text.length).toBeGreaterThanOrEqual(80);
    expect(last.text).toContain('tail');
  });

  it('still emits a page whose only content is shorter than minChars, because dropping it loses the page', () => {
    const chunks = chunkPages([{ page: 5, text: 'tiny' }]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('tiny');
    expect(chunks[0]?.locator).toEqual({ page: 5 });
  });
});

describe('chunkText markdown locators', () => {
  it('tags a chunk with the most recent ATX heading and the 1-based line where the chunk starts', () => {
    const text = ['# Title', '', 'Intro line.', '', '## Methods', '', 'We did the thing.'].join('\n');
    const chunks = chunkText(text);

    const methods = chunks.find((c) => c.text.includes('We did the thing.'));
    expect(methods?.locator.heading).toBe('Methods');
    expect(methods?.locator.line).toBe(5);
  });

  it('emits a line-only locator for content that appears before any heading', () => {
    const text = ['Front matter before any heading.', '', '# Title', '', 'Under the title.'].join('\n');
    const chunks = chunkText(text);

    const front = chunks.find((c) => c.text.includes('Front matter'));
    expect(front?.locator).toEqual({ line: 1 });
    expect(front?.locator.heading).toBeUndefined();
  });

  it('starts a new chunk at every heading, so no chunk spans two headings', () => {
    const text = ['# One', '', 'body of one', '', '## Two', '', 'body of two', '', '### Three', '', 'body of three'].join(
      '\n'
    );
    const chunks = chunkText(text);

    for (const chunk of chunks) {
      const headingsInside = chunk.text.match(/^#{1,6} /gm) ?? [];
      expect(headingsInside.length).toBeLessThanOrEqual(1);
    }
    expect(chunks.map((c) => c.locator.heading)).toEqual(['One', 'Two', 'Three']);
  });

  it('numbers ord contiguously from 0 across headings', () => {
    const text = ['# One', '', words(TARGET * 2, 'alpha'), '', '## Two', '', words(TARGET * 2, 'bravo')].join('\n');
    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.map((c) => c.ord)).toEqual(chunks.map((_, i) => i));
  });
});

describe('chunker locator contract', () => {
  it('produces only locators that parse against the contract Locator schema', () => {
    const fromPages = chunkPages([
      { page: 1, text: words(TARGET * 2) },
      { page: 2, text: 'A short second page.' }
    ]);
    const fromText = chunkText(
      ['Front matter.', '', '# Title', '', words(TARGET * 2, 'alpha'), '', '## Next', '', 'tail body'].join('\n')
    );

    expect(fromPages.length + fromText.length).toBeGreaterThan(0);
    for (const chunk of [...fromPages, ...fromText]) {
      expect(Locator.safeParse(chunk.locator).success).toBe(true);
    }
  });
});
