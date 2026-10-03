# 7. Accessibility Baseline (WCAG 2.2 AA)

[← UX foundation index](README.md) · Related: [States](06-interaction-states.md) · [Design system](05-design-system.md) · [Shell](04-responsive-shell.md)

## 1. Target and scope

- **Conformance target: WCAG 2.2 Level AA** for every product surface. That covers:
  - the authenticated application;
  - guest and public views;
  - intake forms;
  - sign-in, sign-up and recovery;
  - onboarding;
  - help pages built by the product;
  - transactional and notification emails (to the extent WCAG applies to HTML email).
- **Pattern source.** Interactive widgets follow the W3C *ARIA Authoring Practices Guide* (APG) patterns named below. Native HTML elements are preferred over ARIA wherever they exist.
- **Criteria format.** Each `A11Y-` item below is written as an **acceptance criterion**: it can be tested, and a later brief can cite it. Items marked **[M]** need manual verification; **[A]** can be largely automated; **[A+M]** needs both.
- **Absolute rule (P-11).** Drag-and-drop, hover, colour and pointer gestures are **never the only way** to complete an action. Every such interaction has a keyboard path and a single-tap or click path that uses visible controls ([A11Y-PT-02](#a11y-pt-02), [A11Y-PT-03](#a11y-pt-03), [A11Y-VI-06](#a11y-vi-06), [A11Y-PT-04](#a11y-pt-04)).

User-generated content (uploaded videos, documents written by customers) cannot be made conformant by the product alone. The product must give authors the means: alt text for images in documents, caption tracks for uploaded video, and heading structure in the editor. It must also keep product chrome conformant around that content ([UXD-22](09-decisions-and-risks.md#uxd-22)).

## 2. Keyboard

<a id="a11y-kb-01"></a>**A11Y-KB-01 — Full keyboard operation [M].** Every function in core workflows ([§9](#9-core-workflows-for-accessibility-acceptance)) can be completed with the keyboard alone, without timing requirements, using standard keys (Tab, Shift+Tab, arrows, Enter, Space, Esc, Home/End, Page Up/Down).

<a id="a11y-kb-02"></a>**A11Y-KB-02 — Logical focus order [M].** Tab order follows the visual reading order: header, navigation, main content, panel. Hidden content (collapsed sidebars, off-screen sheets, inactive tabs) is not focusable. Positive `tabindex` values are not used.

<a id="a11y-kb-03"></a>**A11Y-KB-03 — No traps [A+M].** Focus can leave every component with standard keys. Modal dialogs and sheets *contain* focus while open, and <kbd>Esc</kbd> always closes them, subject to the unsaved-changes prompt ([ST-09](06-interaction-states.md#st-09)). Rich-text editors are exited with <kbd>Esc</kbd> then <kbd>Tab</kbd> ([A11Y-PA-09](#a11y-pa-09)).

<a id="a11y-kb-04"></a>**A11Y-KB-04 — Skip links and region navigation [A+M].** The first focusable element on every page is "Skip to main content". When a detail panel is open, a second skip link, "Skip to details panel", follows it. <kbd>F6</kbd>/<kbd>Shift</kbd>+<kbd>F6</kbd> cycles header → navigation → main → panel ([RS-12](04-responsive-shell.md#rs-12)).

<a id="a11y-kb-05"></a>**A11Y-KB-05 — One tab stop per composite [M].** Lists of records, toolbars, tab lists, menus, grids, boards, calendars and trees are single tab stops with arrow-key navigation inside (roving `tabindex` or `aria-activedescendant`). The last-focused item is remembered when focus returns to the composite.

<a id="a11y-kb-06"></a>**A11Y-KB-06 — Documented shortcuts [M].** Every keyboard shortcut is listed in the shortcut reference (<kbd>?</kbd> and Help) and shown beside its command in menus and the palette. Every shortcut has a non-shortcut equivalent ([RS-12](04-responsive-shell.md#rs-12)).

<a id="a11y-kb-07"></a>**A11Y-KB-07 — Shortcut conflict handling [A+M].**

1. Single-character shortcuts (letters, digits, punctuation, without modifiers) can be **turned off** in Settings, are **never active while focus is in an editable field**, and are documented (WCAG 2.1.4).
2. The product does not override these browser and operating-system shortcuts: <kbd>Ctrl/⌘</kbd>+<kbd>L</kbd>, <kbd>T</kbd>, <kbd>W</kbd>, <kbd>N</kbd>, <kbd>Shift</kbd>+<kbd>N</kbd>, <kbd>Shift</kbd>+<kbd>T</kbd>, <kbd>Tab</kbd>, <kbd>Q</kbd>, <kbd>R</kbd>, <kbd>P</kbd>, <kbd>F</kbd> (find stays native), <kbd>+</kbd>/<kbd>-</kbd>/<kbd>0</kbd> (zoom), <kbd>Alt</kbd>+<kbd>F4</kbd>, <kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd> (history). It also leaves the function keys used by the browser alone.
3. The product does not use the screen-reader modifier combinations: <kbd>Insert</kbd>/<kbd>Caps Lock</kbd> + key (NVDA, JAWS) and <kbd>Ctrl</kbd>+<kbd>Option</kbd> + key (VoiceOver). Screen readers in browse mode intercept single-letter keys, so no workflow depends on single-key shortcuts.
4. A shortcut fires only within its layer ([RS-12](04-responsive-shell.md#rs-12)). The same key never means different things in two contexts the user could confuse.
5. Before 1E finalizes the key map, it is tested with NVDA, JAWS and VoiceOver running ([§8](#8-testing-protocol)).

<a id="a11y-kb-08"></a>**A11Y-KB-08 — Esc closes the topmost layer only [M].** Tooltip, then menu or popover, then sheet or dialog, then side panel.

## 3. Focus

<a id="a11y-fo-01"></a>**A11Y-FO-01 — Visible focus [A+M].** Every focusable element shows the focus indicator in [DS-30](05-design-system.md#ds-30) when focused by keyboard. The indicator contrasts at least 3:1 with adjacent colours (verified by [`check_contrast.py`](tools/check_contrast.py)). This meets 2.4.7 and follows the intent of 2.4.13.

<a id="a11y-fo-02"></a>**A11Y-FO-02 — Focus is never clipped [M].** Containers with `overflow` and virtualized rows do not cut off focus rings.

<a id="a11y-fo-03"></a>**A11Y-FO-03 — Focus management follows ST-90 to ST-95 [M].** That covers opening and closing surfaces, route changes, errors, bulk actions and deletion of the focused item ([06 §11](06-interaction-states.md#11-focus-restoration-and-context-preservation)).

<a id="a11y-fo-04"></a>**A11Y-FO-04 — Focus not obscured [A+M].** A focused element is never fully hidden by sticky headers, bottom navigation, sticky action bars, toasts, chat or AI panels, or the on-screen keyboard. Achieve this with `scroll-padding` matching the sticky regions and by repositioning toasts (WCAG 2.4.11).

<a id="a11y-fo-05"></a>**A11Y-FO-05 — No surprise context changes [M].** Focus or hover never triggers navigation, submission or opening of a new window. Changing a select or checkbox never navigates, except for controls whose label says they navigate, such as a "Go to section" menu (WCAG 3.2.1, 3.2.2).

## 4. Structure, names and announcements

<a id="a11y-sr-01"></a>**A11Y-SR-01 — Landmarks [A].** Each page has exactly one `banner` (shell header), one `main`, a labelled primary `navigation` ("Primary"), and a labelled `search`. The side panel is a `complementary` region (or `region`) named after the record ("Task details: Fix login redirect"). Other navigation regions are labelled ("Project sections", "Breadcrumb").

<a id="a11y-sr-02"></a>**A11Y-SR-02 — Headings [A+M].** Each page has one `h1`: the destination name or record title. Sections use descending heading levels without skips. Panels, dialogs and widgets start at the appropriate level for their position. Visual size never determines the level ([DS-02](05-design-system.md#ds-02)).

<a id="a11y-sr-03"></a>**A11Y-SR-03 — Names and descriptions [A+M].**

- Every control has an accessible name that *contains* its visible label (WCAG 2.5.3).
- Icon-only buttons are named ("Filter", "More actions for Fix login redirect").
- Repeated controls include the item ("Assign Fix login redirect").
- Help text and errors are associated through `aria-describedby`.
- The brand marker's name is "Brand: Optestra" and the workspace marker's is "Workspace".
- Actor avatars include the actor type ("Ana", "Research agent, Agent") ([DS-44](05-design-system.md#ds-44)).

<a id="a11y-sr-04"></a>**A11Y-SR-04 — Announcements and live regions [A+M].**

- The app provides one polite and one assertive live region, managed centrally, so components do not create competing regions.
- **Polite:** save confirmations for explicit saves, "Captured to Inbox", result counts after filtering ("42 tasks"), selection changes in bulk mode, scope switches, panel item changes, undo availability, and background-run completion or review-ready.
- **Assertive:** save failure, conflict, session expiring, permission lost while editing, and background failure that needs action.
- **Rate-limited.** Identical messages are not repeated within 2 s. Streaming AI or agent output is *not* piped into live regions: announce "Response started" and "Response complete: 3 suggestions". Live logs can be read on demand.
- **No announcement** for skeleton or loading churn under 1 s ([ST-40](06-interaction-states.md#st-40)).

<a id="a11y-sr-05"></a>**A11Y-SR-05 — Status messages [A+M].** Save state, execution state, toasts, result counts and validation summaries are exposed as status messages without moving focus, except where [ST-92](06-interaction-states.md#st-92) moves focus deliberately (WCAG 4.1.3).

<a id="a11y-sr-06"></a>**A11Y-SR-06 — Disabled and limited controls explain themselves [M].** A disabled control has its reason in visible text near it, and the reason is reachable by screen readers (for example through `aria-describedby`). The reason must not appear only in a tooltip on a disabled element, since disabled elements may not receive focus ([ST-42](06-interaction-states.md#st-42)).

<a id="a11y-sr-07"></a>**A11Y-SR-07 — Page titles [A].** Each route has a unique, descriptive title per [IA-14](02-information-architecture.md#ia-14), updated on in-app navigation.

<a id="a11y-sr-08"></a>**A11Y-SR-08 — Visual data has a text equivalent [M].** Charts, capacity bars, timelines, Gantt charts, workload grids and calendars provide one of the following:

- a "View data" table;
- an equivalent list view showing the same records, dates and values;
- a text summary ("6.5 of 8 hours committed; 1.5 hours available").

<a id="a11y-sr-09"></a>**A11Y-SR-09 — Images and media [A+M].** Product images have alt text (empty for decorative ones). User-uploaded images in documents get an alt-text field prompted at insert. Attachments are named by file name and type. Product-authored video (onboarding, help) has captions and a transcript. The media player supports captions for uploaded video ([UXD-22](09-decisions-and-risks.md#uxd-22)).

<a id="a11y-sr-10"></a>**A11Y-SR-10 — Language [A].** The page `lang` matches the UI locale. User content with a known different language carries its own `lang` where the editor records it.

## 5. Component patterns

<a id="a11y-pa-01"></a>**A11Y-PA-01 — Dialogs (APG Dialog, Alert Dialog) [M].** The dialog role and accessible name come from its title, and the description from its body. Focus moves to the first meaningful control: the least destructive action for Tier 2 ([ST-33](06-interaction-states.md#st-33)), otherwise the first field. Focus is contained, the background is inert, and Esc closes the dialog. Focus returns to the trigger ([ST-90](06-interaction-states.md#st-90)). Tier 2 confirmations use `alertdialog`.

<a id="a11y-pa-02"></a>**A11Y-PA-02 — Menus (APG Menu Button) [M].** Only *action* lists use the menu role. Navigation lists are links in a list. Arrow keys move, Enter or Space activates, Esc closes and returns focus, and type-ahead jumps to items. Destructive items are announced with their full label ("Delete task…").

<a id="a11y-pa-03"></a>**A11Y-PA-03 — Tabs (APG Tabs) [M].** In-panel content tabs use the tabs pattern with manual activation where switching is expensive. Page-level section tabs that change the URL are a labelled `navigation` of links with `aria-current="page"`, not ARIA tabs.

<a id="a11y-pa-04"></a>**A11Y-PA-04 — Comboboxes and pickers (APG Combobox) [M].** People, record, label and brand pickers announce the result count and the active option. Brand markers in options are in each option's name. "No matches" is announced. Async loading is announced politely.

<a id="a11y-pa-05"></a>**A11Y-PA-05 — Tables and grids [M].**

- Read-only tables use native table semantics with `th` scope and a caption naming the view and scope.
- Editable tables use the **grid** pattern: arrow keys move between cells, Enter or F2 edits, Esc cancels, and Tab leaves the grid.
- Sortable headers expose `aria-sort`.
- Virtualized tables expose row count and index ([DS-60](05-design-system.md#ds-60)).
- Column resize and reorder are available from a header menu ("Move column left/right", "Width…"), not only by dragging.

<a id="a11y-pa-06"></a>**A11Y-PA-06 — Boards [M].**

- Each column is a labelled group with a heading ("In progress, 5 tasks") containing a list of cards. Each card is a list item with a primary link and a "Card actions" button.
- **Keyboard move mode.** With a card focused, <kbd>Space</kbd> (or "Move" in the card menu) picks it up and announces "Picked up Fix login redirect. In progress, position 2 of 5. Use arrow keys to move, Space to drop, Escape to cancel." Arrow keys then move between positions and columns, with each move announced. <kbd>Space</kbd> drops and announces the result. <kbd>Esc</kbd> cancels and returns the card.
- **Pointer alternative without dragging.** A "Move to…" menu offers status and position (top or bottom), plus "Move up/down" (WCAG 2.5.7).
- Drops that trigger a gated transition open the transition form ([ST-71](06-interaction-states.md#st-71)). Focus returns to the card afterwards.

<a id="a11y-pa-07"></a>**A11Y-PA-07 — Calendars and date pickers [M].**

- Date pickers follow the APG date-picker dialog: the grid of days has full date names ("Friday 3 October 2026"), arrow and Page Up/Down navigation, and Home/End for week start and end.
- Typed entry is always available alongside the picker ([ST-77](06-interaction-states.md#st-77)).
- Calendar views expose events as buttons named with title, brand, time range with timezone, and type ("Scheduled block", "Deadline", "External event").
- **Day and week views:** arrow keys move by slot. <kbd>Enter</kbd> on an empty slot opens "Schedule…" for that slot. <kbd>Enter</kbd> on an event opens it.
- **Moving and resizing without dragging:** event actions "Move to…" (date and time fields) and "Change duration…", plus <kbd>Alt</kbd>+arrows to nudge by one slot with an announcement.
- The agenda view is a fully equivalent list.

<a id="a11y-pa-08"></a>**A11Y-PA-08 — Trees (Knowledge, nested tasks, project hierarchy) [M].** APG Tree View: arrows expand and collapse, type-ahead works, and the level is announced. Reordering and nesting are available through a menu ("Move to…", "Indent", "Outdent") in addition to drag.

<a id="a11y-pa-09"></a>**A11Y-PA-09 — Rich-text editing [M].**

- The editor is a labelled multi-line textbox ("Description", "Comment").
- The formatting toolbar is a single tab stop with arrow navigation, and each button exposes its pressed state ("Bold, pressed").
- Keyboard formatting uses standard modifier shortcuts (<kbd>Ctrl/⌘</kbd>+<kbd>B</kbd>/<kbd>I</kbd>/<kbd>K</kbd>).
- Markdown auto-formatting announces the conversion ("Heading level 2").
- **Leaving the editor.** <kbd>Tab</kbd> indents inside lists and code blocks and otherwise moves focus out. <kbd>Esc</kbd> followed by <kbd>Tab</kbd> always leaves, and this is documented in the editor's description.
- Mentions and "/" commands use the combobox pattern ([A11Y-PA-04](#a11y-pa-04)).
- Embedded blocks (tables, images, files, code) are reachable and labelled. Table blocks inside documents use table semantics.
- Collaborative cursors and presence, if built, are announced on demand rather than continuously ([UXD-17](09-decisions-and-risks.md#uxd-17)).
- Suggestions and comments are listed in an accessible sidebar with links back to their anchor.

<a id="a11y-pa-10"></a>**A11Y-PA-10 — Review and diff [M].**

- Each change is announced with record, field, old value, new value and include state ("Change 2 of 5: Due date, from 3 Oct to 10 Oct, included").
- Inline diffs mark insertions and deletions with text equivalents (`<ins>`/`<del>` or visually hidden "added"/"removed").
- Decision buttons name the outcome ([ST-50](06-interaction-states.md#st-50)).

<a id="a11y-pa-11"></a>**A11Y-PA-11 — Toasts and banners [M].** Toasts are status messages that never take focus. Their action (Undo) is reachable by keyboard in two ways: through <kbd>Ctrl/⌘</kbd>+<kbd>Z</kbd>, and through <kbd>F6</kbd> region cycling, which includes the toast region while a toast is visible. Banners are regions with a heading-equivalent name, and critical banners are announced once.

<a id="a11y-pa-12"></a>**A11Y-PA-12 — Side panel [M].** Non-modal, labelled region. Focus moves to its heading on open. The underlying list stays operable. Previous/next controls announce the new item ([RS-33](04-responsive-shell.md#rs-33)).

<a id="a11y-pa-13"></a>**A11Y-PA-13 — Command palette [M].** A modal dialog containing a combobox with a grouped listbox. Group labels are announced. The result count updates politely. Shortcut hints are in each option's description.

<a id="a11y-pa-14"></a>**A11Y-PA-14 — Notifications list [M].** A feed or list. Each item's name includes brand, actor, event and record, and its read state is exposed. Inline actions are separate buttons with item-specific names.

<a id="a11y-pa-15"></a>**A11Y-PA-15 — Timeline and Gantt [M].**

- Bars are focusable items named with title, brand, start, end, duration and dependency count.
- Arrow keys move between items. <kbd>Alt</kbd>+arrows shift dates by one unit, with the change announced.
- "Edit dates…" opens the fields. Dependencies are listed in text in the item detail.
- The compact agenda view is an equivalent ([RS-52](04-responsive-shell.md#rs-52)).

<a id="a11y-pa-16"></a>**A11Y-PA-16 — Generic drag and drop [M].** Every drag interaction (reorder lists, move between groups, schedule onto calendar, resize, upload by drop, column reorder, dashboard layout) has:

1. a keyboard method;
2. a single-pointer method using visible controls, with no path-based or held gesture (WCAG 2.5.7).

During a pointer drag, dropping outside a valid target cancels, and the drag can be aborted with <kbd>Esc</kbd> (WCAG 2.5.2).

<a id="a11y-pa-17"></a>**A11Y-PA-17 — File upload [M].** Every drop zone also has a labelled "Choose files" button. Upload progress, malware scanning and result are announced politely, and errors assertively.

## 6. Visual presentation

<a id="a11y-vi-01"></a>**A11Y-VI-01 — Text contrast [A].** At least 4.5:1, or 3:1 for large text, for all text, including placeholders, metadata and text on status fills. Token pairs are verified by [`check_contrast.py`](tools/check_contrast.py). Text over images or user brand colours is not allowed except inside the brand tile, where [DS-41](05-design-system.md#ds-41) guarantees 4.5:1.

<a id="a11y-vi-02"></a>**A11Y-VI-02 — Non-text contrast [A+M].** Input boundaries, checkbox and radio outlines, focus indicators, meaningful icons, chart series and state indicators contrast at least 3:1 with adjacent colours.

<a id="a11y-vi-03"></a>**A11Y-VI-03 — Resize text [M].** At 200% browser zoom or OS text size, no content or function is lost and nothing overlaps. Typography uses relative units ([DS-02](05-design-system.md#ds-02)).

<a id="a11y-vi-04"></a>**A11Y-VI-04 — Reflow [M].** At 320 CSS px width, content reflows to one column without horizontal scrolling, except the two-dimensional content allowed in [RS-63](04-responsive-shell.md#rs-63), which scrolls within its own container.

<a id="a11y-vi-05"></a>**A11Y-VI-05 — Text spacing [A+M].** Applying WCAG 1.4.12 text-spacing overrides causes no clipping or overlap. Fixed-height text containers are avoided.

<a id="a11y-vi-06"></a>**A11Y-VI-06 — Non-colour indicators [M].** Status, priority, health, risk, execution, save, validation, selection, required, current-page, link and diff indicators use shape or text in addition to colour ([DS-45](05-design-system.md#ds-45)). Charts use labels or patterns. Over-capacity uses an icon and text.

<a id="a11y-vi-07"></a>**A11Y-VI-07 — Forced colours [M].** In Windows high-contrast or forced-colours mode, all controls, focus, selection, borders and status icons remain visible and distinguishable ([DS-23](05-design-system.md#ds-23)).

<a id="a11y-vi-08"></a>**A11Y-VI-08 — Motion and flashing [A+M].**

- Nothing flashes more than three times per second.
- `prefers-reduced-motion` and the in-product setting are honoured ([DS-11](05-design-system.md#ds-11)).
- Auto-updating regions that run longer than 5 s alongside other content can be paused or have their auto-scroll stopped (WCAG 2.2.2). These include streaming run logs, live activity feeds and auto-refreshing dashboards.

<a id="a11y-vi-09"></a>**A11Y-VI-09 — Orientation [M].** Works in portrait and landscape; never locked ([RS-64](04-responsive-shell.md#rs-64)).

## 7. Pointer, touch, forms and time

<a id="a11y-pt-01"></a>**A11Y-PT-01 — Target size [A+M].** Every pointer target is at least 24 × 24 CSS px, or has enough spacing to meet the WCAG 2.5.8 spacing exception. The product standard is 44 × 44 on coarse pointers ([DS-07](05-design-system.md#ds-07)). Inline text links in paragraphs are exempt.

<a id="a11y-pt-02"></a>**A11Y-PT-02 — Pointer gestures [M].** Multi-point gestures (pinch-zoom on timelines, two-finger pan) and path-based gestures have single-pointer alternatives: zoom buttons, scroll buttons, menus.

<a id="a11y-pt-03"></a>**A11Y-PT-03 — Dragging and swiping alternatives [M].** Every drag has a single-pointer non-drag alternative ([A11Y-PA-16](#a11y-pa-16)). Every swipe action (swipe to complete, archive or snooze) is duplicated by a visible button or menu item. Long-press is never the only path.

<a id="a11y-pt-04"></a>**A11Y-PT-04 — Hover and focus content [M].** Tooltips and hover cards appear on focus as well as hover, can be dismissed with Esc without moving focus, can be hovered without disappearing, and persist until dismissed or no longer relevant. Essential information or actions are never hover-only. Hover-revealed row actions are also available through the row's "⋯" menu and are always visible on coarse pointers ([RS-03](04-responsive-shell.md#rs-03)).

<a id="a11y-pt-05"></a>**A11Y-PT-05 — Pointer cancellation and motion actuation [M].** Actions fire on pointer up, not down, and can be aborted by moving off the target. No function depends on device motion (shake, tilt).

<a id="a11y-fm-01"></a>**A11Y-FM-01 — Labels and instructions [A+M].** Every input has a visible, persistent label. Placeholders are never labels. Format hints appear in help text ("e.g. 3 Oct 2026 or tomorrow").

<a id="a11y-fm-02"></a>**A11Y-FM-02 — Required fields [A].** Marked with the text "Required" and `aria-required`.

<a id="a11y-fm-03"></a>**A11Y-FM-03 — Errors [A+M].**

- Invalid fields set `aria-invalid` and reference the error text through `aria-describedby`.
- The error summary is a labelled region of links to each field, and receives focus on submit ([ST-75](06-interaction-states.md#st-75)).
- Error text identifies the field and suggests a correction (WCAG 3.3.1, 3.3.3).

<a id="a11y-fm-04"></a>**A11Y-FM-04 — Input purpose [A].** Personal-data fields (name, email, organization, phone, address, payment fields, one-time code) use correct `autocomplete` tokens.

<a id="a11y-fm-05"></a>**A11Y-FM-05 — Accessible authentication [M].**

- Sign-in, MFA and re-authentication allow paste and password managers, and do not depend on memorizing or transcribing beyond what those support.
- Email links and passkeys are acceptable alternatives.
- Any bot check offers a non-cognitive alternative (WCAG 3.3.8).

<a id="a11y-fm-06"></a>**A11Y-FM-06 — Redundant entry [M].** Within a flow, previously entered information is pre-filled or selectable and not requested again (WCAG 3.3.7). Examples: the brand chosen in a step, or billing details already entered.

<a id="a11y-fm-07"></a>**A11Y-FM-07 — Error prevention for consequential submissions [M].** Financial, legal, data-deleting and access-changing submissions are reversible, checked, or confirmed per the confirmation tiers ([§6.6](06-interaction-states.md#6-confirmation-tiers)) (WCAG 3.3.4).

<a id="a11y-tm-01"></a>**A11Y-TM-01 — Timing [M].**

- Session expiry warns at least 2 minutes ahead with "Stay signed in", and user input is preserved across re-authentication ([ST-08](06-interaction-states.md#st-08)).
- Undo toasts persist at least 10 s and pause on hover or focus ([ST-21](06-interaction-states.md#st-21)).
- No other action has a time limit, except security-defined limits such as one-time codes. Those state their duration and allow requesting a new code (WCAG 2.2.1).

<a id="a11y-co-01"></a>**A11Y-CO-01 — Consistency [M].** Navigation order is the same on every page ([IA-01](02-information-architecture.md#ia-01)). Components with the same function have the same names and icons. Help ("?" in the shell header, and the Help entry in the account menu on Compact) is in the same place on every page (WCAG 3.2.3, 3.2.4, 3.2.6).

<a id="a11y-co-02"></a>**A11Y-CO-02 — Multiple ways [M].** Every record and destination is reachable by at least two of: navigation, search, command palette, links from related records, recents and favorites (WCAG 2.4.5).

## 8. Testing protocol

### Automated (every pull request touching UI; owned by 1A/1E pipelines)

1. **Rule-based scanning** (axe-core or equivalent) in component tests for every component state in [06 §12](06-interaction-states.md#12-reusable-state-matrix), and in end-to-end tests on every route. Zero violations of serious or critical impact may merge.
2. **Token contrast**: `check_contrast.py` or its successor.
3. **Landmark, heading and title checks** per route: one `main`, one `h1`, unique title.
4. **Keyboard scripts** for each core workflow ([§9](#9-core-workflows-for-accessibility-acceptance)) that drive the flow using only keyboard events and assert focus location after each step.
5. **Reflow checks** at 320 px and **target-size checks** on coarse-pointer emulation.
6. **Reduced-motion and forced-colours snapshots** for the shell and core components.

Automated checks find only part of real issues. Passing them is necessary but not sufficient.

### Manual (required before a sub-phase brief is accepted, and before paid launch)

| Check | Method | When |
|---|---|---|
| Keyboard-only walkthrough | Complete each affected core workflow without a pointer; verify order, visibility, no traps, restoration | Every UI sub-phase |
| Screen reader: NVDA + Firefox, NVDA + Chrome (Windows) | Complete affected workflows; verify names, roles, states, announcements | Every UI sub-phase |
| Screen reader: VoiceOver + Safari (macOS) | Same | Every UI sub-phase |
| Screen reader: VoiceOver + Safari (iOS), TalkBack + Chrome (Android) | Affected workflows on Compact | Every sub-phase with mobile-facing UI |
| Screen reader: JAWS + Chrome (Windows) | Core workflows | Before paid launch (11E) |
| Zoom and text | 200% text size; 400% zoom at 1280 px; text-spacing bookmarklet | Every UI sub-phase |
| Forced colours | Windows contrast themes | 1E, then each new component |
| Reduced motion | OS setting on | 1E, then each animated component |
| Touch | Real devices: targets, gestures with alternatives, virtual keyboard behavior ([RS-61](04-responsive-shell.md#rs-61)) | Every sub-phase with mobile-facing UI |
| Cognitive review | Plain-language errors, consistent labels, no unexpected changes | 11E and 12D |

**Severity.** Any failure that prevents completing a core workflow with keyboard or a supported screen reader is a **release blocker**. Failures that make a workflow significantly harder but still completable are high severity. The defect-severity policy is finalized in 12C.

**Evidence.** Each brief's completion response includes the automated report and a manual checklist naming the screen-reader/browser pairs tested, the workflows covered, the defects found and their dispositions.

## 9. Core workflows for accessibility acceptance

These are the workflows meant by the launch requirement "Core workflows pass keyboard and screen-reader accessibility checks" (*FEATURES › Launch acceptance requirements*). The list depends on 0A's catalog for final IDs.

| # | Workflow | Journey |
|---|---|---|
| 1 | Sign up, create workspace and first brand, project and task | [J-01](03-journeys.md#j-01-first-workspace-first-brand-first-project-first-task) |
| 2 | Switch scope between one brand, several and all | [IA-23](02-information-architecture.md#ia-23) |
| 3 | Capture to Inbox and triage | [J-02](03-journeys.md#j-02-universal-capture-to-inbox-to-triaged-work) |
| 4 | Plan Today, reorder, and complete tasks | [J-03](03-journeys.md#j-03-plan-today-across-brands) |
| 5 | Open task details from list, board and table, edit, and return | [J-04](03-journeys.md#j-04-open-task-details-without-losing-view-state) |
| 6 | Move a task on a board, and schedule a task on the calendar, without dragging | [A11Y-PA-06](#a11y-pa-06), [A11Y-PA-07](#a11y-pa-07) |
| 7 | Comment with a mention | [A11Y-PA-09](#a11y-pa-09) |
| 8 | Submit and review a deliverable | [J-05](03-journeys.md#j-05-create-and-review-a-deliverable) |
| 9 | Act on a notification | [J-07](03-journeys.md#j-07-receive-and-act-on-a-notification) |
| 10 | Review and selectively apply AI proposals | [J-08](03-journeys.md#j-08-ai-proposes-record-changes-for-selective-approval) |
| 11 | Review agent output | [J-09](03-journeys.md#j-09-assign-work-to-an-agent-and-review-its-output) |
| 12 | Failed test → defect → verify → release decision | [J-10](03-journeys.md#j-10-failed-test-to-defect-to-fix-to-verification-to-release) |
| 13 | Invite a guest with scoped access | [J-06](03-journeys.md#j-06-invite-a-guest-to-explicitly-scoped-content) |
| 14 | Search and open a result in context; use the command palette | [IA-10](02-information-architecture.md#ia-10), [IA-11](02-information-architecture.md#ia-11) |
| 15 | Manage usage limits, cancel, and export | [J-12](03-journeys.md#j-12-plan-limit-spending-warning-cancellation-and-export) |

## 10. WCAG 2.2 AA traceability

All 55 Level A and AA success criteria in WCAG 2.2 (4.1.1 Parsing is obsolete and removed in 2.2) mapped to the criteria above.

| SC | Name | Level | Covered by |
|---|---|---|---|
| 1.1.1 | Non-text Content | A | SR-03, SR-09, DS-05 |
| 1.2.1 | Audio-only and Video-only (Prerecorded) | A | SR-09; UXD-22 |
| 1.2.2 | Captions (Prerecorded) | A | SR-09; UXD-22 |
| 1.2.3 | Audio Description or Media Alternative | A | SR-09 (transcripts for product media) |
| 1.2.4 | Captions (Live) | AA | Not applicable at launch (no live media); revisit if added |
| 1.2.5 | Audio Description (Prerecorded) | AA | SR-09 (product-authored media) |
| 1.3.1 | Info and Relationships | A | SR-01, SR-02, PA-05, PA-06, FM-01 |
| 1.3.2 | Meaningful Sequence | A | KB-02 |
| 1.3.3 | Sensory Characteristics | A | VI-06; instructions never rely on shape/position alone |
| 1.3.4 | Orientation | AA | VI-09 |
| 1.3.5 | Identify Input Purpose | AA | FM-04 |
| 1.4.1 | Use of Color | A | VI-06, DS-45 |
| 1.4.2 | Audio Control | A | No auto-playing audio; uploaded media never autoplays |
| 1.4.3 | Contrast (Minimum) | AA | VI-01, DS-21 |
| 1.4.4 | Resize Text | AA | VI-03 |
| 1.4.5 | Images of Text | AA | No images of text in product chrome; logos exempt |
| 1.4.10 | Reflow | AA | VI-04, RS-63 |
| 1.4.11 | Non-text Contrast | AA | VI-02, FO-01 |
| 1.4.12 | Text Spacing | AA | VI-05 |
| 1.4.13 | Content on Hover or Focus | AA | PT-04 |
| 2.1.1 | Keyboard | A | KB-01, PA-01…PA-17 |
| 2.1.2 | No Keyboard Trap | A | KB-03 |
| 2.1.4 | Character Key Shortcuts | A | KB-07 |
| 2.2.1 | Timing Adjustable | A | TM-01 |
| 2.2.2 | Pause, Stop, Hide | A | VI-08 |
| 2.3.1 | Three Flashes or Below Threshold | A | VI-08 |
| 2.4.1 | Bypass Blocks | A | KB-04, SR-01 |
| 2.4.2 | Page Titled | A | SR-07, IA-14 |
| 2.4.3 | Focus Order | A | KB-02, FO-03 |
| 2.4.4 | Link Purpose (In Context) | A | SR-03 |
| 2.4.5 | Multiple Ways | AA | CO-02 |
| 2.4.6 | Headings and Labels | AA | SR-02, FM-01 |
| 2.4.7 | Focus Visible | AA | FO-01, DS-30 |
| 2.4.11 | Focus Not Obscured (Minimum) | AA | FO-04, RS-61 |
| 2.5.1 | Pointer Gestures | A | PT-02 |
| 2.5.2 | Pointer Cancellation | A | PT-05, PA-16 |
| 2.5.3 | Label in Name | A | SR-03 |
| 2.5.4 | Motion Actuation | A | PT-05 |
| 2.5.7 | Dragging Movements | AA | PT-03, PA-06, PA-07, PA-15, PA-16 |
| 2.5.8 | Target Size (Minimum) | AA | PT-01, DS-07 |
| 3.1.1 | Language of Page | A | SR-10 |
| 3.1.2 | Language of Parts | AA | SR-10 |
| 3.2.1 | On Focus | A | FO-05 |
| 3.2.2 | On Input | A | FO-05 |
| 3.2.3 | Consistent Navigation | AA | CO-01, IA-01 |
| 3.2.4 | Consistent Identification | AA | CO-01, P-09 |
| 3.2.6 | Consistent Help | A | CO-01 |
| 3.3.1 | Error Identification | A | FM-03, ST-75 |
| 3.3.2 | Labels or Instructions | A | FM-01, FM-02 |
| 3.3.3 | Error Suggestion | AA | FM-03, ST-75 |
| 3.3.4 | Error Prevention (Legal, Financial, Data) | AA | FM-07, ST-33 |
| 3.3.7 | Redundant Entry | A | FM-06 |
| 3.3.8 | Accessible Authentication (Minimum) | AA | FM-05 |
| 4.1.2 | Name, Role, Value | A | SR-03, PA-01…PA-17 |
| 4.1.3 | Status Messages | AA | SR-04, SR-05 |

**FEATURES › Accessibility and internationalization**, mapped:

| Requirement | Covered by |
|---|---|
| Keyboard-only operation for core workflows | KB-01–KB-08, §9 |
| Visible focus states | FO-01, DS-30 |
| Accessible names and descriptions | SR-03 |
| Colour-contrast requirements | VI-01, VI-02, DS-21 |
| Colour not the only status indicator | VI-06, DS-45 |
| Screen readers for navigation, forms, tasks, boards, dialogs | SR-01–SR-10, PA-01, PA-06, FM-01–FM-03 |
| Reduced-motion preferences | VI-08, DS-11 |
| Text resizing and responsive reflow | VI-03, VI-04, RS-63 |
| Accessible validation and error messages | FM-03, ST-74–ST-77 |
| Test core workflows against WCAG 2.2 AA | §8, §9, §10 |
| Timezone, locale, timestamps, localization-ready layouts | [08](08-i18n-and-time.md) |
