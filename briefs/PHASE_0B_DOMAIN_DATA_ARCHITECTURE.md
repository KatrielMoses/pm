# Developer Brief — Phase 0B: Domain and Data Architecture

## Objective

Define an implementation-ready domain and data architecture for the complete product scope. The result must give later developers one coherent PostgreSQL-oriented model for tenancy, brand ownership, record relationships, lifecycle, history, deletion/recovery, concurrency, and high-volume data without prematurely implementing application code or exhaustively specifying every UI field.

This brief consumes the accepted Phase 0A product contracts and the Phase 0E UX foundation. Where an unresolved product decision does not block the core architecture, model a reversible extension point and record the assumption. Do not invent customer-facing promises.

## Read first

- `FEATURES.md`
- `BUILD_ROADMAP.md`
- `ROADMAP_CHECKLIST.md`
- all files under `docs/product/`, especially `hierarchy-and-scope.md`, `lifecycle-and-states.md`, `time-and-scheduling.md`, `deletion-retention-history.md`, and the requirement catalog;
- all files under `docs/ux/`, especially the information architecture, interaction states, and resolved UXD-28 decision.

Treat decisions recorded in `ROADMAP_CHECKLIST.md` as approved architecture inputs. Do not edit `BUILD_ROADMAP.md`, mark checklist items complete, or overwrite accepted Phase 0A/0E contracts. If a contradiction is discovered, document it and propose a narrowly scoped amendment.

## Required deliverables

Create a coherent architecture set under `docs/architecture/data/`. Include a README that provides reading order and links all artifacts. Use diagrams and machine-readable definitions where useful.

### 1. Domain module map

Define domain modules, their responsibilities, owned entities, allowed dependencies, and integration boundaries. Cover at minimum:

- identity and accounts;
- workspaces, brands, memberships, teams, and grants;
- projects, tasks, workflows, statuses, custom fields, and relationships;
- Inbox, Today planning, scheduling, time, workload, and capacity;
- comments, mentions, following, notifications, documents, files, and deliverables;
- goals, portfolios, search, metrics, dashboards, and reports;
- integrations, API tokens, webhooks, imports/exports, and synchronization;
- AI actions, briefings, automations, agents, approvals, and usage/cost metering;
- test management, defects, environments, development links, and releases;
- billing, subscriptions, entitlements, onboarding, templates, administration, support, activity, and audit.

Keep this a modular monolith. Modules may share one PostgreSQL database, but ownership and write boundaries must be explicit. Identify which modules publish facts/events rather than writing another module's tables directly.

### 2. Canonical logical data model

Provide a complete logical entity model and relationship diagram. For every major entity, document:

- authoritative module and purpose;
- stable identifier strategy;
- tenant/scope keys (`workspace_id`, brand ownership where applicable, personal ownership where applicable);
- containment parent versus non-owning association;
- lifecycle and version/concurrency fields;
- creator, updater, source actor, timestamps, and provenance expectations;
- deletion/retention class;
- high-level cardinality and uniqueness rules;
- sensitive fields or data-classification concerns;
- expected high-volume or high-growth behavior.

Do not use one untyped universal-record table for unrelated domain data. Reusable primitives may be polymorphic only when referential integrity, authorization, query behavior, and deletion semantics remain enforceable.

### 3. Tenancy, brand scope, and sharing model

Prescribe the data invariants that enforce:

- every tenant record belongs to exactly one workspace;
- brand-owned records belong to exactly one brand in that workspace;
- tasks always have a brand and may omit a project;
- Inbox items may be personal and unbranded until triage;
- workspace-scoped documents, files, goals, templates, automations, and connections are valid;
- the all-brands view owns no data;
- containment never crosses brands;
- cross-brand associations require authorized creation and do not grant access;
- explicit cross-brand shares are revocable grants, read-only by default, exclude children unless selected, may expire, and never imply onward sharing or ownership changes;
- inaccessible relationship endpoints, counts, types, and derived conditions are not exposed;
- moving a record between brands is distinct from sharing and produces an auditable operation.

Show how database constraints, transaction-level validation, and the later policy layer divide responsibility. Do not falsely claim that PostgreSQL foreign keys alone can enforce every authorization rule.

### 4. Reusable relationship primitives

Design typed models for:

