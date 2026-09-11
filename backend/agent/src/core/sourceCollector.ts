/**
 * SourceCollector — ARCHITECTURE.md §2: per-request registry of retrieved material,
 * the ONLY mint for sources. Dedupe by normalized URL / docId+locator; contiguous
 * unique numbering from 1; frozen after finalize (§3.1 grounding boundary).
 */
import type { Locator, Source } from '@lumina/contract';

export type SourceMaterial =
  | { kind: 'web'; url: string; title: string; snippet: string }
  | { kind: 'doc'; docId: string; title: string; snippet: string; locator: Locator };

export interface RegisterOpts {
  subQuestion?: number;
}

/** Strip fragment and utm_* tracking params; other query params stay significant. */
function normalizeUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('utm_')) url.searchParams.delete(key);
  }
  return url.toString();
}

export class SourceCollector {
  private readonly byKey = new Map<string, Source>();
  private finalized = false;

  /** Returns the provisional source; a duplicate returns the first registration (its subQuestion wins). */
  register(material: SourceMaterial, opts: RegisterOpts = {}): Source {
    if (this.finalized) throw new Error('SourceCollector is frozen: finalize() already ran');
    const key =
      material.kind === 'web'
        ? `web:${normalizeUrl(material.url)}`
        : `doc:${material.docId}:${JSON.stringify(material.locator)}`;
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const source: Source = {
      n: this.byKey.size + 1,
      kind: material.kind,
      title: material.title,
      snippet: material.snippet,
      ...(material.kind === 'web'
        ? { url: material.url }
        : { docId: material.docId, locator: material.locator }),
      ...(opts.subQuestion !== undefined ? { subQuestion: opts.subQuestion } : {})
    };
    this.byKey.set(key, source);
    return source;
  }

  /**
   * Freezes the registry and returns the contiguous 1-based source list. May be empty:
   * a request that retrieved nothing finalizes to [] and the answer must cite nothing.
   */
  finalize(): Source[] {
    this.finalized = true;
    return [...this.byKey.values()];
  }
}
