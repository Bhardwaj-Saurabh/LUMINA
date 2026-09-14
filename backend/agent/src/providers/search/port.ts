/**
 * SearchPort + FetchPagePort — ARCHITECTURE.md §2.2 (providers/search/port.ts). Types
 * only; the Tavily/SerpApi adapters are the sole SDK importers. Extraction is folded
 * into the search provider, so the fetch-page port lives here too.
 */

export interface SearchResult {
  url: string;
  title: string;
  /** Short, verbatim, what the citation shows and what grounding substring-matches. */
  snippet: string;
  /**
   * The provider's fuller extract when it has one (Tavily basic returns ~1300 chars). Shown
   * to the MODEL, never on the source: measured live, a model that only sees a 500-char
   * snippet reaches for fetch_page a third to half of the time — an extra ~1 s LLM round trip
   * plus the fetch — to read text the provider had already handed us.
   */
  content?: string;
}

/**
 * How broadly to search. The two gears differ here, not only in how many questions they ask:
 * quick takes the provider's cheap, narrow shape; deep pays for more results and the
 * provider's own deeper crawl. Measured need — with both gears searching identically, one
 * deep answer reached only 1.69x the sources of the same query run quick (bench 2026-09-14,
 * cap 2x), because "deeper" was doing all its work through fan-out alone.
 */
export interface SearchOptions {
  maxResults?: number;
  depth?: 'basic' | 'advanced';
}

/** The quick gear's shape, and the default for any caller that names none. */
export const QUICK_MAX_RESULTS = 5;
export const QUICK_DEPTH = 'basic' as const;

export interface SearchPort {
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

export interface FetchPagePort {
  fetchPage(url: string): Promise<FetchedPage>;
}
