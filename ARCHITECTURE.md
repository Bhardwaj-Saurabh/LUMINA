# LUMINA — Production Architecture

> **Scope.** This document is the engineering blueprint for LUMINA's two backend services and
> their deployment on **Google Cloud**. It covers the high-level design, the low-level module
> design, data and information flow, the agent loop and deep-search handoff, the guardrails a
> production system needs, containerization, and the CI/CD + deployment plan.
>
> **Authority.** Nothing here overrides the assignment's sources of truth: `packages/contract/`
> (executable schemas), `benchmark/sla.json`, `expectations.json`, `eval/rubric.json`, and
> `AGENTS.md`. Where this document and those disagree, they win and this document is stale.
>
> **What gets built.** New code lives only in `backend/gateway/` and `backend/agent/` (plus
> Dockerfiles, CI workflows, and this doc at the repo root). `web/`, `packages/contract/`,
> `benchmark/`, `eval/`, `quality/`, `scripts/` are provided and are never edited.

---

## 1 · System overview (HLD)

### 1.1 Context diagram

```
                    ┌────────────────────────────────────────────┐
                    │  Browser — React 18 + Vite SPA (provided)  │
                    │  /  /evals  · SSE consumer · VITE_API_URL  │
                    │  = "" (same-origin: gateway serves dist)   │
                    └──────────────────────┬─────────────────────┘
                                           │ HTTPS  (x-user-id, x-request-id)
                                           ▼
        ┌──────────────────────────────────────────────────────────────────┐
        │  lumina-gateway · Cloud Run (PUBLIC) · Express :8787             │
        │  serve web/dist · CORS · x-user-id → 401 · zod validate → 400    │
        │  token-bucket rate limit → 429 · request-id · pino JSON          │
        │  JSON proxy + SSE byte-level pass-through + multipart stream     │
        └──────────────────────┬───────────────────────────────────────────┘
                               │ HTTPS + IAM ID token (audience = agent URL)
                               │ same contract, x-user-id / x-request-id forwarded
                               ▼
        ┌──────────────────────────────────────────────────────────────────┐
        │  lumina-agent · Cloud Run (NOT public, IAM-gated) · Express :8000│
        │  agent loop (quick/deep) · tool registry · planner → fan-out →   │
        │  merge · memory · hybrid RAG · jobs worker (child process) ·     │
        │  spend gates · run logs — ALL provider keys live here            │
        └───┬──────────────┬──────────────┬──────────────┬─────────────────┘
            ▼              ▼              ▼              ▼
      Anthropic API   Tavily/SerpApi  OpenAI          MongoDB Atlas M0 (europe-west2)
      claude-sonnet-5 (env-swappable) text-embedding- threads · messages · memories(vec)
      (Secret Mgr)    (Secret Mgr)    3-small, 1536d  spaces · documents · chunks(vec+BM25)
                                      (Secret Mgr)    searchCache(TTL) · jobs · requests ·
                                                      runs · GridFS uploads
```

### 1.2 Trust boundaries

| Boundary | Mechanism | Notes |
|---|---|---|
| Browser → gateway | `x-user-id` header (dev-grade identity, per assignment) + CORS + rate limit | `401` without the header on every route except `GET /health` and `GET /evals/report.json` |
| Gateway → agent | **Cloud Run IAM**: agent deployed `--no-allow-unauthenticated`; only the gateway's service account holds `roles/run.invoker`; gateway mints Google-signed ID tokens | The deep-search spend cap cannot be bypassed by calling the agent directly — there is no unauthenticated path to it |
| Agent → providers | API keys mounted from **Secret Manager** into the agent only | No key ever exists in the gateway, the browser bundle, or a repo file |
| Agent → fetched web pages | Untrusted-content framing + SSRF guard (§5) | Pages are data, never instructions |

### 1.3 Design principles

1. **The contract is the spine.** All 13 routes, every SSE event, and every status code come from
   `packages/contract/` zod schemas; both services validate against them at their boundaries, so
   drift fails `npm run typecheck` before it fails a user.
2. **Fail loud.** A provider exception ends the run with `terminated: "error"` and a `502` —
   never a plausible answer (the Live Translate precedent, rule A1). The only catch-and-continue
   sites in the entire system are enumerated in §5.
3. **Grounded or nothing.** A citation is only mintable from material retrieved *in that request*
   (structurally enforced by the `SourceCollector`, §3); `unresolvedCitations()` is checked before
   `done` is ever emitted.
4. **Spend is gated at the source.** Per-request budgets, the per-user `DEEP_DAILY_CAP`, and a
   global kill switch all live in the agent service — next to the spending, behind IAM.
5. **Depth is data, not a prompt.** The tool registry filters `plan_research` out of quick runs
   before the first model call. The server never upgrades a request's depth.
6. **Async off the request path.** Document ingestion is `202` in < 300 ms + a `jobs` row; a
   crash-safe worker does the work.
7. **One language, one database.** TypeScript end to end; MongoDB Atlas holds documents, memory,
   cache, jobs, run logs, files (GridFS), and both vector indexes.

---

## 2 · Low-level design (LLD)

### 2.1 Gateway — `backend/gateway/src/`

**Pattern: middleware chain (chain of responsibility) over a reverse proxy.** The gateway is
deliberately boring: transport and policy, zero AI. Each contract rule is one small, testable
file; the proxy forwards bytes and stays ignorant of SSE semantics, so loop changes never touch
the edge.

