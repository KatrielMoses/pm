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

<a id="adr-26"></a>
## ADR-26: Saved views, defaults, and pins (Phase 3A amendment)

- **Decision:**
  - **Saved views.** `views.saved_view` (`view_`) is a workspace-level record (its `core.record` brand is NULL, because record scope is immutable). It stores the entity (task or project), the name, the owner (its creator), and the visibility (personal or shared). A shared view names exactly one scope through `share_brand_id` and `share_project_id`. Its query is the canonical serialization of the versioned AST (at most 32 KiB) with a separate presentation (columns, density; at most 8 KiB). Layout is `list` until 3B adds others. Concurrency is row-version.
  - **Defaults.** `views.view_default` holds one row per (target kind, target, entity), for a member, a brand, or a project, pointing to a saved view.
  - **Pins.** `views.view_pin` (1E) gains its write path. A trigger keeps every pin on a view shared with the pin's own scope.
  - **View state.** `views.view_state` gains keyed families (`views.saved.<view id>`, `views.draft.task|project`) under one allow-listed schema.
  - **Lifecycle.** Delete is a lifecycle trash. Views shared with a brand purge with it. Views shared with a project are that project's content. Pins and scope defaults go with any change of share.
- **Alternatives:**
  - Brand-scoped view records: a share could not change scope without changing an immutable record scope.
  - A view per share scope: duplicate definitions that drift.
  - Storing query results: they would freeze and widen access.
- **Consequences:** One migration, `0031_saved_views`, with a down migration to 0030. No 3B layout tables, 3C planning, or 6D export-job tables.
<a id="adr-33"></a>
## ADR-33: Documents and knowledge (Phase 4C amendment)

- **Decision:**
  - **Documents.** `knowledge.document` (`doc_`) is a record in the core envelope: workspace-scoped (no brand) or brand-scoped, optionally attached to one project or one task, and nested under at most one parent page. A page lives in its parent's scope and attachment (checked at commit), the tree is bounded by `DOCUMENT_DEPTH_MAX`, `DOCUMENT_CHILDREN_MAX`, and `DOCUMENT_TREE_MAX`, and a move never enters the page's own subtree. Authority is the placement's; restricted document trees are not built in 4C.
  - **Content and versions.** Content is rich-text version 2: ordered blocks with stable identifiers (paragraph, heading, lists, checklist, quote, code, table, divider, callout, embed), validated and normalized by the server, and hashed in a canonical form so equal content has an equal hash. `knowledge.document_version` (`dcv_`) is immutable (a trigger refuses updates; the application role inserts and reads only). A save names its base version, a stale base conflicts, equal content is a no-op, and a restore appends a new version holding the chosen content.
  - **State, owner, review.** A document is draft, current, or stale (stored) and may be archived through the record lifecycle. `effective_state` reports stale when a current document's review date has passed; the stored state is never rewritten. The owner is an active member who can edit it.
  - **References.** `knowledge.document_reference` holds the content's inline mentions (rebuilt on every save) and the document's explicit record links, with no label. A viewer who cannot read a target receives an opaque restricted token, never an identifier, and a save restores what the token stands for.
  - **Suggestions and approvals.** `knowledge.document_suggestion` (`dsg_`) proposes replacing one block against the version and block hash it saw; it is applied only to an unchanged block. `knowledge.source_approval` is an append-only fact that one version is (or is no longer) an approved AI source.
  - **Starters.** Built-in typed starters are versioned constants recorded on the first version; there is no template catalog (10B).
- **Alternatives:** Titles or labels stored beside references (stale and leaky after revocation). Overwriting the current content with a history table beside it (a silent overwrite window). Restricted document trees in the shared visibility compiler now (a change to every record query). A stored `stale` state rewritten by a job (a fabricated history).
- **Consequences:** Migration `0038_documents` with an exact 0037 rollback. All new tables have workspace RLS; versions and approvals are append-only to the application; purge removes a document's versions, references, suggestions, approvals, comments, and notifications.
<a id="adr-36"></a>
## ADR-36: Search projection, indexing queue, and recent searches (Phase 5A amendment)

