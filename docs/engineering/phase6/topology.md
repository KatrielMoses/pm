# Phase 6 branch topology and merge order

Status: integration review (P6-IR1). Nothing here is merged. Every pull request except #32 is a
draft. #32 (6C) is open, ready for review, and targets `main`; the merge order below handles that.

6A and 6B were built in parallel from the accepted Phase 5 final-integration head. 6C reconciled
them (it contains both) and added calendar. 6E and 6D were then built in parallel from 6C; 6E was
accepted first and 6D was rebuilt on it. The integration review branches from the accepted 6D
head, so it contains every Phase 6 commit.

| # | Pull request | Head branch | Base branch (as opened) | Head | Commits over the previous head | Migrations added |
|---|---|---|---|---|---|---|
| 6A | #30 | `phase-6a-integration-framework` | `phase-5-final-integration` | `9eeee12` | 6 over `phase-5-final-integration` | 0045 |
| 6B | #31 | `phase-6b-public-api-webhooks` | `phase-5-final-integration` | `17ccc67` | 6 over `phase-5-final-integration` | 0046 |
| 6C | #32 | `phase-6c-google-calendar` | `main` | `d5e5eb1` | 16 over 6A (and over 6B; it contains both) | 0047 |
| 6E | #33 | `phase-6e-mcp-access-foundation` | `phase-6c-google-calendar` | `5917b9e` | 10 over 6C | 0048, 0049 |
| 6D | #34 | `codex/phase-6d-csv-portability` | `phase-6e-mcp-access-foundation` | `6b4bb78` | 13 over 6E | 0050 |
| P6-IR1 | this review's PR | `codex/phase-6-integration-review` | `codex/phase-6d-csv-portability` | this branch | the review commits | 0051 |

Checked at review time (`git merge-base --is-ancestor`, `git rev-list --count`, migration
history):

- `phase-5-final-integration` is an ancestor of 6A and of 6B. 6A and 6B are both ancestors of 6C.
  6C is an ancestor of 6E, 6E of 6D, and 6D of this branch. `6b4bb78` contains every Phase 6
  subphase commit; none sits only on another branch.
- Migrations 0045–0050 are byte-identical to their accepted heads (applied checksums unchanged).
  0051 is the only migration this review adds. `docs/engineering/tools/phase6.py` re-checks owners,
  contiguity, pairing, and the rollback boundaries on every verify run.

## Merge order (product owner)

Merge bottom-up, one pull request at a time, without squashing, so each subphase keeps its
accepted commits and CI evidence. Phase 5 (#29 and its own stack) merges first.

1. After Phase 5 has merged into `main`, retarget #30 (6A) to `main` and merge it.
2. Retarget #31 (6B) to `main` and merge it. Its diff must show only 6B's files.
3. #32 (6C) already targets `main`. After 6A and 6B have merged, its diff must show only the 6C
   reconciliation and calendar commits. Merge it.
4. Retarget #33 (6E) to `main` and merge it.
5. Retarget #34 (6D) to `main` and merge it.
6. Retarget this review's pull request to `main` and merge it last.

After each merge, the next pull request's diff must show only that subphase's files. If it shows
more, stop: the history diverged. A squash or rebase merge rewrites the commits that later pull
requests build on. Use a merge commit or a fast-forward, or explicitly accept re-running CI on every
later head.
