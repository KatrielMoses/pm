# Developer Brief — Phase 1 Integration Review and Exit Gate

## Objective

Prove that the complete Phase 1 stack works as one secure SaaS foundation and is ready for Phase 2. This is an integration, reconciliation, and acceptance-evidence brief—not a new feature phase.

The required exit journey is: a user securely creates an account and workspace, creates three isolated brands, invites an explicitly scoped guest, switches between individual and aggregate contexts, and demonstrates through UI, API, worker, database, and automated authorization tests that neither the guest nor another tenant can learn about or access anything outside their authority.

Use the Phase 1E head `5f636c8` as the integration candidate. Do not start Phase 2, broaden scope, redesign accepted behavior, merge PRs, or mark the roadmap complete.

## Read and reconcile first

- `BUILD_ROADMAP.md` Phase 1 goal, subphases 1A–1F, and exit gate;
- all accepted Phase 0 contracts and exit report;
- Phase 1 briefs, completion reports, ADR-0008 through ADR-0012, engineering runbooks, and current generated contracts;
- the stacked branch/PR history and migrations 0001–0020;
- accepted deviations recorded in `ROADMAP_CHECKLIST.md`.

Change ADR-0012 from acceptance-pending to accepted, citing CI run `37202829149`, head `5f636c8`, the PostgreSQL digest, scanner outcome, and production image evidence. Check every other Phase 1 ADR/status/index for stale “pending,” contradictory, or superseded language. Update status/evidence only where already architecturally accepted; report any substantive conflict instead of silently choosing a side.

## Integration baseline and branch hygiene

- Establish one review branch from `5f636c8` named `phase-1-integration-review` unless the product owner directs otherwise.
- Confirm the candidate contains every accepted 1A–1F commit and migration exactly once, in order, with no missing generated output.
- Produce a branch/PR dependency and merge-order note for the stacked PRs. Detect duplicate commits, accidental reversions, migration conflicts, or changes that exist only in an obsolete branch.
- Keep `BUILD_ROADMAP.md`, `ROADMAP_CHECKLIST.md`, `briefs/`, local configuration, reports, secrets, and build output out of commits.
- Integration fixes must be narrowly explained and tested. Do not squash or rewrite published history unless the product owner explicitly authorizes it.

## Contract and requirements reconciliation

Run and extend automated reconciliation to prove:

- every Phase 1-owned requirement is implemented or has an explicitly accepted/deferred disposition at its authoritative source;
- every runtime action, account command, record type, status, actor, error, parameter, event, telemetry name, route, command, and token purpose is registered at the canonical Phase 0 source;
- generated docs/contracts are current and no implementation-only vocabulary remains;
- all accepted deviations and deferred ownership point to a real later subphase and do not falsely mark later functionality complete;
- no parallel identity, membership, role/grant, workspace/brand context, audit/lifecycle, router, preference, or authorization system exists;
- documentation counts, migration numbers, schemas, environment instructions, role bootstrap ordering, backup/recovery claims, and readiness checks match the executable system.

Add a machine-readable Phase 1 coverage/closure check where practical; do not rely only on prose inspection.

## Mandatory end-to-end exit journey

Create a deterministic seeded journey using real services and containerized PostgreSQL:

1. register, verify, sign in, and establish a secure session;
2. create a workspace and complete onboarding;
3. create three brands with distinct identity, including one sensitive brand; exercise active, archived, and restored lifecycle where applicable;
4. switch among each brand, a multi-brand selection, and All brands; reload and browser Back/Forward must preserve normalized authorized scope;
5. invite an internal member and a guest through the real invitation delivery/token boundary;
6. grant the guest one exact fixture-backed record share and no workspace, brand, directory, aggregate, descendant, related-record, audit, Trash, or future-record access;
7. accept invitations through the real sign-in/verification path and demonstrate permission preview equals actual enforcement;
8. revoke/suspend/remove relevant access and prove next-check invalidation across session/request, UI navigation, API, worker/job freshness, cached personal navigation, and reused database connection;
9. exercise ownership/last-owner protection, audit evidence, trash/restore/recovery primitives, and personal navigation cleanup without weakening tenant isolation;
10. sign out and prove personal/device state and secret-bearing flows obey their documented lifecycle.

The browser journey must run at desktop, tablet, and mobile widths with axe. It must use observable readiness, never arbitrary sleeps, global timeout inflation, unconditional retries, or skipped assertions.

## Isolation and adversarial matrix

Use at least three workspaces, three brands in the primary workspace, all six roles, an internal member, a guest, a sensitive brand, archived/trashed records, and principals whose access changes during the test.

Prove through API/service calls and direct `app_rw`/`app_worker` PostgreSQL roles:

