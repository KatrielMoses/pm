# Developer Brief — Phase 1E: Application Shell and Personal Navigation

## Objective

Build the permanent, accessible application frame in which every present and future module runs. A signed-in user must be able to understand their workspace and brand scope, navigate reliably on desktop/tablet/mobile, use breadcrumbs and browser history, choose a theme, use a safe command palette and shortcuts, and maintain permission-safe personal favorites, recents, and view state.

This is the final Phase 1 implementation subphase. Extend the accepted 1B–1D identity, tenancy, permission, public-ID, audit, and UI foundations. Do not create a parallel router, brand selector, authorization check, design system, or preference store.

## Read first

- `FEATURES.md`; `BUILD_ROADMAP.md`; `ROADMAP_CHECKLIST.md`;
- requirement catalog entries WSB-006, WSB-015, NAV-001, and NAV-007 through NAV-014;
- all accepted Phase 0 contracts, especially `docs/ux/02-information-architecture.md`, `04-responsive-shell.md`, `05-design-system.md`, `06-interaction-states.md`, and `07-accessibility.md`;
- the 0B `views` module and its `favorite`, `recent_item`, and `view_state` entities;
- 0C rules for activity/recents/favorites, permission-filtered navigation, hidden-resource omission, and personal scope;
- ADR-0010, ADR-0011, and the current 1C scope/brand and 1D permission APIs.

Run the Phase 0 validator first and keep it green. Do not edit `BUILD_ROADMAP.md`, mark the checklist complete, implement later business modules, or commit/push unless the product owner asks.

## Requirement scope

Complete:

- NAV-001: shell navigation for Today, Inbox, Projects, Calendar, Knowledge, Goals, Reports, and Settings;
- NAV-007: Recently Viewed sidebar summary and full personal view;
- NAV-008: personal favorites and the model/UI foundation for authorized shared-view pins;
- NAV-009: permission-aware command palette navigation and action registry;
- NAV-010: global shortcut registry, conflict protection, enablement preference, and reference;
- NAV-011: persistence of filters, sorting, grouping, visible columns, density, open item, selection, and scroll anchor at the lifetimes defined by RS-20;
- NAV-012: breadcrumbs, deep links, page titles, and correct push/replace browser-history behavior;
- NAV-013: light, dark, and system themes without flash or inaccessible contrast;
- NAV-014: the complete Expanded/Wide, Medium, and Compact shell behavior;
- the 1E contribution to WSB-006 and ownership of WSB-015's reusable brand-marker/presentation contract.

Foundation only:

- Later destinations must be real, addressable, accessible shell routes with honest phase-unavailable states. Do not fabricate Today, Inbox, project, calendar, knowledge, goal, report, notification, search, capture, or activity data and do not claim those later features are complete.
- Palette record search remains a permission-safe provider interface and may expose only currently implemented record types. Full indexed/quick search is Phase 5A.
- Shared saved views and their administrator pins arrive with the owning view engine. Implement schema/service/component hooks and personal favorites now; do not invent shared-view behavior without a real view.
- Quick capture, notifications, and background activity retain honest unavailable/empty foundations until their owning phases.

## Architecture and data

Add ordered expand migrations after 0019 using the accepted `views` schema. Implement canonical personal rows for favorites, recent items, and persisted view state. Reconcile the model source first if implementation requires a missing field; regenerate derived docs.

Requirements:

- every row belongs to an account and, where relevant, workspace; tenant references use canonical foreign keys and RLS;
- targets use registered record/public identifiers and target kinds, never titles or tenant-local secrets in URLs;
- favorites have stable ordering with bounded rank/reorder semantics and active uniqueness;
- recents deduplicate per user/target, retain the latest authorized visit, are bounded to the documented 50, grouped by day, filterable, and clearable;
- view state is keyed by user, device identity, workspace, route/view identity, and compatible schema version; define bounded payloads and expiry/cleanup;
- server-synced durable preferences and per-device/session/local state are separated according to RS-20–22;
- theme, density, sidebar state, shortcut enablement, start destination, and record-opening preference use one typed personal-preference contract;
- lifecycle, audit, retention, purge, and account-deletion hooks are registered. Ordinary recent/view-state churn must not flood the immutable material-event audit; security/material preference changes remain auditable as specified.

All personal lists are hints, never authority. Re-authorize every target at display and activation time. Silently omit and opportunistically remove targets that are deleted, expired, inaccessible, outside the current principal, or hidden by lifecycle/sensitive-brand rules. Never show an “unavailable favorite/recent” that reveals prior existence.

