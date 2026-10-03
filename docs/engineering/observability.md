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

| Area | Signals emitted in 1A |
|---|---|
| HTTP | `http.server.request.duration` (route, method, status_class, principal_class), `http.server.requests` |
| Database | `db.transaction.duration` (module, kind), `db.rls_context_assertion_failures`, `db.pool.connections` (identity, state: total/idle/waiting) |
| Jobs | `job.attempts` (queue, outcome), `job.attempt.duration`, `job.retries` (queue, error_class), `job.dead`, `job.lease_expired`, `job.queue.lag`, `job.states` (queue, state) |
| Outbox | `outbox.dispatch.lag`, `outbox.backlog`, `outbox.dispatched` (outcome), `inbox.duplicates_skipped` (consumer) |
| Worker / health | `worker.up`, `worker.active_jobs`, `readiness.checks` (check, outcome) |

## Health and readiness (0D §17.4)

| Endpoint | Returns | Never returns |
|---|---|---|
| `GET /healthz` | `{"status":"ok"}` | anything else |
| `GET /readyz` | `200/503 {"status","checks":{database,migrations,dispatcher,object_storage},"build"}` | hosts, ports, database names, versions beyond the build ID, errors |
| `GET /v1/status` (public, cached 5 s) | `{"data":{"type":"platform_status","status":"available"|"degraded","build":{version,build}},"meta":{…}}` | check names or reasons |

Failure reasons go to `readiness.check_failed` logs. `/readyz` fails immediately when shutdown starts.

## Error reporting

`ErrorReporter` (`capture`, `flush`) is the vendor boundary. The default `LogErrorReporter`
emits `error.captured` with allow-listed context and error class/code. A future vendor adapter must
accept only these fields.
