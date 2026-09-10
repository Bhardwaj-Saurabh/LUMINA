# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

LUMINA — a Perplexity-style AI search engine (streamed, cited answers from live web search + user documents, cross-session memory, and a two-gear quick/deep search). Assignment 1 of the FDE Agent Engineering Bootcamp. MERN: MongoDB Atlas (including vectors via Atlas Vector Search), two Express services, React UI, Node everywhere.

**Read [AGENTS.md](AGENTS.md) before doing anything — it is the binding contract for coding agents in this repo.** Reading order and authority: `packages/contract/` (executable zod schemas) outranks all prose; thresholds live only in `benchmark/sla.json`, `expectations.json`, `eval/rubric.json`; `SPEC.md` is the exhaustive agent-facing spec; `TECHNICAL.md` the build guide; `README.md`/`PRD.md` are intent, never numbers. **`ARCHITECTURE.md` is our own design authority** — the decided HLD/LLD, module layout for both services, guardrails, and the GCP deployment plan; implement to it.

## What you build vs. must never touch

- **BUILD:** `backend/gateway/` and `backend/agent/` only. Both are skeletons returning `501` on every route except `/health`.
- **DO NOT EDIT (red line, checked by the grader):** `web/`, `packages/contract/`, `benchmark/`, `eval/`, `quality/`, `scripts/`. The UI is the acceptance test; each route implemented "lights up" a UI panel.
- `DESIGN.md` (five questions: components, responsibilities, communication, state, trade-offs) must exist before code — copy from `DESIGN.template.md`; it's parsed by heading for the graded `/evals` page.
- Note: an earlier draft of this assignment had deck/image artifact generation. It was **cut** and replaced by deep search. Ignore any stale references to `make_presentation`/`generate_image`/`POST /artifacts`.

## Commands

```bash
npm install                            # workspace: web, backend/*, packages/contract (Node 20.19+)
npm run build -w @lumina/contract      # REQUIRED before typecheck/dev work — workspaces import its dist/
npm run dev                            # agent :8000, gateway :8787, UI :5173 (builds contract first)
npm run dev:agent | dev:gateway | dev:web   # one service at a time
npm run worker                         # jobs worker as a separate process
npm run typecheck                      # tsc across all workspaces (fails if contract not built)
npm run lint                           # eslint, repo-wide
npm run indexes                        # scripts/create-indexes.mjs — Atlas vector/text/TTL indexes
node scripts/create-indexes.mjs --status   # search indexes build async; wait for queryable
npm run bench                          # benchmark/bench.mjs end-to-end via gateway; exit 0 = SLA met
node benchmark/bench.mjs --smoke       # 5 queries (Gate 2); --target <url> for a deploy
npm run quality                        # quality/check.mjs . — reads runs/*.json; exit ≤1 = ok
npm run eval                           # eval/eval.mjs — all six gates in order, stops at first failure
npm run export:runs                    # dump the runs collection to runs/ (deployed instances)
```

There is no test suite; the bench, quality checker, and eval gates are the tests. Env comes from `.env` at the repo root (copy `.env.example`), read by both services. No Atlas? `docker compose up mongo` + `VECTOR_BACKEND=mongo-cosine-scan` (and `/health` must say so).

## Architecture (big picture)

```
web/ (React, PROVIDED) → gateway :8787 (edge: CORS, X-User-Id → 401, zod validation → 400,
rate limit → 429, X-Request-Id, pino log, SSE pass-through, serves web/dist)
→ agent :8000 (all AI: loop, tools, memory, RAG, deep search, jobs worker, run logs; holds ALL provider keys)
→ one MongoDB Atlas cluster (threads, messages, memories[vector idx], spaces, documents,
  chunks[vector idx + BM25 text idx], searchCache[TTL], jobs, requests, runs, GridFS uploads)
```

