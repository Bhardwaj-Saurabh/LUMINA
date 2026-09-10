# DESIGN.md — LUMINA

## Components

Five pieces. (1) The provided React UI, deployed unmodified to Vercel — the submitted URL. (2) An
Express **gateway** on Cloud Run (public), which is the only thing the browser ever talks to: it
validates, rate-limits, logs, proxies, and also serves `web/dist` for same-origin local use. (3) An
Express **agent service** on Cloud Run (not publicly reachable, IAM-gated), which owns the agent
loop, the tools, memory, RAG, deep search, and every provider key. (4) A **jobs worker** running as
a supervised child process inside the agent container, claiming work from the `jobs` collection —
it is a separate component even though it shares a container, because it has its own lifecycle,
lease, and failure story. (5) One **MongoDB Atlas** cluster holding everything that carries state:
threads, messages, memories and chunks (both with vector indexes), the `searchCache` TTL
collection, the `jobs` queue, `requests`/`runs` accounting, and GridFS uploads. Two non-services
make decisions and deserve naming: the **run log** (one record per answer; it is what the quality
gates read, so it is a contract surface, not telemetry) and the **search cache** (a two-tier
LRU-plus-Mongo decorator that decides whether a search costs money).

## Responsibilities

The gateway is the only component allowed to face a browser, and the only one that may say `401`,
`400`, or rate-limit `429` — and it is *not allowed* to hold a provider key, parse an SSE frame, or
make an AI decision; it forwards bytes. The agent service is the only component that may call
Anthropic, Tavily, or OpenAI, the only one that can mint a citation (sources are only created from
material retrieved in that same request, by construction), and the only place a spend decision is
made: per-request budgets, the deep-search daily cap (`429 {error, resetsAt}`), and the kill
switch all live there, behind IAM, precisely so they cannot be bypassed by calling the AI backend
directly. The worker is the only component allowed to parse, chunk, embed, or flip a document to
`indexed` — the request path may only accept an upload (`202` in under 300 ms) and enqueue. The
loop itself is the only place `terminated` is set (`done | cap | error`), explicitly at every
exit. Mongo owns durability: nothing is reported as done that it has not acknowledged.

## Communication

Browser → gateway is HTTPS with `x-user-id` and `x-request-id` headers; the ask route is SSE
(`plan? → trace → sources → token → done`), which the gateway passes through chunk-by-chunk
without parsing, because any buffering silently destroys time-to-first-token. Gateway → agent is
the same HTTP contract plus a Google-signed IAM ID token — if the agent is down, the gateway
returns `502` before committing SSE headers, and if a stream has already started, the failure
becomes a terminal SSE `error` frame (an HTTP status cannot change mid-stream, so the error frame
is the honest channel). Agent → worker is not HTTP at all: it is the `jobs` collection, claimed
with an atomic `findOneAndUpdate` lease and heartbeats — if the worker dies mid-job, the row goes
stale and a sweeper returns it to `pending`, resuming from stage checkpoints rather than
re-running finished work. An in-flight ask whose client disconnects aborts all upstream work and
is recorded as interrupted, not as a success.

## State

Mongo is authoritative for everything a user would miss: threads and messages, long-term memories
(visible and deletable at `/memory` — nothing is remembered that the endpoint does not show),
Spaces, documents and their chunks with page/line locators, the per-user deep-search admission
ledger, and the `requests`/`runs` records that `/stats` and the graders read. Two things are
deliberately disposable caches: the in-process search LRU (dies with the instance, costs nothing)
and the `searchCache` collection (TTL-expired; deleting it only makes the next search cost
$0.008). Run logs are written to local files in development and to the `runs` collection when
deployed, because Cloud Run's filesystem is in-memory and dies with the instance. The consistency
story I had to design around: Atlas Search indexes are eventually consistent, so a chunk that has
been written is not yet searchable — a document only reaches `indexed` after a read-your-write
probe actually gets one of its own chunks back from the vector index. "Upserted" is not
"searchable", and the status field never claims otherwise.

## Trade-offs

**Atlas Vector Search instead of a dedicated vector store:** a citation is one document — the
embedding lives next to the chunk text and its page locator, and `spaceId` is a plain filter
inside `$vectorSearch` — at the cost of the M0 tier's three-search-index limit and eventual
consistency I have to probe around. **A hand-rolled agent loop over the Anthropic SDK instead of
a framework:** the contract requires control of every turn (trace events per step, sources before
tokens, explicit termination, budget checkpoints between calls), which frameworks own and hide; I
gave up prebuilt orchestration and accepted more code that is mine to get seams the graders can
actually measure. **The worker co-located in the agent container instead of a separate service:**
one always-on Cloud Run instance instead of two (instance-based billing is required anyway,
because request-billed Cloud Run throttles CPU and silently freezes a polling loop); I gave up
blast-radius isolation between ingestion and answering, and would split them at real scale.
**RRF-only hybrid retrieval with no reranker — the one I am least sure about:** skipping a
rerank step keeps a provider call off the retrieval path and the docs allow it with a documented
reason, but if recall@5 misses 0.70 on the gold set, my plan is to diagnose chunk boundaries and
candidate coverage first and only then add a bounded reranker inside the latency budget. I may
end up eating that cost anyway.
