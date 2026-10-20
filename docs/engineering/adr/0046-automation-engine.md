# ADR-0046: Versioned, permission-safe automation engine (Phase 8A)

Status: **proposed** (implemented; candidate for architect review; not self-accepted).
Date: 2026-10-20. Brief P8-W1 (Phase 8A). Base: accepted P8-W0 head `0c25983` (`0c259833f0037e341f89c2221c6dee537ffd042b`, CI run 39234366133 attempt 1; the acceptance is recorded in ADR-0045). Migrations 0001–0061 unchanged; this adds `0062_automation_engine`.

## Context

Phase 0 reserved automations in every contract: the `auto` prefix and `automation_run` operation kind (0D), the `automation` principal and its intersection rule (0C), the automation entities (0B), and `automations.configure` and `automation.run_manual`. Phase 8A builds the engine on the platform that exists: PostgreSQL, the outbox with inbox receipts, the operation, job, attempt, and P8-W0 effect ledgers, the recurring-job scheduler, the canonical domain commands, the policy engine, 4B notifications, the 5D metric port, and the 7A AI gateway. It adds no broker, workflow service, retry engine, expression language, or executable user code.

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | One engine, definitions as data | An automation is a `core.record` extension (`auto_`) with an accountable owner and brand or workspace scope. Its definition is typed, schema-versioned data (trigger, nested AND/OR conditions, ordered steps, branches, bounded delays, explicit fallbacks). There are no expressions, SQL, scripts, or arbitrary HTTP. Workspace scope declares its brands; it is never all-brands authority. |
| D2 | Drafts and immutable revisions | Edits change only the draft (If-Match). Activation compiles the draft, checks permission, grantability, limits, availability, and outbound approvals, and selects an immutable revision (one per definition hash). A run pins its revision, owner, scope snapshot, trigger identity, and decisions. Duplicating creates a disabled draft owned by the duplicator, without approvals. Turning on again never replays events that happened before `activated_at`. |
| D3 | A typed compiler and action matrix | The compiler validates types, references, field names, graph acyclicity and reachability, depth, node, condition, and size caps, and action eligibility, at save (reported as draft issues) and at activation (refused). The per-record action matrix lists supported, unsupported (with the reason), and unavailable (with the owning phase) verbs. Unsupported configuration is refused, never ignored. |
| D4 | One evaluator, opaque hidden inputs | Preview and execution share one pure evaluator. The trigger record is loaded through the run principal; an input it cannot read now is `input_unavailable` (an opaque policy refusal), never false and never a branch hint. Decisions store bounded comparisons, not hidden values or event bodies. |
| D5 | Attribution and lineage | Writes inside a run carry the actor `automation` on behalf of the owner, with the run's operation as causation, derived centrally from the trusted execution context (`writeOutboxEvent`), never from a payload. The loop guard follows an event's causation to the run that caused it: a repeated automation or a chain deeper than `AUTOMATION_CHAIN_DEPTH_MAX` is a skipped run (`loop_guard`). Replays reuse the same run and spend nothing. |
| D6 | Fenced steps, durable delays | The `automation.run` job advances one `ctx.step` at a time; a succeeded step is recorded once per run and never rerun. Internal actions and step completion share a transaction (a savepoint isolates a refused step). A delay ends the attempt with `waiting`/`delay` and a stored wake time; a continuation job resumes it and re-checks owner, scope, and target. No sleeping worker, held transaction, or in-memory timer. Runs are unique per automation and trigger key, so redelivery and competing workers converge. |
| D7 | Finite technical limits | Sixteen registered parameters bound definitions, graphs, fan-out, chains, steps, concurrency, delays, retries, monthly runs, sweeps, and alerts. Slots and monthly runs are reserved atomically at admission and released or settled exactly once (`slot_held`, `usage_state`). Technical limits are not 10A plan entitlements; the usage view labels the plan limit unavailable. |
| D8 | Canonical commands in the worker | Steps call the existing task and project commands (`applyTaskChanges`, `setAssigneesIn`, `moveTaskIn`, `toggleLabel`, `archiveTaskIn`, `addRelationshipIn`, `insertTask`, project update, schedule, and `archiveProjectIn`), which keep custom workflows, required fields, optimistic versions, cross-brand rules, lifecycle, and approved-time locks. The worker role gains only the columns those commands write. No business-table writes in the automation module. |
| D9 | Webhooks through the effect ledger | A webhook step uses a configured 6B subscription (URL, secret, readiness, SSRF guard) and a per-step field allow-list, through the registered `unsafe` destination `automation.webhook` and the P8-W0 claim, typed proof, and fencing. An ambiguous send is never repeated: the run waits for `operation.reconcile_effect`. A fallback cannot handle `outcome_unknown`. |
| D10 | Standing outbound approval | Activation of a webhook step needs a human with `webhooks.manage`, a fresh step-up, and an approval of the exact revision, destination fingerprint, field set, scope hash, and action class (0C contract 9.4). A changed revision, destination, or scope ends it; send time re-checks it and the subscription. |
| D11 | The run principal | A run executes as its owner, narrowed to declared brands ∩ snapshot ∩ brands the owner can still configure, and to declared projects per target. Activation and reassignment require grantable authority of both the activator and the owner and refuse delegated callers. Owner departure or authority loss suspends the automation; history renders through the viewer's current access. |
| D12 | AI drafts through the gateway | `ai.draft` starts a 7A gateway run under the owner (`caller_kind` `automation`, privacy snapshot, hard budget reservation, confirmation thresholds). The output is a proposal for a person to review and apply (7D); an automation never approves or applies it. With AI off or no provider, the step refuses truthfully (`ai_*` codes as `unavailable`) with no spend. |
| D13 | Typed future boundaries | Test-result (9B) and agent-result (8C) triggers and the agent-workflow step (8C) compile as typed, unavailable nodes: a draft can hold them, activation refuses them with `dependency_unavailable` and the owning phase. No synthetic events or agent runner. |
| D14 | Retry, cancel, disable | Retry resumes a failed or refused run from its failed step under a new operation (`rerun_of`), at most `AUTOMATION_RETRIES_MAX` times, re-authorizing everything. A run is addressed by its first or current operation. Cancel and disable stop queued, running, and delayed runs before their next step; a run waiting for reconciliation keeps its liability. |
| D15 | Alerts and usage notices | Persistent failures notify the owner (`automation_failure`) once per interval, with the streak reset by a success. The notify action sends `automation_notice` to chosen people who can read the record. Monthly usage thresholds raise `metering.usage.threshold_reached` (meter `automation.runs`, NTF-006) through 4B. |
| D16 | Truthful outcomes and health | Statuses distinguish skipped, policy rejected, failed, cancelled, waiting (delay or reconciliation), partial, and succeeded. A fallback after a failure is partial; a retried step that later succeeds is not. The 5D port answers `automation.rates` (RPT-013) for what the viewer may see; health lists only automations whose brand the viewer configures or holds `health.view` in. Run history exports through the 6D boundary (`automation_history`, the DATA-013 portion 6D deferred to 8A) with the same current-access rendering. Unknown effects never count as success; agent rates stay separate (8C). |
| D17 | Lifecycle | Archive and trash stop open runs; restore leaves the automation off and replays nothing; purge removes history through the registered adapter. The ownership hook suspends on departure. |
| D18 | Surfaces | Automations navigation and palette routes, list with starter templates and usage, builder (trigger, conditions, steps, branches, delays, fallbacks), preview, activation with the disclosure dialog, and run pages with explanations, retry, cancel, and reconciliation (UXD-32). |