- **Decision:**
  - **Projection.** `search.search_document` is one row per searchable source row (`source_kind`, `source_id`), keyed by that pair within the workspace. It holds the title, the body text (at most 100,000 characters), an optional owner, the source's update time, and a generated `tsv` (the `simple` and `english` configurations indexed together, the title weighted above the body). It holds **no** brand, project, lifecycle, or permission key: `auth_record_id` names the record whose access governs it (itself, or the host of a comment, a file, or a deliverable) and `context_record_id` the record that opens it, and both are read live. This refines §10.7, which sketched a projection carrying scope and permission keys; a copied key cannot honour revocation (I-12).
  - **Queue.** `search.index_status` holds one key per source row whose projection is stale (`pending`, or `failed` once the allowed attempts are used), with its attempts, the next attempt time, and a short failure class, never a message. Triggers on the source tables write the key in the source's own transaction; the worker drains it. §10.7's "fed by outbox consumers" is replaced because events carry no content and are not emitted for every change.
  - **Recent searches.** `search.recent_search` is the person's own submitted query (at most 200 characters) and its filters (brand and project by public identifier), unique per normalized query and filters, with a count and a time. It is personal data (R-PERSONAL): erased with the person's other personal data, swept after the retention period, and never audited.
  - **Registered kinds.** `source_kind` is validated by shape in the database and by an adapter registry in code, so a later phase adds a source without a schema change.
  - **Deletion.** Deleting a source row, and tombstoning a purged record, remove the projection rows (and queued keys) of the row and of everything it hosts, by trigger in the same statement.
  - **No GIN index.** Under forced row-level security the full-text operator cannot use one (it is not leakproof, and no role may mark it so), so none is created; see engineering decision S14 of Phase 5A for the bound and the upgrade path.
- **Alternatives:** Permission keys copied into the projection (stale after every share, move, and role change). An outbox consumer (misses edits that emit no event, and cannot backfill). A definer function that reads the projection outside row-level security to regain the index (a new privileged read path). Offset paging (§10.5 forbids it for user lists).
- **Consequences:** Migration `0041_permission_aware_search` with an exact 0040 rollback. All three tables have workspace RLS and indexes on every foreign key; the worker holds write grants, the API read grants (and write grants on recent searches only).
<a id="adr-37"></a>
## ADR-37: Goals, key results, check-ins, links, and portfolios (Phase 5B amendment)

- **Decision:**
  - **Records.** `goals.goal` (`goal_`), `goals.key_result` (`kr_`), and `goals.portfolio` (`pf_`) are records in the core envelope. A goal is workspace-, brand-, or project-scoped (a project goal names a project of its brand), a key result lives in its goal's scope, and a portfolio is workspace- or brand-scoped. Access is the placement's: the workspace or brand level, and the governing project chain for a project goal. A goal or portfolio is never shareable, and a guest or share-only reader has no access to either. No row copies anyone's access.
  - **Periods and measurement.** A goal has an owner, a calendar period (quarter, half, year, or custom of at most 3660 days; no fiscal calendar), a status (draft, active, achieved, missed, cancelled), and one progress basis: `manual` (a measured value against a baseline and target, or a percentage), `key_results`, or `linked_work`. Values are bounded decimals. The direction of a goal is the order of its baseline and target.
  - **Check-ins.** `goals.goal_checkin` (`gci_`) is append-only (a trigger refuses updates, and the application role has no update or delete). A manual check-in carries a value or percentage, an optional confidence (a check-in that states none keeps the last stated one), and a note. The goal's and key result's `latest_*` columns move with the check-in in one transaction. A `computed` check-in is appended only when the inputs hash of the goal's manual key results changes (unique per goal and hash).
  - **Links.** `goals.goal_link` associates a goal, or one of its key results, with a project or a task. The linker must be able to read the target. A brand goal links only its brand's work and a project goal only tasks of its project (checked by a trigger). A link grants no access and implies no progress for work a viewer cannot read.
  - **Derived state.** `goals.goal_state` (one per goal) stores only viewer-neutral facts: update and period state, the rollup of manual key results, the inputs hash, and the dirty, due, lease, attempt, and error bookkeeping. Nothing derived from linked work is stored (a goal that depends on linked work is `viewer_dependent` with no number): progress, health, dependencies, budgets, effort, and orphan findings over work are computed at read time for the viewer from the work that viewer may read.
  - **Portfolios.** `goals.portfolio_project` is an explicit, bounded list of project identities. A brand portfolio holds only its brand's projects (checked by a trigger). Members an editor cannot read are preserved by an edit but never listed or counted for them.
  - **Deletion.** Archive, trash, and restore of a goal carry its key results. Purge of a goal deletes its key results, links, check-ins, and state; purge of a project or task removes the links and portfolio memberships that name it.
