# RUNBOOK.md — running and operating LUMINA

The project's own notes: how to run it, how it is deployed, and the things that cost time.

`README.md` is the **course's assignment brief** and is left exactly as delivered. The design
answers live in [`DESIGN.md`](../DESIGN.md), the decided architecture in
[`ARCHITECTURE.md`](ARCHITECTURE.md), and the delivery record — every gate result, in order,
including the failures — in [`PROGRESS.md`](../PROGRESS.md).

## Live

| | |
|---|---|
| **Submitted URL** (the provided UI, unmodified) | https://lumina-theta-woad.vercel.app |
| Gateway (public API, also serves the same UI) | https://lumina-gateway-iwc6fhv5oa-nw.a.run.app |
| Agent | not publicly reachable — `--no-allow-unauthenticated`, only the gateway's service account holds `run.invoker` |
| GCP | project `all-thing-agentic-505911`, region `europe-west2` |
| Data | MongoDB Atlas M0, GCP `europe-west2` |
| Models | Azure OpenAI `gpt-5.4-mini` (chat) · `text-embedding-3-large` at 1536 dims · endpoint in Sweden Central |

## Run it locally

Node ≥ 20.19. Copy `.env.example` to `.env` and fill it in — both services read that one file.

```bash
npm install
npm run build -w @lumina/contract   # REQUIRED first: the workspaces import its dist/
npm run indexes                     # Atlas vector + BM25 + TTL indexes (once per cluster)
node scripts/create-indexes.mjs --status   # search indexes build async — wait for queryable
npm run dev                         # agent :8000 · gateway :8787 · UI :5173
```

`npm run dev` supervises the jobs worker inside the agent process (`WORKER_MODE=child`). To run
it standalone instead, set `WORKER_MODE=off` and `npm run worker`.

No Atlas? `docker compose up mongo` and `VECTOR_BACKEND=mongo-cosine-scan` — `/health` then says
so, truthfully.

## The gates

There is no separate test suite for behaviour: the bench, the quality checker and the eval
ladder **are** the tests. Unit tests cover the pure modules and the ports.

```bash
npm run typecheck && npm run lint
npm test                                   # 365 agent + 57 gateway
node benchmark/bench.mjs --smoke           # 5 queries, cheap
npm run bench                              # the full 75-answer bench — real money
npm run quality                            # reads runs/*.json; exit ≤ 1 is a pass
npm run eval                               # all six gates in order, stops at the first failure
```

Add `--target <url>` to the bench, or `--deploy-url <url>` to the eval, to run them against the
deployment instead of localhost.

**Where the gates stand** (deployed, 2026-09-14): 15 of 16 bench caps, quality 0 errors and 1
warning, report 82/85 automated. The one failure is `ttft p95` — see PROGRESS.md, which records
what was measured and which fixes were rejected on their own numbers. Two boxes are human, not
code: quality rule **P1** (a person reads one successful and one failing trajectory end to end)
and the submission video.

## Deploying

Push to `master`. `.github/workflows/deploy.yml` builds both images, deploys the agent with **no
traffic**, smoke-tests that candidate over an IAM-authenticated call, promotes it, then deploys
the gateway. Auth is Workload Identity Federation — there are no JSON keys anywhere.

A deploy only swaps the image. **Runtime env and secrets live on the services**, so they survive
deploys and are changed deliberately:

```bash
gcloud run services update lumina-gateway --region europe-west2 \
  --update-env-vars "^@^CORS_ORIGINS=http://localhost:5173,https://lumina-theta-woad.vercel.app"
```

Provider keys are in Secret Manager, mounted into the agent only. The gateway holds none: it
proves who it is to the agent with an ID token minted by the metadata server
([`proxy/idToken.ts`](backend/gateway/src/proxy/idToken.ts)).

**The UI** is deployed separately and by hand, because `vercel git connect` needs a GitHub login
connection on the Vercel account:

```bash
npx vercel deploy --prod          # root vercel.json builds the contract first, outputs web/dist
```

## Publishing the evals report

`/evals` reads an artifact an operator published — never a live computation. The chain, after a
deployed bench:

```bash
cd backend/agent && npm run build
node dist/ops/exportRuns.js --since <ISO>      # deployed run logs out of Mongo, WITH depth
cd ../.. && node quality/check.mjs .
node eval/build-report.mjs --student "Saurabh Bhardwaj"
cd backend/agent && node dist/ops/publishReport.js
curl -sI https://lumina-gateway-iwc6fhv5oa-nw.a.run.app/evals/report.json   # ETag + X-Published-At
```

Use `dist/ops/exportRuns.js`, not the provided `scripts/export-runs.mjs`: the provided one drops
`depth`, which the quality rules need.

## Things that cost time

- **`npm run typecheck` fails with "Cannot find module '@lumina/contract'"** until you build the
  contract package once.
- **Atlas Search indexes are eventually consistent.** "Upserted" is not "searchable" — ingestion
  only reports `indexed` after a read-your-write probe actually finds the chunk.
- **`spaceId` must be filtered *inside* `$vectorSearch`.** A later `$match` silently leaks across
  Spaces.
- **An empty env var is not zero.** `Number('')` is `0`, which is finite, so `PORT_AGENT=` once
  meant "listen on a random port". `num()` treats empty as unset.
- **The openai SDK's retry sleeps on Azure's `Retry-After`** — 30 s, inside the call, ignoring
  the abort signal. It is turned off; ours is bounded, cancellable and logged
  ([`providers/llm/retry.ts`](backend/agent/src/providers/llm/retry.ts)). A slow turn should
  always be explainable from the log.
- **Cloud Run scales to zero unless told otherwise.** Both services now run `min-instances 1`;
  the agent also needs `--no-cpu-throttling`, or the polling worker freezes between requests.
- **Deliberately failed runs belong in `runs/failing/`**, never `runs/` — quality rule A2 fails
  any non-`done` run it finds in `runs/`. Never delete a real failure.

## Repo layout

```
backend/agent/      the work: loop, tools, memory, RAG, deep search, worker, run logs, ops CLIs
backend/gateway/    the edge: auth, validation, rate limit, SSE pass-through, IAM token minting
packages/contract/  zod schemas — outranks all prose
web/                the provided UI. DO NOT EDIT — it is the acceptance test
benchmark/ eval/ quality/ scripts/   provided graders. DO NOT EDIT
```

The only sanctioned edits inside those provided folders were `benchmark/sla.json`'s `cost_model`
(the learner declares real provider rates) and the TODO `precedent` arrays in
`quality/rules.json`. Both are recorded in PROGRESS.md.
