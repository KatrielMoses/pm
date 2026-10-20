# ADR-0047: Agent profiles, connectors, and scoped task assignments (Phase 8B)

Status: **proposed** (implemented; candidate for architect review; not self-accepted).
Date: 2026-10-20. Brief P8-W2 (Phase 8B). Base: accepted Phase 8A head `802c026` (`802c0265ca2a40e50fc5fea35b866c895c00fe10`, CI run 39401581014 attempt 1; the acceptance is recorded in ADR-0046). Migrations 0001–0063 unchanged; this adds `0064_agent_profiles_connectors`.

## Context

Phase 0 reserved agents in every contract: the `agt` prefix and the `agents:execute` scope (0D), the `agent_profile`, `agent_run`, and `tool_invocation` principals with their intersection rules and the agent tool classes with risk and minimum approval (0C), the agent entities (0B), and the actions `agents.configure` and `agent.assign`. Phase 8B lets people configure agents and assign them to tasks. It does not run them: durable runs, run credentials, tool execution, progress, artifacts, and emergency stop are 8C; per-instance approval, review, and acceptance are 8D. Nothing here dispatches an assignment, mints a credential, or implies that a run exists.

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Profiles are records with a human owner | An agent profile is a `core.record` extension (`agt_`, workspace scope) with an accountable human owner, a kind (`internal` uses the 7A gateway; `external` uses a connector) fixed at creation, name and purpose, lifecycle, optimistic versions, and audit. No membership, account, or token represents an agent. |
| D2 | Typed draft, immutable revisions | Configuration is typed, schema-versioned, bounded data (instructions, model reference, limits, tools, scope, approval policy) compiled canonically. Edits change only the draft; activation selects an immutable revision (one per configuration hash) with relational scope and tool grants. Assignments pin a revision, so editing a profile never broadens them. |
| D3 | Explicit scope; empty means nothing | Scope names brands, projects, records (tasks, projects, documents), and integrations by public id. An empty scope grants nothing, never all; workspace visibility of a profile is not permission to use workspace records. A selected project follows containment; a selected integration or relationship never grants the records behind it. |
| D4 | Registered, versioned tools only | Tools come from `agent-tools.json` (generated into `tool-registry.ts`): each names a version, a 0C tool class, and a description. No arbitrary HTTP, scripts, SQL, unregistered MCP tools, or model-supplied names. Tools owned by later phases (`pm.tests.run` 9B, `github.pull_requests.open` 9A) are listed and refused. |
| D5 | Approvals only stricter | The class fixes the risk and minimum approval; a profile may require more, never less. R3 and R4 always need a per-instance human approval (8D). Automation standing approval does not transfer to an agent. Until 8D, execution is unavailable rather than inferring low-impact authority. |
| D6 | Grantability for configurer and owner | Configuration and reassignment need `agents.configure` (owners and administrators; members only by the `members_configure_agents` policy). At activation and reassignment the configurer and the owner must each hold, on every scope item, the level the granted classes need (`read_records` view; R0/R1 writes edit; others manage). |
| D7 | Session-only configuration | Every profile and connector command refuses delegated callers at service entry, before any idempotency work, and in every replay renderer; the bearer gate refuses tokens on `/agents`, `/agent-templates`, and `/agent-tools`. An agent cannot configure itself, grant access, alter policy, or approve its own actions. |
| D8 | Five starter templates | Development, research, growth, documentation, and testing templates instantiate turned-off drafts with conservative R0/R1 tools, limits, stricter approvals, an empty scope, and the missing configuration named. Duplication copies the draft only: no connector, credential, standing approval, revision, or grant. 10B owns the later catalog. |
| D9 | Departure, authority loss, lifecycle | A departing owner suspends the profile (`owner_departed`). An owner who can no longer grant the active revision's scope makes it not ready (`owner_authority`), decided on every read. Archive, trash, and disconnect stop use and destroy the connector secret; restore and unarchive come back disabled. Purge uses the registered lifecycle adapter and refuses while a secret reference remains. |
| D10 | Connector kinds on existing foundations | External connectors are `api` (bearer secret from the secret store), `webhook` (6B signature scheme; a `whs_` signing secret shown once), and `mcp` (JSON-RPC `initialize` at `2025-11-25`). The product's own API and MCP endpoints and its own credentials (`pm_`, `hk_`, `oac_`, `pma_`) are refused; a personal token is not an agent credential. |
| D11 | Guarded, bounded handshakes | Endpoints use the existing URL controls: https only, no private, loopback (except the local fixture transport), link-local, or metadata ranges, no credentials in the URL, never the product's origin. Redirects are refused; answers are bounded by size and time (more is refused, never truncated); errors are typed codes without peer content. |
| D12 | A test is a separate confirmed operation | `POST …/connector:test` needs `{ "confirm": true }`, a configurer, and the hourly limit; it creates an `agent_connector_test` operation. The worker re-decides authority and the connector immediately before the request (effect destination `agents.connector_test`), sends only the protocol, version, and a nonce, and binds the result to the settings version it prepared; a change in between makes it `stale`. A pass proves protocol compatibility only. |
| D13 | Capabilities are metadata | The manifest must name protocol `pm-agent/1`, version `1`, and the nonce. Advertised tools are intersected with the registry and the revision's grants; unknown protocols, versions, and unregistered tools are refused or ignored without widening anything. A peer chooses no membership, workspace, or delegation. |
| D14 | Truthful states; production blocked | Connector states are configured, verified, stale, revoked, and unavailable (and not configured). Without `AGENT_CONNECTOR_TRANSPORT=fixture` tests are `dependency_unavailable`; the fixture is refused when deployed. Fixture verification is labelled synthetic and never marks a live connector verified; live connectors are blocked until an approved secret store and credentials exist (DQ-28). Internal profiles use the gateway's current model availability. |
| D15 | Assignment is a separate relationship | `agent_assignment` belongs to the task, separate from human assignees, needs `agent.assign` (edit, no shares), and never changes task status. One active assignment per task and profile, with idempotent keys and a per-task limit under the task lock. States are assigned and withdrawn; blocked is derived. |
| D16 | Structured brief and an only-narrowing ceiling | An immutable assignment revision holds the goal, constraints, deliverable, criteria, context references (never copied content), the pinned profile revision, the assigner, and the stored ceiling = pinned grants ∩ assigner access ∩ explicit scope ∩ owner authority. Every read, edit, and readiness check narrows it again; widening needs a new authorized revision. A structured preview names what is included and refuses the rest in the caller's own terms. |
| D17 | No leaks through the task panel | Task readers see the agent's name and kind, the brief, and only the context and scope items they can open (others counted); never instructions, grants, connector details, or unreadable titles. Unknown and hidden identifiers are one answer. |
| D18 | Execution refused; the 8C contract published | `POST /tasks/{tsk}/agents/{agt}:run` is refused (`dependency_unavailable`) and the UI says "Assigned; execution available in Phase 8C". 8C will issue a run-bound, narrowing, revocable credential scoped to the assignment's current ceiling, the pinned tools, and one run, and dispatch through the same protocol and effect boundary (PL-54). 8B mints nothing and sends no assignment. |
| D19 | Finite limits under concurrency | Profiles per workspace (an advisory lock), assignments per task (the task lock), scope and tool grants, context references, criteria, text and configuration sizes, connector timeouts, response bytes, and tests per hour are technical limits with finite defaults and hard maximums, separate from 10A plan entitlements. |

