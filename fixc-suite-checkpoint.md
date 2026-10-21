# Checkpoint: fix C port suite run (job e67d3ee6)

## Zrobione
- A parallel job, `2026-10-21-fix-c-port-trace-red-tests-fork-9e23e77b` (same goal: trace red tests, push, open the fork PR), runs at the same time. It pruned the verify worktrees under `/home/dev/projects/.limen-limen-worktrees/`. My worktrees now live outside that folder: `~/fixc-e67d/v2` (51614a4) and `~/fixc-e67d/base` (a8cb4b0), both `npm ci` from lockfile.
- That job already pushed fork `port/fix-c-handoff-truthful` to 27a47d2 ("Compact the truthful handoff test to fit the test/ line cap", on top of 51614a4). No PR exists yet in SzpakowskiPersonit/limen for that head (`gh pr list` empty at checkpoint).
- On 51614a4: `tsc --noEmit` pass; `biome check --error-on-warnings .` pass (147 files).
- Per-file suite on 51614a4 (`~/fixc-e67d/run.sh`, NODE_OPTIONS unset, `--test-concurrency=1`, one file at a time). Logs: `~/fixc-e67d/out-v2/<file>.log`, summary `~/fixc-e67d/out-v2/summary.txt`:
  - group-extensions 4/4 pass; s11-devin 2/2; s12-truthful-handoff 4/4; s1-spawn 3/3.
  - s10-doorbell 0/1 (fail: "unsafe owner or permissions on /tmp"; environment hypothesis, unverified on base).
  - s2-hosted 1/5 pass, 2 fail (hosted tests need Herdr; unverified on base).
  - Remaining files were still running when the budget stop came.

## Zostało
- Do not duplicate job 9e23e77b. First check its state and the fork PR. If it opened the PR, this task is done by that PR; report its URL and head SHA.
- If no PR and 9e23e77b is finished: run `~/fixc-e67d/run.sh ~/fixc-e67d/base ~/fixc-e67d/out-base <red files>` and compare with out-v2. Then open the PR: `gh pr create -R SzpakowskiPersonit/limen --base main --head port/fix-c-handoff-truthful`. The fork head is now 27a47d2, not 51614a4; do not force-push over it.
- Never push to origin overment/limen. Do not touch the running limen service.
- Factory rung 4 asks for `test_*.py`; the change carries `test/s12-truthful-handoff.test.ts`. Owner decision.

## Gałąź
- Job branch: `limen/2026-10-21-finish-fix-c-port-memory-safe-su-294fc05b` (this checkpoint commit).
- Work branch: fork `port/fix-c-handoff-truthful` at 27a47d2 (pushed by job 9e23e77b); local `port/fix-c-handoff-truthful` at 51614a4.

## Następny krok
- `gh pr list -R SzpakowskiPersonit/limen --head port/fix-c-handoff-truthful --state all` and read `.limen/jobs/2026-10-21-fix-c-port-trace-red-tests-fork-9e23e77b/` outcome before any further run.
