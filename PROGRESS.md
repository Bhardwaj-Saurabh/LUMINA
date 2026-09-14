# PROGRESS.md — LUMINA delivery tracker

> Single source of truth for project state across sessions. Maintained via the
> `lumina-track` skill. A milestone is ✅ only when its **EDD proof** column holds a real
> result (a gate that ran), never on inspection. Update this file in the same commit as the
> work it describes.

## Status

| | |
|---|---|
| **Current milestone** | M9 — OPEN at 15/16 caps (M10 ◐: deployed and serving, Vercel pending) |
| **Blockers** | **`ttft p95` FAILS: 4666 ms against a 2500 ms gate** (client-side, latest deployed full bench; 2659 / 2686 / 4666 across three runs). Transport is measured at ~107 ms from a laptop vs ~68 ms in-region, so this is REAL service latency, not a measurement artifact — two sequential model completions, ~1.9 s at p50. See "M9 — full bench run 3". |
| **Last gates run** | 2026-09-14 11:00Z deployed full bench (`--target` the Cloud Run gateway): **15/16 caps, `pass:false`, exit 1** — everything green except `ttft p95`. Earlier the same day: eval ladder `--deploy-url` **stopped at Gate 2** on the same cap (Gates 0/1 pass). `quality/check.mjs .` 0 errors, 1 warning (A3), exit 1. |
| **Deploy state** | **Fully deployed.** Submitted URL: **https://lumina-theta-woad.vercel.app** (the provided UI, unmodified, built with `VITE_API_URL` = the gateway). Backends on Cloud Run europe-west2: `lumina-agent` IAM-gated, `lumina-gateway` public at `https://lumina-gateway-iwc6fhv5oa-nw.a.run.app`. CI/CD green end to end; evals report published and served. Verified from the Vercel origin end to end: preflight 204, then `trace → sources → token → done`. |

## Milestones

Legend: ☐ not started · 🔨 in progress · ◐ partly done (some gates open — never a hedged ✅) · ✅ done (EDD proof recorded)

| ID | Scope | TDD surface | EDD proof (gate / bench caps) | Status |
|----|-------|-------------|-------------------------------|--------|
| M0 | Scaffold verified: `npm install`, contract builds, typecheck clean | — | `npm run typecheck` exit 0 (2026-09-09) | ✅ |
| M1 | `.env` filled; `node scripts/create-indexes.mjs` run; 3 search indexes queryable | — | 2026-09-11: `--status` → memories_vector, chunks_vector, chunks_text all READY (queryable); `/health` db ok against Atlas | ✅ |
| M2 | Quick vertical slice: `POST /threads`, ask loop (web_search + fetch_page), SSE `trace→sources→token→done`, SourceCollector, budget, run log | budget, sourceCollector, citations units; loop test w/ fake ports + collecting emitter; ask route supertest | 2026-09-13 via :8787 — all 4 `contractProbes` ✓ (401/404/400, `/evals` not 401); web workload 5/5 answered, 0 errors; sources precede first token; 6 `runs/*.json` read by `quality/check.mjs` → 0 errors. **Smoke cannot COMPLETE until M7** (it runs the RAG phase and 501s on `POST /spaces`) | ✅ (functionally; smoke completion deferred to M7) |
| M3 | Two-tier search cache (LRU → `searchCache` TTL) | cache key sha256, decorator hit/miss units | 2026-09-13 live: repeat query → `searchCached: true`, TTFT 2554→1077 ms; 27 unit tests. Bench-workload hit rate awaits a completing bench (M7) | ✅ |
| M4 | Threads + messages persistence; follow-ups see the thread | threads/messages repo units; getThread route test | UI thread reload; bench web workload green | ☐ |
| M5 | Memory: save/recall tools, `GET /memory`, `DELETE /memory/:id`, cross-thread effect | memory tool units w/ fake embeddings; route tests | 2026-09-13 live: thread A `save_memory` ✓ → `GET /memory` lists it → fresh thread B calls `recall_memory` FIRST and answers in the saved style → DELETE 204, re-DELETE 404, foreign 404, list empty. 29 unit tests | ✅ |
| M6 | Gateway complete: auth 401, zod 400, rate limit 429, IAM-ready proxy, SSE pass-through, upload pipe, `/evals` SPA route | middleware units; askProxy stream test; 413 test | 2026-09-13: 39/39 gateway tests; live through :8787 — 401/400/404 probes correct, SSE streams trace→sources→token→done, one requestId greps both logs | ✅ (upload proxy deliberately 501 until M7) |
| M7 | RAG: spaces, upload 202 <300 ms, jobs worker (lease+sweeper), pdfjs page-aware parse, chunk+locators, embed, hybrid RRF, read-your-write probe, `search_documents`, mode router | chunker/locator, RRF, jobState, ingest-pipeline, retrieve, docTools, spaces routes, upload route (98 tests) | 2026-09-13 `bench --smoke`: `accept202` 202 in 120–152 ms ✓ · `indexedViaWorker` 4/4 ✓ · `pageLocator` ✓ · `routerPicksDocs` ✓ (live: mode=auto reached for the Space) · recall@5 3/3 smoke, **39/39 = 1.000 over the full gold set** ✓ · grounding 1.0, 0 dangling | ✅ |
| M8 | Deep search: plan-first, concurrency-3 fan-out, merge/renumber, subQuestion tags, DEEP_DAILY_CAP 429 + resetsAt, quick-never-escalates, `/stats` | planner validation, deepCap ledger, deep orchestrator w/ fake ports, deep+stats routes (41 tests) | 2026-09-13 live via :8787 — `deepPlan`: plan is frame 0, 6 sub-questions, plan in **1867 ms** (gate 4000) ✓ · `deepAttribution`: every retrieval step and all 22 sources tagged, numbering contiguous ✓ · `deepReadsMore`: 22 vs 5 distinct = **4.4x** (gate 2.0) ✓ · `deepBudget`: $0.0062 (gate 0.35), 7 steps (gate 24) ✓ · `deepCap429`: 6th deep → 429 with `resetsAt`, quick unaffected ✓ · `quickNeverEscalates`: no `plan_research` in any quick trace ✓ · `/stats` contract-valid | ✅ |
| M9 | Full local proof: bench exit 0 vs sla.json; quality exit ≤ 1; failing trajectory in `runs/failing/`; `/stats` route; `sla.json` `cost_model` re-declared with real Azure rates. **Carries the one open SLA item: ttft p95** | regression tests for every gate failure found | `node benchmark/bench.mjs` exit 0 · `node quality/check.mjs .` exit ≤ 1 | ☐ |
| M10 | Containerize (2 Dockerfiles), Cloud Run deploy (agent IAM-gated), Vercel UI, indexes on Atlas, deployed eval, report published, `/evals` renders | image smoke (USER node, ports, worker supervision) | `eval/eval.mjs --deploy-url` all gates; `/evals` on the Vercel URL renders the real report | ◐ |