## Requirement matrix

| Requirement | Disposition | Evidence |
|---|---|---|
| AGT-001, AGT-002 | implemented | profiles, typed configuration, revisions (AT-595–AT-597, AT-620) |
| AGT-003, AGT-004, TSK-008 | implemented (execution 8C) | assignments with structured brief and preview (AT-608–AT-614, AT-628) |
| AGT-005, PERM-008 | implemented | explicit scope, tool grants separate from human permissions, grantability (AT-598, AT-611, AT-615) |
| AGT-006 | implemented (runtime 8C) | internal profiles on the gateway's availability (AT-630) |
| AGT-007 | implemented (runtime 8C) | API, webhook, and MCP connectors with real handshakes against fixture peers (AT-601–AT-607) |
| AGT-008 | implemented (catalog 10B) | five starter templates (AT-595, AT-622) |
| ONB-013, LA-008 | contributed | agent templates; assignment to one connected agent (runs in 8C) |

## Boundaries kept

- **8C:** runs, run credentials, tool calls, progress, artifacts, emergency stop, and dispatch to connectors; the run endpoint refuses.
- **8D:** per-instance approval, review, and acceptance; R3/R4 stay human-approved and execution unavailable until then.
- **10A:** limits are technical; no plan, price, or entitlement is invented.
- **10B:** five starter templates only; no catalog or distribution.
- **Production connectors:** blocked until an approved secret store and credentials exist (DQ-28); only the synthetic local fixture is tested.
- **Production AI:** unconfigured; internal readiness is verified against the deterministic fixture. No live or paid call.
- **Manual:** no new screen-reader or live-agent claims; real-device and assistive-technology checks stay manual.
- **Follow-ups kept open:** REL-FU-P7-01 and TEST-FU-P7-02 (ADR-0045) are not claimed resolved. The 8A and P8-W0 dispatch, replay, and uncertainty regressions stay in the suite unchanged.

## Evidence

| Test | File |
|---|---|
| AT-595–AT-600, AT-630, AT-631 | packages/work/test/integration/agents.test.ts |
| AT-601–AT-607 | packages/work/test/integration/agents-connectors.test.ts |
| AT-608–AT-614 | packages/work/test/integration/agents-assignments.test.ts |
| AT-615–AT-619 | packages/work/test/integration/agents-access.test.ts |
| AT-620–AT-624 | packages/work/test/unit/agent-config.test.ts |
| AT-625–AT-629 | apps/api/test/integration/agents-api.test.ts |
| AT-632, AT-633 | e2e/agents.spec.ts |
| Component | apps/web/test/agents.test.tsx |
| Query plans at volume (2,000 profiles, 5,000 assignments, 20,000 grants) | packages/work/test/integration/agents-volume.test.ts (EXPLAIN) |
| Migration boundary 0064 and its guarded rollback | packages/db/test/integration/migrations.test.ts |

## Identifier reconciliation

| Kind | Identifier | Note |
|---|---|---|
| Migration | 0064 | `0064_agent_profiles_connectors` |
| Engineering ADR | 0047 | This record |
| 0B / 0C / 0D / UX | ADR-52, AZ-52, PL-54, UXD-33 | Data, access, platform, and UX decisions |
| Threats | T-152–T-161 | Grantability, tool and approval injection, silent widening, confused deputy, delegated configuration, task-panel inference, malicious connectors, stale tests, departure, limits and invented readiness |
| Tests | AT-595–AT-633 | Above |
| Operation kind | `agent_connector_test` | Detail `agents.agent_connector_test` |
| Response types | `agent_profiles`, `agent_templates`, `agent_tools`, `agent_profile_revisions`, `agent_connector_test`, `agent_assignment_preview`, `agent_assignment`, `agent_assignments` | Non-resource envelopes |
| Effect destination | `agents.connector_test` | `naturally_idempotent` |
