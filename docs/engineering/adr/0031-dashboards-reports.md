# ADR-0031: Dashboards, saved reports, shares, schedules, and exports (Phase 5D)

Status: **proposed** (decisions recorded before code; implemented; awaiting one clean current-head no-skip CI run on the draft PR).
Extends ADR-0029 (goals and portfolios, 5B) at the top of the work service chain, and reuses the saved-view query engine (3A, ADR-0018), time (3D), capacity (3E), daily records (3C), deliverables (4E), notifications' email provider boundary (4B, ADR-0024), audit, lifecycle, ownership, and job-runtime foundations.

**Numbering.** 5D was built from the accepted Phase 5 integration head in parallel with Phase 5C, so both first used migration `0043`, ADR-0030, 0B ADR-38, 0C AZ-38, 0D PL-40, and threat and test identifiers from T-63 and AT-269. Phase 5C was accepted first and keeps those numbers; the Phase 5 final integration review renumbered 5D deterministically (as it did for 4C/4E and 5A/5B): migration `0044`, ADR-0031, 0B ADR-39, 0C AZ-39, 0D PL-41, threats T-65 to T-72 (each old number plus 2), and tests AT-280 to AT-297 (each old number plus 11). It changed the numbers and nothing else and kept every threat, test, decision, validator, and closure record.

**Dependency on 5C.** 5C defines the canonical metric model (blocked and stale work, cycle time, time in status, aging, created versus completed, and the metric definition and snapshot structures). It was not available when 5D was built, so 5D does not calculate those: it consumes the owners' existing services through one port (D4), lists the metrics that 5C will define as "not yet available" with their owner phase, and registers 5C's definitions through the same port when they exist. Nothing dashboard-specific is calculated here.