- **Alternatives:** Storing progress, health, or counts per goal or portfolio (they would freeze one viewer's view and disclose hidden work to the next). A shared goal or portfolio (a second access path to the work it summarizes). Mutable check-ins (a rewritable history). A separate access table for goals (a second source of authority). Weighting progress by estimates (5C's metric decision).
- **Consequences:** Migration `0042_goals_portfolios` with an exact 0040 rollback. All seven tables have workspace RLS and indexes on every foreign key; the worker may recalculate state and append computed check-ins, and a payload-free `SECURITY DEFINER` discovery lists only the workspaces with goals due for recalculation.
<a id="adr-38"></a>
## ADR-38: Task status history and its reconciliation state; metric definitions and snapshots (Phase 5C amendment)

- **Decision:**
  - **Status ledger.** `metrics.task_status_span` is the append-only history of each task's status: one row per span (`task_id`, `seq`, `status_id`, `status_category`, `entered_at`, `left_at`, `basis`), keyed by `(workspace_id, task_id, seq)`, with at most one open span per task (a partial unique index). Triggers on `work.task` write it in the task's own transaction (creation opens a span; a change of status or status category closes the open span and opens the next), and deleting a task, or tombstoning a purged record, deletes its spans in the same statement. `basis` is `recorded`, `assumed` (written by the migration for a task that predates the ledger), or `repaired` (written by reconciliation, starting when the disagreement was found). The ledger holds **no** brand, project, lifecycle, or permission key: every read joins `auth` to the task's `core.record` and applies the compiled visibility predicate. This is the one stored input of the metrics model; everything else is computed from the records at the time of the request.
  - **Reconciliation state.** `metrics.reconcile_state` is one row per workspace with tasks: the time the next bounded pass is due, a lease, the keyset position of a pass in progress, the repairs of the pass and in total, the attempts, the last success and failure, and a short failure code (`source_error` or `timeout`), never a message. It holds times, counts, and a code, never record content.
  - **`metric_definition` is a registry, not a table.** A definition is executable (it names the computation), so it lives in a versioned code registry; each released version has a pinned SHA-256 digest that every result carries. A released definition is never edited: a change of meaning is a new version. The entity keeps its purpose (versioned, immutable, with provenance) and its requirements (RPT-023, RPT-024) with the digest as the provenance.
  - **`metric_snapshot` is not built in 5C.** A pre-aggregated value per scope cannot be shared between viewers without disclosing what some may not read, and a per-viewer copy would be a second, stale authority. A report that must freeze a figure (5D `report_run`) stores the result computed as its recipient, with the definition digest.
  - **Schema.** The new tables live in a `metrics` schema (module `metrics`), so the `insights` schema of dashboards and reports (5D) is created once by its own phase.
- **Alternatives:** Deriving status time from the audit ledger (status keys, not categories, and a rename or a workflow change would rewrite history). A stored count per scope (frozen for one viewer, disclosing to the next). A definitions table (a copy that can drift from the code that computes it). Letting the application write spans (a path that bypasses it leaves a gap).
- **Consequences:** Migration `0043_metrics_model` with an exact 0042 rollback. Both tables have workspace RLS and indexes on every foreign key; the API role reads them and may only move `next_run_at`, the worker reads, inserts, updates, and deletes them. Existing tasks receive one `assumed` span.

<a id="adr-35"></a>
## ADR-35: Live editing drafts, sessions, and operations (Phase 4D amendment)

