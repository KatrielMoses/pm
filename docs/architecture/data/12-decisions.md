# 12. Architecture decision records

Status of every ADR: **proposed (Phase 0B)**, pending solutions-architect acceptance. Each record follows the same structure: context, decision, alternatives considered, and consequences.

<a id="adr-01"></a>
## ADR-01: Modular monolith with schema-per-module ownership

- **Context:** The roadmap prescribes a modular monolith on one PostgreSQL database. 684 requirements span 30+ domains.
- **Decision:** 32 modules in 6 layers, one PostgreSQL schema each. Only the owning module writes its tables. Cross-module reads go through APIs or published views. Cross-module facts travel as outbox events. Dependencies may point only to the same or lower layers ([01](01-module-map.md)), and `datamodel.py` validates this.
- **Alternatives:** A single schema with naming conventions (ownership drifts and is unenforceable). Microservices (prohibited, and unjustified operational cost).
- **Consequences:** Ownership is checkable. Extraction stays possible. Cross-module transactions remain available where invariants need them, at the cost of discipline in using command APIs instead of direct SQL.

<a id="adr-02"></a>
## ADR-02: Internal UUIDv7 keys; random, prefixed public IDs

- **Context:** IDs must not encode tenants or reveal counts. Offline capture, imports, and idempotent creates need IDs before insert.
- **Decision:** Internal `uuid` primary keys generated as UUIDv7 by the application and never exposed. Public IDs are `<type>_<26 base32>` from 128 random bits, stored on `core.record` (or a `public_id` column for API-visible non-addressable rows), and never change.
- **Alternatives:** Bigint sequences (expose counts, and conflict on tenant moves or merges). Exposing UUIDv7 (leaks creation time). UUIDv4 as the primary key (poor index locality). Public ID = encoded internal ID (couples exposure to storage).
- **Consequences:** Two identifiers per addressable record. A lookup index on `public_id`. A safe basis for URLs, exports, webhooks, and imports.

<a id="adr-03"></a>
## ADR-03: Thin record envelope plus typed tables

- **Context:** Many primitives (shares, links, mentions, followers, labels, comments, attachments, custom values, search, reviews, tombstones) must reference "any addressable record" with integrity, scope, and lifecycle. The brief forbids an untyped universal records table.
- **Decision:** `core.record` holds only identity, scope keys, lifecycle, and provenance for 30 addressable types. Domain data lives in typed tables sharing the same `id`, bound by a deferrable composite foreign key on `(id, workspace_id, scope_key, lifecycle_state)`. High-volume child data is not registered.
- **Alternatives:** Per-pair join tables for every primitive (combinatorial growth, with no uniform lifecycle or tombstones). Polymorphic `(type, id)` without foreign keys (no integrity, orphaned rows). A universal domain table or entity–attribute–value model (prohibited; loses typing and query performance). Table inheritance (poor support for foreign keys and indexes across children).
- **Consequences:** One extra row and index per addressable record, and a hot table that needs good indexing. In return: real foreign keys for every primitive, uniform archive, trash, purge, and tombstones, public-ID resolution, and brand moves updated in one place.

<a id="adr-04"></a>
## ADR-04: Polymorphic associations through the envelope; exclusive arcs for small fixed sets

- **Decision:**
  - Associations to "any addressable record" reference `core.record(id)` with a composite foreign key including scope where containment applies.
  - Associations to a small fixed set of types use exclusive arcs (`num_nonnulls(a_id, b_id) = 1`). Examples: time entry → task or project; criteria item → task or project.
  - Typed `(kind, id)` references **without** foreign keys are allowed only in append-only evidence that must outlive its target (audit, activity, usage).
- **Alternatives:** `(type, id)` everywhere (no integrity). A separate table per pair (explosion of tables).
- **Consequences:** Referential integrity, query behavior, and deletion semantics stay enforceable, which is the brief's condition for polymorphism.

<a id="adr-05"></a>
## ADR-05: Trees as adjacency list plus materialized ancestor array

