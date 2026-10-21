# Agent runs (Phase 8C): implementation and operator notes

Engineering record: [ADR-0048](adr/0048-durable-agent-runs.md). Closure: [phase8/closure-8c.json](phase8/closure-8c.json), checked by `tools/phase8c.py`. Data: [database.md](database.md#phase-8c-agent-runs). Profiles, connectors, and assignments: [agents.md](agents.md).

A run executes one assigned agent on one task and returns draft output for a person to review. It never changes the task's status and never accepts anything: per-action approval, review, acceptance, and deliverable promotion are 8D.

## Lifecycle

- **Start.** On the task, a person with `agent.run_control` previews the run (`GET …/agent-run-preview?profile=`: scope, tools and whether each runs or needs approval, limits, cost basis, refusals) and starts it (`POST /tasks/{tsk}/agents/{agt}:run`; an internal agent needs `{ "confirm": true }` for its gateway cost). Admission re-decides eligibility, readiness, the emergency stop, and `AGENT_RUNS_ACTIVE_MAX`, and pins the revisions, ceiling, tools, limits, and deadline. One open run per task and agent.
- **Automations.** The 8A `agent.invoke` step admits a run through the same path as the automation owner; the `agent.result` trigger fires when a run returns output.
- **Execution.** The `agents.run` job (queue `agents`) decides authority again in a step keyed per attempt, then:
  - **internal:** reads its own task through the granted read tool and requests one gateway model turn (`agent_task_draft`); its output becomes the `draft` artifact.
  - **external:** dispatches through `agents.run_dispatch` (unsafe) with a fresh run credential and waits for the agent's callbacks until the deadline.
- **States.** Queued, Running, Waiting (paused, authorization changed, approval, reconciliation required, …), Failed, Cancelled, Ready for review. They are derived from the operation; `accepted` never appears.
- **Controls.** `POST /agent-runs/{run}:pause|:resume|:cancel|:retry`, each decided against current authority and audited. Retry links a new operation and keeps the counters and deadline, up to `AGENT_RUN_RETRIES_MAX`. Withdrawing the assignment ends its open runs as a cancel does.

## External agents

- The dispatch (`agent.run.dispatch`, `pm-agent/1`) carries the run and attempt, the brief, the pinned tools, callback URLs under `PUBLIC_BASE_URL`, and the credential. External runs refuse admission (`callback_unavailable`) when no public base URL is configured, and (`connector_transport_unavailable`) without a connector transport.
- **Credential.** `par_` + 40 characters, shown only in the dispatch, stored as a hash, valid until the earlier of `AGENT_RUN_CREDENTIAL_TTL_SECONDS` and the deadline. It reaches only `GET /agent-runs/{run}/context`, `POST /agent-runs/{run}/events|tools|artifacts|result`, and the run tools on `POST /mcp`. It stops at once on pause, waiting for a person, cancel, the emergency stop, withdrawal, and end; the agent then gets `run_unavailable` or not-found.
- **Callbacks** carry an idempotency `key`; a repeated key changes nothing. Progress and commentary are notes. The result needs every named artifact (and one when the assignment expects a deliverable); a late or overlapping result settles nothing twice.
- **Unknown dispatch.** If a worker dies after claiming or sending, the run waits as `reconciliation_required`. An owner decides through the P8-W0 effect reconciliation (`POST /operations/{op}/effects/{key}:reconcile` with step-up: sent, retry, abandon; there is no agent-run control for it in the web app yet); nothing is resent automatically, callbacks are refused until then, and cancel is refused until the outcome is known.

## Tools

Only `read_records` tools with approval `none` execute (`pm.tasks.get`, `pm.tasks.list`, `pm.documents.get`), as the assigner within the ceiling and the owner's access. Every other granted tool is recorded as `approval_required` and changes nothing. Unknown tools and targets outside the ceiling answer not-found.

| Decision | Code | Meaning |
|---|---|---|
| `executed` | — | The read ran |
| `approval_required` | `approval_required` | A change that needs a person's approval (8D); nothing changed |
| `refused` | `not_available`, `authorization_changed`, `paused`, `emergency_stop` | Not granted, outside the ceiling, or the run cannot act now |
| `unavailable` | `tool_unavailable` | A registered tool owned by a later phase |
| `limit_reached` | `limit_reached` | The run's tool call limit |

## Refusals and failures

| Code | Where | Meaning |
|---|---|---|
| `run_in_progress` | start | The agent already has an open run on this task |
| `limit_reached` | start, callbacks | Open runs, retries, tool calls, artifacts, output bytes, events, or the deadline |
| `emergency_stop` | start, tools | Agent work is stopped in the workspace |
| `deliverable_missing`, `artifact_missing` | result | The result names no artifact, or one that was not returned |
| `unsupported_media_type` | artifact | Only Markdown, plain text, and JSON |
| `run_unavailable` | callbacks | Paused, waiting, ended, or waiting for reconciliation |
| `reconciliation_required` | cancel | Decide the unknown dispatch first |
| `limit_exceeded` | failure | The deadline passed |
| `agent_reported_failure` | failure | The agent's result said it failed |
| `assignment_withdrawn` | cancel detail | The assignment was withdrawn while the run was open |

## Emergency stop and health

- `POST /agent-emergency-stop` (owners and administrators, session only; optional `reason`) pauses every open run and revokes every run credential in one transaction. While stopped, starts, dispatches, tool calls, and callbacks refuse. `POST /agent-emergency-stop/restart` allows runs again; paused runs stay paused until each is resumed.
- `GET /agent-health`: open and recent (30 days) runs by state and the stop's status. Tokens can never stop, restart, or read health.

## Progress

`GET /agent-runs/{run}/events?after={cursor}&wait={seconds}` returns up to 100 events after the cursor, waiting at most `AGENT_RUN_POLL_WAIT_SECONDS`. Each check is its own transaction that decides access again, so a person who loses access stops seeing progress on the next check. The web app reconnects with backoff and says so.

## Costs

Internal runs: usage measured by the AI gateway within its budget. External runs: any cost the agent reports is stored and shown as "reported by {agent}", never as measured (OD-24).

## Limits

`AGENT_RUNS_ACTIVE_MAX` (under a workspace lock), `AGENT_RUN_RETRIES_MAX`, `AGENT_RUN_EVENTS_MAX`, `AGENT_RUN_EVENT_TEXT_MAX_CHARS`, `AGENT_ARTIFACT_MAX_BYTES`, `AGENT_RUN_OUTPUT_MAX_BYTES`, `AGENT_RUN_CREDENTIAL_TTL_SECONDS`, and `AGENT_RUN_POLL_WAIT_SECONDS`, with the profile's own runtime, tool call, and artifact limits. See [environments.md](environments.md).

## Not in 8C

Per-action approval, review, acceptance, and deliverable promotion (8D); live connectors (DQ-28); production AI; plan entitlements (10A).
