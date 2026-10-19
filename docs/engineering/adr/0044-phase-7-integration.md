# ADR-0044: Phase 7 integration review and engineering exit gate

Status: **proposed** (implemented; awaiting one clean current-head no-skip CI run and the architect's review of the Phase 7 exit gate; production use is not approved).
Date: 2026-10-19. Brief P7-IR1. Base: accepted 7F head `245cf42`, which contains, in dependency order, 7A (`2f2b61e`), 7B (`cdaa184`), 7D (`9542473`), 7C (`730c6e4`), and 7E (`c28a89a`).

## Context

7A–7F were built as a stack and accepted one at a time, each within its recorded boundary. Every Phase 7 surface lives in one service (`AiGatewayService`, the top of the work chain), so a defect at a seam shows up only when the subphases are exercised together: one person across retrieval, actions, proposals, plans, capture, voice, and briefings; every role and delegation; revocation between every step; departure, erasure, retention, and purge through the registered hooks and workers. This review builds those cross-surface proofs, fixes the defects they exposed, and records the aggregate closure. It adds no Phase 8 capability, no live or paid provider, and no new provider authority.

## Accepted subphase engineering scope

The architect accepted each subphase's engineering scope at the head and CI run below (each run's attempt 1 ended with the repository's success marker on every shard). That acceptance is of the engineering scope within its recorded boundaries: it is not production approval and not acceptance of the Phase 7 exit gate, which stays pending this review.

| Subphase | Engineering ADR | Accepted head | CI run | Draft PR |
|---|---|---|---|---|
| 7A | [ADR-0038](0038-ai-gateway-privacy-budgets.md) | `2f2b61e98afee06fcd6b30d23c49495c2e3b2fe1` | 39026967712 | #36 |
| 7B | [ADR-0039](0039-authorized-retrieval-citations.md) | `cdaa184e600f357495ad52d13f694374d07bd208` | 39039501794 | #37 |
| 7D | [ADR-0040](0040-change-proposal-protocol.md) | `954247319ac6cf88a00a9a99780b73c49319bafc` | 39047853519 | #38 |
| 7C | [ADR-0041](0041-ai-drafting-analysis.md) | `730c6e473ba2c86e482af394ccb4c53be6c3a2fd` | 39057392016 | #39 |
| 7E | [ADR-0042](0042-briefings-reviews.md) | `c28a89a859181ac3b8d6b8d55c78892c53b3ecb7` | 39148906597 | #40 |
| 7F | [ADR-0043](0043-planning-capture.md) | `245cf4219bb3e72c19e05ad086ae9412ee89e370` | 39202442831 | #41 |

## Decisions — integration corrections (I)

Each correction is a defect the cross-surface tests exposed on `245cf42` (the "old code" column records the failing test there), fixed at its root with the narrowest change.

| # | Topic | Decision | Old code |
|---|---|---|---|
| I1 | Person-only surfaces are session-only in the service | 7F refused delegated (API-token or OAuth) callers inside the service; 7D proposals, 7E briefings, schedules, and notes, and voice settings relied on the HTTP path rule alone, so a token reached them through the service. Every one of those methods now starts with `#sessionOnly(caller)`. Runs and the action catalog stay under the token's `ai:execute` grant (7A). | AT-524 fails |
| I2 | A purged capture takes its AI copies with it | Purging an Inbox item saved from a recording failed (`voice_capture_inbox_fkey` is `ON DELETE RESTRICT` and the saved state required the link), so the 1F purge executor could never finish it. The Inbox purge adapter now erases the transcription and any interpretation run made from the capture (through `eraseAiContentRows` with named operations; usage, operation, and audit facts stay) and unlinks the recording, which stays `saved` as a reference-only fact. Migration `0060_phase7_integration` relaxes only `voice_capture_saved`; its down migration relabels such recordings `expired` and restores the exact 0059 check. | AT-527, AT-528 fail |
| I3 | Departure ends recordings through the registered hooks | Only `eraseAiContent` (called by tests) cancelled a leaver's open recordings; the departure ownership hook and the personal-data eraser did not, so a real removal left uploaded audio waiting for its upload expiry. One function, `endVoiceCaptures`, is now called by the ownership hook, the personal-data eraser, and the service eraser; the registered cleanup sweep then deletes the audio. | AT-527 fails |
| I4 | Briefing baselines | A regeneration (same window end, published later) became the next briefing's baseline, contrary to ADR-0042 D4. `#comparableBaseline` now excludes regenerations. A scheduled occurrence owed for a cutoff before the latest comparable briefing (one made by hand after it was due) used the previous-day window but still recorded that later briefing as its baseline; a baseline is now recorded only when the window continues from it. | AT-532 fails |
| I5 | Transcription job bound | The transcription job used the AI provider's timeout plus headroom; a valid `TRANSCRIPTION_TIMEOUT_MS` (up to 120 s) could exceed it, ending a possibly charged attempt mid-call. The handler takes its own bound (`transcriptionTimeoutMs`, the transcription transport timeout plus 30 s). | unit test |
| I6 | The review page names every operation | The web change type and labels lacked the 7C operations `task.assign`, `label.add`, and `criterion.add` (an empty heading for every drafted acceptance criterion), and never showed the label or the people an assignment names. Both are shown now, with removed choices labelled unavailable. | component test, AT-534 |
| I7 | One plan-operation list | The gateway re-listed the five planning operations; it now derives them from `PLAN_OPS` in the proposal contract. | — |
| I8 | Boundary evidence | The migration boundary walk now also compares functions (definition, security, owner, execute grants) and triggers at every boundary from 0052 on, and includes 0060. | — |

## Cross-surface evidence

- **Permission and content boundary** (AT-524–AT-526): every principal — owner, administrator, member, limited and read-only members, a share-only member, a guest, and a delegated token — against the canonical read decision for named AI sources, briefings, and person-only surfaces; foreign, other-person, and unknown identifiers refuse identically on every getter and command; revocation and a data-use change between preview, estimate, start, dispatch, approval, Apply, completed-key replay, and display are reauthorized each time, and a completed key renders only the outcome, never content.
- **Lifecycle and privacy** (AT-527, AT-528, AT-533): real departure in a mixed workspace including a call in flight and its late reply; the registered cleanup and retention handlers across AI-only and briefing-only workspaces; restart; purge; account erasure through the personal-data registry; distinctive markers absent from every generic store and log; a failed audio delete retried by the sweep.
- **Concurrency and budgets** (AT-529, AT-530, AT-532): duplicate concurrent Apply, timeout-after-commit, role changes, a plan racing a task edit, shared hard limits with exactly-at-limit, held and unknown liability, and scheduled sweeps under overlap, restart, edits, departure, and a failing email channel.
- **Browser exit journeys** (AT-534–AT-538) on desktop, tablet, and mobile, with keyboard, axe, 320 px, 200% zoom, forced colours with reduced motion, and offline recovery.

## Lock ordering

Plan Apply takes, in order: the person's plan-constraint lock (`planning.lock_plan_constraints`), `capacity.profile:<member>`, the day, the person's blocks, `capacity.holidays:<brand>` for each brand in scope, the workspace dependency lock (shared), and the candidate tasks `FOR SHARE`. Every current canonical writer of calendar mirrors, reservations, profile, time off, blocks, and Today takes at most one person's constraint lock first, and the 0059 triggers make any other writer take it. The orders exercised by AT-515–AT-520, AT-529, and AT-536 complete without deadlock. There is no global lock-order proof: a future bulk writer that changes several people's constraints in one transaction (for example a brand-wide calendar or holiday import) must take those locks in a stable order (by membership id) or it can deadlock with plan Apply or with another such writer. That risk is recorded for the phase that adds such a writer.

## Boundaries kept

- **DQ-28, OD-41, OD-46:** no secret store, no reviewed provider terms, workspace keys off when deployed; production AI and transcription stay disabled and only the labelled fixture transports exist. Real-model input and cost bounds stay unverified.
- **OD-31:** retrieval stays lexical. **DOC-019:** attachment text is not a source.
- **OD-25, OD-16, OD-36:** briefing notes stay personal; a verified update is one with a verification fact; technical AI retention stays unset (off), not a chosen legal period.
- **PRJ-007:** project AI budgets are not enforced; paid project-scoped runs are refused, never relabelled.
- **10A:** commercial entitlements and billing; usage is never billable.
- **BRF-010 → 8C, release evidence → 9D:** agent-run review stays an explicit foundation; release readiness never certifies or publishes.
- **Fact-only briefings, no briefing export, conservative evidence supersets, size refusal:** kept as accepted limits.
- **REL-FU-7A-01:** the generic effect ledger still treats a pending effect as retryable after a crash. No Phase 7 path relies on it. It is a prerequisite before Phase 8 reuses unsafe crash recovery; this review does not implement a new execution engine.
- **Account deletion:** the command belongs to a later phase (identity.md). The AI personal-data eraser is registered and proven through `productPersonalDataRegistry`; nothing claims account deletion ships.

## Findings outside Phase 7 authority

- The 0010–0012 rollback does not restore `exec_dispatch.claim_jobs` byte for byte (the stronger boundary comparison found it). Accepted migrations are not edited; the comparison of functions and triggers starts at 0052 and the finding is reported for the platform owner.
- API readiness reports the AI provider but not transcription; transcription availability is reported truthfully per person by voice settings (`not_configured`, `ai_unavailable`, `storage_unavailable`).

## Identifier reconciliation

| Kind | Identifier | Owner | Note |
|---|---|---|---|
| Migration | 0053–0059 | 7A (0053, 0054), 7B, 7D, 7C, 7E, 7F | Unchanged |
| Migration | 0060 | Phase 7 review | `0060_phase7_integration` |
| Engineering ADR | 0038–0043 | 7A, 7B, 7D, 7C, 7E, 7F | Acceptance recorded in each status line |
| Engineering ADR | 0044 | Phase 7 review | This record |
| Threats | T-136–T-138 | Phase 7 review | Delegated reach, capture content lifecycle, briefing baselines |
| Tests | AT-524–AT-533 | Phase 7 review (matrix) | `packages/work/test/integration/phase7-matrix.test.ts` |
| Tests | AT-534–AT-538 | Phase 7 review (browser) | `e2e/phase7-exit-journey.spec.ts` |

No 0B, 0C, or 0D decision anchor is added; the corrections stay inside ADR-50 (0B), AZ-44–AZ-50 (0C), and PL-46–PL-52 (0D) as recorded by the subphases.

## Acceptance tests

| Test | Test file | Test title |
|---|---|---|
| AT-524 | packages/work/test/integration/phase7-matrix.test.ts | AT-524 every principal sees exactly the records the canonical read decision allows, on every Phase 7 surface |
| AT-525 | packages/work/test/integration/phase7-matrix.test.ts | AT-525 another workspace’s, another person’s, and unknown identifiers fail identically on every Phase 7 surface |
| AT-526 | packages/work/test/integration/phase7-matrix.test.ts | AT-526 revocation between preview, confirmation, dispatch, approval, Apply, completed-key replay, and display is reauthorized every time; nothing hidden survives through another surface |
| AT-527 | packages/work/test/integration/phase7-matrix.test.ts | AT-527 departure, the registered workers, restart, purge, and retention converge across AI, briefing, plan, voice, and mixed workspaces |
| AT-528 | packages/work/test/integration/phase7-matrix.test.ts | AT-528 protected content stays in its boundary: no generic store or log holds it, a failed audio delete is retried, and purging a capture erases its AI copies |
| AT-529 | packages/work/test/integration/phase7-matrix.test.ts | AT-529 duplicate Apply, timeout-after-commit, role and grant changes, and a plan racing a task edit change business state exactly once, with matching operation, audit, and outbox facts |
| AT-530 | packages/work/test/integration/phase7-matrix.test.ts | AT-530 assist, interpretation, and transcription share one authoritative budget: exactly-at-limit fits once, held and unknown liability blocks the next feature, nothing is clamped or resent |
| AT-531 | packages/work/test/integration/phase7-matrix.test.ts | AT-531 with AI, speech, storage, or email unavailable every surface says so truthfully and the manual core (capture, triage, task edits, Today plans, briefings) still works |
| AT-532 | packages/work/test/integration/phase7-matrix.test.ts | AT-532 the registered briefing sweep across workspaces publishes each due occurrence once, as its recipient, through overlap, restart, edits, departure, and a failing email channel; a regeneration never advances the baseline |
| AT-533 | packages/work/test/integration/phase7-matrix.test.ts | AT-533 migration 0060: a saved recording outlives its purged item under forced RLS; the rollback relabels it and restores the exact 0059 check; re-apply is clean |
| AT-534 | e2e/phase7-exit-journey.spec.ts | AT-534 Phase 7 exit journey: an authorized brief becomes a reviewed, partly selected plan applied once with AI-draft provenance; stale confirmation is refused; a narrower member and other workspaces see none of it |
| AT-535 | e2e/phase7-exit-journey.spec.ts | AT-535 Phase 7 exit journey: typed and spoken capture are interpreted or transcribed, edited, saved explicitly, and triaged with their provenance; bad audio never completes and no audio is kept |
| AT-536 | e2e/phase7-exit-journey.spec.ts | AT-536 Phase 7 exit journey: a realistic Today plan with capacity, a meeting, estimates, a dependency, and locked work; a meeting synced after approval is refused atomically, rebased explicitly, and applied exactly once |
| AT-537 | e2e/phase7-exit-journey.spec.ts | AT-537 Phase 7 exit journey: fact-only cross-brand and narrower briefings with evidence, claimed versus accepted work, an approved personal note reused until its evidence changes, a regeneration, and a scheduled in-app occurrence |
| AT-538 | e2e/phase7-exit-journey.spec.ts | AT-538 Phase 7 exit journey: with AI off, every AI, speech, and assist surface says so truthfully, and manual capture, triage, task editing, Today planning, and briefings keep working |

## Consequences

- One permission and content boundary holds across every Phase 7 surface, in the service as well as at HTTP.
- Purge, departure, account erasure, and retention converge for AI, briefing, plan, and voice content through registered paths only.
- The Phase 7 exit gate is a candidate: `closure-7.json` and `phase7.py` aggregate the six closures for architect review. Nothing here is production-ready or live-provider-tested.