- **The contract is fixed.** `POST /threads/:id/ask` streams SSE `trace → sources → token → done` (`plan` first on deep). `sources` must precede the first `token`. Every `[n]` in the answer resolves to exactly one entry in `sources` retrieved *in that request* — a dangling citation is an automatic fail.
- **Two gears.** `depth: "quick"` (default; caps 8 tool calls/90 s) vs `"deep"` (24/240 s, `DEEP_DAILY_CAP` per user → `429`). Only deep may call `plan_research`; the server never upgrades depth itself. Filter the tool list by depth before the model call — a prompt instruction is not a gate. Deep must emit `plan` (3–6 sub-questions) *before any retrieval*, tag every trace step and source with its `subQuestion`, and merge all results into one contiguous citation numbering (dedupe by URL / docId+locator).
- **Fail loud.** Provider exception → `502` + `terminated: "error"`. Never a try/catch returning a plausible answer. Cap hit → honest partial + `terminated: "cap"`, never `"done"`.
- **Async ingestion.** Document upload → `202` in <300 ms → `jobs` row → worker (separate process/thread: parse with `pdfjs-dist`, chunk with locators `{page|heading|line}`, embed, upsert) → **read-your-write probe** against the vector index → only then `indexed`. Worker claims jobs with atomic `findOneAndUpdate`; a sweeper reclaims stale `running` rows.
- **Retrieval is hybrid:** `$vectorSearch` + Atlas `$search` (BM25) fused with RRF; `spaceId` filter must live *inside* `$vectorSearch` (a later `$match` silently leaks across Spaces).
- **Search cache:** in-process LRU + `searchCache` collection (TTL), key = sha256(normalized query + provider).
- **Run logs:** every answer writes `runs/<requestId>.json` (`tokens, wallClockSec, costUsd, terminated, depth, toolCalls[{name, ok, error}]`) — the quality gates read these. Deliberately-failed runs go in `runs/failing/`, never `runs/` (rule A2 fails any non-`done` run in `runs/`).

## Decided architecture & deployment (see ARCHITECTURE.md for full rationale)

- **No agent framework.** The loop is hand-rolled directly over `@anthropic-ai/sdk` (tool-use message loop). No Google ADK, LangChain/LangGraph, or Vertex AI Agent Engine — the assignment grades *owning* the loop ("Own a real agent loop, not a framework's"), the fixed SSE contract (trace/sources-before-token/done semantics, run logs, budget accounting, explicit `terminated`) requires direct control of every turn, and ADK is Python/Java-first which would break the one-language TypeScript stack and the typecheck gate.
- **LLM:** direct Anthropic API, `claude-sonnet-5` (matches `.env.example` and `sla.json`'s cost model). Embeddings: OpenAI `text-embedding-3-small`. Search: Tavily, env-swappable to SerpApi.
- **Cloud:** GCP, region `europe-west2`. Both services on **Cloud Run**: `lumina-gateway` public (serves `web/dist`, so one URL serves `/` and `/evals`); `lumina-agent` **`--no-allow-unauthenticated`** — only the gateway's service account holds `run.invoker`, gateway mints IAM ID tokens. Keys live in **Secret Manager**, mounted into the agent only.
- **Worker:** co-located in the agent container as a supervised child process; agent runs with **instance-based billing (`--no-cpu-throttling`), min 1 / max 1** — request-billed Cloud Run throttles CPU outside requests and silently freezes a polling loop.
- **Atlas:** M0 free tier on GCP europe-west2; public access list + SCRAM/TLS (M0 has no private endpoints). Run logs go to the Mongo `runs` collection (Cloud Run filesystem is tmpfs); `scripts/export-runs.mjs` bridges to the grader.
- **CI/CD:** GitHub Actions with Workload Identity Federation (no JSON keys) → Artifact Registry → agent-first no-traffic deploys with smoke-gated promotion. PR workflow runs contract build, typecheck, lint, `quality/check.mjs`.
- **Containers:** two multi-stage Dockerfiles at repo root (context = repo root, npm-workspace aware: contract builds first; runtime images preserve the monorepo layout so provided `env.ts` relative paths work unedited).
- Module layout for both services (hexagonal ports & adapters, tool registry with `forDepth()` filtering, repository per collection, job state machine) is specified in ARCHITECTURE.md §2 — follow it.

## Gotchas that cost time

- `npm run typecheck` fails with "Cannot find module '@lumina/contract'" until you build the contract package once.
- SSE buffering: disable compression on the ask route, `res.flushHeaders()`, flush after every write, `X-Accel-Buffering: no`.
- Atlas Search indexes are eventually consistent — "upserted" is not "searchable"; `bench.mjs` refuses to run if `/health` says db is not ok.
- The deep-search cap belongs in the agent service, not the gateway (a cap on the edge can be bypassed by hitting the agent directly); in deploys, the agent service must not be publicly reachable.
- `web/dist/`, `runs/`, `reports/`, `.env` are git-ignored and must never be committed.

## Repo conventions

- Git commits: no Claude co-author trailer; commit messages are attributed solely to the repo owner.
