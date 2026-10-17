# 6. Interaction and State Standards

[← UX foundation index](README.md) · Related: [Principles](01-principles-and-users.md) · [Accessibility](07-accessibility.md) · [Design system](05-design-system.md)

## 1. How to use this document

Every feature brief from Phase 1 onward must state, for each screen and component it introduces, which of these standards apply. Where none fits, the brief records a deviation for review ([P-09](01-principles-and-users.md#p-09)).

- **IDs.** `ST-` IDs are grouped by topic block (01–09 save, 10–19 optimistic/undo/bulk, 20–24 feedback surfaces, 30–35 confirmation, 40–49 page states, 50–56 review, 60–69 execution, 70–79 editing and validation, 80–83 partial success, 90–95 focus). They are stable labels and do not follow section order.
- **Meanings.** State *meanings* (what "accepted" or "cancelled" means for a record) are 0A's ([DEP-0A-04](09-decisions-and-risks.md#dep-0a-04)). Asynchronous job state *machinery* is 0D's. This document defines how states are **shown** and what the user can **do** in each.
- **Visual tokens** are in [05](05-design-system.md); **announcements and focus** are in [07](07-accessibility.md).

## 2. Save states

<a id="st-01"></a>
### ST-01 — Save-state vocabulary

| State | Meaning to the user | Indicator (record title row, or beside an inline field) | Announcement | User actions |
|---|---|---|---|---|
| **Unsaved** | You changed something that has not been sent | Dot + "Unsaved changes" (forms and documents only; inline edits send on commit) | None | Save, Discard |
| **Saving** | Sent and waiting for confirmation | "Saving…", shown only if more than 400 ms pass, to avoid flicker | None | — |
| **Saved** | The server confirmed the change | "Saved" for 2 s, then quiet "Saved 10:42" (time on focus or hover) | Polite "Saved" only for explicit Save actions | — |
| **Retrying** | Temporary failure; retrying automatically | Warning icon + "Retrying… (attempt 2)" | Polite once | Retry now, Copy my changes |
| **Pending sync** (offline) | Stored on this device; will send when back online | Cloud-off icon + "Pending sync" | Polite once on going offline | Discard pending change |
| **Failed** | The change was not saved and will not be retried automatically | Error icon + "Not saved", with the reason inline | **Assertive** | Retry, Copy my changes, Discard |
| **Conflicted** | Someone or something changed the same data first | Warning icon + "Changed by someone else" | Assertive | Review conflict ([ST-06](#st-06)) |

Rules:

<a id="st-02"></a>
- **ST-02 — Never lose the user's input.** On Failed or Conflicted, the user's value stays visible in the field, never silently reverted. A failed state persists until resolved and is never auto-dismissed.

<a id="st-03"></a>
- **ST-03 — Failure explains itself.** Failure text says what failed, why (when known: validation, permission, limit, conflict, network) and what to do. It never shows raw codes alone. A support reference code may follow the explanation.

<a id="st-04"></a>
- **ST-04 — Automatic retry is bounded and visible.** Only transient failures (network, timeout, server temporarily unavailable) retry automatically, with backoff and a bounded attempt count set by 0D. Validation, permission and conflict failures do not retry.

<a id="st-05"></a>
### ST-05 — Offline and degraded connectivity

- A global banner shows "You're offline. Some changes will sync when you reconnect." It replaces lower-priority banners ([ST-22](#st-22)).
- **Queued locally while offline** (recommended default, [UXD-25](09-decisions-and-risks.md#uxd-25)): quick capture, comments, and single-field edits to tasks the user could already edit. Each is marked Pending sync on its record and listed in the Activity tray.
- **Not queued** (controls disabled with the reason "Needs a connection"): approvals and review decisions, deletion and purge, sharing and permission changes, sending or publishing externally, billing, AI and agent runs, integration actions, imports and exports.
- On reconnection, pending changes send in order. Any that fail or conflict become Failed or Conflicted with the normal actions. Nothing that was queued is dropped without telling the user.

<a id="st-06"></a>
### ST-06 — Conflicts

- **Different fields changed.** Merge automatically. Show a non-blocking notice: "Ana changed Due date while you were editing" with a link to history.
- **Same field changed.** The save becomes Conflicted. The conflict view shows *Theirs* (with actor, actor type and time) and *Yours* side by side, with *Keep theirs · Keep mine · Edit merged value*. On Compact they are stacked.
- **Documents.** Conflict behavior depends on the collaborative-editing decision ([UXD-01](09-decisions-and-risks.md#uxd-01)). Until realtime editing exists, a document saved over a newer version opens the conflict view per section, and the user's version is always kept as a restorable version.
- Integration-synced fields that conflict follow [J-11](03-journeys.md#j-11-connect-and-disconnect-an-integration-safely).

<a id="st-07"></a>
### ST-07 — Stale data while viewing

- **Record open, not editing.** A quiet banner says "Updated by Ana · Refresh". Content never changes under the user's cursor without their action, except save-state and execution-state indicators.
- **Lists.** A chip says "4 updates · Show". Rows do not re-sort or vanish under the pointer while the user is interacting. Applying the updates keeps the scroll anchor ([RS-20](04-responsive-shell.md#rs-20)).
- **Editing.** No interruption. A conflict, if any, surfaces on save ([ST-06](#st-06)).
- **Data older than a freshness threshold** (dashboards, synced records, briefings) shows its age ([ST-47](#st-47)).

<a id="st-08"></a>
### ST-08 — Local drafts

Long inputs (comments, descriptions, documents, create forms with three or more fields, import mappings) keep a per-device local draft. A restored draft is announced: "Restored your unsaved draft · Discard". Drafts are cleared on successful save, on discard and on sign-out, and are never shared with other users.

<a id="st-09"></a>
### ST-09 — Leaving with unsaved changes

Follows [RS-25](04-responsive-shell.md#rs-25). Closing a dialog or panel that has non-draftable unsaved input asks *Keep editing · Discard changes*, with focus on Keep editing.

## 3. Execution states (AI, agents, automations, integrations, imports)

These states apply to **any background operation**: AI actions, agent runs, automation runs, integration syncs, imports, exports, bulk operations that run as jobs, uploads with scanning, and test-result ingestion. The machinery is 0D's. Meanings for agent runs and deliverables are 0A's ([DEP-0A-04](09-decisions-and-risks.md#dep-0a-04), [DEP-0A-11](09-decisions-and-risks.md#dep-0a-11)).

<a id="st-60"></a>
### ST-60 — Execution-state display

| State | Icon (shape) + label | Colour role | What the user sees | Actions |
|---|---|---|---|---|
| Queued | Clock · "Queued" | Neutral | Position or "Waiting to start" | Cancel |
| Running | Ring (static under reduced motion) · "Running" | Info | Elapsed time; measurable progress only ("Step 3 of 8"), otherwise indeterminate | Pause (if supported), Cancel |
| Waiting for input | Hand · "Needs your input" | Warning | The question or missing item, inline | Provide input |
| Waiting for approval | Shield · "Waiting for approval" | Warning | What needs approval, by whom | Review (approver), Withdraw (requester) |
| Paused | Pause bars · "Paused" | Neutral | Who paused it (a person or the emergency stop) and why | Resume, Cancel |
| Cancelling | Ring · "Cancelling…" | Neutral | Shown until the system confirms the stop | — |
| Cancelled | Slashed circle · "Cancelled" | Neutral | What had already happened before cancellation ([ST-63](#st-63)) | Retry, Dismiss |
| Failed | Octagon-x · "Failed" | Danger | Reason in plain words, last successful step, side effects already made | Retry ([ST-64](#st-64)), View details, Dismiss |
| Partial | Half-filled circle · "Partly done" | Warning | "4 of 6 succeeded · 2 failed", with per-item reasons ([ST-80](#st-80)). Agent runs display this as **Failed · partial results kept** (0A lifecycle §5.2) | Retry failed, View details |
| Skipped | Dashed circle · "Skipped" | Neutral | Why it did not execute (conditions not met, or deduplicated) | View details |
| Ready for review | Eye · "Ready for review" | Proposed | Output summary, criteria status, evidence | Review ([ST-50](#st-50)) |
| Accepted / Verified / Completed | Check · label per domain | **Success** | Who accepted or what verified it, and when | — |
| Rejected / Changes requested | Return arrow · label | Neutral / Warning | Reviewer's reason | Revise, Create follow-up |

**Mapping to 0A.** These labels present the shared execution vocabulary in 0A *lifecycle-and-states §5.1* (`queued`, `running`, `waiting`, `paused`, `succeeded`, `partial`, `failed`, `cancelled`, `skipped`), combined with the review axis for agent runs (§5.2). "Waiting for input" and "Waiting for approval" are displays of `waiting`. "Cancelling…" is a transitional UI state, not an execution state. Failed subtypes (error, timed out, limit exceeded, rejected by policy) appear in the reason text.

**Success styling rule.** Success colour and check icons are used only for:

1. outcomes accepted or approved by an authorized person;
2. results verified by a deterministic check (test passed, defect verified by rerun, connection test passed);
3. deterministic system operations that completed every step (automation run with all steps successful, import fully applied, sync up to date).

An AI action or agent run reaching its end is **Ready for review** (or "Draft ready" for AI drafts). It is never success-styled, and it never marks the originating task complete ([DEP-0A-04](09-decisions-and-risks.md#dep-0a-04)).

<a id="st-61"></a>
### ST-61 — Commentary is not progress

Streaming text from an AI or agent ("I've updated the tests…") is shown in a region labelled **Run notes — not verified**, visually separated from structured progress. Progress indicators, step counts and states come only from structured run events. A run's claim that it finished never changes a record's state; only the run's terminal state and a review decision do.

<a id="st-62"></a>
### ST-62 — Cost and limits before running

Before any AI or agent run whose estimated cost exceeds the workspace's "confirm above" threshold, or would use more than a set share of the remaining allowance (thresholds set in 7A), the start control shows:

- the estimated cost as a range, the remaining allowance for the period, and the hard limit;
- what happens at the limit: the run stops and reports partial results;
- the start button labelled with the action, never only "OK". For example, "Run research agent (est. $0.40–0.90)".

If the estimate would exceed a hard limit, the run cannot start. The control explains the limit and offers only what the user's role allows: reduce scope, or request or approve extra usage ([J-12](03-journeys.md#j-12-plan-limit-spending-warning-cancellation-and-export)).

<a id="st-63"></a>
### ST-63 — Cancellation

Cancel takes effect as **Cancelling…** until the system confirms the stop. The final report lists side effects that already happened (records changed, messages sent, files created), so the user can review or undo them. A cancelled run is never shown as failed or as successful.

<a id="st-64"></a>
### ST-64 — Retry

- Retry is safe by contract (0D idempotency). The UI states what will be retried: "Retry 2 failed steps", not just "Retry".
- If the operation had external side effects, the retry confirmation says which will *not* be repeated.
- A retry creates a new attempt linked to the original. The original's history is preserved and visible.

<a id="st-65"></a>
### ST-65 — Duplicate-start prevention

After a start, run or apply action is activated, its control enters a busy state and cannot be activated again until the system responds. If an equivalent run is already active for the same record, the control shows "A run for this task is already in progress · View run" instead of starting another.

<a id="st-66"></a>
### ST-66 — Where execution state appears

Execution state appears in four places:

- on the originating record, as a state-banner slot ([IA §6](02-information-architecture.md#6-record-page-anatomy));
- in the Activity tray ([IA-12](02-information-architecture.md#ia-12));
- on the Runs page;
- as a notification when the run fails, is partial, waits for the user, or is ready for review ([IA-55](02-information-architecture.md#ia-50)).

All four show the same state at the same time.

<a id="st-67"></a>
### ST-67 — Connection health (integrations, calendars, agent connectors)

| State | Display | Actions |
|---|---|---|
| Connected | Check + "Connected", last successful sync time | Test, Settings, Disconnect |
| Syncing | Ring + "Syncing" | — |
| Delayed | Warning + "Last synced 3 h ago", with expected interval | Sync now, View errors |
| Needs reauthorization | Warning + "Reconnect required", with what stops working | Reconnect |
| Error | Danger + reason, failing since | Retry, View errors, Disconnect |
| Disconnecting | Ring + "Disconnecting · removing synced data" (if chosen) | — |
| Disconnected | Neutral + "Disconnected", with data retained or removed as chosen | Reconnect |

Synced records always show their source system and last sync time ([ST-47](#st-47)). Connection status appears on the connection page, on every record synced from it, and in Administration › Integrations.

<a id="st-68"></a>
### ST-68 — Limits reached mid-run

A run that hits a time, token, action or cost limit ends as **Failed: limit reached**, or as **Partial** if some required steps succeeded, matching the 0A failed subtype "limit exceeded". It is labelled "Stopped at limit". The report includes what was completed and what was not. **Continue with more budget** starts a new attempt linked to the original, which requires approval of the extra usage ([J-12](03-journeys.md#j-12-plan-limit-spending-warning-cancellation-and-export)). It is never presented as failed for unexplained reasons, and never as complete.

<a id="st-69"></a>
### ST-69 — Provider outage

When AI or an integration provider is unavailable, its entry points show the degraded state ([ST-45](#st-45)) with the manual alternative. Queued runs show "Waiting for {provider} to recover" rather than failing silently.

## 4. Page and collection states

<a id="st-40"></a>
### ST-40 — Loading

- **First load longer than 300 ms** shows skeletons that match the final layout. A blank page or a lone full-page spinner is never shown. Spinners are only for small in-place operations.
- **Refetching** keeps the existing data visible, with a subtle progress indicator. Content does not flash back to skeletons.
- **Progressive loading.** Shell and navigation render first, then primary content, then secondary widgets. Each dashboard widget loads and fails independently.
- **Long loads.** After 1 s, the region gets `aria-busy` and a polite "Loading tasks…". After 10 s, explanatory text with Retry appears.

<a id="st-41"></a>
### ST-41 — Not available (not found or not authorized: identical)

Shown for deep links and searches that reach records the user cannot access *or* that do not exist, including records purged after deletion:

> **This page isn't available**
> It may have been moved or deleted, or you may not have access. Check the link, or ask the person who shared it.
> [Go to Home] [Search]

- It includes no record title, type, brand, owner or workspace-specific hint, and has the same layout, timing class and page title ("Not available · {Product}") in every case.
- "Request access" is not offered from this page ([UXD-13](09-decisions-and-risks.md#uxd-13)).
- If the user is signed out, sign-in comes first. The not-available state is shown afterwards if still applicable.

<a id="st-42"></a>
### ST-42 — Known limited permission

When the user *can* see a record but not perform some action:

- Controls for actions they can never perform in this context are **absent**.
- A read-only record shows a banner: "You can view this. Editing needs {role} access in {brand}." Naming the brand is safe, because the user can already see the record's brand.
- Where an action is *temporarily* unavailable (locked period, pending approval, plan limit), the control is shown disabled **with the reason adjacent in visible text**, not only in a tooltip ([A11Y-SR-06](07-accessibility.md#a11y-sr-06)).

<a id="st-43"></a>
### ST-43 — Empty (nothing here yet)

The empty state has three parts:

1. a one-line explanation of what will appear;
2. the primary action, if the user may take it (for example "Create a project"), otherwise who can ("Ask an admin of Optestra to add you to a project");
3. optionally, a template or sample.

There is no decorative-only illustration without text, and no empty state that suggests other content exists elsewhere. For guests: "Nothing has been shared with you yet."

<a id="st-44"></a>
### ST-44 — No results and filtered-empty

- **Filtered-empty.** "No tasks match these filters", with the active filters listed as removable chips plus *Clear all filters*. If the shell scope narrows results, say so: "Showing MailAccess only · Show all brands".
- **Search no results.** "No results for 'invoice'", with suggestions (check spelling, remove filters, search all my brands). For limited members and guests: "No results among items you can access". Never "no results in this workspace".
- Filtered-empty never uses the first-use empty state.

<a id="st-45"></a>
### ST-45 — Degraded or unavailable service

- The failure is scoped to the surface that depends on it: an AI panel, a calendar layer, synced fields, briefing widgets. A section banner names the service and the manual path: "AI is unavailable right now. You can keep working; drafting and summaries will return when it recovers."
- Core work (capture, edit, plan, comment, review with existing evidence) stays fully interactive ([P-08](01-principles-and-users.md#p-08)).
- Data from a degraded integration is shown with its last sync time and a "may be out of date" label.
- A platform-wide incident shows one global banner with a link to the public status page.

<a id="st-46"></a>
### ST-46 — In trash (deleted, within the recovery period)

Visible only to users whose current effective access to the record's scope permits editing, and to Trash managers within their currently authorized scopes. Guests never see Trash merely because a record was formerly shared. Banner: "Moved to trash by Ana on 2 Oct · Restore (available until {date})". The record is read-only. Restore returns it, and the rest of its deletion batch, to its original location. If the container is no longer active, the banner explains this and offers the options 0A allows (restore the container, or restore a task as projectless in the same brand). After the recovery period and purge, the record shows [ST-41](#st-41). Recovery durations are a product-owner decision ([DEP-0A-06](09-decisions-and-risks.md#dep-0a-06)).

<a id="st-47"></a>
### ST-47 — Freshness, provenance and estimates

- **Synced or computed data** (integration fields, calendar events, dashboard metrics, briefings, AI answers) shows source and freshness: "From GitHub · synced 4 min ago", "Data as of 09:00". When freshness exceeds the defined threshold, the label becomes a warning.
- **Estimated, incomplete or partial data** carries an explicit "Estimated" or "Incomplete" label with an explanation on focus. It is never only a lighter colour.
- **Record provenance.** Records show source and creation method (typed, captured from email, form, API, integration, AI proposal, agent output) in the provenance footer ([IA §6](02-information-architecture.md#6-record-page-anatomy)).

<a id="st-48"></a>
### ST-48 — Archived

A banner says "Archived on {date} by {actor} · Restore". The record is read-only, except for restoring and commenting where policy allows. Archived records are excluded from default views and searches unless a filter includes them; in that case each carries an "Archived" badge.

<a id="st-49"></a>
### ST-49 — Load error

"Couldn't load {what} · Retry", with a support reference code. The shell and unaffected regions stay usable. Repeated failure offers "Report a problem", which attaches diagnostics only with consent (*FEATURES › Support and feedback*).

## 5. Optimistic updates, undo and bulk actions

<a id="st-10"></a>
### ST-10 — When to update optimistically

| Optimistic (show the result immediately, reconcile on response) | Pessimistic (wait for the server before showing the result) |
|---|---|
| Single-record field edits: title, status (no transition gate), priority, assignee, labels, dates | Status transitions with required fields or approval gates |
| Ordering and moving within a view | Approvals, review decisions, go/no-go |
| Checklist toggles, reactions, follow/unfollow, favorite | Sharing, invitations, role and permission changes |
| Archive and soft delete (with undo) | Purge, workspace/brand deletion, disconnecting integrations |
| Comment post (shown as "Sending…" until confirmed) | Anything external: send, publish, webhook test, sync now |
|  | Billing and usage purchases; AI/agent run start; imports |

If an optimistic change is rejected, the UI restores the previous value *visibly*: inline error at the field, the item stays in place, and an assertive announcement plays. If the change made the item leave the view (for example a status change removed it from a filter), the item returns with an error marker.

<a id="st-11"></a>
### ST-11 — Undo

- Reversible actions (field edits, moves, status changes, archive, soft delete, bulk versions of these) show a toast: "{What happened} · Undo".
- **Undo availability.** The toast stays at least 10 s and pauses while hovered or focused. <kbd>Ctrl/⌘</kbd>+<kbd>Z</kbd> outside editors undoes the last undoable action in the current view. The record's history allows reverting a change later where 0A's rules permit.
- Undo of a bulk action reverts the whole batch as one unit, and reports any items that could not be reverted.
- **Not undoable, so these are confirmed instead ([§6](#6-confirmation-tiers)):** external sends, publishing, purge, approval and release decisions (a reversal is a new, recorded decision such as "Reopen"), purchases, and permission changes. Permission changes are reverted by another change, which the confirmation preview makes clear.

<a id="st-12"></a>
### ST-12 — Bulk actions

- **Selection.** Each row has a checkbox. <kbd>Shift</kbd>+click or <kbd>Shift</kbd>+<kbd>Space</kbd> selects a range. "Select all" selects visible items and then offers "Select all 240 matching items". The count is of authorized items only.
- **Bulk toolbar.** A sticky toolbar appears (on Compact it replaces the top app bar) showing "{n} selected", the available actions and Clear. Actions not valid for every selected item explain how many they apply to: "Assign (38 of 42 eligible)".
- **Preview.** Bulk changes affecting more than 25 items, or *any* item outside the current brand scope, or any Tier 1+ action, show a summary first: "Change status of 42 tasks across 2 brands (MailAccess 30, Optestra 12)".
- **Execution.** Bulk operations longer than about 2 s run as a background job with progress in the Activity tray. The user can keep working. The result follows [ST-80](#st-80).
- **Undo** follows [ST-11](#st-11).

<a id="st-13"></a>
### ST-13 — Cross-brand bulk

When the selection spans brands, the bulk toolbar shows the brand count. Brand-specific actions are offered only for items in a brand where the action is valid, and the toolbar says so ("Move to project: only MailAccess items can move to a MailAccess project"). Examples are moving to a project, applying brand labels and using brand statuses. Moving a record between brands is a separate, explicit action, not a side effect of a bulk move ([DEP-0A-02](09-decisions-and-risks.md#dep-0a-02)).

### Feedback surfaces

<a id="st-20"></a>
- **ST-20 — Choosing a surface.** Use an *inline* message for a field or item problem, a *section banner* for a persistent condition in one area, a *page banner* for a persistent condition affecting the page, a *toast* for a transient outcome of the user's own action, and a *notification* for something the user needs to know later or elsewhere. Background failures use the tray and notifications, never only a toast.

<a id="st-21"></a>
- **ST-21 — Toast rules.** At most one toast is visible (others queue). It is placed bottom-centre on Compact (above the navigation and safe area) and bottom-left on larger classes. It never covers the primary action or a focused element. It is polite, never assertive. A toast with an action lasts at least 10 s and pauses on hover or focus. A toast with no action lasts 5 s. Toasts never carry the only copy of important information; errors needing action are not toasts.

<a id="st-22"></a>
- **ST-22 — Banner stacking.** At most two page-level banners are shown, in priority order: platform incident > offline > account/billing hold > read-only/archived/deleted > degraded service > plan or usage warning. Others collapse into "1 more notice".

<a id="st-23"></a>
- **ST-23 — Announcements.** Status changes the user did not directly cause, such as a background save failure, conflict or run failure, are announced assertively only when they need action; otherwise politely. See [A11Y-SR-04](07-accessibility.md#a11y-sr-04).

## 6. Confirmation tiers

<a id="st-31"></a>
### ST-31 — Tier 0: reversible

No confirmation. Act immediately with undo ([ST-11](#st-11)).

<a id="st-32"></a>
### ST-32 — Tier 1: recoverable but significant

A confirmation dialog states what will happen, the scope ("Archive project 'Launch' and its 84 tasks"), the owning brand, and how to recover. The button names the action ("Archive project"). Focus starts on the action button, because the action is recoverable.

<a id="st-33"></a>
### ST-33 — Tier 2: irreversible, external, financial, access-changing or production-affecting

The confirmation dialog must:

- name the action, the target, the owning **brand** and the **audience or system affected**, for example "Send this release note from Optestra to 1,240 mailing-list subscribers through the connected email provider";
- state irreversibility plainly ("This can't be undone");
- show the consequence summary from [ST-30](#st-30) for access changes, or the cost for financial actions;
- use a specific verb on the button ("Delete permanently", "Send now", "Revoke access", "Purchase $20 of usage") styled as danger for destructive actions;
- place **initial focus on Cancel** for destructive actions;
- require **typing the name** only for workspace deletion, brand deletion and permanent purge of more than 100 records;
- require **re-authentication** for ownership transfer, workspace deletion, disabling MFA, creating API tokens with write scopes, and changing AI provider keys (the mechanism is 1B's).

<a id="st-34"></a>
### ST-34 — Tier 3: requires approval by another person or policy

The initiating user sees "Request approval" instead of the action, then the state "Waiting for approval by {person or role}" ([ST-60](#st-60)). The approver decides through the review pattern ([ST-50](#st-50)). Agents can never satisfy their own approval ([J-09](03-journeys.md#j-09-assign-work-to-an-agent-and-review-its-output)). Self-approval by humans follows workspace policy (0C).

<a id="st-30"></a>
### ST-30 — Consequence preview for access and policy changes

Before saving an invitation, share, role change, permission change, sharing-policy change or public-link creation, show **who gains or loses access to what**. For example: "Lee will be able to view 3 projects and 41 tasks in MailAccess, including 2 documents marked confidential". Counts are computed for the *acting administrator*, who may see them. Changes that expose existing content get a warning-style summary (*FEATURES › Roles and permissions: "Warn before permission changes expose existing content"*).

<a id="st-35"></a>
### ST-35 — Default tier by action class

| Action | Tier | Notes |
|---|---|---|
| Edit fields, change status, reorder, assign, label | 0 | Status transitions with gates open a transition form ([ST-71](#st-71)) |
| Archive or soft-delete a task, document, comment | 0 | Undo + trash |
| Archive or soft-delete a project or brand; bulk changes over 25 items | 1 | Scope count in dialog |
| Restore | 0 | Explains if parent is missing |
| Permanently delete from trash (purge); delete workspace or brand permanently | 2 | Type-to-confirm per ST-33 |
| Invite member/guest, share, change role, make public link | 2 | With consequence preview ([ST-30](#st-30)) |
| Revoke access, remove member, revoke sessions or API tokens | 2 | States what stops working |
| Disconnect an integration | 2 | Data-retention choice ([J-11](03-journeys.md#j-11-connect-and-disconnect-an-integration-safely)) |
| Send external message, publish, outbound webhook test to production | 2 (human) / 3 (agent, per policy) | Brand and audience named |
| Purchase usage, change plan, cancel subscription | 2 | Price, proration and renewal shown ([J-12](03-journeys.md#j-12-plan-limit-spending-warning-cancellation-and-export)) |
| Agent actions in approval-required classes (external, publishing, spending, access, destructive, production, scope expansion) | 3 | *FEATURES › Agents and execution* |
| Release go/no-go | 3 | Recorded immutably |
| Emergency stop of all agent runs | 2 | No type-to-confirm ([RS-31](04-responsive-shell.md#rs-31)) |
| Apply AI-proposed changes | Per change content: the highest tier of any included change | [ST-51](#st-51) |

## 7. Inline editing versus full forms

<a id="st-70"></a>
### ST-70 — Inline editing

Use inline editing for **single, independent, reversible fields** on records the user may edit: title, status without gates, priority, assignee, dates, labels, estimates and simple custom fields.

- Activation: click or Enter on the field, which shows edit affordances on focus and hover. On touch, a tap opens the field's editor (popover or sheet).
- Commit on Enter (single-line), on blur, or by selecting from a picker. Cancel on Esc, which restores the previous value.
- Save state appears beside the field ([ST-01](#st-01)).
- Validation is immediate on commit. An invalid value keeps the field in edit mode with the error below it.

<a id="st-71"></a>
### ST-71 — Full forms (dialog or page)

Use a full form when any of the following apply:

- creating a record with more than one required field;
- a status transition requires fields or approval;
- fields depend on each other (recurrence, budget with currency, permission grants);
- the change is Tier 1 or higher;
- the input is long or structured (acceptance criteria, automation conditions).

Forms with up to 8 fields use a dialog (a full-screen sheet on Compact). Longer forms use a page. Required fields are labelled "Required" in text. Optional fields are not marked unless most fields are required.

<a id="st-72"></a>
### ST-72 — Same field, same editor

A field type uses the same editor everywhere: inline, in forms, in bulk edit, in filters (where applicable) and in AI-proposal editing.

## 8. Validation

<a id="st-74"></a>
### ST-74 — Timing

- Do not show errors while the user is still typing in a field for the first time.
- Validate format and constraints **on blur** (leaving the field), and everything **on submit**.
- Once a field shows an error, re-validate **on input**, so the error clears as soon as it is fixed.
- Asynchronous checks (name uniqueness, email deliverability) run on blur, with a "Checking…" indicator, and never block typing.

<a id="st-75"></a>
### ST-75 — Placement and content

- The error appears directly below the field, starting with an error icon and the word "Error:" visually hidden for screen readers. It is linked to the field's description ([A11Y-FM-03](07-accessibility.md#a11y-fm-03)).
- The text says what is wrong and how to fix it: "Enter a date after the start date (3 Oct)", not "Invalid".
- On submit with errors, an **error summary** appears at the top of the form, listing each error as a link to its field. Focus moves to the summary ([ST-92](#st-92)). For single-field forms, focus moves to the field instead.
- **Submit buttons stay enabled.** Problems are explained on submit rather than by disabling the button without explanation. The exception is busy state during submission ([ST-65](#st-65)).

<a id="st-76"></a>
### ST-76 — Server-side validation

Server validation errors (format defined by 0D) map to fields where possible. Errors that do not map to a field (permission, limit, conflict) appear in the summary with the next step.

<a id="st-77"></a>
### ST-77 — Never punish entry

The form preserves all input on error, accepts pasted values, does not reformat while the user types (format on blur), and accepts common date and number formats for the user's locale ([I18N-20](08-i18n-and-time.md#i18n-20)). Information already given in the same flow is not asked for twice ([A11Y-FM-06](07-accessibility.md#a11y-fm-06)).

## 9. Partial success and per-item errors

<a id="st-80"></a>
### ST-80 — Result summaries

Any operation over multiple items (bulk edit, import, AI-proposal apply, automation run, notification batch, agent run with several steps) ends with a summary:

> **38 of 42 tasks updated.** 4 could not be updated. [Review 4 failures] [Retry failed]

- The summary is never success-styled unless all items succeeded ([ST-60](#st-60)).
- Per-item results list each failure with the record (brand marker, title), the reason and a direct fix or retry.
- Succeeded items stay applied. If the operation is **atomic** (all or nothing), the UI says so *before* the user starts ("These changes are applied together; if one fails, none are applied"), and failure reports that nothing changed ([UXD-15](09-decisions-and-risks.md#uxd-15)).

<a id="st-81"></a>
### ST-81 — Failures stay findable

Per-item failure lists stay reachable after the toast or dialog closes, through the Activity tray and the Runs page, until dismissed.

## 10. Preview, approve, edit and reject

<a id="st-50"></a>
### ST-50 — The review pattern

One layout for every reviewable object: deliverable, AI change proposal, agent output, gated status transition, test-case interpretation, defect verification, release go/no-go, time sheet, access request and extra-usage request.

```
┌ Header: [Brand] Type · Title · requested by {actor + actor type} · due {date}  ─────────┐
│ What you're deciding (one sentence)                                                    │
├ Criteria ─────────────────────┬ Evidence / changes ─────────────────────────────────────┤
│ ☐/☑ acceptance criteria with   │ files, versions (compare), test results, links,        │
│ per-criterion status and       │ diffs, run summary, cost, scope deviations             │
│ automated checks labelled as   │                                                         │
│ "Automated check" (not review) │                                                         │
├ History: previous versions and decisions ──────────────────────────────────────────────┤
│ Decision: [Accept …] [Request changes] [Reject]   reason field   ☐ create follow-up task │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

Rules:

- **Decision buttons name the outcome:** "Accept deliverable", "Apply 3 changes", "Approve: Go", "Verify fix". Request changes and Reject require a reason. Accept optionally takes a note.
- **Evidence is beside the decision**, not behind tabs, on Expanded and Medium. On Compact, the decision bar is sticky and the evidence scrolls ([RS-59](04-responsive-shell.md#rs-59)).
- **Automated validation** ("3 of 4 acceptance checks passed automatically") is shown as evidence. It is never presented as the review decision.
- **Self-review.** If the reviewer produced the item and policy prevents self-approval, the decision buttons are absent and the screen says who can approve. Agents never see decision controls for their own outputs.
- **Stale review.** If the reviewed object changes during review (new version, record changed), the screen shows "Changed since you opened this · Reload" and the decision applies only to the version shown, which the decision records.
- **Recording.** Decisions show who, when, which version and evidence snapshot, and are immutable ([DEP-0A-04](09-decisions-and-risks.md#dep-0a-04)).
- **Follow-ups.** "Request changes" can create follow-up tasks from the feedback, pre-filled and editable, on the same brand and project.

<a id="st-51"></a>
### ST-51 — AI change proposals

- Proposed changes are grouped by record. Each shows its brand marker, field, before → after, and rationale with citations.
- Each change has **Include** (checked by default only when the user started the action explicitly for this purpose), **Edit** (opens the same field editor, [ST-72](#st-72)) and **Exclude**.
- Pre-validation marks changes that would fail (permission, required field, conflict) *before* apply, with the reason. Those cannot be included until fixed.
- A change whose target record changed since the proposal is marked **Out of date** and requires refresh or explicit re-confirmation.
- The apply button counts the selected changes ("Apply 3 of 5 changes"). The confirmation tier is the highest tier among included changes ([ST-35](#st-35)).
- Applied changes are attributed in history as "Applied by Ana · proposed by AI".
- **Phase 7D (ADR-0040):** the review page lists changes in their dependency order, each with its target, before → after through current access, and the sources it is based on. Selection shows dependency feedback live ("Change c2 needs change c1") and never adds a change silently. Edits are saved as a new revision and need a new approval; unsaved edits are kept on the device across a refresh, a conflict, or going offline. Apply is atomic: the outcome is either "Applied n change(s)" or "Nothing was applied", with each change shown as applied, failed, rolled back, not attempted, or not selected. A withheld or erased proposal shows no content. A repeated click sends one request.

<a id="st-52"></a>
### ST-52 — Agent outputs

The review screen adds the following:

- a run summary (state, duration, model, tool-call count, cost);
- **scope deviations**: any action outside the original scope is flagged at the top;
- the deliverable with versions;
- acceptance-criteria checks.

Run notes are available but collapsed and labelled as unverified ([ST-61](#st-61)). Accepting the output is what may complete the task, per the task's workflow ([J-09](03-journeys.md#j-09-assign-work-to-an-agent-and-review-its-output)).

<a id="st-53"></a>
### ST-53 — Release go/no-go

Blockers and failing required checks are listed first. "Go" with open blockers requires acknowledging each blocker with a reason. The decision records the approver, the evidence snapshot and the timestamp ([J-10](03-journeys.md#j-10-failed-test-to-defect-to-fix-to-verification-to-release)).

<a id="st-56"></a>
### ST-56 — AI action anatomy

Every AI action surface (assistant panel, "Draft with AI", summaries, briefings) shows:

- a **context bar** before running: brand marker(s), scope (workspace, brand, project or task), and the number of records included, with **Adjust**, which lets the user include or exclude records (*FEATURES › AI assistant*);
- warnings when the context includes **stale or unapproved sources**;
- output labelled by trust: **Facts from the records** (canonical fields, with citation links) and **Calculated** (server calculations) are the only established statements. Model output is labelled separately:
  - **Exact excerpt**: the source's own matched text.
  - **Unverified** (generated): any other claim, even one that cites a source or quotes it. The quotation is shown as provenance.
  - **Suggestion**.
  - **Unknown/needs input**.
  An answer cut off before completion is shown as incomplete, never as an answer. Labels use text and icon, not colour alone (7B corrective review 01, ADR-0039 D7);
- cost per [ST-62](#st-62) where applicable;
- the result as a *draft* or *proposal*, never written to records without [ST-51](#st-51).

## 11. Focus restoration and context preservation

<a id="st-90"></a>
- **ST-90 — Closing a dialog, popover, menu or sheet** returns focus to the element that opened it. If that element no longer exists (the item was deleted), focus moves to the next logical item (next row, otherwise the list heading) and the change is announced.

<a id="st-91"></a>
- **ST-91 — In-app navigation** moves focus to the new page's main heading (`h1`) and announces the page title. Back and Forward also restore the scroll anchor ([RS-20](04-responsive-shell.md#rs-20)). When the restored page has an open detail panel, focus goes to the item that was focused.

<a id="st-92"></a>
- **ST-92 — Submission errors** move focus to the error summary (or to the single field in a one-field form).

<a id="st-93"></a>
- **ST-93 — Closing the side panel** returns focus to the originating row. Deleting the current item from the panel moves to the next item in the list, or closes the panel if none remain, and announces it.

<a id="st-94"></a>
- **ST-94 — Bulk actions** keep focus on the bulk toolbar while running and move it to the result summary when finished.

<a id="st-95"></a>
- **ST-95 — Undo** returns focus to the restored item when it is in the current view.

## 12. Reusable state matrix

Every reusable surface must implement the states in its row. A dash means the state does not apply. "Perm." means known-limited permission ([ST-42](#st-42)); not-available ([ST-41](#st-41)) applies to every addressable surface.

| Surface | Loading | Empty | Error | Perm. | Degraded | Success |
|---|---|---|---|---|---|---|
| List / board / table / calendar view | Skeleton rows; keep data on refetch | First-use empty, filtered-empty, scope-narrowed empty | Load error with Retry | Read-only rows; edit affordances absent | Synced fields labelled "may be out of date" | Optimistic update; undo toast |
| Record page / side panel | Skeleton header + body | — | Load error; save Failed per field | Read-only banner | Integration/AI sections degraded only | Save state "Saved" |
| Inline field edit | "Saving…" (> 400 ms) | — | Failed / Conflicted at field | Field not editable (no affordance) | Pending sync (offline) | "Saved" indicator |
| Create form / dialog | Busy submit | — | Error summary + inline errors | Record types not creatable are absent | AI-assisted fill hidden; form still works | Toast with Open + Undo |
| Quick capture | Busy submit | — | Failed with text preserved; Pending sync offline | — | AI parsing off → plain text saved to Inbox | "Captured to Inbox" |
| Search / command palette | Inline progress | No results with suggestions | Search unavailable → exact-match fallback or message | Results limited to accessible items | Index catching up notice; semantic search off | Results |
| Notifications centre | Skeleton | "You're all caught up" | Load error | Lost-access rows redacted ([IA-53](02-information-architecture.md#ia-50)) | Delivery channel issues noted in Settings | Mark read/dismiss with undo |
| Dashboard widget | Per-widget skeleton | "No data for this period" | Per-widget error | Widget absent if no access to source | "Data as of …" stale label | Values with freshness |
| File upload / deliverable | Progress % then "Scanning" | Drop zone with instructions | Failed, Blocked (malware), Over quota | Upload absent | Preview unavailable → download still offered | "Ready" (not "accepted") |
| Rich-text document | Skeleton | Template picker | Save Failed; Conflicted per section | Read-only banner; comment-only mode | Embeds from integrations show placeholders with source | Save state |
| Review screen | Skeleton | — | Decision failed (choice preserved) | Decision controls absent + who can decide | Evidence from degraded sources labelled | "Accepted by … at …" |
| AI assistant / AI action | Running state | Prompt suggestions scoped to context | Failed with Retry; Partial | AI absent if not permitted | "AI unavailable" + manual path | "Draft ready" (not success) |
| Agent run view | Queued / Running | — | Failed, Stopped at limit, Partial | View-only for non-supervisors | "Waiting for provider" | Ready for review → Accepted |
| Automation run history | Skeleton | "No runs yet" | Failed steps listed | View-only | Trigger source degraded noted | Completed (all steps) |
| Integration connection | Testing… | "Not connected" with Connect | Error / Needs reauthorization | Configure absent | Delayed sync | Connected + last sync |
| Import | Validating → Importing % | — | Row-level errors | Import absent | — | "Imported 1,200 rows" with rollback window |
| Export | Preparing % | — | Failed with Retry | Only permitted data exported, stated up front | — | "Ready to download" (expiry shown) |
| Billing and usage | Skeleton | — | Payment failed banner + recovery | Billing absent for non-billing roles | Usage "as of" label | Receipt link |
