# Phase 7 integration review and exit gate (P7-IR1)

Status: engineering exit gate accepted by the architect at head `3df1b54` (CI run 39223070408,
attempt 1, all four shards green; draft PR #42), recorded under the P8-W0 brief
([ADR-0044](../adr/0044-phase-7-integration.md), [closure-7.json](closure-7.json), checked by
`docs/engineering/tools/phase7.py`). This is engineering acceptance only.
Phase 7 is not production-ready and not live-provider-tested: production AI and transcription stay disabled, and
every automated proof uses labelled deterministic fixtures. REL-FU-7A-01 is closed by
[ADR-0045](../adr/0045-effect-recovery-safety.md); it remains a candidate for architect review.

## Exit gate

| Gate | Evidence |
|---|---|
| Accepted subphases | 7A `2f2b61e`, 7B `cdaa184`, 7D `9542473`, 7C `730c6e4`, 7E `c28a89a`, 7F `245cf42`; each accepted at its CI run (ADR-0044) |
| Requirement closure | 64 owned requirements closed once by their owners (63 implemented, 1 foundation: BRF-010 → 8C); 43 contributions; 18 later-phase boundaries, each citing its owning subphase; derived from the catalog by `phase7.py` |
| Corrective history | 7 corrective reviews, 17 groups, each still resolving to code and registered tests |
| Migrations | 0053–0059 unchanged; 0060 added; fresh one-shot schema equals the stepped schema; every boundary 0052–0060 reverses and re-applies exactly (tables, constraints, grants, policies, functions, triggers) |
| Cross-surface matrix | AT-524–AT-533 (`phase7-matrix.test.ts`) |
| Browser journeys | AT-534–AT-538 (`e2e/phase7-exit-journey.spec.ts`) on desktop, tablet, and mobile |

## Capability matrix

| Capability | Implemented (fact, rule, or fixture behavior) | Production state | Manual or live check | Next owner |
|---|---|---|---|---|
| AI gateway, budgets, history (7A) | One provider path; hard reservations at dispatch; immutable per-attempt pricing; unknown outcomes held and reconciled, never resent | Disabled (DQ-28, OD-41, OD-46) | Real-model cost and input bounds | Provider approval decision; 10A for entitlements |
| Retrieval and citations (7B) | Lexical candidates, canonical loaders, a reviewed manifest, verbatim excerpts; incomplete output is never a checked answer | Disabled | Model answer quality | OD-31 for semantic search |
| Change proposals (7D) | Typed, versioned, edited, selected, approved, applied once in one transaction; reauthorized at every step and on replay | Fixture generation only | — | Phase 8 agents consume it |
| Drafting and analysis (7C) | One action catalog; confirmation bound to the exact input; offered choices typed and redacted | Disabled | Model draft quality | — |
| Briefings and reviews (7E) | Fact-only, recipient-specific, evidence-bound, fail-closed publication; personal notes; schedules with in-app and email links | Enabled (no provider) | Real email delivery | BRF-010 → 8C; release evidence → 9D |
| Planning (7F) | Deterministic rule-based plan from capacity, meetings, estimates, dependencies, and locked work; applied through 7D with a serialized constraint snapshot | Enabled (no provider) | — | — |
| Capture interpretation (7F) | Spans only; server-derived values; explicit save | Disabled | Model interpretation quality | — |
| Voice capture (7F) | Bounded upload, checked bytes, gateway transcription, editable transcript, audio deleted at every outcome | Disabled (no speech provider) | Microphones and recognition quality | TEST-003 → 9B |

## Production-disabled

Production AI, transcription, and workspace-provided keys stay off until DQ-28 (secret store),
OD-41 (provider data use), and OD-46 (commercial terms for workspace keys) are decided. Deployed
configuration refuses the fixture providers. Project AI budgets are not enforced (PRJ-007): paid
project-scoped runs are refused, never relabelled. Commercial entitlements and billing stay with
10A; Phase 7 usage is never billable.

## Manual checks

Device microphones, real speech and model quality, real email delivery, and screen readers are
manual (see [manual-smoke.md](manual-smoke.md)). Deterministic audio proves the path, not
recognition.

## Next owners

- Phase 8A, 8C: agents and automations consume the gateway and the proposal protocol (AUTO-006,
  AGT-024, BRF-010). **REL-FU-7A-01** (an "outcome unknown, never retried" state in the generic
  effect ledger) is a prerequisite before Phase 8 reuses unsafe crash recovery. Passing Phase 7 is
  not Phase 8 readiness.
- Phase 9B, 9D: test cases from voice and proposals (TEST-003, TEST-004) and release evidence
  (DEV-012).
- Phases 10C, 10D, 11B, 11C, 12A: administration, security, reliability, and launch contributions
  recorded in `closure-7.json` `future_boundaries`.
- A later phase: the account-deletion command (the AI eraser is registered); a stable lock order
  for any future multi-person bulk planning writer (ADR-0044, Lock ordering).
- Platform owner: the 0010–0012 rollback of `exec_dispatch.claim_jobs` is not byte-exact (found by
  the stronger boundary comparison; accepted migrations are not edited).

## Accepted operational limits

- Fact-only briefings; no briefing export; conservative evidence supersets; publication refused
  when the complete bounded basis cannot be stored (1,000 rows per basis, 40,000 per briefing).
- Technical AI retention unset (off) by default; it is not a chosen legal period (OD-36).
- Voice: 120 s, 10 MiB, WAV/WebM/Ogg, three open recordings per person, 15-minute uploads.
- Proposals: 25 changes per AI proposal, 99 per plan, approvals valid for 24 hours.

## Integration fixes made in this review

See ADR-0044 I1–I8. In short: person-only surfaces now refuse delegated callers in the service; a
purged capture takes its AI copies with it (migration 0060); departure ends recordings through the
registered hooks; regenerations and later hand-made briefings are never recorded as a baseline;
transcription attempts have their own bound; the proposal review names every operation with its
people and label; one plan-operation list; the boundary walk compares functions and triggers.

## Topology and merge guidance

See [topology.md](topology.md): a linear draft stack #35 → #36 (7A) → #37 (7B) → #38 (7D) → #39
(7C) → #40 (7E) → #41 (7F) → this review. Merge bottom-up after Phase 6, without squashing. Nothing
is merged or closed by this review.
