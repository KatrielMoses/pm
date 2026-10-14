# 9. AI, agent, automation, integration, token, and job delegation

**Principle (I-14):** an execution layer's access is always an **intersection** that can only shrink while it runs:

- a **snapshot** is recorded at start for audit and reproducibility;
- a **live recheck** runs at every step, tool call, or delivery for safety.

**Revocation wins over a historical snapshot.** Execution permissions (may this principal start this kind of execution?) are separate from record permissions (may it read or write these records?).

## 9.1 Common rules

| Rule | Detail |
|---|---|
| Start | Requires the execution permission (matrix: `ai.execute`, `agent.assign`, `automation.run_manual`, `integration.sync_now`, `import.execute`, `tests.execute`, …) **and** the record level on the targets |
| Snapshot | `scope_snapshot` stored with the operation: principals, epochs, the resolved brand/project sets, and the delegation chain |
| Live recheck | Before each read batch, write, tool call, or external effect, compare the current epochs with the snapshot's. If they differ, recompute the intersection. **Access never grows** beyond the snapshot: `current = min(snapshot, recomputed)`. |
| Lost access | If a required delegator lost access, the operation enters `waiting` with reason `authorization_changed` (agent run), the step fails with `policy_rejected` (automation, integration), or the operation is cancelled if the delegator was removed. Nothing is retried with broader authority. |
| Audit actor | `actor_type` is the layer (ai, agent, automation, integration, system), with `on_behalf_of` = initiating human or accountable owner, plus `operation_id` and `attempt_id` |
| Approvals | Gated action classes need a human approval decided at decision time ([10](10-approvals-separation-of-duties.md)). Execution layers can never approve (I-15). |
| Usage limits | Separate from authorization. A metering reservation precedes expensive steps (0B §9.3). |

## 9.2 AI actions

- **Scope** = initiating human's current access ∩ the explicitly selected context (workspace, brands, projects, records, include/exclude) ∩ the AI-eligible field allow-list.
- The context builder retrieves through the visibility predicate. Records outside the selected scope are excluded even if readable (AT-020). Hidden records never appear in context, citations, or "unknown" explanations (AT-019).
- Applying proposals (`ai.apply_proposal`) is a separate human action. **Each change is authorized as the applying human** at apply time, so a change targeting a record the human can no longer edit fails individually.
- Workspace privacy settings decide which providers may receive which classes of content (SEC-027). C3/C4 data never goes to providers except the user's own C3 data when explicitly required.

## 9.3 Agents