**M9 ☐ — 15/16 caps.** Only `ttft p95` is open (2659 / 2686 / 4666 client-side across three
deployed runs; 2032 / 2587 / 2910 agent-side). Cause measured, fixes rejected with numbers, no
honest code change left. `quality/check.mjs .` exits 1 (0 errors, 1 warning: A3 tool thrash,
which is deep fan-out issuing one `web_search` per sub-question against a declared cap of 4 —
`quality/` is a provided folder and the cap stays).

**M10 ◐ — deployed and serving; two items open.** Done and verified live: both images, Cloud Run
`lumina-agent` (IAM-gated, `--no-allow-unauthenticated`) + `lumina-gateway` (public), CI/CD green
end to end (verify → candidate at no traffic → IAM smoke → promote → gateway → public smoke),
Atlas indexes, the run-export → quality → build-report → publish chain, and
`GET /evals/report.json` answering 200 with the strong ETag, `Cache-Control` and
`X-Published-At`, 304 on revalidation, `/evals` rendering the real report. The UI is live on
Vercel at **https://lumina-theta-woad.vercel.app** — the submitted URL — and a full answer
streams over that exact path (preflight 204 with the origin echoed, then
`trace → sources → token → done`); an unknown origin gets no `Access-Control-Allow-Origin`.

Still open, and the reason M10 is not ✅: **the eval ladder stops at Gate 2 on `ttft p95`**, so
"all gates" is not met.

