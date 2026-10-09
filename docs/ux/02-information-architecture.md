# 2. Information Architecture

[← UX foundation index](README.md) · Related: [Responsive shell](04-responsive-shell.md) · [Decisions](09-decisions-and-risks.md)

## 1. Structural model

The product has four nested layers. Every screen belongs to exactly one layer at a time, and the shell always shows where the user is in each.

```
Workspace                    (tenant; one at a time in a browser tab)
└── Scope                    (one brand | selected brands | all authorized brands)
    └── Destination          (Home, Today, Inbox, My Work, Projects, Calendar, Knowledge, Goals, Reports)
        └── Record           (project, task, document, goal, deliverable, test run, release, …)
            └── Section      (a record's tabs, e.g. a project's Tasks or Files)
```

Two areas sit outside scope:

- **Settings** (personal) and **Administration** (workspace, brand and policy configuration). These are *configuration*, not work; see [§7](#7-administration-and-settings-map).
- **Shell utilities**: scope switcher, create/capture, search and command palette, notifications, activity tray, help and account menu. These are available from every work screen.

Record ownership rules (which records belong to the workspace, a brand, a project or a person) are 0A's contract ([DEP-0A-01](09-decisions-and-risks.md#dep-0a-01)). This IA assumes the plain reading of `FEATURES.md`:

- projects, tasks, goals and most documents belong to exactly one brand;
- some documents, goals and settings belong to the workspace;
- Inbox items may exist before a brand is chosen;
- notifications, saved personal views, favorites and recents belong to a person.

## 2. Global navigation

<a id="ia-01"></a>
### IA-01 — Primary destinations and order

The primary navigation lists these destinations in this order. Order is fixed so muscle memory transfers between brands and devices. Users may hide destinations they never use, but not reorder them (reordering is [UXD-20](09-decisions-and-risks.md#uxd-20)).

| # | Destination | Purpose | Scope-sensitive | Default view | Primary phase |
|---|---|---|---|---|---|
| 1 | **Home** | Situation overview: the all-brands home when more than one brand is in scope, the brand home when exactly one is | Yes | Dashboard | 1E shell; 5D content |
| 2 | **Today** | Commit, order and execute today's work across brands against capacity | Yes (filter) | Plan list + time column | 3C |
| 3 | **Inbox** | Untriaged captured items awaiting a decision | Yes (filter; brandless items always shown) | Triage list | 2E |
| 4 | **My Work** | Personal queues: Assigned to me, Reviews, Assigned by me, Following, Time | Yes (filter) | Assigned to me | 2B, 3D, 4A |
| 5 | **Projects** | Portfolio of projects the user can access | Yes | List grouped by brand when more than one brand is in scope | 2A, 5B |
| 6 | **Calendar** | Scheduled work, deadlines, milestones and external events | Yes (layers) | Week | 3B, 6C |
| 7 | **Knowledge** | Documents, briefs, SOPs, decisions, release notes | Yes | Tree + recent documents | 4C |
| 8 | **Goals** | Workspace, brand and project goals and key results | Yes | Current period | 5B |
| 9 | **Reports** | Dashboards, saved reports, workload, scheduled deliveries | Yes | Dashboards list | 5D |
| — | **Settings** | Personal preferences (separated at the bottom of navigation) | No | Profile | 1E |
| — | **Administration** | Workspace configuration; shown only to roles with any configuration right | Partly (brand settings) | Overview | 10C (foundations earlier) |

Notifications, Recent, Favorites and Search are shell utilities, not primary destinations ([§8](#8-wayfinding-utilities)).

<a id="ia-02"></a>
### IA-02 — Navigation reflects permission, not plan marketing

A destination appears only if the user can use it. A destination that the *plan* does not include, but that the user's role could use after an upgrade, may appear to owners and administrators with an "Upgrade" marker ([J-12](03-journeys.md#j-12-plan-limit-spending-warning-cancellation-and-export)). It never appears to members, limited members or guests. Hidden navigation leaves no gaps, placeholders or counts.

<a id="ia-03"></a>
### IA-03 — Home adapts to scope, never to guesswork

- **All-brands home** (two or more brands in scope). Today summary across brands. Shared founder capacity for today and this week against commitments. Cross-brand conflicts. One card per in-scope brand: health, due, overdue, blocked, reviews waiting, AI usage. The Reviews queue preview. The latest briefing when Phase 7 exists. Recent activity, filtered by permission.
- **Brand home** (exactly one brand in scope). Brand identity header with description, status, goals and priorities. That brand's active projects and health. Upcoming milestones and deadlines. Team workload when the brand has members. Pinned brand documents. The brand briefing when Phase 7 exists.
- A user with access to one brand only always sees the brand home, and the shell hides the scope switcher's multi-select affordances ([IA-23](#ia-23)).
- Widgets for features not yet built are absent. Placeholder "coming soon" tiles are not shown.

<a id="ia-04"></a>
### IA-04 — Default landing page

| Who | Lands on | Why |
|---|---|---|
| Owner or member with two or more brands | All-brands Home | U1 needs the situation first |
| Member with one brand | My Work | U2 needs assigned work first |
| Limited member or guest | Shared with me ([IA-05](#ia-05)) | U4 sees only granted content |

Users can change their start page in Settings › Preferences. A deep link always overrides the start page.

<a id="ia-05"></a>
### IA-05 — Guest and limited-member navigation

Guests get a reduced shell:

- **Shared with me**: records explicitly shared with them, grouped by owning brand. The brand marker is shown because it is the context they were invited into ([UXD-06](09-decisions-and-risks.md#uxd-06)).
- **Notifications** and **Search**, both restricted to shared content.
- **Settings** (personal only).

Guests do not see the scope switcher, Home dashboards, Today, Calendar, Goals, Reports, Administration, workspace member directories, or any workspace or brand totals. A guest can see the people participating in shared records and nobody else ([IA-47](#ia-47)).

Limited members see the standard shell, reduced to what their grants allow. This follows the same rule: absent, not disabled.

<a id="ia-06"></a>
### IA-06 — One Reviews queue

My Work › **Reviews** lists everything awaiting the user's decision, sorted by due date and then age. That covers deliverables ready for review, AI change proposals, agent outputs, approval-gated status transitions, test-case review before execution, defect verifications, release go/no-go decisions, time-sheet approvals, access requests and extra-usage purchase approvals. Each row shows brand, type, what is being decided, requester (person, AI, automation or agent), due date and evidence count. All rows open into the shared review pattern ([ST-50](06-interaction-states.md#st-50)). Items the user *requested* that are waiting on others appear in Assigned by me › **Awaiting review**.

<a id="ia-07"></a>
### IA-07 — Inbox is not Notifications

- **Inbox** holds *work input*: captured items that become tasks, notes or projects, or are discarded. It is triaged.
- **Notifications** hold *awareness*: something happened that concerns you. They are read and dismissed.

They never share a list, badge or label. The Inbox badge counts untriaged items. The notification badge counts unread, non-digest notifications. Notifications that need a decision link to the Reviews queue rather than duplicating it. Whether the word "Inbox" is final depends on [DEP-0A-05](09-decisions-and-risks.md#dep-0a-05).

<a id="ia-08"></a>
### IA-08 — My Work tabs

| Tab | Contents | Notes |
|---|---|---|
| Assigned to me | Open tasks where the user is an assignee, grouped by default as Overdue · Today · This week · Later · No date | Default tab |
| Reviews | [IA-06](#ia-06) | Badge = items awaiting the user |
| Assigned by me | Work the user assigned to people or agents and that is still open, with sub-filters *In progress · Awaiting review · Blocked · Done recently* | Includes agent assignments with run state |
| Following | Records the user follows (tasks, projects, documents, deliverables) and recent changes to each | "Follow" vs "watch" terminology: [DEP-0A-07](09-decisions-and-risks.md#dep-0a-07) |
| Time | Timer, the user's time entries, and the current time sheet with submit state | Phase 3D; absent until then |

All tabs use the shared list engine (filters, grouping, saved views; [RS-20](04-responsive-shell.md#rs-20)).

<a id="ia-12"></a>
### IA-12 — Activity tray (background work)

A shell indicator shows the count of the user's *active* background operations: AI actions, agent runs they started or supervise, automation runs they own that need attention, imports, exports and sync jobs. Opening it lists each item with its brand, execution state ([§6.3](06-interaction-states.md#3-execution-states-ai-agents-automations-integrations-imports)), progress where measurable, cost so far where metered, and actions (open, pause, cancel, retry, review). Items that fail stay in the tray until acknowledged. "View all runs" opens the **Runs** page, the user's run history. Administrators also reach workspace-wide health from Administration ([§7](#7-administration-and-settings-map)). The emergency stop for agent execution lives here for authorized users ([RS-31](04-responsive-shell.md#rs-31)).

<a id="ia-15"></a>
### IA-15 — Create and capture

One global **Create** affordance opens quick capture. It defaults to "task or note into Inbox", needs no fields beyond text, and can expand to a full create form for any record type the user may create in the current scope. Brand handling in capture follows [IA-21](#ia-21). Keyboard access and responsive placement are in [RS-10](04-responsive-shell.md#rs-10).

## 3. Scope: one brand, selected brands, all authorized brands

<a id="ia-20"></a>
### IA-20 — Brand marker placement

The brand marker ([DS-40](05-design-system.md#ds-40)) is mandatory on the following surfaces. "Multi" means the surface can show more than one brand at once.

| Surface | Single-brand scope | Multi-brand scope |
|---|---|---|
| Shell scope switcher | Brand marker + name | Stacked markers + "3 brands" / "All brands" |
| List, board, table and calendar rows/cards | Optional (shell already shows it) | **Required on every item** |
| Record page header (project, task, document, goal, deliverable, release, test run) | **Required** | **Required** |
| Breadcrumb root | **Required** | **Required** |
| Search results, command-palette record results | **Required** | **Required** |
| Notifications (in-app, email, browser) | **Required** | **Required** |
| Review queue rows and review screen | **Required** | **Required** |
| AI context bar and every AI/agent action confirmation | **Required** | **Required** |
| Confirmation of any external, publish or send action | **Required, inside the dialog text** | **Required, inside the dialog text** |
| Dashboards and report widgets | Widget subtitle names scope | Per-row markers or per-brand series labels |

Workspace-scoped records show a **Workspace marker** (a neutral marker that is not a brand) so they are never mistaken for a brand's records (0A OD-06). In single-brand contexts, a record **shared from another brand** still carries its own brand marker. Markers also appear in briefings, AI answers and citations, agent runs, activity feeds and exports (0A *hierarchy-and-scope §4*).

<a id="ia-21"></a>
### IA-21 — Creating while in an aggregated scope

- **Quick capture to Inbox** never requires a brand. If exactly one brand is in scope, it is pre-filled. Otherwise the item is saved brandless and triage asks for one ([J-02](03-journeys.md#j-02-universal-capture-to-inbox-to-triaged-work)).
- **Creating any brand-owned record** (project, task, document, goal) in a multi-brand scope requires an explicit brand choice. The field shows the user's last-used brand as a *suggestion chip*, not a pre-selected value. Submitting without a brand shows the field error "Choose which brand owns this"; per [ST-75](06-interaction-states.md#st-75), the button is not silently disabled ([UXD-08](09-decisions-and-risks.md#uxd-08)). Creating inside a project or record inherits that record's brand, shown read-only.
- Natural-language detection of a brand ("…for Optestra") pre-fills the field and highlights it as detected, so the user can see and correct it before saving.

<a id="ia-22"></a>
### IA-22 — Scope is always legible

- The scope switcher is always visible on expanded and medium layouts and is one tap away on compact ([RS-04](04-responsive-shell.md#rs-04)).
- Any aggregated total, chart or count carries a scope caption, for example "Across your 3 brands" or "MailAccess, Optestra".
- When a filter *inside* a view narrows brands further than the shell scope, the view's filter bar shows it as an ordinary filter chip. The shell scope does not change.

<a id="ia-23"></a>
### IA-23 — Scope switcher behavior

- Lists only brands the user can access, active first, then a collapsed "Archived brands" group if the user can see archived brands.
- Options: each brand (single select), **Select multiple…** (checkbox mode), and **All brands**. "All brands" means *all brands you can access*. Its tooltip and accessible description say exactly that, without a workspace-wide number.
- A user with one accessible brand sees that brand's name in the switcher position as a non-interactive label.
- Keyboard: <kbd>Ctrl/⌘</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> opens it ([A11Y-KB-06](07-accessibility.md#a11y-kb-06)). The palette command "Switch brand…" does the same.

<a id="ia-24"></a>
### IA-24 — Scope persistence and URLs

- Scope is part of the URL for scope-sensitive destinations, so links and reloads reproduce the view. It also persists per user per device as the default for the next session.
- Record URLs identify the record. The record's owning brand comes from the record, not the URL, so a link to a moved record still resolves.
- Opaque stable identifiers are used in URLs. Brand names, project names and record titles never appear in paths or query strings ([IA-44](#ia-44)).

Illustrative shapes (final syntax: 1E; identifiers: 0B):

```
/{ws}/home?scope=all
/{ws}/home?scope=brand:{brandId}
/{ws}/today?scope=brands:{brandId},{brandId}
/{ws}/projects/{projectId}/tasks?view={viewId}&item={taskId}
/{ws}/tasks/{taskId}
/{ws}/docs/{docId}
```

<a id="ia-25"></a>
### IA-25 — Opening a record from a different brand

When the user opens a record whose brand is outside the current scope (from a link, notification or search result):

1. The record opens normally. Its header and breadcrumb show its own brand marker.
2. The shell scope switches to that brand. A polite announcement and toast say "Switched to Optestra", with **Back to previous scope**.
3. Browser Back returns to the previous page *and* the previous scope.

When the record's brand is already inside the current multi-brand scope, the scope does not change. This avoids the alternative failure where a user edits a record believing it belongs to the brand shown in the shell.

<a id="ia-26"></a>
### IA-26 — Records shared across brands

The semantics of cross-brand sharing are 0A's ([DEP-0A-02](09-decisions-and-risks.md#dep-0a-02)). Displayed as:

- the owning brand's marker, followed by "Shared with" and the marker of each additional brand the *viewer* can access;
- brands the viewer cannot access are not listed, and no "+1" appears;
- editing a shared record shows the owning brand in the save context, so changes are understood to land in the owner's record.

<a id="ia-27"></a>
### IA-27 — Archived brands

Archived brands do not appear in the default scope list, aggregated Home, Today or capacity. Their records remain reachable through search (with an "Archived brand" badge, if the user still has access) and through the switcher's Archived group. Restoring a brand returns it to the switcher and to "All brands".

<a id="ia-28"></a>
### IA-28 — Brandless items

Only Inbox items (and personal records such as notifications and saved views) may lack a brand. Brandless Inbox items show a **No brand yet** marker in the brand position, never a blank. Every multi-brand Inbox view includes them, and a single-brand Inbox shows them in a separate "Needs a brand" group so they are not lost when the user narrows scope.

## 4. Destination details

### Today (3C)

- Sections in order: **Committed today** (manually ordered), **Scheduled today** (calendar blocks), **Overdue** (separate, never merged into today), **Upcoming deadlines** (next 7 days), **Meetings** (external events).
- A capacity strip shows available working time against estimated committed time, per brand and in total. An overload warning shows the amount over ([J-03](03-journeys.md#j-03-plan-today-across-brands)).
- Committing to Today never edits due dates or deadlines. The commit control is labelled "Add to Today", not "Due today".

### Inbox (2E)

Triage list with source, captured text, detected values and suggested brand/project. Per-item actions: *Make task · Make note · Make project · Move to brand/project · Merge · Discard*. Bulk triage is supported.

### Projects (2A, 5B)

Portfolio list. Default grouping is by brand in multi-brand scope and by status in single-brand scope. Available views: list, board (by status), table, timeline, portfolio health. Archived projects sit behind a filter, not in a separate destination.

### Calendar (3B, 6C)

Day, week, month and agenda views. A layers panel toggles brands, connected calendars, deadlines, milestones and scheduled blocks. External events show their source calendar and sync state ([ST-47](06-interaction-states.md#st-47)).

### Knowledge (4C)

A tree grouped as **Workspace** and then one group per in-scope brand. Project and task documents appear under their project and in Knowledge filters, but not as duplicate tree nodes. Document state badges: draft, current, stale, archived, approved AI source ([DEP-0A-10](09-decisions-and-risks.md#dep-0a-10)).

### Goals (5B)

Period selector, then workspace goals, then goals per brand, with linked projects and progress. Project goals appear inside their project and in filters.

### Reports (5D)

Dashboards (owner, brand, project, release, personal), saved reports, workload, time, AI usage and scheduled deliveries. Every metric drills into authorized source records.

### Runs (Activity tray › View all)

The user's history of AI actions, agent runs, automation runs, imports, exports and syncs, filterable by brand, type and state. Not a primary destination ([IA-12](#ia-12)).

### Shared with me (guests; optionally members)

Explicitly shared records grouped by brand. Members also find it as a My Work filter.

## 5. Project-level sections

Every project uses the same section set, in this order. Sections with no content still exist and show an empty state ([§6.4](06-interaction-states.md#4-page-and-collection-states)), except where noted.

| Section | Contents | Notes |
|---|---|---|
| Overview | Status, health, owner, dates, success criteria, latest *verified* update, completion %, overdue/blocked/unassigned/at-risk counts, accepted vs pending deliverables, decisions and open questions, linked goals | Default section |
| Tasks | Shared list engine (list, board, table, Gantt, milestone) | Includes defects as a task type ([DEP-0A-12](09-decisions-and-risks.md#dep-0a-12)) |
| Timeline | Phases, milestones, dependencies (timeline/Gantt) | Adapted on compact ([RS-52](04-responsive-shell.md#rs-52)) |
| Calendar | Project-filtered calendar | |
| Documents | Project and task documents | |
| Files | All files and deliverables with version and review state | |
| Activity | Permission-filtered activity with actor types | |
| Time | Planned vs actual, time entries, project workload | Phase 3D |
| Costs | Budget, time cost, AI execution cost, with estimated/actual labels | Values labelled per [ST-47](06-interaction-states.md#st-47) |
| Reports | Project dashboards and saved reports | |
| Settings | Identity, members and permissions, statuses, fields, templates, notifications, integrations mapping, archive/delete | Visible to those who can configure |
| *Tests* | Suites, cases, runs, coverage | Conditional: shown when enabled by a software template or setting ([UXD-14](09-decisions-and-risks.md#uxd-14)) |
| *Releases* | Release records, readiness, go/no-go | Conditional, as above |

Section navigation is a tab row on expanded and medium layouts, and a section menu on compact ([RS-41](04-responsive-shell.md#rs-41)). Each section is a URL.

**Phase 2A implementation note.** These rules apply until each section's owning phase delivers it:
- **Timeline:** works in 2A, as accessible lists of phases, milestones, and dependencies.
- **Tasks, Calendar, Documents, Files, Activity, Time, Costs, and Reports:** each keeps its place and its URL, but shows an honest "isn't available yet" state rather than an empty collection that would suggest there is nothing to show.
- **Tests and Releases:** their routes exist, but their tabs stay absent until a software template or setting enables them ([UXD-14](09-decisions-and-risks.md#uxd-14)).
- **Overview:** shows only project-native facts. Task-derived counts are labelled as arriving with tasks.

**Phase 2B implementation note.** Tasks replace the Tasks section placeholder:
- **Project Tasks section:** an accessible paged list and hierarchy (status, priority, assignees, dates, estimates, brand marker, authorized totals) with visible Move up, Move down, Indent, and Outdent controls. Drag and drop, inline and bulk editing, and undo arrive in 2D.
- **Task page:** the canonical `/{ws}/tasks/{taskId}` page holds every task field and section. The list-preserving side panel (`item=`) arrives with list views (3A); until then a task opens its page and Back restores the list.
- **Projectless tasks:** `/{ws}/tasks` lists tasks without a project in the current scope; it is an entry path, not a saved view (My Work is 3B, Inbox 2E).
- **Creation:** inside a project, the brand is the project's and read-only; elsewhere in aggregate scope the brand is chosen explicitly.
- **Honest absences:** comments and followers (4A), files and documents (4C/4E), external records (6A), agents (8B), reminders and recurrence (2D) show an "isn't available yet" state; scheduled time shows the empty work-block state (3C).

**Phase 2C implementation note.** Workflows and custom fields are configured in settings and appear on existing project and task pages:
- **Administration:** `/{ws}/settings/workflows`, `/{ws}/settings/fields`, and `/{ws}/settings/field-sets`. Each opens at workspace scope; a scope selector picks a brand or project, and project settings link there with that project preselected. Every reorder, connection, and option change has a button or menu alternative; there are no drag-only builders.
- **Workflows:** record kind, statuses (name, category, color, order, archive), transitions as a list (from → to) with required fields, confirmation, and approval policy.
- **Fields:** type-specific configuration, applicability (project, task), visibility (field policy), validation, options, a formula builder with dependencies and a safe preview, primary or advanced presentation, and stored view-visibility metadata (applied by views in 3A).
- **Field sets:** ordered composition, scope, versions, and an explicit upgrade preview per record.
- **Approvals:** `/{ws}/approvals` lists pending transition approvals the person may decide (before → after, requester, expiry, stale or expired state) with Approve and Reject. The requester applies an approved transition from the record.
- **Records:** project and task pages resolve their workflow's statuses. A status change that needs fields or an approval opens a transition dialog. Custom fields appear in key fields, with advanced fields under "More fields": keyboard reachable, searchable by label, and expanded and focused when they hold an error.
- **Honest absences:** review requested and changes requested states, comments, and notifications (4A), deliverable reviews (4E), saved-view application of field visibility (3A), and import and export jobs (6D).

## 6. Record page anatomy

All record pages (task, project overview, document, goal, deliverable, test run, defect, release, agent run) share one anatomy. That way review, provenance and state appear in the same place everywhere.

1. **Context bar**: breadcrumb ([IA-13](#ia-13)), brand marker, Follow, Favorite, Share, overflow menu.
2. **Title row**: title (inline-editable if permitted), type icon, primary status control, save-state indicator ([§6.2](06-interaction-states.md#2-save-states)).
3. **State banner slot** (zero or one at a time, highest severity wins): archived, in trash (within the recovery period), read-only, conflicted, stale, review requested, run in progress.
4. **Key fields**: assignees, dates (due date, deadline and scheduled block shown distinctly; [DEP-0A-08](09-decisions-and-risks.md#dep-0a-08)), priority, project, labels, custom fields. Advanced fields are behind "More fields".
5. **Body**: description, acceptance criteria and definition of done, checklists, subtasks, relationships, deliverables.
6. **Activity and comments**: combined timeline with filter (comments, history, runs); actor types are visible.
7. **Provenance footer**: created by/through (source), last meaningful update, freshness.

## 7. Administration and settings map

Configuration has three levels. Each configuration screen states its level in its header ("Workspace setting", "Optestra setting", "Project setting"). When a lower level overrides a higher one, both screens show it.

### Personal settings (every user)

Profile · Preferences (start page, theme, density, reduced motion override, keyboard shortcuts on/off and reference) · Language and region (locale, timezone, week start, time format; [08](08-i18n-and-time.md)) · Notifications (per event, brand, project, channel; quiet hours; digests) · Connected calendars (personal) · Security (password, MFA, sessions, remote sign-out) · Personal API tokens (if allowed by policy).

### Brand settings (brand administrators)

Identity (name, logo, colour, icon, description, status) · Working hours and calendars · Goals and priorities · AI instructions, terminology, audience, voice, approved sources · Integrations (brand-scoped connections) · Notification rules · Members and access · Archive / restore.

### Workspace administration (owners and administrators; each area further gated by role)

| Area | Contains | Phase |
|---|---|---|
| Overview | Workspace profile and defaults (name, logo, timezone, locale, currency, week start), health summary | 1C |
| Brands | List, create, archive, restore, ordering | 1C |
| People and roles | Members, guests, teams, roles, custom roles, effective-permission preview, invitations, ownership preservation | 1D |
| Workflow | Statuses, transitions, required fields, approvals, custom fields, field sets | 2C |
| Templates | Project, task, document, automation, agent templates; sample data removal | 10B |
| Integrations | Connections, owners, scopes, status, last sync, health, conflicts | 6A |
| Automations | Definitions, versions, run history, failures, usage | 8A |
| Agents | Profiles, scopes, tools, limits, approval policies, health, emergency stop | 8B–8D |
| AI | Providers, models, workspace keys, allowances, hard limits, data and training settings | 7A |
| Security | Authentication policy, MFA, sessions, security events, default permissions and sharing policies, feature availability by role | 1B, 1D |
| Billing | Plan, entitlements, seats, invoices, tax details, payment method, cancellation | 10A |
| Storage and usage | Storage, AI, automation, agent and integration usage against limits; projections | 10A |
| API and webhooks | Workspace API tokens, scopes, rotation/revocation, outbound/inbound webhooks, delivery history | 6B |
| Audit | Audit history, filters, export (eligible plans) | 1F |
| Data and retention | Retention policies, exports, imports, deletion, trash, workspace deletion, ownership transfer | 1F, 6D, 10C |

Health views (integration, automation, agent) appear inside their areas and roll up into Overview.

## 8. Wayfinding utilities

<a id="ia-09"></a>
### Favorites and pins (IA-09)

Users can favorite any record or saved view they can access. Favorites appear in a sidebar section in user-defined order, each with its brand marker. **Pinned views** are saved views pinned into a project's or brand's navigation by someone with permission. They are shared, so they need the view to be shared ([DEP-0A-09](09-decisions-and-risks.md#dep-0a-09)). A favorite that becomes inaccessible disappears silently. It is not shown as "unavailable", which would reveal that it existed.

<a id="ia-08b"></a>
### Recent (IA-08b)

The sidebar shows the last 5 visited records. **All recent** opens the Recently Viewed page (last 50, grouped by day, filterable by brand and type). Recents are personal, re-checked against permission at display time, and clearable.

<a id="ia-10"></a>
### Search (IA-10)

- Opened from the shell search field or <kbd>/</kbd> (when single-key shortcuts are enabled) and from the command palette.
- Default scope is the current shell scope, with a one-click "Search all my brands".
- Each result shows: brand marker, record type, title with highlighted match, a snippet from fields the user may read, project, owner, last updated, and source for integration records.
- Filters: brand, type, project, owner, updated date, state. Facet counts are computed only over authorized results.
- Exact match uses quotes. Concept (semantic) results, when available, are labelled as such and never mixed unlabelled with exact matches.
- Opening a result opens it *in context* (task in its project view with the detail panel) and, when it came from a document or comment match, scrolls to and highlights the match.
- Recent searches are personal and clearable.
- Indexing: if the index is behind by more than a threshold (set in 5A), results show "Recent changes may take a moment to appear". Persistent indexing failures appear to administrators in Overview, not as per-result noise.

<a id="ia-11"></a>
### Command palette (IA-11)

- <kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> from anywhere, including inside editors.
- One input, with result groups in this order: **Actions** (create, switch brand, toggle theme, start timer…), **Go to** (destinations, project sections, settings areas), **Records** (permission-filtered search with brand markers), **Recent**.
- Typing <kbd>&gt;</kbd> first restricts to actions. Every action shows its keyboard shortcut if it has one.
- Actions respect permission: unavailable actions are absent, not disabled.
- Executing an action that needs more input opens the normal form for it. The palette never applies consequential changes directly.

<a id="ia-13"></a>
### Breadcrumbs (IA-13)

Breadcrumbs start at the brand (or Workspace) and follow containment: `Brand › Project › Parent task › Task`. A crumb for a container the user cannot access is omitted, and the trail starts at the highest accessible ancestor ([IA-42](#ia-42)). On compact layouts the trail collapses to "‹ Parent" plus the brand marker ([RS-40](04-responsive-shell.md#rs-40)).

<a id="ia-14"></a>
### Page titles (IA-14)

The document title is `{Record title} · {Section} · {Product}`. Brand names are excluded from page titles by default, because titles persist in browser history and on shared machines ([UXD-07](09-decisions-and-risks.md#uxd-07)). Titles of unavailable records are never put in the page title.

### Notifications (IA-50 to IA-55)

<a id="ia-50"></a>
- **IA-50 — Notification centre.** Opened from the shell bell as a panel (expanded and medium layouts) or a full page (compact). Tabs: *All · Mentions · Reviews · Saved*. Filters: brand, project, type, unread. Grouping by record collapses repeated events ("3 comments on…").
- **IA-51 — Anatomy.** Brand marker, actor (with actor type), event, record title, project, relative time with an absolute time on focus or hover, and up to two inline actions (for example *Open · Mark done*). Approvals are never completed inline from a notification; the inline action opens the review ([ST-50](06-interaction-states.md#st-50)).
- **IA-52 — States.** Unread, read, saved, dismissed. Dismissed items stay in searchable history.
- **IA-53 — Re-authorization at display.** Notifications are re-checked against current permission when rendered. If access was lost, the row shows "You no longer have access to this item", with no title, snippet, project or actor. Email and browser notifications cannot be recalled, so sensitive brands may be set to send minimal-content external notifications ([UXD-10](09-decisions-and-risks.md#uxd-10)).
- **IA-54 — Opening in context.** Activating a notification opens the record in context, scrolled to the relevant comment or change, and marks it read. Back returns to where the user was.
- **IA-55 — Failure notifications** (integration, automation, agent, AI spending) use error or warning styling, are never grouped away with low-value notifications, and link to the run or connection with a retry or reauthorize action.

## 9. Destination coverage matrix

Every navigation destination named in `FEATURES.md` and the 0E brief, with its location and responsive behavior. *Exp* = expanded (≥1024 px), *Med* = medium (600–1023 px), *Cmp* = compact (<600 px); see [RS-01](04-responsive-shell.md#rs-01). Parity tiers F/A/V are defined in [04 §8](04-responsive-shell.md#8-feature-parity-tiers).

| Destination | Location | Exp | Med | Cmp | Parity |
|---|---|---|---|---|---|
| All-brands home | Home (≥2 brands in scope) | Sidebar item; multi-column dashboard | Rail item; two-column | Bottom bar; single column, brand cards stacked | A |
| Brand-specific home | Home (1 brand in scope) | Sidebar item; multi-column | Rail; two-column | Bottom bar; single column | A |
| Today | Primary nav | Sidebar; plan list + time column | Rail; plan list, time column toggles | Bottom bar; plan list, capacity strip pinned top | F |
| Inbox | Primary nav | Sidebar with badge | Rail with badge | Bottom bar with badge | F |
| My Work | Primary nav | Sidebar; tabs | Rail; tabs | "More" sheet or bottom bar ([RS-05](04-responsive-shell.md#rs-05)); tabs become a segmented menu | F |
| Assigned by Me | My Work tab | Tab | Tab | Segmented menu option | F |
| Following | My Work tab | Tab | Tab | Segmented menu option | F |
| Reviews | My Work tab | Tab with badge | Tab with badge | Segmented option; badge also on My Work | F |
| Projects | Primary nav | Sidebar; list/board/table/timeline | Rail; list/board/table | "More" or bottom bar; list (cards); board adapted | A |
| Calendar | Primary nav | Sidebar; day/week/month/agenda | Rail; day/week/agenda; month read-mostly | More; agenda + day | A |
| Knowledge | Primary nav | Sidebar; tree + document | Rail; tree as drawer | More; tree as full page, document full page | F (editing) / A (tree) |
| Goals | Primary nav | Sidebar | Rail | More | F |
| Reports | Primary nav | Sidebar; dashboards with grid widgets | Rail; two-column widgets | More; stacked widgets; layout editing deferred | A / V (layout editing) |
| Settings | Nav footer | Sidebar footer | Rail footer | Account menu | F |
| Administration | Nav footer (role-gated) | Sidebar footer | Rail footer | Account menu | F for urgent controls, V for complex editors |
| Recently Viewed | Sidebar "Recent" + page | Sidebar section | Rail flyout | Search sheet "Recent" | F |
| Favorites / pins | Sidebar section | Sidebar section | Rail flyout | Search sheet "Favorites" | F |
| Search | Shell | Header field | Header icon → overlay | Header icon → full screen | F |
| Command palette | Shell (<kbd>Ctrl/⌘</kbd>+<kbd>K</kbd>) | Centered overlay | Centered overlay | Full-screen sheet from search | F |
| Notifications | Shell bell | Side panel | Side panel | Full page | F |
| Activity tray / Runs | Shell indicator | Popover + Runs page | Popover + page | Full page | F |
| Create / capture | Shell | Header button + shortcut | Rail button | Floating action button | F |
| Breadcrumbs | Record context bar | Full trail | Truncated middle | "‹ Parent" + brand marker | F |
| Browser history | All pages | [RS-20](04-responsive-shell.md#rs-20)–[RS-25](04-responsive-shell.md#rs-25) | Same | Same; sheets push history | F |
| Shared with me | Guest home; My Work filter | Page | Page | Page | F |
| Project › Overview | Project section | Tab | Tab | Section menu | F |
| Project › Tasks | Project section | Tab | Tab | Section menu | A (views adapted) |
| Project › Timeline | Project section | Tab | Tab | Section menu; agenda-style | A |
| Project › Calendar | Project section | Tab | Tab | Section menu | A |
| Project › Documents | Project section | Tab | Tab | Section menu | F |
| Project › Files | Project section | Tab | Tab | Section menu | F |
| Project › Activity | Project section | Tab | Tab | Section menu | F |
| Project › Time | Project section | Tab | Tab | Section menu | A |
| Project › Costs | Project section | Tab | Tab | Section menu | A |
| Project › Reports | Project section | Tab | Tab | Section menu | A |
| Project › Settings | Project section | Tab | Tab | Section menu | F (basic) / V (workflow editor) |
| Admin › People and roles | Administration | Page | Page | Page; permission matrix read-only, single changes allowed | A / V (bulk matrix) |
| Admin › Workflow | Administration | Page | Page | View only | V |
| Admin › Templates | Administration | Page | Page | Browse/install | A |
| Admin › Integrations | Administration | Page | Page | Status, test, reauthorize, disconnect | F |
| Admin › Automations | Administration | Builder | Builder | View, enable/disable, run history | V (builder) |
| Admin › Agents | Administration | Page | Page | View, pause, emergency stop | F (stop) / V (profile editing) |
| Admin › AI | Administration | Page | Page | Limits and usage editable | F |
| Admin › Security | Administration | Page | Page | Sessions, revoke | F |
| Admin › Billing | Administration | Page | Page | Page | F |
| Admin › Storage and usage | Administration | Page | Page | Page | F |
| Admin › API and webhooks | Administration | Page | Page | Revoke tokens; view deliveries | A |
| Admin › Audit | Administration | Table | Table | Card list with filters | A |
| Admin › Data and retention | Administration | Page | Page | Export, trash; policy editing deferred | A / V |

## 10. Permission-safe display rules

These rules apply to every surface: lists, search, palette, notifications, dashboards, activity, AI answers, exports and emails. Enforcement is server-side (0C). The UI rules exist so that the *design* never needs data it must not show.

<a id="ia-40"></a>
- **IA-40 — Absent, not hidden.** Unauthorized records, brands, projects, people and navigation entries are absent. No lock icons, greyed rows, "private item" placeholders or "N hidden" notes.

<a id="ia-41"></a>
- **IA-41 — Counts are of what you can see.** Badges, totals, pagination totals, facet counts and chart values count authorized records only. Where a user knows their view is partial (a limited member viewing a project), totals are captioned "Items you can access".

<a id="ia-42"></a>
- **IA-42 — Relationships to the unseen are omitted.** Dependencies, blockers, parent/child links, related records, linked goals and deliverables pointing at inaccessible records are not rendered. A derived condition caused solely by an omitted relationship is also omitted. A record's *own* fields (for example a manual blocked flag with a permission-safe reason) still show. The responsible owner is notified when hidden dependency state needs operational handling. The breadcrumb starts at the highest accessible ancestor. This is the approved resolution of [UXD-28](09-decisions-and-risks.md#uxd-28). Behavior for in-text mentions is [IA-46](#ia-46).

<a id="ia-43"></a>
- **IA-43 — Activity is filtered by its subject.** An activity entry is shown only if the user can access the record it is about *and* every record it names. Otherwise it is omitted, not redacted.

<a id="ia-44"></a>
- **IA-44 — URLs and identifiers leak nothing.** URLs, page titles of unavailable pages, file names in downloads, and email subjects for minimal-content brands contain no unauthorized names. Not-found and not-authorized are indistinguishable ([ST-41](06-interaction-states.md#st-41)).

<a id="ia-45"></a>
- **IA-45 — Snippets respect field permission.** Search snippets, notification previews, AI citations and hover cards draw only from fields the viewer may read.

<a id="ia-46"></a>
- **IA-46 — Mentions of inaccessible records.** A mention or link inside authorized text (a comment or document) pointing to an inaccessible record renders as a neutral **"Restricted item"** token (0A *hierarchy-and-scope §5*). It carries no title, type, brand, status or icon, so the surrounding sentence still reads correctly ([UXD-09](09-decisions-and-risks.md#uxd-09)).

<a id="ia-47"></a>
- **IA-47 — People visibility.** Guests and limited members see only people who participate in records they can access, through assignment, comments or membership of a shared record. Pickers (assign, mention, share) list only people the user may see.

<a id="ia-48"></a>
- **IA-48 — AI and agents inherit the viewer's lens.** AI answers, briefings and citations shown to a user contain only records that user may access ([J-08](03-journeys.md#j-08-ai-proposes-record-changes-for-selective-approval)). Agent output shown to a reviewer is subject to the same rules, so an agent with broader scope cannot show a reviewer what the reviewer may not see ([UXD-11](09-decisions-and-risks.md#uxd-11)).

**Phase 2D implementation note.** Task interaction quality lives on existing task surfaces; there are no new top-level destinations:
- **Lists:** inline edits of title, status, assignee, due date, and priority show a save state (saving, saved, conflict, offline, failed). A conflict offers Keep mine, Use latest, or Cancel. Selection checkboxes open a bulk bar with a preview before any change and a per-item report after. A status change lists the selected tasks' own statuses, custom ones included, marks those only some tasks offer, and the preview shows each task's proposed status and any refusal.
- **Ordering:** every row has a Move menu (up, down, top, bottom, move to position) and keyboard shortcuts with a live-region announcement. Drag is an optional pointer convenience over the same commands, and compact layouts never require it.
- **Undo:** reversible changes show an Undo toast for 30 seconds. It is keyboard reachable and announced, and it explains when a later change makes undo unavailable.
- **Task page:** signal badges (stale, blocked, rescheduled, missing owner, date, criteria, or dependency) with a Missing information panel; possible duplicates while creating; Remind me and Snooze (personal); Reschedule with an explicit due-date or deadline choice; Repeat (recurrence) and Save as template; the task's origin (including the template and version it came from).
- **Honest absences:** reminder delivery by email, push, or chat (4B), AI similarity (7C), rollups (5C), work blocks (3C), and the template catalog (10B).

**Phase 2E implementation note.** Capture and the Inbox:
- **Capture anywhere:** every signed-in screen has a Capture button and the `c` shortcut. It opens one dialog that saves a task or a note with no brand, project, or status needed. Typed tokens (dates, `due …`, `!high`, `30m`, `every week`, `#label`, `+project`, `brand:Name`, `@person`) are shown as detected values before saving, and ambiguous ones need a choice. Parsing is rule-based and is never described as AI.
- **Paste:** pasting several lines previews one candidate per line. Each can be edited, removed, or split, and the save reports every candidate.
- **Inbox:** `/{ws}/inbox` is the person's own daily Inbox (untriaged first). Each item shows its original text and source. Triage into a task, note, or project, or discard it, after a permission-checked preview. Merge duplicates through a preview that names the item kept.
- **Notes:** `/{ws}/notes` lists the person's notes; a note converts into a task or project after confirmation and stays in place.
- **Intake forms:** brand settings list forms (members-only while OD-28 is open); `/{ws}/forms/{form}` lets members submit.
- **Honest absences:** voice (7F), email forwarding (6A), API and webhook capture (6B), file storage (4E), and anonymous forms (OD-28).


**Phase 3A implementation note.** Saved views:
- **One builder.** `/{ws}/views/new?entity=task|project` and every saved view share one builder:
  - filters combined with "all" (and) or "any" (or), with nested groups;
  - multi-sort with Up and Down reordering;
  - grouping, with dates by day, week, or month;
  - shown columns in order, plus comfortable or compact density.
  Value pickers list only what the person can see. Unfinished conditions wait for a value instead of erroring.
- **Results.** A table in a focusable scroll region, with group header rows and counts, "Show more" keyset pages, and a live result count. A view never shows anyone more than they can already see.
- **Deep links and state.** The URL carries the view (`q`), so links, reload, and Back reproduce it. Changes replace the history entry. The last state and scroll anchor are kept per person, device, and view.
- **Saving and sharing.**
  - Views save as personal.
  - Sharing names exactly one scope: the workspace, a brand, or a project.
  - A shared view the person changed shows **Modified** with Save (when they may), Save as new view, and Reset.
  - Shared views can be pinned to workspace or brand navigation (a "Pinned views" sidebar section) and made the default for a brand or project. Each person can choose their own default.
- **Export and links.** Export CSV or JSON of exactly what the person sees, up to the export bound. Copy link.
- **Honest absences:** board, calendar, timeline, and the other 3B renderings; stored export files and scheduled exports (4E, 6D); public or link-shared views (disabled by decision).
**Phase 3D implementation note.** Time tracking and timesheets:
- **Time:** `/{ws}/time` (Workspace section of the navigation, members) shows the live timer, the person's week (per-day totals, billable and non-billable), the timesheet with each brand's state, entries with Edit, and Log time. Previous week, This week, and Next week move the period.
- **Timer:** started from a task or project; it survives a refresh and runs on the server's clock. Pause, Resume, and Stop and save are buttons; elapsed time is not announced every second, state changes are. Pause and stop pressed offline are kept on the device and sent when the connection returns. A timer whose work became unavailable shows no title and can still be stopped.
- **Task and project:** a Time panel (the task page; the project's Time section) shows estimate or time budget and task estimates, logged time (billable and yours), and remaining effort, with Start timer and Log time where the person may log time. Durations are typed as `1:30`, `90`, `1.5h`, or `45m`, shown as h:mm, and spoken in words.
- **Approvals:** `/{ws}/time/approvals` lists waiting (or decided) weeks for brands the person manages: Approve per brand, Return with a note, and, for workspace admins, Unlock with a reason after confirming it is them. Self-approval appears only where policy allows it and is labelled.
- **Reports:** `/{ws}/time/report` compares planned and actual time by brand, project, task, person, day, week, or month, says which planned measure it uses, and exports CSV or JSON of the entries the person can see.
- **Honest absences:** work blocks (3C), capacity and allocation (3E), rollups (5C), stored and scheduled exports and accounting adapters (6D).


**Phase 3B implementation note.** Core views:
- **Layouts.** Every saved view, My Work, and the Calendar destination choose a layout over the one query engine:
  - for tasks: list, board, table, calendar, timeline, Gantt, workload, activity, and timesheet;
  - for projects: list, board, table, calendar, timeline, Gantt, milestones, portfolio, and activity.
  The layout and its options are part of the view and its link.
- **Board.** "Move to…" lists the moves the workflow allows. Moves that need fields or approval change nothing and say why on the card. Compact shows one column with a switcher.
- **Calendar.** Day, week, month, and agenda, with layers for dates, deadlines, and milestones.
- **Timeline and Gantt.** "Change dates…" shifts start and due dates and never the deadline. Gantt shows what blocks what and can move blocked tasks too when chosen.
- **Workload.** Hours of open work by person and period, without capacity.
- **Portfolio and Milestones.** Portfolio shows health, progress, and target date; Milestones lists each project's milestones.
- **Activity and Timesheet.** Activity is filterable by person, actor type, and action. Timesheet shows your own time on the view's tasks.
- **Detail panel.** Opening a record keeps the view: a panel on wider screens, the full page on Compact.
- **Honest absences:**
  - scheduling and resizing work blocks on the calendar (3C);
  - external calendar events (6C);
  - capacity and over-allocation (3E);
  - baseline versus actual (5C);
  - Following (4A).

**Phase 3C implementation note.** Today and manual planning:
- **Today:** the `today` destination shows the day in the person's zone: Plan (committed estimate, scheduled and focus minutes; available time and meetings named as later capabilities), Committed (manual order with Move up, Move down, Lock, Next day, Remove), Scheduled (blocks with time, focus, repeats, preparation and buffer, and warnings when a block ends after the due date or deadline), then Overdue, Due today, and Upcoming deadlines, each with Add to day. Previous day, Today, and Next day change the day.
- **Plan and shutdown:** Shut down the day asks, for each unfinished item, carry to tomorrow, pick a day, return to backlog, or leave it; locked items stay. A closed day shows its record.
- **Blocks:** Schedule a block (for a committed task or a named block; start, minutes, preparation, buffer, focus). Overlapping a focus block is refused. Recurring blocks are added by day of week and time and can be ended.
- **Task page:** a Plan panel with Add to today and Schedule focus time from the estimate. Nothing here changes a due date or deadline.
- **Honest absences:** working hours and capacity (3E), calendar events (6C), drag on the calendar (3B), AI plans (7F).

**Phase 3E implementation note.** Capacity and cross-brand conflicts:
- **Capacity:** the `capacity` destination shows the week by day (available, unavailable, planned, and over or under), capacity by brand (reserved, scheduled, and estimated), and conflicts (overlapping blocks in different brands and unmet reservations). Previous week and Next week change the range.
- **Settings:**
  - My working hours: windows per weekday, an optional weekly capacity, and whether brand holidays apply.
  - My time off: kind, first and last day, and an optional note.
  - These are personal. Others see time off only as unavailable time.
- **Team and brands:**
  - Team allocation shows each person's over and under allocation to people with capacity access.
  - Brand reservations and holidays are shown to people who may set them.
  - Brands the viewer cannot read are never named.
- **Today and workload:** Today's plan shows available time and a warning when the plan exceeds it. The warning never blocks. Without working hours, Today asks the person to set them. The workload layout shows availability per person and period.
- **Honest absences:** suggested reschedules (7F), calendar events and holiday feeds (6C), capacity notifications (4B), and rollups (5C).

**Phase 4A implementation note.** Comments, following, and reviews:
- **Task and project pages:** a Comments region (composer, threads with replies, reactions, edit, delete, and history), a Follow button with a followers list for people who read the record through ownership, and a Reviews region (request, decide, withdraw, ask again). Tasks also have Hand over and Assignment history. Comments and reviews sit with the page's existing content and keep its section order.
- **Mentions:** typing `@` opens a list of people who can read the record, teams, and readable records. Keyboard and screen-reader operable. Someone who can't be mentioned is never explained: the refusal is the same for every case.
- **My Work:** Following lists the records you follow and can read now, newest first. Reviews shows reviews to do and reviews you asked for, with a toggle for settled ones. A follow you can no longer read is not listed.
- **Honest states:** a deleted comment shows "This comment was deleted" (or removed by a moderator) and keeps its replies. A review made stale by a later change says so and offers Ask again. Read-only and share-only readers see only what they may do, with a plain reason.
- **Honest absences:** comments and suggestions in documents (4C), live co-editing and presence (4D), file attachments on comments (4E), and agent reviewers (8D).

**Phase 4B implementation note.** Notifications:
- **Bell and centre:** the shell bell shows the unread count in its name and opens the five newest with *Mark all read*. The centre is a full page at `/workspaces/{ws}/notifications` (tabs All · Mentions · Reviews · Saved; filters for type, brand, project, and unread; search; grouping; bulk actions). Opening an item marks it read. Dismissed items stay findable under *Show dismissed*.
- **Settings:** `/workspaces/{ws}/settings/notifications` holds time zone, quiet hours, the digest (off, daily, or weekly), the email and browser switches, per-event choices (immediate, digest, or muted) and mutes by brand, project, or task with an optional end, and recent deliveries. Security notices are marked always on.
- **Honest states:** when email is not configured the page says nothing is sent by email. The browser opt-in asks permission only after a click, explains a refusal, and says when the browser cannot show notifications. A row whose record you can no longer read says "You no longer have access to this item" and offers only its time and state. Quiet hours say what they hold and what they never hold.
- **Administrators:** a delivery-health section lists failed and dead-lettered deliveries (who, channel, reason, attempts, never content) with Retry, and brand and project defaults.
- **Honest absences:** integration, automation, agent, spend, and briefing events arrive with the phases that produce them (6A, 8A, 8B, 7A, 7E); file and co-editing notices arrive with 4D and 4E.

**Phase 4C implementation note.** Documents and knowledge:
- **Knowledge:** a tree grouped as Workspace and then one group per brand in scope, with filters (type, state including *Review overdue*, owner) and title search. Project and task documents appear under their project and task, and in Knowledge through the filters, not as duplicate tree nodes. The tree is a full page on compact layouts.
- **Document page:** title, type, state (Draft, Current, Stale, in words), owner and review date, *Approved AI source* as a separate badge, the block editor, subpages, version history, suggestions, comments, reviews, and linked records. A document past its review date says it is overdue and shows as stale; nothing claims to be current.
- **Editing:** a block editor (paragraphs, headings, lists, checklists, quotes, callouts, code, tables, dividers, and image, video, and link embeds) with a small written inline syntax. Saving names the version loaded; when someone saved a newer one, your text is kept and you choose what to keep. Unsaved text survives going offline and is restored with a clear message.
- **References:** a link or mention you cannot read is a neutral *Restricted item* token with no title, type, or icon (IA-46). Backlinks appear on task and project pages and list only documents you can read.
- **Honest absences:** live co-editing and presence (4D), file upload and previews (4E), comments anchored to a passage (4D), PDF files (6D; the HTML export prints to PDF from a browser), search inside documents (5A), and custom templates (10B).

**Phase 4E implementation note.** Files and deliverables:
- **Task page:** a Files section lists the task's files and links with their state, size, and version, with Upload, Add link, Download, Preview, Versions (with a comparison), Rename, and Move to trash, offered only when the server says the person may. A Deliverables section lists the task's deliverables with their state and versions, adds one with an expected type (any, file, or link), and submits a ready file of this task or a link for review to named reviewers; accepted versions show who accepted and when.
- **Project page:** a deliverables summary counts accepted versus pending (with changes requested, rejected, and draft) across the project's tasks (PRJ-023). My Work › Reviews lists deliverables waiting for the person's decision, decided through the shared review pattern.
- **Workspace settings:** storage usage (used and reserved against the limit) for people who configure the workspace.
- **Honest states:** a file still being scanned says so and cannot be downloaded; a blocked file says it did not pass its scan and never names the signature. When storage or scanning is not set up the page says uploads are unavailable and still offers links. SVG, HTML, office, and archive files download instead of previewing. An accepted deliverable is final.
- **Honest absences:** collaborative editing (4D), documents and document embeds (4C), connector files (6A, 6C), file content in search (OD-31, 5A), evidence items (9B), agent artifacts (8C), attachments during capture (CAP-015 stays refused by 2E), plan-based storage limits (10A), and legal holds (OD-37).

**Phase 4D implementation note.** Live editing and presence in documents:
- **Editing:** a person who can edit joins a live session when the document opens; changes to different blocks arrive as others make them, and the status line says whether the document is live, reconnecting, offline, or editing without live updates (with the reason). A block both people changed is never merged: the later change is kept and the person chooses between keeping their text or taking the other. *Save* makes a version at once; leaving saves what the session left behind.
- **Presence:** names with a colour swatch and a text label, and the block each person is in, shown to members only (UXD-17). Guests and share-only readers see themselves only. Presence is announced on demand rather than continuously (A11Y-PA-09).
- **Fallback:** if live editing is off, full, or unreachable, the 4C editor and its conflict review work unchanged, and text typed offline is kept on the device and sent when the connection returns.
- **Honest absences:** comments anchored to a passage (comments stay on the whole document), text-level cursors and selections of others, intra-block merging, and presence outside documents.

**Phase 5B implementation note.** Goals and Portfolio:
- **Goals:** a period selector (calendar quarter, half, year, or a custom range), then workspace goals, then goals per brand, with filters. A goal shows its owner, period, status, progress with the basis it comes from (a measurement, key results, or linked work), the latest confidence, and whether its update is fresh or stale. Its page lists key results, linked projects and tasks that open the source record, a drill-down from each linked-work figure to the readable tasks behind it, and the check-in history (append-only, newest first). A project page lists the goals scoped to it or linked to it or its tasks.
- **Portfolio (Projects › Portfolio):** projects with health and the rules behind it, deadlines, effort, budgets, cross-project dependencies, and the orphan findings (projects without a goal, goals without active work), for all readable projects or for one saved portfolio. Every count and label drills into records the person may open (IA-42).
- **Honest states:** each figure says what it covers ("work you can read"), when it was computed, and what is missing: some key results unmeasured, tasks without estimates, no dates, a truncated read. Spend and AI usage are shown as "not tracked yet", money is never summed across currencies, and computed health sits beside the project's declared health instead of replacing it. Orphan findings say they are relative to the viewer. A viewer who cannot read some linked work is never told that any exists.
- **Guests and share-only readers** see no Goals or Portfolio destination and no goal anywhere; a person without workspace-level read does not see workspace goals.
- **Honest absences:** comments, mentions, and following on goals; reminders when an update is stale (the event exists, delivery is 4B's); goals in search (5A); dashboards, reports, and brand time and AI investment (5D); metric definitions and weighted rollups (5C); money spend and AI usage tracking (7A); fiscal calendars; goal hierarchies and templates; capacity-versus-effort comparison.
