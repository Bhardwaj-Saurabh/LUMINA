import { describe, expect, it, vi } from 'vitest';
import { makeTavilySearch } from './tavily.js';

/**
 * The Tavily adapter and the breadth of a search.
 *
 * `SearchPort.search` has always declared `opts.maxResults`, and this adapter always ignored
 * it: every call went out as `max_results: 5, search_depth: 'basic'` whichever gear asked. So
 * deep search was only ever WIDER than quick (more sub-questions), never DEEPER per search —
 * and the full bench caught it on 2026-09-14, where one deep answer reached just 1.69x the
 * sources of the same query run quick (cap: 2x).
 *
 * Honouring the options is what makes the two gears differ in retrieval as well as fan-out.
 */

const okResponse = (results: unknown[]): Response =>
  ({ ok: true, status: 200, json: async () => ({ results }) }) as Response;

const bodyOf = (fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> =>
  JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);

describe('makeTavilySearch — request shape', () => {
  it('asks for the quick-gear defaults when the caller names no options', () => {
    const doFetch = vi.fn().mockResolvedValue(okResponse([]));
    void makeTavilySearch('key', doFetch).search('what is rrf');

    expect(bodyOf(doFetch)).toMatchObject({
      query: 'what is rrf',
      max_results: 5,
      search_depth: 'basic'
    });
  });

  it('honours the breadth and depth the deep gear asks for', async () => {
    const doFetch = vi.fn().mockResolvedValue(okResponse([]));

    await makeTavilySearch('key', doFetch).search('what is rrf', {
      maxResults: 10,
      depth: 'advanced'
    });

    expect(bodyOf(doFetch)).toMatchObject({ max_results: 10, search_depth: 'advanced' });
  });

  it('still fails loud on a non-OK response rather than returning nothing', async () => {
    const doFetch = vi.fn().mockResolvedValue({ ok: false, status: 429, statusText: 'Too Many Requests' });

    await expect(makeTavilySearch('key', doFetch).search('q')).rejects.toThrow(/429/);
  });
});
