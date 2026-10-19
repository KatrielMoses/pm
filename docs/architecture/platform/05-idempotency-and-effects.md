# 5. Idempotency, logical operations, and external effects (resolves DQ-12)

## 5.1 Vocabulary

| Term | Meaning | Identity |
|---|---|---|
| Request | One HTTP call | `request_id` |
| Logical operation | One intended outcome. Retries never create a second one. | `op_…` |
| Attempt | One try at a logical operation | `att_…` |
| Retry | A new attempt on the **same** operation (0A lifecycle §8) | Same `op`, new `att` |
| Rerun | A deliberate **new** operation linked by `rerun_of` (test rerun, briefing regeneration) | New `op` |
| External effect | A side effect outside the product (message, publish, charge, provider write, webhook) | `effect_key` |

## 5.2 The `Idempotency-Key` header

| Rule | Contract |
|---|---|
| Syntax | 16–128 characters `[A-Za-z0-9_.:-]`. A UUID or ULID is recommended. |
| Required for | Every `POST` that creates a resource or starts an operation; bulk requests; imports and exports; actions with external effects; billing actions; offline replay. Missing → the `validation_failed` error (`idempotency_key_required`). |
| Optional for | `PATCH`/`PUT`/`DELETE`, which are already conditional, but **required** when replayed from the offline queue |
| Scope | (workspace, authenticated principal, key). Account-level routes use (account, key). |
| Fingerprint | `sha256` over the RFC 8785 canonical form of {method, route template, path parameters, normalized query, body}. Headers excluded except `If-Match`. |
| Same key, same fingerprint, completed | **Replay:** the original status and the resource **references** are returned, re-rendered through the caller's **current** authorization (stored bodies are never replayed verbatim, so revoked access is not bypassed). Header `Idempotent-Replayed: true`. |
| Same key, same fingerprint, in progress | `idempotency_in_progress` error (retryable, `retry_after_seconds`, `operation_id` if one exists) |
| Same key, different fingerprint | `idempotency_key_reuse` error |
| Deterministic failures (4xx validation, authorization, not-found) | Stored and replayed |
| Transient failures (5xx, timeouts before commit) | Not stored. The key is released so a retry executes. |
| Retention | At least `IDEMPOTENCY_RETENTION`, which must cover the offline replay window. After expiry, the same key is a new request. The value is configuration, not a promise. |
| Record | Internal schema `idempotency-record`, 0B `execution.idempotency_key` entity |

## 5.3 Operation identity

- A request that starts long or retriable work creates **one** `operation` in the same transaction as the idempotency record. Repeated requests return the same operation.
- Natural keys deduplicate machine inputs: provider event IDs, (series, occurrence), (automation, trigger event), (import, row number), and (operation, attempt, meter, sequence) for usage (0B §9.6).

## 5.4 External effects: never exactly once

Every external effect is recorded in the effect ledger (0B `execution.external_effect`) with a stable `effect_key` **before** it is attempted.

| Destination class | Retry policy | Example |
|---|---|---|
| `idempotent_by_provider` | The provider accepts our idempotency key, so retries are safe | A payment provider with an idempotency header; providers with request IDs |
| `naturally_idempotent` | Upsert by a stable external ID, so retries are safe | Calendar event upsert by our event ID; issue update with a version precondition |
| `deduplicated_by_receiver` | At least once; receivers deduplicate by event ID | Outbound webhooks (`Webhook-Id`) |
| `unsafe` | **No automatic retry after an unknown outcome** | Email or chat send without idempotency; creating an external issue without a dedupe key |

**Destinations are registered** in code with their class and contract (`defineEffectDestination`). A handler names a destination, never a bare class, so no caller can relabel an unsafe destination as safe. The ledger stores a fingerprint of the destination and contract; reusing an effect key with another destination, class, or contract is refused.

**Ledger states** (P8-W0, platform effect recovery, migration 0061):

| State | Meaning |
|---|---|
| `pending` | Not dispatched in the current cycle (never attempted, or an explicit retry decision) |
| `dispatching` | One claimant owns an in-flight attempt. The claim (token, attempt, lease) is committed under the row lock **before any I/O** |
| `sent` / `confirmed` | The destination acknowledged it (confirmed: also confirmed by the destination or by an authorized decision) |
| `unknown` | It may have left and the outcome is not known. This is the default after any possible dispatch, with a reason: `outcome_unknown`, `unproven_failure`, `abandoned_claim`, or `legacy_attempted` |
| `failed` | **Typed proof** that it was not sent (`refused_before_send`, `rejected_by_receiver`, `precondition_failed`). Timeouts, resets, cancellation after send, a generic error, and a failed outcome write are never proof |
| `cancelled` | Stopped before dispatch, or abandoned by an authorized decision. An abandoned possibly-sent effect keeps its attempts and decision; it is never relabelled "not sent" |

- Outcome writes are **fenced** to the claim token and `dispatching`. A stale claimant records only late evidence (`late_outcome`) and changes nothing else.
- A claim is alive while its attempt runs under a current job lease. A lost attempt (reaper, end of attempt) has its claims recorded `unknown` (`abandoned_claim`). Without reliable external evidence, a crash after the claim, even just before the request, is unknown.
- **Unknown outcome:** safe classes retry with the **same** provider key under their own contract. For `unsafe`, the operation moves to `waiting` with `waiting_reason: reconciliation_required` and is never resent automatically. An operation never reports success while an effect is unknown or claimed.
- **Reconciliation** tries a provider lookup (search by our reference) where available. Otherwise an owner or administrator decides "sent", "retry" (send once more with the same key), or "abandon" (`operation.reconcile_effect`: session only, step-up, the reviewed version, audited, idempotent; a replay re-renders through current authority). A person's decision is recorded as a decision, not as proof from the destination. "sent" and "retry" resume the operation with one fresh job that keeps its original execution context; "abandon" ends it as cancelled with the abandoned count.

The platform guarantees **at least one** delivery attempt per effect and **no automatic duplicate after ambiguity** for unsafe destinations. It **never claims exactly-once external delivery**. Cancellation stops undispatched work and future attempts and reports effects already `sent`, `unknown`, or in flight with their liability (0E ST-63); it never relabels them.

## 5.5 Offline replay

- Offline-queued changes (UXD-25: capture, comments, single-field edits) each carry a client-generated idempotency key, base values, and `client_recorded_at`.
- On reconnect they replay in order. Duplicates are absorbed by the key, and conflicts surface as Conflicted (0E ST-06).
- The server timestamp is authoritative. `client_recorded_at` is stored as metadata only (0B §6.1).
