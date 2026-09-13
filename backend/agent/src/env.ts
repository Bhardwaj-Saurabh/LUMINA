import { config } from 'dotenv';
import { resolve } from 'node:path';

// The single .env at the assignment root. Provider keys are read HERE and nowhere else.
config({ path: resolve(process.cwd(), '../../.env') });
config({ path: resolve(process.cwd(), '.env') });

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
export const env = {
  port: num(process.env.PORT_AGENT ?? process.env.PORT, 8000),
  mongoUri: process.env.MONGODB_URI ?? '',
  mongoDb: process.env.MONGODB_DB ?? 'lumina',
  vectorBackend: (process.env.VECTOR_BACKEND ?? 'atlas-vector-search') as
    | 'atlas-vector-search'
    | 'mongo-cosine-scan',

  llmProvider: process.env.LLM_PROVIDER ?? 'anthropic',
  llmModel: process.env.LLM_MODEL ?? 'claude-sonnet-5',

  // Azure OpenAI (decided 2026-09-11): deployments are addressed by name, not model id.
  azureOpenaiEndpoint: process.env.AZURE_OPENAI_ENDPOINT ?? '',
  azureOpenaiApiVersion: process.env.AZURE_OPENAI_API_VERSION ?? '2026-03-17',
  azureChatDeployment:
    process.env.AZURE_OPENAI_CHAT_DEPLOYMENT ?? process.env.AZURE_OPENAI_MINI_DEPLOYMENT ?? '',
  azureEmbeddingDeployment: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT ?? '',

  // PLACEHOLDER rates (USD per MTok) — set your provider's published prices before
  // trusting any dollar figure; sla.json's cost_model must be re-declared to match.
  llmInputUsdPerMtok: num(process.env.LLM_INPUT_USD_PER_MTOK, 0.25),
  llmOutputUsdPerMtok: num(process.env.LLM_OUTPUT_USD_PER_MTOK, 2.0),

  // Reserved so a cap can never starve the answer itself (ARCHITECTURE §3.1).
  synthesisAllowanceMs: num(process.env.SYNTHESIS_ALLOWANCE_MS, 15000),
  synthesisAllowanceUsd: num(process.env.SYNTHESIS_ALLOWANCE_USD, 0.01),
  maxUsdQuick: num(process.env.MAX_USD_QUICK, 0.05),
  maxUsdDeep: num(process.env.MAX_USD_DEEP, 0.35),
  maxTokensPerRun: num(process.env.MAX_TOKENS_PER_RUN, 180000),

  searchProvider: (process.env.SEARCH_PROVIDER ?? 'tavily') as 'tavily' | 'serpapi',
  searchCacheTtlSeconds: num(process.env.SEARCH_CACHE_TTL_SECONDS, 21600),

  embeddingModel: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',

  // RAG: SPEC 5.4 requires top-k and thresholds to be CONFIG, not constants buried in the
  // retriever — tuning recall must not need a code change.
  /**
   * Five, not eight: recall@5 is the gate, so chunks 6-8 are prompt tokens nobody scores —
   * they cost input tokens and first-token latency on every document answer. The corpus
   * puts it well: five chunks is roughly what fits alongside instructions and history.
   */
  ragTopK: num(process.env.RAG_TOP_K, 5),
  /** Per half, before fusion: RRF needs depth to have anything to agree about. */
  ragCandidateK: num(process.env.RAG_CANDIDATE_K, 24),
  /** Atlas guidance: candidates well above the limit, or vector recall degrades. */
  ragNumCandidates: num(process.env.RAG_NUM_CANDIDATES, 240),
  ragRrfK: num(process.env.RAG_RRF_K, 60),
  chunkTargetChars: num(process.env.CHUNK_TARGET_CHARS, 1200),
  chunkOverlapChars: num(process.env.CHUNK_OVERLAP_CHARS, 150),
  embedBatchSize: num(process.env.EMBED_BATCH_SIZE, 64),

  // Jobs worker. The probe window has to outlast Atlas Search's indexing lag, which is
  // seconds on a quiet M0 and longer on a busy one.
  /** `child` (default) supervises the worker inside this container; `off` for a standalone one. */
  workerMode: (process.env.WORKER_MODE ?? 'child') as 'child' | 'off',
  workerPollMs: num(process.env.WORKER_POLL_MS, 1000),
  workerLeaseMs: num(process.env.WORKER_LEASE_MS, 300000),
  workerMaxAttempts: num(process.env.WORKER_MAX_ATTEMPTS, 3),
  probeAttempts: num(process.env.PROBE_ATTEMPTS, 20),
  probeDelayMs: num(process.env.PROBE_DELAY_MS, 1500),

  // Deep search is the expensive gear, so its limits are configuration, not code.
  deepSubQuestionsMin: num(process.env.DEEP_SUB_QUESTIONS_MIN, 3),
  deepSubQuestionsMax: num(process.env.DEEP_SUB_QUESTIONS_MAX, 6),
  deepDailyCap: num(process.env.DEEP_DAILY_CAP, 5),
  /** Sub-questions researched at once. Three keeps wall-clock down without stampeding Tavily. */
  deepConcurrency: num(process.env.DEEP_CONCURRENCY, 3),

  // The hard caps from AGENTS.md. Raising these to make a gate pass is the failure mode
  // the caps exist to catch. Two gears, two envelopes.
  maxToolCalls: num(process.env.MAX_TOOL_CALLS, 8),
  maxWallClockSec: num(process.env.MAX_WALL_CLOCK_SEC, 90),
  maxToolCallsDeep: num(process.env.MAX_TOOL_CALLS_DEEP, 24),
  maxWallClockSecDeep: num(process.env.MAX_WALL_CLOCK_SEC_DEEP, 240),

  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Where the per-answer run logs land. quality/check.mjs reads this folder. */
  runsDir: resolve(process.cwd(), '../../runs')
} as const;

/** Never log or return these. /health names the model; it never echoes a key. */
export const secrets = {
  anthropic: process.env.ANTHROPIC_API_KEY ?? '',
  openai: process.env.OPENAI_API_KEY ?? '',
  azureOpenai: process.env.AZURE_OPENAI_KEY ?? '',
  tavily: process.env.TAVILY_API_KEY ?? '',
  serpapi: process.env.SERPAPI_API_KEY ?? ''
} as const;