- **Decision:**
  - **Drafts.** `knowledge.edit_draft` is at most one row per document: the working block list (validated content version 2, canonical hash), the version it was opened from (`base_version`), the last sequenced operation (`seq`), the `seq` of the last checkpoint, and whether it holds operations no version contains (`dirty`). It is never a version and never read by exports, restores, suggestions, or reviews.
  - **Sessions.** `knowledge.edit_session` is one live connection of one member to one document: an unguessable `session_key` (not an identifier of any record), mode (`edit` or `view`), a colour index, the block the person is in, and an expiry renewed by every heartbeat, poll, or operation. An expired row is never read; it is deleted on leave, by the next join to the same document, and on purge (a document holds at most `LIVE_SESSIONS_MAX` live ones). Nothing here is audited.
  - **Operations.** `knowledge.edit_op` is the ordered, gapless log of accepted block operations (`insert`, `replace`, `delete`, `move`) with the client's `op_id` (unique per member, so a retry is idempotent) and the block it names. Rejected operations are never stored. The log is pruned beyond `LIVE_OP_LOG_MAX` at each checkpoint; a client whose position is older receives a snapshot instead.
  - **Checkpoints.** A checkpoint appends one ordinary `document_version` through the save path (canonical content, references, audit `document.saved` with the contributor count, event `knowledge.document.version_saved`, mentions). `edit_draft.checkpoint_seq` records it.
  - **Deletion.** Purge removes a document's operations, sessions, and draft with it, before its versions.
- **Alternatives:** A CRDT state column (the history is a second, unauditable source of truth and carries hidden content). Storing presence in memory only (no recovery across API instances). Auditing operations (keystroke surveillance with unbounded growth).
- **Consequences:** Migration `0040_collaborative_editing` with an exact 0039 rollback. All three tables have workspace RLS and indexes on every foreign key.
<a id="adr-34"></a>
## ADR-34: Files, versions, upload sessions, and deliverables (Phase 4E amendment)

- **Decision:**
  - **Objects.** `files.file_object` is one stored object per upload: an identifier-free key (`q.{64 hex}` while quarantined, `o.{same}` once promoted; a check constraint ties the prefix to `quarantined`), its SHA-256, size, content type, and scan state (`pending`, `clean`, `infected`, `error`). A clean object is never quarantined. An infected object keeps its signature internally and is never shown it; its bytes are deleted. Rows never hold a URL.
  - **Files and versions.** `files.file` (`file_`) is addressable and hangs on exactly one host: the workspace (no brand), a brand, a project, a task, or a comment (its record plus `comment_id`); `scope_key` is the brand, else the workspace. `files.file_version` is immutable (a trigger refuses every change except setting, never clearing, the evidence lock and the preview state): it points at an object or at an external `http(s)` URL that is never copied or fetched. Versions are numbered per file up to `FILE_VERSIONS_MAX`.
  - **Upload sessions.** `files.upload_session` (`upl_`) records the declared name, type, size, checksum, host or target file, its quarantine key, state (`initiated`, `uploaded`, `verifying`, `completed`, `rejected` with a code, `expired`), and expiry (`UPLOAD_SESSION_LIFETIME`). A version exists only on a completed session.
  - **Deliverables.** `files.deliverable` (`dlv_`) is a task's designated output with an expected type (`any`, `file`, `url`; TSK-022) and a state (`draft`, `ready_for_review`, `changes_requested`, `accepted`, `rejected`). `files.deliverable_version` (`dv_`) is one submission (a file version or a URL), linked to its 4A review request; a later submission supersedes an open one. Acceptance records the deciding `collab.review_decision`, who accepted, and when, and locks the version (a trigger refuses every change to a locked row). `collab.review_request.subject_kind` gains `deliverable`.
  - **Usage.** `files.storage_usage` holds a workspace's used and reserved bytes and object count, locked (`FOR UPDATE`) while an upload reserves bytes against `WORKSPACE_STORAGE_QUOTA_BYTES`.
  - **Deletion.** Files and deliverables trash, restore, and purge with their host through the 1F lifecycle. Purge removes rows except evidence-locked versions (R-EVIDENCE) and records each orphaned object as an `object:{key}` external effect that the file sweep deletes. `exec_dispatch.discover_file_work` lists workspaces with expired sessions or pending object deletions, without payloads. Retention periods stay undecided (OD-36).
  - **Not built.** `files.evidence_item` (9B) and agent artifacts as deliverable sources (8C) are not created; no derived preview, thumbnail, or transcoded copy is generated, and no storage class is recorded.
