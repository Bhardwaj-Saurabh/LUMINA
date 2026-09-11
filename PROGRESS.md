# PROGRESS.md — LUMINA delivery tracker

> Single source of truth for project state across sessions. Maintained via the
> `lumina-track` skill. A milestone is ✅ only when its **EDD proof** column holds a real
> result (a gate that ran), never on inspection. Update this file in the same commit as the
> work it describes.

## Status

| | |
|---|---|
| **Current milestone** | M1 — environment & Atlas indexes |
| **Blockers** | `.env` partially filled: Azure OpenAI ✅ (endpoint, key, gpt-5.4 deployments, text-embedding-3-large → use `dimensions: 1536`). Still missing: `MONGODB_URI` (Atlas M0, GCP europe-west2 — free) and `TAVILY_API_KEY` (free) — user-side. Azure AI Search vars present but unused (assignment's RAG contract is Atlas). |
| **Last gates run** | none yet (backend is the provided 501 skeleton) |
| **Deploy state** | not deployed |

## Milestones

Legend: ☐ not started · 🔨 in progress · ✅ done (EDD proof recorded)

| ID | Scope | TDD surface | EDD proof (gate / bench caps) | Status |
|----|-------|-------------|-------------------------------|--------|
| M0 | Scaffold verified: `npm install`, contract builds, typecheck clean | — | `npm run typecheck` exit 0 (2026-09-09) | ✅ |
| M1 | `.env` filled; `node scripts/create-indexes.mjs` run; 3 search indexes queryable | — | `create-indexes.mjs --status`: all queryable | ☐ |
| M2 | Quick vertical slice: `POST /threads`, ask loop (web_search + fetch_page), SSE `trace→sources→token→done`, SourceCollector, budget, run log | budget, sourceCollector, citations units; loop test w/ fake ports + collecting emitter; ask route supertest | bench `--smoke` completes; `sourcesBeforeFirstToken`; `contractProbes` (401/404/400); one `runs/*.json` + `quality/check.mjs` reads it | ☐ |
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
