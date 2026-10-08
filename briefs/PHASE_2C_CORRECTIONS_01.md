# Corrective Brief — Phase 2C Review 01

Phase 2C is not accepted yet. The latest CI run is technically green, but the completion report discloses three gaps against the binding Phase 2C brief. Fix them on the existing `phase-2c-workflows-fields` branch, push corrective commits, and rerun the complete pipeline. The final handoff must cite the new current-head no-skip run.

The authoritative delivery protocol applies: no intermediate approval is needed, ordinary failures must be fixed by the developer, and no test may be weakened, skipped, blindly retried, or hidden.

## Correction 1 — Dedicated configuration concurrency coverage

The Phase 2C brief explicitly requires concurrent configuration operations. Add real PostgreSQL integration/concurrency tests with two authorized managers operating concurrently on the same and overlapping configuration:

- workflow version/edit and status reorder;
- transition add/edit/archive and required-field rule changes;
- field definition/value/set version changes;
- formula definition/dependency edits;
- approval policy/request/decision changes.

For each relevant pair, prove one of the documented outcomes: serialized successful commits with deterministic final state, or one success plus a typed optimistic conflict/stale response. Prove there is no lost update, partial configuration, duplicate active status/transition/definition, cycle, replayable approval, or stale cache/result.

Run through the service/API path and direct pooled `app_rw`/`app_worker` roles where applicable. Assert RLS, ETags/versions, locks, permission epochs, audit/outbox facts, and formula/value consistency. Include at least one concurrent configuration change while a record transition preview/apply is in flight; stale fingerprints must refuse safely.

Add closure evidence and validator checks for this test suite. Document the lock/version ordering in ADR-0015.

## Correction 2 — Complete transition-configuration audit facts

The brief requires every material transition configuration change to have safe before/after audit facts. The current report says transition audit records which settings changed but not their values.

Change the audit projection so each transition/status/required-field/approval-policy configuration mutation records a bounded, content-safe before and after representation:

- include stable public IDs, operation kind, scope, version, category, and the changed setting names;
- include canonical hashes for descriptions, field expressions, formulas, notes, or other content-class values;
- include safe scalar values for non-sensitive settings such as status IDs/categories, confirmation tier, approval mode, required-field IDs, and active/archive state;
- never include secrets, full free text, hidden record data, personal identifiers, arbitrary formulas, or unbounded payloads;
- ensure the audit representation is deterministic and redaction-classified, and add tests for both redacted and scalar cases.

Do not create a second history store. Use the existing append-only audit ledger and its established change/hash helpers. Update ADR-0015, the audit/data classification sources, generated outputs, and closure evidence.

## Correction 3 — Hidden-field timing evidence and bounded behavior

The brief requires hidden fields to be omitted without timing-visible disclosure. The report says timing side channels were not measured.

Add a deterministic, quiet-run timing regression suite around representative API/service paths:

- readable record with visible field;
- readable record with hidden field;
- unreadable record/field and `not_found` path;
- hidden formula input/result and formula explanation;
- hidden field in required-field errors, filters/sorts, serialization, audit projection, and counts.

Use the repository’s existing timing-uniformity harness and a documented statistical threshold appropriate for CI noise. The test must prove no field name, value, option, formula input, record existence, or hidden count becomes distinguishable through response timing beyond the accepted threshold. Keep response shapes and authorization predicates consistent; do not add arbitrary sleeps or global timeout changes.

If the existing harness cannot make a meaningful claim for a specific surface, document that surface as an explicit limitation and redesign it to use the same constant-shape/constant-query authorization path as the covered surfaces. Do not claim timing safety without either evidence or a structural explanation backed by tests.

## Required final verification

- Extend `phase2.py` and `phase2/closure-2c.json` to require all three correction evidence sets.
- Re-run Phase 0, Phase 1, Phase 2A, and Phase 2C validators.
- Re-run all local tests and the full CI pipeline, including Testcontainers PostgreSQL, scanners, production image, readiness, and non-root checks.
- Add the correction commits and failed-run root causes to the final report.

Do not change the accepted Phase 2C product scope, weaken the requirements, or return a handoff until a new current-head no-skip CI run passes and the report explicitly closes all three corrections.