- **Decision:** `parent_id` + `ancestor_ids uuid[]` + `depth` maintained transactionally, with a GIN index on `ancestor_ids`. Structural changes take a per-root advisory lock, and cycle and depth checks run under that lock. One strategy for project, task, and document trees ([04 §4.1](04-relationship-primitives.md#41-hierarchies)).
- **Alternatives:** Closure table (more rows and writes). `ltree` (label encoding, extension dependency). Nested sets (expensive inserts). Recursive CTEs only (slow subtree operations and authorization joins).
- **Consequences:** Cheap ancestor and subtree queries, and moves that cost O(subtree) with bounded depth. Arrays cannot carry foreign keys, so integrity relies on the single maintained code path plus a periodic consistency check job.

<a id="adr-06"></a>
## ADR-06: Typed custom-field values

- **Decision:** `workflow.field_value` holds one row per (record, field), with one typed column per value kind, a `CHECK` that the right column is set, and per-type partial indexes. Definitions are immutable in type and retired rather than deleted. Calculated fields are materialized by a sandboxed interpreter with dependency-driven recompute.
- **Alternatives:** A `jsonb` bag on the record (no generic typed range filters or sorts without per-field expression indexes). Dynamic DDL columns per field (migrations per customer action, and lock risk). An untyped value table (loses typing).
- **Consequences:** Generic filtering and sorting with indexes, at one join per filtered field. Core fields are never custom fields.

<a id="adr-07"></a>
## ADR-07: Append-only audit table with explicit redaction; activity as projection

- **Decision:** `audit.audit_event` is written in the domain transaction, has no foreign keys to targets, and has UPDATE/DELETE revoked plus a guard trigger. Redaction goes only through a privileged procedure that writes `audit_redaction`. Optional per-partition hash chaining. `activity_item` is a rebuildable, display-safe projection.
- **Alternatives:** Audit via database triggers on every table (captures raw columns, including secrets, and misses actor and operation context). An external log service (splits the source of truth, and harder per-tenant export and redaction). Event sourcing for all domains (high complexity, not required).
- **Consequences:** Domain commands must emit audit explicitly, so the module APIs include it in the shared command pipeline. Storage grows fast, which is handled by partitioning when thresholds hit ([10 §10.9](10-postgresql-guidance.md#109-append-heavy-tables-and-partitioning)).

<a id="adr-08"></a>
## ADR-08: Transactional outbox, consumer inbox, external-effect ledger, database-backed jobs

- **Decision:** Facts are written to `execution.outbox_event` in the domain transaction. Consumers deduplicate through `inbox_receipt`. External side effects go through `external_effect` with a stable effect key. Safe destinations may receive retries and must deduplicate where supported; an unknown outcome at a destination that cannot deduplicate moves to `waiting` for human confirmation. Jobs use `execution.job` with `SKIP LOCKED`, leases, backoff, dead-letter, and per-workspace fairness caps.
- **Alternatives:** Kafka or Redis queues (prohibited at outset, adding operational cost and dual-write risk). Dispatching directly after commit (lost events on crash). LISTEN/NOTIFY alone (not durable).
- **Consequences:** At-least-once internal delivery with idempotent consumers, and provider-dependent external deduplication with explicit reconciliation for unknown outcomes. Exactly-once external delivery is never promised. Polling load on PostgreSQL stays small at expected volume. A broker can replace the dispatcher later without changing producers.

<a id="adr-09"></a>
## ADR-09: Fractional rank strings for manual ordering

- **Decision:** `rank text COLLATE "C"`, base-62 keys generated between neighbors, ordered by `(rank, id)` so equal ranks are deterministic, with background rebalancing when keys grow long.
- **Alternatives:** Integer positions (renumbering storms and contention). Floats (precision exhaustion). Linked lists (expensive reads, fragile under concurrency).
- **Consequences:** Concurrent drag-and-drop never blocks, and equal-rank ties are resolved deterministically.

<a id="adr-10"></a>
## ADR-10: PostgreSQL full-text search projection with query-time authorization

- **Decision:** `search.search_document` with weighted `tsvector`, GIN, and `pg_trgm` for quick search, fed by the outbox. Authorization predicates are applied in the query, and nothing ACL-related is copied into the index. `pgvector` is a later, optional addition in the same database (OD-31).
- **Alternatives:** Elasticsearch or OpenSearch (prohibited, with ACL synchronization risk). A separate vector database (prohibited). Searching base tables directly (couples search to every module's schema).
- **Consequences:** Revocations take effect immediately. Ranking quality is that of PostgreSQL full-text search, revisited in 5A with measurements.

<a id="adr-11"></a>
## ADR-11: Soft deletion only where recovery is promised; batches, tombstones, durable purge

- **Decision:** Lifecycle on the envelope, mirrored on typed rows. Archive and deletion batches for subtrees. Guarded idempotent restore. Purge as a resumable operation that leaves tombstones and redacts evidence explicitly. Evidence, execution history, and billing use retention classes instead of trash. All periods are read from `governance.retention_policy`, and a null period disables purge.
- **Alternatives:** A `deleted_at` column per table (no batches, inconsistent cascades). Hard delete plus restore from backup (no self-service recovery). Archive tables (copying breaks foreign keys and IDs).
- **Consequences:** Hot indexes must be partial on active rows. Read APIs default to active. Restoring from backup requires the purge-ledger replay ([08 §8.11](08-deletion-retention.md#811-external-systems-and-backups)).

<a id="adr-12"></a>
## ADR-12: Optimistic concurrency with field-level merge; locks only for named invariants

- **Decision:** Field-merge entities compare client base values per field. Other entities use row versions. Locks are listed exhaustively in [09 §9.3](09-concurrency-consistency.md#93-operations-that-lock-or-serialize), with a global lock order.
- **Alternatives:** Pessimistic editing locks (poor UX, stale locks). Last write wins (violates ST-02/ST-06). Per-field version columns (schema bloat).
- **Consequences:** The client must send base values for changed fields. The conflict response needs the last writer, which is available from `updated_by_*` or audit.

<a id="adr-13"></a>
## ADR-13: Tenant consistency by composite foreign keys; RLS as backstop

- **Decision:**
  - Every tenant table carries `workspace_id`. Brand-owned tables carry `brand_id`. Optional-brand tables carry a generated `scope_key`.
  - Every parent reference is a composite foreign key that includes the scope columns.
  - Row-level security on `workspace_id` via a transaction-local setting.
  - Brand, project, and record authorization stay in the 0C policy layer.
- **Alternatives:** Deriving tenant through joins (unsafe joins and slow filters). RLS for all authorization (hard to express grants and shares and to test, with planner cost and policy sprawl). Schema-per-tenant (operational cost at many small tenants).
- **Consequences:** Some wide composite indexes. A missed filter cannot cross tenants. Deferrable constraints let brand moves stay consistent.

<a id="adr-14"></a>
## ADR-14: Temporal storage types

- **Decision:** Instants as `timestamptz` with IANA-zone companions where local intent matters. Due and start dates as floating `date`. Deadlines as exactly one of date or instant+zone. Effort as integer minutes, tracked time as integer seconds. Recurrence as an RFC 5545 subset anchored to a zone, with occurrence keys ([06](06-temporal-model.md)).
- **Alternatives:** Everything as `timestamptz` (makes "due on Friday" depend on the creator's zone). Storing UTC offsets (breaks across DST). `interval` for effort (awkward aggregation).
- **Consequences:** Queries pass the evaluation zone explicitly, and the 0A semantics (viewer versus brand time) are preserved.

<a id="adr-15"></a>
## ADR-15: Shared operation/attempt model for all execution

- **Decision:** `execution.operation` (one logical outcome) and `execution.attempt` (tries) are shared by AI actions, agent runs, automation runs, syncs, imports, exports, bulk edits, brand moves, purges, template installations, report runs, and briefings. Each has a typed 1:1 detail table. One `exec_state` vocabulary with structured terminal reasons.
- **Alternatives:** Separate state columns per domain (divergent vocabularies, the risk 0A warned against). A generic job table only (no logical-outcome identity).
- **Consequences:** Uniform retry, cancellation, metering, success-rate metrics, and "never report failure as success". 0D builds its job contract on this.

<a id="adr-16"></a>
## ADR-16: Secrets outside application records

- **Decision:** Credentials and keys live in a secret store; the vendor is chosen later and must be managed. Application rows hold `*_secret_ref` only. Tokens are stored as hashes with display prefixes. Application-level envelope encryption is used for listed C3 fields.
- **Alternatives:** Encrypted columns holding secrets (keys and data in the same blast radius, with secrets appearing in backups and replicas).
- **Consequences:** The secret store's availability matters for integrations, which is handled by degraded mode (REL-013). Backups never contain usable credentials.

<a id="adr-17"></a>
## ADR-17: Immutable status categories and versioned workflow rules

- **Decision:** A status's category never changes, so `status_category` is denormalized onto records. Transition rules live in immutable revisions referenced by audit. Statuses and fields are retired rather than deleted while referenced.
- **Alternatives:** Join to the status table for every category filter (slower lists). Mutable categories (silently rewrite reports and history).
- **Consequences:** Changing a category is an explicit migration operation.

<a id="adr-18"></a>
## ADR-18: Viewer-specific derived conditions; no global relationship-derived columns

- **Decision:** Because hidden endpoints must be fully omitted (UXD-28), records never store viewer-independent derived conditions that come from relationships (blocked flags, dependency counts). Derived conditions are computed per viewer, with caches keyed by endpoint visibility scope ([03 §3.5](03-tenancy-brand-sharing.md#35-hidden-endpoints-counts-and-derived-conditions)).
- **Alternatives:** A denormalized `is_blocked` column (leaks existence across brands). Placeholder rows (rejected by the approved decision).
- **Consequences:** Somewhat more query work for boards and timelines. Correct and consistent omission across UI, API, search, AI, exports, and notifications.

<a id="adr-19"></a>
## ADR-19: Brand operational status is business metadata, distinct from lifecycle (Phase 1C amendment)

- **Decision:** `tenancy.brand.operational_status` (`brand_operational_status`) takes exactly `operating`, `paused`, or `planned`. It describes the business, not the record. Archive, trash, and purge stay in `core.record.lifecycle_state` (§8) and are never represented by operational status. A paused brand is fully active for authorization and lists; an archived brand is excluded from active scope whatever its operational status.
- **Alternatives:** One `status` column that mixes business state with archive (duplicates lifecycle state, and restore would need to guess the prior value). Free-text status (unvalidated, unreportable).
- **Consequences:** The database CHECK, the generated runtime vocabulary, API validation, and UI options all derive from this entity's key column. The integration validator fails if any of them diverges.

<a id="adr-20"></a>
## ADR-20: Personal navigation state and account preferences (Phase 1E amendment)

- **Decision:**
  - `favorite`, `recent_item`, and `view_state` are personal rows (workspace plus owner membership) in the `views` schema. Favorites and recents reference `core.record` through composite foreign keys and are unique per owner and target.
  - `view_state` is also keyed by a hash of an opaque per-device key and a registered view identity. Its JSON state is versioned, size-bounded, and allow-listed.
  - Appearance and input preferences (theme, density, motion, shortcuts, start destination, record opening, hidden destinations) live in the account-scoped `account_preference` entity, because they apply before any workspace is chosen. Device-local state (sidebar collapse, the per-device scope default, scroll anchors) is never stored there.
  - `view_pin` gives shared-view pins a schema and read path. No pin can exist until the view engine provides shared saved views.
- **Alternatives:** Workspace-personal preferences (theme unknown on sign-in and personal pages; one choice per workspace). Storing titles or brand names with favorites and recents (stale and leaky). Pixel scroll offsets (wrong after list changes).
- **Consequences:** Every entry is a hint re-authorized at display and activation, and unreadable targets are omitted silently. Personal rows are deleted with the membership's personal data (R-PERSONAL) and by the views cleanup job. Recent and view-state churn is never a material audit event.

<a id="adr-21"></a>
## ADR-21: Projects, hierarchy, and project structures (Phase 2A amendment)

- **Decision:**
  - **Collaborators.** Collaborator authority is project-scoped `access.role_assignment` only (view, comment, edit, manage). There is no project-member table. `work.project.owner_membership_id` is accountable responsibility, not authority. Creating a project, transferring ownership, or restricting it creates or keeps an explicit project manage grant for the responsible manager. A deferred guard keeps one eligible manager on every active project.
  - **Hierarchy.** At most one parent, in the same workspace and brand, never its own ancestor. The adjacency list stays authoritative, with `ancestor_ids` and `depth` (root = 0) maintained in the same transaction under tree-root advisory locks (ADR-05).
    - Commands enforce `PROJECT_DEPTH_MAX`. The database keeps a hard corruption ceiling of 32, which is an invariant, not a tunable parameter (closes DQ-26 for projects).
    - Project lifecycle commands never cascade to child projects. Purge is blocked while a live child references the parent.
  - **Phases.** The `phase` entity is addressable (`phs`) with the full lifecycle. Archive is reversible and distinct from trash, and keeps rank and history.
  - **Scope entries.** `scope_item` holds ordered scope, exclusion, risk, assumption, and constraint entries.
  - **Updates (OD-16).** `project_update` stays append-only. Verification is a separate append-only `project_update_verification` fact; authoring never verifies.
  - **Decisions (OD-15).** `decision_record` carries `kind` (decision or open_question) with kind-specific states: decision proposed, decided, superseded; question open, resolved (closes DQ-29).
  - **Statuses.** `platform_status` seeds the immutable project statuses Planned, Active, On hold, Completed, Cancelled until 2C adds workspace workflows.
  - **Project description.** `work.project.description_rich jsonb` holds rich text version 1 (0D PL-23), checked by `tenancy.valid_rich_text` (20,000 characters of extracted text). The 4C editor extends node and mark types without migrating stored descriptions.
  - **Share representation.** A project share's representation is the project plus its intrinsic facts (`criteria_item`, `scope_item`) and the latest verified update's content (0C AZ-21). No other `work` row is reachable through a share.
  - **Recurrence (OD-14).** `work.project` carries `recurrence_series_id` and `occurrence_key`. The planning module owns the series and validates the reference. The frozen snapshot lives in `planning.recurrence_series.template_payload`. `templates` (layer 4) may read and serialize `work`; `work` and `planning` never depend on `templates`.
  - **Provenance (PRJ-017).** Projects keep an optional validated intake source reference.
- **Alternatives:**
  - A `project_member` table with levels: a second authority source.
  - Owner as implicit authority: contradicts 0C I-10.
  - Mutating updates to mark verification: breaks append-only.
  - A document subtype for decisions: no structured states.
  - A recurrence foreign key to `template_version`: violates module layering.
- **Consequences:** Project visibility is compiled by the 1D policy compiler. Completion is derived from status in 2A and from readable leaf tasks from 2B (OD-13); nothing about it is stored as authority.

<a id="adr-22"></a>
## ADR-22: Tasks and relationships (Phase 2B amendment)

- **Decision:**
  - **Scope (OD-02).** Every task has one workspace and one brand; `project_id` is optional and, when set, in the same workspace and brand (composite keys). Cross-brand moves are explicit commands: a projectless task, or one moving together with a destination project in the target brand.
  - **Tree (OD-08).** Subtasks share workspace, brand, and project identity (both may be projectless). `ancestor_ids` and `depth` (root = 0) are maintained under lock-ordered commands; `TASK_DEPTH_MAX` (20) is enforced by commands and the database ceiling is 64. A move takes the whole subtree.
  - **Statuses.** `workflow.platform_status` seeds immutable task statuses Backlog (planned), To do (planned), In progress (active), Blocked (paused), Done (done), Cancelled (cancelled). `prior_status_id` keeps the reopen target.
  - **Dates (OD-01).** `start_date`, `due_date`, and a deadline stored as `deadline_date` or as `deadline_at` with `deadline_tz`. No schedule columns on tasks (3C work blocks).
  - **Assignees.** `work.task_assignee` holds active internal memberships with an ordered display and at most one primary (partial unique index). Assignment is responsibility, never authority.
  - **Checklists and criteria.** `work.checklist_item` (ordered facts). `work.criteria_item` gains `owner_kind = task` with kinds acceptance and definition of done; project definition-of-done items are inherited by evaluation, and `work.task_inherited_criterion` records whether each inherited item is met or explicitly dismissed.
  - **Labels (OD-10).** `work.label` (one brand) and `work.task_label` replace `relations.label` and `relations.label_assignment`.
  - **Links.** `relations.record_link` with `target_kind` url or record.
  - **Relationships (OD-09).** Task dependencies and related tasks use `relations.record_relationship` (`blocks`, `related`).
  - **History.** The 1F audit ledger is the task history; no history table.
  - **Description.** Rich text version 1 in `description_rich` (0D PL-23).
- **Alternatives:** Mandatory projects (contradicts TSK-003). Unlimited depth (unbounded rewrites). A task status table (a second status system). Copying project definition-of-done items into tasks (drifts from the source). A mutable history table (diverges from the audit ledger).
- **Consequences:** Task visibility is the 1D compiler's: project-contained tasks follow their project chain; projectless tasks follow the brand. Project completion becomes readable done leaf tasks over readable non-cancelled leaf tasks (OD-13).

<a id="adr-24"></a>
## ADR-24: Task interaction quality (Phase 2D amendment)

- **Decision:**
  - **Origin.** `work.task.origin_kind` is a closed kind (`manual`, `recurring`, `intake`, `import`, `integration`, `ai_draft`) with `origin_ref`, a JSON object of safe public identifiers only. A trigger refuses any change after insert; only a registered migration may rewrite them. `core.record.source_kind` keeps recording the creation channel.
  - **Recurring tasks.** `planning.recurrence_series.target_kind` gains `task`, plus an optional `project_id`. Occurrences are `work.task` rows carrying `(recurrence_series_id, occurrence_key)`, unique together, so generation is idempotent.
  - **Templates.** `templates.template.target_record_type` gains `task`; versions stay immutable rows.
  - **Reminders and snoozes.** `planning.task_reminder` (`rem_`) and `planning.task_snooze` are personal rows keyed by workspace, account, and task. They never reference or change task dates, status, or access. The planned `work.reminder` is replaced.
  - **Freshness.** `work.task.last_meaningful_update_at` is maintained by triggers on the task and its content tables (assignees, checklist, criteria, labels, links, relationships, custom field values) for the OD-17 meaningful changes only. Repeated rescheduling is counted from the audit ledger (`audit_event_by_target`), so there is no second history store.
  - **Bulk and undo.** `work.bulk_operation` (`bop_`) and `work.undo_entry` (`und_`) are short-lived, workspace-scoped, RLS-protected rows for the actor. `work.task_rank` is indexed per brand and project for ordering commands.
- **Alternatives:** Freshness computed from the audit ledger on every read (an unbounded scan per list). Snooze as a due-date edit (it would change shared dates). A generic command journal for undo (stores more than the inverse needs).
- **Consequences:** Two migrations, `0027_task_interaction` and `0028_task_bulk_undo`, with down migrations to 0026. No 3C work-block or 4B channel tables.

<a id="adr-23"></a>
## ADR-23: Configurable workflows and custom fields (Phase 2C amendment)

- **Decision:**
  - **One workflow system.** `workflow.workflow` (`wf_`) targets one record kind (project or task) at one scope (workspace, brand, or project); at most one active workflow per scope and kind. Resolution: project → brand → workspace → platform default. `workflow.platform_status` stays the immutable default and is never copied.
  - **Statuses.** `workflow.workflow_status` (`sts_`) rows belong to one workflow and carry exactly one fixed category. A record's `status_id` references a platform status or a workflow status. A trigger checks it on every write: the status belongs to the record kind, and a newly chosen custom status belongs to the workflow that currently applies. A delete guard refuses removing a status in use. `status_category` stays denormalized and guarded.
  - **Transitions.** `workflow.transition` (`trn_`) rows replace the planned `workflow_revision` snapshot. Requirements (`transition_requirement`) and named approvers (`transition_approver`) are child rows. Approval requests bind to a transition version.
  - **Approvals.** `workflow.approval_request` (`wap_`) and `workflow.approval_decision` are append-only facts. A request records the record version, transition and version, fingerprint, requester, approvers, and expiry; its only mutation is a one-time close (`applied` or `withdrawn`).
  - **Fields.** `workflow.field_definition` (`fld_`) carries the immutable type, typed `config`, presentation, applicability (`always` or `via_set`), view-visibility metadata, and, for formulas, the AST, version, and result type. `calculated_field_definition` is folded into the formula type (OD-11); `formula_dependency` stores explicit edges. Broader-scope fields accumulate unless shadowed by the same `lineage_id`.
  - **Values.** `workflow.field_value` is the one value relation (definition, record). It holds validated typed JSON plus normalized typed columns, workspace and brand roots, version, updater, and RLS. Currency is integer minor units plus an ISO 4217 code. Formula results are computed rows with a typed error code.
  - **Field sets.** `workflow.field_set` (`fst_`), immutable `field_set_version`, and `field_set_attachment` (lineage, not a copy). Upgrades are explicit.
  - **Field visibility.** `access.field_policy` (0C §7.1) is implemented for custom definitions.
- **Alternatives:** A JSON blob of transitions per revision (it cannot carry foreign keys to statuses, fields, or approvers). A column per custom field (unbounded schema churn). A separate calculated-field entity (two engines).
- **Consequences:** Two migrations, `0025_workflow_configuration` and `0026_custom_fields`, with down migrations to 0024. Imports and exports (6D) serialize through the canonical field schema (WFL-014).
- **Corrective review 01 (2C):** configuration mutations record deterministic before/after snapshots in the audit ledger (07 §7.3.1). Values of hidden fields are never projected to readers who cannot read them.
