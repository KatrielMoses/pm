# 13. Unresolved questions and contradictions

Each question records the assumption this set makes now and the reversible extension point that keeps the decision open. Product-owner decisions already in the 0A register are referenced by `OD-` ID and not duplicated.

## 13.1 Contradictions found in accepted Phase 0A/0E contracts

<a id="c-01"></a>
### C-01: Free/busy disclosure in 0A time-and-scheduling versus the approved aggregate rule — resolved

- **Conflict:** [time-and-scheduling §5](../../product/time-and-scheduling.md#5-availability-and-capacity) (line "If some of a person's commitments are invisible to the viewer, the viewer sees 'busy' without details") and Example 4 ("sees 'busy 10:00–10:30'") let a viewer infer that **an unreadable commitment exists at a specific time**. The approved decision in `ROADMAP_CHECKLIST.md`, "Aggregates disclose only authorized brands and records", together with 0E principle 01 §92 ("Hidden things are absent") and UXD-28, says aggregates and capacity are calculated from authorized records only.
- **Approved amendment:** Capacity and availability shown to a viewer are computed only from commitments the viewer can read. Time occupied by commitments the viewer cannot read is not shown. Anonymous busy time requires an explicit future free/busy policy and is off by default. The source contract and Example 4 were updated during 0B review.
- **Data impact:** none either way. Capacity is computed from authorized rows. A future free/busy policy would add a per-person setting and a busy-interval projection without titles.

<a id="c-02"></a>
### C-02 (editorial): stale assumption text in 0E DEP-0A-04 — resolved

- [09-decisions-and-risks DEP-0A-04](../../ux/09-decisions-and-risks.md#dep-0a-04) "What this set assumes now" still lists six categories (Not started, Active, In review, Blocked, Done, Cancelled). The reconciliation table below it marks the item aligned with 0A's five categories, with Blocked derived. The data model follows 0A (five categories, `status_category` enum).
- **Resolution:** the assumption column now uses the five 0A categories and treats Blocked as a derived condition. There is no data impact.

<a id="c-03"></a>
### C-03 (ambiguity, not a conflict): "children of a shared project if the share says so" — resolved

- [hierarchy-and-scope §6](../../product/hierarchy-and-scope.md#6-access-and-authorization-concepts) can be read as a **dynamic** subtree grant (future tasks included). The approved decision says "no implicit children", and §5.2 says children are excluded unless the sharer explicitly includes them.
- **Resolution:** children selected at share time each receive their own grant row in a share group (0C AZ-05, applied to the model in Phase 0 integration; the earlier `selected_child_ids` array was superseded). Nothing grants by traversal, and future children are never included. The 0A contract was clarified during 0B review.

## 13.2 Blockers for Phase 0C (authorization and policy)

<a id="dq-01"></a>
### DQ-01: Grant granularity must compile to SQL predicates over scope keys — resolved
- **Status:** resolved by 0C [resolution](../access/15-decisions.md#resolve-dq-01).
- **Needed:** 0C's effective-permission model must be expressible as `(scope_key set) ∪ (project grants, minus project restrictions) ∪ (record grants)` for list, search, and aggregate queries, and for visibility-keyed derived-condition caches ([03 §3.5](03-tenancy-brand-sharing.md#35-hidden-endpoints-counts-and-derived-conditions)).
- **Assumption:** grants at workspace, brand, project, and record level, plus restricted projects. There are no attribute-based rules that need per-row evaluation in application code for list queries.
- **If 0C needs finer rules:** list queries need a post-filter step, and pagination counts become estimates.

<a id="dq-02"></a>
### DQ-02: Restricted (sensitive) projects inside a brand — resolved
- **Status:** resolved by 0C [resolution](../access/15-decisions.md#resolve-dq-02).
- **Needed:** whether a brand-level role implies access to every project unless the project is restricted (PERM-006).
- **Extension point:** `work.project.access_mode` (`inherit`/`restricted`) and project role assignments. It is unused until 0C decides.

<a id="dq-03"></a>
### DQ-03: Row-level security mechanics — resolved
- **Status:** resolved by 0C [resolution](../access/15-decisions.md#resolve-dq-03).
- **Needed:** acceptance of transaction-local `app.workspace_id` RLS with `FORCE`, and the platform role design for cross-tenant jobs and support tooling ([10 §10.4](10-postgresql-guidance.md#104-row-level-security-defense-in-depth)).

<a id="dq-04"></a>
### DQ-04: Dynamic subtree shares — resolved
- **Status:** resolved by 0C [resolution](../access/15-decisions.md#resolve-dq-04).
- **Needed:** whether a share can include **future** children of a shared project or document.
- **Assumption:** explicit lists only. A dynamic mode would be a policy rule over containment (subtree via `ancestor_ids`). That is acceptable only if 0C explicitly allows containment-based (not relationship-based) inheritance for shares.

<a id="dq-05"></a>
### DQ-05: Agent run scope: snapshot or live — resolved
- **Status:** resolved by 0C [resolution](../access/15-decisions.md#resolve-dq-05).
- **Needed:** UXD-11 defines run scope = agent scope ∩ assigner access. Is it snapshotted at assignment (`agent_assignment.run_scope`) or re-evaluated each tool call?
- **Assumption:** snapshot at assignment **and** re-checked at each tool call (the intersection can only shrink). Data: `agent_run.run_scope` stores the snapshot.

<a id="dq-06"></a>
### DQ-06: Free/busy policy (also needs the product owner) — resolved
- **Status:** resolved by 0C [resolution](../access/15-decisions.md#resolve-dq-06).
- See [C-01](#c-01). This set assumes no free/busy disclosure.

<a id="dq-07"></a>
### DQ-07: Field-level permissions and derived outputs — resolved
- **Status:** resolved by 0C [resolution](../access/15-decisions.md#resolve-dq-07).
- **Needed:** how hidden fields (PERM-003) behave in conflict responses (§9.1 returns "theirs"), activity `display_values`, audit exports, calculated fields that depend on hidden fields, and search snippets.
- **Assumption:** every output is filtered through the same field-level policy. Calculated fields that depend on a hidden field are hidden.

<a id="dq-08"></a>
### DQ-08: Who may see and restore Trash — resolved
- **Status:** resolved by 0C [resolution](../access/15-decisions.md#resolve-dq-08).
- **Needed:** ST-46 says trash is visible to "users who could access the record before deletion". Since grants and scopes are retained, evaluation uses the record's scope and grants as of now.
- **Confirm:** that "as of now" (not "as of deletion") is acceptable.

## 13.3 Blockers for Phase 0D (platform contracts)

<a id="dq-10"></a>
### DQ-10: Public ID format and prefix registry — resolved
- **Status:** resolved by 0D [resolution](../platform/19-decisions.md#resolve-dq-10).
- **Assumption:** `<prefix>_<26 Crockford base32>`, with prefixes from the model's `public_id_prefix`. 0D fixes the format, URL usage, and the prefix registry for non-addressable API resources.

<a id="dq-11"></a>
### DQ-11: Field-merge request and conflict payload — resolved
- **Status:** resolved by 0D [resolution](../platform/19-decisions.md#resolve-dq-11).
- **Needed:** encoding of base values (raw value or hash for rich text), the per-field conflict list, and last-writer metadata ([09 §9.1](09-concurrency-consistency.md#91-ordinary-edits-field-level-optimistic-merge)).

<a id="dq-12"></a>
### DQ-12: Idempotency key scope and lifetime — resolved
- **Status:** resolved by 0D [resolution](../platform/19-decisions.md#resolve-dq-12).
- **Assumption:** keys are unique per (workspace, principal) and expire after a technical TTL that covers the offline replay window (UXD-25). 0D sets values and response replay rules.

<a id="dq-13"></a>
### DQ-13: Event schema and webhook exposure — resolved
- **Status:** resolved by 0D [resolution](../platform/19-decisions.md#resolve-dq-13).
- **Needed:** an event naming and versioning scheme for `outbox_event.event_type`, which internal events become public webhook event types, and the rule that payloads carry references plus permission-safe fields only.

<a id="dq-14"></a>
### DQ-14: Job and attempt policies — resolved
- **Status:** resolved by 0D [resolution](../platform/19-decisions.md#resolve-dq-14).
- **Needed:** mapping of `execution.job.state` to `exec_state`, lease durations, backoff, attempt caps (ST-04), dead-letter handling, and per-workspace fairness parameters (REL-018).

<a id="dq-15"></a>
### DQ-15: Change-notice channel — resolved
- **Status:** resolved by 0D [resolution](../platform/19-decisions.md#resolve-dq-15).
- **Assumption:** SSE notices carry `{public_id, version}` only, and clients re-fetch through authorized reads (UXD-27). 0D defines subscription scope and reconnection.

<a id="dq-16"></a>
### DQ-16: Usage meters and money precision — resolved
- **Status:** resolved by 0D [resolution](../platform/19-decisions.md#resolve-dq-16).
- **Assumption:** meter names per resource, quantities as `numeric`, money as integer micros with ISO currency, and `cost_basis` ∈ measured/estimated/reported (OD-24). 0D confirms the envelope for usage and limits.

<a id="dq-17"></a>
### DQ-17: Pagination and counts — resolved
- **Status:** resolved by 0D [resolution](../platform/19-decisions.md#resolve-dq-17).
- **Assumption:** opaque keyset cursors. Totals are computed on authorized sets and may be labeled estimates for large sets (IA-41).

## 13.4 Safely deferred to the owning implementation phase

| ID | Question | Owner | Default now |
|---|---|---|---|
| <a id="dq-20"></a>DQ-20 | Exact partitioning thresholds and partition sizes | 11D | Partition-ready design, no partitions ([10 §10.9](10-postgresql-guidance.md#109-append-heavy-tables-and-partitioning)) |
| <a id="dq-21"></a>DQ-21 | Rank alphabet, maximum key length, rebalance trigger | 2D | Base-62, rebalance above a length threshold |
| <a id="dq-22"></a>DQ-22 | Calculated-field expression language and limits | 2C (OD-11) | Sandboxed AST interpreter, no SQL evaluation |
| <a id="dq-23"></a>DQ-23 | Supported RRULE subset and generation horizon | 2D | Subset listed in [06 §6.4](06-temporal-model.md#64-recurrence) |
| <a id="dq-24"></a>DQ-24 | Search language configurations, attachment text extraction, OCR | 5A (OD-31) | `simple` + English configurations, indexed together (decided by 5A, engineering decision S8). Attachment text and OCR remain later work (OD-31) |
| <a id="dq-25"></a>DQ-25 | Document content format and realtime engine | 4C/4D (OD-30) | Versioned rich-text JSON documents, optimistic saves; realtime engine decided by 4D ([ADR-35](12-decisions.md#adr-35): a server-sequenced block-operation log, no CRDT). The rich-text envelope and version 1 (plain-text subset, used by `work.project.description_rich`) are fixed by 0D PL-23; 4C extends them |
| <a id="dq-26"></a>DQ-26 | Product depth cap value | 2B (OD-08) | Technical ceiling 32, product cap 10. Projects closed by [ADR-21](12-decisions.md#adr-21) (`PROJECT_DEPTH_MAX`); task depth stays with 2B |
| <a id="dq-27"></a>DQ-27 | Size threshold where bulk edits, archives, and brand moves switch to locked background jobs | 1F/2D | Implementation-measured |
| <a id="dq-28"></a>DQ-28 | Secret store and KMS vendor | 1A | Managed service, references only |
| <a id="dq-29"></a>DQ-29 | Structure of decision records | 2A (OD-15) | Closed by [ADR-21](12-decisions.md#adr-21): `kind` decision or open_question with kind-specific states |

## 13.5 Legal, commercial, or customer promises (product-owner approval)

| ID | Question | Related | Model behavior until decided |
|---|---|---|---|
| <a id="dq-30"></a>DQ-30 | Trash recovery, workspace deletion grace, cancellation read-only, payment grace, import rollback, export link lifetime | OD-34, OD-35, OD-40, OD-36 | Periods are null in `retention_policy`, and the dependent jobs do nothing |
| <a id="dq-31"></a>DQ-31 | Legal holds | OD-37 | `governance.legal_hold` reserved and not exposed |
| <a id="dq-32"></a>DQ-32 | Earlier comment text and audit content values after edit, delete, or purge | OD-38 | Revisions kept while the record exists; redaction on purge |
| <a id="dq-33"></a>DQ-33 | Pseudonymization on account deletion | OD-39 | Pseudonym plus redaction of personal-class audit values |
| <a id="dq-34"></a>DQ-34 | Billing-record retention after workspace deletion | OD-36 | Billing tables survive workspace purge (R-BILLING) |
| <a id="dq-35"></a>DQ-35 | Backup expiry, RPO/RTO, hosting region | OD-42, OD-43 | Measured in 11C; single region; no promise |
| <a id="dq-36"></a>DQ-36 | Automatic workspace deletion after the read-only period ends | OD-35 | No automatic deletion request |
| <a id="dq-37"></a>DQ-37 | Deleting data previously pushed to external systems on disconnect | 0A deletion §6 | Per-integration user choice; default **do not** delete remotely |
| <a id="dq-38"></a>DQ-38 | Retention of AI prompts and outputs versus provider retention | OD-36, OD-41 | Kept as R-EXEC; provider retention governed by provider contracts |
