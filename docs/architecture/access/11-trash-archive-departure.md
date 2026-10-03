# 11. Trash, archive, retention, and departed users

## 11.1 Trash (resolves DQ-08)

| Rule | Detail |
|---|---|
| Visibility | A trashed record is visible in Trash to a viewer whose **current** effective level on the record (computed as if the record were active) is **≥ edit**. Permission at deletion time is irrelevant (AT-056). |
| Restore | Requires the current level ≥ edit on the record **and** on its restore destination (container active, 0A rules) |
| Trash management | `trash.manage` (owner, administrator) lists and restores any batch **within scopes the administrator can access**. Sensitive brands and restricted projects without explicit grants stay invisible to administrators here too. |
| Guests | **Never** see Trash, including for formerly shared records. Shares do not apply to trashed records (AT-055). |
| Purge | `record.purge` (owner, administrator) — R4, step-up, independent approver when available. Scheduled purges run as a system job ([09 §9.7](09-execution-delegation.md#97-background-jobs)). |

0E ST-46 says Trash is "visible only to users who could access the record before deletion". This document amends that to current effective permission (AC-02).

## 11.2 Archive

Archive does **not** change authorization: readers of an active record can read it archived. Archived records are excluded from ordinary views, search defaults, Today, AI defaults, and automations (0A). They are writable only through restore, plus comments where workspace policy allows.

## 11.3 Retention, holds, deletions

| Capability | Who | Notes |
|---|---|---|
| `retention.configure` | Owner only, step-up, non-delegable | Values pending OD-34/OD-36 |
| `legal_hold.manage` | Owner only, step-up, entitlement, non-delegable | Extension point (OD-37) |
| `workspace.delete` | Owner only, step-up, independent approver when available | Grace period per 0A |
| Account deletion | The account holder, step-up | Blocked while sole owner of any workspace (OD-39) |

Each is audited with distinct actions.

## 11.4 Ownership transfer and last-owner protection

- `ownership.transfer` is owner-only with step-up. The recipient must be an active member and must accept. The previous owner becomes an administrator unless they choose otherwise.
- The last active owner cannot be removed, demoted, or suspended, and cannot delete their account (AT-071).

## 11.5 Departed members

When a membership is removed (`membership.manage`) or the account is deleted, the following happen **in one transaction**:

1. Membership `state = removed` and the principal epoch is bumped.
2. All sessions are revoked, along with personal API tokens and OAuth consents.
3. Live SSE streams are closed.
4. Queued jobs whose effective principal is the member are cancelled. Jobs rendered *for* the member (digests, reports) are dropped.

Then, by workflow:

- **Owned records** (owner fields on projects, documents, connections, automations, service principals, agent profiles) are reassigned to a chosen person (PERM-014). Until reassigned, service principals and automations owned by the departed member are **suspended**, and connections pause outbound disclosure (AT-070).
- **Agent runs** assigned by the member pause with reason `assigner_removed` until reassigned. Reassignment recomputes the run scope with the new assigner.
- **Shares created by the member** remain (they are workspace grants) and are listed for review.
- **Personal records** are deleted per R-PERSONAL. Administrators cannot read or export them. 0A deletion §3 allows an administrator export before deletion; this conflicts with personal-record privacy, and AC-05 proposes that it require a distinct, audited capability and product-owner approval (AQ-07).
- A departed user keeps **no access** of any kind. Their name remains on history per OD-39 pseudonymization rules.
