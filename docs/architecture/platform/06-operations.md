# 6. Asynchronous operation contract

All long, retriable, or approval-gated work is an **operation** resource (schema `operation`, 0B `execution.operation` entity). There are 19 registered kinds ([generated/registries.md](generated/registries.md#operation-kinds)):

- AI actions, agent runs, automation runs, syncs;
- import preview, apply, and rollback; exports;
- bulk edits, undo;
- report runs, briefings;
- brand moves, purge, template installation, test ingestion;
- webhook delivery, proposal application, workspace deletion.

## 6.1 Resource

| Field | Meaning |
|---|---|
| `id` (`op_`), `kind` | Identity and registered kind |
| `state` | The 0B `exec_state`: `queued`, `running`, `waiting`, `paused`, `succeeded`, `partial`, `failed`, `cancelled`, `skipped` |
| `terminal_reason` | **Required** for `failed`, `cancelled`, `skipped`: `error`, `timed_out`, `limit_exceeded`, `policy_rejected`, `user_cancelled`, `emergency_stop`, `superseded`, `deduplicated` |
| `waiting_reason` | **Required** for `waiting`: `approval`, `input`, `rate_limit`, `delay`, `external_confirmation`, `reconciliation_required`, `authorization_changed`, `dependency_unavailable` |
| `result` | **Required** for `partial`: a `partial-result` with per-item outcomes and side effects |
| `cancel_requested_at` | Set by cancel. The operation shows "Cancelling…" until a terminal state (0E ST-63). |
| `progress` | `{phase, completed, total?, unit, estimated}`. **Structured progress only**, from the engine's step records. |
| `attempt_count`, `current_attempt` | Attempts ([07](07-jobs-and-execution-context.md)) |
| `artifacts` | References to produced records (files, deliverable versions, export files), each authorized on read |
| `approval` | Approval reference when gated |
| `usage` | `estimated` (before start), `reserved`, `measured`, `reported` (external agents), each clearly labelled ([14](14-usage-and-entitlements.md)) |
| `rerun_of` | The previous operation, for reruns |
| `initiated_by`, `brand_ids` | Actor and scope (only brands the caller can read are listed) |
| Timestamps | `created_at`, `started_at`, `ended_at`, `updated_at` |
| `links` | `self`, `events` (SSE topic), `cancel`, `pause`, `resume`, `retry`, `rerun`, `commentary`, present only when supported by the kind **and** allowed for the caller |

**Schema-enforced distinctness:** the schema's `if/then` rules make `failed`, `cancelled`, `skipped`, `waiting`, and `partial` impossible to serialize without their reason or result. `succeeded` is the only success value. Clients must treat any other terminal state as not successful (LA-017).

## 6.2 Controls

| Control | Allowed from | Effect |
|---|---|---|
| `:cancel` | queued, running, waiting, paused | Sets `cancel_requested_at`. The handler stops at the next step boundary. Pending external effects are cancelled; `sent`/`unknown` ones are listed. Terminal `cancelled` (`user_cancelled`). |
| `:pause` / `:resume` | Kinds that support it (agent runs) | `paused` ↔ `running`. Resume re-checks authorization, budget, and approvals. |
| `:retry` | failed, partial (retryable steps only) | Adds an attempt to the **same** operation. Only failed or unfinished steps run again. Effects already sent are never repeated (0E ST-64). |
| `:rerun` | Any terminal state, for kinds that support it | A **new** operation with `rerun_of` |
| `:undo` | Operations with recorded change sets | A new `undo` operation ([04 §4.6](04-concurrency.md#46-undo)) |

All controls require an `Idempotency-Key` and are authorized as their own actions (0C `agent.run_control`, …).

## 6.3 Progress versus commentary

AI and agent commentary ("I've updated the tests…") is served **separately** at `links.commentary`, labelled *Run notes — not verified* (0E ST-61). It never changes `state` or `progress`. Only the execution engine sets terminal states, from verified step outcomes. An agent run that finishes has `state: succeeded`. Its task is **not** complete: completion requires human acceptance (0A lifecycle §3).

## 6.4 Polling and live updates

- **Polling:** `GET …/operations/{id}`, honoring `Retry-After` hints.
- **Live:** subscribe to topic `op_…` on the live stream ([10](10-live-updates.md)). Notices carry only `{id, version}`, and clients re-read the operation.
- Listing: `GET …/operations?kind=&state=` returns only operations the caller can read. An operation is readable if the caller initiated it or can read its scope.
