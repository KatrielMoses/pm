# 12. PostgreSQL RLS and application policy responsibilities (resolves DQ-03)

## 12.1 Division of responsibility

| Layer | Guarantees | Does not guarantee |
|---|---|---|
| **RLS** on every tenant table | A transaction sees and writes only rows of the workspace in `app.workspace_id`. A missing context sees nothing. | Brand, project, record, field, or execution authorization |
| **Application query compilation** | Fine-grained visibility predicates, field allow-lists, gates, approvals, delegation intersections | Isolation if the compiler is bypassed (RLS covers that) |
| **Composite foreign keys** (0B) | Rows cannot reference another tenant's or brand's parents | Who may read |

## 12.2 RLS design

```sql
ALTER TABLE work.task ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.task FORCE ROW LEVEL SECURITY;           -- applies to the table owner too
CREATE POLICY tenant_isolation ON work.task
  USING      (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
-- current_setting(..., true) returns NULL when unset → predicate is NULL → no rows (fail closed)
```

- Applied to **every** table with `workspace_id`, including append-only, projection, and execution tables.
- Platform tables (accounts, plans, platform content) have no tenant policy. They are reachable only through platform APIs.
- `billing.billing_account` and the other R-BILLING tables outlive workspaces. They use a policy on their `workspace_id` reference, and platform billing processes access them through the billing role.

## 12.3 Database roles

| Role | RLS | Purpose |
|---|---|---|
| `app_rw` | **Subject to RLS** (`NOBYPASSRLS`, not table owner) | Web and API processes |
| `app_worker` | **Subject to RLS** | Job workers. Sets the workspace per transaction from the job row. |
| `app_ro` | Subject to RLS | Read replicas, report rendering |
| `dispatcher` | Subject to RLS, plus `SECURITY DEFINER` functions | Cross-tenant **scheduling only**: functions return `(id, workspace_id, queue, run_at)` from `execution.job` / `outbox_event` **without payloads**. Processing then happens per workspace with `app_worker` ([12.4](#124-workers-and-cross-tenant-jobs)). |
| `audit_maintainer` | Subject to RLS | Redaction and purge procedures only (0B §7.1) |
| `migrator` | Owner (DDL) | Migrations. Separate credentials, CI-only, audited. Never used by application processes. |
| `restore_operator` | Owner, break-glass | Backup restore and purge-ledger replay (0B §8.11). Credentials held in the secret store, two-person activation, audited. |
| `platform_support` | Subject to RLS | Support tooling under a customer support grant ([02 §2.5](02-principals-and-execution-identity.md#25-support-access-and-impersonation)). Sets the workspace context only for workspaces with an active grant, enforced by a `SECURITY DEFINER` gate function. |

**No ordinary role has `BYPASSRLS`.** 0B §10.4 proposed a dispatcher with "narrowly scoped BYPASSRLS". This document replaces that with payload-free definer functions plus per-workspace processing (AC-06).

## 12.4 Workers and cross-tenant jobs

1. The dispatcher (definer function) selects due job IDs and workspace IDs across tenants, `FOR UPDATE SKIP LOCKED`, with per-workspace fairness caps.
2. For each claimed job: begin a transaction, `SET LOCAL app.workspace_id = job.workspace_id`, load the job payload (now RLS-visible), and build the execution context from the job's durable principal fields. Run, commit.
3. Maintenance across tenants (retention sweeps, reindex) iterates **explicit workspace IDs**, one transaction per workspace. **There is no wildcard or unset context mode.**

## 12.5 Connection pooling

- Tenant context is set **only** with `SET LOCAL` (transaction-scoped). Session-level `SET` and `set_config(..., false)` are prohibited by a lint rule.
- Every unit of work runs in an explicit transaction, including reads, so `SET LOCAL` applies. The pool is configured in transaction mode, and connections are returned with no open transaction.
- Defense: the application wraps every transaction in a helper that sets the context first and asserts `current_setting('app.workspace_id')` equals the expected value before the first query.

## 12.6 Limitations and failure modes

| Limitation | Mitigation |
|---|---|
| RLS adds a predicate to every query | Indexes lead with `workspace_id` (0B §10.5). The policy expression is a simple equality. |
| Definer functions are privileged code | Small, reviewed, return no payload columns, covered by tests |
| A bug setting the wrong workspace in context would pass RLS | The context comes from the authenticated membership or job row, never the request body (I-09), and is verified against the membership's workspace before any query |
| RLS cannot express grants | By design. The application compiler owns grants (§12.1). |
| Superuser and owner roles bypass RLS | Not used by application, worker, or support processes. Owner-level roles are break-glass, audited. |

## 12.7 Test strategy (feeds 1C/11B)

| Test | Expectation |
|---|---|
| Missing context | Every tenant table returns zero rows, and inserts fail (AT-073) |
| Context leakage via pool | Transaction A sets W1 and commits. The next transaction on the same pooled connection without `SET LOCAL` sees zero rows (AT-073). |
| Wrong-tenant insert | `WITH CHECK` rejects (AT-074) |
| Role inventory | No application or worker role has `BYPASSRLS`. Every table with `workspace_id` has RLS enabled and forced (catalog query in CI). |
| Worker isolation | A worker processing W1's job cannot read W2's rows (AT-075) |
| Definer function surface | Dispatcher functions return only the allowed columns |
| Restore | After a restore drill, RLS policies and roles are intact. Ledger replay runs under `restore_operator` only. |
