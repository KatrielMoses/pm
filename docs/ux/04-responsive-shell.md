# 4. Responsive Application Shell

[← UX foundation index](README.md) · Related: [IA](02-information-architecture.md) · [Accessibility](07-accessibility.md) · [Design system](05-design-system.md)

The shell is the frame around every work screen. It provides navigation, scope, create/capture, search and command palette, notifications, background-work status and account access. Phase 1E implements it, and every later phase renders inside it.

Mobile web is a first-class target, not scaled-down desktop. The launch requirement "capture, schedule, update and complete work from desktop and mobile web" (*FEATURES › Launch acceptance requirements*) is met through the parity tiers in [§8](#8-feature-parity-tiers).

## 1. Breakpoint model

<a id="rs-01"></a>
### RS-01 — Width classes are behavioral

Layouts switch on **available viewport width in CSS pixels**, not on device detection or user-agent. Zooming changes the width class, which is how reflow at 400% zoom is achieved ([A11Y-VI-04](07-accessibility.md#a11y-vi-04)).

| Class | Width | Navigation | Content panes | Detail opening | Typical cause |
|---|---|---|---|---|---|
| **Compact** | < 600 px | Top app bar + bottom navigation bar | One | Full-screen page | Phone portrait; desktop at high zoom |
| **Medium** | 600–1023 px | Navigation rail (icon + short label) | One, plus overlay panel | Overlay side panel (non-modal) | Tablet portrait, phone landscape, narrow window |
| **Expanded** | 1024–1439 px | Collapsible sidebar (full labels) | List + overlay panel | Overlay side panel | Laptop, tablet landscape |
| **Wide** | ≥ 1440 px | Sidebar | List + docked panel side by side | Docked side panel | Desktop monitor |

The edges are inclusive at the lower bound (600 is Medium; 1024 is Expanded). The thresholds belong to the design tokens ([DS-08](05-design-system.md#ds-08)) so that 1E can adjust them once from measurement without changing rules here.

<a id="rs-02"></a>
### RS-02 — Components adapt to their container

Components such as cards, tables, record headers, the review screen and dashboard widgets adapt to the width of *their own container*, not the viewport. A table inside a docked panel at Wide behaves like a Medium table. Implementation should use container queries or an equivalent; the rule is the behavior.

<a id="rs-03"></a>
### RS-03 — Input modality and height are independent of width

- **Coarse pointer** (touch) raises minimum target size to 44 × 44 CSS px regardless of width class or density ([DS-07](05-design-system.md#ds-07)). It also disables hover-only reveals: row actions become always visible or move into an overflow button.
- **Fine pointer** allows 32 px controls in comfortable density and 28 px in compact density. Spacing must still meet the 24 × 24 target minimum ([A11Y-PT-01](07-accessibility.md#a11y-pt-01)).
- **Short viewports** (height < 500 px, for example phone landscape) collapse the top bar to a single row. Sticky headers combined must not exceed 25% of viewport height. The bottom navigation hides while scrolling down and returns on scroll up, on focus, or at the end of the page.
- Hybrid devices (touch laptops) follow the *current* pointer (`any-pointer` coarse means touch-size targets).

## 2. Shell layouts

### Expanded and wide

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ [≡] [Scope ▾ ■ Optestra]   [Search… ⌘K]           [+ Create] [◷ 2] [🔔 5] [?] [●] │  header
├────────────┬──────────────────────────────────────────────┬──────────────────┤
│ Home       │ Breadcrumb ▸ Title                 save state │  Detail panel    │
│ Today      │ [View tabs] [Filter chips…]  [Group][Sort][⋯] │  (docked at Wide,│
│ Inbox    3 │                                              │   overlay at     │
│ My Work  2 │  content                                     │   Expanded)      │
│ Projects   │                                              │                  │
│ Calendar   │                                              │                  │
│ Knowledge  │                                              │                  │
│ Goals      │                                              │                  │
│ Reports    │                                              │                  │
│ ─ Favorites│                                              │                  │
│ ─ Recent   │                                              │                  │
│ Settings   │                                              │                  │
│ Admin      │                                              │                  │
└────────────┴──────────────────────────────────────────────┴──────────────────┘
 ◷ = Activity tray (background work)   🔔 = Notifications   ● = Account menu
```

- The sidebar collapses to a rail (user preference, remembered) and auto-collapses when a docked panel would push the main content below its minimum width (480 px).
- The header is sticky, and its height must not obscure focused content ([A11Y-FO-04](07-accessibility.md#a11y-fo-04)).

### Medium

```
┌────┬────────────────────────────────────────────────────┐
│ ■▾ │ [Search ⌕]                  [+] [◷] [🔔] [●]          │
├────┤ Breadcrumb ▸ Title                       save state│
│ ⌂  │ [Filters ▾] [View ▾]                                │
│Home│                                                     │
│ ☀  │  content                         ┌───────────────┐ │
│Today│                                 │ overlay panel │ │
│ ⇩  │                                  │ (non-modal)   │ │
│Inbox│                                 └───────────────┘ │
│ …  │                                                     │
└────┴────────────────────────────────────────────────────┘
```

- The rail shows icon and short label for every primary destination. Favorites and Recent open as a flyout from a rail item.
- The scope switcher sits at the top of the rail as a brand marker button ([RS-04](#rs-04)).

### Compact

```
┌──────────────────────────────┐
│ ■ Optestra ▾   Title   ⌕  🔔 │  top app bar
├──────────────────────────────┤
│ [Filter ▾] [View ▾] [⋯]      │
│                              │
│  content (single pane)       │
│                              │
│                       (＋)   │  floating capture button
├──────────────────────────────┤
│ Home  Today  Inbox  Work  More│  bottom navigation
└──────────────────────────────┘
```

<a id="rs-04"></a>
### RS-04 — Scope switcher placement

| Class | Placement | Interaction |
|---|---|---|
| Expanded/Wide | Header, leftmost after the nav toggle; shows marker + brand name, or stacked markers + "3 brands"/"All brands" | Dropdown listbox; multi-select mode with checkboxes and an Apply button |
| Medium | Top of rail as marker button; the label appears in its accessible name and tooltip | Same dropdown, anchored to the rail |
| Compact | Leading element of the top app bar: marker + short name, truncated | Opens a bottom sheet with the same options; Apply is sticky at the bottom |

<a id="rs-05"></a>
### RS-05 — Compact bottom navigation

The bar has exactly five slots: **Home · Today · Inbox · My Work · More**. *More* opens a sheet with Projects, Calendar, Knowledge, Goals, Reports, Favorites, Recent, Settings and (if permitted) Administration. Badges: Inbox (untriaged count), My Work (reviews waiting). Notifications live in the top app bar, not the bottom bar. Customizing slots is [UXD-20](09-decisions-and-risks.md#uxd-20). The bar respects the bottom safe area ([RS-60](#rs-60)).

## 3. Global controls

<a id="rs-10"></a>
### RS-10 — Create and capture affordance

| Class | Affordance | Behavior |
|---|---|---|
| Expanded/Wide | "+ Create" button in header | Opens quick capture as a small non-blocking dialog anchored top-centre; "Expand" opens the full create form |
| Medium | "+" in header | Same |
| Compact | Floating action button, bottom-right, above the bottom bar, outside the safe area | Opens a bottom sheet with the text field focused and the keyboard raised. The button hides while an editor or form is active so it never covers fields |
| Any | Keyboard: global capture shortcut ([§3 RS-12](#rs-12)); palette action "Capture…" | Same quick-capture surface |

Quick capture is available on every screen to anyone who may create Inbox items, including on read-only and error pages, and it works during AI and integration outages ([J-02](03-journeys.md#j-02-universal-capture-to-inbox-to-triaged-work)). Submitting keeps the capture surface open with "Captured to Inbox · Undo · Open", so several items can be entered in a row.

<a id="rs-11"></a>
### RS-11 — Command palette

Opens with <kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> on every class. On Expanded, Medium and Wide it is a centred modal overlay up to 640 px wide. On Compact it is a full-screen sheet opened from the search icon, with a "Commands" segment. Content rules are in [IA-11](02-information-architecture.md#ia-11).

<a id="rs-12"></a>
### RS-12 — Keyboard shortcut layers

Shortcuts are organized in layers, and inner layers win only when focus is inside them:

1. **Global**: palette, capture, search, go-to destinations, scope switch, shortcut help.
2. **View**: navigate items, open, select, bulk menu, filter.
3. **Record**: edit fields, change status, assign, comment.
4. **Editor**: rich text and inputs. Only modifier shortcuts that do not collide with text editing apply here. Single-character shortcuts never fire while focus is in an editable field.

Proposed initial map (the final key map belongs to 1E and must pass the conflict rules in [A11Y-KB-07](07-accessibility.md#a11y-kb-07)):

| Action | Shortcut | Type |
|---|---|---|
| Command palette | <kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> | Modifier |
| Quick capture | <kbd>C</kbd>, or palette "Capture…" | Single key (setting-controlled) |
| Search | <kbd>/</kbd> | Single key (setting-controlled) |
| Switch brand scope | <kbd>Ctrl/⌘</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> | Modifier |
| Go to Today / Inbox / My Work / Projects | <kbd>G</kbd> then <kbd>T</kbd> / <kbd>I</kbd> / <kbd>W</kbd> / <kbd>P</kbd> | Sequence (setting-controlled) |
| Next / previous item | <kbd>J</kbd> / <kbd>K</kbd>, and arrow keys | Single key / arrows |
| Open item | <kbd>Enter</kbd>; full page <kbd>Shift</kbd>+<kbd>Enter</kbd> | — |
| Select item | <kbd>X</kbd> or <kbd>Space</kbd> (in list) | Single key |
| Close panel or dialog | <kbd>Esc</kbd> | — |
| Move focus between regions (nav, list, panel) | Skip links and the palette's region actions; no key binding ([A11Y-KB-04](07-accessibility.md#a11y-kb-04)) | — (browser function keys stay native, [A11Y-KB-07](07-accessibility.md#a11y-kb-07)) |
| Shortcut reference | <kbd>?</kbd> | Single key (setting-controlled) |

Single-key and sequence shortcuts can be turned off in Settings › Preferences. They are on by default for new users on fine-pointer devices ([UXD-04](09-decisions-and-risks.md#uxd-04)). Every shortcut has a visible equivalent control or palette action.

## 4. View state, history and deep links

<a id="rs-20"></a>
### RS-20 — View state preservation

The **view state** of any list-like view (list, board, table, calendar, timeline, Today, Inbox, My Work tabs, search results) consists of:

- view type, filters, sort, grouping, visible fields and column order, and density override;
- the open detail item;
- selection;
- scroll anchor.

| Element | Survives detail open/close | Survives Back/Forward | Survives reload | Survives new session |
|---|---|---|---|---|
| View type, filters, sort, grouping, columns | Yes | Yes (from URL) | Yes (URL) | Yes: last state stored per user per view |
| Open detail item | — | Yes (URL `item=`) | Yes | No |
| Selection | Yes | Yes, within the session | Yes, within the session | No |
| Scroll position | Yes | Yes | Yes | Yes, per device, as an anchor item |

Rules:

- Scroll is restored by **anchor item** (the first fully visible record), not pixel offset, so virtualized and changed lists restore sensibly. If the anchor no longer exists or is no longer accessible, restore to the nearest neighbour position. Failing that, go to the top.
- When filters change, the selection is **pruned** to items still in the result set, with a polite announcement such as "2 selected items are no longer shown and were deselected". Bulk actions therefore never apply to items the user cannot currently see.
- Personal views (My Work, Today, Inbox, personal saved views) save their state automatically. A **shared saved view** that the user modifies shows a "Modified" marker with *Save · Save as new view · Reset*, and never silently overwrites the shared definition.
- Infinite or paged lists restore the loaded range needed to show the anchor and do not refetch from the start.

<a id="rs-21"></a>
### RS-21 — History entries

| User action | Browser history | URL |
|---|---|---|
| Go to a destination, record, project section or settings area | **Push** | Changes |
| Change scope | **Push** | Changes |
| Open the detail panel from a list | **Push**, so Back closes the panel | `item=` added |
| Next/previous item while the panel is open | **Replace** | `item=` changes |
| Open full page from the panel | **Push** | Record URL |
| Change filter, sort, grouping, columns, or view type within a view | **Replace** (debounced) | Updated |
| Switch to a different saved view | **Push** | `view=` changes |
| Type a search query | **Replace** | `q=` updated |
| Open a search result | **Push** | Record URL |
| Open a modal dialog or menu | None on Expanded/Medium/Wide | Unchanged |
| Open a full-screen sheet on Compact (capture, filters, palette, record sheet) | **Push**, so the system Back gesture closes it instead of leaving the page | Sheet marker in history state only |
| Complete or cancel a dialog | Back to the pre-dialog entry if one was pushed | — |

The choice to *replace* on filter changes, so Back does not step through each filter tweak, is [UXD-03](09-decisions-and-risks.md#uxd-03).

<a id="rs-22"></a>
### RS-22 — Reload resilience

Reload reproduces the screen from the URL plus personal stored state. Long-form inputs keep a local **draft** that is restored after reload or crash with the notice "Restored your unsaved draft · Discard". Long-form inputs are comments, descriptions, documents, multi-field create forms and import mappings. Drafts are kept per user per device, never synced to other users, and cleared on sign-out ([ST-08](06-interaction-states.md#st-08)).

<a id="rs-23"></a>
### RS-23 — Deep links

Every destination, project section, record, record section, saved view, search query, notification target and review is addressable. A deep link the viewer cannot access shows the not-available state ([ST-41](06-interaction-states.md#st-41)) inside the normal shell (or a minimal shell when signed out, after sign-in). It never shows a partial render of the record.

<a id="rs-24"></a>
### RS-24 — New tabs and windows

Every navigational element is a real link, so <kbd>Ctrl/⌘</kbd>+click, middle-click and "Open in new tab" work. Rows open in the detail panel on plain click and in a new tab on modified click. Actions (buttons) are never links, and links never perform actions.

<a id="rs-25"></a>
### RS-25 — Leaving with unsaved work

Navigation that would discard unsaved, non-draftable input shows a leave-confirmation: *Stay · Leave without saving*, with Stay as the default focus. Draftable inputs ([RS-22](#rs-22)) do not block navigation; their draft is preserved instead. The browser's native unload prompt is used only when closing the tab with pending saves that have not reached the server.

## 5. Background work and safety controls

<a id="rs-30"></a>
### RS-30 — Activity tray placement

| Class | Placement |
|---|---|
| Expanded/Wide | Header indicator showing a count of active and attention-needed items; opens a popover list (max 8) with "View all runs" |
| Medium | Same, in the header |
| Compact | Indicator in the top app bar when anything is active or failed; opens a full page |

The indicator distinguishes *running* (neutral count with a non-animated progress glyph under reduced motion) from *needs attention* (failed or waiting for the user: warning/error marker plus count). Contents are in [IA-12](02-information-architecture.md#ia-12).

<a id="rs-31"></a>
### RS-31 — Emergency stop is reachable everywhere

Users permitted to stop agent execution can reach **Stop all agent runs** from the Activity tray on every width class, in no more than two activations from any screen. It is also in the command palette and in Administration › Agents. It uses the Tier 2 confirmation ([ST-33](06-interaction-states.md#st-33)), with no type-to-confirm, because speed matters. It reports exactly how many runs were stopped, which were already finishing, and which could not be stopped. Stopping is never parity-tier V.

## 6. Opening details and choosing surfaces

<a id="rs-32"></a>
### RS-32 — Detail opening by context and width

| From | Expanded | Wide | Medium | Compact |
|---|---|---|---|---|
| List / table / board row | Side panel overlaying the right portion (default 480 px, resizable 360–720 px); the list stays visible and interactive | Side panel **docked**; the list reflows to remaining width | Non-modal overlay panel, about 60–70% width | Full-screen record page (push) |
| Calendar event or block | Popover summary → "Open" to side panel | Same | Same | Bottom-sheet summary → full page |
| Search / palette / notification result | Opens in context: destination view with panel open ([IA-10](02-information-architecture.md#ia-10)) | Same | Same | Full-screen record page; Back returns to results |
| Modified click (Ctrl/⌘ or middle) | New tab, full page | Same | Same | Browser behavior |
| "Open full page" (panel button or <kbd>Shift</kbd>+<kbd>Enter</kbd>) | Full page (push) | Same | Same | Already full page |

The default can be changed per user to "always open full page" ([UXD-12](09-decisions-and-risks.md#uxd-12)).

<a id="rs-33"></a>
### RS-33 — Side-panel behavior

- **Non-modal.** It does not trap focus. Focus moves to the panel heading when it opens. <kbd>Esc</kbd> closes it and returns focus to the originating row. The "Skip to details panel" link and the palette's region actions move focus between the list and the panel ([A11Y-KB-04](07-accessibility.md#a11y-kb-04)).
- <kbd>J</kbd>/<kbd>K</kbd> (or panel previous/next buttons) move to the adjacent item in the underlying list and keep the panel open. The list highlights the current item and keeps it scrolled into view.
- If the current item leaves the list because of an edit (for example its status changed and it no longer matches the filter), the panel stays open on that item. A notice in the panel says "No longer matches this view's filters". Previous/next continue from its former position.
- The panel shows the record's own brand marker even when the list is single-brand.
- On Expanded, the panel overlays without changing the list's scroll position. On Wide it docks, and the list keeps its anchor row in view.

<a id="rs-34"></a>
### RS-34 — Surface selection rules

| Surface | Use for | Not for | Modality |
|---|---|---|---|
| **Inline** (in place) | Single-field, reversible edits | Anything needing multiple required fields or confirmation | — |
| **Popover** | Pickers (date, person, label), small previews, field editors | Forms with more than two fields; anything with consequences | Non-modal; light-dismiss |
| **Menu** | Choosing an action or option | Navigation trees, forms | Non-modal |
| **Side panel** | Viewing and editing a record while keeping list context | Multi-step flows, confirmations | Non-modal |
| **Dialog** | Short focused tasks: confirmations, create forms (≤ 8 fields), transition-required fields | Long forms, reading long content, nested dialogs | **Modal**; traps focus |
| **Drawer** | Secondary configuration alongside the page (filters, view settings, AI context) | Primary record content | Non-modal on Expanded/Wide; modal sheet on Compact |
| **Bottom sheet** (Compact) | Pickers, menus, quick capture, filter sets | Long content | Modal; pushes history ([RS-21](#rs-21)) |
| **Full page** | Records, long forms, imports, review of large changes, settings areas, multi-step setup | Quick decisions | — |
| **Banner** (page or section) | Persistent conditions (offline, read-only, degraded, archived, plan limit) | Transient confirmations | — |
| **Toast** | Transient outcomes with optional Undo | Errors that need action, anything the user must read | Non-modal; see [ST-21](06-interaction-states.md#st-21) |

Nested modal dialogs are not allowed. A dialog that needs a sub-choice uses an inline section or a popover. If it needs another full flow, it closes and the flow opens as a page.

<a id="rs-35"></a>
### RS-35 — Surface transitions across width changes

When the width class changes while a surface is open (rotation, window resize, zoom), the surface converts and keeps its content, input and focus:

| Open surface | Expanded → Compact | Compact → Expanded |
|---|---|---|
| Side panel | Becomes the full-screen record page (history entry kept) | Full record page stays full page (no surprise re-layout) |
| Dialog | Becomes a full-screen sheet | Sheet becomes a dialog |
| Drawer | Becomes a modal bottom sheet | Becomes a drawer |
| Popover | Becomes a bottom sheet | Becomes a popover |

Unsaved input is never discarded by a layout change.

## 7. Complex view adaptations

Each complex view keeps the **same data, filters, permissions and actions** at every width; the interaction changes. "Adapted" never means "read-only" unless the view is listed in tier V ([§8](#8-feature-parity-tiers)).

<a id="rs-40"></a>
### RS-40 — Breadcrumbs

Expanded shows the full trail. Medium truncates middle crumbs into an overflow menu ("…"). Compact shows "‹ {Parent}" plus the brand marker, and the overflow menu reveals the full trail.

<a id="rs-41"></a>
### RS-41 — Section and view-tab navigation

Expanded and Medium show a horizontal tab row, which overflows into a "More" menu, never into horizontal scroll alone. Compact shows a section menu button showing the current section ("Tasks ▾"). The same order applies everywhere ([IA §5](02-information-architecture.md#5-project-level-sections)).

<a id="rs-50"></a>
### RS-50 — List

Same on all classes. Compact rows show title, brand marker (multi-brand scope), status icon+label, due date and assignee avatar. Secondary fields move to a second line, not hidden. Row actions are in an overflow button; swipe actions are optional shortcuts that duplicate the overflow ([A11Y-PT-03](07-accessibility.md#a11y-pt-03)).

<a id="rs-51"></a>
### RS-51 — Board

- **Expanded/Wide.** Columns side by side with horizontal scroll, sticky column headers and per-column counts (authorized only).
- **Medium.** Columns at fixed minimum width, horizontal scroll, and a column jump menu.
- **Compact.** One column at a time with a status switcher (segmented control or menu with counts). Cards are full width. Moving a card uses a **Move to…** action (status menu) rather than dragging. A swipe between columns is permitted as a shortcut, with the switcher always present.
- **Ordering within a column.** Every class has "Move up / Move down / Move to top" in the card menu, in addition to drag.

<a id="rs-52"></a>
### RS-52 — Timeline and Gantt

- **Expanded/Wide.** Bars on a time axis with dependency lines, zoom (day/week/month/quarter), and drag to move or resize.
- **Medium.** Same, with a narrower label column. Drag is permitted; date editing is always also available in the detail panel.
- **Compact.** An **agenda-style timeline**: items grouped by phase or milestone, each showing start → end, duration and dependency count, with a mini bar showing its position in the visible range. Editing dates opens the date fields. Dependencies are listed in the item detail ("Blocked by…/Blocks…"). The full graphical Gantt is available in landscape on Medium or larger.
- Moving a scheduled bar never changes a deadline unless explicitly chosen ([J-03](03-journeys.md#j-03-plan-today-across-brands)).

<a id="rs-53"></a>
### RS-53 — Table

- **Expanded/Wide.** A grid with a sticky header, frozen first column (title), horizontal scroll for additional columns, column resize/reorder, cell-level inline edit, and multi-select.
- **Medium.** The same grid with a frozen first column, plus a "Columns" control to reduce visible columns quickly.
- **Compact.** A **card list**. Each card shows the title plus the first three user-chosen visible columns as label–value pairs, with "Show all fields" opening the record. Sorting, filtering, grouping and bulk actions are unchanged. Cell editing happens in the record page. An optional "Grid" toggle shows the real table with horizontal scroll and a frozen first column for users who prefer it.
- Large data conventions are in [DS-60](05-design-system.md#ds-60).

<a id="rs-54"></a>
### RS-54 — Calendar

- **Expanded/Wide.** Day, week, month and agenda views. Drag to schedule and move; resize to change duration.
- **Medium.** Day, week and agenda views fully interactive. Month view shows counts per day, with the day's items listed on selection.
- **Compact.** Agenda (default) and day views. Week view is available as a horizontally paged 3-day view. Scheduling uses **Schedule…** (date, start, duration fields) or a "+" button on each empty slot in day view, never drag or long-press alone.
- Timezone display follows [I18N-10](08-i18n-and-time.md#i18n-10).

<a id="rs-55"></a>
### RS-55 — Workload and capacity

Expanded shows a person × time grid with allocation bars and over-capacity markers. Medium shows the same with fewer columns (week granularity). Compact shows a per-person list with a capacity bar for the selected period and drill-down to the items. Over-allocation is indicated by icon + text ("2 h over"), not colour alone.

<a id="rs-56"></a>
### RS-56 — Dashboards and reports

Expanded uses a widget grid. Medium uses two columns. Compact stacks widgets in a single column in the dashboard's defined order. Every widget offers "View data" (an accessible table equivalent) at every width ([A11Y-SR-08](07-accessibility.md#a11y-sr-08)). Layout editing is tier V on Compact.

<a id="rs-57"></a>
### RS-57 — Documents and rich text

Editing is fully supported at every width. On Compact the formatting toolbar docks above the virtual keyboard and shows the most-used formats plus "More". Block insertion uses a "+" menu and the "/" command. Tables inside documents scroll horizontally within their block with a visible scroll affordance.

<a id="rs-58"></a>
### RS-58 — Complex editors

Builders for automations, workflow transitions, import field mapping, dashboard layout, custom roles and permission matrices are tier **V** on Compact ([§8](#8-feature-parity-tiers)). Medium supports all of them, possibly in a stacked layout.

<a id="rs-59"></a>
### RS-59 — Review and diff screens

AI proposals, agent outputs, deliverable version comparison and import previews use one review layout ([ST-50](06-interaction-states.md#st-50)):

- **Expanded/Wide.** A change list on the left and the selected change's before/after on the right. Side-by-side diff where the format allows.
- **Medium.** The change list with expandable before/after inline.
- **Compact.** One change per card with before/after stacked (inline diff), per-change *Include · Edit · Exclude*, and a sticky footer showing "Apply 3 of 5".
- Approval actions stay reachable without scrolling past evidence: a sticky footer on Compact and a sticky header region on larger classes.

## 8. Feature parity tiers

| Tier | Meaning | Rule |
|---|---|---|
| **F — Full** | Same capability and essentially the same interaction | Default for everything not listed below |
| **A — Adapted** | Same capability and data; interaction redesigned for width or touch | Must be listed in [§7](#7-complex-view-adaptations); nothing the user can do on Expanded is impossible |
| **V — View and act** | Viewable and urgent actions possible; full authoring needs Medium or larger | Must provide (1) full read access, (2) safety actions (pause, disable, stop, revoke, cancel, reject), (3) "Continue on a larger screen" that copies a link or sends it to the user's own email, and (4) an explicit explanatory message, never a blank or broken screen |

**Tier V at launch (Compact only)** — requires product-owner approval as [UXD-02](09-decisions-and-risks.md#uxd-02):

1. Automation builder: create/edit definitions. *View, enable/disable, run history and retry remain available.*
2. Workflow configuration: status transitions, required fields, approval rules.
3. Custom role editing and the bulk permission matrix. *Single member role changes and access revocation remain available.*
4. Import field mapping. *Import status, cancel and rollback remain available.*
5. Dashboard layout editing. *Viewing, filtering and drill-through remain available.*
6. Agent profile authoring. *Pause, cancel run, emergency stop and output review remain available.*

**Launch-critical flows that must be tier F or A on Compact.** Capture; Inbox triage; Today planning; task create/update/complete; comments; notifications; reviews and approvals; AI proposal review; agent output review; time entry and timer; calendar scheduling; guest access to shared content; billing usage, spending caps and cancellation; data export request; integration reauthorize and disconnect.

## 9. Safe areas, touch, reflow and orientation

<a id="rs-60"></a>
### RS-60 — Safe areas

The shell pads for device safe-area insets on all four edges (`env(safe-area-inset-*)` or equivalent). The bottom navigation, floating action button, sticky footers and toasts sit above the bottom inset. Content in landscape is not placed under notches or rounded corners.

<a id="rs-61"></a>
### RS-61 — Virtual keyboard

When the on-screen keyboard is open:

- the focused input scrolls into view and stays unobscured ([A11Y-FO-04](07-accessibility.md#a11y-fo-04));
- sticky action bars (Save, Apply, Send) move above the keyboard using the visual viewport;
- the bottom navigation and floating button hide.

Mobile inputs use font size ≥ 16 px to prevent automatic zoom ([DS-02](05-design-system.md#ds-02)). Inputs declare appropriate `inputmode`, `autocomplete` and `enterkeyhint`.

<a id="rs-62"></a>
### RS-62 — Touch targets and gestures

- Minimum 44 × 44 px on coarse pointers, with at least 8 px between adjacent targets in lists and toolbars.
- Gestures (swipe, long-press, pinch, drag) are optional shortcuts only. Every one has a visible single-tap equivalent ([A11Y-PT-02](07-accessibility.md#a11y-pt-02), [A11Y-PT-03](07-accessibility.md#a11y-pt-03)).
- No custom pull-to-refresh. Data freshness follows [ST-47](06-interaction-states.md#st-47).
- No horizontal swipe gestures on the page edges, which conflict with system Back.

<a id="rs-63"></a>
### RS-63 — Reflow and zoom

All content reflows at a 320 CSS px viewport width (equivalent to 400% zoom at 1280 px) without two-dimensional scrolling. The exceptions are content that requires two dimensions to be meaningful: data tables, timelines, Gantt, calendar week grids, code blocks and wide images. Those scroll within their own container, with the surrounding page still reflowing ([A11Y-VI-04](07-accessibility.md#a11y-vi-04)). Text resizing to 200% causes no loss of content or function ([A11Y-VI-03](07-accessibility.md#a11y-vi-03)).

<a id="rs-64"></a>
### RS-64 — Orientation

The product never locks orientation. Rotating preserves state and input ([RS-35](#rs-35)). Landscape phones usually fall into Medium width with a short viewport ([RS-03](#rs-03)).

<a id="rs-65"></a>
### RS-65 — Supported environments

Supported browsers and their versions are a product-owner decision (see *BUILD_ROADMAP › Proposed approval decisions*; [UXD-21](09-decisions-and-risks.md#uxd-21)). This shell assumes evergreen Chromium, Firefox and Safari (desktop and iOS), and Chrome on Android. Responsive acceptance is tested at widths 320, 375, 600, 768, 1024, 1280, 1440 and 1920 px, in both orientations where applicable, at 200% and 400% zoom, with touch and with keyboard-only input.
