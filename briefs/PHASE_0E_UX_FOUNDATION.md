# Developer Brief — Phase 0E: UX Foundation

## Objective

Define the reusable user-experience foundation for the multi-brand SaaS application in `FEATURES.md`. This is a product-design contract that later developers will implement consistently. It must cover information architecture, responsive behavior, accessibility, interaction states, and design-system foundations without prematurely designing every feature screen.

This brief may run in parallel with Phase 0A. Where product terminology is not yet finalized, record an explicit dependency on 0A rather than creating a conflicting definition.

## Read first

- `FEATURES.md`
- `BUILD_ROADMAP.md`
- `ROADMAP_CHECKLIST.md`

Do not edit `BUILD_ROADMAP.md` or mark `ROADMAP_CHECKLIST.md` complete. The solutions architect will update tracking after review.

## Required deliverables

Create a coherent documentation set under `docs/ux/`. You may choose sensible filenames, but the set must cover all of the following.

### 1. UX principles and user model

Define practical product principles for:

- a founder operating multiple brands with shared personal capacity;
- team members focused on assigned work;
- administrators configuring the workspace;
- limited members and guests who must not infer unauthorized information;
- reviewers approving deliverables, tests, defects, and releases;
- users supervising AI, automations, integrations, and agent runs.

Include the principle that brand context, data provenance, save state, execution state, and permission boundaries must remain visible at the moment they matter.

### 2. Information architecture

Define the navigation and hierarchy for:

- all-brands home and brand-specific home;
- Today, Inbox, My Work, Assigned by Me, Following, Projects, Calendar, Knowledge, Goals, Reports, and Settings;
- project-level sections: overview, tasks, timeline, calendar, documents, files, activity, time, costs, reports, and settings;
- search, command palette, notifications, favorites/pins, recent items, breadcrumbs, and browser history;
- administration areas for people/roles, workflow, templates, integrations, automations, agents, AI, security, billing, storage/usage, API/webhooks, audit, and retention.

Show how users switch between one brand, multiple selected brands, and all authorized brands without mistaking aggregation for ownership. Avoid exposing the existence or names of unauthorized brands or records.

### 3. Core journey maps

Map the happy path, major alternate paths, and recovery paths for at least:

- first workspace, first brand, first project, first task;
- universal capture to Inbox to triaged work;
- planning Today across brands without changing deadlines;
- opening task details without losing view state;
- creating and reviewing a deliverable;
- inviting a guest to explicitly scoped content;
- receiving and acting on a notification;
- AI proposing record changes for selective approval;
- assigning work to an agent and reviewing its output;
- failed test to defect to fix to verification to release;
- connecting/disconnecting an integration safely;
- plan limit, spending warning, cancellation, and data export.

Later-phase flows may be lower fidelity, but their cross-cutting interaction rules must be clear.

### 4. Responsive application shell

Define desktop, tablet, and mobile-web behavior, including:

- primary navigation and context switching;
- global create/capture affordance;
- command palette and keyboard access;
- breadcrumbs and history;
- list/board/table/calendar detail opening;
- panels, dialogs, drawers, and full-page transitions;
- dense data views on small screens;
- preserved filters, sorting, grouping, selection, and scroll position;
- safe-area, touch-target, reflow, and orientation considerations.

Use behavioral breakpoint guidance rather than assuming specific device models. State which complex views receive adapted mobile experiences and how feature parity is maintained.

### 5. Design-system foundation

Define tokens and component behavior for:

- typography, spacing, sizing, radii, elevation, and motion;
- semantic colors for surfaces, text, borders, focus, status, priority, risk, success, warning, and error;
- light, dark, and system themes;
- brand color/icon use without allowing customer brand colors to break contrast or impersonate system state;
- buttons, links, inputs, selectors, dates/times, rich text, tables, cards, tabs, menus, tooltips, dialogs, drawers, toasts, banners, badges, avatars, progress, skeletons, and empty states;
- status representation that never relies on color alone;
- density modes and large-data display conventions.

Do not create a polished marketing brand identity or decide the final product name.

