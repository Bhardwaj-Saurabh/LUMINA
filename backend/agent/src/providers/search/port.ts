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

export interface SearchPort {
  search(query: string, opts?: { maxResults?: number }): Promise<SearchResult[]>;
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

export interface FetchPagePort {
  fetchPage(url: string): Promise<FetchedPage>;
}
