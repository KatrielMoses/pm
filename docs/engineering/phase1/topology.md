# Phase 1 branch topology and merge order

Status: integration review (P1-IR1). Nothing here is merged; every pull request is a draft.

Phase 1 was built as one linear stack. Each subphase branch starts from the previous accepted head,
so each pull request shows only its own subphase. Accepted order: 1A, 1B, 1F, 1C, 1D, 1E. 1F came
before 1C because 1C archives and restores through the 1F primitives.

| # | Pull request | Head branch | Base branch | Head | Commits over base | Migrations added |
|---|---|---|---|---|---|---|
| 1A | (on `main`) | `main` | — | `a2f63e7` | — | 0001–0009 |
| 1B | #1 | `phase-1b-identity` | `main` | `8249380` | 3 | 0010–0012 |
| 1F | #2 | `phase-1f-audit-lifecycle` | `phase-1b-identity` | `741481f` | 2 | 0013–0016 |
| 1C | #3 | `phase-1c-workspaces-brands` | `phase-1f-audit-lifecycle` | `30919ff` | 1 | 0017–0018 |
| 1D | #4 | `phase-1d-membership-roles` | `phase-1c-workspaces-brands` | `74e3c54` | 1 | 0019 |
| 1E | #5 | `phase-1e-shell-navigation` | `phase-1d-membership-roles` | `5f636c8` | 6 | 0020 |
| P1-IR1 | integration PR | `phase-1-integration-review` | `phase-1e-shell-navigation` | this branch | — | none |

Checked at review time (`git merge-base --is-ancestor`, `git cherry`, migration history):

- Each head is an ancestor of the next, and `5f636c8` contains every subphase commit. No commit
  sits on another branch only, and none is duplicated.
- Migrations 0001–0020 are contiguous and paired up/down. Each was added exactly once, in the
  order above, and never modified afterwards. `docs/engineering/tools/phase1.py` re-checks
  contiguity and pairing on every verify run.
- The integration branch adds no migration.

## Merge order (product owner)

Merge bottom-up, one pull request at a time, without squashing, so each subphase keeps its
accepted commits and CI evidence:

1. #1 into `main`.
2. Retarget #2 to `main`, then merge it.
3. Repeat for #3, #4, and #5, in that order.
4. Retarget the integration pull request to `main` and merge it last.

After each merge, the next pull request's diff must show only that subphase's files. If it shows
more, stop: the history diverged. A squash or rebase merge rewrites the commits that later
pull requests build on. Use a merge commit or fast-forward, or explicitly accept re-running CI on
the rewritten stack.
