# PROGRESS.md — LUMINA delivery tracker

> Single source of truth for project state across sessions. Maintained via the
> `lumina-track` skill. A milestone is ✅ only when its **EDD proof** column holds a real
> result (a gate that ran), never on inspection. Update this file in the same commit as the
> work it describes.

## Status

| | |
|---|---|
| **Current milestone** | M2 — quick vertical slice (loop, SSE, sources, run log) |
| **Blockers** | none |
| **Last gates run** | 2026-09-11: `create-indexes.mjs --status` → all 3 search indexes READY (queryable); agent `/health` → `db: ok`, `vectorStore: atlas-vector-search` |
| **Deploy state** | not deployed |

## Milestones

Legend: ☐ not started · 🔨 in progress · ✅ done (EDD proof recorded)

| ID | Scope | TDD surface | EDD proof (gate / bench caps) | Status |
|----|-------|-------------|-------------------------------|--------|
| M0 | Scaffold verified: `npm install`, contract builds, typecheck clean | — | `npm run typecheck` exit 0 (2026-09-09) | ✅ |
| M1 | `.env` filled; `node scripts/create-indexes.mjs` run; 3 search indexes queryable | — | 2026-09-11: `--status` → memories_vector, chunks_vector, chunks_text all READY (queryable); `/health` db ok against Atlas | ✅ |
| M2 | Quick vertical slice: `POST /threads`, ask loop (web_search + fetch_page), SSE `trace→sources→token→done`, SourceCollector, budget, run log | budget, sourceCollector, citations units; loop test w/ fake ports + collecting emitter; ask route supertest | bench `--smoke` completes; `sourcesBeforeFirstToken`; `contractProbes` (401/404/400); one `runs/*.json` + `quality/check.mjs` reads it | 🔨 |
| M3 | Two-tier search cache (LRU → `searchCache` TTL) | cache key sha256, decorator hit/miss units | repeat query → `done.searchCached: true`; bench cache-hit ≥ 50 % on workload | ☐ |
| M4 | Threads + messages persistence; follow-ups see the thread | threads/messages repo units; getThread route test | UI thread reload; bench web workload green | ☐ |
| M5 | Memory: save/recall tools, `GET /memory`, `DELETE /memory/:id`, cross-thread effect | memory tool units w/ fake embeddings; route tests | bench caps `memorySaved`, `memoryRecalled`, `memoryDeleted` | ☐ |
| M6 | Gateway complete: auth 401, zod 400, rate limit 429, IAM-ready proxy, SSE pass-through, upload pipe, `/evals` SPA route | middleware units; askProxy stream test; 413 test | `contractProbes` all green through :8787; TTFT measured through gateway in smoke | ☐ |
| M7 | RAG: spaces, upload 202 <300 ms, jobs worker (lease+checkpoints), pdfjs parse, chunk+locators, embed, hybrid RRF, read-your-write probe | jobStateMachine, chunker/locator, RRF units; pipeline test w/ fake embeddings | bench caps `accept202`, `indexedViaWorker`, `pageLocator`, `routerPicksDocs`; recall@5 ≥ 0.70 | ☐ |
| M8 | Deep search: plan-first, p-limit(3) fan-out, merge/renumber, subQuestion tags, DEEP_DAILY_CAP 429, quick-never-escalates | planner validation, merge dedupe/renumber, deepCap ledger units; deep orchestrator test w/ fake ports | bench caps `deepPlan`, `deepAttribution`, `deepReadsMore`, `deepBudget`, `deepCap429`, `quickNeverEscalates` | ☐ |
| M9 | Full local proof: bench exit 0 vs sla.json; quality exit ≤ 1; failing trajectory in `runs/failing/` | regression tests for every gate failure found | `node benchmark/bench.mjs` exit 0 · `node quality/check.mjs .` exit ≤ 1 | ☐ |
| M10 | Containerize (2 Dockerfiles), Cloud Run deploy (agent IAM-gated), Vercel UI, indexes on Atlas, deployed eval, report published, `/evals` renders | image smoke (USER node, ports, worker supervision) | `eval/eval.mjs --deploy-url` all gates; `/evals` on the Vercel URL renders the real report | ☐ |

## Session log (append-only)

