# Checkpoint: fix C port suite run

## Zrobione
- Verify worktree: `/home/dev/projects/.limen-limen-worktrees/fixc-verify-294fc05b`, detached at 51614a4 (`port/fix-c-handoff-truthful`). `npm ci` from lockfile.
- 51614a4 and fork `port/fix-c-handoff-truthful` (b94ae0d) have the same tree (`git diff --stat` empty).
- `tsc --noEmit`: pass. `biome check .`: pass ("Checked 147 files ... No fixes applied").
- Suite in batches of 4 files, `--test-concurrency=1`, NODE_OPTIONS unset. Logs: `<verify worktree>/.verify/batchN.log`.
  - batch1 (group-extensions, s1-spawn, s10-doorbell, s11-devin): tests 10, pass 9, fail 1. Fail: s10-doorbell "only an authorized request rings the doorbell" -> `AssertionError: unsafe owner or permissions on /tmp`. Hypothesis (unverified): environment (/tmp owner), not fix C. Check to run: same test on a8cb4b0.
  - batch2 (s12-truthful-handoff, s2-hosted, s3-finish-wake, s4-steering): was running at checkpoint; 4 failures seen so far (hosted argv/handoff, live OMP job vs Herdr 60s timeout, hosted Pi stop 60s timeout, competing sweeps). Hosted tests need Herdr/tmux; hypothesis (unverified): environment.
  - batches 3-7: not run or not finished.

## Zostało
- Finish batches 2-7 and read summaries.
- Run each failing file on base a8cb4b0 (`git worktree add --detach ... a8cb4b0`) to separate environment failures from regressions.
- Only after that: `git push --force-with-lease=port/fix-c-handoff-truthful:b94ae0d fork 51614a4:refs/heads/port/fix-c-handoff-truthful`, then `gh pr create -R SzpakowskiPersonit/limen --base main --head port/fix-c-handoff-truthful`. Never push to origin.
- Factory rung 4 asks for a `test_*.py`; the commit carries `test/s12-truthful-handoff.test.ts` instead. Adding a file changes the SHA the task names. Owner decision.

## Gałąź
- Work: `port/fix-c-handoff-truthful` at 51614a4 (local), fork at b94ae0d (same tree). Not pushed yet.
- Job branch: `limen/2026-10-21-finish-fix-c-port-memory-safe-su-294fc05b` (WIP notes commit, pushed to fork).

## Następny krok
- In the verify worktree: `unset NODE_OPTIONS; node --test --test-concurrency=1 --test-timeout=60000 test/s10-doorbell.test.ts` on a8cb4b0 and on 51614a4; compare.