```
index.ts                 composition root only: middleware → routes → static SPA → error handler
env.ts                   (provided) + AGENT_AUDIENCE, RATE_LIMIT_BURST
sse.ts                   (provided) sseHeaders()/sseSend() helpers
middleware/
  requestId.ts           reuse inbound x-request-id or mint req_<uuid12>; echo on response
  auth.ts                x-user-id required for every ROUTES entry with auth: true → 401
  validate.ts            factory: validate(schema, target) → 400 with the zod message
  rateLimit.ts           token bucket per userId (capacity = burst, refill = RATE_LIMIT_PER_MINUTE/60 s) → 429 + Retry-After
  errorHandler.ts        anything thrown → 502 JSON with requestId; never a 200 on an exception
proxy/
  client.ts              THE single seam to the agent: base URL, header forwarding, cached
                         Google ID-token minting (google-auth-library), per-route-class timeouts
  jsonProxy.ts           generic pass-through for the JSON routes; upstream status mapped verbatim;
                         network failure → 502
  askProxy.ts            SSE pass-through: undici stream → res.write() per chunk — never parse,
                         never buffer, abort upstream on client disconnect
  uploadProxy.ts         multipart stream pipe; Content-Length precheck + streaming byte cap → 413
static/
  spa.ts                 express.static(web/dist) + SPA fallback (provided regex)
```

Why each pattern fits:

- **Middleware chain** — the contract's edge rules (401/400/429) are orthogonal; one file each
  means one unit test each and an obvious insertion order.
- **Single proxy client seam** — Cloud Run IAM auth (ID tokens) is added in exactly one place;
  swapping the agent's URL or auth mechanism never touches route code.
- **Byte-level SSE pass-through** — the gateway must add zero latency and zero interpretation.
  Any `await res.json()`-style handling of the stream silently destroys TTFT; piping chunks is
  the only correct shape. No `compression()` anywhere near `/threads/:id/ask`.

### 2.2 Agent service — `backend/agent/src/`

**Patterns: hexagonal (ports & adapters) · tool registry · strategy (per depth) · repository ·
state machine (jobs) · decorator (search cache) · observer (SSE emitter).**

```
index.ts                     composition root: providers → repos → registry → routes;
                             forks dist/worker.js as a supervised child process
env.ts · db.ts               (provided) db.ts gains typed collection accessors + GridFS bucket

http/
  routes/ask.ts              POST /threads/:id/ask — guards → strategy (quick|deep) → persist → run log
  routes/threads.ts          POST/GET /threads · GET /threads/:threadId
  routes/memory.ts           GET /memory · DELETE /memory/:memoryId
  routes/spaces.ts           POST/GET /spaces
  routes/documents.ts        POST (stream → GridFS → job row → 202 < 300 ms) · GET (status ladder)
  routes/stats.ts            GET /stats — aggregation over requests/runs; reconciles with logs
  routes/evals.ts            GET /evals/report.json
  sseSink.ts                 AskEmitter over Express Response: plan/trace/sources/token/done/error
                             + `: keepalive` comment every 15 s during silent research stretches

providers/                   ← ports & adapters. ONLY these files import SDKs or read `secrets`.
  llm/port.ts                LlmPort { runTurn(...), streamText(...) } — usage returned per call
  llm/anthropic.ts           @anthropic-ai/sdk adapter; typed errors → ProviderError{retryable}
  search/port.ts             SearchPort { search(q, opts) }
  search/tavily.ts           Tavily adapter (search + extract)
  search/serpapi.ts          SerpApi adapter (+ readability/jsdom for page text)
  search/cached.ts           DECORATOR: L1 in-process LRU → L2 searchCache collection
                             (sha256(normalized query + provider), 6 h TTL, expiresAt also checked
                             in code — Mongo's TTL sweeper runs ~1/min) → provider.
                             Reports hit/miss per call so done.searchCached = "every search hit".
  embeddings/port.ts         EmbeddingsPort { embed(texts[]) } — batch-first
  embeddings/openai.ts       text-embedding-3-small; 1536 dims asserted at the boundary

core/
  loop.ts                    AgentLoop — the depth-agnostic tool-use loop (§3.1)
  budget.ts                  Budget — tool calls, deadline, tokens, USD; tryReserve() race-free
  registry.ts                ToolRegistry: Map<name, ToolDef{zod schema, execute, deepOnly?}>;
                             forDepth('quick') structurally removes DEEP_ONLY_TOOLS
  tools/webSearch.ts         one file per tool: web_search · fetch_page (SSRF-guarded) ·
  tools/fetchPage.ts         search_documents · recall_memory · save_memory · plan_research
  tools/searchDocuments.ts
  tools/memoryTools.ts
  prompts.ts                 frozen system prompts (stable text first for prompt caching),
                             citation discipline, untrusted-content standing rule
  citations.ts               contract's citationNumbers()/unresolvedCitations() + repair policy
  sourceCollector.ts         per-request registry of retrieved material; the ONLY mint for sources
  quick/orchestrator.ts      strategy 'quick': one AgentLoop → synthesize
  deep/planner.ts            plan_research: one LLM call, no tools, JSON out, ≤ 4 s budget
  deep/researcher.ts         one bounded AgentLoop per sub-question (isolated context)
  deep/merge.ts              dedupe (url | docId+locator) · contiguous renumber · localN→globalN
                             remap · subQuestion tagging
  deep/orchestrator.ts       strategy 'deep': planner → p-limit(3) fan-out → merge → synthesize

retrieval/
  hybrid.ts                  $vectorSearch (chunks_vector, spaceId filter INSIDE the stage) +
                             $search (chunks_text BM25) in parallel, fused with RRF (k = 60);
                             top-k and thresholds from config, not hard-coded

ingest/
  pipeline.ts                pure stages: parse (pdfjs-dist, page-aware) → chunk (locator
                             {page|heading|line}) → embed (batched) → upsert → probe
  jobStateMachine.ts         pending → running → done|failed; running + stale claimedAt → pending
                             (sweeper). Illegal transitions throw.
  worker.ts                  (provided stub, built out) atomic findOneAndUpdate claim; heavy PDF
                             parsing inside a worker_thread so it never shares the SSE event loop

repos/                       repository pattern: one file per collection; routes and the loop
  threads.ts messages.ts     never touch a raw Collection. One place per index contract.
  memories.ts spaces.ts
  documents.ts chunks.ts
  jobs.ts runs.ts requests.ts
  searchCache.ts gridfs.ts

guards/
  deepCap.ts                 atomic $inc on {userId, dayKey} → over cap: decrement + 429
                             {error, resetsAt: next UTC midnight}
  killSwitch.ts              ASK_DISABLED / SPEND_KILL_SWITCH env → 503; flipped via
                             `gcloud run services update`, no deploy
  ssrf.ts                    fetch_page URL vetting (§5)
  redact.ts                  pino redact paths + outbound error key-scrubbing

infra/
  resilience.ts              withTimeout · withRetry (backoff + jitter) · CircuitBreaker per port
  lru.ts                     bounded LRU (or lru-cache)

obs/
  runlog.ts                  RunLog builder → runs/<requestId>.json (local) AND upsert into the
                             runs collection (unique requestId). Deployed instances rely on Mongo;
                             scripts/export-runs.mjs bridges to the grader.
  cost.ts                    ONE pricing table (rates mirrored from benchmark/sla.json's
                             cost_model) so the done event, /stats, and the run log can never
                             disagree about a dollar figure.
```

