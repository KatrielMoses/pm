# 17. Observability and operational contracts

## 17.1 Structured logs

| Field | Rule |
|---|---|
| `ts`, `level`, `event` (static name), `msg` (static template) | Always present |
| `request_id`, `correlation_id`, `trace_id`, `span_id` | Always present when available |
| `operation_id`, `attempt_id`, `job_id`, `event_id` | When in execution |
| `workspace_id` (internal UUID), `principal_type`, `principal_id` (internal) | Allowed in logs for support and security, under restricted access |
| `route` (template, never the concrete URL with IDs), `action_key`, `status`, `error_code`, `duration_ms` | Request logs |
| Forbidden | Customer content (titles, descriptions, comments, file names, search queries, AI prompts and outputs), secrets, tokens, email addresses, full IPs outside security events, raw provider bodies |

Logs pass through a redaction filter (SEC-014, 0B §11.3). Free-text fields are not logged. Errors log the error class and code, never the user's input values.

## 17.2 Traces

W3C Trace Context end to end: HTTP → database spans → jobs (the `traceparent` stored in the execution context) → outbox dispatch → consumers → external calls. Span attributes follow the log rules. Sampling is head-based with a configurable rate, plus **always sample** errors, authorization denials on R3/R4 actions, audit write failures, and RLS assertion failures.

## 17.3 Metrics

The registry lists 29 required signals ([generated/registries.md](generated/registries.md#telemetry-signals)). **Labels must have bounded cardinality and contain no customer content.** These labels are forbidden and validator-enforced: `workspace_id`, `brand_id`, `record_id`, `public_id`, `email`, `title`, `name`, `query`, `ip`, `user_agent`. Per-tenant analysis uses logs and traces, not metric labels.

| Area | Required signals (examples) |
|---|---|
| HTTP | request duration and count by route template, method, status class, principal class |
| Authorization | denials by action and response shape, context-build duration and cache hits |
| Database | transaction duration by module, **RLS context assertion failures** |
| Jobs | queue lag, attempts by outcome, dead-letter count, lease expiries |
| Outbox and inbox | dispatch lag, duplicates skipped |
| Webhooks | delivery duration and outcomes, endpoints disabled, inbound rejections by reason |
| SSE | open connections, resets by reason |
| Uploads and files | completions by outcome, scan duration |
| Integrations, AI, agents, automations | sync duration and outcome, AI request duration by provider class, tool calls by class and outcome, automation runs by outcome |
| Usage | reservations denied, cap stops |
| Audit | **write failures** |
| Auth | step-up outcomes, support-access actions |
| Tenancy | workspace/brand command outcomes, authorization decisions by action and outcome, tenant-context failures and fallbacks by reason, RLS denials by module ([PL-19](19-decisions.md#pl-19)) |

## 17.4 Health and readiness

- `GET /healthz` (liveness: the process responds).
- `GET /readyz` (readiness: database reachable, migrations at the expected version, outbox dispatcher alive, object storage reachable, post-restore recovery gate open, and tenant-isolation policy state intact ([PL-19](19-decisions.md#pl-19))).

Both return no tenant data or version details beyond a build identifier, and are not exposed publicly beyond the load balancer.

## 17.5 Service-level indicators

The indicators below are defined here. **Targets are not set here**: they come from measurements in 11C/11D and product decisions (OD-42).

- API availability: the share of non-5xx responses.
- Latency (p95/p99) for capture, update, save, search, and page load (REL-009).
- Job queue lag.
- Outbox dispatch lag.
- Webhook delivery success.
- SSE connection health.
- Upload completion success.
- Integration sync freshness.

## 17.6 Security monitoring and alert ownership

| Alert | Owner |
|---|---|
| Audit write failures (any) | Platform (`audit`) — page |
| RLS context assertion failures (any) | Platform (`execution`, `core`) — page |
| Spikes in `not_found` on sequential ID probing or step-up failures | Security — alert |
| Support access actions, elevation (each) | Security — notify |
| Dead-letter growth per queue | The owning module |
| Webhook endpoint disablement | `integrations` |
| Outbox or job lag above threshold | Platform (`execution`) |
| Usage cap stops spike | `metering` |
| Error-tracking new issue classes | The owning module |

Error tracking uses the same redaction. Events are grouped by error class and route template, never by message text containing input.
