/**
 * runAsk — per-request assembly of BOTH gears (ARCHITECTURE §2.2 orchestrator + persistence).
 * Builds a fresh collector/budget/toolset per request, runs the quick loop or the deep
 * orchestrator, then persists: message pair, run log (file + runs collection), requests row.
 *
 * The gears share everything except their envelope and their shape: quick is one loop over
 * one registry, deep is plan → fan-out over one registry PER SUB-QUESTION → merge. The
 * sub-question registries are built from the same tool factories over a `taggedSink`, which
 * is why deep attribution needs no cooperation from the tools themselves.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { newId, type SourcesEvent, type DoneEvent, type ThreadMessage } from '@lumina/contract';
import { Budget } from '../core/budget.js';
import { SourceCollector, taggedSink, type SourceSink } from '../core/sourceCollector.js';
import { ToolRegistry, type ToolDef } from '../core/registry.js';
import { runLoop, type AskEmitter } from '../core/loop.js';
import { runDeep } from '../core/deep/orchestrator.js';
import { planResearch } from '../core/deep/planner.js';
import { makeWebSearchTool, makeFetchPageTool } from '../core/tools/webTools.js';
import { makeRecallMemoryTool, makeSaveMemoryTool } from '../core/tools/memoryTools.js';
import { makeSearchDocumentsTool } from '../core/tools/docTools.js';
import { retrieveChunks, type ChunkSearchPort } from '../core/rag/retrieve.js';
import { createRunLog } from '../obs/runlog.js';
import { vetUrl } from '../guards/ssrf.js';
import type { LlmPort, LlmMessage } from '../providers/llm/port.js';
import type { SearchPort, FetchPagePort } from '../providers/search/port.js';
import {
  makeCachedSearch,
  type CachedSearchEntry,
  type SearchCacheStore
} from '../providers/search/cached.js';
import type { Lru } from '../infra/lru.js';
import type { RunAskInput } from './app.js';
import type { MessagesWriter } from '../repos/messages.js';
import type { EmbeddingsPort } from '../providers/embeddings/port.js';
import type { MemoriesRepo } from '../repos/memories.js';
import { env } from '../env.js';

export interface RunAskDeps {
  llm: LlmPort;
  search: SearchPort;
  searchCache: SearchCacheStore;
  /** Process-wide L1: scoping it per request would make the in-process tier useless. */
  searchLru: Lru<CachedSearchEntry>;
  fetchPage: FetchPagePort;
  embeddings: EmbeddingsPort;
  memories: Pick<MemoriesRepo, 'insert' | 'searchByVector' | 'hasAny'>;
  /** The two halves of hybrid retrieval; absent only in tests that never ask about a Space. */
  chunks?: ChunkSearchPort;
  messages: MessagesWriter;
  runs: { upsert(doc: Record<string, unknown>): Promise<void> };
  requests: { insert(doc: Record<string, unknown>): Promise<void> };
  /** One structured line per answer; `requestId` is what correlates it with the gateway's. */
  log?: { info(obj: Record<string, unknown>, msg: string): void };
}

const resolveHost = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true })).map((a) => a.address);

/**
 * Router nudge for `mode: 'auto'` with a Space attached. Attaching a Space is a deliberate
 * act, so the user's own material is the first place to look; the web stays available for
 * what the Space cannot answer.
 */
const DOCS_GUIDANCE =
  'The user has attached a Space of their own documents. Call search_documents FIRST — ' +
  'they attached it because they expect the answer to come from it. Fall back to the web ' +
  'only for what the documents do not cover, and say which is which.';

const price = (usage: { in: number; out: number }): number =>
  (usage.in * env.llmInputUsdPerMtok + usage.out * env.llmOutputUsdPerMtok) / 1_000_000;

