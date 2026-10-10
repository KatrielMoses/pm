# Corrective Developer Brief — Phase 1F Review 01

## Objective

Close the remaining lifecycle retryability flaw and make the accepted per-workspace audit-chain tradeoff measurable. Preserve the working Phase 1F implementation and avoid unrelated redesign.

## Read first

- `briefs/PHASE_1F_AUDIT_DELETION_RECOVERY.md`;
- the Phase 1F completion report;
- `docs/engineering/adr/0009-audit-lifecycle.md`;
- 0B §§7–8, especially evidence locks, purge batches, and audit chaining.

Do not edit `BUILD_ROADMAP.md` or mark `ROADMAP_CHECKLIST.md` complete.

## Architectural decisions

The following proposed interpretations are accepted:

- **G1:** canonical per-change digest and explicit redaction reason in the authoritative 0D schema;
- **G2:** one audit chain per workspace for the current unpartitioned architecture, subject to the contention instrumentation and guardrails below;
- **G3:** a database record-type registry seeded and validated exactly from the canonical 0B catalog, with test-only registration unavailable to production roles;
- **G4:** `security_activity` as a closed non-resource response type;
- **G5:** nullable platform retention defaults supplied by validated deployment configuration, with plan/workspace overrides stored as policy rows;
- **G7:** workspace-audit deletion deferred until the workspace-deletion phase adds a narrowly guarded maintainer procedure;
- **G8:** security-event personal-data redaction deferred until account deletion is implemented.

**G6 is rejected as implemented.** Evidence-locked records may be excluded while the rest of a batch proceeds, but they must not remain permanently attached to a terminal `purged` batch with no future purge path.

The unset recovery/retention periods and vendor choices remain intentional non-blockers.

## Required corrections

### 1. Create a retryable residual batch for partial evidence-lock exclusions

When some—but not all—members of a deletion batch are evidence-locked:

- the unlocked members may continue through the original purge operation;
- every excluded record must be moved transactionally into one or more successor **trashed** deletion batches before the original batch becomes terminal;
- the successor batch must retain workspace/brand scope, original trash actor/time, recovery/restore metadata, prior lifecycle states, containment depth, and enough lineage to explain that it came from a partial purge;
- `core.record.deletion_batch_id` and the active batch-membership rows must point to the successor batch;
- the original batch retains immutable outcome/history rows showing which records were excluded and the successor batch that now owns them;
- no record may be an active member of two deletion batches;
- once evidence locks are released, ordinary retention/manual purge discovery must select the successor batch without a special repair operation;
- repeated or concurrent execution of the split must be idempotent and must not create duplicate successor batches;
- a fully evidence-locked batch remains `trashed` and retryable as it does now.

Use an ordered expand migration. Add explicit lineage fields or a narrowly scoped lineage table; do not overload free-form JSON or silently rewrite the original batch history.

If excluded members form separate containment roots, create deterministic successor groups so each batch has coherent restore/purge semantics. Do not point a residual batch at a root tombstone that the original operation purges. Document the grouping algorithm and why it is stable across retries.

The original batch may finish as `purged_with_exclusions` only after every exclusion is safely owned by a retryable successor batch.

### 2. Preserve audit, ledger, and event truth across the split

- Record the partial-purge decision and residual-batch creation through the same-transaction audit pipeline before destructive work proceeds.
- Include original batch, successor batch, excluded count, and structural record references; never include locked evidence content.
- The purge ledger entry for the original operation must describe only records actually purged. Excluded records appear in a later ledger entry only if and when their successor batch is purged.
- External effects, redactions, projections, tombstones, checkpoints, counts, and terminal outcomes must exclude residual members consistently.
- Restore/list-trash commands must resolve residual members through the successor batch and must not treat the terminal original batch as their active recovery unit.
- A failed successor split must roll back the transition into `purging`; nothing destructive may have occurred.

### 3. Add per-workspace audit-chain contention instrumentation

The current chain is accepted as a cost-conscious initial design, but its transaction-level advisory lock serializes audited writes in each workspace. Make this tradeoff observable:

- measure time waiting to acquire the audit-chain lock separately from total audit-write latency;
- emit bounded histograms/counters without workspace IDs or other high-cardinality labels;
- add a content-safe warning or operational threshold for sustained excessive wait, configurable but not a published product promise;
- document that the audit write should occur near the end of a short mutation transaction and that no network call or unrelated long work may occur while holding the chain lock;
- add a deterministic contention test with parallel writers and one deliberately delayed holder, proving correct continuity, bounded recovery after release, and metric emission;
- add a Phase 11D re-evaluation trigger: measured contention beyond the documented threshold requires moving to deterministic chain lanes/time partitions while retaining verifiability.

Do not weaken continuity, move audit outside the material-change transaction, or add workspace identifiers to metrics.

### 4. Finalize ADR-0009 dispositions and future handoffs

- Mark ADR-0009 accepted/implemented only after the correction passes.
- Record G1–G5, G7, and G8 as accepted dispositions and G6 as rejected/replaced by residual batches.
- Add explicit ownership notes:
  - workspace deletion must add and test the guarded audit-removal path before SEC-021 can pass;
  - account deletion must add security-event personal-data redaction before that capability can pass;
  - Phase 11D owns the measured chain-contention re-evaluation.
- Remove stale “awaiting approval” language from code and documentation.

## Required tests

Add real-PostgreSQL integration/concurrency tests proving:

- one locked child and several unlocked members produce a terminal original batch plus a retryable successor batch;
- releasing the lock later allows the successor to purge normally;
- two disjoint locked containment roots produce deterministic, coherent successor grouping;
- the original root being purged cannot become the residual root;
- retry and concurrent workers create no duplicate successor batches or memberships;
- a crash/failure before, during, and immediately after the split resumes without loss or double purge;
- ledger entries, audit events, effects, redactions, tombstones, counts, and checkpoints contain only the records processed by each operation;
- restore and Trash operate on the successor batch;
- full-lock behavior remains blocked and retryable;
- migration up/down/checksum and constraints prevent dual active membership or terminal-batch ownership;
- chain-lock wait metrics and the delayed-holder contention scenario behave as documented.

Preserve every existing Phase 1F, Phase 1B, RLS, redaction, recovery, browser, scan, and image test.

## Required verification

Run one clean, complete CI verification with no skipped gate: frozen install; Phase 0/generated checks; format/lint/type; unit; real-PostgreSQL migrations and integration/concurrency tests; build/process/browser/accessibility tests; scans; and production-image build/runtime smoke.

## Acceptance criteria

- No evidence-locked record remains owned by a terminal batch without a discoverable future purge path.
- Partial purge is idempotent, recoverable, auditable, ledger-correct, and safe under concurrency/interruption.
- Per-workspace chain-lock contention is measured and operationally actionable without high-cardinality data.
- ADR-0009 has final dispositions and explicit future-phase owners.
- Phase 0 validation and the entire clean verification pipeline pass with nothing skipped.

## Required completion response

Return:

1. Concise correction summary.
2. Every changed file and migration.
3. Residual-batch schema, grouping, lineage, state transition, restore, and later-purge behavior.
4. Audit/effect/redaction/ledger consistency across original and successor operations.
5. Chain-lock instrumentation, threshold, contention test, and Phase 11D trigger.
6. ADR-0009 final G1–G8 dispositions.
7. Test additions and updated counts.
8. Clean CI run/commit, PostgreSQL image, production-image evidence, scans, and any limitation or skipped gate.

Do not report Phase 1F complete while excluded records can be stranded in a terminal batch or the per-workspace serialization cost remains invisible.
