# Domain and data architecture (Phase 0B)

Status: **proposed: developer complete, awaiting solutions-architect review.** Nothing here marks a roadmap item complete.

This set defines one PostgreSQL-oriented logical model for the whole product scope in [`FEATURES.md`](../../../FEATURES.md). It covers modules and ownership, tenancy and brand scope, relationships, lifecycle and state axes, time, audit and evidence, deletion and retention, concurrency, PostgreSQL guidance, and data classification. It consumes the accepted Phase 0A contracts ([`docs/product/`](../../product/README.md)), the Phase 0E UX foundation ([`docs/ux/`](../../ux/README.md)), and the approved decisions in `ROADMAP_CHECKLIST.md`.

## Reading order

| # | Document | Read it for |
|---|---|---|
| 1 | [01-module-map.md](01-module-map.md) | The 32 modules, layering, write ownership, and which facts are published as events |
| 2 | [02-logical-model.md](02-logical-model.md) | Conventions every table follows: IDs, standard columns, the record envelope, typed tables, scope keys |
| 3 | [03-tenancy-brand-sharing.md](03-tenancy-brand-sharing.md) | Workspace and brand invariants, sharing, moves, hidden endpoints; what the database enforces versus transactions versus the 0C policy layer |
| 4 | [04-relationship-primitives.md](04-relationship-primitives.md) | Trees, dependencies, links, mentions, followers, labels, custom fields, views, comments, reviews, files, external identities, templates |
| 5 | [05-state-representation.md](05-state-representation.md) | Lifecycle, workflow, review, execution, and verification as separate stored facts |
| 6 | [06-temporal-model.md](06-temporal-model.md) | Instants versus floating dates, timezones, recurrence, availability, time tracking |
| 7 | [07-audit-provenance.md](07-audit-provenance.md) | Audit events, activity projection, provenance, correlation and idempotency identifiers, immutable decisions |
| 8 | [08-deletion-retention.md](08-deletion-retention.md) | Archive, trash, deletion batches, restore, tombstones, purge jobs, account/workspace deletion, backups |
| 9 | [09-concurrency-consistency.md](09-concurrency-consistency.md) | Optimistic concurrency and field merge, locks, ordering keys, transactions, outbox/inbox, read-model lag |
| 10 | [10-postgresql-guidance.md](10-postgresql-guidance.md) | Schemas, keys, constraints, indexes, JSON policy, search, partitioning, object storage, encryption, migrations |
| 11 | [11-data-classification.md](11-data-classification.md) | Confidentiality, retention, export and AI eligibility classes; secret handling |
| 12 | [12-decisions.md](12-decisions.md) | Architecture decision records (ADR-01 … ADR-18) |
| 13 | [13-open-questions.md](13-open-questions.md) | Unresolved questions grouped by what they block, plus contradictions found in 0A/0E |

## Machine-readable model and generated references

| Artifact | Role |
|---|---|
| [model/model.json](model/model.json) | **Authoritative logical model**: vocabulary, 32 modules, 204 entities, each with module, scope, containment, associations, lifecycle, concurrency, retention, classification, volume, uniqueness, key columns, and requirement traces |
| [model/model.schema.json](model/model.schema.json) | Structure of `model.json` |
| [generated/module-index.md](generated/module-index.md) | Module table and dependency diagram |
| [generated/logical-model.md](generated/logical-model.md) | Per-entity reference |
| [generated/er-diagrams.md](generated/er-diagrams.md) | Mermaid ER diagram per module |
| [generated/classification-matrix.md](generated/classification-matrix.md) | Classification and ownership matrix (families and every entity) |
| [tools/datamodel.py](tools/datamodel.py) | Validator and renderer (Python 3.8+, standard library only) |

## Validation

From the repository root:

```sh
python3 docs/architecture/data/tools/datamodel.py validate   # exits 1 on any error
python3 docs/architecture/data/tools/datamodel.py render     # after editing model.json
python3 docs/product/tools/reqcat.py validate                # 0A catalog still intact
```

`datamodel.py validate` checks:

- **Model structure:** `model.json` against its schema, and vocabulary membership of every classification field.
- **Modules:** no dependency cycles, and no module depending on a higher layer. Every cross-module reference from an entity must follow a declared module dependency.
- **Containment:** never crosses a brand boundary (scope-compatibility rule), and records with `full` lifecycle must be addressable through the record envelope.
- **Classification:** C4 (secret) data is never exportable or AI-eligible, and content that may contain secrets is never AI-eligible without redaction.
- **Requirement coverage:** every FEATURES section except launch acceptance is covered by a module and traced by at least one entity, and every requirement ID cited exists in the 0A catalog.
- **Document cross-references:** every internal link and anchor in this folder resolves, and every `OD-`, `UXD-`, `ADR-`, and `DQ-` reference exists.
- **Diagrams:** the Mermaid blocks pass a structural check.
- **Generated files:** they are up to date.

Mermaid is checked structurally (diagram type and line grammar), not rendered. Render in any Mermaid-capable viewer to inspect visually.

## Ground rules this set applies

1. One managed PostgreSQL database, modular monolith, one schema per module with explicit write ownership ([ADR-01](12-decisions.md#adr-01)).
2. Every tenant row carries `workspace_id`; every brand-owned row carries `brand_id`; consistency is enforced by composite foreign keys, not convention ([ADR-13](12-decisions.md#adr-13)).
3. Relationships and containment never grant access. Authorization (0C) evaluates per record, and every read surface uses the same evaluation.
4. Business records are typed tables. A thin record envelope gives addressable records identity, scope, and lifecycle without holding domain data ([ADR-03](12-decisions.md#adr-03)).
5. Durations, prices, regions, and legal promises appear only as named parameters linked to open decisions.