Why hexagonal here specifically: the assignment mandates provider swappability
(`SEARCH_PROVIDER=tavily|serpapi` with no code change) and key isolation ("keys only in the agent
service"). Ports make both enforceable by *import structure* — an ESLint rule bans importing
`env.secrets` outside `providers/` — rather than by convention. The registry makes "a quick run
never calls `plan_research`" a property of data flow, not a prompt instruction a model could
ignore. The job state machine makes `202 → pending → running → indexed` auditable and gives the
sweeper's stale-claim recovery a first-class, tested transition.

---

## 3 · The agent loop & deep-search handoff

### 3.1 The loop (`core/loop.ts`)

The contract requires `sources` before the first `token`, which forces a two-phase shape:
**research (non-streaming tool-use turns) → sources → synthesis (streaming)**.

```
per request: Budget{maxToolCalls, deadline, maxUsd} · SourceCollector · AskEmitter

RESEARCH (loop while stop_reason == "tool_use"):
  1. budget checkpoint (before the LLM call AND before each tool execution)
       exceeded → break with terminated:'cap'
  2. messages.create(system, history, evidence-so-far, tools = registry.forDepth(depth))
  3. execute ALL tool_use blocks concurrently; return all tool_results in ONE user message
       (splitting them degrades the model's parallel tool calling)
       - failed tool → tool_result{is_error:true} + emitter.trace({ok:false, error}) — never dropped (A1)
       - successful retrievals register material with the SourceCollector
  4. emitter.trace({step, tool, input, ok, ms, reason}) per call
       (`reason` is a required field on every tool's input schema — the model explains each step)

SOURCES:  collector.finalize() → emitter.sources([...])   ← always before the first token

SYNTHESIS (streaming):
  messages.stream(evidence + numbered source list + citation rules)
  each text delta → emitter.token({text}); TTFT clock stops at the first delta

VERIFY → DONE:
  unresolvedCitations(fullText, sources) must be empty
    → violations: terminated:'error' + SSE error frame (never a quiet done)
  emitter.done({answerId, latencyMs, ttftMs, model, tokens{in,out}, costUsd,
                searchCached, terminated, depth, subQuestions?})
  persist message pair · write run log (file + runs collection) · insert requests row
```

**Budget accounting** (`budget.ts`) — one object per request, all four dimensions checked at
every checkpoint:

| Dimension | Quick | Deep | Enforcement |
|---|---|---|---|
| Tool calls | 8 | 24 | `tryReserve()` before execution (single-threaded JS ⇒ race-free even under deep fan-out) |
| Wall clock | 90 s | 240 s | deadline checked at checkpoints **and** propagated as `AbortSignal.timeout` into every provider call, so a hung fetch cannot outlive the cap |
| Tokens | accumulated from every `response.usage` (research turns + synthesis) | | reported in `done` and the run log |
| USD | hard ceiling (env; e.g. $0.10 quick / $0.60 deep — above the SLA *means*, below runaway) | | computed via `obs/cost.ts` after each usage update; trips `terminated:'cap'` even with tool calls remaining — cost is the real cap, tool calls are its proxy |

**Termination semantics** (explicit at every exit — no SDK provides this):

| `terminated` | When | User sees |
|---|---|---|
| `done` | natural `end_turn` + citations verified | complete cited answer |
| `cap` | any budget dimension trips | an **honest partial** synthesized from evidence gathered so far, clearly marked — never presented as complete |
| `error` | any provider throw | SSE `error {status: 502, error}` frame; HTTP 502 on non-stream paths; run log records it. **No catch may substitute an answer.** |

Retry policy at the LLM port: only *retryable* errors (rate limit, transient 5xx), only *before*
the first streamed token, SDK `maxRetries: 2`. Mid-stream failure is an `error` frame, not a
silent restart.

**SSE decoupling:** the loop receives an `AskEmitter` interface, never an Express `Response`.
The HTTP route owns transport (flush per frame, 15 s keep-alive comments); the loop owns
semantics. This makes the loop unit-testable with an array-collecting emitter, and lets a local
harness run it without HTTP.

### 3.2 Deep search: planner → researchers → merger

```
ask {depth:"deep"}
  │
  ├─ guards: killSwitch → deepCap ($inc {userId, dayKey}; over cap → 429 {error, resetsAt}
  │          BEFORE the stream ever starts)
  │
  ├─ PLANNER  (core/deep/planner.ts)                        ≤ 4 s budget, effort low, no tools
  │     one LLM call → {subQuestions: [{i, question, reason}] (3–6), reason}
  │     → emitter.plan(...)  ← BEFORE ANY RETRIEVAL (hard ordering; a plan streamed after the
  │       fetches is a rationalisation, not a plan)
  │     → emitter.trace({step:1, tool:'plan_research', ok:true, ms})
  │
  ├─ FAN-OUT  (p-limit(3) bounded concurrency)
  │     researcher(i) = one AgentLoop per sub-question
  │       ISOLATED per researcher: message history (its sub-question is its user turn),
  │         provisional source numbering, trace reasons
  │       SHARED across researchers: the single Budget (24 calls / 240 s, atomic tryReserve),
  │         the cached SearchPort (identical sub-searches dedupe across researchers),
  │         the emitter (every trace step and source carries subQuestion: i),
  │         requestId / userId / spaceId
  │       soft cap floor(24 / n) tool calls per researcher — one sub-question cannot starve
  │         the rest; the shared hard cap still rules
  │       a researcher's provider error fails the WHOLE run loud (502); a researcher that
  │         merely finds little does not
  │
  ├─ MERGER  (core/deep/merge.ts)
  │     dedupe key: normalized url (strip fragment/UTM) for web · docId + JSON(locator) for docs
  │     first occurrence wins the number; later duplicates merge their subQuestion tags
  │     contiguous renumber from 1; per-researcher localN → globalN remap table so researcher
  │       notes handed to the synthesizer cite global numbers
  │     contiguity + full resolution asserted before emitter.sources(...)
  │
  └─ SYNTHESIS (streaming): structured answer — short direct answer, a section per
        sub-question, then "what is still unknown" — grounded only in merged sources
     → done {depth:"deep", subQuestions: n}
```

The bench's "deep reads ≥ 2× quick's distinct sources" falls out structurally (3–6 researchers
each doing their own retrieval), but the merger records the distinct-source count into the run
log so the claim is verifiable, not vibes.

