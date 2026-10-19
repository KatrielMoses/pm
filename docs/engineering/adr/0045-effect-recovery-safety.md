# ADR-0045: Safe recovery of external effects (Phase 8 prerequisite)

Status: **proposed** (implemented; candidate for architect review; closes REL-FU-7A-01 with runtime evidence; not Phase 8 feature work).
Date: 2026-10-19. Brief P8-W0. Base: accepted Phase 7 head `3df1b54` (`3df1b541a14d8c0776bfde511190d9457a16e287`, CI run 39223070408). Migrations 0001–0060 unchanged; this adds `0061_effect_recovery_safety`.

## Context

The generic effect ledger (`exec.external_effect`, 0D §5.4) recorded a stable key before an attempt, but `markEffectAttempt` left the row `pending` while the worker performed the call. A worker that died after the external effect happened, and before its outcome was stored, left a `pending` row that the next attempt treated as never sent, and sent again. The same assumption ran through the rest of the path:
- any thrown error was recorded `failed` (treated as retryable, as if proven not sent);
- cancellation cancelled `pending` rows without asking whether they had been dispatched;
- the reaper marked an exhausted operation `failed` with a possibly-sent effect;
- a stale worker's outcome could overwrite a newer state.

ADR-0038 recorded this as REL-FU-7A-01. On `3df1b54` the regression test below shows the receiver applying an unsafe effect twice and the operation reporting `succeeded`.

## Decisions

