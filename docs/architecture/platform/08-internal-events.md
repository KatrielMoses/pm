# 8. Internal event contract (resolves DQ-13)

Internal events are **facts**, written to the transactional outbox (0B `execution.outbox_event` entity) in the same transaction as the change. They are not a public API: public webhooks are a separate, allow-listed projection ([09](09-webhooks.md)).

## 8.1 Naming and versioning

- Event names follow `<module>.<entity>.<past_tense_verb>`, for example `work.task.completed` event, `core.record.trashed` event, `access.grant.revoked` event.
- The module is the **publishing (owning) module** and must own the aggregate entity. The validator checks this against 0B.
- `schema_version` is an integer per type. Additive fields keep the version. Removals, renames, and semantic changes add a version ([01 §1.4](01-principles-and-versioning.md#14-versioning)).
- The registry lists 47 event types, with fields, maximum class, consumer suitability, public webhook name, and requirement traces ([generated/registries.md](generated/registries.md#internal-events)).

## 8.2 Envelope

Internal schema `internal-event`.

| Field | Rule |
|---|---|
| `event_id` | UUIDv7 |
| `type`, `schema_version` | As above |
| `occurred_at` | Statement time of the domain change (the business time) |
| `recorded_at` | Outbox insert time. **Processing time** is recorded by consumers, never in the event. |
| `workspace_id`, `brand_id` | Scope **at event time** |
| `aggregate` | `{type, id, sequence}`. `sequence` = the aggregate's `version` after the change, monotonic per aggregate. |
| `actor` | `{type, id, on_behalf_of}` with 0A/0B actor types |
| `auth` | `{workspace_epoch, delegation_depth}`, so consumers can detect authorization changes made after the event |
| `correlation_id`, `causation_id`, `operation_id`, `attempt_id` | Causality |
| `data` | **Minimal** facts: IDs, states, categories, changed field **names**, and classified values ≤ C2. No row dumps, no rich content (consumers read current state through module APIs), no credentials, and no C3 values (C3 is referenced by ID only). |
| `max_class` | The highest class present in `data`. The validator caps the registry at C2. |

## 8.3 Delivery and ordering

- **At least once.** The dispatcher delivers each event to every subscribed in-process consumer. A consumer writes `execution.inbox_receipt (consumer, event_id)` **in the same transaction** as its effects, so redelivery is a no-op.
- **Ordering:** guaranteed only per aggregate, by `sequence`. Consumers that need order ignore an event whose `sequence` is ≤ the last one they processed for that aggregate, and re-read current state when they detect a gap. There is no global ordering.
- **Processing lag** is observable (`outbox.dispatch.lag`, [17](17-observability.md)).

## 8.4 Retention, replay, rebuild

- Dispatched outbox rows are kept for `OUTBOX_REPLAY_WINDOW`, then deleted. Replay within the window means resetting a consumer's receipts for a time range.
- **Projections are rebuildable from source tables, not from events.** Search, metrics, and activity rebuild by scanning owners' tables (0B §9.8). There is no event sourcing and no long-term event store.

## 8.5 Consumer suitability

Each registry entry marks which consumers may use the fact. Every consumer re-applies authorization at **its own** read or delivery time.

| Consumer | Rule |
|---|---|
| Activity | Builds display-safe items. Filters by **both** endpoints for relationship facts (0C §8.3). |
| Notifications | Resolves recipients and renders per recipient ([13](13-notifications.md)) |
| Metrics | Updates per-scope-key snapshots (0B §3.6) |
| Automation triggers | Only facts flagged `automation_trigger`. The run is authorized as the automation principal (0C §9.4). |
| Search indexing | Re-reads current record state and indexes readable-by-policy fields |
| Public webhooks | Only facts with a `public_webhook` name. Payloads are rebuilt from a public allow-list at delivery ([09](09-webhooks.md)). |

Security-sensitive facts are not automation triggers and not public webhooks: grants, role assignments, membership removal, usage limits, and inbox capture.

## 8.6 Compatibility rules

- Consumers must ignore unknown fields and unknown event types.
- Producers must not change the meaning of a field within a version.
- Removing an event type requires every consumer to stop subscribing first (an in-repo check, since everything is one codebase).