The planner is invoked **deterministically by the orchestrator** rather than left for the model
to maybe-call — the `plan` event's ≤ 4 s p95 cannot survive an open loop. `plan_research` still
exists in the deep registry so the trace honestly records it as step 1, and so the quick
registry's *omission* of it is the enforcement point (rule R2).

---

## 4 · Data flow narratives

### 4.1 Quick ask

1. Browser `POST /threads/:id/ask {query, mode, depth:"quick", spaceId?}` + `x-user-id`.
2. Gateway: request-id (reuse or mint) → auth (401) → zod validate (400) → rate bucket (429) →
   SSE headers → proxy with IAM ID token, forwarding `x-user-id`/`x-request-id`.
3. Agent: re-validate → load thread history (+ recent turns eagerly; long-term memory is a tool)
   → build **quick** registry (no `plan_research`) → `Budget(8, 90 s)`.
4. Loop: `web_search` → cached decorator (LRU → `searchCache` → Tavily) → `trace 1` →
   `fetch_page` (SSRF-guarded, readability-extracted) → `trace 2` → … each retrieval registers
   with the SourceCollector.
5. `sources` event (always before the first token) → streaming synthesis → `token*`.
6. Citation verification → `done {terminated, searchCached, tokens, costUsd, ttftMs, latencyMs,
   depth:"quick"}`.
7. Persist user+assistant messages; write `runs/<requestId>.json` + `runs` collection row +
   `requests` row. Gateway pipes every frame verbatim; both services log one close line keyed by
   the same `requestId`.

### 4.2 Deep ask

1–2. As above with `depth:"deep"`.
3. Agent: kill switch (503) → `deepCap` atomic `$inc` — over cap → **429 {error, resetsAt}**,
   stream never starts.
4. Planner call (≤ 4 s) → **`plan` event before any retrieval** + `trace step 1
   (plan_research)`.
5. `p-limit(3)` researchers run their isolated loops against the shared budget; every `trace`
   and every eventual `source` is tagged `subQuestion: i`.
