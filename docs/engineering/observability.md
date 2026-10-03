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
| Tenancy (1C) | `tenancy.commands` (command, outcome), `tenancy.authz_decisions` (action_key, outcome), `tenancy.context_failures` (reason), `tenancy.context_fallbacks` (reason), `tenancy.rls_denials` (module) |

## Health and readiness (0D §17.4)

| Endpoint | Returns | Never returns |
|---|---|---|
| `GET /healthz` | `{"status":"ok"}` | anything else |
| `GET /readyz` | `200/503 {"status","checks":{database,migrations,dispatcher,object_storage,recovery_gate,tenant_isolation},"build"}` | hosts, ports, database names, versions beyond the build ID, errors |
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
