# DESIGN.md --- LUMINA

## Components

  ---------------------------------------------------------------------------
  \#                Component         Runs where        What it is
  ----------------- ----------------- ----------------- ---------------------
  1                 **React UI**      Vercel --- the    Query box, streaming
                    (provided,        submitted URL     answers, citations,
                    unmodified)                         memory, Spaces, and
                                                        `/evals`

  2                 **Gateway**       Cloud Run, public The only
                    (Express)                           browser-facing
                                                        service: validation,
                                                        rate limiting,
                                                        logging, proxying,
                                                        and local `web/dist`
                                                        serving

  3                 **Agent service** Cloud Run,        Agent loop, tools,
                    (Express)         **IAM-gated**     memory, RAG, deep
                                                        search, spend
                                                        controls, and all
                                                        provider credentials

  4                 **Jobs worker**   Child process     Claims
                                      inside the agent  document-indexing
                                      container         jobs, manages
                                                        leases/checkpoints,
                                                        and performs parsing,
                                                        chunking, and
                                                        embedding

  5                 **MongoDB Atlas** Atlas M0, GCP     Threads, messages,
                                      `europe-west2`    memories, Spaces,
                                                        documents/chunks,
                                                        search cache, jobs,
                                                        run/accounting data,
                                                        and GridFS uploads
  ---------------------------------------------------------------------------

Two supporting components are also important because they carry state or
influence execution:

-   **Run log** --- one durable record per answer; used for
    observability and evaluation evidence.
-   **Search cache** --- two-tier cache (`LRU → searchCache → provider`)
    that reduces repeated provider calls and cost.

## Responsibilities

The key design principle is clear ownership: each component has
responsibilities it owns and boundaries it must not cross.

-   **Gateway** --- the only component that faces the browser and
    enforces edge concerns such as `401`, `400`, and rate-limit `429`.
    It must not hold provider keys, make AI decisions, or interpret SSE
    frames; it forwards the stream unchanged.
-   **Agent service** --- the only component that calls external
    AI/search providers. It owns the agent loop, citations, budgets,
    deep-search admission, and kill switches. Citations can only be
    created from evidence retrieved during the current request.
-   **Worker** --- the only component allowed to parse, chunk, embed,
    and mark a document as `indexed`. The request path accepts the
    upload, persists the job, and returns `202`.
-   **Agent loop** --- the only place that determines terminal execution
    state: `done | cap | error`.
-   **MongoDB** --- owns durable application state and accounting. A run
    is not reported as successfully completed until the required
    persistence has been acknowledged.

## Communication

  --------------------------------------------------------------------------------------------
  Link                    Mechanism                                    Why this way
  ----------------------- -------------------------------------------- -----------------------
  Browser → gateway       HTTPS + `x-user-id` / `x-request-id`; ask    Keeps the browser on
                          uses SSE                                     one public endpoint
                          (`plan? → trace → sources → token → done`)   while preserving
                                                                       ordered streaming
                                                                       events and citations
                                                                       before answer tokens

  Gateway → agent         Same HTTP contract + Google-signed Cloud Run Keeps the agent private
                          IAM ID token; SSE passed through             and prevents buffering
                          chunk-by-chunk                               from adding latency or
                                                                       breaking TTFT. Upstream
                                                                       failure becomes `502`
                                                                       before headers; after
                                                                       streaming starts,
                                                                       failure is represented
                                                                       by the SSE `error`
                                                                       event

  Agent → worker          MongoDB `jobs` collection with atomic claim, Avoids a separate
                          lease, heartbeat, and checkpoints            queue/service for the
                                                                       course design. A
                                                                       crashed worker can be
                                                                       reclaimed and resumed
                                                                       safely

  Client disconnect →     Abort signal propagated upstream             Cancels in-flight work
  backend                                                              and records the
                                                                       interrupted execution
                                                                       rather than treating it
                                                                       as success
  --------------------------------------------------------------------------------------------

## State

**Authoritative state --- MongoDB:**

-   Threads and messages
-   Long-term memories, visible and deletable through `/memory`
-   Spaces, documents, and chunks with page/line locators
-   Per-user deep-search admission ledger
-   `requests` / `runs` accounting used by `/stats` and evaluation

**Disposable state:**

-   In-process search LRU --- lost when the instance is replaced
-   `searchCache` --- TTL-based; deleting it affects performance/cost,
    not correctness

**Deployment note:** run logs are local files during development but are
persisted in MongoDB when deployed because the Cloud Run filesystem is
ephemeral.

**Consistency:** Atlas Search is eventually consistent. A written chunk
is therefore not considered indexed until a read-your-write probe
confirms that it is searchable. The system treats **"written" and
"searchable" as separate states**.

## Trade-offs

Four important choices were made deliberately:

1.  **MongoDB Atlas Vector Search instead of a dedicated vector
    database.**\
    Keeping embeddings, chunk text, locators, and ownership metadata
    together simplifies the design and citation path. The trade-off is
    Atlas tier/index limits and eventual consistency, which requires the
    read-your-write check.

2.  **A custom agent loop instead of an agent framework.**\
    LUMINA needs explicit control over tool calls, trace events, source
    ordering, termination states, and budget checkpoints. A custom loop
    adds implementation effort, but makes those behaviours predictable
    and testable.

3.  **Worker co-located with the agent instead of a separate service.**\
    This keeps the course deployment small and avoids another service to
    operate. The trade-off is shared CPU/memory and a larger blast
    radius. At production scale, the worker should be separated.

4.  **RRF-only hybrid retrieval initially, without a reranker.**\
    RRF keeps the retrieval path simple and avoids another provider call
    on the quick path. The trade-off is potentially lower ranking
    quality. If the measured `Recall@5` target is missed, first tune
    chunking and candidate coverage; add a bounded reranker only if the
    evidence justifies its latency and cost.