6. Merge → dedupe → contiguous renumber → `sources` (mixed `kind` when docs were relevant).
7. Streamed structured synthesis → `done {depth:"deep", subQuestions: n, costUsd, …}`.
8. Cap tripped anywhere → synthesis from partial evidence, `terminated:"cap"` — honest partial.

### 4.3 Document ingestion (async, crash-safe)

1. `POST /spaces/:id/documents` (multipart, ≤ 25 MB, pdf/md/txt) → gateway streams through
   (Content-Length precheck + byte cap → 413).
2. Agent: stream to **GridFS** → insert `documents {status:"pending"}` + `jobs {kind:
   "index_document", status:"pending"}` → **202 {docId, status:"pending"} in < 300 ms**. No
   parsing on the request path, ever.
3. Worker (child process): atomic claim `findOneAndUpdate({status:"pending"} → {status:
   "running", claimedAt, workerId, $inc attempts})`.
4. Pipeline: GridFS read → `pdfjs-dist` parse per page (inside a `worker_thread` — heavy CPU
   never shares the SSE event loop) → chunk with locator `{page}` / `{heading}` / `{line}` →
   batched OpenAI embeddings (1536 dims) → upsert `chunks` (idempotent by chunk key).
5. **Read-your-write probe:** `$vectorSearch` for a just-written chunk, retried with backoff
   until visible — Atlas Search is eventually consistent; "upserted" is not "searchable".
6. Only then: `documents.status = "indexed"`, job `done`. Status ladder
   `pending → parsing → embedding → indexed | failed` with `pct` exposed by
   `GET /spaces/:id/documents`.
7. Crash mid-job → row stays `running` with a stale `claimedAt`; the sweeper returns it to
   `pending`; completed stages are idempotent so nothing re-runs destructively.
8. Queries: `search_documents` → `retrieval/hybrid.ts` — `$vectorSearch` (spaceId filter
   **inside** the stage) + BM25 `$search`, RRF-fused, locators intact for `filename, p. N`
   citations.

### 4.4 Memory save / recall

- During any ask, the model may call `save_memory {text, reason}` (stable facts/preferences
  only, per prompt discipline) → embed → insert `memories {userId, text, embedding,
  sourceThread}` → visible `trace` step. Nothing is remembered that `GET /memory` does not show.
- `recall_memory {query}` → embed → `memories_vector` `$vectorSearch` filtered by `userId` →
  top-k (≤ 10 docs / ~1 000 tokens) returned as a tool result. Recalled facts inform the answer;
  they are **not** citable sources.
- `GET /memory` lists; `DELETE /memory/:id` removes the document — the effect disappears in the
  next thread, provably (the bench tests exactly this). Memory tool calls draw on the same
  budget as everything else.

---

## 5 · Guardrails catalogue

| # | Guardrail | Where | Design |
|---|---|---|---|
| 1 | Input validation | gateway `validate.ts` (400) **and** agent re-validation | Defense in depth: the agent must be safe even if the edge is bypassed. Contract zod schemas; unknown fields stripped; `depth` defaults to `quick`; id-format checks on params (404 on unknown ids). |
| 2 | Upload limits | gateway `uploadProxy` + agent multipart handling | Content-Length precheck + streaming byte cap → 413; MIME allowlist (`application/pdf`, `text/markdown`, `text/plain`); stream to GridFS — the file is never buffered whole in memory. |
| 3 | Prompt injection (fetched pages are untrusted) | `tools/fetchPage.ts` + `prompts.ts` | Readability extraction drops scripts/nav; page text is wrapped in `<untrusted_source url="…">…</untrusted_source>` inside `tool_result` blocks only (never `system`); a standing system rule declares such content data-never-instructions; per-page content cap (~8 k chars); citations must quote snippets that exist in the fetched text, so injected "cite me" content can't mint sources. |
| 4 | SSRF | `guards/ssrf.ts` | http/https only; resolve the host and reject private, link-local, and loopback ranges — **169.254.169.254 (GCP metadata) is a live threat on Cloud Run**; max 3 redirects, each hop re-vetted; 10 s timeout; 2 MB body cap. |
| 5 | Citation verification | `core/citations.ts` before `done` | `unresolvedCitations(answer, sources)` must be empty; the SourceCollector only admits material actually retrieved this request, so citing something unfetched is structurally impossible; violation → `terminated:"error"`, never a quiet `done`. |
| 6 | Per-request spend | `core/budget.ts` | Four dimensions (calls, wall clock, tokens, USD); deadline propagated as `AbortSignal`; USD ceiling trips `cap` even when calls remain. |
| 7 | Per-user daily deep cap | `guards/deepCap.ts` — in the **agent**, per the contract | Atomic `findOneAndUpdate({userId, day}, {$inc: {count: 1}}, {upsert: true})`, over cap → decrement + `429 {error, resetsAt}`. Atomic ⇒ correct even multi-instance. A cap on the edge would be a cap you can bypass; this one sits behind IAM next to the spending. |
| 8 | Global kill switch | `guards/killSwitch.ts` | `ASK_DISABLED=1` / `SPEND_KILL_SWITCH=1` → 503 on ask routes; flip in seconds with `gcloud run services update --update-env-vars`, no deploy, no code path removed. |
| 9 | Rate limiting | gateway `rateLimit.ts` | Token bucket per `x-user-id`: capacity = burst (10), refill = `RATE_LIMIT_PER_MINUTE`/60 per second → 429 + `Retry-After`. In-memory is acceptable at gateway `max-instances ≤ 3`; the documented production swap is Memorystore/Redis. |
| 10 | Timeouts / retries / circuit breakers | `infra/resilience.ts`, applied per port | **Anthropic:** 60 s/turn, SDK retries 2 (pre-stream only). **Tavily/SerpApi:** 10 s, 1 retry on 5xx/network; breaker opens after 5 failures/30 s, half-open probe at 15 s — an open breaker is an immediate loud 502, never a fabricated result. **OpenAI embeddings:** 30 s, 3 retries with jittered backoff (worker path tolerates latency). **Mongo:** `serverSelectionTimeoutMS: 5000`; `/health` reports `db: "down"` truthfully. |
| 11 | Secret/PII hygiene in logs | both services, pino config + `guards/redact.ts` | `redact` paths for auth headers and key-shaped fields; question text logged as length/hash at `info` (full text only at `debug`); outbound error messages scrubbed against loaded secret values — a provider error that echoes a key must never reach a client or a log line. |
| 12 | Fail-loud invariant | agent error middleware + the loop | Any uncaught error → 502 + SSE `error` frame + `terminated:"error"` run log. The **only** catch-and-continue sites in the system: (a) a tool call failing into `tool_result{is_error}` + `trace{ok:false, error}`, (b) cache fallthrough (cache miss → provider — never the reverse), (c) the gateway's `/health` reporting a dead agent as `ai: {status:"down"}`. Everything else propagates. |

