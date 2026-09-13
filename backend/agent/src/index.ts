/**
 * LUMINA agent service — composition root. Wires real adapters (Azure OpenAI, Tavily,
 * Mongo repos) into makeAgentApp. All provider keys are read in env.ts and injected here;
 * no other module may touch them (ARCHITECTURE §2.2). Routes not yet built still answer
 * 501 via the app factory, so the UI's "not implemented yet" remains the progress bar.
 */
import pino from 'pino';
import { mkdirSync } from 'node:fs';
import type { HealthResponse } from '@lumina/contract';
import { env, secrets } from './env.js';
import { db, pingDb } from './db.js';
import { makeAgentApp } from './http/app.js';
import { makeRunAsk } from './http/runAsk.js';
import { makeAzureOpenAiLlm } from './providers/llm/azureOpenai.js';
import { makeAzureOpenAiEmbeddings } from './providers/embeddings/azureOpenai.js';
import { makeTavilySearch, makeTavilyFetchPage } from './providers/search/tavily.js';
import { createSearchLru } from './providers/search/cached.js';
import { makeUploadDocumentHandler } from './http/uploadRoute.js';
import { makeThreadsRepo } from './repos/threads.js';
import { makeMessagesRepo } from './repos/messages.js';
import { makeMemoriesRepo } from './repos/memories.js';
import { makeRunsRepo, makeRequestsRepo } from './repos/runs.js';
import { makeSearchCacheRepo } from './repos/searchCache.js';
import { makeSpacesRepo } from './repos/spaces.js';
import { makeDocumentsRepo } from './repos/documents.js';
import { makeChunksRepo } from './repos/chunks.js';
import { makeJobsRepo } from './repos/jobs.js';
import { makeDeepUsageStore } from './repos/deepUsage.js';
import { makeStatsReader } from './repos/stats.js';
import { admitDeep } from './core/deep/deepCap.js';
import { makeFileBucket } from './infra/gridfs.js';
import { superviseWorker } from './workerSupervisor.js';

const log = pino({ level: env.logLevel });

mkdirSync(env.runsDir, { recursive: true });

const database = await db();
const llm = makeAzureOpenAiLlm({
  endpoint: env.azureOpenaiEndpoint,
  apiKey: secrets.azureOpenai,
  apiVersion: env.azureOpenaiApiVersion,
  chatDeployment: env.azureChatDeployment || env.llmModel
});
const embeddings = makeAzureOpenAiEmbeddings({
  endpoint: env.azureOpenaiEndpoint,
  apiKey: secrets.azureOpenai,
  apiVersion: env.azureOpenaiApiVersion,
  deployment: env.azureEmbeddingDeployment || env.embeddingModel
});
const memories = makeMemoriesRepo(database);
const spaces = makeSpacesRepo(database);
const documents = makeDocumentsRepo(database);
const chunks = makeChunksRepo(database);
const files = makeFileBucket(database);
const deepUsage = makeDeepUsageStore(database);

const health = async (): Promise<HealthResponse> => {
  const dbStatus = await pingDb();
  return {
    status: dbStatus === 'ok' ? 'ok' : 'degraded',
    model: env.llmModel,
    searchProvider: env.searchProvider,
    vectorStore: env.vectorBackend,
    db: dbStatus,
    ai: { status: 'ok' }
  };
};

const app = makeAgentApp({
  threads: makeThreadsRepo(database),
  messages: makeMessagesRepo(database),
  memories,
  spaces,
  documents,
  // The spend gate lives HERE, in the agent: a cap on the gateway is bypassed by anyone who
  // can reach the agent directly, which is why the agent is IAM-gated in the deploy.
  admitDeep: (userId) =>
    admitDeep({ userId, now: Date.now(), cap: env.deepDailyCap, store: deepUsage }),
  stats: makeStatsReader(database, { deepDailyCap: env.deepDailyCap, deepUsage }),
  uploadDocument: makeUploadDocumentHandler({
    spaces,
    documents,
    jobs: makeJobsRepo(database),
    files,
    now: Date.now
  }),
  runAsk: makeRunAsk({
    llm,
    embeddings,
    memories,
    chunks,
    search: makeTavilySearch(secrets.tavily),
    searchCache: makeSearchCacheRepo(database),
    searchLru: createSearchLru(),
    fetchPage: makeTavilyFetchPage(secrets.tavily),
    messages: makeMessagesRepo(database),
    runs: makeRunsRepo(database),
    requests: makeRequestsRepo(database),
    log
  }),
  health
});

if (env.workerMode === 'child') superviseWorker(log);

app.listen(env.port, () => {
  log.info(
    {
      port: env.port,
      model: env.llmModel,
      llmProvider: env.llmProvider,
      searchProvider: env.searchProvider,
      vectorStore: env.vectorBackend,
      caps: {
        quick: { toolCalls: env.maxToolCalls, wallClockSec: env.maxWallClockSec, maxUsd: env.maxUsdQuick },
        deep: { toolCalls: env.maxToolCallsDeep, wallClockSec: env.maxWallClockSecDeep, dailyCap: env.deepDailyCap }
      }
    },
    'agent up — quick ask live; remaining routes 501 until built'
  );
});
