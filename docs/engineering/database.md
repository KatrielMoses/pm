# Database: roles, RLS, tenant transactions, migrations

PostgreSQL 18 (0B §10 requires ≥ 15; role-membership options used here require ≥ 16). No
extensions are needed in 1A: UUIDv7 keys are application-generated, and `gen_random_uuid()` and
`sha256()` are built in.

## Schemas

| Schema | Owner module | Contents |
|---|---|---|
| `exec` | execution (0B model `schema: exec`) | operation, attempt, job, outbox_event, inbox_receipt, idempotency_key, external_effect; enums; `current_workspace_id()` |
| `exec_dispatch` | execution | Payload-free `SECURITY DEFINER` scheduling functions |
| `tenancy` | tenancy | `workspace` anchor (extended in place, 0017), `membership` (0017; guarded transitions 0019), `brand`, `brand_setting`, `scope_preference` (0018), `team`, `team_member`, `invitation`, `ownership_transfer` (0019); directory definer functions owned by `pm_directory`. See [tenancy.md](tenancy.md) |
| `access` | access | `role`, `role_assignment`, `permission_epoch` (0017); `workspace_policy`, `share_group`, `record_grant`, team principals and the role-shape check (0019) |
| `views` | views | `favorite`, `recent_item`, `view_state`, `view_pin` (0020); personal rows (workspace + owner membership), RLS-forced, cleaned by the `views.cleanup` job |
| `identity` (1E) | identity | `account_preference` (0020): typed per-account preferences |
| `search` (5A) | search | `search_document`, `index_status`, `recent_search` (0041): a rebuildable search projection, its key queue, and personal recent searches; see the Phase 5A section |
| `metrics` (5C) | metrics | `task_status_span`, `reconcile_state` (0043): the append-only task status history and the reconciliation job's state; see the Phase 5C section |
| `ops` | operational | `schema_migration`, `environment_binding`, `worker_heartbeat`, `rate_limit_bucket`, `dev_secret_vault`, `recovery_gate` (no tenant data) |
| `audit` | audit (1F) | audit_event, audit_redaction, security_event, chain_checkpoint, activity_item, buffer_verification (0013, 0015); `redact_purged_values` (0014). Append-only by grants **and** triggers; see [audit.md](audit.md) |
| `core` | core (1F) | record_type, record, archive_batch(+member), deletion_batch(+member) (0014); residual-batch lineage and membership invariants (0016); see [lifecycle.md](lifecycle.md) |
| `governance` | governance (1F) | retention_policy (0015): nullable values only |
| `identity` | identity (1B) | account, credential, mfa_factor, recovery_code, session, oauth_identity, verification_token, step_up_challenge, mail_delivery, security_event_buffer (0011); stored `locked` step-up state (0012). Platform scope, no tenant RLS; see [identity.md](identity.md) |

## Roles (0C §12.3)

Created by `packages/db/bootstrap/roles.sql` (provider admin, once per cluster), never by migrations.

| Role | Login | RLS | Purpose |
|---|---|---|---|
| `pm_owner` | no | subject (tables use `FORCE`) | Owns all schemas and objects |
| `migrator` | yes | subject | DDL via `SET ROLE pm_owner` (membership `INHERIT FALSE, SET TRUE`) |
| `restore_operator` | yes | subject | Break-glass restore / purge-ledger replay via `SET ROLE pm_owner` |
| `app_rw` | yes | **subject** | web/API. Column-scoped grants; owns nothing |
| `app_worker` | yes | **subject** | worker tenant work |
| `dispatcher` | yes | subject | `EXECUTE` on `exec_dispatch.*` only; cannot select any tenant table |
| `pm_scheduler` | no | subject + discovery policies | Owns the definer functions; column grants exclude payload, context, keys |
| `pm_directory` | no | subject + `directory_lookup` select policies | Owns only the 1C account→workspace directory functions (`SECURITY DEFINER`, platform scope, own account only). Only `pm_owner` is a member (SET only) |
| `audit_maintainer` | no | subject | Owns only `audit.redact_purged_values` (1F); the sole identity the audit triggers let change value fields, and only under a transaction-local redaction operation. Only `pm_owner` is a member (SET only); no login role can become it |

No role has `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB`, or `REPLICATION` (catalog test).
`app_ro` and `platform_support` arrive with the phases that need them. **Existing clusters must
re-run the role bootstrap before migration 0013** (it creates `audit_maintainer`) **and again before
migration 0017** (it creates `pm_directory`) **and before 0019** (explicit `TEMPORARY` for `app_rw`/`app_worker`, used by oversized visibility contexts). Migration 0020 needs no new bootstrap step (it grants `pm_scheduler` usage on `tenancy` and `views` itself).

**Managed providers.** If the provider reserves role creation for its admin user, run
`bootstrap` (`node /app/entrypoint.mjs bootstrap`) or `roles.sql` as that admin. The logical model
does not change. If a provider cannot grant role membership with `SET TRUE, INHERIT FALSE`, stop
and escalate rather than weakening it.

## RLS and tenant transactions

- Every table with `workspace_id` (and `tenancy.workspace` by `id`) has RLS **enabled and forced**
  with `tenant_isolation`: `USING/WITH CHECK (workspace_id = exec.current_workspace_id())`.
- `exec.current_workspace_id()` = `NULLIF(current_setting('app.workspace_id', true), '')::uuid`.
  Unset or cleared context is `NULL`, so every predicate is false (fail closed: zero rows, writes rejected).
- `TenantDatabase.withWorkspace(id, {module}, fn)` is the only SQL path for `app_rw`/`app_worker`:
  validates the UUIDv7, opens a transaction, `set_config('app.workspace_id', $1, true)`
  (transaction-local), asserts the setting and that the workspace exists, then runs `fn`. Session-level
  `SET`/`set_config(…, false)` are rejected by lint and by the SQL safety check.