---

## 6 · Deployment on Google Cloud

Region: **`europe-west2` (London)** for all resources; the Atlas M0 cluster is created on GCP in
the matching region so Mongo round-trips stay low.

### 6.1 Topology

| Setting | `lumina-gateway` | `lumina-agent` |
|---|---|---|
| Cloud Run service | public: `--allow-unauthenticated`, ingress `all` | **`--no-allow-unauthenticated`** (IAM-gated) |
| Invoker | everyone | only the gateway's runtime service account (`roles/run.invoker`) |
| CPU / memory | 1 vCPU / 512 MiB, request-based billing | 1 vCPU / 1 GiB (pdfjs headroom), **instance-based billing (`--no-cpu-throttling`)** |
| Instances | min 0 (raise to 1 during the grading window for TTFT), max 3 | **min 1, max 1** (course scale — see rationale) |
| Concurrency | 80 | 20 (deep runs are I/O-bound) |
| Request timeout | 320 s | 300 s (deep cap 240 s + margin; gateway ≥ agent) |
| Env / secrets | `AGENT_URL`, `CORS_ORIGINS`, rate-limit knobs — no secrets | `--set-secrets`: `MONGODB_URI`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TAVILY_API_KEY` from **Secret Manager** (runtime SA holds per-secret `secretAccessor`) |

### 6.2 Decisions and rationale

**Agent reachability: IAM-only, no VPC (course); VPC in production.** Deploying the agent
`--no-allow-unauthenticated` means every request must carry a Google-signed ID token from an
authorized service account — cryptographic protection with zero network plumbing. Forcing
`ingress=internal` instead would require Direct VPC egress on the gateway plus all-traffic VPC
routing plus Cloud NAT for Atlas — roughly $35+/month of infrastructure to re-protect a service
IAM already protects. Production upgrade: `ingress=internal` + Direct VPC egress on both
services + Cloud NAT, keeping IAM as the second layer.

**Worker placement: co-located in the agent container as a supervised child process.**
`node dist/index.js` forks `dist/worker.js` (restart on exit; container exits if it flaps so
Cloud Run replaces it); heavy parsing runs in a `worker_thread` inside that child. Rationale:

1. Cloud Run's **#1 footgun** for this workload: under request-based billing, CPU is throttled
   to near-zero outside request handling — a background polling loop silently freezes. Fix:
   instance-based billing (`--no-cpu-throttling`). The agent already needs an always-on instance
   (deep runs + TTFT), so one instance paying that cost is cheaper than two.
2. The atomic `findOneAndUpdate` job claim already makes co-located or duplicated workers safe.
3. `max-instances=1` keeps in-process state (search LRU, circuit breakers) coherent; correctness
   never depends on it (L2 cache and caps live in Mongo).

Production change: split a `lumina-worker` Cloud Run service from the **same image** with
`command: node dist/worker.js`, min 1, and raise agent `max-instances` — blast-radius isolation
between ingestion and answering.

**Atlas connectivity (M0):** the free tier has no VPC peering or Private Service Connect, so the
cluster is publicly addressable either way. Decision: **IP access list `0.0.0.0/0` + strong SCRAM
credentials + TLS (always on) + a database user scoped to the single `lumina` DB**, URI in
Secret Manager. The alternative — a static egress IP via Direct VPC egress + Cloud NAT — costs
more per month than the rest of the stack to protect a free dev cluster. Production: M10+,
Private Service Connect, public access list removed.

**SSE on Cloud Run:** streaming HTTP/1.1 responses are supported and unbuffered. The two things
that bite: (1) the request timeout — 300/320 s covers the deep cap with margin, well under the
60-minute platform max; (2) silence — the 15 s `: keepalive` comments keep intermediaries and
the browser from declaring the wire dead during long research stretches. No compression
middleware on the ask path; `X-Accel-Buffering: no` is already set by the provided `sse.ts`.

**Run logs on Cloud Run:** the container filesystem is in-memory and dies with the instance.
The Mongo `runs` collection (unique `requestId`) is the durable store; local `runs/*.json`
remains for local grading; `scripts/export-runs.mjs` bridges deployed → grader.

**Domain/TLS:** the default `*.run.app` URL ships with managed TLS — sufficient here. Production:
global external HTTPS load balancer + Cloud Armor (WAF/DDoS) + CDN for the static assets.

**Cost envelope (course):** agent ≈ $15–25/month for one always-on 1 vCPU instance (less with
the free tier), gateway near zero at min 0, Artifact Registry + Secret Manager pennies, Atlas M0
free. **Production deltas:** min 2 instances multi-region · separate worker service ·
Memorystore for rate limits/cache · M10 + PSC · LB + Cloud Armor · per-user budgets stored in
the DB with an admin surface instead of env vars.

### 6.3 Risk flags (Cloud Run × this workload)

1. **CPU throttling freezes the jobs poller** under request billing — instance billing on the
   agent is non-negotiable.
2. **Cold start vs TTFT 2.5 s p95** — agent min-instances 1 always; gateway min 1 while the
   bench runs.
3. **In-memory state assumes few instances** — enforced by max-instances; correctness lives in
   Mongo (L2 cache, caps), only latency lives in RAM.
4. **Instance death mid-deep-run** kills the SSE stream unresumably — accepted for the course
   (client sees the error frame); production work: event-log persistence + resume tokens.
5. **The gateway must pipe, never buffer** — any accidental full-body read of the upstream
   stream destroys TTFT invisibly. The askProxy is chunk-for-chunk by construction and the bench
   (TTFT measured through the gateway) would catch a regression.

---

## 7 · Containerization

Two multi-stage Dockerfiles at the repo root (`Dockerfile.agent`, `Dockerfile.gateway`), build
context = repo root — the npm-workspace lockfile and dependency graph live there, so per-package
builds would drift. The runtime images preserve the monorepo layout because the provided `env.ts`
files resolve paths relative to the service directory (`../../.env`, `../../runs`,
`../../web/dist`) — preserving layout means **zero skeleton edits**.

`Dockerfile.agent`:

```dockerfile
# ---- deps: full install (dev deps needed to compile TS) --------------------
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contract/package.json packages/contract/
COPY backend/agent/package.json     backend/agent/
RUN npm ci --workspaces --include-workspace-root

# ---- build: contract FIRST, then the service -------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contract packages/contract
COPY backend/agent     backend/agent
RUN npm run build -w @lumina/contract && npm run build -w @lumina/agent

# ---- prod-deps: clean runtime-only node_modules ----------------------------
FROM node:20-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contract/package.json packages/contract/
COPY backend/agent/package.json     backend/agent/
RUN npm ci --workspaces --include-workspace-root --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/packages/contract/dist packages/contract/dist
COPY packages/contract/package.json            packages/contract/
COPY --from=build /app/backend/agent/dist      backend/agent/dist
COPY backend/agent/package.json                backend/agent/
COPY package.json ./
USER node
WORKDIR /app/backend/agent
CMD ["node", "dist/index.js"]        # index.ts forks dist/worker.js (supervised)
```

`Dockerfile.gateway` differs in three ways: it also copies `web/` and runs
`npm run build -w @lumina/web`, copies the resulting `web/dist` into the image at
`/app/web/dist` (the skeleton's `env.webDist` finds it there), and its `CMD` is the gateway
entry. The UI is built with `VITE_API_URL=""` (empty = same-origin), which is exactly what the
provided `web/src/api.ts` expects when the gateway serves the SPA.

`.dockerignore`:

```
node_modules
**/node_modules
**/dist
.env
.env.*
runs/
reports/
.git
web/dist
```

Why this shape: `npm ci` from the root lockfile is the only correct install for npm workspaces;
the contract package must compile before anything that imports it (same rule as local dev); the
separate `prod-deps` stage is the standard workspace prune because `npm prune --omit=dev` is
unreliable with hoisted dependencies; `node:20-slim` + `USER node` keeps the runtime image small
and unprivileged.

---

## 8 · CI/CD — GitHub Actions + Workload Identity Federation

No long-lived JSON keys anywhere: GitHub's OIDC token is exchanged for GCP credentials via WIF.

**`.github/workflows/pr.yml`** (every pull request, no GCP credentials — fork-safe):

```
checkout → setup-node 20 (npm cache) → npm ci
→ npm run build -w @lumina/contract
→ npm run typecheck → npm run lint
→ node quality/check.mjs .            # the assignment's contract gate
```

**`.github/workflows/deploy.yml`** (push to `master`):

1. **verify** — the same gates as PR. Nothing deploys that didn't pass.
2. **build-push** — `google-github-actions/auth` (WIF + deploy SA) → build both images tagged
   `$GITHUB_SHA` + `latest` → push to Artifact Registry
   `europe-west2-docker.pkg.dev/<project>/lumina/{agent,gateway}`.
3. **deploy-agent** — `gcloud run deploy lumina-agent --image …:$SHA --no-traffic
   --tag candidate` → authenticated smoke against the candidate revision URL (`/health` must be
   200 with `db: "ok"`) → promote with `--to-latest`. **Agent first**: the gateway must never
   point at an older agent.
4. **deploy-gateway** — same no-traffic/smoke/promote pattern, then a public smoke: `/health`
   200, and one quick ask must stream a `sources` frame before the first `token` frame (a
   ~20-line script, or `node benchmark/bench.mjs --smoke --target <url>`).
5. **Rollback** — a failed smoke never moved traffic, so the previous revision still serves.
   Manual: `gcloud run services update-traffic lumina-gateway --to-revisions <prev>=100`.

IAM (least privilege):

| Principal | Grants |
|---|---|
| Deploy SA (used by Actions via WIF) | `roles/run.admin`, `roles/artifactregistry.writer`, `roles/iam.serviceAccountUser` on the two runtime SAs |
| Gateway runtime SA | `roles/run.invoker` **on the agent service only** |
| Agent runtime SA | `roles/secretmanager.secretAccessor` on its four secrets only |

One-time ops (not in CI): create the Secret Manager secrets; create the Atlas cluster + db user
+ access list; run `node scripts/create-indexes.mjs` and wait for `--status` to report the three
search indexes queryable.

---

## 9 · Observability & SLA mapping

- **Structured logs:** pino JSON in both services. Gateway: one line per request
  (`method, route, status, ms, requestId, userId`). Agent: one line per answer
  (`requestId, toolCalls, terminated, tokens, costUsd, searchCached, ttftMs, latencyMs, depth`).
  Cloud Logging ingests stdout natively; one `x-request-id` greps a request end to end across
  both services.
- **`/stats` reconciles with the logs** (the bench cross-checks `answers` and `costUsdToday`):
  both are aggregations over the same `requests`/`runs` collections that `obs/runlog.ts` writes,
  and `obs/cost.ts` is the single pricing table — the done event, the run log, and `/stats`
  cannot disagree by construction.
- **Run logs:** one per answer, file + Mongo (§6.2); the deliberate failure kept for rule P1
  lives in `runs/failing/`, which the trajectory gate does not scan.

How each declared SLA target is defended (targets live in `benchmark/sla.json`; this table maps
them to design elements):

| Target | Defended by |
|---|---|
| TTFT p95 ≤ 2.5 s | min-instances (no cold start) · two-phase loop streams synthesis immediately after `sources` · gateway pipes bytes, never buffers · no compression on the ask path |
| Answer p95 ≤ 12 s | parallel tool execution within a turn · search cache · bounded quick budget (8 calls) |
| 202 accept p95 ≤ 300 ms | upload path does GridFS write + two inserts only; parsing is on the worker |
| Search p95 during ingest ≤ 1.3× idle | parsing in a `worker_thread` inside the worker child — the SSE event loop never blocks |
| Grounding ≥ 95 % | SourceCollector-only source minting · `unresolvedCitations` gate before `done` · synthesis from fetched text, snippet discipline in prompts |
| Recall@5 ≥ 0.70 | hybrid RRF (dense + BM25) · spaceId filter inside `$vectorSearch` · read-your-write probe before `indexed` |
| Cache hit ≥ 50 % | two-tier cache (LRU → `searchCache` TTL) keyed on normalized query + provider; time-sensitive queries bypass |
| Deep plan p95 ≤ 4 s | deterministic planner call, no tools, low effort, hard 4 s budget |
| Deep answer p95 ≤ 90 s | `p-limit(3)` parallel researchers — wall clock is not the sum of the parts |
| Deep/quick source ratio ≥ 2× | structural: 3–6 researchers with independent retrieval + dedupe-aware merge; count recorded in the run log |
| Error rate ≤ 1 % | retries where safe (pre-stream), circuit breakers fail fast and loud, health checks gate deploys |
| Cost/answer ≤ $0.05 quick, ≤ $0.35 deep | budget USD ceilings · effort tuning (low for research turns, medium for synthesis) · prompt-cache-friendly stable system prompts · search cache |

---

## 10 · Assignment red-line compliance

| Red line (AGENTS.md / rubric) | Enforced by |
|---|---|
| Secrets committed / reachable from the app | Secret Manager only; `.env` git-ignored; `guards/redact.ts` scrubs outbound errors; no key in the gateway or browser bundle |
| Provided folders edited | New code only in `backend/*`; Dockerfiles preserve the monorepo layout so even `env.ts` path assumptions stand unedited |
| Fabricated citation | SourceCollector is the only mint; `unresolvedCitations` gate; violation → `terminated:"error"`, never `done` |
| 2xx on a provider exception (A1) | Fail-loud invariant (§5 #12): 502 + SSE `error` + `terminated:"error"`; enumerated catch sites only |
| Capped run reported as `done` (A2) | Termination set explicitly at every exit; `cap` synthesizes an honest partial and says so |
| `plan_research` from a quick run (R2) | `registry.forDepth('quick')` structurally omits it — the model cannot call a tool it was never given |
| Agent service publicly reachable | Cloud Run IAM: `--no-allow-unauthenticated`, invoker = gateway SA only — the deep cap cannot be bypassed |
| Server upgrades depth on its own | `depth` defaults to `quick` at the contract layer; strategy selection reads the validated body only; `done` reports the gear that actually ran |

---

*Document owner: Saurabh Bhardwaj · Stack: MERN on GCP (Cloud Run, europe-west2) · LLM:
Anthropic claude-sonnet-5 (direct API) · Search: Tavily (env-swappable) · Embeddings: OpenAI
text-embedding-3-small · Store: MongoDB Atlas M0 (Vector + Search + GridFS).*
