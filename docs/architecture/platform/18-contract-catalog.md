# 18. Contract catalog and validation

## 18.1 Schemas

There are 29 schemas in `contracts/schemas/`, rendered in [generated/schema-reference.md](generated/schema-reference.md) with every example.

| Family | Schemas | Visibility |
|---|---|---|
| Common definitions | `common` (public ID, internal UUID, timestamp, date, local date-time, tz, locale, decimal, money, trace ID, request ID, actor, exec state, terminal and waiting reasons, risk class, data class, cost basis, record reference, approval reference), `meta` | public (internal UUID is marked internal-only) |
| Success and pagination | `success-envelope`, `collection-page` | public |
| Errors and gates | `error-envelope`, `conflict`, `approval-required`, `step-up-challenge` | public |
| Concurrency | `field-merge-request`, `conflict` | public |
| Idempotency | `idempotency-record` | internal |
| Operations | `operation`, `attempt`, `partial-result` | public |
| Execution | `execution-context`, `job` | internal |
| Events and delivery | `internal-event` (internal), `webhook-outbound`, `webhook-delivery`, `webhook-inbound-generic`, `sse-notice` | mixed |
| Audit | `audit-event`, `security-event` | internal |
| Notifications | `notification` | public |
| Usage and entitlements | `usage-event` (internal), `usage-estimate`, `entitlement-decision` | mixed |
| Files | `upload-session`, `file-reference` | public |
| Imports | `import-row-issue` | public |

Each schema declares `x-visibility` and `x-max-class`. Each sensitive property declares `x-class`.

## 18.2 Registries

`contracts/registry.json`, rendered in [generated/registries.md](generated/registries.md):

- public ID prefixes (61), each mapped to a 0B entity or a documented platform-only owner;
- error codes (32), plus the 0C response-shape mapping;
- states: exec states, terminal reasons, waiting reasons, the job-state mapping, actor types;
- operation kinds (19);
- internal events (47, of which 20 have public webhook names);
- scopes (19) and step-up methods;
- meters (14);
- notification types (18);
- telemetry signals (29) and forbidden metric labels;
- named parameters (30).

## 18.3 What the validator proves

| Check | Why |
|---|---|
| Unique `$id`s; all `$ref`s resolve | One contract per name |
| Public schemas never reach `internal_uuid` or internal schemas | DQ-10: internal keys stay private |
| No `x-class: C4`; no property above its schema's `x-max-class` | Classification propagates into every envelope |
| Every schema has an example, and all 37 validate | The schemas are usable and the examples are not illustrative fiction |
| Examples contain no secret-like values | I-16 |
| Required schemas and error codes present; `not_found` carries the uniform rule | Brief coverage |
| ID prefixes match 0B addressable entities exactly | One identity scheme |
| Actor types, exec states, terminal reasons match the 0B documents | No divergent state vocabularies |
| Event modules own their aggregates (0B); event classes ≤ C2 | Ownership and classification |
| Scopes reference 0C actions and principals; no step-up action reachable by non-human principals | Authorization consistency |
| Every 0C response shape maps to a platform response | AQ-01 completeness |
| Operation-kind entities exist; risk classes are 0C classes | Cross-phase references |
| Requirement IDs, decisions, invariants, actions, parameters, error codes, and events cited in documents exist | No dangling references |
| Links and anchors resolve; generated files current | Reviewable documentation |
| Resolution anchors for DQ-10…17 and AQ-01…05 | Brief acceptance |
