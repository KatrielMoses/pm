# Phase 0 exit-gate report

Status: **accepted — Phase 0 exit gate passed.**

True architecture blockers remaining: **0**

Decision: **Phase 0 exit gate passed following acceptance of this reconciliation and [RELEASE_TOPOLOGY.md](RELEASE_TOPOLOGY.md)**. The topology is assembled from accepted decisions and introduces no vendor commitment of its own.

## 1. Roadmap exit-gate criteria

`BUILD_ROADMAP.md` Phase 0 exit gate: *"approved architecture decision records, domain map, permission matrix, requirement traceability matrix, and initial release topology."*

| Criterion | Evidence | Status |
|---|---|---|
| Approved ADRs | 0B ADR-01…18 ([data/12](data/12-decisions.md)), 0C AZ-01…16 ([access/15](access/15-decisions.md)), 0D PL-01…16 ([platform/19](platform/19-decisions.md)). All recorded as accepted in `ROADMAP_CHECKLIST.md`. | Met |
| Domain map | 32 modules with layers, ownership, and dependencies ([data/01](data/01-module-map.md), [generated index](data/generated/module-index.md)). Validated acyclic and layer-monotonic. | Met |
| Permission matrix | 98 actions × 6 roles = 588 cells, 17 principals, 14 agent tool classes ([access matrix](access/generated/permission-matrix.md)). Validated for grantable authority, caps, non-delegable actions, and step-up. | Met |
| Requirement traceability matrix | 684 requirements (661 product + 23 launch acceptance), each with one owning sub-phase ([catalog](../product/requirements/catalog.md)). 0 unmapped. | Met |
| Initial release topology | [RELEASE_TOPOLOGY.md](RELEASE_TOPOLOGY.md): deployable units, data stores, environments, trust boundaries, open vendor items | **Produced in this pass; awaiting acceptance** |

## 2. Deliverables by sub-phase

| Sub-phase | Deliverables | Machine-readable core |
|---|---|---|
| 0A | Glossary, hierarchy and scope, lifecycle, time, deletion, 46 open decisions, requirement catalog | `docs/product/requirements/catalog.json` |
| 0E | Principles, IA, journeys, responsive shell, design system, interaction states, accessibility, i18n/time, UX decisions (UXD-01…28) | Token tables checked by `check_contrast.py` |
| 0B | 13 architecture documents, ADRs, open questions | `data/model/model.json`: 32 modules, **204 entities** (30 addressable) |
| 0C | 16 documents, ADRs, threat model | `access/policy/policy.json`, `threats.json`: 34 threats, 80 tests |
| 0D | 20 documents, ADRs | 29 JSON Schemas, 37 validated examples, registry |
| Integration | [PHASE_0_DECISIONS.md](PHASE_0_DECISIONS.md), this report, [RELEASE_TOPOLOGY.md](RELEASE_TOPOLOGY.md), `docs/architecture/tools/phase0.py` | Cross-package checks |

## 3. Validation evidence

Command (runs every package validator, then the cross-package checks):

```sh
python3 docs/architecture/tools/phase0.py
```

Result:

```
package: 0A requirement catalog                                PASS   [RESULT: PASS]
package: 0E documentation                                      PASS   [All documentation checks passed.]
package: 0E contrast                                           PASS   [All contrast checks passed.]
package: 0B data model                                         PASS   [RESULT: PASS]
package: 0C authorization policy                               PASS   [RESULT: PASS]
package: 0D platform contracts                                 PASS   [RESULT: PASS]
cross: 0C-required data entities and fields in 0B              PASS
cross: 0D execution context representable in 0B                PASS
cross: principals, prefixes, actions, scopes                   PASS
cross: states, actors, classes, parameters                     PASS
cross: public surfaces (classes, decisions, webhooks, SSE)     PASS
cross: stale contradiction language                            PASS
cross: approved amendments present at source                   PASS
cross: cross-phase blockers resolved                           PASS
cross: Phase 0 summary documents (links, references)           PASS
PHASE 0 INTEGRATION: PASS
```

Package summaries at the time of this report:

| Package | Summary |
|---|---|
| 0A | 684 items (661 + 23), 684 unique IDs, 0 missing or extra, 0 unmapped, 64 sub-phases |
| 0B | 32 modules, 204 entities (30 addressable), 376 requirement traces |
| 0C | 18 invariants, 17 principals, 6 roles, 98 actions, 588 cells, 34 threats / 80 tests |
| 0D | 29 schemas (22 public, 7 internal), 37 examples, 61 ID prefixes, 32 error codes, 19 operation kinds, 47 events (20 public webhooks), 19 scopes, 14 meters, 18 notification types, 29 telemetry signals, 30 parameters |

## 4. Reconciliation performed in this pass

