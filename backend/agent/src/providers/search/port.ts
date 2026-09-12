/**
 * SearchPort + FetchPagePort — ARCHITECTURE.md §2.2 (providers/search/port.ts). Types
 * only; the Tavily/SerpApi adapters are the sole SDK importers. Extraction is folded
 * into the search provider, so the fetch-page port lives here too.
 */

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
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