Accepted sources (recorded before code):
- 0A: RPT-001 to RPT-022, WSB-016, NAV-002, NAV-003, GOAL-011, and REL-012 (owned); RPT-023 to RPT-025, PRJ-019, and TIME-005 (contributions). OD-06 (workspace-scoped records), OD-07 (restricted brands in aggregates), OD-17 (staleness thresholds, for 5C), and UXD-10 (minimal content for sensitive brands).
- 0B: ADR-39. `insights.dashboard`, `insights.report_definition`, `insights.report_recipient`, `insights.report_share`, and `insights.report_run` (migration 0044).
- 0C: AZ-39 (no new actions: `record.*`, `report.schedule`, and `personal.manage_own` are reused); T-65 to T-72.
- 0D: PL-41 (routes, envelopes, events, bounds, signals); 0E: the dashboard grid (RS-56), the widget states, and the chart requirements (UX design system §Data display).

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Records and placement | Dashboard (`dash_`) and report definition (`rpt_`) are `core.record` envelopes; a share has its own identifier (`rsh_`). A dashboard is `owner` (workspace), `brand`, `release` (brand), `project`, or `personal`; a report is workspace-, brand-, or project-scoped. Access is the placement's, decided through the same compiled level as goals. No action is added (122). |
| D2 | Release dashboards | Releases are a 9D record that does not exist yet. A `release` dashboard is placed at a brand, carries the widgets that exist today (work, milestones, deliverables), and gains test and defect widgets when 9B to 9D define them (RPT-015 is listed as not yet available). Nothing is invented for it. |
| D3 | Nothing derived is stored | Every figure, group, total, label, freshness statement, export, and email is computed on request or at send, for the person asking, from what that person may read now. There are no snapshots or cached values, so a revoked grant or share applies to the next read. The 0B `metric_snapshot` and `metric_definition` entities remain 5C's. |
| D4 | The metric port | A widget names a metric and its parameters; the metric is answered by the service that owns the data: the 3A query engine for work and project counts (one query AST, the viewer's own predicate), 5B goals, 3D time, 3E capacity, 3C daily records, 4E deliverables, and work milestones. Task and project counts are not recomputed here: they are the query engine's totals and groups. Metrics 5C, 7A, 8, and 9 will define are listed with their owner phase and refused as widgets until they exist (`not_available`). |
| D5 | Widgets and layouts | A layout is a bounded list (`DASHBOARD_WIDGETS_MAX`) of widgets (identifier, metric, title, size, parameters) in the order they display and stack in; parameters are validated by the metric that owns them. Layout editing is by buttons (keyboard and screen reader friendly), not dragging. |
| D6 | Filters | Date, brand, project, person, and status filters only narrow (they are added to the viewer's own predicate, never replace it). Saved defaults live on the definition; ad hoc filters apply to one view. Each figure says which filters did not apply to it. A range is a preset or at most 366 real days in the workspace calendar. |
| D7 | Drill-through | Every metric lists the records behind its figure through the same authorized path, with an opaque cursor bound to the person and the query (a cursor from one person never works for another). A record is linked only when it has a page the person can open. |
| D8 | Shares and guests | A report share lets the grantee open and run the saved definition. It carries the report's own scope key (a composite key refuses another scope), an optional expiry, and a revocation, needs `record.share` (manage) to create and `record.share_revoke` to revoke, and is never onward-shareable. It grants no data: the figures are the grantee's own, within the report's scope. A guest or share-only reader gets only guest-safe metrics (record-level work counts), computed over the records they hold, labelled "The records shared with you", and cannot export or reach dashboards. A share-only reader never sees the scope's brand or project name. |
| D9 | Personal dashboards | A personal dashboard is its owner's alone, managed through `personal.manage_own`, and listed and read by nobody else (an administrator, the owner, and other members get `not_found`). It has its own lifecycle issuer, as a personal saved view does. |
| D10 | Labels and attribution | Every figure carries what it covers, its source, when it was computed, which filters applied, whether it is built from estimates (hatched, with the word "Estimated"), and what is incomplete (capped counts, truncated groups or rows, items without a measurement). A derived source older than `REPORT_FRESHNESS_MINUTES` is labelled out of date. Widgets count and measure work, time, goals, and deliverables; none attributes business outcomes to project activity (RPT-025). |
| D11 | Exports | CSV and PDF are produced for the requester from what they may read, bounded (`REPORT_EXPORT_ROWS_MAX`), rate limited per member, formula-safe, audited with a security event, and never stored. The PDF is a small dependency-free writer (text, Courier, A4); characters a base font cannot show become `?` (limitation). Exporting needs `record.export` at the placement, so a read-only member, a limited member without the policy, and a guest cannot export. |
| D12 | Scheduled delivery | The schedule (daily, weekly, or monthly on days 1 to 28; a local time; an IANA zone) is stored on the definition. A sweep claims due reports with a lease (`FOR UPDATE SKIP LOCKED`), and for each recipient, in that recipient's own transactions, renders the report as that recipient and sends it through the 4B email provider boundary. The occurrence is a unique key per recipient, so a repeated, overlapping, or crashed sweep sends nothing twice; a sweep that was down owes one delivery for the latest missed occurrence, never a backlog; a local time inside a spring-forward gap is sent right after the clock jumps. A recipient who cannot read the report, who is gone, or who can see nothing is skipped and not emailed; an unconfigured provider is recorded `skipped` (`provider_unconfigured`), never as delivered; a transient failure backs off and a permanent one is recorded failed. The email carries the recipient's own figures (bounded rows) and a link; a sensitive brand's email carries no figures. |
| D13 | Accountability and departure | Whoever saves a schedule answers for it. At each send the accountable owner must still be an active member holding `report.schedule` at the report's scope, or the schedule is suspended (`owner_authority`, `owner_departed`) and nothing is sent; an authorized person resumes it and becomes accountable. A departing member's shared dashboards and reports move to the member chosen in the departure plan, their scheduled reports are suspended, and their recipient rows are removed. A recipient may stop their own emails at any time. |
| D14 | Lifecycle and retention | Archive, trash, and restore carry the record and stop a trashed report from sending; a project's lifecycle carries its dashboards and reports; purge deletes a report's runs, shares, and recipients with it. Delivery runs hold counts and a hash, never content, and age out after `REPORT_RUN_RETENTION_DAYS`. |
| D15 | Where it appears | The Reports destination lists dashboards, reports, and the trash; Home shows the situation overview for the brands in the shell's scope (WSB-016, NAV-002, NAV-003); a project has its own Reports section (PRJ-019). Widgets below the fold load only when they come near the screen, and each loads and fails on its own (REL-012, ST-47). |
| D16 | Operations and boundaries | 14 named bounds (owner 5D), nine events, four signals, and one job (`insights.deliver`, every minute, through a payload-free discovery) are registered. No external connector, AI-written report, or charting library is added. |

## Requirement closure

5D owns RPT-001 to RPT-022, WSB-016, NAV-002, NAV-003, GOAL-011, and REL-012, and contributes RPT-023 to RPT-025, PRJ-019, and TIME-005. Where a requirement names a metric that a later phase defines (blocked and stale work, cycle time, time in status, aging, and created versus completed in 5C; AI usage in 7A; automation and agent rates in 8A and 8C; tests, defects, and release blockers in 9B to 9D) 5D records a foundation: the metric is in the catalog as "not yet available" with its owner and reason, and it joins the same port when defined. `closure-5d.json` records the disposition and evidence of every requirement and decision.

## Acceptance tests (0C AZ-39)

| Test | Test file | Test title |
|---|---|---|
| AT-280 | packages/work/test/integration/insights.test.ts | differs by what each person may read, and hidden work changes no number or label |
| AT-281 | packages/work/test/integration/insights.test.ts | drills into only the records the viewer may read |
| AT-282 | apps/api/test/integration/insights-api.test.ts | computes each widget for the caller and never caches it for anyone else |
| AT-283 | packages/work/test/integration/insights.test.ts | a revoked grant applies to the next read |
| AT-284 | packages/work/test/integration/insights.test.ts | is invisible to someone without access until it is shared, and a share grants no data |
| AT-285 | packages/work/test/integration/insights.test.ts | limits a guest to the records granted to them, and to guest-safe widgets |
| AT-286 | packages/work/test/integration/insights.test.ts | only managers share, and a share is bound to the report and listed to managers |
| AT-287 | packages/work/test/integration/insights.test.ts | delivers once per recipient, as that recipient, and a repeat sends nothing more |
| AT-288 | packages/work/test/integration/insights.test.ts | removes a recipient who lost access and never emails them |
| AT-289 | packages/work/test/integration/insights.test.ts | suspends the schedule when its accountable owner loses authority or leaves |
| AT-290 | packages/work/test/integration/insights.test.ts | exports CSV and PDF with only what the requester may read, and audits them |
| AT-291 | e2e/insights.spec.ts | narrower access gives smaller figures and no hidden names; shares open and close reports; scheduling needs recipients |
| AT-292 | packages/work/test/integration/insights.test.ts | requires placement authority, and keeps personal dashboards personal |
| AT-293 | apps/api/test/integration/insights-api.test.ts | answers unknown and hidden identically, and keeps personal dashboards personal |
| AT-294 | packages/work/test/integration/insights.test.ts | updates with optimistic concurrency and one winner under a race |
| AT-295 | packages/work/test/integration/insights.test.ts | replays an idempotent create once |
| AT-296 | packages/work/test/integration/insights.test.ts | records an unconfigured or rejecting provider honestly and retries a transient failure |
| AT-297 | apps/web/test/insights.test.tsx | warns when a derived source is out of date and says which filters do not apply |

Revocation (AT-283, AT-284) is evidenced by tests that revoke between two reads, and by construction: nothing derived is stored (D3).

## Migration and rollback evidence

Migration `0044_dashboards_reports` creates the `insights` schema and five tables (`dashboard`, `report_definition`, `report_recipient`, `report_share`, `report_run`), each with workspace row-level security and an index on every foreign key, the payload-free `exec_dispatch.discover_report_work` function (workspace identifiers only, owned by `pm_scheduler`), and the worker's grants. Its down migration restores the exact 0042 catalog.

Executable evidence, in `packages/db/test/integration/migrations.test.ts`:
- "upgrades through every accepted boundary (0009–0044) to the candidate and reverses each boundary step": for each accepted boundary it fingerprints objects, constraints, grants, and policies, steps up, and reverses down to the previous boundary's exact catalog and up again.
- "reverses completely with down migrations and re-applies cleanly": every down migration runs to version 0 and the full catalog fingerprint after re-applying equals the first.

Related catalog tests: `packages/db/test/integration/workspace-integrity.test.ts` (the five `insights.*` tables carry the database-enforced workspace key; 26 foreign keys, all indexed) and `packages/platform/test/integration/rls.test.ts` (row-level security on every tenant table, and 20 discovery functions).

## Consequences

The API gains the dashboard, report, share, schedule, recipient, run, export, and ad hoc widget routes (PL-41), the worker gains the `insights.deliver` job (every minute) and a service instance that renders as each recipient, and the work service chain ends in `ReportService`. 14 named parameters (owner 5D), nine events, four telemetry signals, three identifier prefixes (`dash`, `rpt`, `rsh`), and six non-resource envelopes are registered. Residual risks and limitations are in `closure-5d.json`.