Vercel builds from the REPO ROOT via a new root `vercel.json`, not from `web/`: the UI depends on
the `@lumina/contract` workspace, which must be built first, so `web/vercel.json` is not the
config Vercel reads. Its SPA rewrite is mirrored verbatim in the root file — without it `/evals`
404s on the hard refresh the grader uses. Two things the Vercel CLI did that needed undoing: it
wrote `.env*` into `.gitignore`, which would have covered the tracked `.env.example` that Gate 0
checks for (narrowed to `.env.local`), and `vercel git connect` needs a GitHub login connection
on the Vercel account, so UI redeploys are `npx vercel deploy --prod` by hand. `web/` is
untouched.

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
| 2026-09-12 | **M2 batch 5 — FIRST LIVE ANSWER.** Azure OpenAI adapter (LlmPort, signal forwarding), Tavily adapters, Mongo repos (threads/messages/runs/requests), `runAsk` assembly (recording emitter → runlog file+Mongo, requests row, message persistence), index.ts composition. Live: `curl -N` streams trace→sources→token×107→done, all [n] resolve, $0.0017/answer. TWO REAL BUGS found by real runs and fixed with a regression test: invalid AZURE_OPENAI_API_VERSION in .env (→ 2024-10-21), and a hung provider turn running 295 s past the 90 s cap → deadline AbortSignal on every provider call, abort maps to cap never error (loop test i). Placeholder tool schemas → real JSON schemas (model no longer guesses args). Both genuine failures kept in `runs/failing/` as P1 candidates | 96/96 ✅ | quality exit 1 ✅ (run log read; A2 clean) · live ask ×2 ✅ | Gateway (M6) so bench --smoke can run through :8787 and formally close M2; then M3 cache | TTFT ~8 s vs 2.5 s target — §9.1 optimization pass pending (research turns dominate); searchCached hardwired false until M3 |
| 2026-09-13 | **M6 gateway**: `middleware/rateLimit.ts` (token bucket, per-user, Retry-After), `proxy/client.ts` (AgentClient + Cloud Run IAM idToken seam, streams `res.body` without reading it), `app.ts` (ROUTES-driven auth, zod 400, verbatim JSON proxying, byte-identical SSE pipe, truthful health incl. relaying a self-reported-sick agent as 503), index.ts composition. Agent gains the §10 per-answer pino line. THIRD live bug found end-to-end: gateway aborted every upstream in 0 ms because `req.on('close')` fires when the request BODY is read (Node ≥16), not on client disconnect → moved to `res.on('close')`, regression test pinned with a signal-honouring slow fake | gw 39/39 ✅ | quality exit 1 ✅ · live ask via :8787 ✅ · requestId in both logs ✅ | Streaming-refactor green (test-writer already rewrote loop.test.ts), then bench --smoke through :8787 to close M2 | TTFT 4.9–5.6 s via gateway (was 8.2 s direct) — still > 2.5 s until the refactor lands; upload proxy deliberately 501 (no tests yet, needs streaming multipart) |
| 2026-09-13 | **Streaming-turn refactor** (§9.1 TTFT pass): `LlmPort.streamTurn` replaces runTurn+streamText in the loop — the answer IS a turn, so the model's final text is streamed instead of generated, discarded, and re-generated. Optimistic streaming (first delta with no tool call ⇒ finalize collector, emit sources, stream tokens); capped finish makes one tool-free turn; mixed narration+tool-call is dropped with a visible ok:false trace. Azure adapter accumulates tool-call fragments by index. Implementer caught an API constraint no fake could: OpenAI rejects an assistant message with tool_calls lacking matching tool responses, so refused calls now get ok:false results in the transcript | 100/100 agent + 39/39 gw ✅ | live via :8787 ✅ | `bench --smoke` through :8787 = M2's EDD proof | **TTFT 8.2s→4.0-4.2s, cost/answer roughly halved** (one fewer round trip, answer generated once). Still >2.5s target: remaining budget is ~1.4s per decision turn + search latency |
| 2026-09-13 | **M2 + M6 closed on real evidence.** `bench --smoke` through :8787: 4/4 contract probes ✓, 5/5 web queries answered with 0 errors, run logs written and read by the quality kit (0 errors). DISCOVERY: `--smoke` also runs the RAG phase, so it cannot complete until M7 — the lumina-edd milestone→proof map claimed smoke proves M2 and has been corrected rather than worked around | 100 agent + 39 gw ✅ | probes ✓ · workload ✓ · quality exit 1 ✅ · smoke blocked at runRag (honest: NOT a pass) | M3 search cache, then M7 RAG (which unblocks a completing smoke) | bench exit code not captured (piped to tail); the crash itself is unambiguous in the console output |
| 2026-09-13 | **M3 search cache** (27 tests): `infra/lru.ts` (true LRU), `providers/search/cached.ts` (sha256 key over normalized query+provider, L1→L2→provider, expiry enforced on READ at both tiers since Mongo's TTL sweeper lags, in-flight dedupe, time-sensitive bypass), `repos/searchCache.ts`; wired per-request (stats isolated) over one process-wide LRU, so `searchCached` is finally honest. Also: gateway upload proxy finished (streams multipart, 413 from the cap) — M6 fully done. FINDING: cache hits initially looked broken because the MODEL rephrases its search each run (two keys, two paid searches); a system-prompt nudge to reuse the user's wording fixed it | 168 (127 agent + 41 gw) ✅ | live: cold 2554 ms miss → warm 1077/2065 ms hits, `searchCached: true` ✅ | M5 memory (vector index already live), then M7 RAG | **TTFT now at/under the 2500 ms SLA on repeats** (was 8.2 s at session start). Zero searches ⇒ allHits false; an in-flight join counts as a miss — both keep `searchCached` honest |
| 2026-09-13 | **M5 memory** (29 tests): `providers/embeddings/{port,azureOpenai}.ts` (always sends `dimensions: 1536` — the deployment is text-embedding-3-large, native 3072 — and sorts the batch by `index`, which the API does not guarantee), `core/tools/memoryTools.ts` (userId comes from request context, never model input — a hostile `{userId}` in tool args is stripped), `repos/memories.ts` ($vectorSearch with `filter:{userId}` INSIDE the stage; delete filters on owner so foreign reads as unknown), memory routes, and SYSTEM_PROMPT guidance so the model actually recalls in a fresh thread | 197 (156 agent + 41 gw) ✅ | live cross-thread recall ✓ · delete 204/404/404 ✓ · list empty after ✓ | M7 RAG: spaces, upload→202, jobs worker, pdfjs, chunking, hybrid RRF, read-your-write probe | Embeddings path now proven live, which de-risks M7's biggest unknown |
| 2026-09-13 | **M7 RAG** (98 new tests, 302 total): `core/rag/{chunker,rrf,jobState,ingest,retrieve}.ts`, `core/tools/docTools.ts`, `repos/{spaces,documents,chunks,jobs}.ts`, `infra/gridfs.ts`, `providers/parse/pdf.ts`, `http/{uploadRoute,app}.ts` (multer→GridFS streaming storage engine), `worker.ts` + `workerSupervisor.ts` (child process, `--no-cpu-throttling` shape), mode router in `runAsk`. **bench --smoke completed for the first time** | 302 (258 agent + 44 gw) ✅ | smoke: accept202 ✓ · indexedViaWorker 4/4 ✓ · pageLocator ✓ · routerPicksDocs ✓ · recall@5 3/3 (39/39 full gold) · grounding 1.0 · **✗ ttft p95 3060 ms** | M8 deep search; ttft p95 to M9 | Three live-only bugs — see notes below |
| 2026-09-13 | **M8 deep search** (44 new tests, 348 total): `core/deep/{planner,deepCap,orchestrator}.ts`, `repos/{deepUsage,stats}.ts`, deep admission + `GET /stats` in `http/app.ts`, both gears assembled in `runAsk` (deep gets its own envelope: 24 calls / 240 s / $0.35). `SourceSink` + `taggedSink` refactor so each sub-question's tools mint pre-attributed sources. Plan-prompt brevity pass: **plan 3376→1867 ms, cost/deep answer halved, end-to-end 22.6→11.4 s** | 348 (304 agent + 44 gw) ✅ | all six deep caps proven live (see M8 row) · quality exit 1 | M9: full bench exit 0; re-declare `sla.json` cost_model with real Azure rates; ttft p95 | Attribution is structural, not remembered; audit caught an all-branches-failed hole — see notes |
| 2026-09-14 | **TTFT investigation** (plan-driven): `core/timings.ts` per-turn instrumentation; H3 speculative `prewarm` (join counted as a miss); H2 `recall_memory` offered only when the user HAS memories; bounded thread history (8); 1500 chars of provider content to the model. Rejected on measurement: H1 `reasoning_effort` (no gain), H5 nano research model (2.7x slower + duplicate calls), H4 700-char cap (worse) | 344 ✅ | `bench --smoke` ttft p95 3060 → 2354 ✅ | full bench + cost model | Every lever behind a flag, measured on one fixed workload before/after |
| 2026-09-14 | **M9 cost + full bench**: `sla.json` `cost_model` re-declared with real Azure rates (the one sanctioned edit); prices mirrored in `env.ts`. Three local full benches 14/16 → 15/16; found unbounded thread history tripping the deployment's TPM quota (8/40 answers died as 429s) and spurious memories saved from questions → structural `memoryGate.ts` | 344 ✅ | full bench ttft p95 6481 → 3780 → 2880, still ✗ | M10 containerize | Real cost: $0.0036/quick, $0.0113/deep |
| 2026-09-14 | **M10 containerize + deploy**: two multi-stage Dockerfiles (repo-root context), `tsconfig.build.json` so tests stay out of `dist`, Cloud Run europe-west2 (agent `--no-allow-unauthenticated` + IAM ID tokens from the metadata server, gateway public), Secret Manager, Workload Identity Federation, `pr.yml`/`deploy.yml`, `repos/reports.ts` + `ops/{publishReport,exportRuns}.ts` | 397 ✅ | deployed smoke ✅ (ttft p95 2333) | deployed full ladder | `num('')` was 0 → an empty env var meant port 0; found smoke-testing the image |
| 2026-09-14 | **Deployed eval ladder ✗ Gate 2** at ttft p95 **66259 ms**. Diagnosed from our own timings (two turns of ~32 s at `toolsMs: 0` = a sleep): the openai SDK honours Azure's `Retry-After: 30` INSIDE `completions.create`, un-abortably. Replaced with our own bounded (4 s cap), abortable, logged retry — `providers/llm/retry.ts` — on both the chat AND embeddings clients | 356 ✅ | re-run: ttft p95 66259 → **3763**, no retry fired ✗ (gate 2500) | close the last cap | Quota probe showed 149/150 requests free: shared-subscription pressure, not our load |
| 2026-09-14 | **CI/CD green end to end** for the first time (verify → agent candidate at no traffic → IAM smoke → promote → gateway → public smoke), after `fc17fdd` fixed `npm test` ENOENT on a fresh checkout | 356 ✅ | deploy ✅ | deployed full bench | The previous deploy had failed at `verify`, so the 10:02Z eval ran against the older revision |
| 2026-09-14 | **Deployed full bench ×3.** Run 1 14/16 (ttft 2659, `202 accept` 943 — Cloud Run's own logs said the server answered in 66–74 ms, so that one was the measuring laptop; CPU was 1.4–7.8 %, killing my contention hypothesis). Run 2 14/16 (202 back to 130 ✓, deep ratio 1.69 ✗). Run 3 **15/16** | 365 ✅ | 15/16, `pass:false` — only ttft ✗ | – | Hedging turn 1 rejected on its own numbers: 26 % of calls for 173 ms |
| 2026-09-14 | **Deep gear made deeper per search**, not just wider: `SearchOptions{maxResults,depth}` port → Tavily → tool, chosen by gear in `runAsk`; cache keys on the shape so quick's rows never serve deep. Declined `search_depth:'advanced'` — 2 credits against a cost_model we may not edit that prices 1 | 365 ✅ | deep/quick source ratio 1.69x → **5.11x** ✅ | publish chain | The adapter had ignored the `opts.maxResults` its own port declared since day one |
| 2026-09-14 | **Publish chain + gateway header relay**: 90 deployed runs exported → quality 0 errors/1 warning → report 82/85 automated → published. Verifying over HTTP found the gateway's JSON proxy discarding every upstream header, so the agent's ETag/`X-Published-At`/304 contract was dead in production despite passing agent tests | 422 ✅ | `/evals/report.json` 200 + strong ETag + 304 ✅ | Vercel (owner) | Red-line audit then caught the Status block still claiming "ttft p95 closed, blockers none" — corrected |
| 2026-09-14 | **Vercel: the submitted URL is live** — https://lumina-theta-woad.vercel.app. Root `vercel.json` builds from the monorepo root (contract first) and mirrors the provided SPA rewrite; `web/` untouched. Gateway `CORS_ORIGINS` updated to admit the Vercel origin (CI only swaps images, so runtime env survives a deploy) | 422 ✅ | preflight 204 + full `trace→sources→token→done` from the Vercel origin ✅; unknown origin refused ✅ | `ttft p95` is the only open cap | Narrowed the `.env*` rule the Vercel CLI wrote into `.gitignore` — it would have covered the tracked `.env.example` |
| 2026-09-14 | **Measured the client-side claim instead of asserting it** (user challenge: the laptop is not the client). Paired each request with its own agent-recorded `ttftMs` via a chosen `x-request-id`, 12 quick answers from the laptop vs 12 from a Cloud Run job in europe-west2: transport **107 ms** vs **68 ms** p50. My earlier "the gap is the laptop" claim was wrong — it had compared p95s of two different answer pools. `ttft p95` is REAL service latency. Also re-measured nano at n=30 (no win) | 422 ✅ | transport ~100 ms, immaterial | – | Probe job + image deleted after; Compute API left disabled (used Cloud Run Jobs instead of a VM) |
| 2026-09-14 | **Gateway kept warm**: `lumina-gateway` had no `minScale` and was scaling to zero, so the first request after idle paid a container cold start — evidenced by repeated startups in its logs and a first-request latency of ~311 ms against ~45 ms warm. Set `--min-instances=1` (the agent already had it). Does NOT move the bench p95, which warms the gateway on request one; it is what a grader pays opening the Vercel link cold | – | n/a (infra) | – | Costs one always-on 1 vCPU / 512 MiB instance at Cloud Run's idle rate |

### M7 findings — three bugs only a live run could surface

1. **The rate limit was throttling the grader, not an abuser.** 30/min flat was tighter than
   the bench's own workload (40 web + 30 doc queries at concurrency 4, plus document-status
   polling every 1.2 s), and every 429 counts against the error-rate SLA. Fixed by making the
   limiter *weighted* — an answer or an ingest costs 5 tokens, a status poll costs 1 — so
   polling stays cheap without leaving the expensive path unguarded. 3 new gateway tests.
2. **The model could answer without retrieving at all.** Asked a gold question whose answer
   sat in an indexed Space, it called `recall_memory` and then answered from its own weights:
   `sources: []`, a confidently ungrounded answer, and a run that fails the rubric's
   `retrievalRate >= 1`. Optimistic streaming means the first token is already on the wire
   before this is detectable, so the fix had to be in the request: until something has been
   retrieved, `tool_choice: 'required'`. Forcing *a* tool was not enough — offered everything,
   the model picked the cheapest one (recall@5 actually FELL to 0.897) — so a turn that comes
   back without a retrieval call narrows the offer to retrieval tools only. Recall and search
   still share one turn, so memory costs no extra round trip.
3. **Tool calls were unbounded.** A Mongo pool reset made `web_search` hang and a request
   streamed its first token **230 seconds** into a 90-second gear. LLM turns had a deadline
   since M2; tool dispatch did not, so nothing in the request was actually bounded. Each
   dispatch now races the remaining budget and the signal is handed to the tool.

Also: fixing (2) regressed M5 — the forced search satisfied the model and it stopped recalling
across threads, failing `memoryRecalled`. Caught by replaying the grader's exact memory
scenario rather than trusting the unit tests, and fixed in the prompt (recall governs *how* to
answer, so it belongs in the first turn alongside the search, not in a turn of its own).

### M8 notes — what made deep search work

**Attribution is structural, not remembered.** `deepAttribution` requires every retrieval step
AND every source to carry its `subQuestion`. Rather than passing an index through every tool
and hoping none forgets, each sub-question researches through its own registry built over a
`taggedSink` — a view of the one shared `SourceCollector` that stamps the sub-question on
everything minted through it. No tool knows sub-questions exist, and none can produce an
untagged source. The shared collector is also what makes the merge free: dedupe by URL /
docId+locator and contiguous numbering already lived there, so "merge the fan-out" is just
"they all wrote to the same collector", and a source found by three sub-questions keeps the
first one that found it.

**The spend gate is an HTTP status, not a stream frame.** By the time the SSE sink exists the
request has been accepted; a client that asked for a deep search would have to parse an error
frame to learn it never got one. So admission happens in the route — after ownership, so
probing someone else's thread cannot burn your allowance — and the ledger row is written at
ADMISSION, not completion. Counting finished deep searches would let a user start `cap + 1`
at once and discover the cap afterwards, which is the one moment it needed to work.

**The audit caught a laundered exception.** One sub-question failing is an honest partial —
the others finish and the answer is grounded in what did arrive. But if EVERY sub-question's
provider turn threw (a correlated failure: an Azure 429, a network reset), the first cut
emitted `sources: []`, let the model write its "nothing was retrieved" prose, and reported
`terminated: "done"` with a 200 — a provider exception turned into a plausible answer, which
is precisely rule A1's failure mode. Now an all-branches-failed fan-out is a 502 naming each
sub-question's error, while a budget exhaustion stays an honest `cap`. Two related fixes came
with it: a research turn that threw before any tool ran no longer fabricates a `web_search`
entry in the graded run log, and a sub-question that retrieved nothing is named in the
evidence digest so the answer discloses the gap instead of covering it from memory.

**A prompt change bought more than any code change.** The planner was emitting paragraph-long
sub-questions: 3376 ms to first paint against a 4000 ms gate, and poor search queries into the
bargain. Asking for one short line each — phrased the way you would type it into a search box —
took the plan to 1867 ms, halved the cost per deep answer, and halved end-to-end latency,
because shorter sub-questions are also better queries.

### TTFT investigation (2026-09-14) — Phase 0 baseline, before any lever

Instrumented per-turn timings (`core/timings.ts`, on the log line and `requests` row, off the
contract). Fixed workload: 5 smoke web queries cold + the same 5 repeated + 20 gold doc questions
(concurrency 3) + the grader's memory scenario. Client-side TTFT via the provided bench helpers,
joined to the agent log by `requestId`.

| phase                              |  p50 |  p95 |   max |
|------------------------------------|-----:|-----:|------:|
| client TTFT, all 30 quick          | 2716 | 7609 | 13186 |
| · web cold (Tavily miss)           | 3427 | 5075 |  5075 |
| · web repeat (cache hit 4/5)       | 2357 | 3005 |  3005 |
| · docs                             | 2699 | 7609 | 13186 |
| gateway + network (client − agent) |   47 |   73 |    75 |
| `turn1Ms` (decision turn)          | 1465 | 4040 | 12201 |
| `toolsMs` (before the answer)      |  229 | 1476 |  1782 |
| `answerFirstDeltaMs`               |  785 | 3306 |  3575 |

turnCount: 27 × 2 turns, 3 × 3 turns. Guards: 0 errors, retrievalRate 30/30, memoryRecalled ✓,
cost $0.00106/answer.

Findings that change the plan:
- **`reasoning_effort` is not the lever.** Probe against the deployment: the parameter is accepted
  (incl. `minimal`) but the default already runs at that speed — tool-turn first token 464–990 ms,
  answer turn 747–1307 ms at every level. The floor is ~0.8–1.0 s per round trip.
- **The tail is Azure's, not ours.** 8 concurrent tool turns: 0 retries, all HTTP 200, medians
  ~900 ms, one at 3761 ms. The 12 201 ms decision turn in the baseline had the same token counts
  as its neighbours. A p95 over ~75 answers tolerates ~3 such outliers; more than that and no
  code change helps.
- **The second tool call on turn 1 costs ~400–500 ms.** Turn 1 with `recall_memory` + search is
  1.3–1.5 s median vs 0.8–0.9 s with one call — output tokens on the critical path (H2's target).
- **Web cold pays Tavily serially after turn 1** (`toolsMs` p95 1476 on those) — H3's target.
- Gateway overhead 47–73 ms: transport ruled out.

**Levers measured (same fixed workload, 30 quick answers each):**

| lever                     | ALL p50 | ALL p95 | web-cold p50 | docs p50 | turn1 p50 | turns | guards |
|---------------------------|--------:|--------:|-------------:|---------:|----------:|-------|--------|
| baseline                  |    2716 |    7609 |     3427*    |     2699 |      1465 | 27×2, 3×3 | all ✓ |
| H2 recall only if memories|    1818 |    3379 |     1611*    |     2120 |       911 | 30×2  | all ✓, cost −15 % |
| H2, genuinely cold web    |    2116 |    6004 |     3465     |     1905 |       810 | 27×2, 3×3 | all ✓ |
| H2 + H3 prefetch          |    2142 |    7234 |     3344     |     1964 |       864 | 25×2, 4×3, 1×4 | all ✓ |
| H2 + H3, web-only diag    |       — |       — |   **2594**   |        — |         — | 4×2, 1×3 | all ✓ |
| **H2 + H3 + H9**          |**1730** |**2854** |   **2431**   | **1729** |       838 | **30×2** | all ✓ |

\* the smoke queries were already in the 6 h L2 cache — not a real cold measurement (fixed by
rotating unused slices of `queries.web`).

- **H2 kept (unconditional).** A user with nothing to recall is not offered `recall_memory`. The
  decision turn drops 1465 → ~850 ms (the second tool call's output tokens), the 3-turn
  "recall instead of search" shape disappears, `memoryRecalled` still ✓ (that user HAS a memory).
- **H3 kept (flag `SEARCH_PREFETCH=1`).** The model used the user's wording verbatim in 10/10
  web queries, so the prefetch is reused every time — as an in-flight join, or as an L1 hit when
  Tavily finished before the model asked. Cold web p50 3465 → 2594. A join is counted as a
  miss, so the cache-hit SLA cannot be inflated by it.
- **H9 kept: the model reads the content Tavily already returned.** Tavily `basic` hands back
  ~1300 chars per result; the adapter sliced it to 500 before the model saw it, and the model
  fetched pages to read the rest. The source snippet is unchanged (grounding and the UI); the
  model gets up to `SEARCH_RESULT_MODEL_CHARS` (1500) plus a prompt line that one search
  normally suffices. Result on the same workload: **every answer two turns (30/30)**, web-cold
  p50 2431, overall **p50 1730 / p95 2854 / max 4358** vs baseline 2716 / 7609 / 13186.
  Guards: 0 errors, retrievalRate 30/30, repeat cache hits 5/5, memoryRecalled ✓, $0.00103.
- **Smoke bench after the levers: ✓ passed, exit 0** — ttft p95 2354 ms (was 3060), every
  other row unchanged or better. H1 (`reasoning_effort`) measured and dropped: no gain over the
  default on this deployment, so no knob was added. The full bench is M9's gate; the p95 there
  pools ~75 answers and tolerates ~3 Azure tail outliers, which is now the remaining risk.
- **What set the p95 before H9: extra retrieval turns.** 30–50 % of fresh web answers went
  `web_search → fetch_page` or `→ web_search` before answering; each another ~1 s round trip
  plus its tool (3.5–4.5 s TTFT), ~10 of a 75-answer pool ⇒ they WERE the p95. H9 removed the
  shape by giving the model the content the provider had already returned.

### M9 (2026-09-14) — full bench, first two runs

**Cost model re-declared** (`benchmark/sla.json` `cost_model`, the one sanctioned edit there, and
`env.ts` to match): Azure gpt-5.4-mini $0.75 / $4.50 per MTok in/out, text-embedding-3-large
$0.13, Tavily $0.008 per basic credit. The scaffold's placeholder Anthropic rates had understated
cost ~2.5–3×; real figures: **$0.0049/quick, $0.0113/deep**, both far inside their caps.

**Quality case law filled** (`quality/rules.json` precedents — the file itself asks the cohort to
replace its TODOs): all ten rules now cite an incident from this project. P2 ✓.

**Full bench run 1: 14/16 rows green, two misses with one cause.** recall@5 30/30 · cache hit
93.8 % · every deep target (plan p95 3533, 3.56× sources, $0.0113) · grounding 0.981 · ingest
decoupling 0.32× · 202 accept 147 ms. ✗ ttft p95 6481 ms and ✗ error rate 11.1 %: the grader
asks all 40 web questions in ONE thread at concurrency 4, and every request prepended the whole
unbounded thread — input tokens climbed 6k → 14k per answer and 8/40 (plus one deep run) died
as the deployment's tokens-per-minute quota bit. Nine runs preserved in `runs/failing/`.

Fixes (338 tests): history bounded to the most recent `HISTORY_MAX_MESSAGES` (8); the error
text of a failed run is now logged and stored on the requests row (the nine failures had left
only `terminated: "error"` server-side); the prefetch no longer skips threads with history
(it had been off for the grader's whole web workload — `prefetch issued 0/40`); `save_memory`'s
contract forbids inferring interests from questions (the model had saved "the user is interested
in Atlas Vector Search" from a search topic, flipping `hasAny` and re-introducing the recall turn
for the next 36 answers).

Grader-shaped reproduction (40 web, one thread, concurrency 4): before → after —
answered 32/40 → **40/40**, errors 8 → **0**, max input tokens 14 262 → 5 463, turnCount all 2,
ttft p50 1789 / **p95 3000** (Azure per-turn tails under 4-way contention: turn-1 p95 1333 +
answer p95 1294). The 30 sequential doc answers dilute that in the real 75-answer pool.

A3 ("no tool thrash") warns on deep runs: 5–6 consecutive `web_search` is one search per
sub-question, not a retry loop. `expectations.json` declares `maxConsecutiveSameTool: 4` and
says a threshold set after seeing the score is not a threshold — so it stays, and the warning
is documented here rather than declared away.

**Full bench runs 2 and 3 (after the fixes):** 15/16 rows green each time; the one miss is
ttft p95, falling **6481 → 3780 → 2880 ms** (gate 2500). Run 3: 0 errors · recall@5 30/30 ·
cache hit 100 % · deep plan p95 2335, 3.22× sources, $0.0113 · grounding 0.985 · 202 accept
170 ms · $0.0036/quick. Between runs 2 and 3: a spurious memory (the model saving "the user is
interested in Atlas Vector Search" — later "prefers concise explanations" — inferred from
QUESTIONS, then attested `statedByUser: true` when the schema demanded it) kept re-introducing
the recall turn; prose and attestation both failed, so `save_memory` is now advertised only when
the message could carry a statement about the user (`core/tools/memoryGate.ts`: first person or
an explicit "remember"). H5 (a nano deployment for the decision turn) was measured and REVERTED
to opt-in: on this account it was ~2.7× slower (turn-1 p50 847 → 2309 ms) and issued duplicate
tool calls. What remains of the p95 is the `gpt-5.4-mini` answer turn's first delta at 3–4.7 s
under 4-way contention — provider tail, measured, not ours. Two more experiments, both
measured and NOT adopted: showing the model 1000 chars per result instead of 1500 made the
p95 worse (4715); the nano run itself left four more failed runs (3 × `read ECONNRESET`, 1 cap)
that are preserved in `runs/failing/` — a "faster model" is a hypothesis to measure, not a fact.
A3 note, precisely: one deep run made 7 consecutive searches with 6 sub-questions, so at least
one sub-question searched twice; still fan-out, not a retry loop, and still a warning.

### M10 (2026-09-14) — in progress

Built and verified locally: `Dockerfile.agent` / `Dockerfile.gateway` (multi-stage, repo-root
context, monorepo layout preserved; both workspaces now build with `tsconfig.build.json` so
tests stay out of `dist`), `.dockerignore`. Both containers pass a local smoke: `/health` ok,
the gateway serves `/` and `/evals` from `web/dist`, `/evals/report.json` is an honest 404
until published (never 401), `/memory` 401 without a user, and one real question streams
trace → sources → token → done across the two containers. Found on the way: `num('')` was 0
(a port of 0), so an empty env var now reads as unset in both services.

Code for the deployed shape: agent `GET /evals/report.json` reads the operator-published
artifact (`repos/reports.ts`, versioned, ETag, 304); `ops/publishReport.ts` validates a built
report against the contract's `EvalsReport` before storing it; `ops/exportRuns.ts` pulls the
deployed run logs out of Mongo WITH `depth` (the provided exporter drops it, and is a red
line). Gateway mints Cloud Run IAM ID tokens from the metadata server (`proxy/idToken.ts`,
cached to 60 s before `exp`, in-flight deduped, fails loud) when `AGENT_AUDIENCE` is set —
and `health()` now carries the token too; it was the one hop that did not, and would have
403'd against the gated agent. 15 new tests; 397 total (344 agent + 53 gateway).

GCP one-time setup done: Artifact Registry `lumina` (europe-west2), service accounts
`lumina-agent` / `lumina-gateway` / `lumina-deploy`, Secret Manager `MONGODB_URI`,
`AZURE_OPENAI_KEY`, `TAVILY_API_KEY` (agent SA is the only accessor), Workload Identity
Federation pool `github` + provider `github-oidc` scoped to `Bhardwaj-Saurabh/LUMINA`,
`.github/workflows/{pr,deploy}.yml` (agent first, no traffic, IAM-authenticated smoke, promote,
then gateway). Vercel: needs the owner's `npx vercel login`; the gateway serves the UI as the
fallback submission URL.

**Deployed eval run 1 (10:02Z) — Gate 2 FAIL: `ttft p95 66259ms`, `answer p95 67226ms`.**
Everything else on that run was green (grounding 1.0, error rate 0, recall@5 3/3, cost
$0.0026/quick, ordering ok, 0 dangling). Diagnosed from the agent's own timings rather than
guessed: two of the nine answers were throttled — one at `ttftMs 35416` (`turn1Ms 32441`, turn 2
first delta 2974) and one at `ttftMs 66166`, which paid it on BOTH turns (`turn1Ms 32888`, turn 2
first delta 33277) and so set the p95 on its own. Every one of those turns reports `toolsMs: 0`:
a turn that does ~1 s of work taking 32 s is a sleep, not a slow model. Cause: the openai SDK
(`node_modules/openai/core.js:138`, `:447`) retries twice by
default and honours Azure's `Retry-After: 30`, **inside** `completions.create`, with a sleep
that ignores the abort signal — so neither the request budget nor the tool deadline could see
or stop it, and the run log showed only "a slow LLM turn". A direct probe of the deployment
during the diagnosis (four back-to-back completions with the SDK out of the way, reading
`x-ratelimit-*` off the response) showed the quota healthy — 150 RPM / 150k TPM, 149 requests
remaining, `abusepenalty-active False`, 0.7–2.4 s per call — and the bench runs the smoke web
workload at concurrency 1 (`benchmark/bench.mjs:286`), so the throttle was shared-subscription
pressure on the Azure deployment, not our load. It is therefore expected to recur, at a time we
do not choose: the fix has to bound the damage rather than prevent the 429.

Fix (`providers/llm/retry.ts`, 12 tests): SDK retries off (`maxRetries: 0`); the policy is ours
and is **bounded** (cap `LLM_RETRY_MAX_WAIT_MS`, default 4000 — we decline Azure's 30 s),
**abortable** (the backoff loses the race to the request's signal), and **visible** (`onRetry`
→ a `llm retry` warn line with status, wait and reason). Non-transient statuses (400/401/403/
404/422) are not retried at all, an exhausted retry rethrows the provider's error untouched
(A1: a 502 with the real reason, never a plausible substitute), and only *opening* a stream is
retried — once deltas have been yielded a retry would replay tokens the client already has.
The same treatment went to the embeddings adapter, which had the identical SDK default and runs
*before* the first token (memory recall, RAG retrieval) — a throttled embedding call could have
burned 30 s inside TTFT with the chat path already fixed. Its port stays signal-free; bounding
is the part that matters there.

Trade-off, recorded as a prediction to be checked, not a result: a throttled answer should now
arrive ~4 s late instead of 66 s — one sample near the TTFT p95 instead of a blown gate — and if
every attempt is throttled the answer fails loudly instead of arriving a minute later. Note that
4000 ms is itself over the 2500 ms TTFT target by construction: a retried turn is a slow turn,
the point is only that it is now a *bounded* one.

**Deployed eval run 2 (10:20Z, revision `lumina-agent-00002-rul`) — ttft p95 66259 → 3763 ms.**
The prediction held. Gate 2 still FAILS (target 2500) but for a different and much smaller
reason: **no retry fired at all** this run — `llm retry` / `embeddings retry` appear nowhere in
the logs, so the provider was healthy and this is the un-throttled floor. Eight of the nine
answers landed 1312–2414 ms; a single docs answer at 3683 ms set the p95, and with nine samples
p95 *is* the max. Its timings show no pathology to fix: `turn1Ms 2810` for a 559-token call,
`toolsMs 189`, final-turn first delta 684. Just one slow completion. Everything else green
(grounding 1.0, 20/20 verifiable citations, error rate 0, recall@5 3/3, $0.0028/quick).

CI/CD also went green end to end for the first time on this push: verify → agent candidate at
no traffic → IAM-authenticated smoke → promote → gateway → public smoke. The previous deploy
(189f964) had failed at `verify` on the `runs/` ENOENT that `fc17fdd` fixes, which is why the
10:02Z eval ran against the older revision.

**Why the last ~1.3 s is provider-bound, measured rather than asserted.** Two experiments, both
of which said "do not build the thing you were about to build":

1. *Tail shape, over all 803 recorded answers* — turn 1 p50 911 / p90 1648 / p95 2284 / p99
   5594; final-turn first delta p50 766 / p90 1433 / p95 1906. TTFT is the sum of two such
   draws (plus tool time), which puts its p95 near 3.3–3.8 s structurally. Hedging turn 1 (fire
   a duplicate after H ms, keep the first to answer) is the textbook fix for a *rare* tail — but
   this body is merely WIDE, not spiky: H=1200 ms would fire on **26.3 %** of all calls to move
   turn-1 p95 by 173 ms, and H=800 ms on 68.4 %. Rejected on its own numbers, unbuilt.
2. *Is another deployment faster?* (Interleaved rounds per shape, so a slow minute hits both
   equally.) gpt-5.4 "large" is worse on both shapes: decision p50 2063 vs mini's 1361,
   answer-first-delta 1605 vs 893. gpt-5.4-**nano** was re-measured at n=30 after the throttling
   fix, because the first "2.7× slower" reading had been taken while the SDK was silently
   sleeping on `Retry-After` and was not trustworthy: decision turn **mini p50 1254 / p90 2040 /
   p95 2421** vs **nano p50 1968 / p90 2320 / p95 2331**. Nano is 714 ms worse at the median and
   a tie at the p95 the gate measures, and it threw a connection error mid-probe — no win.
   Mini stays; there is no faster path on this account.

   That probe also showed where the tail actually lives: mini's **answer-turn** first delta
   (p95 2931) is as big a contributor as the decision turn (p95 2421). The answer turn is where
   grounding and citations are produced, so it is not a place to put a smaller model — which is
   why "use a smaller model" has no version left that helps.

The honest conclusion: a **two-turn agent loop on this Azure deployment cannot reliably hold
ttft p95 ≤ 2500 ms**. The floor is two sequential completions (~1.9 s p50, and a p95 set by
provider variance we do not control). Closing the remaining gap would mean removing a round trip
from the critical path — i.e. hardcoding retrieve-then-generate instead of letting the agent
decide — which SPEC forbids and which is the opposite of what this assignment grades. Recorded
as a measured constraint; the threshold is not touched and the gate is reported as failed.

### M9 — full bench against the deployment, run 1 (ran 10:25–10:34Z) — 14/16 caps

First full bench ever run against the deployed stack. **Failed on two caps**, everything else
green: recall@5 30/30, cache hit 97.5 %, grounding 0.981 (211/215 verifiable, 0 dangling), error
rate 0, search during ingest 0.529× idle, all six deep caps (5–6 sub-questions, plan p95 2194 ms,
deep answer p95 20.3 s, 4.6× the sources of the same query run quick, $0.0111/deep), quick cost
$0.0034.

- `ttft p95 2659ms` (≤ 2500). The trend across fixes: 6481 → 3780 → 2880 → **2659**. The last
  ~160 ms is the provider variance analysed above, not a code path.
- `202 accept p95 943ms` (≤ 300) — **a regression that is not ours.** Cloud Run's own request
  logs for all five `POST …/documents` in that window: agent latency **66–74 ms**, gateway
  **87–93 ms**. The service answered every upload roughly 4× inside budget; the 943 ms was
  measured client-side on the laptop driving the bench (the same four files accepted in
  107–152 ms on the smoke run 30 minutes earlier). Checked before concluding: container CPU
  utilisation over the whole ingest window was **1.4–7.8 %**, so the co-located worker was not
  starving the request path — the hypothesis I started with, and the metric refuted it.

Both remaining failures are therefore dominated by variance outside the service (provider tail,
client network). Re-running once on that evidence — not to fish for a better draw, and this run
stands recorded either way.

### M9 — full bench run 2 (ran 10:37–10:43Z) — 14/16 caps, and a DIFFERENT pair

| cap | run 1 | run 2 |
|---|---|---|
| `ttft p95` | 2659 ✗ | 2686 ✗ |
| `202 accept p95` | 943 ✗ | **130 ✓** |
| `deep/quick source ratio (min)` | 4.6× ✓ | **1.69× ✗** |

Two things settled. The 202 cap came back at 107–114 ms on the same four files, confirming that
run 1's 943 ms was the measuring client, not the service. And ttft landing at 2659 then 2686 —
27 ms apart — confirms the floor is structural rather than an unlucky draw, so I stopped
re-running for it.

**The deep-ratio miss was a real design gap, and the bench was right to catch it.** Both gears
called Tavily with the identical hardcoded `max_results: 5, search_depth: 'basic'` — the
adapter had always ignored the `opts.maxResults` its own `SearchPort` declared. So deep was only
ever *wider* than quick (more sub-questions), never *deeper* per question, and the ratio rested
entirely on fan-out: fine when the quick baseline happened to retrieve little (4.6×), thin when
quick was thorough (a 13-source quick run against a 22-source deep one → 1.69×).

Fixed by honouring the seam: `SearchOptions { maxResults, depth }` threaded port → Tavily
adapter → `web_search` tool, chosen by gear in `runAsk` — structural, like the tool list itself,
never a prompt instruction. Deep now asks for 10 results per sub-question, quick keeps the
provider's 5. The search cache keys on the SHAPE as well as the query (`shapeOf`), or a quick
5-result row would be served to a deep search and deep would silently inherit quick's
retrieval; the quick defaults contribute an empty suffix, so rows written before this change
stay valid. The adapter also takes an injected `fetch` now, which is what let its request shape
be tested at all (3 new tests; 365 total).

Deliberately NOT taken: Tavily's `search_depth: 'advanced'`. It would deepen the crawl, but it
costs two credits where `max_results` costs none extra — and `benchmark/sla.json`'s cost_model,
a file we may not edit, prices one credit per search. Using it would make every declared deep
cost under-report the real spend. Breadth was the half that was free and honest; the knob
(`DEEP_SEARCH_DEPTH`) stays for a deploy that declares its own rates.

### M9 — full bench run 3 (ran 10:53–11:00Z, after the search-shape fix) — 15/16 caps

The fix did what it was built to do: **deep/quick source ratio 1.69× → 5.11×** (min across four
deep answers; 41–66 sources each against 22 before), deep sub-questions min 5, deep cost
$0.0141 against a $0.35 cap. `202 accept p95 146ms`. Only `ttft p95` misses, at 4666 ms.

That number needed explaining rather than accepting, and the explanation is measurement, not
regression. Agent-side, quick answers only, 81 per run:

| run | ttft p50 | ttft p95 | turn1 p50 | turn1 p95 | tools p95 | 3-turn shape | web cache-miss |
|---|---|---|---|---|---|---|---|
| 1 | 1392 | **2032** | 676 | 1017 | 256 | 1.2 % | 2/50 |
| 2 | 1492 | 2587 | 686 | 1077 | 480 | 4.9 % | 4/50 |
| 3 | 1461 | 2910 | 697 | 1263 | 331 | 3.7 % | 4/50 |

- The search-shape change did **not** touch the quick path: turn-1 p50 is 676 / 686 / 697 across
  the three runs, tool time at p50 is 1 ms (cache hits).
- No retries fired in run 3 (`llm retry` absent from the logs), so no provider throttling either.
- **CORRECTION (12:42Z).** An earlier version of this entry claimed the client-minus-agent gap
  (627 ms in run 1, 1756 ms in run 3) was the measuring laptop's network. **That was wrong, and
  the method was wrong.** It compared the bench's p95 over ITS 75-answer pool against an
  agent-side p95 over a DIFFERENT 81-answer set pulled from Mongo — two populations, so the
  difference between them is not transport and says nothing about the client.

  Measured properly instead, by pairing each request with its own recorded `ttftMs` via a
  chosen `x-request-id`, 12 quick web answers per client, search cache warmed first for both:

  | client | client p50 | client p95 | agent p50 | agent p95 | **transport** p50 / p95 |
  |---|---|---|---|---|---|
  | laptop (home connection) | 1714 | 2719 | 1609 | 2622 | **107 / 117** |
  | Cloud Run job, europe-west2 (next to the gateway) | 1552 | 1814 | 1491 | 1756 | **68 / 76** |

  Transport is ~107 ms from the laptop against ~68 ms from inside the region: a ~40 ms penalty,
  not a second. **The laptop is a fair measuring client and `ttft p95` is a real service-latency
  failure, not a measurement artifact.** The run-1 `202 accept` finding still stands on its own
  evidence — Cloud Run's own per-request log said 66–74 ms server-side against 943 ms observed —
  but that was one outlier request, and it must not be generalised into "the laptop is slow".

`ttft p95` is recorded as FAILED on all three runs. With transport now measured at ~100 ms, the
whole of the gap is the service: two sequential model completions, ~1.9 s at p50, with a p95 set
by the provider's per-call spread.

All three runs are archived as `reports/bench-full-run{1,2,3}.json` (`ranAt` 10:33:53Z /
10:42:32Z / 11:00:24Z, `pass:false` on each) so the tables above are checkable rather than
transcribed. `reports/` is git-ignored, so these live only on the machine that ran them.

**M9 stands at 15/16 caps, bench exit 1.** Not closed. The one open cap has a measured cause, a
rejected-with-numbers list of fixes (hedging, a faster deployment, more CPU), and no code change
left that would honestly move it.

### M10 — the publish chain, run end to end against the deployment (11:03Z)

`exportRuns` pulled 90 deployed runs out of Mongo (with `depth`, which the provided exporter
drops) → `quality/check.mjs .` **0 errors, 1 warning, exit 1** → `build-report.mjs` **82/85
automated**, 15 points left to a human grader → `publishReport.js` stored it as the active
artifact (etag `fa5bad40…`).

Verifying that over HTTP found the last bug of the session, and it was ours. The gateway's JSON
proxy answered with `res.status(...).json(body)`, discarding every header the agent set — and
the agent client never captured headers for JSON responses at all. So the caching contract the
agent's own tests pin (strong ETag over the published artifact, `X-Published-At`, 304
revalidation) was **dead on arrival in the deployed stack**: the browser got Express's weak ETag
and no provenance. Tested behaviour that never happens in production is worse than no behaviour,
so: relay an allowlist (not a copy — the gateway re-serializes the body, so the agent's
`content-length` and framing describe a payload that no longer exists), forward `If-None-Match`
upstream so the agent answers 304 itself, and relay a 304 as a 304 with no body. 4 new tests.

Verified live after the deploy:

```
etag: "fa5bad40570f55fff0297da57dff01c4"     ← ours, not Express's weak one
cache-control: no-cache
x-published-at: 2026-09-14T11:03:09.326Z
If-None-Match → 304
```
