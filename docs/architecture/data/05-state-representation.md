# 5. Lifecycle, review, execution, and status representation

Input: [0A lifecycle-and-states](../../product/lifecycle-and-states.md). Each axis is stored in **its own columns or tables**, so no single column can be misread as another fact.

## 5.1 The axes in storage

| Axis | Stored as | Values | Writers |
|---|---|---|---|
| Lifecycle | `core.record.lifecycle_state` (mirrored on typed rows via the composite foreign key) + `archive_cause`, batch IDs, timestamps | enum `lifecycle_state`: `active`, `archived`, `trashed`, `purged` | `core` lifecycle commands only |
| Workflow status | `status_id` → `workflow.workflow_status` + denormalized `status_category` | Category enum `status_category`: `planned`, `active`, `paused`, `done`, `cancelled` | Owning module's transition command |
| Review | `collab.review_request.state` + immutable `collab.review_decision` | `requested`, `changes_requested`, `accepted` (alias approved), `rejected`, `withdrawn` | Requesters; human reviewers |
| Execution | `execution.operation.execution_state` + `execution.attempt` rows | enum `exec_state`: `queued`, `running`, `waiting`, `paused`, `succeeded`, `partial`, `failed`, `cancelled`, `skipped` + `terminal_reason` (`error`, `timed_out`, `limit_exceeded`, `policy_rejected`, `user_cancelled`, `emergency_stop`, `superseded`, `deduplicated`) | `execution` engine only |
| Verification / acceptance facts | Dedicated append-only tables (§5.3) | — | Authorized humans, or the engine recording external facts |
| Derived conditions | Not stored as truth. Computed per viewer, with optional visibility-keyed caches. | overdue, past deadline, blocked, at risk, stale, unassigned | — |

`status_category` is **immutable per status** (a status's category cannot change). Denormalizing it onto `task`/`project` rows is therefore safe and lets reports filter by category without joins. To change a category, create a new status and migrate records explicitly.

## 5.2 Workflow evolution without rewriting history

- Statuses are rows with stable IDs. They are **retired**, never deleted, while any record or event references them. Renaming changes display only, and audit events store `status_id` plus a name snapshot.
- Transition rules (allowed transitions, required fields, approval rules) live in immutable `workflow.workflow_revision` rows. `workflow.current_revision_id` points to the active revision.
- A transition command evaluates the **current** revision at the moment of transition and records `workflow_revision_id` in the audit event. Past transitions are never re-validated against new rules, and records already in a status are not moved when rules change.
- Removing a status that records still use requires a migration operation (`brand_move`-like mapping) that moves those records explicitly, with audit.

## 5.3 Separate facts, separate rows

| Fact | Where it lives | Can be confused with? |
|---|---|---|
| **Claimed completion** | `audit.audit_event` / activity entry with `action = 'claimed_complete'`, actor type agent/integration/human. Agent "done" commentary lives in `agents.agent_run` notes (not verified). | Never written to status or review |
| **Task completion** | `work.task.status_category = 'done'`, `completed_at` | Gated by the transition command: required fields, approval (review decision exists for current version), agent-assigned tasks require accepted deliverable, tasks with `requires_acceptance` require it |
| **Deliverable accepted** | `collab.review_decision (decision='accepted', reviewer human)` + `files.deliverable_version.accepted_review_decision_id`, `evidence_locked = true` | Independent of task status |
| **Code merged** | `delivery.external_fact (fact='pr_merged', occurred_at, provider_event_id)` | Never sets defect `done`; may set "Fixed – awaiting verification" (category `active`) via automation |
| **Deployed** | `delivery.deployment (environment_id, version_label, deployed_at, source)` | — |
| **Defect verified** | `quality.verification_record (method rerun\|manual, test_result_id, version_label, environment_id, verified_by, verified_at)` | Required by the transition rule before a defect enters `done` when policy says so |
| **Agent run finished** | `execution.operation.execution_state = 'succeeded'` for the run | Never changes task status. The deliverable version it produced starts at `ready_for_review`. |
| **Release go/no-go** | `delivery.release_decision` (append-only, sequenced, `supersedes_id`) | Release status changes only via a decision |
| **Document approved as AI source** | `knowledge.source_approval (document_version_id, approved_by, approved_at)` | Applies to one version only |

## 5.4 Failure is structurally distinct from success

- `exec_state` has distinct terminal values. `succeeded` is the **only** success value, and `partial` is its own state, never a flag on `succeeded`.
- A check constraint ties terminal state and reason together: `CHECK ((execution_state IN ('failed','cancelled','skipped')) = (terminal_reason IS NOT NULL))`. `partial` requires `outcome_detail` listing succeeded and failed steps.
- Aggregate success rates (RPT-013) count `succeeded` / (all terminal states except `skipped`). Retries do not inflate the count: one operation, one outcome ([09 §9.6](09-concurrency-consistency.md#96-idempotency-logical-operations-and-attempts)).
- Projections (activity, briefings, notifications, webhooks) copy the terminal state verbatim. There is no mapping from `partial` or `cancelled` to a success-styled value.
- Test results use their own enum `test_outcome` (`passed`, `failed`, `blocked`, `skipped`, `not_run`, `flaky`) and keep the runner's original value in `original_outcome`. Values that cannot be mapped become `blocked`.

## 5.5 Agent-run display state (derived)

The display states required by AGT-010 are a **view**, not a stored column:

```
display_state =
  CASE
    WHEN op.execution_state IN ('queued','running','waiting','paused') THEN op.execution_state
    WHEN op.execution_state IN ('failed','partial')                     THEN 'failed'
    WHEN op.execution_state = 'cancelled'                               THEN 'cancelled'
    WHEN op.execution_state = 'succeeded' AND rr.state = 'requested'    THEN 'ready_for_review'
    WHEN rr.state = 'changes_requested'                                  THEN 'changes_requested'
    WHEN rd.decision = 'accepted'                                        THEN 'accepted'
    WHEN rd.decision = 'rejected'                                        THEN 'rejected'
  END
```

The run carries three facts with three timestamps: finished (`operation.ended_at`), ready for review (`review_request.created_at`), and accepted (`review_decision.decided_at`).

## 5.6 Other state machines

| Entity | States | Notes |
|---|---|---|
| `tenancy.workspace.state` | `active`, `read_only`, `deletion_pending`, `purging` | Read-only is set by subscription state (cancellation or payment restriction). Commands check it centrally. |
| `billing.subscription.state` | `trialing`, `active`, `past_due`, `restricted`, `cancelled_read_only`, `ended` | Period end times are stored. Durations come from `governance.retention_policy` and plan data, never constants. |
| `delivery.release.state` | draft → preparing → ready_for_decision → go_approved / no_go → deployed → verified / rolled_back; cancelled | `go_approved`/`no_go` only via `release_decision` |
| `integrations.connection.health` | `connected`, `needs_reauthorization`, `error`, `disconnected` | Separate from sync operation outcomes |
| `files.file_object.scan_state` | `pending`, `clean`, `infected`, `error` | Downloads require `clean` |
| `ai.proposed_change` | decision `pending/accepted/edited/rejected`; applied `not_applied/applied/failed` | Application is its own operation. Partial application is listed per change. |
| `core.deletion_batch.state` | `trashed`, `restoring`, `restored`, `purging`, `purged` | Idempotent transitions ([08](08-deletion-retention.md)) |
| `quality.test_run.execution_state` | `exec_state` subset | Counts per outcome stored in `counts`. A run is "passing" only if every required case is `passed` (computed). |