| Element | Rule |
|---|---|
| `agent_profile` grants | Explicit scope grants (brands, projects, records, integrations) and **tool-class grants**. Configuring them requires `agents.configure` **and** grantable authority over every scope and tool class granted (I-11). |
| Assignment | The assigner needs `agent.assign` (edit on the task + execution capability). The assignment stores the task, the context records chosen, constraints, and an optional narrower scope. |
| Run scope | **Profile grants ∩ assigner's access ∩ assignment scope**, snapshotted at run start (`agents.agent_run.run_scope`), and re-evaluated at **every tool call** against current epochs (UXD-11, DQ-05 resolved) |
| Tool invocation | Allowed iff the record level within the run scope is sufficient **and** the tool class is granted **and** the class's approval requirement is satisfied for this instance |
| Tool classes | 14 classes with risk and approval classes ([generated/permission-matrix.md](generated/permission-matrix.md#agent-tool-classes)). R3/R4 classes (external message, publish, spend, access change, destructive, production change, scope expansion) **always** require a human approval per instance (AGT-016/017). Low-impact classes run without per-action review only under the workspace low-impact policy (OD-23). |
| Scope expansion | An agent can never widen its own scope. A request to act outside the run scope becomes an `action_approval` of class `scope_expansion`. Approval creates a **new** assignment scope, evaluated by the approving human's authority. |
| Reviewers | Eligible reviewers of a run's output must be human, designated, and able to read the **entire run scope** (UXD-11), so reviewers never see output that references unreadable records |
| Self-approval | Agents can never decide reviews or approvals (AT-061). Completion is gated on human acceptance (0A lifecycle §3). |
| Confused deputy | Because the run scope includes the assigner's access, a low-privilege assigner cannot use a powerful agent to reach more data (AT-059). Profiles with wider grants exist to let **authorized** assigners delegate. They never lend access. |
| Emergency stop | `emergency_stop.trigger` (owner, administrator) moves all runs to `paused`/`cancelled` and blocks new tool calls immediately via an epoch bump on the agent principal class |
| External agents | The connector credential authenticates the external system as the run principal. The external agent can call the API or MCP tools only with a run-bound token whose scope equals the live run scope. The token expires when the run reaches a terminal state. |

## 9.5 OAuth and MCP clients (6E)

- A workspace registration declares the maximum 6B token scopes. A human member grants a subset and an optional brand allow-list; the resulting short-lived bearer token is workspace-bound and stored hash-only.
- Every MCP request resolves the active client, token, consent, and membership again. Existing workspace and record policy decisions still run at command execution, so revocation or lost access takes effect on the next call.
- Only the static versioned registry is discoverable. Tool descriptions, schemas, and resource names are metadata; they never add authority. Unregistered tools, resources, and inaccessible records return bounded opaque errors.
- Mutations require an idempotency key; destructive calls require explicit confirmation. Invocation records keep the tenant, actor label, consent/token references, registered name/version, outcome, and bounded duration, never request arguments or credentials.
- The 6E HTTP transport is stateless JSON request/response. It has no SSE stream or MCP task store. A timed-out or disconnected mutation may finish; clients use the same idempotency key to resolve its outcome.

## 9.4 Automations

- **Service principal:** each automation has an accountable owner, a declared scope (brands/projects; workspace automations list brands explicitly), and a declared action set.
- **Activation:** the activator needs `automations.configure` in that scope **and** grantable authority for every declared action in every declared scope (AUTO-013 versioning: each version is checked on activation).
- **Run access** = declared scope and actions ∩ accountable owner's **current** authority ∩ the **trigger record's** scope. A run triggered by a record outside the declared scope is `skipped`. A record that the triggering user can read is irrelevant: the viewer or trigger author never lends access.
- **Owner loses authority or leaves** → the automation is **suspended** (`suspended_reason = owner_authority`) until reassigned by someone with authority (AT-060).
- **Gated actions:** R3 actions (send webhooks, external integration actions, notify external parties) must be declared at activation by an owner with authority. That declaration is the standing approval. R4 actions are never available to automations.
- **Loop prevention and causation** (0B §7.6) do not affect authorization, but every step re-evaluates epochs.

## 9.5 Integrations and webhooks

| Direction | Rule |
|---|---|
| Inbound sync (provider → product) | Writes only into mapped brand/project scopes (`connection_mapping`). Items for unmapped resources stay in the connection's staging area, visible to connection managers only (0B §2). Writes are recorded with actor type `integration`. |
| Outbound sync and integration actions (product → provider) | Allowed only for records in the mapped scope **and** readable by the connection's accountable owner at send time, with fields from a per-destination allow-list. External disclosure is R3: configured by `integrations.configure` (step-up for the first enablement of outbound sync). |
| Provider scopes | Recorded on the connection. The product never requests broader provider scopes than the configured features need. |
| Inbound webhooks | Signature, timestamp tolerance, and replay dedupe (provider event ID) are verified before any processing. The endpoint can invoke exactly one configured intake action in one configured scope (AT-063/064). No read access. Responses carry no tenant data. |
| Outbound webhooks | Payloads are built per subscription with its scope and field allow-list, evaluated at **delivery** time. A subscription whose owner lost authority is suspended. Delivery is at least once with provider-dependent deduplication (approved decision). The receiver gets a stable event ID to deduplicate. |
| Connection owner leaves | The connection is paused (no outbound disclosure) until reassigned. Inbound processing into mapped scopes may continue only if the workspace policy allows it, and is audited. |

## 9.6 API tokens and OAuth clients

| Token | Rules |
|---|---|
| Personal | Scopes = action families (read, write per family), optional brand list, optional expiry (workspace maximum lifetime policy). Effective = **creator's current access ∩ scopes**. Write scopes require step-up at creation. Revoked on departure (AT-069). Rotation issues a new secret and revokes the old one after an optional overlap ≤ workspace maximum. |
| Service | Bound to a `service_principal` with explicit grants, created by `api_tokens.service.manage` with grants ≤ the creator's grantable authority. Live-checked against the accountable owner's authority. Suspended on owner departure. Expiry required. |
| OAuth / MCP client | User consent lists scopes. Effective = consenting user's current access ∩ consented scopes ∩ client registration scopes. Consent is revocable by the user and by admins. Tokens are short-lived with refresh, and refresh is denied after revocation. |

All tokens: hashes only, last-used tracking, `security_event` on creation, use from new contexts, and revocation.

## 9.7 Background jobs

- Every job row carries `workspace_id`, `effective_principal` (type + ID), `initiating_human`, `operation_id`, and the epochs at enqueue.
- **At execution, the job re-evaluates authorization** with the current epochs (AT-047). A job never runs with authority beyond its effective principal's current authority.
- **System jobs** (purge, retention sweeps, reindex, metric recompute, recurrence generation, outbox dispatch) run as `system_job` with a per-job-kind **capability allow-list**. Examples: reindex may read records to build `search_document` and nothing else. Purge may delete only batches marked eligible.
- Jobs that produce **user-visible output** (exports, reports, digests, briefings) are rendered **as the recipient**, never as the system.
- Cross-tenant iteration follows [12 §12.4](12-rls-and-application-policy.md#124-workers-and-cross-tenant-jobs).