## Requirement and action matrix

| Requirement | 8A | Evidence |
|---|---|---|
| AUTO-001 | Trigger–condition–action automations | AT-552, AT-578, AT-580 |
| AUTO-002 | Five starter templates (10B owns the catalog) | AT-586, AT-578, AT-580 |
| AUTO-003 | Record, field, status, comment, approval, integration, date, schedule, manual triggers; test and agent results unavailable (9B, 8C) | AT-552, AT-576, AT-584, AT-572 |
| AUTO-004 | Nested AND/OR | AT-587, AT-554 |
| AUTO-005 | Task create, update, assign, move, label, notify, schedule, archive, relate; project update, notify, schedule, archive | AT-561, AT-562 |
| AUTO-006 | AI drafts through the gateway, proposals only | AT-571 |
| AUTO-007 | Typed agent-workflow boundary, refused (8C) | AT-572, AT-584 |
| AUTO-008 | Webhooks through configured subscriptions and the effect ledger | AT-567, AT-568, AT-569, AT-585 |
| AUTO-009 | Durable delays, scheduled triggers | AT-554, AT-576 |
| AUTO-010 | Branches and typed fallbacks | AT-554, AT-583 |
| AUTO-011 | Loop guard and chain bound | AT-555 |
| AUTO-012 | Preview with the same evaluator and policy | AT-575, AT-578 |
| AUTO-013 | Enable, disable, duplicate, versions | AT-553, AT-578 |
| AUTO-014 | Run history with inputs, outputs, durations, errors | AT-559, AT-580 |
| AUTO-015 | Safe retry from the failed step | AT-558, AT-563, AT-580 |
| AUTO-016 | Persistent-failure alerts | AT-573 |
| AUTO-017 | Atomic limits | AT-570 |
| AUTO-018 | Usage against technical limits; plan limit unavailable (10A) | AT-570, AT-580 |