- no forged header/body/query/path/cursor/public ID, stale ETag, invitation token, session, preference, scope URL, favorite, recent, view-state payload, job payload, or pooled connection can select another account/workspace/brand/principal;
- absent workspace context sees no tenant rows and transaction-local context never leaks across a reused connection;
- list, count, aggregate, breadcrumb, palette, navigation, page title, audit, error, readiness, log, and timing-visible response surfaces omit hidden existence and metadata;
- archived, trashed, sensitive-without-grant, suspended, removed, expired, and revoked objects/principals follow the same canonical predicate on single reads, lists, totals, writes, jobs, and UI;
- owners/administrators have no generic bypass, guests gain no inheritance, and exact shares never acquire children or future records;
- lifecycle, audit-chain, recovery, residual-batch, permission-epoch, and cleanup behavior remains retryable and tenant-scoped under concurrency.

## Reliability, accessibility, and regression review

- Run migration up/down/checksum and role-bootstrap tests from a clean database and from the supported prior migration boundary.
- Exercise clean install, seed/bootstrap, API/worker startup, readiness, graceful failure, recovery gate, cleanup jobs, and production image startup.
- Run focused concurrency/race suites for duplicate onboarding, invitation acceptance, last-owner changes, permission preview/apply, audit chain locking, lifecycle batches, favorites/reordering, recents, and view-state updates.
- Rerun the full responsive/accessibility suite, including 320 px, boundary widths, 400% zoom, keyboard-only, reduced motion, forced colors, theme initialization, skip links, focus restoration, dialogs/sheets, and guest navigation.
- Preserve diagnostics for the previously intermittent `goTo` navigation failure. If it recurs, identify and fix the root cause; do not add retries or merely rerun until green.
- Perform a short manual smoke checklist for behaviors automation cannot prove. The full NVDA/JAWS/VoiceOver study remains scheduled for 11E, but document that limitation accurately.

## Security, privacy, and operational review

- Verify password/token/session/invitation secrets are hashed or sealed as designed and absent from logs, audit, errors, browser storage, URLs, and build artifacts.
- Verify RLS/grants for every tenant table, non-root image execution, dependency/secret/license scans, CSP/security headers, bounded telemetry cardinality, and no production debug/test escape hatch.
- Confirm backups/recovery claims and operator steps are executable, including role bootstrap before migration 0019 and all later migrations.
- Confirm readiness is truthful: configured dependencies are checked, optional unconfigured services are explicitly reported, and tenant isolation/recovery gates fail closed.
- Review cost posture: no unnecessary production service/vendor was introduced, cleanup is bounded, indexes/query plans cover representative principals, and the single deployable remains suitable for the low-cost modular-monolith plan.

## Required evidence and acceptance gates

Run the full repository verification locally where possible, then create a draft integration PR and obtain one clean no-skip CI acceptance run. Acceptance requires:

- lockfile-enforced clean install;
- Phase 0 plus Phase 1 closure/reconciliation validators;
- format, lint, SQL safety, dependency graph, generated-contract, and type gates;
- all unit/component, real-Testcontainers PostgreSQL integration/concurrency, process smoke, and browser/axe tests;
- checksum-pinned dependency and secret scanners plus license policy;
- production image build, migration/startup/readiness/web smoke, exact image ID and size, and non-root identity;
- no skipped tests, developer fallbacks, hidden retries, or unexplained failing predecessor accepted as evidence.

Do not mark the integration ADR/report accepted yourself. Leave the PR draft and do not merge.

## Deliverables

1. Phase 1 integration/exit report mapping 1A–1F, requirements, deviations, migrations, ADRs, and the exit journey;
2. machine-enforced closure/reconciliation checks added to the normal verification path;
3. any narrowly scoped fixes, with cause and regression tests;
4. updated accepted-status documentation for already accepted 1E only;
5. branch/PR topology and safe merge-order recommendation;
6. complete local and CI evidence.

## Completion response

Return:

1. overall outcome and whether every Phase 1 exit condition is proven;
2. exact commits, changed files, migrations, ADR/status changes, and generated artifacts;
3. requirements/contract closure results and any deferred items with owning phases;
4. exit-journey results across UI/API/worker/database;
5. isolation, revocation, lifecycle, audit, concurrency, accessibility, and regression results;
6. local verification and manual smoke results;
7. no-skip CI run, PostgreSQL digest, scanner results, production image ID/size/non-root/readiness evidence;
8. limitations, residual risks (including whether the navigation flake recurred), operational notes, PR topology, and recommended merge order.

## Stop conditions

Stop and report rather than papering over the issue if any Phase 1 requirement lacks a disposition, accepted sources conflict, branch history omits or duplicates accepted work, the exit journey needs fabricated authority/data, tenant isolation or revocation differs across surfaces, an unexplained flake recurs, a migration/rollback/role bootstrap is unsafe, a scanner or production-image gate is unavailable, or any test/gate must be skipped, retried blindly, or weakened to pass.