- **Alternatives:** Keys carrying workspace or file identifiers (they leak through URLs and provider logs). Mutable versions (lost history and evidence). A deliverable review state separate from 4A reviews (two decisions for one acceptance). Counting usage on the fly (races between concurrent uploads).
- **Consequences:** Migration `0039_files_deliverables` with an exact 0038 rollback. All seven tables have workspace RLS and indexes on every foreign key.
<a id="adr-32"></a>
## ADR-32: Notification platform (Phase 4B amendment)

- **Decision:**
  - **Notifications.** `notify.notification` (`ntf_`) is one row per recipient and event: type, record, actor, a deduplication key, and small scalar facts (identifiers and counts, bounded by `NOTIFY_FACTS_MAX_BYTES`), never a title or body. The summary is rendered when it is shown, from what the recipient can read then. Repeats inside `NOTIFY_DEDUPE_WINDOW_MINUTES` collapse into one row with an occurrence count and reopen a read or dismissed row; a saved row stays saved. Rows age out after `NOTIFY_RETENTION_DAYS` except saved ones.
  - **Deliveries.** `notify.delivery` (`ndl_`) is one email or browser delivery of a notification or a digest, with a state machine: pending, sending (leased), delivered, failed, dead, suppressed (with a reason), deferred for quiet hours, and expired. Delivered means the provider (or the person's own browser) acknowledged it. Failures have a class (transient, permanent, unconfigured, rate limited) and a bounded code; retries back off exponentially up to `NOTIFY_DELIVERY_MAX_ATTEMPTS` and then dead-letter. Retries reuse the delivery's own id as the provider message id.
  - **Preferences.** `notify.preference` is a person's choice per event type (or all), channel (or all), and scope (workspace, brand, project, or record), as immediate, digest, or muted, optionally expiring. `notify.scope_default` is a brand or project default, ranked below every personal choice. `notify.profile` holds the person's time zone source, quiet hours, digest cadence and times, channel switches, and browser permission.
  - **Digests.** `notify.digest` is one bundle per person, cadence, and period (unique), assembled with items re-authorized at assembly and again when sent. A person has one cadence (off, daily, or weekly), so one digest carries each item.
  - **Discovery.** `exec_dispatch.discover_notification_work` lists the workspaces with due work without payloads, like the other schedulers.
- **Alternatives:** Titles on the row (stale, leaky). One delivery row per attempt (unbounded growth; attempts are a counter and the audit trail). A separate muted-scope table (mutes are preferences with mode `muted`). Two digest cadences at once (a duplicate of every item).
- **Consequences:** Migration `0037_notifications` with an exact 0036 rollback. All new tables have workspace RLS; deliveries and notifications of a purged record or a departed person are removed with them.
<a id="adr-31"></a>
## ADR-31: Comments, mentions, followers, reviews, and assignment history (Phase 4A amendment)

- **Decision:**
  - **Comments.** `collab.comment` (`cmt_`) hangs on one host record (a task or a project until later phases register more) and is authorized through that host on every read. Threads are flat: a root, and replies naming the root and the comment they answer. A body is rich-text version 1; `body_text` is its extracted plain text. Deleting is a tombstone: the body leaves the row, and the row keeps its author, time, and place in the thread.
  - **Revisions (OD-38).** `collab.comment_revision` is append-only. It holds the prior body of every edit and of a deletion. Authors edit or delete only within `COMMENT_EDIT_WINDOW_MINUTES`; moderators (manage on the host) delete but never edit. Purge removes bodies, revisions, reactions, and mentions with the host; audit events keep content hashes only.
  - **Reactions.** `collab.reaction` has one row per comment, person, and reaction from a fixed vocabulary of eight.
  - **Mentions.** `relations.mention` references a comment's person, team, or record targets through typed foreign keys (exactly one target column), keeps their order, and carries `notified` for 4B. Document and record-field sources arrive with 4C.
  - **Followers (OD-10).** `relations.follower` is one explicit subscription per person and record, with source `explicit`. It is never derived and grants nothing.
  - **Reviews.** `collab.review_request` (`rvw_`) targets one record at one version, with a kind (`review` or `approval`), a rule (`any` or `all`), and a state. At most one request per record is open (partial unique index). `collab.review_reviewer` names the reviewers (active internal members, trigger-checked). `collab.review_decision` has one immutable decision per named reviewer, so the single terminal decision of the Phase 0 sketch becomes one decision per reviewer with a request that settles at most once.
  - **Assignment history.** `collab.assignment_event` is append-only (assigned, unassigned, reassigned, delegated; via assign, delegate, or departure). `work.task_assignee` gains `delegated_from_membership_id` and `delegated_at`.
- **Alternatives:** Hard-deleting comments (breaks threads and audit). Storing bodies in audit (privacy and OD-38). Deriving followers from assignment or membership (notification noise and disclosure). A single decision column on the request (cannot express the `all` rule). Brand identifiers on comments (they would go stale on brand moves; the host row owns the brand).
- **Consequences:** Migration `0036_collaboration_reviews` with an exact 0035 rollback. All new tables have workspace RLS; the application role cannot delete comments, revisions, decisions, or assignment events, and the worker purges them with their host.
<a id="adr-30"></a>
## ADR-30: Working hours, time off, brand holidays, and capacity reservations (Phase 3E amendment)

- **Decision:**
  - **Capacity profile.** `planning.capacity_profile` holds one row per membership: an optional weekly capacity override (`weekly_capacity_minutes`, 0 to 10080), whether the person observes brand holidays (default yes), and a row version.
  - **Working hours.** `planning.availability_rule` holds local wall-clock windows per weekday (1 Monday to 7 Sunday, minutes `[start, end)`). A guard trigger refuses overlapping windows on one weekday. Windows are evaluated per date in the person's own zone (`identity.account.timezone`, else the workspace calendar zone), so DST days have their real length.
  - **Time off.** `planning.time_off` (`tof_`) is personal: a kind (`vacation`, `sick`, `personal`, `holiday`, `unavailable`), either all-day local dates (inclusive, read in `source_tz`) or timed UTC instants, and an optional label.
  - **Brand holidays.** `planning.holiday` (`hol_`) is one manual holiday per brand and day (OD-19). It removes a person's day only when the person observes brand holidays and holds a reservation in that brand covering the day.
  - **Reservations.** `planning.capacity_reservation` (`rsv_`) is a weekly planning target for one person in one brand (`minutes_per_week`, `effective_from`, optional `effective_to`, `set_by`, version). It warns and never blocks. A new reservation from a later date closes the open one the day before.
  - **Nothing cached.** Availability, allocation, and conflicts are computed on read from these rows, 3C blocks and commitments, and 3A-visible estimates. No capacity snapshot is stored.
- **Alternatives:** Storing availability per day (it would drift with zone and rule changes). Holidays as time-off rows per person (one brand edit would fan out to many personal rows). Reservations as hard limits (TIME-002 says they are targets).
- **Consequences:** Migration `0035_capacity` with a down migration that restores 0034 exactly. All five tables use workspace RLS. No external holiday feeds or connected calendars (6C), and no AI rescheduling (7F).

<a id="adr-29"></a>
## ADR-29: Today, work blocks, and daily records (Phase 3C amendment)

- **Decision:**
  - **Commitments.** `planning.today_commitment` is a person's choice to do one task on one local day (the viewer's zone, OD-18): manual order (`rank`), `locked`, and an outcome (`open`, then `done`, `carried` with the target day, `returned` to the backlog, or `dropped`). Committing never changes the task. A closed commitment is final (guard trigger). One per person, day, and task.
  - **Work blocks.** `planning.work_block` (`blk_`) is calendar time reserved to do work: UTC instants in whole minutes (5 minutes to 24 hours) with the zone they were entered in, an optional task (its brand cascades with the task), or a personal title; `focus`, `locked`, preparation and buffer minutes, and a source (`manual`, `estimate`, `recurrence`). Blocks are distinct from due dates and deadlines and never change them.
  - **Focus protection.** No block may overlap a focus block of the same person, preparation and buffer included; a guard trigger repeats the rule under a per-person transaction lock.
  - **Recurring blocks.** `planning.block_series` (`bls_`) holds a rule in the 2A RFC 5545 subset, an anchor zone, a local start, a duration, and block settings. Occurrences are work blocks keyed `(series_id, occurrence_key)` (the local date-time), generated idempotently through `BLOCK_SERIES_HORIZON_DAYS`; local time is stable across DST.
  - **Daily records.** `planning.daily_record` is written once per person and day (at shutdown or by the day-close job): committed, completed, carried, returned, and dropped counts that always add up; planned minutes (estimates) with unestimated items counted; block and focus minutes; actual seconds from 3D time entries; and an item snapshot. It is never updated.
  - **Deviation.** `work_block` keeps its public ID but does not use the core record envelope in 3C (no trash); the seeded record type stays reserved for 6C calendar sync.
