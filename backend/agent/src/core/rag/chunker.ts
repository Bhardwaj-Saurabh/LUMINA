/**
 * Chunker — ARCHITECTURE.md §2 (RAG: "chunk with locators {page|heading|line}").
 * A locator is a promise to the reader ("this sentence is on page 4"), so a page is a hard
 * boundary: chunks are never merged across pages, and every cut lands on a paragraph, a
 * sentence end or — at worst — a word boundary.
 */
import type { Locator } from '@lumina/contract';

export interface Chunk {
  text: string;
  locator: Locator;
  ord: number;
}

export interface PageText {
  page: number;
  text: string;
}

export interface ChunkerOptions {
  targetChars?: number;
  overlapChars?: number;
  minChars?: number;
}

interface Settings {
  targetChars: number;
  overlapChars: number;
  minChars: number;
}

const DEFAULTS: Settings = { targetChars: 1200, overlapChars: 150, minChars: 80 };

const settle = (options?: ChunkerOptions): Settings => ({ ...DEFAULTS, ...options });

const HEADING = /^(#{1,6})\s+(.*)$/;

interface Piece {
  text: string;
  /** Offset of the piece's own body inside the block, ignoring carried overlap. */
  offset: number;
}

export function chunkPages(pages: readonly PageText[], options?: ChunkerOptions): Chunk[] {
  const settings = settle(options);
  const chunks: Chunk[] = [];
  for (const page of pages) {
    for (const piece of splitBlock(page.text, settings)) {
      chunks.push({ text: piece.text, locator: { page: page.page }, ord: chunks.length });
    }
  }
  return chunks;
}

export function chunkText(text: string, options?: ChunkerOptions): Chunk[] {
  const settings = settle(options);
  const chunks: Chunk[] = [];
  for (const section of sections(text)) {
    for (const piece of splitBlock(section.text, settings)) {
      const line = lineAt(text, section.offset + piece.offset);
      chunks.push({
        text: piece.text,
        locator: section.heading === undefined ? { line } : { heading: section.heading, line },
        ord: chunks.length
      });
    }
  }
  return chunks;
}

interface Section {
  offset: number;
  heading?: string;
  text: string;
}

/** A heading always opens a section, so no chunk spans two headings. */
function sections(text: string): Section[] {
  const lines = text.split('\n');
  const out: Section[] = [];
  let current: Section = { offset: 0, text: '' };
  let offset = 0;
  for (const line of lines) {
    const match = HEADING.exec(line);
    if (match) {
      if (current.text.trim().length > 0) out.push(current);
      current = { offset, heading: (match[2] ?? '').trim(), text: '' };
    }
    current.text += `${line}\n`;
    offset += line.length + 1;
  }
  if (current.text.trim().length > 0) out.push(current);
  return out;
}

const lineAt = (text: string, offset: number): number => {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
};

/**
 * Splits one block (a page, or a markdown section) into overlapping pieces. The carried
 * overlap is a contiguous tail of the previous piece, so a sentence straddling a cut is
 * retrievable from either side.
 */
function splitBlock(block: string, s: Settings): Piece[] {
  const pieces: Piece[] = [];
  let carry = '';
  let p = 0;
  while (p < block.length) {
    while (p < block.length && isSpace(block[p])) p += 1;
    if (p >= block.length) break;
    const rest = block.slice(p);
    // Budget shrinks by whatever the word-snapped carry cost above overlapChars (plus the
    // joining space), keeping every piece within targetChars + overlapChars.
    const separator = carry ? 1 : 0;
    const budget = Math.max(1, s.targetChars - Math.max(0, carry.length - s.overlapChars) - separator);
    const cut = rest.length <= budget ? rest.length : cutPoint(rest, budget, s.minChars);
    const body = rest.slice(0, cut).trimEnd();
    if (body.length === 0) break;
    const text = carry ? `${carry} ${body}` : body;
    const last = pieces[pieces.length - 1];
    if (cut === rest.length && text.length < s.minChars && last) {
      // A trailing fragment belongs to the previous piece of the SAME block; `carry` is
      // already that piece's tail, so only the new body is appended.
      last.text = `${last.text} ${body}`;
    } else {
      pieces.push({ text, offset: p });
    }
    carry = overlapTail(text, s.overlapChars);
    p += cut;
  }
  return pieces;
}

/** Paragraph > sentence end > word boundary > hard split (an unbroken run leaves no choice). */
function cutPoint(rest: string, budget: number, minChars: number): number {
  const window = rest.slice(0, budget);
  const floor = Math.max(minChars, Math.floor(budget / 2));

  const paragraph = lastMatch(window, /\n[ \t]*\n/g);
  if (paragraph !== undefined && paragraph.index >= floor) return paragraph.index;

  const sentence = lastMatch(window, /[.!?]["')\]]?(?=\s)/g);
  if (sentence !== undefined && sentence.end >= floor) return sentence.end;

  if (isSpace(rest[budget])) return budget;
  for (let i = window.length - 1; i >= floor; i -= 1) if (isSpace(window[i])) return i;
  return budget;
}

function lastMatch(text: string, pattern: RegExp): { index: number; end: number } | undefined {
  let found: { index: number; end: number } | undefined;
  for (const match of text.matchAll(pattern)) {
    found = { index: match.index, end: match.index + match[0].length };
  }
  return found;
}

/** At least overlapChars, snapped left to a word start so no half-word is carried. */
function overlapTail(text: string, overlapChars: number): string {
  if (text.length <= overlapChars) return text;
  const from = text.length - overlapChars;
  const floor = Math.max(0, from - overlapChars);
  let start = from;
  while (start > floor && !isSpace(text[start - 1])) start -= 1;
  if (start === floor && !isSpace(text[start - 1] ?? ' ')) start = from;
  return text.slice(start);
}

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);