### 6. Interaction and state standards

Prescribe consistent behavior for:

- unsaved, saving, saved, retrying, failed, offline/degraded, conflicted, and stale states;
- optimistic updates, undo, irreversible confirmation, and bulk actions;
- loading, empty, no-results, filtered-empty, permission-denied, not-found, deleted, archived, and unavailable-service states;
- inline editing versus full forms;
- validation timing and error placement;
- partial success and per-item errors;
- background AI/agent/automation/integration progress without treating commentary or partial work as completion;
- preview/approve/edit/reject patterns for consequential changes;
- focus restoration and context preservation after dialogs, drawers, navigation, or errors.

### 7. Accessibility baseline

Define an implementation-ready WCAG 2.2 AA baseline for:

- keyboard-only operation and logical focus order;
- visible focus and focus trapping/restoration;
- landmarks, headings, names, descriptions, announcements, and live regions;
- forms, validation, dialogs, menus, tabs, grids, boards, drag/drop alternatives, calendars, and rich-text editing;
- contrast and non-color indicators;
- reduced motion, zoom/text resizing, reflow, touch targets, and screen-reader behavior;
- skip links and shortcut conflict handling;
- automated accessibility checks plus required manual keyboard and screen-reader checks.

Be explicit that drag-and-drop, hover, color, and pointer gestures cannot be the only means of completing an action.

### 8. Internationalization and time display

Define UI rules for user timezones, workspace/brand context, localized dates/times/numbers/currencies, week start, ambiguous timezone displays, relative time, and layouts that tolerate longer translated text. Product terminology may depend on 0A; flag this cleanly.

### 9. UX decision and risk register

List unresolved UX decisions with recommended defaults, consequences, affected journeys, and the phase by which each must be resolved. Include collaborative-editing behavior, mobile support boundaries, realtime presence, public/guest views, complex-table behavior, and notification-channel expectations.

## Architecture and consistency constraints

- Brand identity must appear on every project, task, document, notification, search result, and AI action where cross-brand confusion is possible.
- The all-brands experience is a permission-filtered aggregation, never a bypass of brand context.
- AI, automation, integration, and agent failure states must be visible and must not resemble success.
- Destructive, external, financial, access-changing, and production actions require proportionate confirmation or approval.
- Core work management remains usable during AI and integration outages.
- UX patterns must be reusable across domains; avoid one-off interaction models for equivalent actions.
- Preserve browser semantics: meaningful URLs, Back/Forward behavior, reload resilience, and deep linking where authorization permits.
- Never reveal unauthorized record names, counts, snippets, navigation entries, or relationship metadata.

## Non-goals

- Do not implement the production UI or application code.
- Do not choose the final product name or create a marketing identity.
- Do not produce high-fidelity designs for every feature.
- Do not define database schemas, API payloads, or authorization algorithms owned by 0B–0D.
- Do not rewrite feature scope or silently resolve terminology owned by 0A.
- Do not edit the approved roadmap or execution checklist.

## Acceptance criteria

- All required navigation destinations in `FEATURES.md` have an intentional location and responsive behavior.
- The documents cover desktop, tablet, and mobile web rather than treating mobile as scaled-down desktop.
- Cross-brand context and permission-safe behavior are explicit in navigation, search, notifications, and aggregated views.
- Every reusable interaction documents loading, empty, error, permission, degraded, and success behavior where relevant.
- Accessibility guidance is specific enough to become implementation acceptance criteria later.
- The journey maps expose dependencies on later phases without pretending those features already exist.
- Unresolved decisions and dependencies on 0A are clearly registered instead of guessed.
- Documentation is readable, internally linked where useful, and free of placeholder sections presented as complete.

## Required completion response

Return:

1. A concise summary of the UX foundation and major decisions.
2. Every file created or changed.
3. The navigation model and list of journey maps delivered.
4. Accessibility and responsive-coverage evidence.
5. Dependencies on Phase 0A and open questions requiring product-owner approval.
6. Known limitations or design work intentionally deferred to later phases.

Do not merely state that the work is complete; provide reviewable evidence.