- `PlatformDiscovery` (dispatcher) is the separate, explicitly named cross-tenant path. Its functions
  return only IDs, queue names, lease tokens, timestamps, and counts.
- `PlatformHealth` reads only `ops` metadata and catalog policy state (`tenantIsolationIntact`)
  outside tenant context; never tenant rows.
- **Workspace existence is database-enforced** (migration 0009): every `exec` tenant table has
  `<table>_workspace_fkey (workspace_id) REFERENCES tenancy.workspace(id) ON DELETE RESTRICT`.
  Foreign-key checks bypass RLS, so the constraint holds for every identity, including owners and
  superusers. Composite `(workspace_id, id)` keys additionally keep attempts, jobs, outbox events,
  idempotency keys, effects, and reruns in their operation's workspace. Every foreign key has a
  full (non-partial) index leading with its referencing columns (catalog test).

## Workspace purge order

`RESTRICT` means a workspace cannot be deleted while any execution history remains (error
`23001`). The audited workspace purge (implemented with deletion in 1F/later phases, under a
dedicated purge identity) deletes in this order, in the workspace's context:

1. `exec.inbox_receipt` 2. `exec.external_effect` 3. `exec.idempotency_key` 4. `exec.outbox_event`
5. `exec.attempt` 6. `exec.job` 7. `exec.operation` 8. `tenancy.workspace`

1F tables (`core.*`, `governance.retention_policy`, `audit.*`) join this order ahead of `exec.*`.
Audit rows are append-only for every role, so workspace deletion (SEC-021) must first add its own
guarded, audited `audit_maintainer` deletion path (ADR-0009 G7); none exists yet.

Phase 6D transfer rows are deleted before the workspace: `transfer.import_row`, then
`transfer.import_job`, `transfer.import_preview`, and `transfer.import_mapping`. A membership
departure cascades its mapping, previews, import jobs, and source-row provenance so stored source
values and source actor identifiers do not outlive the owner. Workspace scope remains `RESTRICT`.

Attempts are append-only; their guard permits `DELETE` only when the transaction-local marker
`app.purge_workspace_id` equals the attempt's workspace. No application role holds `DELETE` on
`exec.attempt`, so the marker alone grants nothing. Later modules insert their tables before
`exec.*` in this order (dependents first).

## Migrations

- One ordered stream: `packages/db/migrations/NNNN_name.up.sql` + `.down.sql` (both required).
- Header `-- migrate:phase expand|contract`; optional `-- migrate:no-transaction`.
- Tamper evidence: `ops.schema_migration` stores the SHA-256 of each up and down file and a hash
  chain (`chain_hash = sha256(prev | version | name | checksum | down_checksum)`). `migrate verify`
  and every `migrate up` recompute it; any edited file, edited row, gap, or reorder stops the run.
- Only the `migrator` login may run migrations (checked); a session advisory lock serializes
  concurrent migrators; each migration runs in its own transaction with lock/statement timeouts.
- **Expand/contract.** `migrate up` applies expand migrations and stops at the first contract
  migration; `migrate up --contract` applies it once every running instance uses the new code.
  Readiness accepts a database that is *ahead* of the artifact (rolling deploys) but not behind.
  `scripts/check-sql-safety.mjs` rejects destructive statements in expand migrations.
- `migrate down --to N` exists for local and test only. Deployed environments roll forward.
- The first `migrate up` binds the database to `APP_ENV` (`ops.environment_binding`); later runs
  under another environment are refused.

| # | Migration | Creates |
|---|---|---|
| 0001 | foundation_schemas | `exec`, `tenancy`, `access`, `exec_dispatch`; enums; `exec.principal_type` domain; context and UUIDv7 functions |
| 0002 | ops_runtime | grants on `ops.schema_migration`; `ops.environment_binding`; `ops.worker_heartbeat` |
| 0003 | tenancy_workspace | `tenancy.workspace` + RLS |
| 0004 | exec_operation_attempt | `exec.operation`, `exec.attempt` (append-only guard) + RLS |
| 0005 | exec_job | `exec.job` + RLS + scheduler policies and column grants |
| 0006 | exec_outbox_inbox | `exec.outbox_event`, `exec.inbox_receipt` + RLS |
| 0007 | exec_idempotency_effects | `exec.idempotency_key`, `exec.external_effect` (transition guard) + RLS |
| 0008 | exec_dispatch_functions | `claim_jobs`, `discover_expired_leases`, `job_queue_stats`, `claim_outbox_events`, `outbox_backlog`, `discover_maintenance_workspaces` |
| 0009 | exec_workspace_foreign_keys | Workspace FKs (`RESTRICT`, added `NOT VALID` then validated) on all seven tenant `exec` tables; FK-supporting indexes; purge-aware attempt guard |

## Writing a new migration

1. Add `NNNN_name.up.sql` and `.down.sql`; never edit an applied file.
2. Tenant table: `workspace_id` with a `RESTRICT` foreign key to `tenancy.workspace(id)`, composite keys as needed, `ENABLE` + `FORCE` RLS, `tenant_isolation`
   policy, explicit column-scoped grants. Indexes lead with `workspace_id`.
3. Update `packages/db/src/schema.ts` (`Database` types and `TABLE_COLUMNS`; the drift test fails otherwise).
4. `pnpm lint` (SQL safety) and `pnpm test:integration` (catalog RLS checks, reversibility).

## Platform scope (migration 0010)

Some execution rows belong to no workspace: identity mail delivery, identity cleanup, and
account-level idempotency keys. `PlatformDatabase.withPlatform()` opens a transaction with
`app.platform_scope='platform'` and **no** workspace context, and `exec.in_platform_scope()`
gates RLS policies that admit only rows with `workspace_id IS NULL`. `exec.job.workspace_id` and
`exec.idempotency_key.workspace_id` are nullable; operations, attempts, effects, and outbox events
stay tenant-only (`CHECK (workspace_id IS NOT NULL OR operation_id IS NULL)`). The tenant and
platform scopes are mutually exclusive: a platform transaction cannot see tenant rows, and a tenant
transaction cannot see platform rows.