- containment and hierarchy, including project trees, task/subtask trees, and document page trees;
- dependencies/blocking and non-blocking related records;
- record links/mentions;
- followers/watchers;
- labels and label assignment;
- custom fields, field definitions, validated values, and calculated-field definitions;
- saved views and query definitions;
- comments, threaded replies, reactions, and review/approval requests;
- files, attachments, versions, deliverables, and evidence;
- external-record links and synchronization identity;
- templates and instantiated-from provenance.

For hierarchical records, prescribe cycle prevention, move behavior, ancestor querying, depth safeguards, and subtree operations. Choose a PostgreSQL-appropriate representation and explain the tradeoff; do not leave later developers to independently choose incompatible tree strategies.

### 5. Lifecycle, review, execution, and status representation

Model the accepted independent axes:

- lifecycle;
- configurable workflow status mapped to fixed categories;
- review/approval state;
- execution state and attempt history;
- verification/acceptance facts.

Show how claimed completion, task completion, accepted deliverables, code merge, deployment, defect verification, agent completion, and release approval remain separate facts. Failed, cancelled, timed-out, and partial execution must be structurally distinguishable from success.

Define how custom status transitions and required-field/approval rules can evolve without rewriting historical records.

### 6. Temporal and recurrence model

Define storage rules for:

- timestamped instants versus date-only floating values;
- user/workspace/brand timezones;
- due dates, deadlines, scheduled blocks, durations, estimates, and completion dates;
- recurrence rules, named recurrence timezone, occurrence identity, exceptions, and edits to one/future/all occurrences;
- working hours, holidays, time off, unavailable periods, and capacity reservations;
- time entries, timers, timesheets, approvals, and locked periods.

Preserve the Phase 0A semantic rule that moving scheduled work does not implicitly change a deadline.

### 7. Audit, activity, provenance, and immutable decisions

Separate operational domain state from append-only evidence. Define:

- material audit events with actor types: human, AI, automation, integration, agent, and system;
- user-facing activity projections;
- previous/new value capture without leaking secrets or excessive sensitive content;
- immutable approvals, go/no-go decisions, accepted deliverable versions, release decisions, and verification evidence;
- source/provenance for imported, integrated, AI-proposed, automated, and agent-created changes;
- correlation, causation, logical operation, attempt, and idempotency identifiers;
- retention classification and exportability.

Prescribe append-only behavior where historical truth is required while allowing privacy-driven redaction/purge workflows to be represented explicitly rather than silently rewriting evidence.

### 8. Archive, deletion, recovery, retention, and purge

Translate the accepted product semantics into a data design for:

- archive without deletion;
- soft deletion/trash;
- deletion batches for contained subtrees;
- restoration to prior state/location;
- tombstones and broken/removed associations;
- purge eligibility and durable purge jobs;
- account/workspace deletion workflows;
- retention policy references without choosing unapproved durations;
- cancellation read-only/export periods;
- object-storage cleanup and external-system data references;
- backups where purged data may remain until backup expiry.

Explain how queries exclude deleted data by default and how restore/purge operations remain idempotent and auditable.

### 9. Concurrency, consistency, and transactional boundaries

Define the concurrency strategy for ordinary edits, inline/bulk edits, drag/drop ordering, counters/rollups, collaborative-document metadata, approvals, timers, syncs, imports, automation/agent execution, and brand moves.

At minimum, cover:

- optimistic concurrency/version checks and conflict responses;
- operations that require locking or serialization;
- deterministic ordering keys and concurrent reorder behavior;
- transaction boundaries for multi-record invariants;
- idempotency records and logical-operation versus attempt identity;
- outbox/inbox foundations for reliable asynchronous effects;
- derived/read models and acceptable consistency lag;
- prevention of duplicate logical outcomes after retries.

Phase 0D will define public envelopes and job contracts; 0B must define the durable data foundations those contracts require.

### 10. PostgreSQL storage and scale guidance

Provide implementable PostgreSQL guidance for:

- schema/module organization and migration ownership;
- primary keys and public identifiers;
- foreign keys, uniqueness, check constraints, and tenant-consistency enforcement;
- indexes for tenant/brand filtering, active records, common date/status/assignee queries, and cursor pagination;
- JSON use only where flexibility is justified, with typed columns for high-value query and policy fields;
- full-text search source fields and indexing feed foundations;
- partitioning thresholds for append-heavy tables rather than premature partitioning;
- large audit, activity, notification, webhook, execution-attempt, and usage-meter tables;
- object-storage metadata and signed-access references;
- encryption-sensitive fields and credential separation;
- backup/restore and migration compatibility considerations.