| Date | Did | Tests | Gates | Next | Notes |
|------|-----|-------|-------|------|-------|
| 2026-09-08 | Imported full course scaffold (81 files); verified install + typecheck after building contract | n/a | typecheck ✅ | architecture | Scaffold appeared upstream after first empty clone |
| 2026-09-09 | CLAUDE.md created | n/a | — | plan GCP architecture | |
| 2026-09-10 | ARCHITECTURE.md written (GCP/Cloud Run, Mermaid), then hardened in review (durable admission, evidence workflow, Vercel-submitted UI); CLAUDE.md synced; DESIGN.md drafted + reformatted | n/a | — | delivery tooling | Planner trace: omit `subQuestion` (bench excludes plan_research from attribution) |
| 2026-09-11 | Delivery tooling: PROGRESS.md, skills (lumina-tdd, lumina-edd, lumina-track), agents (test-writer, implementer, gate-runner, red-line-auditor), delivery rules in CLAUDE.md, vitest wiring + seed tests | seed ✅ | typecheck/lint ✅ · quality C1 ✅ | M1: user supplies Atlas URI + API keys → `.env` → indexes | |
| 2026-09-11 | LLM switched to **Azure OpenAI** (user's work access; gpt-5.4 deployments in `.env`); docs updated (ARCHITECTURE, CLAUDE, this file). Embeddings: text-embedding-3-large with `dimensions: 1536` | n/a | — | M1 still blocked: Atlas URI + Tavily key | Azure key echoed to terminal during check — rotate after project; confirm work-resource policy |
| 2026-09-11 | **M1 closed**: Atlas URI + Tavily key landed; 14 regular indexes + 3 search indexes created, all queryable in ~30 s; agent `/health` green against Atlas; `.env` gains `LLM_PROVIDER=azure-openai`, `LLM_MODEL=gpt-5.4-mini` | n/a | indexes ✅ · health ✅ | M2 red phase: test-writer on Budget + SourceCollector, then loop | user's `.env` is hand-rolled, not a copy of the example — defaults apply for unset vars |
| 2026-09-11 | **M2 batch 1** via agent pipeline: test-writer red (25 tests, module-not-found) → implementer green (`core/budget.ts`, `core/sourceCollector.ts`) → test-writer follow-up (guarded indexing + empty-finalize Must) → finalize() honest `Source[]` | 30/30 ✅ | typecheck/lint ✅ | M2 batch 2 red: AskEmitter/SSE sink + the loop (fake ports, sources-before-token, fail-loud) | Budget reports state; `terminated:'cap'` = orchestrator's call on a REFUSED admission, not exhaustion (A2) |
| 2026-09-11 | **M2 batch 2**: `core/registry.ts` (R2 at dispatch, DEEP_ONLY_TOOLS authoritative), `core/loop.ts` (order trace→sources→token→done, parallel tool exec in one tool_results msg, A1 traces, 502-no-done on provider throw, refused-admission cap vs natural-finish done, unresolvedCitations audit), `providers/llm/port.ts` (neutral LlmPort — Azure adapter implements it), `src/testing/fakes.ts` | 49/49 ✅ | typecheck/lint ✅ | Batch 3 red: SSE sink over Response, threads+ask routes (supertest), run log writer; then Azure adapter (no unit TDD, taxonomy) | Placeholder tool inputSchema in loop's spec advert — real JSON-schema derivation lands in the LLM adapter |
| 2026-09-11 | **M2 batch 3**: `http/sseSink.ts` (AskEmitter over Response, keepalive stops on done/error/close, post-close emits ignored), `obs/runlog.ts` (build = RunLog.parse so A1 enforced by contract; injected persist seams), `guards/ssrf.ts` (octet-math ranges, GCP metadata, rebinding defense, IPv4-mapped in BOTH dotted and hex forms — WHATWG URL serializes to hex). Red written by coordinator after test-writer agent stalled twice | 75/75 ✅ | typecheck/lint ✅ | Batch 4: tools (web_search/fetch_page over Tavily), threads+ask routes, composition root, Azure OpenAI adapter → first live `curl -N` (M2's EDD gate) | Redirect re-vetting/timeout/body-cap deferred to the fetch_page tool slice, which calls vetUrl per hop |
| 2026-09-12 | **M2 batch 4**: `core/tools/webTools.ts` (web_search + fetch_page factories: vet-before-fetch, untrusted_source framing, collector-grounded snippets), `providers/search/port.ts`, `http/app.ts` (`makeAgentApp` — ROUTES-driven auth 401, ownership-as-404, AskBody 400, SSE via real sink, runAsk seam, degraded health stays 503). Both agents stalled once mid-batch; resumed with incremental-read instructions | 95/95 ✅ | typecheck/lint ✅ | Batch 5 (composition, no-unit-TDD zone): Azure OpenAI + Tavily adapters, cached search, repos, prompts, runAsk assembly, index.ts rewiring → `curl -N` + bench smoke = M2 EDD proof | |