- **Alternatives:** Reusing `recurrence_series` for blocks (it requires a brand; personal blocks may have none). Changing due dates when blocks move (contradicts CAL-013). Rewriting daily records after later edits (PLAN-019 says snapshots are not rewritten).
- **Consequences:** Migration `0034_today_planning` with a down migration to 0032. No working hours, capacity, holidays, calendar events, or AI plans (3E, 6C, 7F).

<a id="adr-28"></a>
## ADR-28: Core view layouts (Phase 3B amendment)

- **Decision:**
  - **Layout field.** `views.saved_view.layout` accepts the core layouts, and a second check ties each to its entity.
    - Tasks: list, board, table, calendar, timeline, Gantt, workload, activity, and timesheet.
    - Projects: list, board, table, calendar, timeline, Gantt, milestones, portfolio, and activity.
  - **Layout options** are presentation keys: board field, calendar date field and mode, timeline zoom, and workload bucket.
  - **No new tables.** A layout never stores rows, schedules, or aggregates.
  - **Facts from existing data.** Workload totals, Gantt dependencies, milestones, portfolio progress, a person's own time, and activity are read from existing tables (`work.task`, `relations.record_relationship`, `work.milestone`, `timetrack.time_entry`, `audit.audit_event`) for records the same authorized query returns.
  - **Scheduled work** (work blocks) remains 3C's table.