## Phase 2A: work, relations, templates, planning

Migrations `0021_work_projects` and `0022_project_relations_templates_recurrence` (ADR-0013). Down
migrations restore the exact 0020 catalog (boundary test `[…, 20, 21, 22]`).

| Schema | Objects |
|---|---|
| `workflow` | `platform_status`: five immutable rows with fixed ids (`planned`, `active`, `on_hold`→paused, `completed`→done, `cancelled`), read-only for application roles |
| `work` | `project` (`core.record` extension: brand, parent, `ancestor_ids`, `depth` ≤ 32, `description_rich` (rich text version 1, `tenancy.valid_rich_text`), status and denormalized `status_category`, priority, dates, `completed_at` tied to the done category, manual health, owner, budgets, `COLLATE "C"` rank, `access_mode`, `allow_record_shares`, intake provenance, recurrence identity, version); `phase`, `milestone`, `decision_record` (`core.record` extensions); `criteria_item`, `scope_item`, `project_update`, `project_update_verification` (public ids, no envelope) |
| `relations` | `record_relationship` (`blocks`, `related`; both endpoints and both brands carried with composite FKs) |
| `templates` | `template`, `template_version` (immutable package, `item_count` 1–500) |
| `planning` | `recurrence_series` (immutable `template_payload`, version + 1 on every change except the operational `last_run_at` fairness stamp; partial index `recurrence_series_fair` for oldest-waiting discovery) |
| `access` | `role_assignment.project_scope_id` (generated from project-scoped rows; FK to `work.project`); `grant_source` adds `project_manager` |

Invariants enforced in the database:

- **Ancestry.** A deferred trigger checks each project against its parent at commit, so a subtree rewrite can run as one statement.
- **Status category.** A trigger keeps `status_category` equal to the status row's category.
- **Decision states.** The state must fit the kind; outcomes are required for decided and resolved; supersession is shaped.
- **Last manager.** Deferred guards on project, assignment, and membership refuse a commit that leaves an active project without a manager.
- **Append-only updates.** `project_update` and its verification have no `UPDATE` grant for any role. Only the worker's purge hook may `DELETE` them.
- **Immutable snapshots.** `recurrence_series.template_payload` is immutable; `(workspace, series, occurrence_key)` is unique on `work.project`.

Definer functions (owner `pm_owner`, `search_path` pinned, `EXECUTE` revoked from `PUBLIC`):

| Function | Caller | Purpose |
|---|---|---|
| `work.project_has_manager(workspace, project)` | app_rw, app_worker (via guards) | Eligible-manager check |
| `work.grant_occurrence_manager(…)` | app_worker | The explicit manage grant for a generated occurrence (the worker has no assignment `INSERT`) |
| `work.remove_purged_project_access(…)` | app_worker | Removes project-scoped assignments of a trashed or purged project during purge |
| `exec_dispatch.discover_recurrence_due(now, limit)` | dispatcher | Workspace ids with due active series, oldest-waiting first (`min(last_run_at)`); `limit` is `RECURRENCE_WORKSPACE_DISCOVERY_MAX` |

**RLS and indexes.** Array operators (`@>`, `&&`, `= ANY(array_column)`) are not leakproof, so under RLS they cannot be index conditions. Hierarchy queries therefore walk `parent_project_id` (`project_children`) recursively instead of filtering `ancestor_ids`; no GIN index is kept. Query-plan tests (`packages/work/test/integration/contracts.test.ts`) seed 5,000 projects with structures, dependencies, and assignments, and check the list, children, subtree walk, scope seeds, structure, relationship, project-assignment, occurrence, and due-work indexes.

## Phase 2B: tasks and relationships

Migrations `0023_work_tasks` and `0024_task_relationships_sharing` (ADR-0014). Down migrations restore
the exact 0022 catalog (boundary test `[…, 22, 23, 24]`); 0024's down restores the 0016 `core.record_guard`.

| Schema | Objects |
|---|---|
| `workflow` | Six `platform_status` rows for `task` (Backlog, To do, In progress, Blocked, Done, Cancelled) with fixed ids |
| `work` | `task` (`core.record` extension: brand, optional project, parent, `depth` ≤ 64, `description_rich`, status and `status_category` (trigger `task_status_category`), priority, `start_date`, `due_date`, deadline as `deadline_date` or `deadline_at` + `deadline_tz`, estimates, expected deliverable, completion and override, `COLLATE "C"` rank, version; deferred `task_ancestry` checks brand and project identity with the parent); `task_assignee` (unique `task_assignee_one_primary`, eligibility trigger); `checklist_item` (`chk_`); `criteria_item.task_id` and `required` (project or task arc); `task_inherited_criterion` (per-task state for an inherited project item); `label` (`lbl_`, brand-scoped) and `task_label` |
| `relations` | `record_link` (`lnk_`; `https` URL or record target, checked in the database) |
| Functions | `work.move_task_brand(uuid[], uuid)` (security definer; the only brand change for task records, allowed by `core.record_guard` for its owner); deferred `assert_departing_assignee` |

Child foreign keys of `work.task` use `ON UPDATE CASCADE` so the brand move is one statement.
Hierarchy walks recurse on `parent_task_id` (indexes `task_children`, `task_by_project`,
`task_projectless`); no array predicates. `packages/work/test/integration/task-plans.test.ts`
checks plans at 5,000 and 50,000 tasks for lists, children, assignees, labels, items,
relationships, and history, for restricted and grant-heavy principals.

