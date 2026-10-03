# Execution engine (operations, jobs, outbox, idempotency, effects)

State names are exactly the 0D registry values (generated into `@pm/contracts`).
Delivery is **at least once**; nothing here promises exactly-once delivery.

## Creating work (one transaction)

`startOperation(tx, input, auditSink)` creates, in the caller's workspace transaction:
the `exec.operation` (registered kind, full execution context, optional dedupe key), its
`exec.job`, the initial `execution.operation.state_changed` outbox event, and the audit-ready
metadata hand-off (`AuditSink.record`; 1F supplies the durable writer). All commit or none do.
The job stores `request_id`, `correlation_id`, and the active `traceparent`, so the trace continues
in the worker.

## Job lifecycle

| Step | Transaction / identity | Effect |
|---|---|---|
| Discover + lease | `dispatcher` → `exec_dispatch.claim_jobs` | Serialized per queue; round-robin across workspaces; skips workspaces at `WORKSPACE_CONCURRENCY_CAP`; `FOR UPDATE SKIP LOCKED`; sets `leased`, `lease_token`, `lease_owner`, `lease_until`, `attempts+1`. Returns `(job_id, workspace_id, lease_token)` only |
| Start attempt | `app_worker`, job's workspace | Fence on `lease_token`; cancel observed before start; new `exec.attempt` (`running`); operation → `running` |
| Steps | one workspace transaction per step | `ctx.step(name, fn)` fences the lease, checks cancellation, runs `fn`, records `completed_steps` + `checkpoint`, extends the lease. Completed steps are skipped on re-execution |
| Heartbeat | every `JOB_HEARTBEAT_INTERVAL` | Extends `lease_until`; a lost lease aborts the handler |
| Timeout | `min(JOB_TIMEOUT, job.timeout_seconds)` | Abort with error class `timeout` |
| Success | fenced finalize | job `succeeded`; attempt `succeeded`/`partial`; operation `succeeded`/`partial` (+ outbox fact) |
| Failure | fenced finalize | Retryable classes (`transient`, `timeout`, `worker_lost`) below the cap → `retry_scheduled` with full-jitter backoff `random(0, min(cap, base·2^attempt))` (longer `Retry-After` wins); otherwise `dead` and operation `failed` with `error`/`timed_out`/`policy_rejected`/`limit_exceeded` (or `waiting` when the handler names a waiting reason) |
| Cancel | `cancel_requested_at` on the operation (or job) | Observed before start and at every step/effect boundary → job/attempt/operation `cancelled` (`user_cancelled`); pending effects cancelled, sent/unknown effects reported |
| Worker loss | `discover_expired_leases` + per-workspace recovery | Open attempt closed `failed`, `error_class=worker_lost`, `worker_lost=true`; job back to `queued` (or `dead` at the cap) |
| Shutdown | `SIGTERM` | Stop claiming; wait `WORKER_SHUTDOWN_GRACE_MS`; abort the rest → job `retry_scheduled` immediately, attempt closed `worker_lost` |

A stale worker can never finalize: every write is fenced on `(id, lease_token, state='leased')`.
Unclassified exceptions are `transient` (bounded by the attempt cap). Duplicate enqueues are
absorbed by `(workspace_id, queue, dedupe_key)` while active.

## Outbox and inbox

Events are written with the domain change (`writeOutboxEvent` accepts only registered types and
declared fields; payload ≤ C2). The worker claims undispatched events through
`claim_outbox_events` (dispatch lease), loads each in its workspace, and delivers it to every
subscribed consumer **in a separate transaction per consumer** that first inserts
`exec.inbox_receipt (consumer, event_id)`; an existing receipt makes redelivery a no-op. The event
is marked dispatched only after all consumers succeed; a failing consumer leaves it for redelivery
after the dispatch lease. Maintenance deletes dispatched events after `OUTBOX_REPLAY_WINDOW`,
receipts whose event is gone, expired idempotency keys, and finished jobs — one workspace per transaction.

## Idempotency (0D §5.2)

`requestFingerprint` = SHA-256 of the RFC 8785 canonical form of `{method, route template, path
params, query, body, If-Match}`. `reserveIdempotencyKey` returns `reserved`, `in_progress`
(concurrent duplicates block on the unique key, then see this), `replay` (stored status and
**references**, never bodies), or `key_reuse`. Deterministic 4xx outcomes are stored; transient
failures release the key. Expired keys are new requests. `renderReplay` is the PC-02 hook that
re-renders references through the caller's current authorization.

## External effects (0D §5.4)

`ctx.effect(key, destinationClass, perform)` records the effect with its stable key before any
attempt and passes a stable provider idempotency key. Sent/confirmed effects are never repeated.
Unknown outcome: safe classes retry; `unsafe` moves the operation to
`waiting(reconciliation_required)` and the job ends. `reconcileEffect` records the human decision
(`sent`/`retry`/`abandon`). A database trigger enforces legal transitions and refuses to retry an
unsafe unknown effect without a recorded `retry` decision. 1A performs no real third-party effects.

## Registering work

Product phases add `JobHandler`s and `OutboxConsumer`s in `apps/worker/src/registry.ts`. 1A
registers none (no feature jobs).