Do not introduce Elasticsearch, Kafka, a separate vector database, or microservices. If a future extraction boundary is useful, describe the evidence that would justify it.

### 11. Data classification and ownership matrix

Create a matrix covering major entity families with:

- scope and owner module;
- confidentiality class;
- authorization sensitivity;
- audit requirements;
- retention/deletion class;
- export eligibility;
- expected volume;
- search/AI eligibility;
- whether content may contain secrets or regulated personal data.

Credentials and secret material must never live in ordinary application records, logs, search indexes, AI context, or broad exports.

### 12. Architecture decisions and unresolved questions

Record important choices as concise architecture decision records. Include considered alternatives and consequences for tree storage, polymorphic associations, custom fields, audit storage, outbox/inbox, ordering, search foundations, soft deletion, and public IDs.

Maintain an unresolved-questions register that distinguishes:

- blockers for Phase 0C;
- blockers for Phase 0D;
- decisions safely deferred to the owning implementation phase;
- legal/commercial/customer promises requiring product-owner approval.

## Prescribed architectural decisions

- Use managed PostgreSQL as the transactional source of truth.
- Use a modular monolith with explicit module ownership; do not design microservices.
- Use application-generated stable opaque public IDs. Internal key choice may be recommended with rationale, but identifiers must not encode tenant names or sequentially expose counts.
- Carry `workspace_id` directly on tenant-owned high-value and authorization-sensitive rows even when derivable through parents, and enforce consistency. This prevents unsafe joins and makes tenant filtering explicit.
- Carry `brand_id` directly on brand-owned high-value rows, including tasks, even when a project also supplies it.
- Do not implement authorization by cross-brand relationship traversal. Relationships never grant access.
- Keep business records typed. Avoid an entity-attribute-value model for core fields and avoid an unbounded universal `records` table.
- Use an outbox/inbox pattern foundation for reliable external effects and retried consumers.
- Use optimistic concurrency by default, escalating to locks only for defined invariants.
- Use soft deletion only where recovery is promised; immutable evidence and retention-controlled data require explicit treatment.

## Non-goals

- Do not implement production migrations, ORM models, APIs, services, UI, workers, or infrastructure.
- Do not exhaustively enumerate every presentation-only field from all 684 requirements.
- Do not define the final authorization algorithm or role matrix; Phase 0C owns it.
- Do not define final API/event/job envelope syntax; Phase 0D owns it.
- Do not select commercial vendors or publish retention/recovery promises.
- Do not alter accepted scope or silently resolve contradictions.

## Acceptance criteria

- Every major product domain in `FEATURES.md` appears in the module map and logical model.
- Entity scope and module ownership are unambiguous.
- Tenant and brand invariants are enforceable and consistent with accepted Phase 0A/0E decisions.
- The model supports workspace-scoped, brand-scoped, project-scoped, task-scoped, and personal records without overloading a single ambiguous ownership field.
- Cross-brand sharing, relationships, moves, and hidden-endpoint behavior are structurally distinct.
- Lifecycle, workflow, review, execution, verification, and acceptance remain separate axes/facts.
- Hierarchies have a prescribed cycle-safe, move-safe implementation strategy.
- Archive, trash, restore, purge, retention, and immutable evidence have coherent, idempotent data behavior.
- Concurrency and asynchronous reliability foundations are explicit.
- PostgreSQL constraints/indexes and scale guidance are concrete enough for later migrations without premature infrastructure.
- Documentation identifies assumptions and unresolved decisions rather than presenting guesses as approved facts.
- Internal links and any machine-readable diagrams or schemas validate successfully with a repeatable command.

## Required completion response

Return:

1. A concise architecture summary and the most consequential decisions.
2. Every file created or changed.
3. The module list and major entity-family count.
4. The chosen hierarchy, custom-field, audit, deletion, concurrency, and outbox strategies with brief rationale.
5. Validation commands and complete results.
6. Any contradiction found in accepted Phase 0A/0E contracts.
7. Open questions grouped by whether they block 0C, block 0D, or may wait for implementation.
8. Known limitations and deliberately deferred physical-design work.

Do not merely state that the work is complete; provide reviewable evidence.
