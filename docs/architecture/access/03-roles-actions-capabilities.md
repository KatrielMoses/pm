# 3. Roles, actions, and capabilities

A role label is **not** the algorithm. A role contributes three things to the effective-permission calculation ([04](04-effective-permissions.md)):

1. a set of **administrative and execution capabilities** (matrix cells);
2. **implicit scope access**, which only owner and administrator have;
3. a **level cap**.

Everything else comes from grants.

## 3.1 Default roles

| Role | Kind | Implicit access | Level cap | Distinguishing rules |
|---|---|---|---|---|
| `owner` | member | `manage` on the workspace scope and every **non-sensitive** brand | — | The only role for non-delegable actions (workspace deletion, ownership transfer, retention, legal hold, sensitive-scope elevation). At least one owner always exists. |
| `administrator` | member | `manage` on the workspace scope and every non-sensitive brand | — | Workspace administration except the non-delegable owner actions. Billing management only if `admins_manage_billing` policy is on. |
| `member` | member | `view` on workspace-scoped records (workspace default level, configurable); no brand access | — | Brand and project access only through scope grants. May invite guests if `members_invite_guests` policy is on. |
| `limited_member` | member | none | — | Internal user with no implicit workspace or brand access. Explicit brand, project, or record grants only. Reduced capabilities (export, tokens, AI, and agents only by policy). |
| `read_only` | member | as for member, capped | `view` | No comment, edit, execution, or approvals. Read-only AI only when `read_only_ai` policy is on. |
| `guest` | guest | none | `edit` (the share level) | Record grants (shares) only. No scope grants, directory, aggregation, trash, onward sharing, or administration ([06](06-guests-sharing-public-links.md)). |

**Who can assign which role** (validated as grantable authority, I-11):

| Assigner | Can assign |
|---|---|
| owner | any role |
| administrator | administrator, member, limited member, read-only, guest |
| member | guest only, and only through sharing when the policy allows it |
| limited member, read-only, guest | none |

The validator proves that each assignable role never exceeds its assigner on any of the 98 actions.

**Last-owner protection:** removing, demoting, or suspending the last active owner is rejected (AT-071).

## 3.2 Access levels (record permissions)

| Level | Includes |
|---|---|
| `view` | read, follow, download, AI read over the record (if AI is permitted), export (if the export capability is held) |
| `comment` | + comment, reply, react, mention; act as a designated reviewer; log own time |
| `edit` | + create in scope, update, assign, delegate, relate (with view on the target), upload, archive, trash, restore, complete, submit, request review, start agents and tests (with execution capability) |
| `manage` | + share, grant scope roles ≤ own level, restrict, configure the scope (workflow, fields, views, automations, notification rules, brand AI profile), approve brand lines, move between brands |

Levels are ordered. A requirement "≥ edit" is satisfied by edit or manage.

## 3.3 Action vocabulary

There are 98 actions in four kinds. The authoritative list is [policy/policy.json](policy/policy.json), rendered in [generated/permission-matrix.md](generated/permission-matrix.md).

| Kind | Count | What it governs | Evaluated against |
|---|---|---|---|
| Record permissions | 33 | Operations on records in a scope (create, read, update, archive, restore, trash, comment, follow, assign, delegate, relate, upload, download, move, move between brands, share, revoke share, export, complete, submit, review decide, self-approve, verify, release decide, time, timesheets, views, reports, environments, tests) | Effective access level on the target **and** the role's matrix cell |
| Administrative capabilities | 50 | Workspace and brand administration, membership, teams, roles, grants, restrictions, previews, elevation, policies, workflows, fields, views, templates, notifications, AI, agents, automations, integrations, API tokens, webhooks, security, sessions, retention, legal holds, trash, purge, audit, export, usage, billing, secrets metadata, health, support access, emergency stop | Role capability, plus the scope level for scope-bound capabilities (cells `≥manage`) |
| Execution permissions | 11 | Running things: AI, applying proposals, agents, run control, gated agent actions, automations, syncs, imports, webhook tests, tests, production actions | Role capability + level on the target + the execution layer's own scope ([09](09-execution-delegation.md)) |
| Personal | 4 | Own Inbox, Today, notifications, views, availability, sessions, personal tokens, timesheet submission | Ownership of the personal record |

**Agent tool classes** (14, separate from all of the above) govern what an agent may invoke. They have their own risk and approval classes ([09 §9.3](09-execution-delegation.md#93-agents)).

Required brief verbs map to matrix rows as follows:

- **Records:** create, read, update, archive, restore, delete (`record.trash`), purge, comment, follow, assign, delegate, relate, upload, download, share, export.
- **People and ownership:** invite (member and guest invitations), manage membership, transfer ownership.
- **Decisions:** approve and reject (`review.decide`), verify, release, unlock, self-approve.
- **Configuration:** the `*.configure` and `*.manage` families.
- **Execution:** the execution kind.
- **Viewing administrative data:** `audit.view`, `usage.view`, `billing.view`, `secrets_metadata.view`, `health.view`.

## 3.4 Plan entitlements

Entitlements (from `billing.entitlement_grant`) **only remove** capabilities (I-13). An action flagged `E:<key>` in the matrix is unavailable when the plan lacks the entitlement, regardless of role. Entitlement-limited at launch:

- `custom_roles.manage` (`custom_roles`);
- `audit.export` (`audit_export`);
- `legal_hold.manage` (`legal_hold`, an extension point).

Usage limits (AI, agents, automations, storage) are enforced by `metering` reservations and are not permissions.

## 3.5 Custom roles (extension point)

- Gated by the `custom_roles` entitlement (OD-45).
- A custom role is defined as **a base default role minus capabilities, plus capabilities from a delegable allow-list**. It can never include non-delegable actions, implicit brand access, or a level above its base role's cap.
- The grantable-authority check applies: an administrator can create or assign only custom roles whose every cell is ≤ the administrator's own.
- Custom roles are stored as `access.role` rows with a capability set. The evaluation algorithm is unchanged, because a role contributes only capabilities, implicit access, and a cap.
