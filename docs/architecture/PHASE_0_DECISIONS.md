# Phase 0 decisions index

Status: produced in Phase 0 integration reconciliation. This is an **index**: each row links to the authoritative document, which governs if wording differs. Validated by `python3 docs/architecture/tools/phase0.py`.

## 1. Authoritative versus generated files

| Package | Authoritative (edit these) | Generated (never edit by hand) | Validator |
|---|---|---|---|
| Scope | `FEATURES.md` (wording), `BUILD_ROADMAP.md` (phases), `ROADMAP_CHECKLIST.md` (approved decisions, progress) | — | — |
| 0A product | [docs/product/*.md](../product/README.md), `docs/product/requirements/catalog.json` | `requirements/catalog.md`, `requirements/summary.md` | `docs/product/tools/reqcat.py` |
| 0E UX | [docs/ux/*.md](../ux/README.md) | — | `docs/ux/tools/check_docs.py`, `check_contrast.py` |
| 0B data | [docs/architecture/data/*.md](data/README.md), `data/model/model.json` (+ schema) | `data/generated/*.md` | `docs/architecture/data/tools/datamodel.py` |
| 0C access | [docs/architecture/access/*.md](access/README.md), `access/policy/policy.json`, `access/policy/threats.json` | `access/generated/*.md` | `docs/architecture/access/tools/accesspolicy.py` |
| 0D platform | [docs/architecture/platform/*.md](platform/README.md), `platform/contracts/schemas/*.json`, `platform/contracts/examples/*.json`, `platform/contracts/registry.json` | `platform/generated/*.md` | `docs/architecture/platform/tools/platformcontracts.py` |
| Integration | This file, [PHASE_0_EXIT_GATE.md](PHASE_0_EXIT_GATE.md), [RELEASE_TOPOLOGY.md](RELEASE_TOPOLOGY.md) | — | `docs/architecture/tools/phase0.py` (runs all of the above) |

Machine-readable models win over prose for structure (entities, columns, actions, scopes, prefixes, states). Prose wins for semantics. The integration validator fails when the two disagree in the checked areas.

## 2. Approved cross-phase decisions

| Decision | Authoritative source |
|---|---|
| Tasks require a brand; projects are optional | [0A OD-02](../product/open-decisions.md#od-02), [0B §3.2 T3](data/03-tenancy-brand-sharing.md#32-invariants) |
| Inbox items may be personal and unbranded until triage | [OD-03](../product/open-decisions.md#od-03), [0B T4](data/03-tenancy-brand-sharing.md#32-invariants) |
| Cross-brand sharing uses revocable record grants: one row per selected record at share time, never future children | [OD-04](../product/open-decisions.md#od-04), [0B §3.4](data/03-tenancy-brand-sharing.md#34-explicit-cross-brand-shares), [0C AZ-05](access/15-decisions.md#az-05) |
| Cross-brand associations allowed; inaccessible endpoints, counts, types, derived conditions omitted | [OD-05](../product/open-decisions.md#od-05), [UXD-28](../ux/09-decisions-and-risks.md#uxd-28), [0B §3.5](data/03-tenancy-brand-sharing.md#35-hidden-endpoints-counts-and-derived-conditions) |
| Workspace-scoped records valid; guests get no implicit workspace access | [OD-06](../product/open-decisions.md#od-06), [0C §6.1](access/06-guests-sharing-public-links.md#61-guests) |
| Aggregates disclose only authorized brands and records | [OD-07](../product/open-decisions.md#od-07), [0C §8.2](access/08-search-reporting-notifications-caches.md#82-dashboards-reports-counts-metrics-capacity-portfolios) |
| Anonymous colleague free/busy off by default | [0A time §5](../product/time-and-scheduling.md#5-availability-and-capacity), [0C DQ-06 resolution](access/15-decisions.md#resolve-dq-06) |
| 0B ADRs accepted; internal delivery at least once, external deduplication provider- or receiver-dependent, never exactly once | [0B ADR-08](data/12-decisions.md#adr-08), [0D §5.4](platform/05-idempotency-and-effects.md#54-external-effects-never-exactly-once) |
| 0C authorization ADRs and permission matrix accepted | [0C ADRs](access/15-decisions.md#152-architecture-decision-records), [matrix](access/generated/permission-matrix.md) |
| Guests use fixed record grants only; public links and request-access disclosure disabled | [0C AZ-06](access/15-decisions.md#az-06), [0C §6.7](access/06-guests-sharing-public-links.md#67-public-unauthenticated-links), [UXD-13](../ux/09-decisions-and-risks.md#uxd-13) |
| Departed-member personal data not administrator-exportable by default | [0A deletion §3](../product/deletion-retention-history.md#3-brand-workspace-and-account-deletion), [0C AC-05](access/16-open-questions.md#ac-05) |
| No ordinary application, worker, support, dispatcher, or scheduler role bypasses tenant RLS | [0B §10.4](data/10-postgresql-guidance.md#104-row-level-security-defense-in-depth), [0C §12.3](access/12-rls-and-application-policy.md#123-database-roles) |
| 0D platform ADRs, 20 public webhook event types (PQ-03), reference-only SSE topics (PQ-04) accepted | [0D ADRs](platform/19-decisions.md#192-architecture-decision-records), [registries](platform/generated/registries.md) |
| Idempotent replay re-renders stored references through current authorization (PC-02) | [0B §9.6](data/09-concurrency-consistency.md#96-idempotency-logical-operations-and-attempts), [0D §5.2](platform/05-idempotency-and-effects.md#52-the-idempotency-key-header) |
| Signed URLs: bounded residual use until short expiry; revocation blocks new URLs (PC-03); proxied downloads for sensitive brands are a later option | [0C §6.5](access/06-guests-sharing-public-links.md#65-behavior-on-shared-records), [0D §15.2](platform/15-files.md#152-download-flow) |
| Trash uses current effective permission; guests excluded | [0E ST-46](../ux/06-interaction-states.md#st-46), [0C DQ-08 resolution](access/15-decisions.md#resolve-dq-08) |
| Legal, commercial, retention-duration, SLO, rate-limit, and compatibility-window promises remain unset unless approved | §4 below |

## 3. Product decisions with accepted safe defaults (build to the default; confirm in the owning phase)

| Decision | Safe default (summary) | Owning phase |
|---|---|---|
| [OD-01](../product/open-decisions.md#od-01) due date versus deadline | Decided in Phase 2B: due = internal target; deadline = external, explicit-only (date or instant); scheduling is a separate work block | 2B |
| [OD-08](../product/open-decisions.md#od-08) subtask depth | Decided in Phase 2B: `TASK_DEPTH_MAX` 20, database ceiling 64 | 2B |
| [OD-09](../product/open-decisions.md#od-09), [OD-10](../product/open-decisions.md#od-10), [OD-11](../product/open-decisions.md#od-11), [OD-12](../product/open-decisions.md#od-12) | One dependency family; follower/label canonical; one calculated-field type; Timeline ≠ Gantt as defined (OD-12 decided in Phase 3B: arrows and explicit dependency-aware rescheduling on Gantt; baseline deferred to 5C) | 2B, 2C, 3B |
| [OD-10](../product/open-decisions.md#od-10) followers (Phase 4A) | Implemented in Phase 4A: *follower* is one explicit, per-record subscription that is never inherited and grants nothing; a follow the person can no longer read is inert; notification preferences stay with 4B | 4A |
| [OD-38](../product/open-decisions.md#od-38) comment text after edit, delete, and purge | Implemented in Phase 4A: authors edit or delete only inside `COMMENT_EDIT_WINDOW_MINUTES`; edits and deletions keep the prior body in an append-only trail; moderators delete but never edit; audit keeps hashes only; purge removes the content | 4A |
| [OD-36](../product/open-decisions.md#od-36) notification retention (Phase 4B) | Stays open as a legal question; the technical bound `NOTIFY_RETENTION_DAYS` (default 365, configurable) ages notifications out unless saved, and purge and departure remove them sooner | 4B |
| [OD-18](../product/open-decisions.md#od-18) Today's zone and sections | Implemented in Phase 3C: the viewer's profile zone; committed and block-scheduled work, with overdue, due-today, and upcoming-deadline sections | 3C |
| [OD-19](../product/open-decisions.md#od-19) holiday calendars | Implemented in Phase 3E: manual brand holidays (`brand.configure`) plus personal holiday time off; a brand holiday applies to people who observe brand holidays and hold a reservation in that brand; feeds and connected calendars stay with 6C | 3E |
| [OD-26](../product/open-decisions.md#od-26) unlocking approved time | Implemented in Phase 3D: workspace admins only, step-up and a reason, audited unlock row, re-approval required; OD-20 self-approval applies to timesheet lines | 3D |
| [OD-28](../product/open-decisions.md#od-28) intake forms | Open; Phase 2E implements the deferred rule only (members-only, brand-owned forms) | 2E (blocker recorded) |
| [OD-29](../product/open-decisions.md#od-29) email capture | Open; 6A owns forwarding; 2E keeps the adapter-ready source kind | 2E (deferred to 6A) |
| [OD-17](../product/open-decisions.md#od-17) staleness and freshness | Decided in Phase 2D for tasks: meaningful-update definition; 7/14-day stale thresholds; 3 reschedules in 14 days; registered parameters | 2D |
| [OD-11](../product/open-decisions.md#od-11) formula versus calculated fields | Decided in Phase 2C: one formula field type over a typed AST with a fixed function registry; visible only where every input is visible | 2C |
| [OD-13](../product/open-decisions.md#od-13), [OD-14](../product/open-decisions.md#od-14), [OD-15](../product/open-decisions.md#od-15), [OD-16](../product/open-decisions.md#od-16) | Decided in Phase 2A: leaf-task count completion % (status-based until tasks exist); recurring project = schedule over an immutable planning-owned snapshot; structured decision record with decision and open-question kinds; explicit human verification as a separate fact | 2A, 2B, 5C |
| [OD-17](../product/open-decisions.md#od-17), [OD-18](../product/open-decisions.md#od-18), [OD-19](../product/open-decisions.md#od-19) | Configurable staleness; Today in viewer timezone; manual holidays | 2D, 3C, 3E |
| [OD-20](../product/open-decisions.md#od-20) self-approval | `auto` mode (0C AZ-12); confirm wording (AQ-16) | 4A, 8D, 9D |
| [OD-21](../product/open-decisions.md#od-21)–[OD-26](../product/open-decisions.md#od-26) | Verification and flaky policy; layered agent validation; low-impact classes; reported cost labelled; personal briefing corrections; admin-only unlock | 9C, 8D, 7E, 3D |
| [OD-27](../product/open-decisions.md#od-27)–[OD-33](../product/open-decisions.md#od-33) launch scope | No public links; brand-owned intake forms; personal email capture; optimistic document editing; keyword search; Markdown/HTML/PDF export; CSV-only import at launch | 2E, 4C, 4D, 5A, 6D |
| UX decisions marked PO or SA in [0E §3](../ux/09-decisions-and-risks.md#3-ux-decision-register) (UXD-01…27) | Their recorded defaults | As listed per UXD |

## 4. Legal, commercial, and customer promises still unset (product-owner approval required)

| Promise | Decisions | Behavior until approved |
|---|---|---|
| Recovery, grace, read-only, rollback, export-link periods | [OD-34](../product/open-decisions.md#od-34), [OD-35](../product/open-decisions.md#od-35), [OD-40](../product/open-decisions.md#od-40), DQ-30, PQ-15 | Parameters null; purge disabled; no published number |
| Retention by data class, legal holds, audit content, pseudonymization, billing retention | [OD-36](../product/open-decisions.md#od-36)–[OD-39](../product/open-decisions.md#od-39), DQ-31…DQ-34, DQ-38 | Retain until deletion; holds reserved; redaction on purge |
| AI provider data use | [OD-41](../product/open-decisions.md#od-41) | Contractually training-excluded providers only; publish nothing beyond contracts |
| RPO/RTO, SLOs, status page, region | [OD-42](../product/open-decisions.md#od-42), [OD-43](../product/open-decisions.md#od-43), DQ-35, PQ-13 | Measure in 11C; single region; no promise |
| Plans, seats, guests, lifetime offers, eligible plans, BYO keys, billing administration | [OD-44](../product/open-decisions.md#od-44)–[OD-46](../product/open-decisions.md#od-46), AQ-14, AQ-15 | Entitlements data-driven; no prices or limits in copy |
| Departed-member data export, break-glass support, public links, request access | AQ-07, AQ-08, AQ-12, AQ-13 | All off |
| API deprecation window, published rate limits, webhook retry and disablement promises, signed-URL residual acceptance | PQ-08, PQ-12, PQ-14, PQ-16 | Unset; signed-URL residual bounded by `SIGNED_URL_LIFETIME` (approved in principle) |
| Automatic workspace deletion after read-only; remote deletion on disconnect | DQ-36, DQ-37 | No automatic deletion; no remote deletion |

## 5. Implementation parameters and choices deliberately left unvalued

- **Named parameters** (names fixed, values owned by implementation phases):
  - the 0A periods: `TRASH_RECOVERY_PERIOD`, `WORKSPACE_DELETION_GRACE_PERIOD`, `CANCELLATION_READ_ONLY_PERIOD`, `PAYMENT_GRACE_PERIOD`, `IMPORT_ROLLBACK_PERIOD`, `EXPORT_LINK_LIFETIME`;
  - the 30 platform parameters in the [0D registry](platform/generated/registries.md#named-parameters-values-are-configuration-not-promises), for example `JOB_LEASE_DURATION`, `SSE_BUFFER_LIMIT`, `SIGNED_URL_LIFETIME`, `STEP_UP_WINDOW`, `TOTAL_COUNT_CAP`.

  Owner: PQ-05 by phase. The integration validator rejects any backticked parameter name that is not defined in one of these two places.
- **Choices deferred to the owning phase:**
  - DQ-20…DQ-29: partitioning, ranks, expression language, RRULE subset, search configuration, rich-text format, depth cap, job thresholds, secret-store vendor, decision-record structure;
  - AQ-06, AQ-09, AQ-10, AQ-11, AQ-17;
  - PQ-06, PQ-07, PQ-09, PQ-10, PQ-11.
- **Vendors** (hosting, email, payments, scanning, AI, error tracking, secret store) remain roadmap approval decisions ([RELEASE_TOPOLOGY.md](RELEASE_TOPOLOGY.md)).
