# 14. Usage, cost, limits, and entitlements (resolves DQ-16)

## 14.1 Meters

There are 14 registered meters ([generated/registries.md](generated/registries.md#meters)), named `<area>.<measure>`:

- AI: `ai.input_tokens`, `ai.output_tokens`, `ai.cost`;
- agents: `agent.runs`, `agent.runtime_seconds`, `agent.cost`;
- automations: `automation.runs`, `automation.steps`;
- platform: `storage.bytes` (gauge), `api.requests`, `webhook.deliveries`, `integration.sync_items`, `export.bytes`, `seats.active`.

New meters are additive registry entries.

## 14.2 Usage events

Internal schema `usage-event`, 0B `metering.usage_event` entity. Events are append-only and immutable.

| Field | Rule |
|---|---|
| `quantity` | Decimal string (no floats) with `unit` |
| `cost` | Money with **integer micros as a string** and an ISO 4217 currency, only for cost-bearing meters |
| `cost_basis` | `measured` (from provider usage), `estimated` (computed before or without provider data, labelled), `reported` (an external agent's self-report, OD-24). **Never summed across bases without labels.** |
| `occurred_at`, `period_start` | Business time, and the usage period it belongs to |
| `operation_id`, `attempt_id`, `sequence` | Attribution and natural-key dedupe `(operation, attempt, meter, sequence)`. Retried attempts meter real spend per attempt. Success-rate metrics count the logical outcome once (0B §9.6). |
| `brand_id`, `actor_type` | Attribution for brand reports (GOAL-011, RPT-012) |
| `correction_of` | Corrections are **new** events (negative or adjusting quantities) referencing the original. Originals are never edited. |

**Late-arriving usage:** if `period_start`'s period is still open, it is applied there. If closed, a correction event is recorded in the current period, referencing the closed period, and invoices show it as a correction.

## 14.3 Reservations, caps, warnings

1. **Estimate before expensive work** (public schema `usage-estimate`): `low`/`high` money range, `basis`, remaining allowance, hard limit, `would_exceed_hard_limit`, and `requires_confirmation` (0E ST-62). Shown before start.
2. **Reserve:** `metering.usage_reservation` holds the high estimate against `usage_balance` (row lock, 0B §9.3). Insufficient balance under a hard cap gives the `usage_limit_reached` error **before** any work.
3. **During execution:** each step checks the remaining reservation. Reaching the cap stops the step, and the operation ends `partial` or `failed` with `terminal_reason: limit_exceeded`. **Usage never silently exceeds a hard cap** (AI-035).
4. **Settle or release** on the terminal state: measured cost replaces the reservation, and the unused amount is released.
5. **Warnings:** crossing `USAGE_WARNING_THRESHOLDS` emits the `metering.usage.threshold_reached` event, which notifies owners (NTF-006). Reaching the limit emits the `metering.usage.limit_reached` event.
6. **Extra usage purchases** require explicit approval (`billing.manage` action, step-up; BILL-010).

## 14.4 Entitlements versus authorization

| | Entitlement | Authorization |
|---|---|---|
| Question | Does the plan include this capability or limit? | May this principal do this to this data? |
| Source | `billing.entitlement_grant` (plan, add-on, override, trial) | 0C effective-permission model |
| Effect | **Only removes** capabilities (I-13) | Grants and denies |
| Response | `entitlement_required` error, only for readable targets | `not_found` / `forbidden` |
| Decision record | Public schema `entitlement-decision`: `{key, available, limit?, used?, source, plan_version}` | — |

Both are evaluated server-side for every request. Clients may display entitlement decisions to explain unavailable features (IA "Upgrade" markers), and this is never a security boundary.
