/**
 * ParsePort adapter — ARCHITECTURE.md §2.2 (providers/parse). PDFs go through pdfjs-dist
 * ONE PAGE AT A TIME, because the page number is the citation: a parser that concatenates
 * the document and guesses page breaks afterwards produces citations that point at the
 * wrong page, which reads exactly like a hallucination to anyone checking.
 *
 * Markdown and plain text come back as a single text blob for the heading/line chunker.
 *
 * Adapter, not core: no unit tests by the lumina-tdd taxonomy — its proof is the live
 * ingest and the bench's `pageLocator` cap.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ParsedDoc, ParsePort } from '../../core/rag/ingest.js';

const require = createRequire(import.meta.url);

/**
 * The legacy build is the one that runs on Node without a DOM. Resolved lazily so a
 * text-only deployment never pays for loading it.
 */
type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjs: PdfjsModule | undefined;

async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjs) pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as PdfjsModule;
  return pdfjs;
}

/** pdfjs warns on every page without these; they also decode the 14 standard fonts. */
const standardFontDataUrl = `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/`;

export const PDF_MIME = 'application/pdf';

export function makeDocumentParser(): ParsePort {
  return {
    async parse(bytes, mimeType): Promise<ParsedDoc> {
      if (mimeType === PDF_MIME) return parsePdf(bytes);
      return { kind: 'text', text: new TextDecoder().decode(bytes) };
    }
  };
}

async function parsePdf(bytes: Uint8Array): Promise<ParsedDoc> {
  const lib = await loadPdfjs();
  // pdfjs takes ownership of the buffer it is handed, so pass a copy: the caller's bytes
  // are still needed if the ingest retries.
  const doc = await lib.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl,
    isEvalSupported: false,
    useSystemFonts: false
  }).promise;

  try {
    const pages: Array<{ page: number; text: string }> = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      // `hasEOL` is pdfjs's own line break; without it every page collapses to one line
      // and the heading/line fallbacks downstream have nothing to work with.
      const text = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join('');
      pages.push({ page: n, text });
      page.cleanup();
    }
    return { kind: 'pages', pages };
  } finally {
    await doc.destroy();
  }
}
