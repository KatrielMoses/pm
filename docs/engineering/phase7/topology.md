# Phase 7 branch topology and merge order

Status: integration review (P7-IR1). Nothing here is merged and every pull request is a draft.

Phase 7 was built as one linear stack on the Phase 6 integration review, in dependency order (not
numeric subphase order): 7A, 7B, 7D, 7C, 7E, 7F. The integration review branches from the accepted
7F head, so it contains every Phase 7 commit.

## Verified stack

| Subphase | Pull request | Head branch | Base branch | Head (accepted) | Commits over the previous head | Migrations added |
|---|---|---|---|---|---|---|
| Phase 6 review | #35 | `codex/phase-6-integration-review` | `codex/phase-6d-csv-portability` | `9aa0b67` | — | 0051, 0052 |
| 7A | #36 | `codex/phase-7a-ai-gateway` | `codex/phase-6-integration-review` | `2f2b61e` | 14 | 0053, 0054 |
| 7B | #37 | `codex/phase-7b-authorized-retrieval` | `codex/phase-7a-ai-gateway` | `cdaa184` | 11 | 0055 |
| 7D | #38 | `codex/phase-7d-change-proposals` | `codex/phase-7b-authorized-retrieval` | `9542473` | 8 | 0056 |
| 7C | #39 | `codex/phase-7c-ai-drafting-analysis` | `codex/phase-7d-change-proposals` | `730c6e4` | 8 | 0057 |
| 7E | #40 | `codex/phase-7e-briefings-reviews` | `codex/phase-7c-ai-drafting-analysis` | `c28a89a` | 4 | 0058 |
| 7F | #41 | `codex/phase-7f-planning-capture` | `codex/phase-7e-briefings-reviews` | `245cf42` | 7 | 0059 |
| P7-IR1 | this review's PR | `codex/phase-7-integration-review` | `codex/phase-7f-planning-capture` | this branch | the review commits | 0060 |

Checked at review time with `git merge-base --is-ancestor` and `git rev-list --count`, and against
each pull request's recorded head: each accepted head is an ancestor of the next, each pull
request's head equals its accepted head, and `245cf42` contains every Phase 7 subphase commit.
Migrations 0053–0059 are byte-identical to their accepted heads; 0060 is the only migration this
review adds, and `docs/engineering/tools/phase7.py` re-checks owners, contiguity, and the rollback
boundaries on every verify run.

## Merge order (product owner)

Merge bottom-up, one pull request at a time, without squashing, so each subphase keeps its
accepted commits and CI evidence. The Phase 6 stack (through #35) merges first, as recorded in
`docs/engineering/phase6/topology.md`.

1. After #35 has merged into `main`, retarget #36 (7A) to `main` and merge it.
2. Retarget and merge, in order, #37 (7B), #38 (7D), #39 (7C), #40 (7E), and #41 (7F). Before each
   merge its diff against `main` must show only that subphase's commits.
3. Retarget this review's pull request to `main` and merge it last.

Supersession: none. No Phase 7 pull request replaces another; each stays open until merged.
