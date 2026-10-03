# 7. Durable jobs and execution context (resolves DQ-14 and AQ-03)

## 7.1 Execution context (AQ-03)

Every job, operation, internal event, and audit record carries the execution context (internal schema `execution-context`). It is built server-side ([02 §2.2](02-http-api.md#22-request-context-derived-server-side)) and persisted with the job or operation:

| Field | Purpose |
|---|---|
| `workspace_id` | The single tenant context. Workers `SET LOCAL app.workspace_id` from it (0C §12.4). |
| `authenticated_principal`, `effective_principal` | Who authenticated, and whose authority is evaluated (member, guest, `service_principal`, `automation`, `agent_run`, `integration_connection`, `inbound_webhook`, `system_job`) |
| `initiating_membership_id` | The human who started the chain, if any |
| `delegation_chain` | Ordered narrowing steps (member → agent profile → run → tool) with a scope snapshot reference |
| `selected_scope` | Explicit brands, projects, records, and exclusions (AI context, agent assignment, automation declaration) |
| `epochs` | Workspace, principal, and agent-class permission epochs **at enqueue** |
| `risk` | The 0C `action_key`, `risk_class`, `approval_class`, and the approval or step-up IDs that satisfied it |
| `data_class_limit` | The maximum data class this execution may read or emit (for example C2; AI per workspace privacy settings) |
| `correlation_id`, `causation_id`, `traceparent`, `request_id` | Correlation |
| `operation_id`, `attempt_id` | Execution identity |
| `locale`, `timezone` | Rendering for user-visible outputs, rendered as the recipient |

**Live recheck:** before each consequential step (a read batch, write, tool call, external effect, or delivery), the handler compares the current epochs with `epochs`. On change it recomputes the intersection, and access can only shrink (0C §9.1). Approvals, budgets (reservations), and entitlements are rechecked at the same points. A failure moves the operation to `waiting(authorization_changed)` or `failed(policy_rejected)` per kind.

> **Integration note (resolved):** 0B's `execution.operation` and `execution.job` entities now carry typed columns for every field above (Phase 0 integration, PC-01). Only `delegation_chain` and `selected_scope` are JSON, validated against this schema.

## 7.2 Job states and mapping

Internal schema `job`.

| Job state | Meaning | Operation `exec_state` |
|---|---|---|
| `queued` | Waiting for `run_at` and a free fairness slot | `queued` |
| `leased` | Claimed by a worker until `lease_until` | `running` |
| `retry_scheduled` | The attempt failed transiently and the next attempt is scheduled | `running` (or `waiting(rate_limit)` / `waiting(dependency_unavailable)` when that is the reason) |
| `succeeded` | Handler completed | `succeeded` (or `partial` when the handler reports per-item failures) |
| `dead` | Retries exhausted or a deterministic failure | `failed` (`error`/`timed_out`/`limit_exceeded`/`policy_rejected`) |
| `cancelled` | Cancelled before or between steps | `cancelled` |

## 7.3 Leasing, heartbeat, timeout, recovery

- **Claim:** a payload-free dispatcher function returns `(job_id, workspace_id)` across tenants using `FOR UPDATE SKIP LOCKED` and fairness caps. The worker then opens a per-workspace transaction, loads the job under RLS, and sets `lease_until = now() + JOB_LEASE_DURATION` (0C §12.4).
- **Heartbeat:** every `JOB_HEARTBEAT_INTERVAL` (less than a third of the lease), the worker extends `lease_until` and records `heartbeat_at`. A heartbeat failure makes the worker abandon the job at the next step boundary.
- **Timeout:** `JOB_TIMEOUT` per kind. When exceeded, the attempt ends `timed_out`.
- **Worker loss:** when the lease expires without a heartbeat, the job returns to `queued` and a **new attempt** is recorded with `worker_lost: true`. Handlers resume from their last committed step checkpoint.

## 7.4 Retry, backoff, dead letter

| Error class (`last_error.class`) | Retry? |
|---|---|
| `transient` (network, 5xx, rate limit, dependency unavailable) | Yes, until `JOB_MAX_ATTEMPTS` |
| `timeout`, `worker_lost` | Yes, until the cap |
| `deterministic` (validation, unprocessable data) | No → `dead` |
| `authorization` (live recheck failed) | No → operation `waiting(authorization_changed)` or `failed(policy_rejected)` |
| `policy` (limit, entitlement, approval rejected) | No |

- **Backoff:** exponential with **full jitter**: delay = random(0, min(`JOB_BACKOFF_CAP`, `JOB_BACKOFF_BASE` × 2^attempt)). `Retry-After` from providers takes precedence when longer.
- **Dead letter:** `dead` jobs stay visible in health views (ADM-010), raise a `job.dead` metric and an alert, and notify the owner for user-facing kinds (AUTO-016, NTF-005). A manual retry creates a new attempt on the same operation.

## 7.5 Fairness and cancellation

- **Fairness:** per-queue weighted round-robin across workspaces, with `WORKSPACE_CONCURRENCY_CAP` concurrent jobs per workspace per queue (REL-018).
- **Cancellation:** cooperative. Handlers check `cancel_requested_at` at every step boundary, and before every external effect.

## 7.6 Idempotent handlers

- **Inputs:** the job carries a `payload_ref` (operation detail row), not large payloads, plus a `dedupe_key`. The unique active-job index prevents duplicate enqueue.
- **Step checkpoints:** each step writes its result and the next checkpoint in the same transaction as its effects, with an inbox-style receipt `(job_id, step)`. Re-execution after a crash skips completed steps.
- **External effects** go through the effect ledger ([05 §5.4](05-idempotency-and-effects.md#54-external-effects-never-exactly-once)).
- **Delivery semantics:** jobs are **at least once**, and correctness comes from the checkpoints and effect keys, never from assuming single execution.