export function makeRunAsk(deps: RunAskDeps) {
  return async function runAsk(input: RunAskInput): Promise<void> {
    const { body, threadId, userId, emitter } = input;
    const requestId = input.requestId ?? newId('req');

    const now = () => Date.now();
    const startedAt = now();
    const collector = new SourceCollector();
    // Two gears, two envelopes — the caps are configuration, never a prompt instruction.
    const deep = body.depth === 'deep';
    const budget = new Budget({
      maxToolCalls: deep ? env.maxToolCallsDeep : env.maxToolCalls,
      deadlineMs: (deep ? env.maxWallClockSecDeep : env.maxWallClockSec) * 1000,
      maxUsd: deep ? env.maxUsdDeep : env.maxUsdQuick,
      maxTokens: env.maxTokensPerRun,
      synthesisAllowance: { ms: env.synthesisAllowanceMs, usd: env.synthesisAllowanceUsd },
      now
    });
    // Per-request cached port so stats (and therefore `searchCached`) describe this answer only.
    const cachedSearch = makeCachedSearch({
      inner: deps.search,
      store: deps.searchCache,
      ttlSeconds: env.searchCacheTtlSeconds,
      provider: env.searchProvider,
      lru: deps.searchLru,
      now
    });
    // Two cheap indexed reads, in parallel: the thread's history and whether this user has
    // anything to recall. Both shape the request before the first provider call.
    const [threadMessages, hasMemories] = await Promise.all([
      deps.messages.listByThread(threadId),
      deps.memories.hasAny(userId)
    ]);
    const history: LlmMessage[] = threadMessages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));

    // The router (SPEC 5.4 "Should"): `mode` decides which retrieval surfaces EXIST for this
    // request, structurally — the same discipline as depth. `auto` advertises both and lets
    // the model choose, and its choice shows up in the trace as the tool it reached for.
    const spaceId = body.spaceId;
    const chunkSearch = deps.chunks;

    const docsAvailable = body.mode !== 'web' && spaceId !== undefined && chunkSearch !== undefined;

    /**
     * The retrieval half of the toolset, built against a given sink. Quick uses the
     * collector directly; deep hands each sub-question a `taggedSink`, which is what makes
     * every deep source carry its `subQuestion` without any tool knowing about sub-questions.
     */
    const retrievalTools = (sink: SourceSink): ToolDef[] => {
      const tools: ToolDef[] = [];
      if (body.mode !== 'docs') {
        tools.push(
          makeWebSearchTool({ search: cachedSearch, collector: sink, modelContentChars: env.searchResultModelChars })
        );
        tools.push(
          makeFetchPageTool({
            fetchPage: deps.fetchPage,
            vet: (url) => vetUrl(url, resolveHost),
            collector: sink
          })
        );
      }
      if (docsAvailable) {
        tools.push(
          makeSearchDocumentsTool({
            retrieve: (query, forSpace) =>
              retrieveChunks(
                { query, spaceId: forSpace, userId },
                {
                  embeddings: deps.embeddings,
                  chunks: chunkSearch,
                  config: {
                    topK: env.ragTopK,
                    candidateK: env.ragCandidateK,
                    numCandidates: env.ragNumCandidates,
                    rrfK: env.ragRrfK
                  }
                }
              ),
            collector: sink,
            spaceId
          })
        );
      }
      return tools;
    };

    const registry = new ToolRegistry();
    for (const tool of retrievalTools(collector)) registry.register(tool);
    // Memory is available in both gears; userId/threadId are request-scoped, never model input.
    registry.register(
      makeSaveMemoryTool({
        embeddings: deps.embeddings,
        memories: deps.memories,
        userId,
        threadId,
        now
      })
    );
    // Offered only when there is something to recall (TTFT): to a user with no memories the
    // tool can only return [], and measured live it cost ~400-500 ms of output tokens on the
    // decision turn — or a whole extra round trip when the model called it INSTEAD of
    // searching. Structural, like depth and mode: a tool that cannot help is not on the menu.
    if (hasMemories) {
      registry.register(
        makeRecallMemoryTool({ embeddings: deps.embeddings, memories: deps.memories, userId })
      );
    }

    // Speculative search (TTFT): a fresh web question almost always becomes web_search with
    // the user's own wording (the prompt asks for exactly that), and today that search waits
    // for LLM turn 1 to finish before it starts. Start it now, into the cache layer only; the
    // model's identical call joins the in-flight promise. It cannot mint a source (it never
    // touches the collector), cannot count as a cache hit (a join is a miss), and a failure
    // here is not a request failure — it surfaces, if at all, through the model's own call.
    const prefetchable =
      env.searchPrefetch &&
      !deep &&
      history.length === 0 &&
      (body.mode === 'web' || (body.mode === 'auto' && !docsAvailable));
    if (prefetchable) cachedSearch.prewarm(body.query);

    const runlog = createRunLog({ depth: body.depth, now });
    const toolCallLog: Array<{ name: string; ok: boolean }> = [];
    let answerText = '';
    let sources: SourcesEvent = [];
    let doneEvent: DoneEvent | undefined;
    // Observe the stream to build the evidence trail; the sink still owns transport.
    const recording: AskEmitter = {
      plan: (d) => emitter.plan(d),
      trace: (d) => {
        runlog.toolCall({ name: d.tool, ok: d.ok, ...(d.error ? { error: d.error } : {}), ms: d.ms });
        toolCallLog.push({ name: d.tool, ok: d.ok });
        emitter.trace(d);
      },
      sources: (d) => {
        sources = d;
        emitter.sources(d);
      },
      token: (d) => {
        answerText += d.text;
        emitter.token(d);
      },
      done: (d) => {
        doneEvent = d;
        emitter.done(d);
      },
      error: (d) => emitter.error(d)
    };

    const answerId = newId('ans');
    const common = {
      llm: deps.llm,
      budget,
      collector,
      emitter: recording,
      query: body.query,
      history,
      now,
      answerId,
      model: env.llmModel,
      price,
      searchCached: () => cachedSearch.stats().allHits
    };

    const outcome = deep
      ? await runDeep({
          ...common,
          // Each sub-question gets its own registry over a sink that stamps its index, so a
          // source cannot reach the merged list without the attribution the grader checks.
          registryFor: (subQuestion) => {
            const sub = new ToolRegistry();
            for (const tool of retrievalTools(taggedSink(collector, subQuestion))) {
              sub.register(tool);
            }
            return sub;
          },
          planner: (query) =>
            planResearch(query, {
              llm: deps.llm,
              min: env.deepSubQuestionsMin,
              max: env.deepSubQuestionsMax,
              price,
              budget
            }),
          concurrency: env.deepConcurrency
        })
      : await runLoop({
          ...common,
          registry,
          depth: body.depth,
          ...(docsAvailable ? { guidance: DOCS_GUIDANCE } : {})
        });

    // --- evidence + persistence: never claim more than what happened -------------------
    const snapshot = budget.snapshot();
    runlog.finish({
      tokensIn: snapshot.tokens.in,
      tokensOut: snapshot.tokens.out,
      costUsd: snapshot.costUsd,
      terminated: outcome.terminated
    });
    await runlog.persist({
      requestId,
      writeFile: async (path, content) => {
        void path; // builder computes runs/<requestId>.json relative; we anchor at env.runsDir
        await writeFile(join(env.runsDir, `${requestId}.json`), content, 'utf8');
      },
      upsert: (doc) => deps.runs.upsert(doc)
    });
    await deps.requests.insert({
      requestId,
      userId,
      route: 'POST /threads/:threadId/ask',
      status: outcome.terminated === 'error' ? 502 : 200,
      ms: now() - startedAt,
      tokensIn: snapshot.tokens.in,
      tokensOut: snapshot.tokens.out,
      costUsd: snapshot.costUsd,
      terminated: outcome.terminated,
      depth: body.depth,
      // Operational fields beyond the contract's declared minimum: /stats is computed from
      // these rows, so the evidence a dashboard shows is the evidence the run logs carry.
      ttftMs: doneEvent?.ttftMs ?? null,
      searchCached: doneEvent?.searchCached ?? false,
      mode: body.mode,
      timings: outcome.timings ?? null
    });

    // §10: one line per answer, keyed by the same requestId the gateway logged, so a single
    // request is greppable end to end across both services.
    deps.log?.info(
      {
        requestId,
        userId,
        threadId,
        answerId,
        depth: body.depth,
        terminated: outcome.terminated,
        toolCalls: toolCallLog, // not runlog.build(): logging must never throw on an A1 violation
        tokens: snapshot.tokens,
        costUsd: snapshot.costUsd,
        searchCached: doneEvent?.searchCached ?? false,
        ttftMs: doneEvent?.ttftMs ?? null,
        latencyMs: doneEvent?.latencyMs ?? now() - startedAt,
        mode: body.mode,
        // Phase attribution (core/timings.ts): where ttftMs went. Off the contract, on the log.
        timings: outcome.timings ?? null,
        prefetch: cachedSearch.stats().prefetch
      },
      'answer'
    );

    if (outcome.terminated !== 'error') {
      const pair: ThreadMessage[] = [
        { role: 'user', content: body.query },
        {
          role: 'assistant',
          content: answerText,
          sources,
          answerId,
          ...(doneEvent ? { done: doneEvent } : {})
        }
      ];
      await deps.messages.insertMany(threadId, userId, pair);
    }
  };
}