| # | Topic | Decision |
|---|---|---|
| E1 | One ledger, explicit states | The existing ledger gains `dispatching` (an owned in-flight claim). `pending` means not dispatched in the current cycle. `unknown` (with a reason) is the default after any possible dispatch. `failed` means typed proof of not sent. `cancelled` means stopped before dispatch or abandoned by decision. There is no parallel journal and no provider-specific shortcut. |
| E2 | Durable claim before I/O | `claimEffect` decides and takes a claim (token, attempt, lease) under the row lock and commits it before the caller performs any I/O. Every claim is one counted attempt. A crash at any point after the claim, even just before the request, is `unknown`: without reliable external evidence nobody knows whether the call left. |
| E3 | At most one claimant | A claim is alive while its attempt runs under a current, heartbeat-extended job lease (a sweep's claim, while its own `claim_until` holds). A live claim is never dispatched a second time: another claimant gets `effect_in_flight` and retries later through the job's existing backoff. An abandoned claim (lost attempt, reaped lease, ended attempt) is recorded `unknown` (`abandoned_claim`) before anything else happens. |
| E4 | Typed proof only | An adapter throws `EffectNotSentError` (`refused_before_send`, `rejected_by_receiver`, `precondition_failed`) only when it knows the request never left or was refused without being applied. Timeouts, resets, cancellation after send, a generic exception, a non-2xx status, and a failed outcome transaction are never proof; they are `unknown` (`outcome_unknown` or `unproven_failure`). The database refuses `failed` without a proof code. |
| E5 | Fenced outcomes | `recordEffectOutcome` writes only for the current claim token in `dispatching`. A stale claimant commits late evidence (`late_outcome`, `late_outcome_at`) and stops (`StaleEffectClaimError`); it never overwrites a reconciliation, cancellation, or terminal state, and never causes another send. |
| E6 | Retry classes are registered | Handlers name a registered destination (`defineEffectDestination(id, class, contract)`), never a bare class. A destination cannot be re-registered with another class or contract. The ledger stores a destination fingerprint; reusing a key with another destination, class, or contract fails explicitly (`EffectKeyConflictError`). Safe classes (`idempotent_by_provider`, `naturally_idempotent`, `deduplicated_by_receiver`) retry after `unknown` with the same provider key under their own contract. `unsafe` never retries automatically, and the database refuses claiming an unsafe `unknown` effect directly. |
| E7 | No false success | At the end of an attempt, any claim it still holds becomes `unknown`. An operation with an `unknown` or claimed effect never finishes `succeeded` or plain `failed`: the job dead-letters with `reconciliation_required` and the operation waits. The reaper does the same when attempts are exhausted. |
| E8 | Cancellation reports liability | `cancelOpenEffects` cancels `pending` (undispatched) and `failed` (proven not sent) effects. A live claim is reported `in_flight`, an abandoned one becomes `unknown`, and `sent`, `confirmed`, and `unknown` are reported. The cancelled operation's `outcome_detail.effect_liability` counts them. Nothing that may have left is relabelled. |
| E9 | Authorized reconciliation | `operation.reconcile_effect` is a new 0C action: owners and administrators, R3, step-up, session-only (refused for tokens at the gate and in the service). The decision ("sent", "retry", "abandon") is bound to the reviewed version, audited (`operation.effect_reconciled`, references only), and idempotent; a completed key re-renders through current authority only. "sent" confirms and never resends. "retry" (the person chose to send again) returns the effect to `pending`, and the operation resumes with one fresh job that keeps the completed steps and the original execution context: no authority is gained from the reconciler. "abandon" stops future attempts and ends the operation cancelled with the abandoned count; the effect keeps its attempts, reason, and decision, so possible delivery is never rewritten as known non-delivery. Routes: `GET /v1/workspaces/{ws}/operations/effects`, `POST /v1/workspaces/{ws}/operations/{op}/effects/{key}:reconcile`. |
| E10 | Content stays out | The ledger, jobs, outbox, audit, logs, and metrics hold references and bounded state facts only (keys, classes, states, reasons, counts). Listings show no external reference or payload. |

## State machine (database guard `exec.external_effect_transition_guard`)

| From | To |
|---|---|
| `pending` | `dispatching`, `cancelled` |
| `dispatching` | `sent`, `unknown`, `failed` (proof) — only through the claim (`abandoned_claim` on recovery) |
| `sent` | `confirmed`, `unknown` |
| `unknown` | `dispatching` (safe classes only), `pending` (a retry decision, or a safe class), `confirmed`, `sent`, `failed` (proof), `cancelled` (abandon decision only) |
| `failed` | `dispatching`, `pending`, `cancelled` |

Identity (operation, key, class, provider key, a set fingerprint) is immutable, and attempts never decrease. `dispatching` always holds a claim, and nothing else does.

## Consumer audit

| Consumer | Before | After |
|---|---|---|
| Worker `ctx.effect` (platform) | Attempt left `pending`; any error `failed`; unknown unsafe waited only when the error was typed | Claim, typed proof, fenced outcome, recovery as `unknown`, no false success (E2–E7) |
| Lifecycle purge: object deletions | Recorded `naturally_idempotent` with a bare class | Registered `storage.object_delete` (naturally idempotent); records only |
| Lifecycle purge: purge-ledger append | `ctx.effect(…, 'idempotent_by_provider')` | Registered `lifecycle.purge_ledger` (idempotent by entry id); unchanged behavior |
| Files sweep (performs object deletions) | `failed → pending` without a claim; a storage error recorded `failed` | Claims before deleting (sweep claim lease); a storage error is `unknown` (retried next sweep, safe class); a recovered claim's late result is evidence only; discovery also finds `unknown` and claimed rows |
| Cancellation (worker) | Cancelled every `pending`/`failed` row | E8 |
| Reaper | Exhausted job: operation `failed` | Lost attempts' claims become `unknown`; an uncertain operation waits (E7) |
| AI dispatch and transcription (7A, 7F) | Private ledgers `ai.ai_dispatch`, voice capture | Untouched; they keep their stronger accounting and no-resend rules (all Phase 7 suites pass) |
| Webhooks, calendar sync, notifications | Their own delivery ledgers | Not users of `exec.external_effect`; unchanged |

## Existing rows (migration 0061)

| Row before 0061 | After 0061 | Operator consequence |
|---|---|---|
| `pending`, attempts = 0 | `pending` (unchanged) | Attempted normally |
| `pending`, attempts > 0 | `unknown` (`legacy_attempted`) | Unsafe: waits for reconciliation. Safe class: retried with its key |
| `failed` (any; the old worker recorded every error as failed) | `unknown` (`legacy_attempted`) | Same as above; never treated as proven not sent |
| `sent`, `confirmed`, `cancelled`, `unknown` | Unchanged | — |

Nothing is reset: attempts, keys, and decisions are kept. The rollback restores the exact 0060 catalog, including the enum without `dispatching`. It refuses, with counts, while any row is `dispatching` or carries late evidence, because the old schema would turn a possibly-sent effect into retryable work or drop evidence. `unknown` and `failed` rows stay representable (an unknown unsafe effect still waits under 0060).

## Evidence

| Test | File | What it proves |
|---|---|---|
| AT-550 | `packages/platform/test/integration/effect-crash-after-send.test.ts` | The REL-FU-7A-01 regression through the real worker and reaper |
| AT-539, AT-540, AT-541, AT-542, AT-543, AT-544, AT-545, AT-546, AT-547, AT-548 | `packages/work/test/integration/effect-recovery.test.ts` | Every boundary with barriers and a deterministic receiver (applied counts and attempts); overlap, stale completion, cancellation stages, proof versus generic errors, safe-class contracts, key reuse, authorized reconciliation, no leakage, no false success |
| AT-549 | `apps/api/test/integration/effects-api.test.ts` | The HTTP routes: step-up, replay, envelopes, bearer refusal |
| — | `packages/db/test/integration/migrations.test.ts` | Boundary 0061 (exact rollback and reapply, functions and triggers), legacy-row classification, rollback refusal, enum restoration |
| — | `packages/platform/test/unit/platform.test.ts` | Decisions and destination registration |

**Old-code result.** The same crash-after-send scenario (the receiver applies, the worker process stops before storing the outcome, a survivor recovers) was run against `3df1b54` with the old API:
- On `3df1b54`: applied 2, effect `sent` with 2 attempts, operation `succeeded` (test failed).
- With this change: applied 1, effect `unknown` with 1 attempt, operation `waiting` with `reconciliation_required` (AT-550 passes).

## Follow-ups (from the Phase 7 review)

| Id | Owner | Facts | Next step |
|---|---|---|---|
| REL-FU-7A-01 | platform (execution engine) | **Closed** by E1–E10 with runtime evidence (above). | — |
| REL-FU-P7-01 | platform (database migrations) | Rolling back from 0012 to 0009 restores `exec_dispatch.claim_jobs` with a different function body than the stepped 0009 catalog. Its signature, owner, security, and grants are restored, and behavior is retained, but the body is not byte-exact. Found by the stronger boundary comparison, which runs on functions and triggers from 0052 on. Accepted migrations are not edited. | A future platform migration may make the historical rollback byte-exact, or record the 0009-era body as accepted history. It is not a blocker for this prerequisite. |
| TEST-FU-P7-02 | planning (7F tests) | AT-518 failed once in a fully parallel local run on embedded PostgreSQL: no lock waiter was observed for the in-flight reservation writer within 10 s. It did not recur in four further full runs, three isolated runs, or CI run 39223070408. Diagnostics (commit `3df1b54`) now name the writer's own outcome if it settles before it is seen waiting. The mechanism is unexplained. | If it recurs, use the recorded writer outcome to diagnose and fix the mechanism. It is not claimed resolved. |

## Boundaries kept

- No exactly-once delivery is claimed for unsafe destinations. The guarantee is no automatic duplicate after ambiguity, plus truthful, authorized reconciliation.
- No automation rule, agent, provider integration, AI authority, live or paid effect, or second execution engine is added. Phase 8A/8B/8C requirements are not marked complete.
- Production, legal, and commercial boundaries recorded by Phase 7 are unchanged.

## Identifier reconciliation

| Kind | Identifier | Note |
|---|---|---|
| Migration | 0061 | `0061_effect_recovery_safety` |
| Engineering ADR | 0045 | This record |
| 0C action | `operation.reconcile_effect` | Owner and administrator, R3, step-up |
| Threats | T-139–T-141 | Crash recovery, ledger spoofing, reconciliation authority |
| Tests | AT-539–AT-550 | Above |
| Response types | `external_effects`, `external_effect_reconciliation` | Non-resource envelopes |
