# Observability

## Logs (0D §17.1)

JSON lines on stdout: `ts`, `level`, `service`, `event` (static name), `msg` (= event), plus an
**allow-list** of fields (request/correlation/trace/span IDs, operation/attempt/job/event IDs,
internal workspace/principal IDs, route template, method, status, duration, error class/code,
job kind, queue, outcome, …). Unknown fields are dropped and counted; string values pass through
redaction (credential URLs, bearer/basic tokens, JWTs, `key=value` secrets, private keys, emails).
Errors log class, code, and stack frames, never messages (driver messages can hold values).
Fastify's own logger is disabled; request logs carry the route **template**, never the URL, headers,
query, or body. SQL text and bind values are never logged.

## Traces (0D §17.2)

OpenTelemetry API/SDK with the W3C trace-context propagator; OTLP/HTTP export only when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set. Spans: `http.server` (continues an incoming `traceparent`;
its trace ID is the correlation ID), `db.<op>` per query (attributes: system, operation keyword,
identity — no statement), `job.run` (parent = the enqueuing request's `traceparent` stored on the
job), `outbox.dispatch` / `outbox.consume` (parent = the producer's `traceparent` on the event).
Sampling is head-based parent-based ratio (`TRACE_SAMPLE_RATIO`). "Always sample errors" needs tail
sampling in a collector; that is deferred with the vendor decision.

## Metrics (0D §17.3)

Only declared signals with declared labels are accepted (`Metrics` facade). Forbidden labels
(`workspace_id`, `brand_id`, `record_id`, `public_id`, `email`, `title`, `name`, `query`, `ip`,
`user_agent`) and identifier-looking values (UUIDs, public IDs, emails, IPs, URLs, long hex) are
rejected: thrown in local/test, dropped and counted (`telemetry.label_rejected`) elsewhere.

| Area | Signals |
|---|---|
| HTTP | `http.server.request.duration` (route, method, status_class, principal_class), `http.server.requests` |
| Database | `db.transaction.duration` (module, kind), `db.rls_context_assertion_failures`, `db.pool.connections` (identity, state: total/idle/waiting) |
| Jobs | `job.attempts` (queue, outcome), `job.attempt.duration`, `job.retries` (queue, error_class), `job.dead`, `job.lease_expired`, `job.queue.lag`, `job.states` (queue, state) |
| Outbox | `outbox.dispatch.lag`, `outbox.backlog`, `outbox.dispatched` (outcome), `inbox.duplicates_skipped` (consumer) |
| Worker / health | `worker.up`, `worker.active_jobs`, `readiness.checks` (check, outcome) |
| Identity (1B) | `identity.flow.outcomes` (flow, outcome), `identity.flow.duration`, `identity.rate_limited` (policy), `identity.sessions` (state), `identity.cleanup.deleted` (kind), `mail.enqueued` (template), `mail.deliveries` (template, outcome) |
| Audit and lifecycle (1F) | `audit.writes`/`audit.write_failures` (module), `audit.write.duration` (module, outcome), `audit.chain.lock_wait` (module), `audit.chain.lock_wait_exceeded` (module), `audit.chain.verifications` (outcome), `audit.chain.problems` (kind), `audit.redactions` (reason), `security_events.written` (category, scope), `security_events.write_failures` (scope), `security_events.buffer_drained`, `security_events.buffer_remaining`, `security_events.buffer_verifications` (outcome), `lifecycle.transitions` (transition, outcome), `purge.backlog` (state), `purge.blocked` (reason), `purge.hook.duration` (hook, outcome), `purge.hook.failures` (hook), `purge.ledger.acknowledgements` (outcome), `retention.scheduler.runs` (policy, outcome) |
| Tenancy (1C) | `tenancy.commands` (command, outcome), `tenancy.authz_decisions` (action_key, outcome), `tenancy.context_failures` (reason), `tenancy.context_fallbacks` (reason), `tenancy.rls_denials` (module), `tenancy.invitation_outcomes` (stage, outcome), `tenancy.revocations` (kind, outcome), `tenancy.epoch_stale` (consumer), `tenancy.ownership_hook_failures` (hook), `tenancy.context_strategy` (strategy) |
| Shell and personal navigation (1E) | `views.recent_writes` (outcome), `views.favorite_changes` (op, outcome), `views.state_ops` (op, outcome), `views.state_decode_failures` (source, reason), `views.omitted_targets` (list), `views.cleanup` (kind), `shell.commands` (command, trigger; registry ids only), `identity.preference_updates` (outcome) |

## Health and readiness (0D §17.4)

| Endpoint | Returns | Never returns |
|---|---|---|
| `GET /healthz` | `{"status":"ok"}` | anything else |
| `GET /readyz` | `200/503 {"status","checks":{database,migrations,dispatcher,object_storage,email_delivery,recovery_gate,tenant_isolation},"build"}` | hosts, ports, database names, versions beyond the build ID, errors |
| `GET /v1/status` (public, cached 5 s) | `{"data":{"type":"platform_status","status":"available"|"degraded","build":{version,build}},"meta":{…}}` | check names or reasons |

Failure reasons go to `readiness.check_failed` logs. `/readyz` fails immediately when shutdown starts.

## Error reporting

`ErrorReporter` (`capture`, `flush`) is the vendor boundary. The default `LogErrorReporter`
emits `error.captured` with allow-listed context and error class/code. A future vendor adapter must
accept only these fields.

## Identity redaction (1B)

Logs carry `flow`, `template`, `policy`, and `auth_method` fields, never tokens, codes, passwords,
seeds, cookies, emails, or full IPs. Identity C4 values never become metric labels or span
attributes. An integration test collects the logs from a full identity run and asserts that no
token, code, or password from that run appears in them.

## Audit and lifecycle (1F)

Audit change content never reaches logs, traces, or metrics. `audit.write_failed` (error, with
`workspace_id`, `operation_id`, and `error_class` only) accompanies every rolled-back mutation and
should page. `audit.chain_problems` logs chain positions and problem kinds only. `audit.chain_lock_wait_high`
(warn) logs `workspace_id` and `duration_ms` only. Purge logs carry
`batch_id`, `reason`, and IDs. Readiness adds `recovery_gate`, which fails while a restored
environment awaits purge-ledger replay.

## Projects (2A)

| Signal | Labels | Meaning |
|---|---|---|
| `work.hierarchy.moves` | `outcome` (`ok`, a 0D error code such as `validation_failed`, `not_found`, `forbidden`, `conflict`; `invariant` when a database check refused it; `error`) | Project move commands |
| `work.recurrence.occurrences` | `outcome` (`generated`, `manual`, `paused`, `catchup_deferred`, `workspace_batch_full`, `series_batch_full`) | Recurrence results. A steady `workspace_batch_full` or `series_batch_full` means the discovery bounds (`RECURRENCE_WORKSPACE_DISCOVERY_MAX`, `RECURRENCE_SERIES_DISCOVERY_MAX`) are reached every run: work still completes, oldest-waiting first, over more runs; raise the bound if due times slip |

Project names, descriptions, criteria, scope entries, updates, decisions, budgets, and dependency endpoints never appear in labels, logs, or error context. Audit records content-class changes as hashes.

## Tasks (2B)

| Signal | Labels | Meaning |
|---|---|---|
| `work.task.moves` | `outcome` (`ok`, `brand` for an applied cross-brand move, a 0D error code, `invariant` when a database check refused it, `error`) | Task move and cross-brand move commands |
| `work.task.completions` | `outcome` (`completed`, `override`, `refused_criteria`, `refused_subtasks`) | Completion results; a rising `override` share means criteria are not being maintained |

Task titles, descriptions, checklist and criteria text, link URLs, and label names never appear in labels, logs, or error context.

## Workflows and fields (2C)

| Signal | Labels | Meaning |
|---|---|---|
| `workflow.transitions` | `outcome` (`ok`, `refused`, `review_required`, `stale`, `approval_required`, an approval state, `applied`) | Every gated status change through the one evaluator |
| `workflow.transition.duration` | `outcome` | Evaluation and enforcement time per status change |
| `workflow.formula.evaluations` | `outcome` (`ok`, `missing`, `invalid`, `divide_by_zero`, `cycle`, `overflow`) | Formula results computed on writes and reads |

Field names, values, formulas, option labels, status names, and emails never appear in labels, logs, or error context. Audit records value changes as hashes under `fields.<field id>`.

## Task interaction (2D)

Counters `work.reminders.fired`, `work.bulk.items`, and `work.undo.applied` (outcome label only); task occurrences reuse `work.recurrence.occurrences`. Outbox facts carry identifiers, counts, and states only.

## Capture (2E)

Counters `capture.items`, `capture.parse`, and `capture.triage` (outcome label only). Captured text never appears in logs, metrics, events, or audit (content hashes only).

## Views (3A)

Views emit two counters and one histogram:
- `views.queries` (entity, outcome)
- `views.query_duration` (entity)
- `views.exports` (entity, format)

Query text, filter values, view names, and exported rows never appear in logs, metrics, or events. Audit records a content hash of the exported query.
## Time (3D)

Counters `time.entries` (source, outcome), `time.timers` (action, outcome: `ok`, `noop`, `capped`), `time.timesheets` (action, outcome: `ok`, `self`), `time.exports` (format), and `time.timer_guard` (outcome: `stopped`, `workspace_batch_full`). Events carry identifiers, durations, dates, and flags only. Notes and unlock reasons never appear in logs, metrics, or events; audit keeps their hashes. Exports write an `export` security event; unlocks a `permission` security event.


## Views (3B)

`views.layout_reads` (layout, outcome). No record identifiers, names, or values are labels.

## Planning (3C)

Counters `planning.today` (action, outcome), `planning.blocks` (action, outcome), `planning.block_series` (outcome: `defined`, `generated`, `skipped`), and `planning.day_close` (outcome: `closed`). Events carry identifiers, days, counts, sources, and flags; never task or block titles (audit keeps block-title hashes).

## Capacity (3E)

Counters `capacity.reads` (view: `person`, `team`, or `rescheduling`; outcome) and `capacity.changes` (kind: `profile`, `time_off`, `holiday`, or `reservation`; outcome). Events carry identifiers, days, minutes, and kinds, never time-off labels or holiday names.

## Collaboration (4A)

Counters `collab.comments` (action: `create`, `edit`, `delete`, `list`, `replies`; outcome), `collab.reactions` (change: `added` or `removed`; outcome), `collab.follows` (change: `added`, `removed`, or `list`; outcome), `collab.reviews` (action: `request`, `decide`, `withdraw`, `refresh`, `list`, or `queue`; outcome), `collab.delegations` (kind: `delegate`; outcome), and the shared `tenancy.authz_decisions` for every decision. Events carry identifiers, kinds, and flags; never comment bodies, notes, messages, or names.

## Notifications (4B)

Counters `notify.fanout` (type; outcome: `created`, `collapsed`, `muted`, `skipped_record`, `skipped_recipient`, or `skipped_access`), `notify.deliveries` (channel: `email` or `browser`; outcome: `delivered`, `retry`, `failed`, `dead`, `suppressed`, `unconfigured`, `expired`, `deferred`, or `sweep_error`), `notify.digests` (kind: `daily` or `weekly`; outcome: `assembled` or `empty`), and `notify.reads` (view: `list`, `counts`, and the other reads; outcome: `ok` or an error code), plus the shared `tenancy.authz_decisions`. The readiness check `email_delivery` is `ok` with a configured mail transport and `not_configured` without one; it is never `fail`, and a missing provider is never reported as delivery. Events and logs carry identifiers, types, channels, states, and failure classes and codes; never titles, names, addresses, or bodies.

## Documents (4C)

Counters `knowledge.documents` (action: `create`, `read`, `list`, `update`, `move`, `archive`, `unarchive`, `trash`, `restore`, `purge`, `approve`, `revoke`; outcome), `knowledge.versions` (action: `save`, `restore`, `list`, `read`; outcome), `knowledge.suggestions` (action: `create`, `accept`, `reject`, `withdraw`, `list`, `read`; outcome), `knowledge.exports` (format: `markdown` or `html`; outcome), `knowledge.references` (action: `links` or `backlinks`; outcome), plus the shared `tenancy.authz_decisions`. Events carry identifiers, kinds, and counts; never titles, text, or addresses.

## Files (4E)

Counters `files.requests` (op: the service operation; outcome: `ok` or an error code), `files.jobs` (kind: `scan`, `expire`, or `delete_object`; outcome), and `upload.completed` (outcome: `ok` or the rejection code), the histogram `file.scan.duration` (outcome: the verdict), plus the shared `tenancy.authz_decisions`. The readiness check `object_storage` is `ok` when the configured store answers, `not_configured` without one, and `fail` when a configured store is unreachable; the `storage_status` resource reports object storage and the malware scanner the same way, with the workspace's used and reserved bytes. Events and logs carry identifiers, version numbers, sources, states, and codes; never file names, URLs, object keys, signed URLs, or malware signatures.

## Live editing (4D)

The counter `knowledge.live` (action: `join`, `ops`, `poll`, `heartbeat`, `checkpoint`, or `leave`; outcome: `ok` or an error code such as `live_capacity`, `session_expired`, or `not_found`). Operations, cursors, and heartbeats are never audited and never logged with content; the audit trail records only the checkpoint's version (`document.saved`, with the contributor count and the reason it was saved). A rising `live_capacity` or `session_expired` rate is the signal that the limits in `LIVE_*` need attention.

## Search (5A)

Three signals. `search.requests` (op: `query`, `status`, `open`, `recent_add`, `recent_list`, or `recent_clear`; outcome: `ok` or an error code such as `validation_failed`, `not_found`, `cursor_invalid`, or `rate_limited`). `search.index.jobs` (kind: a source kind, `recent`, or `workspace`; outcome: `indexed`, `removed`, `retry`, `failed`, `swept`, or `error`): a rising `retry` or any `failed` means records are not reaching the index, and the same state is shown to people as "Search is catching up" or "Some items couldn't be searched". `search.query.duration` (histogram, outcome): the cost of a search grows with one workspace's entry count (no full-text index is usable under row-level security), so this is the signal to act on before a workspace nears about 100,000 entries (ADR-0028 S14). Logs carry the source kind and the error class of a failed indexing attempt (`search.index_failed`), never text, queries, or results; queries and recent searches are never logged.

## Goals and portfolios (5B)

Counters `goals.reads` (view: the read, such as goal, list, check-ins, overview, dependencies, orphans, or export; outcome: `ok` or an error code), `goals.changes` (kind: the command; outcome), and `goals.jobs` (kind: `recalculate`; outcome), plus the shared `tenancy.authz_decisions`. Goal titles, descriptions, notes, owner names, and project or task names never appear in a metric label, a log line, or an event: events carry enums and counts (scope, period kind, basis, source, confidence, days stale, member count), and the audit trail stores content hashes for titles, descriptions, and notes. Exports are audited (`goals.exported`, `portfolio.exported`, with the row count and format) and raise a security event of category export. A goal whose recalculation keeps failing is reported `failing` to people who read it and counts as `goals.jobs` outcome `failed`; its stored error is a short code, never a message.
