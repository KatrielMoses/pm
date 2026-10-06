# Platform contracts (Phase 0D)

Status: **accepted** (Phase 0D, P0-W4); accepted at the Phase 0 exit gate (P0-IR1; [exit-gate report](../PHASE_0_EXIT_GATE.md)). Later approved amendments are recorded at their sources.

This set defines the shared technical language that every implementation phase uses: identifiers, encodings, HTTP conventions, errors, concurrency, idempotency, operations, jobs, events, webhooks, live updates, scopes, step-up, audit, notifications, usage, entitlements, files, imports/exports, and observability. It builds on [0A](../../product/README.md), [0E](../../ux/README.md), [0B](../data/README.md), [0C](../access/README.md), and the decisions in `ROADMAP_CHECKLIST.md`.

## Reading order

| # | Document | Resolves |
|---|---|---|
| 1 | [01-principles-and-versioning.md](01-principles-and-versioning.md) | DQ-10 |
| 2 | [02-http-api.md](02-http-api.md) | DQ-17 |
| 3 | [03-errors-and-non-disclosure.md](03-errors-and-non-disclosure.md) | AQ-01 |
| 4 | [04-concurrency.md](04-concurrency.md) | DQ-11 |
| 5 | [05-idempotency-and-effects.md](05-idempotency-and-effects.md) | DQ-12 |
| 6 | [06-operations.md](06-operations.md) | — |
| 7 | [07-jobs-and-execution-context.md](07-jobs-and-execution-context.md) | DQ-14, AQ-03 |
| 8 | [08-internal-events.md](08-internal-events.md) | DQ-13 |
| 9 | [09-webhooks.md](09-webhooks.md) | — |
| 10 | [10-live-updates.md](10-live-updates.md) | DQ-15, AQ-04 |
| 11 | [11-scopes-and-step-up.md](11-scopes-and-step-up.md) | AQ-02, AQ-05 |
| 12 | [12-audit-and-security-events.md](12-audit-and-security-events.md) | — |
| 13 | [13-notifications.md](13-notifications.md) | — |
| 14 | [14-usage-and-entitlements.md](14-usage-and-entitlements.md) | DQ-16 |
| 15 | [15-files.md](15-files.md) | — |
| 16 | [16-imports-exports-bulk.md](16-imports-exports-bulk.md) | — |
| 17 | [17-observability.md](17-observability.md) | — |
| 18 | [18-contract-catalog.md](18-contract-catalog.md) | Catalog overview |
| 19 | [19-decisions.md](19-decisions.md) | ADRs PL-01…PL-16 and all resolutions |
| 20 | [20-open-questions.md](20-open-questions.md) | Contradictions and open questions |

## Machine-readable contracts

| Artifact | Contents |
|---|---|
| `contracts/schemas/*.schema.json` | 30 JSON Schemas (draft 2020-12): 23 public, 7 internal |
| `contracts/examples/*.json` | 38 examples, each validated against its schema |
| `contracts/registry.json` | 83 public ID prefixes (each mapped to a 0B entity or a documented platform-only owner), 32 error codes, 0C response-shape mapping, states, 19 operation kinds, 90 internal events (20 public webhook types), 19 scopes, 14 meters, 18 notification types, 57 telemetry signals, 80 named parameters |
| [generated/schema-reference.md](generated/schema-reference.md) | Field tables and examples for every schema |
| [generated/registries.md](generated/registries.md) | All registries rendered |
| `tools/platformcontracts.py` | Validator and renderer |

## Validation

```sh
python3 docs/architecture/platform/tools/platformcontracts.py validate
python3 docs/architecture/access/tools/accesspolicy.py validate
python3 docs/architecture/data/tools/datamodel.py validate
python3 docs/product/tools/reqcat.py validate
```

The platform validator checks:

- **Schemas:** unique `$id`s; resolvable `$ref`s; public schemas never reach internal-only definitions (internal UUIDs, internal schemas); no C4 field anywhere; field classes within each schema's maximum class.
- **Examples:** every schema has an example, and every example validates.
- **Registry duplicates:** prefixes, codes, events, webhook types, scopes, meters, notification types, telemetry, and parameters.
- **Agreement with 0B:** public ID prefixes match the 0B addressable entities. Actor types, exec states, and terminal reasons match the 0B documents. Event modules and aggregates match 0B entities.
- **Agreement with 0C:** scopes reference 0C actions and principals. Step-up actions are never granted to non-human principals. Every 0C response shape maps to a platform response.
- **Content rules:** required error codes are present; `not_found` carries the uniform rule; telemetry never uses forbidden labels.
- **Documents:** requirement IDs, `OD-`/`UXD-`/`ADR-`/`DQ-`/`AZ-`/`AQ-`/`AC-`/`PL-`/`PQ-`/`PC-` references, invariants, actions, named parameters, error codes, and events cited in documents all exist. Links and anchors resolve.
- **Resolutions:** explicit anchors for DQ-10…DQ-17 and AQ-01…AQ-05.
- **Generated files** are up to date.

## Prescribed decisions applied

- JSON over HTTPS, with no GraphQL.
- Opaque keyset cursors.
- Opaque prefixed public IDs; UUIDv7 stays internal.
- One error shape with uniform not-found.
- At-least-once internal events and jobs with idempotent consumers; **no exactly-once external promise**.
- SSE carries notices only.
- Authorization, entitlements, budgets, and approvals are rechecked before consequential work.
- Payloads carry references and minimum fields.
- Secrets never appear in any envelope.