- **Alternatives:**
  - Per-layout tables or materialized summaries: a second source of truth that could drift or leak.
  - A separate view type per layout: duplicate definitions.
- **Consequences:** One migration, `0033_core_view_layouts` (constraint changes only), with a down migration to 0032.

<a id="adr-27"></a>
## ADR-27: Time tracking, timesheets, and period locks (Phase 3D amendment)

- **Decision:**
  - **Entries.** `timetrack.time_entry` (`te_`) belongs to the person and to exactly one task or one project in that work's brand; the brand is part of the target foreign key (`ON UPDATE CASCADE`), so a task moved to another brand carries its entries. `source` is `manual` or `timer`; `state` is `running`, `paused`, or `stopped` (manual entries are always stopped). Every entry keeps its IANA zone and the local `work_date` it counts towards; instants are UTC whole seconds. Durations are never negative and at most 24 hours (`TIME_ENTRY_MAX_HOURS`); one live timer per person (partial unique index).
  - **Segments.** `timetrack.time_segment` holds the half-open UTC intervals of a timed entry (one for a manual timed entry; one per run between pauses for a timer; an open segment is a running timer). A person's segments never overlap: a guard trigger checks under a per-person transaction lock. A deferred constraint trigger keeps each entry's duration equal to its closed segments. Duration-only manual entries have no segments and do not take part in overlap.
  - **Timesheets.** `timetrack.timesheet` (`tsh_`) is one person's seven-day period starting on the workspace week start, `open`, `submitted`, or `approved`. `timetrack.timesheet_line` holds one brand's state (`pending`, `approved`, `rejected`, `withdrawn`, `unlocked`) and the submitted totals and entry hash.
  - **Evidence.** `timetrack.timesheet_approval` is append-only: who decided which line of whose period, `approve` or `reject`, `self_approval` (OD-20), and the exact entries (count, totals, hash, sheet version). `timetrack.period_lock` is append-only: `lock` rows (written by an approval) and `unlock` rows (reason and step-up, OD-26); the latest row per person, brand, and period decides.
  - **Lock enforcement.** Every write that a period check protects takes the person's transaction lock first; a guard trigger refuses any insert, update, move, or delete of an entry (or its segments) whose day is in a submitted timesheet or an approved, locked period. The only sanctioned deletions are lifecycle purge of the work (the worker role) and an explicit workspace purge; approvals keep their own totals and hash.
  - **Deviations from §6.6.** Exactly one target (not "at least one"); `timesheet_id` and `locked` are derived from timesheet and lock rows rather than stored; the per-person transaction lock and guard trigger replace `FOR SHARE` on the lock row; a `timesheet_line` table carries per-brand state.
