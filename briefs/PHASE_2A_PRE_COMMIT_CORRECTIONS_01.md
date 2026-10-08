# Corrective Brief — Phase 2A Pre-Commit Review 01

## Outcome

Phase 2A is not yet authorized for branch, commit, PR, or CI. Apply the four required corrections below, record the accepted dispositions, rerun the complete local verification, and return a focused correction report. These decisions are authoritative; do not offer alternative implementations unless a new material contradiction is discovered.

## Required correction 1 — Preserve canonical rich-description storage

ADR-0013 G1 is rejected as written. Phase 2A must not replace the accepted `description_rich jsonb` contract with a plain-text database column that requires a later destructive/content migration.

- Store the project description in `work.project.description_rich jsonb` using the canonical versioned rich-content/document envelope already defined by the architecture. If the shared rich-content schema is not yet runtime-generated, add the smallest versioned schema owned by the appropriate contracts package and register it at the authoritative source; do not depend on the Phase 4C editor.
- The Phase 2A web editor may remain a plain multiline text control. Encode its value as the canonical single-paragraph/plain-text rich document and decode that subset for editing.
- Validate the JSON shape and version at the API and database boundary. Reject unsupported nodes/marks rather than storing arbitrary JSON.
- Keep the 20,000-character limit over normalized extracted text, not serialized JSON bytes. Preserve empty/null semantics explicitly.
- Templates, duplication, audit hashing, API contracts, tests, generated docs, and down migrations must use the rich field.
- Phase 4C may add a rich editor and more supported nodes without migrating existing project descriptions.

Update ADR-0013 G1 to state: **rich description storage is implemented in 2A; the rich editor is deferred to 4C**.

## Required correction 2 — Exact project-share representation

ADR-0013 G2 is accepted only with the following precise boundary:

- A project share grants the recipient the project representation plus intrinsic, non-addressable project facts required to understand it: criteria items and scope/exclusion/risk/assumption/constraint items.
- It does not grant phases, milestones, decisions/open questions, dependencies, child projects, recurrence configuration, templates, collaborators, grants, audit/activity, verification history, or arbitrary project-update history.
- The shared overview may include exactly the latest verified project update's content and public update ID, because PRJ-025 makes that part of the project overview. Omit verifier identity, verification history, unverified updates, older updates, and update counts.
- A recipient with independent authority may naturally see additional structures through that separate authority. The response must calculate each section independently; the share itself cannot be treated as blanket project-container access.
- Direct child endpoints remain independently authorized and return `not_found` when the recipient has only the project share.
- Preview, UI, API, counts, template/duplicate paths, favorites, recents, breadcrumbs, and tests must reflect this same boundary.

Amend P5/G2, 0B/0C sources, response contracts, and tests so “contained facts” cannot be interpreted as all child rows.

## Required correction 3 — Register recurrence discovery bounds

ADR-0013 G3 is rejected. Literal operational batch sizes contradict the authoritative brief and make production tuning invisible.

Register two bounded 0D parameters and use them through typed configuration:

- `RECURRENCE_WORKSPACE_DISCOVERY_MAX`, default `200`, valid range `1..1000`;
- `RECURRENCE_SERIES_DISCOVERY_MAX`, default `50`, valid range `1..500`.

Requirements:

- Add authoritative registry entries, environment documentation, generated contracts, configuration validation, dependency injection into the worker, and bounded telemetry/runbook notes where applicable.
- Remove the `200` and `50` literals from recurrence discovery.
- Tests must prove defaults, lower/upper validation, injected values, paging/deferred pickup, and that work beyond a batch remains eligible for the next run without starvation.
- Keep `RECURRENCE_CATCHUP_MAX=12` as the per-series occurrence bound; the three parameters control distinct layers.

Update ADR-0013 G3 from a deviation to the registered-parameter decision.

## Required correction 4 — Complete the owned recurrence UI

ADR-0013 G5 is not an acceptable deferral in its current form. PRJ-013 is owned by 2A, and the service already supports the authoritative RRULE subset.

- The 2A recurrence UI must offer Daily, Weekly, Monthly, and Yearly frequencies.
- It must support the validated interval, anchor local date/time, IANA timezone, and end condition supported by the service.
- Weekly exposes weekday selection; Monthly exposes the supported month-day choice. Invalid/unsupported combinations show field errors and are never silently normalized.
- Show next occurrence, paused state, catch-up/deferred state, and explicit pause/resume/manual-next controls when authorized.
- Desktop, tablet, and mobile tests must cover all four frequencies, DST-safe local-time intent, keyboard use, errors, and permission loss.
- Phase 2D may improve shortcuts, editing ergonomics, and task recurrence, but it must not be required to make recurring projects fully usable.

## Accepted dispositions

Record these as accepted in ADR-0013 and the Phase 2 closure source:

- **G4 accepted:** PostgreSQL may select the efficient recursive-walk join plan by data volume. Keep representative 5,000/50,000-row query-plan and latency evidence; do not pin a planner strategy without production data.
- **G6 accepted:** 2A provides create-from-project and apply. Template catalog rename/archive/version-management UI remains 10B. The immutable version used by an apply/recurrence remains explicit.
- **G7 accepted:** followers remain entirely in 4A/PRJ-026; no placeholder rows, counts, or UI in 2A.
- **G8 accepted:** intake provenance is implemented and tested with registered fixtures; real intake forms and anonymous/routing/abuse flows remain 2E/OD-28.
- **G9 accepted:** automated accessibility plus keyboard/axe/responsive coverage is required now; the named manual NVDA/JAWS/VoiceOver study remains scheduled for 11E and must not be claimed complete.
- **P17 accepted narrowly:** `project_overview` is a computed non-resource envelope and therefore has no synthetic public ID. Add it to the closed non-resource-type registry at the authoritative source. Only `apps/api/src/work/routes.ts` may construct it through the shared route/envelope helper. The confinement test must reject all other unregistered response types or direct constructors. Nested resource objects retain their real public IDs and individual authorization.

## Regression and verification requirements

Add or update tests proving:

- rich descriptions round-trip, validate, enforce normalized text limits, serialize through templates/duplicate, and remain forward-compatible with a richer editor;
- a share-only recipient sees criteria, scope items, and only the latest verified update while every excluded child/history surface remains absent or `not_found`;
- recurrence discovery uses injected registered bounds and cannot starve later work;
- all four recurrence frequencies work through the real UI/API/worker path, including timezone/DST behavior;
- Phase 0, Phase 1, and Phase 2 validators lock these dispositions and generated outputs are current.

Run `git diff --check` and the full local verification. No branch, commit, push, PR, or CI yet.

## Correction response

Return:

1. exact files and authoritative sources changed for each correction;
2. final description storage/envelope and validation behavior;
3. exact share-only response boundary with negative-test results;
4. new parameter names, defaults, ranges, worker injection, and batching tests;
5. recurrence UI coverage across all four frequencies and timezone/DST cases;
6. updated ADR dispositions for G1–G9 and P17;
7. local validator/test/build/browser totals and any remaining deviation;
8. confirmation that nothing was committed or pushed.

## Stop conditions

Stop and report if no canonical versioned rich-content envelope can be introduced without creating a parallel document system, if share-only visibility cannot be separated from child authority, if registered discovery limits cannot page without starvation, if the service/UI recurrence semantics conflict with the accepted temporal model, or if any verification gate must be weakened or skipped.
