# Automations (Phase 8A): implementation and operator notes

Engineering record: [ADR-0046](adr/0046-automation-engine.md). Closure: [phase8/closure-8a.json](phase8/closure-8a.json), checked by `tools/phase8a.py`. Data: [database.md](database.md#phase-8a-automation-engine).

## How a run happens

1. A committed outbox event reaches the `automation.triggers` consumer. Only automations whose `trigger_event` matches, that are enabled, and that were activated before the event happened are considered (at most `AUTOMATION_TRIGGER_FANOUT_MAX` per event).
2. Admission, in one transaction: the trigger filters, the declared brands, the loop guard (the event's causation leads to the run that caused it; a repeated automation or a chain deeper than `AUTOMATION_CHAIN_DEPTH_MAX` is recorded as a skipped run), the run slot (`AUTOMATION_ACTIVE_RUNS_MAX`), and the month's reservation (`AUTOMATION_RUNS_PER_MONTH`). The run row is unique per automation and trigger key, so a redelivered event or a second worker converges on the same run.
3. The `automation.run` job on the `automation` queue advances one fenced step at a time: conditions, then each step. Actions run the canonical task and project commands as the automation on behalf of its owner, inside the step's transaction. A delay ends the attempt as `waiting`/`delay` with the wake time stored; a continuation job resumes it, re-checking the owner, scope, and target.
4. The `automation.outcomes` consumer settles the run once: slot released, usage settled or released, failure streak, and an `automation_failure` notification to the owner after `AUTOMATION_ALERT_FAILURE_THRESHOLD` failures in a row, at most once per `AUTOMATION_ALERT_INTERVAL_MINUTES`.

Date and schedule triggers come from the `automation.sweep` job (every minute; `AUTOMATION_SWEEP_BATCH_MAX` bounds both the workspaces visited and the due triggers taken per workspace) using the one recurrence parser and the trigger's IANA zone. Each occurrence has a stable local key, so a repeated sweep admits nothing twice.

## Statuses

| Status | Meaning |
|---|---|
| `queued`, `running` | Admitted; steps are running or about to |
| `waiting` | A delay (`wake_at`) or a send whose outcome is unknown (`reconciliation_required`) |
| `succeeded` | Every step that ran succeeded (a retried step counts once it succeeds) |
| `partial` | A fallback ran after a failed step; never reported as success |
| `failed` | A step failed with no fallback for its failure class |
| `policy_rejected` | The owner's authority or the scope no longer allowed the run |
| `skipped` | Conditions not met, the loop guard, or a bounded fan-out; nothing ran |
| `cancelled` | Stopped by a person, by turning the automation off, or by abandoning an unknown send |

Unknown external outcomes never count as success in usage, metrics (`automation.rates`), or health.

## Operating it

- **Turning off** stops new runs and cancels queued, running, and delayed runs before their next step. A run waiting for a send to be confirmed keeps waiting: its liability is not erased.
- **Unknown sends.** An automation webhook is an `unsafe` destination: an ambiguous send is never repeated automatically. An owner or administrator confirms it through the operation routes (`operation.reconcile_effect`, step-up): "It was received", "Send it again", or "Stop this run". The run continues or ends accordingly.
- **Retry** resumes a failed or refused run from its failed step under a new operation (at most `AUTOMATION_RETRIES_MAX`). Succeeded steps are not run again; usage is not charged again.
- **Suspension.** An owner who leaves the workspace or loses configuration authority in a declared brand suspends the automation. Assign a new owner (`:reassign`, which leaves it off) and turn it on again.
- **Limits** are technical configuration, not plan entitlements. Their defaults and hard maximums are in [environments.md](environments.md) and the 0D registry. The usage page shows measured runs against them and labels the plan limit unavailable (10A).
- **Telemetry:** `automation.runs` with the `outcome` label only. Logs carry identifiers, never titles, bodies, field values, or webhook payloads.

## Not in 8A

Test-result triggers (9B), agent-result triggers and agent workflows (8C), plan entitlements (10A), and a template catalog (10B) are typed, refused boundaries: they can be saved in a draft and are refused at activation, with the owning phase named. No production AI or live provider is configured; AI draft steps use the 7A gateway and refuse truthfully when AI is off.