| Suite | Proves |
|---|---|
| `packages/work/test/integration/tasks.test.ts` | Scope, depth, fields, completion gates and overrides, checklists, labels, links, relationships, moves (including concurrent reparents), cross-brand move, lifecycle, duplicate, assignees and departure, history, project rollups |
| `packages/work/test/integration/task-access.test.ts` | Three workspaces, all six roles, projectless and project tasks, surfaces agreeing with single-record checks, share boundary, hidden endpoints, forged identifiers |
| `packages/work/test/integration/task-plans.test.ts` | `app_rw` and `app_worker` isolation; query plans at volume |
| `apps/api/test/integration/tasks-api.test.ts` | HTTP flows with ETags, verbs and item routes, uniform `not_found`, no internal UUIDs |
| `apps/web/test/tasks.test.tsx`, `e2e/tasks.spec.ts` | Task routes; tree keyboard and Move/Indent/Outdent; task page flows, conflict, offline, axe, forced colors, 320 px on desktop, tablet, and mobile |

## Phase 2C: workflows and custom fields

Migrations `0025_workflow_configuration` and `0026_custom_fields` (ADR-0015). Down migrations restore
the exact 0024 catalog (boundary test `[…, 24, 25, 26]`): 0025's down restores the 2A/2B status
triggers and platform-status foreign keys; 0026's down restores the 0024 `work.move_task_brand`.

| Schema | Objects |
|---|---|
| `workflow` | `workflow` (`wf_`, scope and record kind, one active per scope and kind); `workflow_status` (`sts_`, fixed category, guarded); `transition` (`trn_`, one active edge per pair) with `transition_requirement` and `transition_approver`; append-only `approval_request` (`wap_`, one-time close) and `approval_decision`; `field_definition` (`fld_`, immutable type, lineage, formula AST); `field_option` (`fop_`); `formula_dependency` (deferred acyclic check); `field_value` (typed JSON plus normalized columns derived by `field_value_shape`); `field_set` (`fst_`), immutable `field_set_version`, `field_set_attachment` |
| `access` | `field_policy` (read rule, minimum levels, guest visibility) per custom definition |
| Functions | `workflow.resolve_workflow`, `workflow.status_category`, `workflow.status_offered` (used by the task and project status triggers); guards `workflow_status_guard`, `approval_request_guard`, `field_definition_guard`, `field_value_shape`, `assert_formula_acyclic` |

`work.task.status_id`, `prior_status_id`, and `work.project.status_id` no longer have a foreign key to
`workflow.platform_status`. The status triggers resolve either catalog and refuse a new choice the
applicable workflow does not offer; `workflow_status_guard` refuses deleting a status in use. The
SQL safety gate now covers the `workflow` schema.

Lock order (ADR-0015 W24): record row → applicable workflow row `FOR SHARE` for status changes; workflow row `FOR UPDATE` → status and transition rows for workflow configuration; the workspace field-graph advisory lock → definition row for field configuration; record row → approval request row for approvals.

| Suite | Proves |
|---|---|
| `packages/work/test/unit/workflow-engine.test.ts` | Formula language, typed errors, AST validation; linear-time patterns; field values (currency, percentage, URL, email); lossless serialization |
| `packages/work/test/integration/workflows.test.ts` | Resolution and precedence, fixed categories, archive and migration, transitions that edits cannot bypass, atomic required fields, approvals (stale, rejected, applied once, self-approval), TSK-031 |
| `packages/work/test/integration/fields.test.ts` | Every type, references without access, options with replacement, formula chains, cycles, depth, field policy, field sets, cross-brand move and purge, the canonical document |
| `packages/work/test/integration/workflow-plans.test.ts` | Pooled `app_rw` and `app_worker` isolation for all 15 tables; append-only approvals; query plans at 5,000 records × 10 fields |
| `packages/work/test/integration/workflow-concurrency.test.ts` | Review 01: two managers on the same or overlapping configuration through a pooled `app_rw` barrier (workflow edit vs reorder, transitions and requirements, a configuration change during preview/apply, definitions, values, set versions, formula cycles, approvals); one success plus a typed conflict or serialized commits; invariants, audit, outbox, permission epochs |
| `packages/work/test/integration/field-timing.test.ts` | Review 01: equal statement shapes and one timing class (`@pm/test-support` timing harness) for hidden vs visible fields, unreadable vs unknown records, formula explanations, required-field errors, history, export, and set-preview counts |
| `apps/api/test/integration/workflows-api.test.ts` | HTTP configuration, preview and apply, values with ETags, collection verbs, uniform `not_found`, no internal UUIDs |
| `apps/web/test/workflow.test.tsx`, `e2e/workflows.spec.ts` | Routes; More fields; transition dialog; configuration, approvals, and fields on desktop, tablet, and mobile with axe, forced colors, and 320 px |

## Phase 2D: task interaction quality

Migrations `0027_task_interaction` and `0028_task_bulk_undo` (ADR-0016, 0B ADR-24):
- `work.task` gains `origin_kind`/`origin_ref` (immutable: trigger plus grants), `recurrence_series_id`/`occurrence_key` (unique together), and `last_meaningful_update_at` (triggers on the task and its content tables through the definer `work.touch_task`). Indexes: `task_duplicate_probe` (normalized title), `task_by_freshness`, and `task_rank_by_brand`.
- `planning.recurrence_series` accepts `target_kind = task` and an optional `project_id`; `templates.template` accepts `task`.
- `planning.task_reminder` (guarded forward-only states; `task_reminder_due` for discovery through `exec_dispatch.discover_reminders_due`) and `planning.task_snooze`: personal, RLS, removed on task purge and member departure.
- `work.bulk_operation` and `work.undo_entry`: actor-owned, one-way closes (`work.bulk_undo_guard`), expired rows deleted by their owner.

## Phase 2E: capture

