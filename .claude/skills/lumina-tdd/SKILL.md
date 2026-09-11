---
name: lumina-tdd
description: The TDD process for all LUMINA backend code (backend/agent, backend/gateway). Use before writing or changing any implementation file — it defines the red→green→refactor loop, the test taxonomy per module, and the definition of done for a slice. Also use when a gate or bench failure needs a regression test.
---

# LUMINA TDD — red, green, refactor

Every behavior in `backend/agent/` and `backend/gateway/` is built test-first. The graders
never read tests — the bench and quality kit are the acceptance gates (`lumina-edd`) — but
TDD is how we arrive at code that passes them without thrashing.

## The loop (non-negotiable order)

1. **Red.** Write a failing test for the next small behavior. Run it. **Confirm it fails for
   the expected reason** — a test that fails because of a typo or missing import proves
   nothing. If delegating, the `test-writer` agent does this step and must report the failure
   message verbatim.
2. **Green.** Write the minimal implementation that passes. No speculative structure — the
   module layout comes from ARCHITECTURE.md §2, but files are created when a test demands
   them, not scaffolded empty ("the module list is a responsibility map, not a requirement to
   scaffold every file first"). The `implementer` agent does this step and may not edit tests.
3. **Refactor.** With green tests, clean up. Re-run tests + `npm run typecheck` + `npm run lint`.

**Exceptions to test-first** (the only ones): composition roots (`index.ts` wiring),
type-only files, provider adapters (see taxonomy), and config objects. Everything else —
including "trivial" guards — gets a red test first.

## Test taxonomy (what kind of test, per module)

| Layer | Modules | How to test |
|-------|---------|-------------|
| Pure units (no I/O, no fakes needed) | `core/budget`, `core/deep/merge`, `core/citations`, `core/sourceCollector`, `guards/ssrf` (parsing/vetting logic), `ingest/jobStateMachine`, RRF fusion math, cache key derivation, `obs/cost` | Direct calls, exhaustive edges. These are the highest-value tests in the repo — budget races, merge renumbering, citation resolution are where grading points live. |
| The loop | `core/loop`, `quick/orchestrator`, `deep/orchestrator`, `deep/planner` | **Fake ports** (hand-written `LlmPort`/`SearchPort`/`EmbeddingsPort` stubs returning scripted turns) + an **array-collecting AskEmitter**. Assert on the emitted event sequence: sources-before-token, plan-before-retrieval, trace ok:false carries error, terminated set right. No HTTP, no SDKs, no network. |
| HTTP routes & middleware | `http/routes/*`, gateway `middleware/*`, `proxy/*` | `supertest` against an Express app built with in-memory fake repos/ports. Assert status codes + bodies against `@lumina/contract` zod schemas — parse the response with the schema, don't hand-match fields. |
| Provider adapters | `providers/llm/anthropic`, `search/tavily`, `embeddings/openai` | **Excluded from unit TDD** — they are thin translations; unit-mocking the SDK tests the mock. They are covered by the EDD smoke ladder against real providers. Error-mapping logic (SDK error → ProviderError) IS pure and IS unit-tested. |
| Repos | `repos/*` | Thin Mongo pass-throughs: not unit-tested against mocks. Logic that creeps into a repo (e.g. the deepCap conditional reservation pipeline) moves to a pure function that builds the query/update documents — test that. |

## Conventions

- Test files colocated: `src/**/<module>.test.ts`. Runner: **vitest** (`npm run test -w
  @lumina/agent`, `-w @lumina/gateway`, or root `npm test`).
- **Fake ports over SDK mocks.** Never `vi.mock('@anthropic-ai/sdk')` — implement the port
  interface with a scripted stub. Ports exist exactly so tests don't know SDKs exist.
- **Never mock what we own.** Loop tests use the real Budget, real SourceCollector, real
  merge — only the ports are fake.
- **Contract schemas are the assertions.** An emitted event or response body is verified by
  parsing it with the zod schema from `@lumina/contract`, so tests can't drift from the wire.
- **Every gate/bench failure gets a regression test first**, reproducing the failure at the
  smallest layer that exhibits it, before the fix. This is how EDD failures feed back into TDD.
- Tests never hit the network, never read `.env` secrets, never require Mongo. (Integration
  against `docker compose up mongo` is allowed later for repo/worker paths, marked and skipped
  by default; correctness claims still come from the gates.)

## Definition of done — for any slice

1. New/changed behavior has tests that were seen red.
2. `npm test` green in the touched workspace.
3. `npm run typecheck` and `npm run lint` clean.
4. The slice's EDD gate (see `lumina-edd` milestone map) ran; result recorded in PROGRESS.md.
5. `red-line-auditor` pass before the commit batch.
