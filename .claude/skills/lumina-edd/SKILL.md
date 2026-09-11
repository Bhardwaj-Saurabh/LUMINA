---
name: lumina-edd
description: Eval-Driven Development for LUMINA — the provided gates (quality/check.mjs, benchmark/bench.mjs, eval/eval.mjs) ARE the evals. Use when starting a milestone, when deciding which gate proves a feature, when a gate or bench cap fails, or before claiming any milestone done. Defines the red→build→green eval loop and the milestone→cap map.
---

# LUMINA EDD — the graders are the evals

We never invent thresholds and never touch theirs. `benchmark/sla.json`, `expectations.json`,
`eval/rubric.json`, and the `quality/` kit are the eval suite; our job is to make them pass
for real. **Editing a provided file, weakening a threshold, or special-casing bench traffic
is a red line, not a technique.**

## The EDD loop (per milestone)

1. **Name the proof.** From the map below, identify the gate/caps that prove the milestone.
2. **Run it red.** Run that gate BEFORE building and confirm it fails **for the expected
   reason** (e.g. `501 not implemented`, cap `memorySaved: false`). An unexpected failure
   reason means the plan is wrong — stop and understand it first.
3. **Build** the slice via `lumina-tdd`.
4. **Run it green.** Re-run the same gate. Read cap names, not vibes.
5. **Record both runs** (red reason → green result) in PROGRESS.md's session log, and tick
   the milestone only now. Delegate runs to the `gate-runner` agent; it reports, never fixes.

## Gate ladder (cheapest first — run the cheapest thing that can falsify the work)

| Rung | Command | Proves / costs |
|------|---------|----------------|
| 0 | `npm run typecheck && npm run lint && npm test` | Free, no providers. Always first. |
| 1 | `node quality/check.mjs .` | C1 config sanity + trajectory rules (A1/A2/A3/R2) over `runs/*.json`. Free. |
| 2 | `node benchmark/bench.mjs --smoke` | 5 quick queries end-to-end through the gateway. Costs a few LLM/search calls. **Smoke skips RAG, deep search, and memory** — it can never prove M5/M7/M8. |
| 3 | `node benchmark/bench.mjs` | The full workload: web (50 % repeats), RAG gold set, ingest decoupling, deep-vs-quick pairs, memory, /stats. Costs real money — run when a capability is believed done, not per-edit. |
| 4 | `node eval/eval.mjs [--deploy-url <url>]` | All six gates in order, stops at first failure. The `--deploy-url` form is what the grader runs. |

Both services must be up for rungs 2+ (`npm run dev`, or deployed). Bench refuses to run if
`/health` says the db is down — that is rung 2 telling you M1 isn't done.

## Milestone → proof map

| Milestone | Gate rung | Caps / metrics that must flip |
|-----------|-----------|-------------------------------|
| M1 env/indexes | `create-indexes.mjs --status` | all 3 search indexes `queryable`; `/health` db ok |
| M2 quick slice | 2 | smoke completes; `contractProbes` (401/404/400); `sourcesBeforeFirstToken`; a `runs/*.json` exists and rung 1 reads it |
| M3 search cache | 2 then 3 | repeat query → `searchCached: true`; full-bench cache hit ≥ 50 % |
| M4 threads/messages | 2 | follow-up sees thread; web workload green |
| M5 memory | 3 (memory phase) | `memorySaved` · `memoryRecalled` (trace shows recall_memory in thread B) · `memoryDeleted` |
| M6 gateway | 2 through :8787 | all `contractProbes` via gateway; TTFT measured through the gateway |
| M7 RAG | 3 (RAG + decoupling phases) | `accept202` (<300 ms p95) · `indexedViaWorker` · `pageLocator` · `routerPicksDocs` · recall@5 ≥ 0.70 · ingest ratio ≤ 1.3× |
| M8 deep search | 3 (deep phase) | `deepPlan` (≥3 sub-qs, plan before retrieval) · `deepAttribution` (every retrieval step + source tagged; planner trace exempt) · `deepReadsMore` (≥2× distinct sources) · `deepBudget` · `deepCap429` (+`resetsAt`) · `quickNeverEscalates` |
| M9 full local proof | 3 + 1 | bench exit 0 vs `sla.json`; quality exit ≤ 1; `statsReconciles`; `requestIdEchoed` |
| M10 deployed | 4 with `--deploy-url` | all six gates against the public gateway; report built from those artifacts only |

## Failure protocol

1. Read the failing **cap name / rule id** from the output (`reports/bench.json` has the
   detail; `quality/check.mjs` prints per-rule ✓/✗).
2. Map it: caps → rubric rows (`eval/rubric.json`), rules → `quality/rules.json` meanings.
3. Reproduce at the smallest layer, **write the regression test first** (`lumina-tdd`), fix,
   re-run the rung.
4. Legitimate but wrong-looking numbers: unverifiable citations (blocked publishers) are
   excluded from grounding, not failures; dangling `[n]` is fatal — never confuse the two.
5. Forbidden responses to a failure: loosening any threshold · editing provided folders ·
   detecting bench traffic · deleting real failed runs from `runs/` (the deliberate P1
   failure lives in `runs/failing/`, everything else stays) · marking a capped run `done`.

## Cost discipline

Rungs 2–4 spend real money (LLM + search + embeddings). Prefer rung 0/1 during development;
batch full-bench runs; the bench's own cache-friendly workload keeps repeat costs down. Every
full bench run's cost shows up in `/stats` — that is a feature, look at it.