Migrations `0029_capture_inbox` and `0030_intake_forms` (ADR-0017, 0B ADR-25) create the `capture` schema:
- `inbox_item`: personal (owner-filtered in the service, RLS by workspace), with a guard trigger that keeps the original text, source, correlation, owner, and brand immutable and makes triage forward-only with restore. `inbox_item_by_owner` serves the daily Inbox.
- `note`: personal, with its source item.
- `capture_conversion`: append-only lineage.
- `intake_form`: brand-scoped, with a queue owner.
- `intake_submission`: append-only receipts.
The worker may detach `work.project.intake_source_id` and `capture.note.source_inbox_item_id` during purge.

## Phase 3A: saved views

Migration `0031_saved_views` (ADR-0018, 0B ADR-26):
- **`views.saved_view`:** a workspace-level record extension. `saved_view_share_shape` allows exactly one share scope or none. The query (32 KiB) and presentation (8 KiB) have hard ceilings, and the configured `QUERY_*` bounds are lower.
- **`views.view_default`:** one row per target kind, target, and entity, with a target-shape check.
- **`views.view_pin`:** gains `INSERT`, `DELETE`, and `UPDATE (rank)` for `app_rw`. `view_pin_shared_guard` refuses a pin unless the view is shared with the pin's own scope.

Every foreign key has a full index on its referencing columns. The worker may delete views, defaults, and pins during purge.
## Phase 3D: time tracking