| Record | Supported | Unsupported (reason) | Unavailable |
|---|---|---|---|
| Task | create, update, assign, move (same brand), label, notify, schedule, archive, relate, AI draft, webhook | — | agent workflow (8C) |
| Project | update, notify, schedule, archive, create a task in it, AI draft, webhook | create, assign, move, label, relate (each would change access or has no meaning) | agent workflow (8C) |

## Boundaries kept

- **9B, 8C:** test-result and agent-result triggers and agent workflows are refused at activation; nothing pretends a task assignment is an agent run.
- **10A:** usage is measured against technical limits; no plan, price, or entitlement is invented.
- **10B:** five starter templates only; no catalog or distribution.
- **Production AI:** unconfigured; verification uses the deterministic fixture. No live or paid call.
- **No exactly-once delivery:** an automation webhook is unsafe; the guarantee is no automatic duplicate after ambiguity plus authorized reconciliation (P8-W0).
- **Manual:** no new screen-reader claims; real-device and assistive-technology checks stay manual.
- **Hand-offs from earlier phases:** NTF-005 (4B) receives automation failure events (`automation.automation_run.failed` to `automation_failure`); DATA-013 (6D) gains the automation history export. Agent portions stay with 8B.
- **Follow-ups kept open:** REL-FU-P7-01 and TEST-FU-P7-02 (ADR-0045) are not claimed resolved. During 8A, one fully parallel local integration run on embedded PostgreSQL failed AT-519 and AT-520 (a plan reported stale between proposal and approval, so Apply never waited at the pause); the file passed three isolated runs and a second full run, and 8A adds no planning input or lock. It is recorded as another observation of TEST-FU-P7-02, not resolved.

## Evidence

| Test | File |
|---|---|
| AT-552–AT-555 | packages/work/test/integration/automations.test.ts |
| AT-556–AT-560 | packages/work/test/integration/automations-access.test.ts |
| AT-561–AT-563 | packages/work/test/integration/automations-actions.test.ts |
| AT-564–AT-566, AT-582–AT-588 | packages/work/test/unit/automation-definition.test.ts |
| AT-567–AT-569 | packages/work/test/integration/automations-effects.test.ts |
| AT-570–AT-577 | packages/work/test/integration/automations-platform.test.ts |
| AT-578, AT-579 | apps/api/test/integration/automations-api.test.ts |
| AT-580, AT-581 | e2e/automations.spec.ts |
| Component | apps/web/test/automations.test.tsx |

## Identifier reconciliation

| Kind | Identifier | Note |
|---|---|---|
| Migration | 0062 | `0062_automation_engine` |
| Engineering ADR | 0046 | This record |
| 0B / 0C / 0D / UX | ADR-51, AZ-51, PL-53, UXD-32 | Data, access, platform, and UX decisions |
| Threats | T-142–T-148 | Owner authority, revocation, inference, lineage, outbound effects, tenancy, staleness |
| Tests | AT-552–AT-588 | Above |
| Response types | `automations`, `automation_templates`, `automation_revisions`, `automation_preview`, `automation_run`, `automation_runs`, `automation_usage`, `automation_health` | Non-resource envelopes |
| Notification type | `automation_notice` | 4B |
| Effect destination | `automation.webhook` | `unsafe`, `automation-webhook.v1` |