- **Alternatives:** An exclusion constraint for overlap (needs `btree_gist`, which the platform does not install). Storing pauses as a list on the entry (cannot be checked for overlap). A mutable lock flag (loses unlock history).
- **Consequences:** Migration `0032_time_tracking` with a down migration to 0031. No work blocks, capacity, rollups, or export-adapter tables (3C, 3E, 5C, 6D).

<a id="adr-25"></a>
## ADR-25: Inbox and universal capture (Phase 2E amendment)

- **Decision:**
  - **Inbox items.** `capture.inbox_item` (`inb_`) is a personal record (OD-03) with an optional brand. It stores the immutable original text, source kind (`typed`, `paste`, `form` produced in 2E; `voice`, `email`, `api`, `webhook` reserved for 7F, 6A, and 6B), safe source reference, and correlation. It also holds the intent (task or note), a versioned deterministic parse, and triage state (untriaged, converted, merged, discarded). A trigger keeps the original text and source immutable. Merging and discarding keep the item.
  - **Notes.** `capture.note` (`note_`) is personal until filed and keeps its source Inbox item. Converting a note never removes it.
  - **Lineage.** `capture.capture_conversion` is append-only (source item or note, resulting record, kind, actor). Tasks created by triage have origin `intake` with the source item's public ID.
  - **Intake forms.** `capture.intake_form` (`form_`) belongs to one brand and one queue owner. `capture.intake_submission` is an append-only receipt to the Inbox item it created. Forms are members-only while OD-28 is open.
  - **Attachments.** Links use `relations.record_link` on the item or note. File storage is 4E: file references are refused per attachment (`storage_unavailable`) without losing the capture.
- **Alternatives:** A separate brand intake queue table (a second Inbox). Storing parse results only on the client (not explainable later).
- **Consequences:** Two migrations, `0029_capture_inbox` and `0030_intake_forms`, with down migrations to 0028. No email address, voice, API, or file-storage tables.

<a id="adr-24"></a>
## ADR-24: Task interaction quality (Phase 2D amendment)

- **Decision:**
  - **Origin.** `work.task.origin_kind` is a closed kind (`manual`, `recurring`, `template`, `intake`, `import`, `integration`, `ai_draft`) with `origin_ref`, a JSON object of safe public identifiers only. A trigger refuses any change after insert; only a registered migration may rewrite them. `core.record.source_kind` keeps recording the creation channel.
  - **Recurring tasks.** `planning.recurrence_series.target_kind` gains `task`, plus an optional `project_id`. Occurrences are `work.task` rows carrying `(recurrence_series_id, occurrence_key)`, unique together, so generation is idempotent.
  - **Templates.** `templates.template.target_record_type` gains `task`; versions stay immutable rows. A task created from a template has origin `template` with the template's public ID and version in `origin_ref` (review 01).
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
