/**
 * Tavily adapters for SearchPort and FetchPagePort. Fail loud: a non-OK response or a
 * timeout throws — the tool layer records the visible ok:false trace (A1); nothing here
 * may fabricate an empty-but-successful result.
 */
import type { FetchPagePort, FetchedPage, SearchPort, SearchResult } from './port.js';

const TIMEOUT_MS = 10_000;

async function post<T>(url: string, body: Record<string, unknown>, apiKey: string): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`tavily ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

interface TavilySearchResponse {
  results?: Array<{ url?: string; title?: string; content?: string }>;
}

interface TavilyExtractResponse {
  results?: Array<{ url?: string; raw_content?: string }>;
  failed_results?: Array<{ url?: string; error?: string }>;
}

export function makeTavilySearch(apiKey: string): SearchPort {
  return {
    async search(query: string): Promise<SearchResult[]> {
      const body = await post<TavilySearchResponse>(
        'https://api.tavily.com/search',
        { query, max_results: 5, search_depth: 'basic' },
        apiKey
      );
      return (body.results ?? [])
        .filter((r) => r.url && r.title)
        .map((r) => ({ url: r.url!, title: r.title!, snippet: (r.content ?? '').slice(0, 500) }));
    }
  };
}

export function makeTavilyFetchPage(apiKey: string): FetchPagePort {
  return {
    async fetchPage(url: string): Promise<FetchedPage> {
      const body = await post<TavilyExtractResponse>(
        'https://api.tavily.com/extract',
        { urls: [url] },
        apiKey
      );
      const hit = body.results?.[0];
      if (!hit?.raw_content) {
        const failure = body.failed_results?.[0]?.error ?? 'no content extracted';
        throw new Error(`extract failed for ${url}: ${failure}`);
      }
      // Tavily extract carries no title; the URL identifies the page well enough to cite.
      return { url, title: new URL(url).host + new URL(url).pathname, text: hit.raw_content };
    }
  };
}
