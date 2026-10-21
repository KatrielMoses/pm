# ADR-0048: Durable, bounded agent runs (Phase 8C)

Status: **proposed** (implemented; candidate for architect review; not self-accepted; not production approval: live connectors stay blocked (DQ-28), production AI stays unconfigured, and per-instance approval, review, and acceptance are 8D).
Date: 2026-10-21. Brief P8-W3 (Phase 8C). Base: accepted Phase 8B head `e51b3f1` (`e51b3f19ecf215e296d08c12c14649a4e1b2565d`, CI run 39502523692 attempt 1; the acceptance is recorded in ADR-0047). Migrations 0001–0064 unchanged; this adds `0065_agent_runs`.

## Context

Phase 8B lets people configure agents and assign them to tasks, and published the contract 8C must honour: call the shared assignment eligibility immediately before issuing a run credential or dispatching, act only within the live ceiling and the pinned tools, and use a run-bound, narrowing, revocable credential (ADR-0047 D18). Phase 8C runs agents on the existing platform: operations, jobs, checkpointed steps, the effect ledger with reconciliation, the outbox, the 7A gateway, and the 8B connector protocol. It does not approve, review, or accept anything: those are 8D.

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | A run is an operation | Each run is an `agent_run` operation (its public id is the run id) with a detail row `agents.agent_run`. The operation is the one authority for state; a retry links a new operation to the same logical run (`current_operation_id`), keeping the counters and the deadline. |
| D2 | One state table, no stored state | The run state is derived from the current operation by one table (`run-states.ts`): queued; running (including waiting for the agent's or the model's own answer); waiting with its reason (paused, authorization changed, approval, reconciliation required, rate limit, dependency unavailable, delay, input); failed (failed, partial, skipped); cancelled; ready for review (succeeded). `accepted` is never produced: it is reserved for a real 8D decision. |
| D3 | Admission pins everything | Starting a run (`agent.run_control`, or an automation's `agent.invoke` as its owner) re-decides the 8B shared eligibility, the profile's readiness, the emergency stop, and the open-run limit under a workspace lock, then pins the assignment and profile revisions, the instructions hash, the live ceiling, the granted tools, the limits, the deadline, and the connector settings version or model. One open run per task and agent (a partial unique index); a replayed start key returns the same run. |
| D4 | Live authority everywhere | Before the dispatch, every tool call, and every callback, authority is decided again: pinned ceiling ∩ current assignment and profile grants ∩ the assigner's and owner's current access, plus the connector's settings version. A loss holds the run as waiting for authority (a withdrawal ends it); its credential stops at once. A later grant never broadens a run in flight. |
| D5 | Run-bound credentials | An external agent receives a `par_` credential per dispatch: 40 random base62 characters, stored as a prefix and a SHA-256 hash only (never in a checkpoint or log), valid for one run and its current operation until the earlier of `AGENT_RUN_CREDENTIAL_TTL_SECONDS` and the deadline. It is revoked on pause, waiting for a person, cancel, the emergency stop, withdrawal, and end. It authenticates as a delegation of kind `agent_run` with no scopes and reaches only that run's context, events, tools, artifacts, and result routes and the MCP run tools; anything else is the canonical not-found answer. |
| D6 | Only R0 reads execute | Tools resolve through the registry and the run's pinned grants. Only `read_records` tools with approval `none` (`pm.tasks.get`, `pm.tasks.list`, `pm.documents.get`) execute, as the assigner, within the ceiling and the owner's access. Every other class is recorded as `approval_required` and changes nothing (8D owns approval). Unregistered tools and targets outside the ceiling are the same answer as unknown ones. Calls are recorded without targets or results. |
| D7 | Internal agents through the gateway | An internal run requests one model turn (`agent_task_draft`) through the 7A gateway under the run principal (`caller_kind` `agent`), with its budget, cost confirmation, privacy, and availability. Its output becomes a draft artifact; usage is measured by the gateway. AI off or unconfigured refuses admission truthfully. A redelivered job never starts a second turn. |
| D8 | External agents through the connector protocol | The dispatch (`agent.run.dispatch`, `pm-agent/1`) carries the run and attempt, the brief, the pinned tools, the callback URLs, and the credential, through the effect destination `agents.run_dispatch` (unsafe): a refusal before any request is not sent; anything after it is sent or unknown. An unknown outcome waits for an owner's reconciliation and is never resent automatically; a confirmed send continues the same run with the credential already sent. The dispatch key includes a generation bumped only by an explicit resume. |
| D9 | Progress is notes, never completion | Events have a per-run sequence and bounded text. Agent progress, commentary, acknowledgments, transport ends, and provider statuses never complete anything. People follow progress by the established bounded long poll: each check is its own transaction that decides access again; the wait is capped; there is no held authorized connection. |
| D10 | Results and artifacts are drafts | The agent's result needs every named artifact (and one when the assignment expects a deliverable); a completed result settles the run as ready for review exactly once. Artifacts are Markdown, plain text, or JSON, SHA-256 checked, versioned by key, bounded per version and per run, and immutable. Nothing is accepted, no deliverable is promoted, and the task's status never changes (8D). |
| D11 | Controls decided now | Pause (revokes the credential; the next step stops), resume (re-decides authority; a fresh dispatch with a new credential), cancel (terminal; reports what may already have left; late callbacks refused; refused while an outcome is unknown), and retry (a linked operation, the same counters and deadline, up to `AGENT_RUN_RETRIES_MAX`) are each decided against current authority and audited. |
| D12 | Limits and costs | Open runs per workspace, retries, tool calls, artifacts, output bytes, events, event text, the deadline, and the credential lifetime are technical limits with finite defaults and hard maximums. Measured cost comes from the gateway. An external agent's reported cost is stored and shown labelled "reported by {agent}", never as measured (OD-24). |
| D13 | Emergency stop | `POST /agent-emergency-stop` (owners and administrators, `emergency_stop.trigger`, session only) pauses every open run and revokes every run credential in one transaction and records an epoch. While stopped, admissions, dispatches, tool calls, and callbacks refuse. Restart records a new epoch and leaves runs paused until each is resumed under current authority. |
| D14 | Reporting through existing ports | Outcomes publish `agents.agent_run.output_returned` and `agents.agent_run.failed` once, with the automation causation when an automation invoked the run. The 5D metric `agent.rates` (agent run outcomes, apart from automation rates), 7E briefing facts (runs ready for review per viewer), 4B notifications (`agent_output_ready`, `agent_failure`), and ADM-010 health (open and recent runs by state) read only what the viewer may read. |
| D15 | Automations invoke agents | The 8A `agent.invoke` step admits a run through D3 as the automation owner (`agent.assign` and an existing assignment); its success means the run was admitted, never that the agent finished. The `agent.result` trigger fires on `output_returned`; the 8A loop guard sees the causation. |
| D16 | Withdrawal and purge | Withdrawing an assignment ends its open runs as a cancel does and revokes their credentials at once (an unknown dispatch still waits for reconciliation). Task purge removes runs with their events, tool calls, artifacts, and credentials. |
| D17 | Platform extension | A job may return `waiting` without `resumeAt` for `authorization_changed` and `approval`, and `paused`, which pauses its operation; `delay` and `external_confirmation` still need `resumeAt`. The automation engine's waiting rehydration only follows waits that have a `resumeAt`. |

## Requirement matrix

| Requirement | Disposition | Evidence |
|---|---|---|
| AGT-009 | implemented | queue, start, pause, resume, cancel, retry (AT-643, AT-645–AT-647, AT-664, AT-665) |
| AGT-010 | implemented (accepted 8D) | every state but accepted, derived by one table; ready for review is never accepted (AT-643, AT-644, AT-650, AT-664) |
| AGT-011 | implemented | bounded progress, notes never completion, long poll with reconnect (AT-643, AT-661, AT-664, component) |
| AGT-012 | implemented | pins, tool calls, artifacts, errors, time, measured and reported cost (AT-643, AT-644, AT-652) |
| AGT-013 | implemented (promotion 8D) | draft artifacts returned to the run on the originating task (AT-643, AT-644, AT-664) |
| AGT-022 | implemented (acceptance 8D) | failed, partial, and finished runs never change the task (AT-643, AT-646, AT-664) |
| AGT-023 | implemented | one open run, keyed steps, unknown dispatch never resent, settle once (AT-650, AT-653–AT-656) |
| AGT-024 | implemented | runtime deadline, tool call, artifact, output, event, retry, and open-run limits; gateway token and cost budgets (AT-644, AT-647, AT-652, AT-667) |
| AGT-025 | implemented | emergency stop and restart (AT-651, AT-663, AT-665) |
| AGT-026 | implemented | audit of every control and the stop; tool-call and event history (AT-645–AT-651) |
| BRF-010 | contributed | real agent-run facts in briefings per viewer (AT-658) |
| AUTO-007 | contributed | automations invoke agents and react to results (AT-657) |
| RPT-013 | contributed | `agent.rates` apart from automation rates (AT-658) |
| AUD-008 | contributed | run history retained with its task and purged with it (AT-660) |
| REL-006 | contributed | failures notified to the people involved (AT-658) |
| ADM-010 | contributed | agent health for owners and administrators (AT-651, AT-663, AT-665) |
| LA-008 | contributed | a founder delegates a task to one connected agent and gets a draft back (AT-643, AT-664) |
| LA-017 | contributed | failed runs are shown failed, never successful (AT-646, AT-658, AT-667) |

## Boundaries kept

- **8D:** per-instance approval, review, acceptance, and deliverable promotion; every non-R0 tool waits as `approval_required`; no accept control exists.
- **Production connectors:** blocked until an approved secret store and credentials exist (DQ-28); dispatch is exercised only against the synthetic local fixture (`AGENT_CONNECTOR_TRANSPORT=fixture`, refused when deployed).
- **Production AI:** unconfigured; internal runs use the deterministic fixture provider. No live or paid call.
- **10A:** limits are technical; no plan, price, or entitlement is invented.
- **Manual:** no screen-reader, real-device, or live-agent claims.
- **Reconciliation UI:** an unknown dispatch is decided through the P8-W0 effect reconciliation endpoint (step-up); the web app explains the wait but has no agent-run control for it yet.
- **Follow-ups kept open:** REL-FU-P7-01 and TEST-FU-P7-02 (ADR-0045) are not claimed resolved; the P8-W0, 8A, and 8B regressions stay in the suite unchanged, and 0063's no-pre-correction-worker restriction stands.

## Evidence

| Test | File |
|---|---|
| AT-643, AT-644 | packages/work/test/integration/agents-runs.test.ts |
| AT-645–AT-653 | packages/work/test/integration/agents-runs-control.test.ts |
| AT-654–AT-656 | packages/work/test/integration/agents-runs-recovery.test.ts |
| AT-657–AT-660, AT-666, AT-667 | packages/work/test/integration/agents-runs-platform.test.ts |
| AT-661–AT-663 | apps/api/test/integration/agents-runs-api.test.ts |
| AT-664, AT-665 | e2e/agents.spec.ts |
| Component | apps/web/test/agents.test.tsx (Agent runs (8C)) |
| Query plans at volume (10,000 runs, 50,000 events, 10,000 credentials) | packages/work/test/integration/agents-volume.test.ts (EXPLAIN) |
| Migration boundary 0065 and its guarded rollback | packages/db/test/integration/migrations.test.ts |

## Identifier reconciliation

| Kind | Identifier | Note |
|---|---|---|
| Migration | 0065 | `0065_agent_runs` |
| Engineering ADR | 0048 | This record |
| 0B / 0C / 0D / UX | ADR-53, AZ-53, PL-55, UXD-34 | Data, access, platform, and UX decisions |
| Threats | T-164–T-173 | In-flight widening, stale dispatch, credential misuse, claimed completion, unapproved writes, duplicates, inference, limits, the stop, escalation |
| Tests | AT-643–AT-667 | Above |
| Operation kind | `agent_run` | Detail `agents.agent_run` (reserved by 0D) |
| Job and consumer | `agents.run` on `agents`; `agents.runs` | The run job and the outcome consumer |
| Effect destination | `agents.run_dispatch` | `unsafe` |
| Response types | `agent_run`, `agent_runs`, `agent_run_preview`, `agent_run_events`, `agent_artifact`, `agent_run_context`, `agent_run_event_receipt`, `agent_tool_result`, `agent_artifact_receipt`, `agent_run_result_receipt`, `agent_health`, `agent_emergency_stop` | Non-resource envelopes |
| AI action | `agent_task_draft` v1 | Gateway catalog |
