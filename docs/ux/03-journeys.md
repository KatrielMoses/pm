# 3. Core Journey Maps

[← UX foundation index](README.md) · Related: [IA](02-information-architecture.md) · [States](06-interaction-states.md) · [Shell](04-responsive-shell.md)

## How to read these maps

Each journey lists actors, the phase that builds it, its **fidelity**, entry points, a happy path, alternate paths, recovery paths, the cross-cutting rules it applies, and its dependencies.

| Fidelity | Meaning | Journeys |
|---|---|---|
| **High** | Step-level behavior is the specification for the building phase | J-01 to J-07 (Phases 1–4) |
| **Medium** | Steps are firm, and screen details are left to the phase brief | J-08, J-11, J-12 (Phases 6, 7, 10) |
| **Lower** | Flow and cross-cutting rules are firm; the screens and the domain detail are deferred | J-09, J-10 (Phases 8–9) |

Lower fidelity never relaxes the cross-cutting rules: brand visibility, permission silence, honest execution state, proportionate confirmation and keyboard/screen-reader operability. A journey that depends on a phase not yet built must not be faked with placeholders; its entry points simply do not appear until that phase ships ([IA-02](02-information-architecture.md#ia-02)).

Names in examples (Ana, Lee, MailAccess, API Access, Optestra) are illustrative.

---

## J-01 First workspace, first brand, first project, first task

- **Actors:** new user who becomes the workspace owner (U1).
- **Phases:** 1B, 1C, 2A, 2B. Guided setup polish, templates and sample workspace: 10B.
- **Fidelity:** High.
- **Launch requirements served:** "create three brands and see them separately and together"; "first useful project and daily plan without configuration assistance".
- **Entry points:** sign-up page; an invitation link (alternate A3).

### Happy path

| # | User does | System shows | Rules |
|---|---|---|---|
| 1 | Signs up and verifies email | Sign-up form with paste and password managers allowed. Verification can complete in another tab, and this tab detects it | [A11Y-FM-05](07-accessibility.md#a11y-fm-05) |
| 2 | Names the workspace | Name field; timezone, locale and week start **detected and shown** for confirmation ("Lisbon, UTC+1 · Change") | [I18N-02](08-i18n-and-time.md#i18n-02) |
| 3 | Creates the first brand | Brand form: name (pre-filled from the workspace name), colour (from a suggestion set), icon (initials by default). A live brand-marker preview shows how it will appear | [DS-40](05-design-system.md#ds-40), [UXD-16](09-decisions-and-risks.md#uxd-16) |
| 4 | Optionally adds more brands | "Add another brand" repeats step 3 inline. Each new brand appears in a live scope-switcher preview. "Continue" is always available | [IA-23](02-information-architecture.md#ia-23) |
| 5 | Creates the first project | Project name with optional starter templates (shown only once 10B exists). The brand is pre-selected when one exists; with several, the user must choose ([IA-21](02-information-architecture.md#ia-21)) | [ST-71](06-interaction-states.md#st-71) |
| 6 | Adds the first task(s) | Quick-capture-style field inside the project: type and press Enter, repeat. Each task appears immediately (optimistic) | [ST-10](06-interaction-states.md#st-10) |
| 7 | Finishes setup | Lands on the project's task list with a dismissible "Next steps" checklist: *Plan today · Connect calendar · Connect GitHub · Import CSV · Invite someone*. Every step is skippable and remembered | *FEATURES › Templates and onboarding* |
| 8 | Switches to All brands | Home shows the all-brands dashboard with one card per brand ([IA-03](02-information-architecture.md#ia-03)); a brand without projects shows an empty state with "Create project" | [ST-43](06-interaction-states.md#st-43) |

### Alternate paths

- **A1 — Template or sample workspace (10B).** Choosing a template previews its components and lets the user install selected parts. A sample workspace is labelled "Sample" on every record's brand marker and can be removed in one action that lists what will be deleted.
- **A2 — Start from CSV (6D).** "Import tasks" replaces steps 5–6 and opens the import flow, with mapping preview and row errors.
- **A3 — Joining by invitation.** The user skips workspace and brand creation and lands per [IA-04](02-information-architecture.md#ia-04). Guests land on Shared with me ([J-06](#j-06-invite-a-guest-to-explicitly-scoped-content)).
- **A4 — Skip the first project.** "Skip for now" lands on Today with an empty state that offers capture. Inbox capture works with no brand or project ([IA-28](02-information-architecture.md#ia-28)).
- **A5 — Compact width.** Each step is a full-screen page with a sticky Continue above the keyboard ([RS-61](04-responsive-shell.md#rs-61)). Progress shows as "Step 2 of 4" in text.

### Recovery paths

- **Abandoned mid-setup.** Every completed step is saved. Returning resumes at the first incomplete step, with earlier steps editable.
- **Network failure on create.** Input is preserved, and the step shows Failed with Retry ([ST-02](06-interaction-states.md#st-02)).
- **Wrong timezone or locale detected.** Editable at step 2, and later in Settings › Language and region.
- **Email not yet verified.** A banner limits only verification-gated actions (defined by 1B, for example inviting others). Creating work is not blocked.
- **Mistyped brand name or colour.** Editable at any time in brand settings. The marker updates everywhere.

### Depends on

[DEP-0A-01](09-decisions-and-risks.md#dep-0a-01) (whether a workspace can have zero brands), 1B verification policy, 10B templates.

### Success signal (for 12D)

Time from sign-up to the first task existing in a project, and the proportion of users completing it without help.

---

## J-02 Universal capture to Inbox to triaged work

- **Actors:** any member (U1, U2). Intake-form submitters and email senders are external sources.
- **Phases:** 2E (capture, deterministic parsing, triage). Email forwarding and intake forms: 2E/6B. API and webhooks: 6B. Voice and AI parsing: 7F.
- **Fidelity:** High.
- **Entry points:** Create button, <kbd>C</kbd>, palette "Capture…", the Compact floating button, inline "Add" in lists. External sources: email forward, intake form, API.

### Happy path

| # | User does | System shows | Rules |
|---|---|---|---|
| 1 | Presses <kbd>C</kbd> on any screen | Quick capture with the text field focused. Mode toggle: Task · Note. The current scope's brand is pre-filled only if exactly one brand is in scope | [RS-10](04-responsive-shell.md#rs-10), [IA-21](02-information-architecture.md#ia-21) |
| 2 | Types "Draft pricing page for Optestra tomorrow 2h #launch" | Detected tokens appear as **removable chips**: brand Optestra · due Tomorrow (Fri 3 Oct) · estimate 2 h · label launch. Detected text is underlined in the input | *FEATURES › Inbox and capture* |
| 3 | Sees an ambiguous detection | "Optestra" matches both a brand and a project. The chip shows "Optestra: brand or project?" with both options. Nothing ambiguous is saved silently | "Show detected values before saving when input is ambiguous" |
| 4 | Presses <kbd>Enter</kbd> | Saves to **Inbox** with the detected values. The surface stays open: "Captured to Inbox · Undo · Open". <kbd>Ctrl/⌘</kbd>+<kbd>Enter</kbd> instead creates the task directly when the brand (and project, if required) is known | [ST-21](06-interaction-states.md#st-21) |
| 5 | Opens Inbox | Triage list. Each item shows the original captured text, its **source** (Typed · Email · Form · API · Voice), detected values, a suggested destination, and its brand marker or "No brand yet" | [IA-28](02-information-architecture.md#ia-28), [ST-47](06-interaction-states.md#st-47) |
| 6 | Triages an item | Panel actions: *Make task · Make note · Make project · Move to… · Merge · Discard*. Making a task opens the inline form with detected values. A brand is required; a project is optional per [DEP-0A-01](09-decisions-and-risks.md#dep-0a-01) | [ST-70](06-interaction-states.md#st-70), [ST-71](06-interaction-states.md#st-71) |
| 7 | Confirms | The item leaves Inbox, the badge decrements, and a toast offers "Open task · Undo". The task's provenance footer shows "Captured from Typed · original text" | [P-03](01-principles-and-users.md#p-03) |

### Alternate paths

- **A1 — Paste multiple lines.** Pasting several lines offers "Create 6 items?" with a per-line preview, edit and exclude ([ST-51](06-interaction-states.md#st-51) layout, without AI).
- **A2 — Attach links and files.** Drop or paste into capture, or use the "Attach" button ([A11Y-PA-17](07-accessibility.md#a11y-pa-17)). Uploads continue in the background, and the item saves immediately.
- **A3 — Email forwarding.** The item appears with source "Email from {sender}", the subject as title, the body preserved, and attachments attached. Sender addresses not linked to a workspace user are labelled "External sender".
- **A4 — Intake form.** Submissions arrive with source "Form: {form name}". Form brand routing is pre-set by the form owner.
- **A5 — Duplicate detected.** "Looks similar to *Draft pricing page* (Optestra, created yesterday) · Merge · Keep both". Duplicate checks consider only records the user can access ([IA-40](02-information-architecture.md#ia-40)). Merge previews the combined result and keeps both sources.
- **A6 — Bulk triage.** Select several items, then "Move to Optestra › Launch" or "Discard" ([ST-12](06-interaction-states.md#st-12)). A mixed-brand selection follows [ST-13](06-interaction-states.md#st-13).
- **A7 — Note to project.** "Make project" opens the project form pre-filled from the note. The note is linked as the project brief.
- **A8 — Voice or AI parsing (7F).** Voice transcription shows the transcript for editing before parsing. AI-detected values are marked "Suggested by AI" and remain removable chips.

### Recovery paths

- **Offline.** Capture queues locally as Pending sync ([ST-05](06-interaction-states.md#st-05)).
- **Parser uncertain or unavailable.** Raw text always saves to Inbox. Parsing never blocks capture ([P-08](01-principles-and-users.md#p-08)).
- **Wrong detection saved.** Chips are editable in triage. Undo reverts the capture within the toast window.
- **Discarded by mistake.** The Inbox "Discarded" filter shows items within the recovery period, with Restore ([ST-46](06-interaction-states.md#st-46)).
- **External source failure.** Email or form ingestion failures surface to the form or address owner in the Activity tray and in notifications, never silently.

### Depends on

[DEP-0A-05](09-decisions-and-risks.md#dep-0a-05) (Inbox item vs note vs task), [DEP-0A-01](09-decisions-and-risks.md#dep-0a-01) (whether a task needs a project).

### Success signal

Capture-to-saved time, and the proportion of Inbox items triaged within 24 h.

---

## J-03 Plan Today across brands

- **Actors:** multi-brand founder (U1).
- **Phases:** 3C (manual planning), 3E (capacity and conflicts), 6C (calendar events), 7F (AI-proposed plan).
- **Fidelity:** High for manual planning; Medium for the AI proposal.
- **Core rule:** committing to Today, ordering, deferring and moving a scheduled block **never change a due date or deadline** unless the user explicitly selects that option (*FEATURES › Today and planning*; *Calendar and scheduling*).

### Happy path

| # | User does | System shows | Rules |
|---|---|---|---|
| 1 | Opens Today (scope: All brands) | Sections: **Unfinished from yesterday** (if any) · **Committed today** · **Scheduled today** · **Overdue** (separate) · **Upcoming deadlines** · **Meetings**. Every item has its brand marker | [IA §4](02-information-architecture.md#4-destination-details), [I18N-16](08-i18n-and-time.md#i18n-16) |
| 2 | Reviews the capacity strip | "Available 5 h 30 min (working hours minus 2 h meetings) · Committed 0 h". A per-brand breakdown is on expand | [RS-55](04-responsive-shell.md#rs-55) |
| 3 | Adds tasks | "Add to Today" from candidates (due soon, high priority, already scheduled), from My Work, or from any task's menu. Each commitment shows its estimate. **Due date stays unchanged**, and the item shows both "Today" and "Due Mon 6 Oct" | [DEP-0A-08](09-decisions-and-risks.md#dep-0a-08) |
| 4 | Over-commits | Warning (icon + text): "1 h 30 min over your available time". Suggested actions: *Defer an item · Schedule on another day · Keep anyway* | *FEATURES: "Warn when daily commitments exceed capacity"* |
| 5 | Orders the list | Drag, or "Move up / Move down / Move to top" in the item menu, or <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> | [A11Y-PA-16](07-accessibility.md#a11y-pa-16) |
| 6 | Time-blocks an item | Drag into the time column (Expanded), or "Schedule…" with start and duration fields. The block is distinct from the due date. "Lock" protects it from automatic rescheduling | [RS-54](04-responsive-shell.md#rs-54) |
| 7 | Works and completes | Marking done (checkbox, <kbd>Space</kbd> on a focused item, or swipe with a button equivalent) moves it to "Done today" with Undo | [ST-11](06-interaction-states.md#st-11) |
| 8 | Ends the day (optional shutdown) | Summary of planned vs completed. Unfinished items each offer *Tomorrow · Pick a day · Remove from plan*; none is moved silently. The record is saved for reports | *FEATURES: "planned versus completed work for each day"* |

### Alternate paths

- **A1 — Single-brand scope.** Lists show only that brand. The capacity strip still shows **total personal capacity**, with a summary line "Other brands: 3 h committed today", so the founder cannot overbook by narrowing scope ([P-02](01-principles-and-users.md#p-02)). Other-brand detail is one click away and needs no extra permission, because these are the user's own commitments.
- **A2 — Cross-brand conflict.** Two brands' blocks or meetings overlap. Both show a conflict marker with both brand markers and "Conflicts with *API Access standup*"; resolving means moving one ([I18N-11](08-i18n-and-time.md#i18n-11)).
- **A3 — Changing a deadline intentionally.** In "Schedule…" or the date fields, "Also change due date" is an explicit, unchecked-by-default option. When chosen, the confirmation names the old and new dates.
- **A4 — Calendar not connected.** Available time comes from working hours only, labelled "Meetings not included: calendar not connected · Connect" ([ST-45](06-interaction-states.md#st-45)).
- **A5 — AI-proposed plan (7F).** "Propose a plan" runs with the context bar ([ST-56](06-interaction-states.md#st-56)). The proposal shows ordered items, each with a **reason** ("Due tomorrow; blocks 2 tasks"), what is **deferred** and why, and locked items untouched. It is reviewed with the [ST-51](06-interaction-states.md#st-51) pattern: accept all, edit, reject, or apply selected. Applying changes Today commitments and blocks, never deadlines unless a change explicitly says so and is included.
- **A6 — Compact.** The capacity strip is pinned. The time column is a toggle ("Plan · Timeline"). Ordering uses the item menu.

### Recovery paths

- **Block moved by mistake.** Undo. History shows the previous time.
- **Deadline changed by mistake.** Undo within the window, otherwise revert from history. The change is attributed in activity.
- **Calendar sync failing.** Meetings show "as of 08:10 · Sync delayed" ([ST-67](06-interaction-states.md#st-67)). Capacity numbers carry "Estimated".
- **Day rolls over mid-work.** Items stay visible under "Unfinished from yesterday" ([I18N-16](08-i18n-and-time.md#i18n-16)).

### Depends on

[DEP-0A-08](09-decisions-and-risks.md#dep-0a-08) (due date vs deadline vs scheduled block vs Today commitment), 3E capacity definitions, 6C calendar.

### Success signal

The proportion of days planned, the committed-vs-available ratio, and planned-vs-completed over time.

---

## J-04 Open task details without losing view state

- **Actors:** any user working in a list-like view.
- **Phases:** 1E (history and state framework), 3A/3B (views).
- **Fidelity:** High.
- **Rules applied:** [RS-20](04-responsive-shell.md#rs-20)–[RS-25](04-responsive-shell.md#rs-25), [RS-32](04-responsive-shell.md#rs-32), [RS-33](04-responsive-shell.md#rs-33), [ST-93](06-interaction-states.md#st-93).

### Happy path

| # | User does | System shows |
|---|---|---|
| 1 | Uses a project's Tasks table: filters (Status ≠ Done, Assignee = me), grouped by milestone, sorted by due date, scrolled to row 140 | URL reflects view, filters, sort and grouping. The scroll anchor is recorded |
| 2 | Clicks a row (or presses <kbd>Enter</kbd>) | The side panel opens with focus on its heading. The URL gains `item=`, and a history entry is pushed. The table keeps its scroll position and highlights the current row |
| 3 | Edits status inline in the panel | Optimistic update. The row updates. If the row no longer matches the filter, the panel notes "No longer matches this view's filters" and the row stays until the panel closes |
| 4 | Presses <kbd>J</kbd> | Next row opens in the panel (history replaced). The table keeps the current row in view |
| 5 | Presses <kbd>Esc</kbd> | Panel closes. Focus returns to the originating row. Scroll position is unchanged |
| 6 | Opens a task full page (<kbd>Shift</kbd>+<kbd>Enter</kbd>), then presses browser Back | Returns to the table with the same filters, sort, grouping, selection (same session) and scroll anchor, and with the panel open on that item |
| 7 | Reloads | Same view, same panel item, same scroll anchor |

### Alternate paths

- **A1 — Board, calendar, timeline.** Same rules. On a board, the panel overlays the board (Expanded) or docks (Wide). On a calendar, the popover summary opens first ([RS-32](04-responsive-shell.md#rs-32)).
- **A2 — Compact.** The row opens a full-screen record page. Back returns to the list at the anchor.
- **A3 — Modified click.** The task opens in a new tab, and the original tab is unchanged.
- **A4 — Sharing the URL.** The recipient sees the same view with the panel if the view is shared with them and they can access the task. If the view is personal to the sender, the recipient gets the task in its project's default view, with a note "The view in this link is personal to its owner". The note reveals nothing about records. If they cannot access the task: [ST-41](06-interaction-states.md#st-41).
- **A5 — Unsaved description edit, then pressing <kbd>J</kbd>.** The description is a draftable input, so its draft is kept ([ST-08](06-interaction-states.md#st-08)) and navigation proceeds. Returning shows "Restored your unsaved draft".

### Recovery paths

- **Task deleted by someone else while open.** The panel shows the deleted state ([ST-46](06-interaction-states.md#st-46)), with Restore if permitted. The list removes the row on refresh.
- **Access revoked while open.** The panel shows "You no longer have access to this item" with no content, and the row disappears ([IA-40](02-information-architecture.md#ia-40)).
- **Panel load error.** The error is confined to the panel with Retry. The list remains usable ([ST-49](06-interaction-states.md#st-49)).

### Success signal

Back/Forward restore accuracy (automated), and user-reported loss of place (12D).

---

## J-05 Create and review a deliverable

- **Actors:** assignee/producer (U2), reviewer (U5).
- **Phases:** 2B (expected deliverable and acceptance criteria fields), 4A (review requests), 4E (files, versions, deliverable workflow).
- **Fidelity:** High.
- **Rule:** completion, submission for review, and acceptance are distinct facts ([DEP-0A-04](09-decisions-and-risks.md#dep-0a-04)).

### Happy path

| # | Actor | Does | System shows |
|---|---|---|---|
| 1 | Producer | Opens a task with expected deliverable type "Design file" and three acceptance criteria | Body shows criteria and a "Deliverables" section with an empty state: "Add the design file for review" |
| 2 | Producer | Uploads a file (button or drop) or links a URL | Upload progress, then Scanning, then Ready ([A11Y-PA-17](07-accessibility.md#a11y-pa-17)). Deliverable state is **Draft**. Linked URLs are stored by reference, not copied |
| 3 | Producer | Chooses "Submit for review" | Dialog: reviewer (pre-filled from the workflow; picker lists eligible people only), optional note. The producer's own self-check of criteria is optional and labelled "Self-check" |
| 4 | System | — | Deliverable becomes **Ready for review** (proposed styling, not success). The task moves to "In review" if the workflow says so. The reviewer is notified |
| 5 | Reviewer | Opens it from Reviews or the notification | Review screen ([ST-50](06-interaction-states.md#st-50)): criteria, file preview, version list, task context, brand marker |
| 6 | Reviewer | Checks criteria and chooses "Accept deliverable" | Deliverable becomes **Accepted** (success). Recorded: who, when, version. The task completes only as its workflow defines. The producer is notified |

### Alternate paths

- **A1 — Request changes.** A reason is required. "Create follow-up task" is optional and pre-filled. The deliverable becomes **Changes requested**. The producer uploads v2, and the reviewer sees "Compare v1 ↔ v2" (side-by-side where the format allows, otherwise metadata and a download for each) ([RS-59](04-responsive-shell.md#rs-59)).
- **A2 — Reject.** A reason is required. The deliverable becomes **Rejected**. The task returns to its workflow's rejection state.
- **A3 — Several deliverables on one task.** Each has its own state. The task shows "1 of 2 accepted" and never "done" unless the workflow's rule is met.
- **A4 — Reviewer on Compact.** Preview, criteria and the decision bar (sticky) are fully supported (tier F).
- **A5 — Self-review policy.** If the producer is the only eligible reviewer and policy forbids self-approval, step 3 says "No eligible reviewer. Ask an admin to assign one" ([ST-50](06-interaction-states.md#st-50)).

### Recovery paths

- **Upload failed or blocked by the malware scan.** The item shows Blocked with the reason. It is never attached silently and never previewed ([06 §12](06-interaction-states.md#12-reusable-state-matrix)).
- **Preview unavailable.** Download remains available, with the file type and size shown.
- **New version uploaded mid-review.** The review screen shows "Changed since you opened this · Reload". The decision applies to the version displayed ([ST-50](06-interaction-states.md#st-50)).
- **Accepted by mistake.** There is no undo. "Reopen review" records a new decision with a reason, and the history keeps both.
- **Reviewer unavailable.** "Reassign reviewer", with history.

### Depends on

[DEP-0A-04](09-decisions-and-risks.md#dep-0a-04), [DEP-0A-11](09-decisions-and-risks.md#dep-0a-11) (deliverable states), 4E file comparison capabilities by format.

---

## J-06 Invite a guest to explicitly scoped content

- **Actors:** a member with share permission (U1/U3); the guest (U4).
- **Phases:** 1D (invitations, guest role), 4A/4E (sharing documents and files). The authorization model is 0C's.
- **Fidelity:** High.
- **Launch requirement served:** "A guest cannot access records outside explicitly granted scope".

### Happy path

| # | Actor | Does | System shows |
|---|---|---|---|
| 1 | Member | Chooses "Share" on a project (or document or task) | Share dialog: people with access (visible to the sharer), "Invite by email", access level (View · Comment · Edit, per 0C), brand marker in the dialog title |
| 2 | Member | Enters a non-member email | "This person will join as a **guest** with access only to what you share" |
| 3 | Member | Reviews the consequence preview | [ST-30](06-interaction-states.md#st-30): "Lee will see project *Website redesign* (Optestra): 41 tasks, 3 documents, 12 files, and the names of 4 people working on it. They won't see other projects or brands." Items linked to records *outside* the share are listed for the sharer: "3 linked items outside this share will not be visible to Lee" |
| 4 | Member | Optionally sets an expiry and a message, then chooses "Invite guest" | Tier 2 confirmation is already part of this dialog (audience and brand named). The invitation is sent, and its pending state appears in the share list |
| 5 | Guest | Opens the invitation email | Email shows: inviter name, brand name, what was shared (one title), access level. No workspace member counts and no other brands |
| 6 | Guest | Signs in or creates an account | Lands on **Shared with me** ([IA-05](02-information-architecture.md#ia-05)) with the project. Reduced navigation |
| 7 | Guest | Works in the project | Sees only shared records. Relationships to unshared records are omitted ([IA-42](02-information-architecture.md#ia-42)). Search covers shared content only. Pickers list only participants ([IA-47](02-information-architecture.md#ia-47)) |

### Alternate paths

- **A1 — Guest already uses the product elsewhere.** Their workspace switcher lists only workspaces they belong to. This workspace appears under its name.
- **A2 — Sharing a sensitive brand's content.** The preview adds a warning banner when the brand or any record is marked sensitive (classification from 0C).
- **A3 — Guest to member.** An admin converts the guest. The preview shows the access gained.
- **A4 — Expiry.** At expiry, access ends. The guest sees [ST-41](06-interaction-states.md#st-41) on old links, and the sharer is notified.
- **A5 — Guest limits by plan.** Follows [J-12](#j-12-plan-limit-spending-warning-cancellation-and-export) A1.

### Recovery paths

- **Wrong email.** Revoke the pending invite (Tier 2, quick). The invitation link stops working.
- **Over-shared.** Remove access (Tier 2). It takes effect promptly, and active guest sessions lose access on their next request ([J-04](#j-04-open-task-details-without-losing-view-state) recovery).
- **Invitation email bounced.** Shown in the share list and in People and roles as "Not delivered", with Resend.
- **Guest follows a link outside scope.** [ST-41](06-interaction-states.md#st-41), identical to not-found.

### Depends on

0C (roles, guest grants, inheritance), [DEP-0A-03](09-decisions-and-risks.md#dep-0a-03) (guest vs limited member), [UXD-06](09-decisions-and-risks.md#uxd-06) (brand identity shown to guests).

---

## J-07 Receive and act on a notification

- **Actors:** any user.
- **Phases:** 4B (notification platform). Events are emitted by their owning phases.
- **Fidelity:** High.

### Happy path

| # | User does | System shows | Rules |
|---|---|---|---|
| 1 | — (Ana mentions the user on an Optestra task) | The bell badge increments. If browser notifications are enabled and it is not quiet hours, one appears: "Optestra · Ana mentioned you on *Fix login redirect*" | [IA-51](02-information-architecture.md#ia-50), [DS-42](05-design-system.md#ds-42) |
| 2 | Activates the notification | The task opens in context, scrolled to the comment, which is briefly highlighted (static highlight under reduced motion). The notification is marked read | [IA-54](02-information-architecture.md#ia-50) |
| 3 | Replies | Comment composer focused under the thread | [A11Y-PA-09](07-accessibility.md#a11y-pa-09) |
| 4 | Presses Back | Returns to the previous screen and state | [RS-21](04-responsive-shell.md#rs-21) |

### Alternate paths

- **A1 — From the notification centre.** Tabs and filters per [IA-50](02-information-architecture.md#ia-50). Inline actions (*Open · Mark done · Mute*) are limited to reversible actions.
- **A2 — Review or approval request.** The inline action is "Review", which opens the review screen. There is never an inline approve ([IA-51](02-information-architecture.md#ia-50)).
- **A3 — Grouped.** "3 comments on *Fix login redirect*" expands to the individual events.
- **A4 — Digest.** Daily or weekly digests group by brand, then by record. Each line links to its record.
- **A5 — Quiet hours.** Non-security notifications are held and delivered at the end of quiet hours, in order, grouped.
- **A6 — Failure notifications.** "Optestra · GitHub sync failed: reconnect required". The action opens the connection with Reconnect ([IA-55](02-information-architecture.md#ia-50)).
- **A7 — Noise control.** "Mute this project/brand/type" is available from each notification's menu, with Undo.

### Recovery paths

- **Record since deleted.** Deleted state if the user can still see it, otherwise [ST-41](06-interaction-states.md#st-41).
- **Access lost.** The row is redacted ([IA-53](02-information-architecture.md#ia-50)).
- **Dismissed by mistake.** Notification history (searchable) with "Mark unread".
- **Channel delivery failing** (email bounces, browser permission revoked). Settings › Notifications shows the channel's status and how to fix it. In-app delivery continues.

### Depends on

[UXD-18](09-decisions-and-risks.md#uxd-18) (channels at launch), [UXD-10](09-decisions-and-risks.md#uxd-10) (minimal content for sensitive brands).

---

## J-08 AI proposes record changes for selective approval

- **Actors:** founder or member supervising AI (U1/U6).
- **Phases:** 7A (budgets), 7B (retrieval and citations), 7C (drafting), 7D (change proposals).
- **Fidelity:** Medium.
- **Rule:** AI never silently edits records. It returns proposed changes for preview, per-change selection, editing and approval ([ST-51](06-interaction-states.md#st-51)).

### Happy path

| # | User does | System shows |
|---|---|---|
| 1 | Opens the AI panel in project *Launch v2* | Context bar: "Optestra · Project: Launch v2 · 54 records · Adjust" ([ST-56](06-interaction-states.md#st-56)). Stale or unapproved sources flagged |
| 2 | Asks: "Break the pricing-page brief into tasks with estimates and acceptance criteria" | If the estimate exceeds the threshold: cost range, remaining allowance and limit, with the start button labelled with the estimate ([ST-62](06-interaction-states.md#st-62)) |
| 3 | Starts | **Running** in the panel and the Activity tray. Run notes are shown separately and labelled unverified ([ST-61](06-interaction-states.md#st-61)). Cancel is available |
| 4 | — | **Draft ready** (proposed styling): 8 new tasks, 2 due-date edits, 1 new milestone. Each change is grouped by record with a brand marker, before/after, rationale with citations to brief sections, and a kind label (Sourced or Suggestion) |
| 5 | Excludes 2 changes, edits one estimate, and notices 1 change flagged "Can't apply: you can't edit tasks in *Billing*" (locked out of selection) | Pre-validation per [ST-51](06-interaction-states.md#st-51) |
| 6 | Chooses "Apply 6 of 8 changes" | The confirmation tier is the highest included. Atomic or individual application is stated before applying ([ST-80](06-interaction-states.md#st-80)) |
| 7 | — | Summary "6 changes applied". Records show "Created by Ana · proposed by AI". AI history stores the prompt, context references, output, applied changes, model, time and cost |

### Alternate paths

- **A1 — AI needs information.** The state is "Needs your input" with the question inline. Nothing is guessed (*FEATURES: "Ask for missing information when required"*).
- **A2 — Multi-brand context.** The context bar lists each brand. Changes to different brands are grouped by brand, and the apply summary names each brand ([ST-13](06-interaction-states.md#st-13)).
- **A3 — Proposal out of date.** A target changed after proposal: the change is marked Out of date, and re-confirmation is required.
- **A4 — Reject all.** "Discard proposal" with optional feedback. The AI history records the rejection.
- **A5 — Compact.** One change per card, with a sticky "Apply n of m" ([RS-59](04-responsive-shell.md#rs-59)).

### Recovery paths

- **AI unavailable.** The panel shows the degraded state and manual paths ("Create tasks manually", "Use a template") ([ST-45](06-interaction-states.md#st-45)).
- **Cancelled mid-run.** **Cancelled**, with whatever partial draft exists labelled "Incomplete draft". It can be reviewed, but is clearly partial.
- **Limit reached.** **Stopped at limit** with a partial proposal labelled as such ([ST-68](06-interaction-states.md#st-68)).
- **Partial apply failure (non-atomic).** "5 of 6 applied · 1 failed", with the reason and fix ([ST-80](06-interaction-states.md#st-80)).
- **Applied something wrong.** Bulk undo within the window ([ST-11](06-interaction-states.md#st-11)). Later, revert from each record's history.

### Depends on

7D atomicity choice ([UXD-15](09-decisions-and-risks.md#uxd-15)), 7A thresholds, 7B citation granularity.

---

## J-09 Assign work to an agent and review its output

- **Actors:** founder or assigner (U1/U6), agent, reviewer (U5).
- **Phases:** 8B (profiles and connectors), 8C (durable runs), 8D (approval and review control plane).
- **Fidelity:** Lower: flow and rules are firm, screens are deferred.
- **Launch requirements served:** "delegate a task to one connected agent workflow"; "review the agent's output before accepting completion".

### Happy path

| # | Actor | Does | System shows |
|---|---|---|---|
| 1 | Assigner | Opens a task with acceptance criteria and an expected deliverable, then chooses Assign → Agent | The agent picker lists only agents permitted for this brand and project. Each shows purpose, scope, tools, limits and approval policy in brief |
| 2 | Assigner | Picks "Research agent" | **Pre-flight sheet:** what will be sent (goal, context records with include/exclude, constraints, inputs, expected deliverable, criteria), estimated cost and limits, and which action classes need approval. The run's scope is the **intersection** of the agent's scope and the assigner's access ([UXD-11](09-decisions-and-risks.md#uxd-11)) |
| 3 | Assigner | Starts the run | The task shows "Assigned to Research agent · Queued", then Running, with structured step progress. Run notes are labelled unverified ([ST-61](06-interaction-states.md#st-61)). The run appears in the Activity tray |
| 4 | Agent | Requests an approval-class action (for example posting externally) | **Waiting for approval**. The approver is notified, and the request opens in the review pattern with the exact action, target, brand and audience ([ST-34](06-interaction-states.md#st-34)) |
| 5 | Approver | Approves or denies | The run continues, or adapts to the denial. Recorded immutably |
| 6 | Agent | Finishes | **Ready for review**, never success. The deliverable is attached to the originating task. Automated criteria checks are shown as evidence |
| 7 | Reviewer | Reviews ([ST-52](06-interaction-states.md#st-52)) | Scope deviations first, then deliverable, criteria, run summary (duration, model, tool calls, cost) and collapsed notes |
| 8 | Reviewer | Accepts | Deliverable Accepted. The task completes only per its workflow. The agent is not the approver; agents never see decision controls for their own output |

### Alternate paths

- **A1 — Request changes.** Feedback creates a follow-up task, or a new run with the feedback attached (a new attempt, history linked).
- **A2 — External agent (API, webhook, MCP-compatible).** Same states and review. The connector's health follows [ST-67](06-interaction-states.md#st-67).
- **A3 — Scope expansion.** The agent asks for more records or tools, which becomes Waiting for approval, with the exact expansion shown.
- **A4 — Low-impact actions under policy.** Shown in the run log as "Allowed by policy: {policy name}", and still audited.

### Recovery paths

- **Failed.** The task is unchanged and **not complete** ([ST-60](06-interaction-states.md#st-60)). The reason and side effects are listed. "Retry failed steps" is safe ([ST-64](06-interaction-states.md#st-64)).
- **Partial or stopped at limit.** Displayed as Failed with partial results kept and labelled. "Continue with more budget" starts a linked attempt and requires usage approval ([ST-68](06-interaction-states.md#st-68)).
- **Cancelled.** **Cancelling…** then **Cancelled**, with the side-effect report ([ST-63](06-interaction-states.md#st-63)).
- **Emergency stop.** Available from the tray on every width ([RS-31](04-responsive-shell.md#rs-31)). The report says how many runs were stopped.
- **Duplicate start.** Prevented ([ST-65](06-interaction-states.md#st-65)).
- **Reviewer lacks access to part of the output.** By UXD-11's default, eligible reviewers must have access to the run's scope, so this does not arise. If 0C chooses otherwise, [IA-48](02-information-architecture.md#ia-48) applies.

### Depends on

[DEP-0A-11](09-decisions-and-risks.md#dep-0a-11) (agent-run states), 8D action classification, [UXD-11](09-decisions-and-risks.md#uxd-11).

---

## J-10 Failed test to defect to fix to verification to release

- **Actors:** tester or developer (U2), founder or release approver (U5).
- **Phases:** 9A (GitHub), 9B (tests), 9C (defects), 9D (releases), 9E (MailAccess, API Access and Optestra contexts).
- **Fidelity:** Lower.
- **Rules:** code merged ≠ defect verified ≠ released ([DEP-0A-04](09-decisions-and-risks.md#dep-0a-04)). Each fact has its own state and visual. Only verification and acceptance are success-styled ([ST-60](06-interaction-states.md#st-60)).

### Happy path

| # | Does | System shows |
|---|---|---|
| 1 | Test results arrive (from Optestra or another runner via API, webhook or report import) | The run summary shows all six result counts (passed, failed, blocked, skipped, not run, flaky; 0A lifecycle §5.3). "Checkout flow · staging" shows **Failed** with evidence: screenshot, trace, logs, URL. The source is labelled ("From Optestra · run #482"). Flaky results never count as passes |
| 2 | Chooses "Create defect" | Defect form pre-filled: title, brand and project (from the test's links), environment, affected version, linked test, and **evidence preserved** (copied or immutably referenced). The user sets severity, reproducibility and owner |
| 3 | Developer links a PR | The defect shows the PR state from GitHub with sync freshness |
| 4 | PR merged | The defect moves to **"Fixed – awaiting verification"** (an `active`-category status in the 0A default defect workflow): neutral styling, not success. Merging never moves it to done |
| 5 | Rerun (manual trigger or CI) passes | The defect shows **"Verified by rerun #491"** (success; `done` category). Manual verification, where policy allows it, shows the verifying person instead |
| 6 | Opens the release | Release record: scope and exclusions, blockers (open defects at or above the configured severity, failing required tests), coverage by critical workflow, checklist, readiness |
| 7 | Requests go/no-go | The approver reviews ([ST-53](06-interaction-states.md#st-53)): blockers first; any open blocker requires a per-blocker acknowledgement and reason |
| 8 | Approver chooses "Approve: Go" | Recorded with approver, evidence snapshot and timestamp (immutable). Deployment state is shown from the provider. The record later shows the deployed version, included changes, known issues and verification results |
| 9 | Publishes release notes (draft generated from accepted changes) | Tier 2 confirmation naming the brand and audience ([ST-33](06-interaction-states.md#st-33)) |

### Alternate paths

- **A1 — Flaky test.** Labelled "Flaky: 3 of last 10 runs failed". Defect creation suggests checking flakiness first, without blocking.
- **A2 — Rerun fails.** The defect returns to its active state, with the new evidence appended and nothing overwritten.
- **A3 — Merged without acceptance checks.** Warning on the task and the release: "Merged without completed acceptance checks".
- **A4 — No-go.** Recorded with a reason. Blockers become assigned work.
- **A5 — Several brands.** MailAccess, API Access and Optestra each have their own release context. Release lists in multi-brand scope carry brand markers ([DEP-0A-12](09-decisions-and-risks.md#dep-0a-12)).

### Recovery paths

- **Ingestion failure.** Visible in integration health and the tray. Missing results are shown as **Not run (no result received)**, never as passed. Unmappable external states show as **Blocked** with the original value visible (0A lifecycle §5.3).
- **Duplicate ingestion.** Idempotent, with no duplicate results (0D).
- **GitHub disconnected.** Links remain, marked "Sync paused" ([ST-67](06-interaction-states.md#st-67)).
- **Mistaken go decision.** A new "Revoke go" decision is recorded. The original is never erased.

### Depends on

[DEP-0A-12](09-decisions-and-risks.md#dep-0a-12) (defect, release, test result definitions and scope), 9B result-state vocabulary, [UXD-14](09-decisions-and-risks.md#uxd-14).

---

## J-11 Connect and disconnect an integration safely

- **Actors:** user (personal calendar) or administrator (workspace or brand connections).
- **Phases:** 6A (framework), 6C (Google Calendar), 9A (GitHub).
- **Fidelity:** Medium.

### Happy path: connect

| # | Does | System shows |
|---|---|---|
| 1 | Chooses "Connect Google Calendar" (Settings › Connected calendars) or "Connect GitHub" (Administration › Integrations, or brand settings) | Explanation before redirecting: what will be read and written, in plain words; **which brand(s)** the connection serves; who will own the connection; how to disconnect |
| 2 | Completes provider authorization | Returns to the same setup step, with no lost context ([RS-22](04-responsive-shell.md#rs-22)) |
| 3 | Configures | Calendar: choose calendars and per calendar "Show events" and/or "Write scheduled work here", plus the brand mapping. GitHub: organizations and repositories mapped to brands and projects, and which fields sync |
| 4 | Tests the connection | "Connection test passed" (success, a deterministic check) or the specific failure |
| 5 | Saves | **Connected**. The initial sync shows progress in the Activity tray. Synced items show their source and freshness ([ST-47](06-interaction-states.md#st-47)) |

### Happy path: disconnect

| # | Does | System shows |
|---|---|---|
| 1 | Chooses Disconnect | Tier 2 dialog: what stops working (sync, automations that use it, listed by name), affected brands, and **a required data choice with no default**: *Keep synced data as read-only copies* or *Remove synced data (1,204 events, 37 links)* |
| 2 | Confirms | **Disconnecting**, then **Disconnected**, with a summary of what was kept or removed. Automations that depended on it are flagged ([ST-67](06-interaction-states.md#st-67)) |

### Alternate paths

- **A1 — Authorization cancelled or denied.** Back to step 1 with "Nothing was connected". No partial connection is stored.
- **A2 — Fewer permissions granted than needed.** "Connected with limited access", with the missing capabilities listed and Reconnect.
- **A3 — Brand-scoped visibility.** Members without access to the mapped brand do not see the connection, its records or its health ([IA-40](02-information-architecture.md#ia-40)).
- **A4 — Connection owner leaves the workspace.** Before removal, the admin is prompted to transfer connection ownership (*FEATURES: "Preserve ownership when members leave"*).

### Recovery paths

- **Expired token.** **Needs reauthorization** on the connection, on affected records (synced fields labelled) and through a notification to the owner. Core work continues ([P-08](01-principles-and-users.md#p-08)).
- **Sync conflict** (event moved in both places). A conflict record appears on the item: *Keep this · Keep {provider} · Edit*, using the [ST-06](06-interaction-states.md#st-06) layout. It is listed in the connection's Conflicts tab.
- **Rate limited or provider outage.** **Delayed**, with the expected recovery and no error spam ([ST-69](06-interaction-states.md#st-69)).
- **Disconnected by mistake.** Reconnect. If data was retained, the previous configuration is offered pre-filled.
- **Removal partly failed.** Partial summary with Retry ([ST-80](06-interaction-states.md#st-80)).

### Depends on

0C (who can configure which connections), 6A data-retention choices, [DEP-0A-01](09-decisions-and-risks.md#dep-0a-01) (connection scope).

---

## J-12 Plan limit, spending warning, cancellation and export

- **Actors:** owner or billing administrator; members affected by limits.
- **Phases:** 7A (AI budgets), 10A (entitlements and billing), 6D (export).
- **Fidelity:** Medium.
- **Rule:** prices, limits, renewal terms, cancellation and export rights are visible *before* commitment. No dark patterns: no hidden cancellation, no forced retention steps, no pre-checked purchases (*FEATURES › Billing and plans*).

### A. Approaching and reaching a plan limit

| # | Who | System shows |
|---|---|---|
| 1 | Owner | At a defined threshold (for example 80%): Administration › Storage and usage, a page banner for owners, and a notification. "Storage 80% used (8 of 10 GB) · Manage storage · See plans" |
| 2 | Member hits the limit (for example uploading) | The upload control is disabled with the adjacent reason "Workspace storage is full. Ask your workspace owner." Owners see "Manage storage · Upgrade" instead ([ST-42](06-interaction-states.md#st-42)) |
| 3 | Anyone | Existing data is never deleted or hidden because of a limit. Core work continues |

### B. AI or agent spending

| # | Who | System shows |
|---|---|---|
| 1 | Owner and the running user | Warnings at configured thresholds: "AI usage 90% of this month's allowance ($18 of $20)" |
| 2 | User starting a run near the cap | Estimate and remaining allowance ([ST-62](06-interaction-states.md#st-62)). If the estimate would exceed the hard cap, the run cannot start |
| 3 | Owner | "Purchase extra usage" is a Tier 2 action with exact price and period. Non-owners get "Request extra usage" (Tier 3), routed to the Reviews queue of owners |
| 4 | Running runs at the cap | **Stopped at limit** (failed or partial), with partial results kept and "Continue with more budget" offered to those who can approve usage ([ST-68](06-interaction-states.md#st-68)). Never silent overage (*FEATURES: "Prevent AI usage from silently exceeding configured limits"*) |

### C. Cancellation

| # | Does | System shows |
|---|---|---|
| 1 | Billing › Cancel subscription (a direct link, never buried) | A **page**, not a dialog: when cancellation takes effect, what happens to access (read-only period), export rights and their duration ([DEP-0A-06](09-decisions-and-risks.md#dep-0a-06)), and a prominent "Export your data" |
| 2 | Optional reason | Optional. At most one clearly skippable alternative offer, never a chain |
| 3 | Confirms "Cancel subscription" | Tier 2. Result: an exact end date and "Resume subscription" available until then. Confirmation email with the same facts |

### D. Data export

| # | Does | System shows |
|---|---|---|
| 1 | Administration › Data and retention › Export | Scope (workspace, brand or project; only scopes the user may export), formats (documented), attachments (archive or references), estimated size. States plainly: "The export includes only data you can access" |
| 2 | Starts | Background job in the tray ([ST-60](06-interaction-states.md#st-60)). The user can leave |
| 3 | Completes | Notification: "Export ready · Download (link expires {date})". If partial: "Exported, except 3 attachments that couldn't be read · View list" ([ST-80](06-interaction-states.md#st-80)) |

### Alternate paths

- **A1 — Plan-gated feature.** Owners see an "Upgrade" marker on the entry point and the plan comparison, including price and minimum charge. Members don't see it ([IA-02](02-information-architecture.md#ia-02)).
- **A2 — Downgrade with usage over the new limits.** The preview lists what becomes read-only or unavailable, and proration is explained before confirming.
- **A3 — Trial ending.** The post-trial price is visible from trial start. Reminders appear before the end, and no charge happens without a visible price.
- **A4 — Payment failure.** A grace-period banner for owners ("Payment failed · Update payment method"). Members see nothing alarming until access is affected. No immediate data loss.

### Recovery paths

- **Cancelled by mistake.** "Resume subscription" until the end date.
- **Export failed.** Retry. Partial results are listed.
- **Cap set too low.** The owner adjusts it, and the change is audited.
- **Billing provider outage.** Billing pages show the degraded state. Product use continues.

### Depends on

10A entitlement model, [DEP-0A-06](09-decisions-and-risks.md#dep-0a-06) (read-only and export durations), 6D export formats.

---

## Journey-to-rule coverage

| Cross-cutting concern | J-01 | J-02 | J-03 | J-04 | J-05 | J-06 | J-07 | J-08 | J-09 | J-10 | J-11 | J-12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Brand marker / scope ([IA-20](02-information-architecture.md#ia-20)) | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ○ |
| Permission silence ([§10](02-information-architecture.md#10-permission-safe-display-rules)) | ○ | ● | ○ | ● | ● | ● | ● | ● | ● | ○ | ● | ● |
| Save / execution state ([06](06-interaction-states.md)) | ● | ● | ● | ● | ● | ○ | ○ | ● | ● | ● | ● | ● |
| Confirmation tiers ([§6](06-interaction-states.md#6-confirmation-tiers)) | ○ | ○ | ● | ○ | ● | ● | ○ | ● | ● | ● | ● | ● |
| Review pattern ([ST-50](06-interaction-states.md#st-50)) | — | — | ● | — | ● | — | ● | ● | ● | ● | — | ● |
| Degraded mode ([ST-45](06-interaction-states.md#st-45)) | — | ● | ● | ● | ○ | — | ● | ● | ● | ● | ● | ● |
| Compact behavior ([04](04-responsive-shell.md)) | ● | ● | ● | ● | ● | ● | ● | ● | ○ | ○ | ○ | ● |
| Keyboard / screen reader ([07 §9](07-accessibility.md#9-core-workflows-for-accessibility-acceptance)) | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ○ | ● |

● specified in the journey · ○ applies through general rules · — not applicable