## Shell and routing

Implement one route registry used by sidebar/rail/bottom navigation, breadcrumbs, palette, shortcuts, page titles, and authorization filtering.

- Expanded/Wide: collapsible sidebar, sticky header, scope control, utilities, main outlet, and the accepted panel/docked behavior.
- Medium: navigation rail and non-modal overlay panels.
- Compact: top bar, exactly five bottom slots (`Home`, `Today`, `Inbox`, `My Work`, `More`), More sheet, safe areas, and full-page detail behavior.
- Breakpoints are behavioral tokens: Compact `<600`, Medium `600–1023`, Expanded `1024–1439`, Wide `>=1440`. Do not use user-agent detection.
- Existing onboarding, account/security, workspace/brand settings, People, invitations, teams, permissions, audit/trash, and ownership pages must render inside the shell without losing their current states or access controls.
- Administration and settings entries are absent when unauthorized. Guests receive only their permitted shared-record navigation and personal/account actions—never directory, brand aggregation, audit, trash, or hidden destination counts.
- Navigation remains usable at 320 CSS px and 400% zoom, with touch targets, forced colors, reduced motion, keyboard operation, focus restoration, landmarks, skip links, and non-color indicators.

Every navigational element must be a real link supporting new-tab behavior. Buttons must not masquerade as links. Deep links resolve through the normal authenticated/minimal shell and return the canonical non-disclosing not-available state.

## Workspace and brand context

Reuse the 1C canonical scope selection and accessible-brand resolver.

- Show only accessible active brands by default, with a permission-correct archived group; never expose hidden names, IDs, counts, or existence.
- Support one brand, multiple selected brands, and “All brands” meaning all brands the user can access. A sole accessible brand is a non-interactive label.
- Put scope in scope-sensitive URLs and persist the per-device default; validate all URL scope IDs server-side and normalize stale/unauthorized scope safely.
- Implement the Ctrl/Cmd+Shift+B and palette switcher entry points.
- Opening an authorized record outside current scope switches to its owning brand, announces the change, offers “Back to previous scope,” and makes browser Back restore both page and scope.
- Implement one reusable brand marker/summary component and response shape. Present records with their owning brand even inside aggregated or cross-brand surfaces; show a neutral Workspace or No brand yet marker where the contracts require it. Never derive brand identity from an untrusted URL.

## History, breadcrumbs, titles, and state

Implement RS-20 through RS-25 exactly, including:

- URL ownership for shareable filters/sort/group/view/scope/open-item state and typed stored fallbacks;
- push vs replace behavior from RS-21, including Compact full-screen sheets;
- scroll restoration by authorized anchor item, not pixel offset;
- pruning invisible selections after filter/permission changes before any bulk action;
- accessible containment breadcrumbs that omit inaccessible ancestors and collapse correctly by width;
- page title `{record} · {section} · {product}` without brand names by default and without inaccessible record titles;
- versioned decoding, size limits, allowlisted filter/sort fields, safe corruption fallback, and no prototype/key injection from stored or URL state;
- draft restoration/sign-out clearing hooks for future long-form editors without falsely implementing their content.

## Command palette and shortcuts

Create one extensible command/action registry with stable IDs, labels, categories, optional shortcuts, enablement, permission predicate, telemetry name, and execution mode.

- Ctrl/Cmd+K works everywhere, including editors; Compact uses the documented full-screen sheet.
- Result order: Actions, Go to, currently supported authorized Records, Recent. `>` restricts to actions.
- Unavailable actions and targets are absent, not disabled. Consequential commands open their normal form/review surface and are never directly applied by the palette.
- Navigation/palette results display safe brand markers and only already-authorized labels/snippets.
- Implement the RS-12 shortcut layers and a conflict validator. Inner context wins; single-key/sequence shortcuts never fire in editable fields, during composition, or when disabled.
- Every shortcut has a visible equivalent and appears in the `?`/Help reference and beside palette/menu commands. Handle Windows/Linux Control and macOS Command labels correctly.
- Do not hijack browser/assistive-technology conventions, and do not use raw global listeners that survive unmount or bypass modal/focus context.

## Favorites and recent items

