---
name: lumina-track
description: Keep the LUMINA project on track. Use at session start ("where are we", "what's next"), at session end, when completing a milestone, and before any commit batch. Reads and updates PROGRESS.md, verifies claimed state against reality, flags drift, and enforces the pre-commit checklist.
---

# LUMINA track — where are we, what's next, is it true

PROGRESS.md is the single source of truth across sessions, but only if it is verified, not
trusted. This skill has three modes; pick from what the user asked.

## Mode 1 — Orient (session start / "what's next")

1. Read `PROGRESS.md`, `git log --oneline -10`, `git status --short`.
2. **Verify the claimed state cheaply** — claims are checked, not believed:
   - `npm run typecheck` (fast, catches drift instantly)
   - `npm test` if test scripts exist
   - If PROGRESS.md cites gate results: confirm `reports/bench.json` / `reports/gates.json`
     exist and their `ranAt` is consistent with the claim. A cited result with no artifact is
     drift — flag it and downgrade the milestone to 🔨.
3. Report exactly four things, in order:
   - **Current milestone** and its one-line scope
   - **Next single action** (one, not a list — the smallest step that advances the milestone)
   - **Blockers** (from the Status block; verify they still hold, e.g. does `.env` exist now?)
   - **Drift**, if any: uncommitted work, a ✅ without recorded EDD proof, provided-folder
     modifications in `git status`, PROGRESS.md older than the last code commit.

## Mode 2 — Checkpoint (milestone completion / session end)

1. A milestone flips to ✅ **only** when its EDD-proof column can cite a real gate run
   (command + result + date). "It should pass" is 🔨, not ✅.
2. Append one session-log row: date · did · tests · gates (with results) · next · notes.
   Keep rows one line; detail lives in commit messages.
3. Update the Status block (current milestone, blockers, last gates).
4. Commit PROGRESS.md **in the same commit as the work it describes** — never a separate
   "update progress" commit drifting from the code it claims.

## Mode 3 — Pre-commit checklist (before any commit batch)

Run the `red-line-auditor` agent for the full audit; minimum inline check when the change is
trivial:

```bash
git status --porcelain | grep -E '^\s*[AM].*(web/|packages/contract/|benchmark/|eval/|quality/|scripts/|\.claude/skills/fde-lumina-eval/)' \
  && echo "RED LINE: provided folder staged" || echo "provided folders clean"
git status --porcelain | grep -E '\.env$|^..\s*(runs|reports)/|node_modules' \
  && echo "RED LINE: unstage" || echo "hygiene clean"
git diff --cached | grep -nEi 'mongodb\+srv://[^ ]*:[^ ]*@|sk-[A-Za-z0-9]{20,}|tvly-[A-Za-z0-9]{16,}' \
  && echo "RED LINE: secret in diff" || echo "no secrets"
```

Plus: commit message has **no co-author trailer**; PROGRESS.md included if a milestone-state
claim changed; the work followed `lumina-tdd` (tests exist and were red first) and, if a
milestone closes, `lumina-edd` (proof recorded).

## Standing truths (repeat these when they are at risk)

- The next milestone order lives in PROGRESS.md; do not reorder without saying so there.
  RAG (M7) is the biggest lift; deep search (M8) reuses the quick loop — a grounded,
  streaming, well-traced loop with memory outranks half-finished later milestones.
- A gate that cannot run yet is reported as **"not run"**, never assumed or extrapolated.
- Numbers come from artifacts (`reports/*.json`, `runs/*.json`), never from memory of a
  previous run.
