/**
 * runAsk — per-request assembly of the quick ask path (ARCHITECTURE §2.2 quick/orchestrator
 * plus persistence). Builds a fresh collector/budget/registry per request, runs the loop,
 * then persists: message pair, run log (file + runs collection), requests row. Deep search
 * lands in M8; until then a deep request is answered 501, honestly, before any spend.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { newId, type SourcesEvent, type DoneEvent, type ThreadMessage } from '@lumina/contract';
import { Budget } from '../core/budget.js';
import { SourceCollector } from '../core/sourceCollector.js';
import { ToolRegistry } from '../core/registry.js';
import { runLoop, type AskEmitter } from '../core/loop.js';
import { makeWebSearchTool, makeFetchPageTool } from '../core/tools/webTools.js';
import { createRunLog } from '../obs/runlog.js';
import { vetUrl } from '../guards/ssrf.js';
import type { LlmPort, LlmMessage } from '../providers/llm/port.js';
import type { SearchPort, FetchPagePort } from '../providers/search/port.js';
import type { RunAskInput } from './app.js';
import type { MessagesWriter } from '../repos/messages.js';
import { env } from '../env.js';

export interface RunAskDeps {
  llm: LlmPort;
  search: SearchPort;
  fetchPage: FetchPagePort;
  messages: MessagesWriter;
  runs: { upsert(doc: Record<string, unknown>): Promise<void> };
  requests: { insert(doc: Record<string, unknown>): Promise<void> };
}

const resolveHost = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true })).map((a) => a.address);

const price = (usage: { in: number; out: number }): number =>
  (usage.in * env.llmInputUsdPerMtok + usage.out * env.llmOutputUsdPerMtok) / 1_000_000;

export function makeRunAsk(deps: RunAskDeps) {
  return async function runAsk(input: RunAskInput): Promise<void> {
    const { body, threadId, userId, emitter } = input;
    const requestId = input.requestId ?? newId('req');

    if (body.depth === 'deep') {
      emitter.error({ status: 501, error: 'deep search not implemented yet (M8)' });
      return;
    }

    const now = () => Date.now();
    const startedAt = now();
    const collector = new SourceCollector();
    const budget = new Budget({
      maxToolCalls: env.maxToolCalls,
      deadlineMs: env.maxWallClockSec * 1000,
      maxUsd: env.maxUsdQuick,
      maxTokens: env.maxTokensPerRun,
      synthesisAllowance: { ms: env.synthesisAllowanceMs, usd: env.synthesisAllowanceUsd },
      now
    });
    const registry = new ToolRegistry();
    registry.register(makeWebSearchTool({ search: deps.search, collector }));
    registry.register(
      makeFetchPageTool({
        fetchPage: deps.fetchPage,
        vet: (url) => vetUrl(url, resolveHost),
        collector
      })
    );

    const runlog = createRunLog({ depth: body.depth, now });
    let answerText = '';
    let sources: SourcesEvent = [];
    let doneEvent: DoneEvent | undefined;
    // Observe the stream to build the evidence trail; the sink still owns transport.
    const recording: AskEmitter = {
      plan: (d) => emitter.plan(d),
      trace: (d) => {
        runlog.toolCall({ name: d.tool, ok: d.ok, ...(d.error ? { error: d.error } : {}), ms: d.ms });
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

    const history: LlmMessage[] = (await deps.messages.listByThread(threadId))
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));

    const answerId = newId('ans');
    const outcome = await runLoop({
      llm: deps.llm,
      registry,
      depth: body.depth,
      budget,
      collector,
      emitter: recording,
      query: body.query,
      history,
      now,
      answerId,
      model: env.llmModel,
      price,
      searchCached: () => false // accurate two-tier cache lands in M3
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
      depth: body.depth
    });

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