Migration `0032_time_tracking` (ADR-0019, 0B ADR-27) creates the `timetrack` schema:
- `time_entry` (`te_`): one task or one project in its brand (the brand is part of the target foreign key, `ON UPDATE CASCADE`), manual or timer, UTC instants, IANA zone, local `work_date`, whole-second duration, billable, note. `time_entry_one_live_timer` keeps one running or paused timer per person.
- `time_segment`: half-open UTC intervals of timed entries; `time_segment_guard` refuses overlaps per person, and the deferred `time_entry_consistency` trigger keeps durations equal to closed segments.
- `timesheet` (`tsh_`, seven-day periods) and `timesheet_line` (one brand's state, submitted totals, and hash).
- `timesheet_approval` and `period_lock`: append-only (`timetrack.append_only`), deletable only by an explicit workspace purge.
- `timetrack.lock_person` (transaction advisory lock per person) and `timetrack.day_closed` (submitted or locked) back `time_entry_guard`, which refuses any change to closed time except deletion by the worker role during lifecycle purge.
- `exec_dispatch.discover_runaway_timers` (payload-free; owned by `pm_scheduler`) serves the timer guard.


## Phase 3B core views

Migration `0033_core_view_layouts` (ADR-0020, 0B ADR-28) widens `saved_view_layout_known` to the core layouts and adds `saved_view_layout_entity`, which ties each layout to its entity. It adds no tables or indexes: activity uses `audit_event_by_target`.

## Phase 3C: Today and planning

Migration `0034_today_planning` (ADR-0021, 0B ADR-29) adds to the `planning` schema:
- `today_commitment`: one per person, day, and task; rank, lock, outcome (`open` → `done`, `carried`, `returned`, `dropped`); `today_commitment_guard` keeps owner, day, and task fixed and closed rows final.
- `work_block` (`blk_`): personal, optional task (brand cascades with it), whole-minute UTC span with its zone, focus, lock, preparation and buffer; `work_block_guard` refuses overlap with a focus block under a per-person lock; `(series_id, occurrence_key)` is unique.
- `block_series` (`bls_`): a 2A-subset rule in an anchor zone, local start, duration, and block settings.
- `daily_record`: one per person and day; `daily_record_guard` refuses updates.
- `exec_dispatch.discover_days_to_close` and `discover_block_series_due` (payload-free, `pm_scheduler`) serve the worker; the worker reads `identity.account (id, timezone)` only.

## Phase 3E: capacity

Migration `0035_capacity` (ADR-0022, 0B ADR-30) adds to the `planning` schema:
- `capacity_profile`: one per membership, with an optional `weekly_capacity_minutes` (0–10080), `observe_brand_holidays` (default true), and a version.
- `availability_rule`: weekday (1–7) and local `[start_minute, end_minute)`. `availability_rule_guard` refuses overlapping windows.
- `time_off` (`tof_`): kind (`vacation`, `sick`, `personal`, `holiday`, `unavailable`), either all-day local dates with `source_tz` or timed instants, an optional label, and a version.
- `holiday` (`hol_`): one manual holiday per brand and day (OD-19).
- `capacity_reservation` (`rsv_`): brand, member, `minutes_per_week`, `effective_from` and `effective_to`, `set_by`, and a version.

All five tables have `tenant_isolation` RLS. The down migration restores the exact 0034 catalog.

## Phase 4A: collaboration

Migration `0036_collaboration_reviews` (ADR-0023, 0B ADR-31) adds the `collab` schema and two `relations` tables:
- `collab.comment` (`cmt_`): a host record, a flat thread (`root_comment_id`, `in_reply_to_comment_id`), a rich-text body, and a tombstone shape (a deleted comment has no body and names who removed it). `comment_thread_guard` keeps a reply in its root's thread and record and pins host, thread, author, and time. The application role cannot delete comments.
- `collab.comment_revision`: append-only prior bodies (the application role cannot update or delete).
- `collab.reaction`: one row per comment, person, and reaction from a fixed vocabulary.
- `relations.mention`: typed targets (member, team, or record, exactly one), their order, and `notified` for 4B.
- `relations.follower`: one explicit subscription per person and record.
- `collab.review_request` (`rvw_`), `review_reviewer` (active internal members, trigger-checked), and `review_decision` (one immutable decision per named reviewer). A partial unique index allows one open request per record.
- `collab.assignment_event`: append-only assignment history. `work.task_assignee` gains `delegated_from_membership_id` and `delegated_at`.

All nine new tables have `tenant_isolation` RLS and full indexes on every foreign key. The worker may select and delete them to purge a host's content; the down migration restores the exact 0035 catalog.

## Phase 4B: notifications

Migration `0037_notifications` (ADR-0024, 0B ADR-32) adds the `notify` schema:
- `notify.notification` (`ntf_`): one row per recipient and event with a deduplication key (unique per recipient), a group key, small scalar facts, an occurrence count, and the person's state (unread, read, saved, dismissed). Foreign keys to the recipient, actor, and record are composite on the workspace.
- `notify.delivery` (`ndl_`): one email or browser delivery of a notification or a digest, with a checked state machine, attempts, `next_attempt_at`, a lease, failure class and code, suppression reason, provider message id, and acknowledgement source.
- `notify.digest`: one bundle per recipient, cadence, and period (unique).
- `notify.preference`: a person's choice per event type, channel, and scope (unique on the whole key), optionally expiring.
- `notify.profile`: one row per person (time zone, quiet window, digest cadence and times, channel switches, browser permission).
- `notify.scope_default`: a brand or project default per event type and channel.
- `exec_dispatch.discover_notification_work(now, retention_before, limit)`: a payload-free `SECURITY DEFINER` discovery of the workspaces with due work (owner `pm_scheduler`, executable by the dispatcher), with narrow read grants for `pm_scheduler` on the delivery, notification, and task columns it needs.

All six tables have `tenant_isolation` RLS and full indexes on every foreign key. The application role can write them; the worker reads, claims, and updates deliveries. The down migration drops the function, the grants, the policy it added on `work.task`, and the tables in key order, restoring the exact 0036 catalog.

## Phase 4C: documents

Migration `0038_documents` (ADR-0025, 0B ADR-33) adds the `knowledge` schema:
- `knowledge.document` (`doc_`, on the envelope): scope (`brand_id` null for workspace-level, `scope_key = coalesce(brand_id, workspace_id)`), the page tree (`parent_document_id`, `ancestor_ids`, `depth`), the attachment (a project or a task, never both), type, title, state, owner, review date, the current version pointer, `access_mode` (constrained to `inherit`), and `rank`. A deferred constraint trigger checks that a page is in its parent's scope and attachment with ancestry equal to the parent's plus the parent.
- `knowledge.document_version` (`dcv_`): immutable (a trigger refuses updates; the application role inserts and reads only), with number (unique per document), title, content (checked shape and size ceiling), SHA-256 hash, kind, restore source, starter key, and change summary.
- `knowledge.document_reference`: inline mentions and explicit links, typed targets (member, team, or record of a registered type), no label.
- `knowledge.document_suggestion` (`dsg_`): a block replacement against a base version and block hash, with a checked state machine.
- `knowledge.source_approval`: append-only approvals and revocations of one version as an AI source.
- `collab.review_request.subject_kind` now accepts `document`.

The keys that relate documents, versions, and their children are deferrable (`NO ACTION`, deferred) so a purge may delete them together. All five tables have `tenant_isolation` RLS and full indexes on every foreign key. The worker may select and delete them to purge a document's content; the down migration restores the exact 0037 catalog.

## Phase 4E: files and deliverables

Migration `0039_files_deliverables` (ADR-0026, 0B ADR-34) adds the `files` schema:
- `files.file_object`: one stored object per upload with an identifier-free key (`q.{64 hex}` while quarantined, `o.{same}` once promoted; `file_object_key_shape` and `file_object_key_matches` tie the prefix to `quarantined`), SHA-256, size, content type, scan state, attempts, and (only when infected) an internal signature.
- `files.file` (`file_`, a `core.record`): name, owner, source (`upload` or `external`), host kind and host (`file_host_shape`), brand and `scope_key`, current version, and version count.
- `files.file_version`: immutable by the `file_version_guard` trigger (only the evidence lock may be set, never cleared, and the preview state); an object or an external `http(s)` URL (`file_version_source_shape`).
- `files.upload_session` (`upl_`): the declared name, type, size, and checksum, the host or target file, the quarantine key, state, rejection code, and expiry; a version only on a completed session.
- `files.deliverable` (`dlv_`, a `core.record`) and `files.deliverable_version`: expected type, state, current and accepted versions; each version is a file version or a URL with its 4A review request, the deciding `collab.review_decision`, who accepted and when, and the evidence lock (`deliverable_version_guard` refuses any change to a locked row). `collab.review_request.subject_kind` gains `deliverable`, and `collab.review_decision` gains a workspace-qualified unique key for the composite foreign key.
- `files.storage_usage`: one row per workspace with used and reserved bytes and the object count.
- `exec_dispatch.discover_file_work(now, limit)`: a payload-free `SECURITY DEFINER` discovery of the workspaces with expired upload sessions or pending `object:{key}` effects (owner `pm_scheduler`, executable by the dispatcher), with column-level read grants for `pm_scheduler`.

All seven tables have `tenant_isolation` RLS and indexes on every foreign key. The application role inserts and updates only named columns (objects change scan state and leave quarantine only in the worker). The down migration drops the function, grants, and policies, restores the 0037 review subject check, and drops the tables in key order, restoring the exact 0038 catalog.

## Phase 4D: collaborative editing

Migration `0040_collaborative_editing` (ADR-0027, 0B ADR-35) adds three tables to the `knowledge` schema:
- `knowledge.edit_draft`: at most one per document (primary key `(workspace_id, document_id)`): the working block list (`valid_content`), its hash, the version it was opened from, the last sequenced operation (`seq`), the `seq` of the last checkpoint, and `dirty`.
- `knowledge.edit_session`: a live connection (`session_key`, mode, colour, caret block, `expires_at`), unique per document and handle.
- `knowledge.edit_op`: the ordered log (primary key `(workspace_id, document_id, seq)`); a unique `(document, member, op_id)` makes a retry idempotent; the session reference is `ON DELETE SET NULL (session_id)`.

All three have `tenant_isolation` RLS, deferrable composite foreign keys to the document, and indexes on every foreign key. The application role reads, inserts, and updates drafts, inserts and deletes operations, and manages sessions; the worker may only read and delete (purge). The down migration drops the three tables, restoring the exact 0039 catalog.

## Phase 5A: permission-aware search

Migration `0041_permission_aware_search` (ADR-0028, 0B ADR-36) adds the `search` schema:
- `search.search_document`: one row per searchable source row (primary key `(workspace_id, source_kind, source_id)`): the governing record (`auth_record_id`, a composite foreign key to `core.record` that cascades), the optional context record and owner, the title and body (at most 100,000 characters), the source's update time, and a generated `tsv` (the `simple` and `english` configurations, title weighted above body, ASCII punctuation as separators). It stores no brand, project, lifecycle, or permission key. There is **no GIN index**: under forced row-level security PostgreSQL cannot use one for a role subject to it (the match operator is not leakproof), so it would only slow writes (ADR-0028 S14).
- `search.index_status`: the key queue (`pending` or `failed`, attempts, `next_attempt_at`, a failure class from a fixed list, never a message), written by triggers in the source's transaction and drained by the worker.
- `search.recent_search`: the person's own submitted queries, unique per workspace, owner, and normalized query and filters; the owner foreign key cascades.

Triggers: `search.source_changed()` (after insert or update of the searchable columns of tasks, projects, milestones, decisions, documents, comments, files, deliverables, and deliverable versions) writes the key; `search.source_removed()` (after delete) and `search.record_purged()` (after a record becomes `purged`) remove rows. They run as the owner, write and delete keys and projection rows only, and are covered by the rollback. The migration queues every existing source row: because the source tables force row-level security even on the migration role, it lifts the force on those eight tables for that one read inside the migration transaction and restores it straight after (corrective review 01). `exec_dispatch.discover_search_work(now, retention_before, limit)` is a payload-free `SECURITY DEFINER` discovery (owner `pm_scheduler`, executable by the dispatcher) of workspaces with due keys or recent searches past retention, with column-level read grants for `pm_scheduler`.

All three tables have `tenant_isolation` RLS (enabled and forced) and indexes on every foreign key. The API role reads the projection and the queue and manages recent searches; the worker reads, inserts, updates, and deletes both the projection and the queue and may only read and delete recent searches (retention). The down migration drops the triggers, functions, tables, and schema, restoring the exact 0040 catalog.

## Phase 5A search authority

`SearchService` (AZ-36) is the last class of the service chain. Every search is one workspace transaction: it compiles the person's visibility once (`need: view`), then reads the projection through a single statement that joins each row to its governing `core.record` and applies the predicate before matching, ranking, counting, faceting, or paging; the page's excerpts, brands, projects, and owners are then read for those keys only. A source adapter (`SearchSource`) may add a live check on the row itself (a comment's `deleted_at`, a file's or deliverable's own lifecycle), so a deletion is visible before the index catches up. The index job (`searchIndexHandler`) claims keys with `FOR UPDATE SKIP LOCKED`, rebuilds each row under a savepoint, and records failures on the key.

## Phase 5B: goals and portfolios

Migration `0042_goals_portfolios` (ADR-0029, 0B ADR-37) adds the `goals` schema:
- `goals.goal`, `goals.key_result`, and `goals.portfolio`: records in the core envelope (`goal_`, `kr_`, `pf_`) with a row `version`, bounded text and decimals, a period of at most 3660 days, a measurement that needs its baseline, and a basis that allows a measurement only when it is manual. `latest_*` columns mirror the newest manual check-in.
- `goals.goal_checkin`: append-only. A `BEFORE UPDATE` trigger refuses any change, the application role has no update or delete, and a unique index on `(workspace_id, goal_id, inputs_hash)` makes a computed check-in idempotent.
- `goals.goal_link`: links a goal or key result to a project or task (unique per goal, key result, and target); a trigger keeps a brand goal's links in its brand and a project goal's task links in its project.
- `goals.portfolio_project`: an explicit member list; a trigger keeps a brand portfolio to its brand's projects.
- `goals.goal_state`: one row per goal with viewer-neutral derived facts and the dirty, due, lease, attempt, and error bookkeeping, and `exec_dispatch.discover_goal_work(now, limit)`, a payload-free `SECURITY DEFINER` discovery of workspaces with goals due for recalculation (owner `pm_scheduler`, executable by the dispatcher, with column-level read grants).

All seven tables have `tenant_isolation` RLS and indexes on every foreign key. The worker may read and delete (purge), append computed check-ins, and maintain state. The down migration drops the function, grants, policy, triggers, and tables in key order and the `goals` schema, restoring the exact 0040 catalog.

**Migration number.** This branch and Phase 5A (`0041_permission_aware_search`) were built in parallel and both use `0041`; the integrator renumbers one of them, as 4C and 4E did with `0038`.

## Phase 5C: the metrics ledger

Migration `0043_metrics_model` (ADR-0030, 0B ADR-38) adds the `metrics` schema:
- `metrics.task_status_span`: one row per span of a task's status (primary key `(workspace_id, task_id, seq)`; a composite foreign key to `core.record`, deferrable, cascading; a partial unique index allows one open span per task). `basis` is `recorded`, `assumed`, or `repaired`. It holds no brand, project, lifecycle, or permission key.
- `metrics.reconcile_state`: one row per workspace with tasks (due time, lease, keyset position, repair counts, attempts, last success and failure, a short failure code).

Triggers: `metrics.task_changed()` (after insert, and after update of `status_id` or `status_category` on `work.task`) opens, closes, and opens spans in the task's transaction; `metrics.task_removed()` (after delete) and `metrics.record_purged()` (after a record becomes `purged`) delete spans. They run as the owner and only write and delete spans. The migration writes one `assumed` span per existing task; because the task table forces tenant row-level security even on its owner, the force is lifted for that one read inside the migration transaction and set again straight after (the catalog comparison in the migration test proves it is restored). `exec_dispatch.discover_metrics_work(now, limit)` is a payload-free `SECURITY DEFINER` discovery of workspaces whose pass is due and not leased (owner `pm_scheduler`, executable by the dispatcher, with column-level read grants).

Both tables have `tenant_isolation` RLS (enabled and forced) and indexes on every foreign key. The API role reads them and may only update `next_run_at` of the state row; the worker reads, inserts, updates, and deletes both. The down migration drops the triggers, functions, tables, and schema, restoring the exact 0042 catalog.

Every figure is one workspace transaction that joins each counted record to its governing `core.record` and applies the compiled visibility predicate before counting; nothing aggregate is stored (ADR-0030 M1, M3).
**Migration number.** This branch and Phase 5C were built in parallel and both first used `0043`; Phase 5C was accepted first, so the Phase 5 final integration renumbered this migration to `0044` (a number-only change).

## Phase 5D: dashboards and reports

Migration `0044_dashboards_reports` (ADR-0031, 0B ADR-39) adds the `insights` schema:
- `insights.dashboard` and `insights.report_definition`: records in the core envelope (`dash_`, `rpt_`) with a row `version`. A dashboard holds a bounded `layout` (widgets) and `filters`; a report holds a bounded `config` and an optional schedule (frequency, weekday or month day 1 to 28, minute of day, IANA zone, next and last run, lease, attempts, suspension). A check constraint keeps a schedule all-or-nothing and the placement of each dashboard kind exact. No column holds a figure.
- `insights.report_recipient`: the members who receive a scheduled report (primary key on report and member).
- `insights.report_share`: an explicit, revocable grant to open and run one report. Its composite key names the report's own scope key, so a share cannot name another scope; one active share per grantee (partial unique index); an optional expiry.
- `insights.report_run`: one row per scheduled occurrence and recipient, unique on (report, recipient, occurrence), so delivery is idempotent. It stores a state, a short code, a row count, an incomplete flag, a content hash, and a failure class; the application role may only read it and the worker writes and ages it out.

All five tables have `tenant_isolation` RLS and indexes on every foreign key. A payload-free `SECURITY DEFINER` function `exec_dispatch.discover_report_work(now, retention_before, limit)` (owned by `pm_scheduler`, executable only by the dispatcher) returns workspace identifiers with a report due or runs past retention. The down migration restores the exact 0042 catalog.

**Migration number.** This branch and Phase 5C were built in parallel and both first used `0043`; Phase 5C was accepted first, so the Phase 5 final integration renumbered this migration to `0044` (a number-only change).

## Phase 7A: AI gateway and metering

Migration `0053_ai_gateway` (expand; exact rollback to 0052; 0B ADR-44, ADR-0038) adds the `ai` schema (`ai_provider_config`, `brand_ai_profile`, `ai_action`, `ai_context_ref`, `ai_dispatch`, `ai_output`) and the `metering` schema (`spend_limit`, `usage_balance`, `usage_reservation`, `usage_event`). Every table has a `RESTRICT` workspace key, forced `tenant_isolation`, and explicit grants. Highlights:

- Money and token amounts are `numeric(20, 6)` (exact micro-dollars; tokens on the same scale).
- `ai_provider_config.require_training_exclusion` is held true by a CHECK while OD-41 is open. A workspace key is a vault reference only.
- `ai_dispatch` is committed as `dispatching` before a provider request leaves. A later attempt that finds it still `dispatching` marks it `unknown` and never resends it.
- Reservations are unique per `(dispatch_id, meter)`. Reserving locks the meter's balance rows up to the current period `FOR UPDATE`, in meter and period order. Settlement moves `held`/`unknown` to `settled` exactly once.
- `usage_event` is insert-only for both application roles and never billable (10A owns billing).
- `ai_output` is immutable (trigger `ai_output_immutable`) except for erasure. `ai_action` grants `UPDATE` only on its erasure columns.
- `exec_dispatch.discover_ai_retention_work` (payload-free, `pm_scheduler`) serves the content retention sweep, which is off while `AI_HISTORY_RETENTION_DAYS` is unset.

Purge order (dependents first, ahead of `exec.*`): `metering.usage_event`, `metering.usage_reservation`, `ai.ai_output`, `ai.ai_context_ref`, `ai.ai_dispatch`, `ai.ai_action`, `metering.usage_balance`, `metering.spend_limit`, `ai.brand_ai_profile`, `ai.ai_provider_config`.

Migration `0054_ai_gateway_corrections` (expand; exact rollback to 0053; 0B ADR-45; corrective review 01) is additive:

- `ai_dispatch` gains `price_snapshot` and `capability_snapshot` (null only for attempts before 0054, which settle against their action's snapshot), `bound_breach`, `clipped_locally`, and `failure_detail` (a closed set). A breach always carries `failure_detail = 'bound_breach'`.
- `ai_provider_config` gains `dispatch_suspended_reason` and `dispatch_suspended_at`. `app_worker` may update only those columns, `updated_at`, and `version`.
- `ai.scrub_dispatch_checkpoints(uuid[])` (SECURITY DEFINER, `search_path` pinned, not executable by `PUBLIC`; `app_rw` and `app_worker` may call it) removes `system`, `user`, and `keyRef` from the `ai.prepare.<n>` steps of `ai.action.dispatch` jobs. It reaches the current workspace only, because `exec.job` row-level security still applies. Every other step and fact is kept.
- The one-time cleanup of copies written before 0054 lifts forced row-level security on `exec.job` for one statement inside the migration transaction and restores it, as 0041 did. The migration test proves the catalog afterwards is the reference catalog. Rolling back does not restore removed content.