- Any currently implemented readable record or compatible view can be favorited/unfavorited idempotently. Favorites show brand markers and support keyboard-accessible reorder plus non-drag alternatives.
- Sidebar shows the documented recent five; All recent shows up to 50 grouped by day with brand/type filters and clear controls.
- Record a recent only after a successful authorized render—not on probes, failed/hidden routes, previews, background loads, or API access.
- Coalesce rapid revisits, bound write rate, and avoid turning reads into synchronous failure points. A recents-write failure must not block the page.
- Permission loss, deletion, archival rules, account/workspace switch, and sensitive-brand grant removal must take effect on the next read/check despite cached UI or pooled connections.
- Do not include hidden item titles, brand names, or IDs in analytics, logs, page titles, error messages, browser history labels, or client storage.

## API, privacy, audit, and observability

Use Phase 0D envelopes, public IDs, cursors, ETags/idempotency where applicable, safe errors, and the existing request principal. Provide typed endpoints for preferences, favorites/list/reorder, recents/list/clear, and view-state read/upsert/clear.

Register all new actions, event types, statuses, parameters, and bounded telemetry at authoritative Phase 0 sources before use. Metrics may describe outcomes, latency, palette/shortcut command IDs from a fixed registry, state decode failures, and cleanup counts; they must not label tenant, account, brand, route parameter, record, title, or query text. Never persist search input, inaccessible targets, secrets, editor contents, or arbitrary URL parameters as telemetry.

## Required tests

Use at least three workspaces, multiple active/archived/sensitive brands, internal roles, read-only, and guest principals. Prove:

- shell routes, navigation, breadcrumbs, palette, favorites, recents, state, scope URLs, counts, and errors never disclose another tenant or hidden scope;
- direct service/API calls, forged public IDs, malformed/oversized state, reused DB connections, and stale client caches cannot bypass canonical permissions;
- loss of membership, team/grant access, sensitive-brand grant, archive visibility, suspension, removal, and sign-out removes affected shell entries on the next check;
- the same route registry drives all shell surfaces and prevents dead or permission-inconsistent destinations;
- Back/Forward, reload, new tabs, panel open/close, filter changes, scope changes, and width changes preserve exactly the state defined in RS-20/21;
- theme initializes before first paint, follows system changes only in system mode, meets contrast/forced-color requirements, and survives reload/sign-in correctly;
- shortcuts obey editable fields, IME composition, modal layers, user disabling, platform modifiers, repeat keys, and visible alternatives;
- responsive behavior at boundary widths 599/600/1023/1024/1439/1440, 320 px, 400% zoom, coarse pointer, short viewport, reduced motion, forced colors, keyboard-only use, and screen-reader landmarks;
- concurrent favorite/reorder/recent/view-state updates are deterministic or safely last-write-wins per documented contract, without duplicates or cross-device corruption.

At minimum include unit/component tests, real-PostgreSQL migration/RLS/grant/concurrency tests, API integration tests, and Playwright + axe journeys on desktop, tablet, and mobile. Add query-plan/boundedness tests for favorite/recent lists and cleanup.

## Documentation and acceptance evidence

Add a Phase 1E ADR recording routing/state ownership, client-vs-server persistence, preference schema, command registry, shortcut map, placeholder-destination policy, and any deviations. Update tenancy/data/access, UX implementation notes, database, observability, lifecycle, environment/runbook, and architecture indexes.

Run the full repository verification. Acceptance requires the no-skip CI path with Testcontainers PostgreSQL, pinned security/secret/license scans, production image build/smoke, non-root runtime proof, and all browser/accessibility projects. No developer-mode fallback is acceptance evidence.

## Completion response

Return:

1. outcome and exact dependency/runtime versions;
2. changed files, migrations, schemas, generated-contract updates, and preference/state ownership;
3. route registry, shell layouts, scope/brand behavior, breadcrumbs/history, and future-destination treatment;
4. command/palette/shortcut architecture and permission filtering;
5. favorites, recents, persistence, cleanup, privacy, and concurrency behavior;
6. test inventory with isolation, responsive, accessibility, history/state, theme, and authorization results;
7. full verification and CI evidence, PostgreSQL image digest, production image ID/size/non-root check, and scanner results;
8. deviations, limitations, deferred work, operational notes, and explicit confirmation that no later feature was falsely marked complete.

## Stop conditions

Stop and report instead of improvising if the accepted contracts conflict, the canonical 1C/1D permission/context APIs cannot support a shell behavior, a new parallel authorization/router/preference system appears necessary, a future destination would need fabricated data, hidden targets leak through personal state or navigation, responsive/accessibility parity cannot be met, migrations cannot roll back safely, or any required acceptance gate is skipped.