| Item | Resolution | Where |
|---|---|---|
| 0C AC-03 not applied to the 0B model (0D PC-01) | Applied. 8 entities added: `share_group`, `field_policy`, `permission_epoch`, `service_principal`, `support_access_grant`, `upload_session`, `step_up_challenge`, `export_file`. 20 entities extended: record grant rows, access modes, typed workspace policy, owner-authority suspension, execution context, elevation, idempotency state, effect destination classes, and others. | `data/model/model.json`, data prose |
| Obsolete share arrays | Removed from the model. 0B §3.4 and the C-03 resolution rewritten. The 0C AZ-05 wording marks them superseded. | data/03, data/13, access/15 |
| `execution.job` lacked `correlation_id`/`causation_id` (found by the integration validator) | Added | model |
| 0D prefixes without a data home (`shr`, `svc`, `upl`, `stp`, `exf`) or owner (`evt`, `req`) | Mapped to the new entities. `evt`/`req` documented as platform-only (owner `execution`). `sag` and `fpol` added. **61 prefixes**, each with an owner module. | `platform/contracts/registry.json` |
| 0C `service_principal` without entity; platform-only identities unmarked | `access.service_principal`. `support_operator` and `anonymous_public` marked platform-only. | `access/policy/policy.json` |
| Public webhooks lacked an explicit allow-list version and delivery-authorization rule | Added for all 20 and validated | registry |
| SSE topics not registered against 0C predicates | 5 topics registered with their 0C context parameters and validated against 0C §4.5 | registry |
| AC-01…06, PC-01…03, PQ-01…04, 0B DQ-01…08 and DQ-10…17 still read as open | Marked resolved with links to their resolutions. History kept. | access/16, platform/20, data/13 |
| Stale counts (196 entities, 59 prefixes) and the "pending (PC-01)" notes | Updated | data, platform docs |
| Approved amendments PC-02, PC-03, AC-01, 02, 04, 05, 06 | Verified present at source, with phrases asserted by the validator | §3 cross checks |

## 5. Unresolved items, classified

**True architecture blockers: none.** Every remaining item has an accepted safe default or is a parameter or vendor choice owned by a later phase ([PHASE_0_DECISIONS.md §3–5](PHASE_0_DECISIONS.md#3-product-decisions-with-accepted-safe-defaults-build-to-the-default-confirm-in-the-owning-phase)).

| Class | Items | Why not a blocker |
|---|---|---|
| Phase-owned product defaults | OD-01, OD-08…33, UXD PO/SA items | Defaults are buildable and reversible |
| Implementation choices and parameter values | DQ-20…29, AQ-06/09/10/11/17, PQ-05…07/09…11, 30 named parameters | Owned by the implementing phase. Measured, not promised. |
| Legal, commercial, and customer promises | OD-34…46, AQ-07/08/12…16, PQ-08/12…16, DQ-30…38 | Unset by design. The product publishes nothing until approved. |
| **Prerequisites for the first Phase 1 brief** (not architecture blockers) | Hosting provider and first region (OD-43), secret store and KMS (DQ-28), CI provider | Needed to provision environments in 1A. Local and CI work can start provider-neutral. |
| Exit-gate artifact acceptance | [RELEASE_TOPOLOGY.md](RELEASE_TOPOLOGY.md) | Produced from accepted decisions. Awaits sign-off. |

## 6. Warnings: contracts held only in prose

These accepted contracts have **no machine-readable authoritative model**. The validators cannot detect drift in them. Each must be implemented and tested in its owning phase:

1. **Physical database constraints:** composite tenant/brand foreign keys, deferred constraint triggers, RLS policies, role grants, and partial indexes. They exist only as illustrative DDL in 0B §3.3, §10 and 0C §12. The logical model is authoritative for entities and columns, not constraints. → 1A/1C migrations plus the 0C §12.7 tests.
2. **0A state-transition rules:** default workflows, defect and release workflows, completion gates. → 2C/9C/9D.
3. **0C field-policy defaults:** core fields always hidden from guests (§7.1). The `access.field_policy` entity exists, but there is no seeded default set. → 2C.
4. **0E UX rules:** prose by design, except contrast tokens.
5. **[RELEASE_TOPOLOGY.md](RELEASE_TOPOLOGY.md):** prose only.

No accepted architecture decision now exists only in a completion report or the checklist while contradicting an authoritative model. The approved checklist decisions are asserted at source by the integration validator.

## 7. Recommended first Phase 1 batch (dependency-oriented)

| Wave | Sub-phases | Why this order | Key inputs |
|---|---|---|---|
| **P1-W1** | **1A** alone | Every later sub-phase needs the repository, CI with the six validators, the migration workflow (expand/contract under `migrator`), the RLS role layout, and the execution foundations (`execution` schema: operation, attempt, job, outbox, inbox receipts, idempotency keys, external effects) plus the observability baseline | Release topology; 0B §10; 0C §12; 0D §5, §7, §8, §17; prerequisite decisions: hosting and secret store |
| P1-W2 | **1B** ∥ **1F** | Identity, sessions, MFA foundations, and step-up challenges (1B, `identity` module), alongside the record envelope, audit and security events, deletion batches, and tombstones (1F, `core` and `audit` modules). Separate modules and outputs make them parallel-safe. | 0B §2.3, §7, §8; 0D §11–12 |
| P1-W3 | **1C** then **1D** | Workspaces, brands, and tenant isolation (RLS fixtures from 0C §12.7). Then memberships, roles, record grants and share groups, field policy, epochs, and the visibility compiler with 0C property tests. | 0B §3; 0C §4, §6, §13 |
| P1-W4 | **1E** | The shell needs authenticated, tenant-scoped data and permission-safe routing | 0E; 0D §2, §10 |

**Recommended first brief: 1A.** Do not start 1B or later until 1A's CI runs `python3 docs/architecture/tools/phase0.py` and the migration and RLS skeleton exist.
