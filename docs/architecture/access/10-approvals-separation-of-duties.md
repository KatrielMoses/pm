# 10. Approval, self-approval, and separation of duties

## 10.1 Who can approve

An approval decision (review decision, gated agent action, go/no-go, verification, timesheet approval, extra-usage purchase) is valid only if **at decision time** all of the following hold:

1. The decider is a **human** membership (I-15). Agents, automations, integrations, AI, tokens, and service principals are structurally excluded: `review_decision.reviewer_actor_type = 'human'` (0B §4.8).
2. The decider is **designated** by the reviewer rule or approval policy for that subject.
3. The decider holds the action's capability and level **now**. Authority at request time is not enough (AT-080 checks policy at decision).
4. For agent output, the decider can read the **entire run scope** (UXD-11).
5. Separation of duties (§10.2) and step-up (§10.4) are satisfied.

## 10.2 Self-approval and independence

| Policy (`workspace_policy.self_approval_mode`) | Behavior |
|---|---|
| `auto` (default) | Self-approval allowed **only while exactly one approval-capable human** belongs to the workspace. Approval-capable means an active, non-guest, non-read-only membership whose role allows any decision action. Evaluated at decision time: when a second approval-capable human joins, self-approval stops for new decisions. |
| `allowed` | An owner explicitly allows self-approval (step-up, audited). It still never applies to agents, AI, automations, or integrations. |
| `forbidden` | Self-approval is never allowed. With a single human, gated actions wait. |

**Every self-approval is labelled and audited:** `review_decision.self_approval = true` and a `security_event` for R3/R4. It shows as "Self-approved" wherever the decision is shown (OD-20).

**Independent approver** (`independent_if_available` approval class, and actions flagged 2A): the approver must differ from the requester and from the person whose work is approved. If no other approval-capable human exists:

- under `auto`, the action proceeds as a labelled self-approval;
- under `forbidden`, it waits.

The policy `require_independent_for: [risk classes or action keys]` lets a team make independence mandatory, for example for `release.production_action`, `record.purge`, and `security.configure`.

**Defect verification:** the verifier must differ from the fixer when the defect policy requires independence (OD-21). The same self-approval rule applies to solo workspaces.

## 10.3 Action-risk classification (reused by 8D and 9D)

| Class | Meaning | Humans | Agents (tool classes) | Automations |
|---|---|---|---|---|
| **R0** | Informational or trivially reversible internal action | Authorization only | Allowed within run scope (`read_records`, `draft_content`, `attach_artifacts`) | Allowed |
| **R1** | Reversible internal change | Authorization; undo available | `create_subtasks`, `run_tests` under low-impact policy; `update_records` needs review | Allowed within declared actions |
| **R2** | Significant internal change or configuration | Confirmation (0E Tier 1) | `code_change` held for review | Allowed if declared at activation |
| **R3** | External disclosure, financial, access-changing, integration effect | Confirmation (Tier 2) + step-up where flagged | **Human approval per instance** (`external_message`, `publish`, `spend`, `scope_expansion`) | Only if declared at activation by an owner with authority (standing approval); otherwise denied |
| **R4** | Irreversible, production, security, ownership, legal | Step-up + independent approver where policy and availability allow | **Human approval per instance** (`access_change`, `destructive`, `production_change`) | **Never** |

Each action in [policy/policy.json](policy/policy.json) carries `risk_class` and `approval_class`, and each agent tool class carries both. Phase 8D (agent approvals) and 9D (release decisions) reuse these classes rather than defining new ones.

## 10.4 Step-up authentication

Step-up means fresh re-authentication within a short window (mechanism in 1B) for the 24 actions flagged SU in the matrix. These include every R4 action and all 0E ST-33 cases:

- ownership transfer;
- workspace deletion;
- disabling MFA (part of `security.configure`);
- API tokens with write scopes;
- AI provider keys.

Step-up is bound to the session and the action. It cannot be satisfied by a token or service principal, so these actions are human-only.

## 10.5 High-risk actions and their controls

| Action | Controls |
|---|---|
| `release.production_action`, `release.decide` | R4, step-up, independent approver when available, immutable decision |
| `security.configure` | R4, step-up; independent if required by policy |
| `billing.manage` (purchases, extra usage, plan changes) | R3, step-up, explicit approval of the amount (BILL-010) |
| `ownership.transfer` | R4, owner only, step-up; the recipient accepts; last-owner protection |
| `record.purge`, `workspace.delete` | R4, step-up, independent approver when available; deletion has a grace period (0A) |
| `access.elevate_sensitive`, `support_access.grant` | R4, step-up, reason, time-box, notifications, audit |
| `retention.configure`, `legal_hold.manage` | R4, owner only, step-up |
