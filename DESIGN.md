# DESIGN.md — LUMINA

## Components

| # | Component | Runs where | What it is |
|---|-----------|-----------|------------|
| 1 | **React UI** (provided, unmodified) | Vercel — the submitted URL | Query box, streaming answer, citations, memory panel, Spaces, `/evals` |
| 2 | **Gateway** (Express) | Cloud Run, public | The only thing the browser talks to: validate, rate-limit, log, proxy; also serves `web/dist` for same-origin local use |
| 3 | **Agent service** (Express) | Cloud Run, **not** publicly reachable (IAM-gated) | The agent loop, tools, memory, RAG, deep search — and every provider key |
| 4 | **Jobs worker** | Child process inside the agent container | Claims `index_document` work from the `jobs` collection; own lifecycle, lease, and failure story |
| 5 | **MongoDB Atlas** (one cluster) | Atlas M0, GCP europe-west2 | Threads, messages, memories + chunks (vector indexes), `searchCache` (TTL), `jobs`, `requests`/`runs`, GridFS uploads |

Two non-services carry state or make decisions, so they count as components:

- **Run log** — one record per answer. The quality gates read it, so it is a contract surface, not telemetry.
- **Search cache** — a two-tier decorator (in-process LRU → `searchCache` collection → provider) that decides whether a search costs money.

## Responsibilities

The interesting part is what each component is the **only** one allowed to do — and what it is forbidden from doing:

- **Gateway** — the only component that faces a browser; the only one that says `401`, `400`, or rate-limit `429`. Forbidden: holding a provider key, parsing an SSE frame, making any AI decision. It forwards bytes.
- **Agent service** — the only component that calls Anthropic / Tavily / OpenAI. The only one that can **mint a citation**: sources are created exclusively from material retrieved in that same request, by construction. The only place a **spend decision** happens: per-request budgets, the deep-search daily cap (`429 {error, resetsAt}`), and the kill switch — all behind IAM, so none can be bypassed by calling the AI backend directly.
- **Worker** — the only component allowed to parse, chunk, embed, or flip a document to `indexed`. The request path may only accept an upload (`202` in < 300 ms) and enqueue.
- **The loop** — the only place `terminated` is set (`done | cap | error`), explicitly at every exit.
- **Mongo** — owns durability. Nothing is reported as done that it has not acknowledged.

## Communication

| Link | Mechanism | Why this way · what happens when the far side is down |
|------|-----------|------------------------------------------------------|
| Browser → gateway | HTTPS + `x-user-id` / `x-request-id`; the ask route is SSE (`plan? → trace → sources → token → done`) | The UI needs trace/source events before tokens; SSE gives ordered frames over one request |
| Gateway → agent | Same HTTP contract + a Google-signed IAM ID token; SSE passed through **chunk-by-chunk, never parsed** | Buffering silently destroys time-to-first-token. Agent down → `502` before SSE headers commit; failure mid-stream → terminal SSE `error` frame (an HTTP status cannot change once streaming, so the error frame is the honest channel) |
| Agent → worker | Not HTTP: the `jobs` collection, claimed with an atomic `findOneAndUpdate` lease + heartbeats | Worker dies mid-job → lease goes stale → a sweeper returns the row to `pending`; resume from stage checkpoints, never re-run finished work |
| Client disconnect | Abort propagated upstream | All in-flight work is cancelled and the run is recorded as interrupted — never as a success |

## State

**Authoritative (in Mongo — a user would miss it):**

- Threads and messages; long-term **memories** — visible and deletable at `/memory`, and nothing is remembered that the endpoint does not show
- Spaces, documents, and their chunks with page/line locators
- The per-user deep-search admission ledger
- `requests` / `runs` accounting — what `/stats` and the graders read

**Disposable caches (delete without losing anything):**

- The in-process search LRU — dies with the instance, costs nothing
- The `searchCache` collection — TTL-expired; deleting it only makes the next search cost ~$0.008

**Placement quirk:** run logs are local files in development but live in the `runs` collection when deployed — Cloud Run's filesystem is in-memory and dies with the instance.

**The consistency story I had to design around:** Atlas Search indexes are eventually consistent, so a chunk that has been written is **not yet searchable**. A document only reaches `indexed` after a read-your-write probe gets one of its own chunks back from the vector index. "Upserted" is not "searchable", and the status field never claims otherwise.

## Trade-offs

Four decisions a reasonable engineer could have made differently:

1. **Atlas Vector Search instead of a dedicated vector store.** A citation is one document — the embedding lives next to the chunk text and its page locator, and `spaceId` is a plain filter inside `$vectorSearch`. What I gave up: the M0 tier's three-search-index limit, and eventual consistency I have to probe around.

2. **A hand-rolled agent loop over the Anthropic SDK instead of a framework.** The contract requires control of every turn — trace events per step, sources before tokens, explicit termination, budget checkpoints between calls — which frameworks own and hide. What I gave up: prebuilt orchestration; I accepted more code that is mine to maintain in exchange for seams the graders can actually measure.

3. **Worker co-located in the agent container instead of a separate service.** One always-on Cloud Run instance instead of two — instance-based billing is required anyway, because request-billed Cloud Run throttles CPU and silently freezes a polling loop. What I gave up: blast-radius isolation between ingestion and answering. At real scale I would split them.

4. **RRF-only hybrid retrieval, no reranker — the one I am least sure about.** Skipping rerank keeps a provider call off the retrieval path, and the spec allows it with a documented reason. If recall@5 misses 0.70 on the gold set, the plan is: diagnose chunk boundaries and candidate coverage first, and only then add a bounded reranker inside the latency budget. I may end up eating that cost anyway.
