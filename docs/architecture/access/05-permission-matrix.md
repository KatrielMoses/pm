# 5. Default permission matrix

The matrix is machine-readable in [policy/policy.json](policy/policy.json) and rendered in [generated/permission-matrix.md](generated/permission-matrix.md).

**Dimensions:** 109 actions × 6 default roles = 654 explicit cells. Each action also declares:

- its applicable scope levels (workspace, brand, project, record, personal, field, connection);
- the required access level;
- its risk class and approval class;
- step-up, second-approval, non-delegable, and entitlement flags;
- its requirement traces.

## 5.1 Cell semantics

| Cell | Meaning |
|---|---|
| `implicit` (**all**) | Allowed across the workspace and non-sensitive brands without a specific grant. Sensitive brands and restricted projects still require explicit grants. |
| `grant:<level>` (≥level) | Allowed where the principal's effective level on the target ([04](04-effective-permissions.md)) is at least that level |
| `own` | Only on the principal's own personal records or own items (own comments, sessions, tokens) |
| `policy:<key>` (if key) | Allowed only when the named workspace policy setting is on (stored in `access.workspace_policy`) |
| `deny` (—) | Never, for any scope |

## 5.2 Coverage of the required areas

| Area | Rows (examples) |
|---|---|
| Workspace and brand administration | `workspace.configure`, `brand.create/configure/archive/delete/mark_sensitive`, `feature_availability.configure` |
| Projects, tasks, comments, documents, files, deliverables, goals | Generic record rows (`record.*`) apply to every record family, plus `task.complete`, `project.complete`, `deliverable.submit`, `comment.edit_own`, `comment.moderate` |
| Views, reports, time | `view.share`, `views.configure`, `report.schedule`, `time.log_own`, `timesheet.submit_own/approve/unlock` |
| Membership, teams, guests, sharing, exports | `membership.invite_member/invite_guest/manage`, `team.manage`, `access.grant_scope`, `record.share/share_revoke`, `record.export`, `workspace.export` |
| Approvals and reviews | `review.request`, `review.decide`, `review.self_approve`, `defect.verify`, `release.decide` |
| AI, agents, automations, integrations, tokens, webhooks | `ai.execute`, `ai.apply_proposal`, `ai.configure_brand`, `ai.providers.manage`, `ai.limits.configure`, `agent.assign`, `agent.run_control`, `agent.action_approve`, `agents.configure`, `automations.configure`, `automation.run_manual`, `integrations.configure`, `integration.sync_now`, `api_tokens.personal`, `api_tokens.service.manage`, `webhooks.manage`, `webhook.test_send` |
| Testing, defects, environments, releases, production | `tests.execute`, `defect.verify`, `environment.configure`, `release.decide`, `release.production_action` |
| Audit, security, sessions, retention, deletion, billing, ownership | `audit.view/export`, `security.configure`, `sessions.manage_own/others`, `retention.configure`, `legal_hold.manage`, `trash.manage`, `record.purge`, `workspace.delete`, `billing.view/manage`, `usage.view`, `secrets_metadata.view`, `health.view`, `ownership.transfer`, `support_access.grant`, `emergency_stop.trigger` |

## 5.3 Special flags

| Flag | Actions | Rule |
|---|---|---|
| **Non-delegable** (owner only; excluded from custom roles; cannot be granted to any service principal, token, agent, or automation) | `workspace.delete`, `ownership.transfer`, `retention.configure`, `legal_hold.manage`, `access.elevate_sensitive` | Validator-enforced |
| **Step-up authentication** (fresh re-authentication; mechanism in 1B) | 27 actions, including all R4 actions, own-account MFA enrollment, MFA removal, and recovery-code regeneration, write-scoped API tokens, AI provider keys, security settings, membership management, sharing policy, workspace and audit exports, billing changes, period unlock, support access, brand sensitivity | Includes all 0E ST-33 re-authentication cases. Validator: every R4 action has step-up. |
| **Second / independent approval** | `record.purge`, `workspace.delete`, `release.decide` (and every action whose approval class is `independent_if_available`) | Required when policy enables it and another approval-capable human exists; otherwise labelled self-approval ([10](10-approvals-separation-of-duties.md)) |
| **Entitlement-limited** | `custom_roles.manage` (custom_roles), `audit.export` (audit_export), `legal_hold.manage` (legal_hold) | Entitlements only remove capabilities (I-13) |
| **Never automatable** | Every R4 action; `review.decide`, `review.self_approve`, `defect.verify`, `release.decide` | No service principal, token, agent, automation, or AI may perform them (I-15) |
