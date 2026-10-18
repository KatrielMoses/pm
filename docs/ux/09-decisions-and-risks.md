# 9. UX Decision, Dependency and Risk Register

[← UX foundation index](README.md)

## 1. How to use this register

- **Decisions (`UXD-`)** are open UX choices. Each has a **recommended default** that the rest of this set already assumes. If the product owner approves the default, nothing else changes. If they choose differently, the rules citing the decision must be updated in the same change.
- **Dependencies (`DEP-0A-`)** are terms or semantics this set needs from Phase 0A. The UX rules are written to survive either plausible 0A outcome. Where they would not, the entry says what would change.
- **Risks (`UXR-`)** are ways the design could fail users even if built as specified, with mitigations and the evidence that would show the risk materializing.
- **Deviations from [P-09](01-principles-and-users.md#p-09)** (a one-off interaction model) are recorded as new `UXD-` entries before implementation.
- **"Resolve by"** is the latest phase whose brief needs the answer. Resolving earlier is cheaper.

**Approval key.** **PO** = product owner must approve · **SA** = solutions architect can approve · **0C**/**1E**/etc. = owned by that brief, with UX constraints stated here.

## 2. Dependencies on Phase 0A

| ID | Needed from 0A | What this set assumes now | If 0A decides otherwise | Cited by |
|---|---|---|---|---|
| <a id="dep-0a-01"></a>DEP-0A-01 | Record hierarchy and scope: which records are workspace-, brand-, project-, task-scoped or personal; whether tasks need a project; whether a workspace may have zero brands; connection scope | Projects, tasks and goals belong to exactly one brand. Tasks may lack a project. Inbox items may lack a brand. Some documents and goals are workspace-scoped. A workspace needs one brand before brand-owned records exist | Brand marker and IA-21 rules apply to any record that ends up brand-owned. A workspace marker is used for workspace-owned ones. J-01 step 3 changes if zero-brand workspaces are allowed | IA §1, IA-28, J-01, J-02, J-11 |
| <a id="dep-0a-02"></a>DEP-0A-02 | Cross-brand sharing semantics; whether records can move between brands; cross-brand relationships | Sharing is explicit and does not change ownership. Moving between brands is a separate explicit action | IA-26 display rules stay. If moving is disallowed, the "Move to brand" action is removed | IA-26, ST-13 |
| <a id="dep-0a-03"></a>DEP-0A-03 | Role names and the difference between limited member, guest and read-only | Guests see only explicitly shared records and a reduced shell. Limited members see the standard shell reduced to grants | IA-05 navigation sets are re-mapped to the final roles | 01 §1.2, IA-05, J-06 |
| <a id="dep-0a-04"></a>DEP-0A-04 | Lifecycle and state meanings: completion vs submitted vs accepted; status categories; immutability of decisions | These are distinct facts. Status categories are Not started, Active, Paused, Done, Cancelled. Blocked and review are separate derived/overlay axes. Decisions are immutable | DS-46 icons map to the final categories. ST-60 success rule is unchanged (it keys off "accepted/verified", whatever 0A names them) | ST-60, ST-50, DS-46, J-05, J-10 |
| <a id="dep-0a-05"></a>DEP-0A-05 | Names and distinctions for Inbox item, note and task | "Inbox" holds untriaged captured items that become tasks, notes or projects | IA-07 separation of Inbox and Notifications remains whatever the name | IA-07, J-02 |
| <a id="dep-0a-06"></a>DEP-0A-06 | Deletion, trash, purge, post-cancellation read-only and export semantics (durations are PO decisions) | A recovery period exists. Read-only and export periods exist after cancellation | ST-46 and J-12 show whatever durations are approved; no duration is promised in this set | ST-46, J-12 |
| <a id="dep-0a-07"></a>DEP-0A-07 | "Follow" vs "watch" (FEATURES uses both: "watchers and followers") | One concept, "Follow" | If both exist with different meanings, My Work › Following splits into two filters | IA-08 |
| <a id="dep-0a-08"></a>DEP-0A-08 | Time semantics: start date, due date, deadline, scheduled block, Today commitment; date-only vs instant; the timezone that anchors due dates | Due date is date-only (recommended). Deadline may carry a time. Scheduled block is a time range. A Today commitment is a personal per-day plan entry. None changes another implicitly | I18N-13 gives display rules for both date-only and instant outcomes. J-03 rules are unchanged | IA §6, I18N-13, J-03, DS-50 |
| <a id="dep-0a-09"></a>DEP-0A-09 | Saved-view ownership: personal vs shared views, pinned views, default views | Personal views auto-save state; shared views need explicit save; pins require a shared view | RS-20 "Modified" rule stays; pin rules follow 0A | IA-09, RS-20 |
| <a id="dep-0a-10"></a>DEP-0A-10 | Document states: draft, current, stale, archived, approved AI source | Five badges, with approved-source as an attribute alongside state rather than a state | Badge set adjusts; no layout change | IA §4 Knowledge |
| <a id="dep-0a-11"></a>DEP-0A-11 | Agent-run and deliverable state sets | ST-60 vocabulary (Queued … Accepted) and deliverable Draft → Ready for review → Changes requested/Accepted/Rejected | ST-60 labels map onto 0A's states; the success-styling rule is unchanged | ST-60, J-05, J-09 |
| <a id="dep-0a-12"></a>DEP-0A-12 | Test case/result, defect, environment and release definitions and scope (project-scoped vs brand-scoped releases; whether a defect is a task type) | Defects are a task type. Releases belong to one brand and may span projects of that brand | IA §5 Tests/Releases placement ([UXD-14](#uxd-14)) changes if releases are brand-level | IA §5, J-10 |
| <a id="dep-0a-13"></a>DEP-0A-13 | The canonical glossary as the localization term base, including "brand" (vs "business") and the label "All brands" | "Brand" and "All brands" | Strings change through the term base only ([I18N-35](08-i18n-and-time.md#i18n-35)) | I18N-35 |
| <a id="dep-0a-14"></a>DEP-0A-14 | Actor and source types. 0A's brief names human, AI, automation, integration and agent; this set also uses "System" for platform actions (retention purge, plan enforcement) | Six actor types ([DS-44](05-design-system.md#ds-44)) | If "System" is not an actor type, those events are attributed per 0A and DS-44 drops the row | DS-44 |

### 2.1 Reconciliation with the 0A proposal

0A delivered its proposal in [`docs/product/`](../product/README.md) while this set was being written. That proposal is also awaiting review. This set has been aligned with it where the two differed. The table records each dependency's status, so the reviewer can confirm the two contracts agree.

| Dependency | 0A proposal | Status in this set |
|---|---|---|
| DEP-0A-01 | Task: exactly one brand, project optional. Inbox items personal, brand optional (OD-03). Workspace-scoped records carry a "Workspace" marker (OD-06) | **Aligned.** Whether a workspace may have zero brands is not addressed by 0A; [UXD-16](#uxd-16) still assumes a first brand is created |
| DEP-0A-02 | Sharing is explicit, revocable, never exposes parents, children or links; a shared record keeps its owner's marker (OD-04) | **Aligned** (IA-26) |
| DEP-0A-03 | Guest sees only records explicitly shared with it; distinct from public visitors and read-only members | **Aligned** (IA-05, UXD-05) |
| DEP-0A-04 | Five status categories: `planned`, `active`, `paused`, `done`, `cancelled`. Blocked is a derived condition. Review is a separate axis. Decisions immutable | **Aligned after edit:** DS-46 changed from six categories to 0A's five, with Blocked and review state as overlay conditions |
| DEP-0A-05 | Inbox item = raw captured input awaiting triage; Note is a separate record | **Aligned** |
| DEP-0A-06 | Archive, trash (soft delete in deletion batches), restore, purge, tombstone; durations are open decisions (OD-34) | **Aligned after edit:** "recovery bin/window" renamed "trash/recovery period"; ST-46 restore follows deletion batches |
| DEP-0A-07 | "Follower" is canonical; "watcher" is a synonym | **Aligned** (Follow) |
| DEP-0A-08 | Due and start dates are floating calendar dates. Deadline is a date or an instant, changed only explicitly. Overdue uses the viewer's day on personal surfaces and the brand timezone on brand surfaces. "Past deadline" is more severe than overdue | **Aligned after edit:** I18N-13 and the worked example now use 0A's evaluation rule (this set had recommended brand time everywhere); past-deadline display added |
| DEP-0A-09 | Saved view = stored query plus presentation; personal or shared | **Aligned** |
| DEP-0A-10 | Document states draft, current, stale, archived; approved AI source is separate | **Aligned** |
| DEP-0A-11 | Shared execution vocabulary (queued, running, waiting, paused, succeeded, partial, failed, cancelled, skipped); agent-run display combines execution and review axes; deliverable draft → ready for review → changes requested / accepted / rejected, per version | **Aligned after edit:** ST-60 gains Skipped, maps to the 0A states, and shows agent-run partial as "Failed · partial results kept"; "Paused at limit" removed in favour of "Stopped at limit" (failed subtype) |
| DEP-0A-12 | Defect is a task type; release is brand-scoped; six test-result states; defect workflow includes "Fixed – awaiting verification" | **Aligned after edit:** J-10 uses 0A's status names and the six result counts; UXD-14 notes brand-scoped releases |
| DEP-0A-13 | "Brand", "All-brands view", "Brand marker", "Restricted item" are glossary terms | **Aligned after edit:** IA-46 and UXD-09 use "Restricted item" |
| DEP-0A-14 | Human, AI, automation, integration, agent and **system** actor types | **Aligned** (DS-44) |
| — | OD-05: behavior for an unreadable relationship endpoint | **Aligned after architecture review:** omit the relationship, count, type, and derived condition caused solely by it; notify the responsible owner. See [UXD-28](#uxd-28) |

## 3. UX decision register

### Summary

| ID | Decision | Recommended default | Resolve by | Approval |
|---|---|---|---|---|
| [UXD-01](#uxd-01) | Collaborative editing at launch | Optimistic concurrency + version history first; realtime later | 4C (before 4D) | PO |
| [UXD-02](#uxd-02) | Mobile-web support boundaries | Tier V list in RS §8 | 1E | PO |
| [UXD-03](#uxd-03) | History granularity for view changes | Replace on filter/sort; push on view switch | 1E | SA |
| [UXD-04](#uxd-04) | Single-key shortcuts default | On for fine-pointer users; easy off | 1E | SA |
| [UXD-05](#uxd-05) | Public (unauthenticated) views | Off by default; read-only, expiring, admin-enabled | 2A (project views), 4C | PO |
| [UXD-06](#uxd-06) | Brand identity shown to guests | Show owning brand name and icon | 1D | PO |
| [UXD-07](#uxd-07) | Brand names in page titles | Excluded | 1E | SA |
| [UXD-08](#uxd-08) | Brand selection when creating in multi-brand scope | Required; last-used as suggestion only | 2A | SA |
| [UXD-09](#uxd-09) | Inaccessible mentions in text | Neutral "Restricted item" token (aligned with 0A) | 4A | 0C + SA |
| [UXD-10](#uxd-10) | External notification content for sensitive brands | Per-brand minimal-content option | 4B | PO |
| [UXD-11](#uxd-11) | Agent run scope and reviewer eligibility | Run scope = agent scope ∩ assigner access; reviewer must have access to run scope | 8B | 0C + PO |
| [UXD-12](#uxd-12) | Default detail-opening mode | Side panel; per-user option for full page | 3B | SA |
| [UXD-13](#uxd-13) | "Request access" from not-available pages | Not offered | 1D | 0C + PO |
| [UXD-14](#uxd-14) | Where tests and releases live in IA | Conditional project sections + brand-level release list in Reports | 9B | SA (after 0A) |
| [UXD-15](#uxd-15) | Atomicity of applying AI proposals | Atomic per apply, declared before apply | 7D | SA |
| [UXD-16](#uxd-16) | First brand in onboarding | Required step, pre-filled from workspace name | 1C | PO |
| [UXD-17](#uxd-17) | Realtime presence | Documents only, when realtime ships; never across guest boundaries | 4D | PO |
| [UXD-18](#uxd-18) | Notification channels at launch | In-app (canonical), email, browser; no SMS/chat apps; no reply-by-email | 4B | PO |
| [UXD-19](#uxd-19) | Day-start offset for Today | Supported, default 00:00 | 3C | SA |
| [UXD-20](#uxd-20) | Navigation customization | Hide only; no reorder; fixed Compact bar | 1E | SA |
| [UXD-21](#uxd-21) | Supported browsers and versions | Evergreen Chromium, Firefox, Safari; iOS Safari; Android Chrome | 1A | PO |
| [UXD-22](#uxd-22) | Accessibility of user-generated media | Product provides alt text and caption-track support; authors responsible for content | 4E | PO |
| [UXD-23](#uxd-23) | Localization scope at launch | English UI, all locale formats, English NL parsing, RTL-ready not RTL-shipped | 1E | PO |
| [UXD-24](#uxd-24) | Back-filling requirement IDs | Mechanical replacement after 0A acceptance | Phase 0 exit | SA |
| [UXD-25](#uxd-25) | Offline write queue scope | Capture, comments, single-field edits only | 2D | SA |
| [UXD-26](#uxd-26) | Complex-table behavior | Grid on Medium+, card list on Compact; cell editing on Medium+ | 3B | SA |
| [UXD-27](#uxd-27) | Live-update mechanism for lists and records | Server push of change notices; "updates" chip, no auto-reflow | 1E / 3A | SA |
| [UXD-28](#uxd-28) | Relationships to records the viewer cannot read | **Decided:** omit relationship metadata and derived conditions caused solely by hidden records; notify owner | **Resolved in Phase 0 review** | **Approved** |
| [UXD-29](#uxd-29) | Search scope, results, and an honest index | Shell scope by default with "Search all my brands"; state in the address; marks as text; a banner whenever the index lags or has failed; nothing remembered while typing | 5A | SA |
| [UXD-30](#uxd-30) | A figure with its rule, its state, and its records | One figure at a time; state in words; what is missing, how fresh, and how it is counted always shown; the records behind it one step away; unavailable is never zero | 5C | SA |
| [UXD-31](#uxd-31) | Assisted capture and daily plans | Help is optional and explicit: estimate and confirm before interpreting, evidence beside every value, recording only on a gesture with visible state, a plan reviewed and applied as a proposal; every unavailable state says so and typing keeps working | 7F | SA |

### Detail

<a id="uxd-01"></a>
#### UXD-01 — Collaborative editing at launch

- **Question.** Must documents (and long descriptions) support simultaneous live editing at first launch? (*BUILD_ROADMAP › Proposed approval decisions*)
- **Default.** Launch with **optimistic concurrency and version history**: per-section conflict view ([ST-06](06-interaction-states.md#st-06)), every save a restorable version, and a "Someone else is editing" notice when another save lands while the user has unsaved edits. Add realtime co-editing (4D) using a proven engine.
- **Consequence.** Simpler and cheaper at launch. Concurrent editors meet conflict views, which is acceptable for a founder-plus-small-team audience. Comments and suggestions work regardless.
- **If realtime is required at launch.** The 4D scope grows. Presence ([UXD-17](#uxd-17)), cursor accessibility ([A11Y-PA-09](07-accessibility.md#a11y-pa-09)) and offline merging become launch work.
- **Affected.** J-05 (document deliverables), Knowledge, ST-06.

<a id="uxd-02"></a>
#### UXD-02 — Mobile-web support boundaries

- **Question.** Which capabilities may be view-and-act only on Compact width?
- **Default.** Exactly the six tier-V items in [RS §8](04-responsive-shell.md#8-feature-parity-tiers). All launch-critical flows are tier F or A.
- **Consequence.** Administrators configuring automations, workflows, custom roles, imports, dashboard layouts or agent profiles need a tablet or larger screen. Safety actions remain on phones.
- **Evidence to revisit.** Support requests or analytics showing frequent Compact attempts at tier-V editors.
- **Affected.** J-11 (configuration), J-12 (export is F), Administration.

<a id="uxd-03"></a>
#### UXD-03 — History granularity

- **Default.** Filter, sort, grouping and column changes *replace* the history entry. Switching saved views, scope and destinations *push* ([RS-21](04-responsive-shell.md#rs-21)).
- **Consequence.** Back leaves the view rather than undoing a filter tweak. Users undo filters with the visible chips. Alternative: push each filter change, which tends to trap users in long Back sequences.
- **Affected.** J-04.

<a id="uxd-04"></a>
#### UXD-04 — Single-key shortcuts default

- **Default.** On for new users on fine-pointer devices. Off on coarse-pointer-only devices. Always disable-able, and never active in editable fields ([A11Y-KB-07](07-accessibility.md#a11y-kb-07)).
- **Consequence.** Fast for power users (U1). Risk of accidental activation for speech-input users, mitigated by the setting and by offering it in onboarding.
- **Affected.** J-02 (capture via <kbd>C</kbd>), J-04.

<a id="uxd-05"></a>
#### UXD-05 — Public and guest views

- **Question.** *FEATURES* includes "public or guest project views with controlled access". Should unauthenticated public links exist at launch, and with what limits?
- **Default.** Authenticated guest access is the standard path ([J-06](03-journeys.md#j-06-invite-a-guest-to-explicitly-scoped-content)). **Public links** are off by workspace default and can be enabled by an administrator per brand. When enabled they are read-only, have an expiry date (default 30 days, adjustable) and can be revoked. They show the owning brand, hide people's names except the project owner, and show no comments or activity. Creating one is Tier 2 with a consequence preview.
- **Consequence.** Minimizes accidental exposure. Customers wanting public roadmaps or status pages must enable it explicitly.
- **Affected.** J-06, IA-44, ST-30.

<a id="uxd-06"></a>
#### UXD-06 — Brand identity shown to guests

- **Default.** Guests see the owning brand's name and icon on shared records ([IA-05](02-information-architecture.md#ia-05)), because collaboration happens in that brand's context and hiding it causes confusion. Guests never see other brands.
- **Alternative.** Allow sensitive brands to show a guest-facing alias. This adds complexity and can confuse audit trails. Revisit only on customer demand.
- **Affected.** J-06, J-07 (emails to guests).

<a id="uxd-07"></a>
#### UXD-07 — Brand names in page titles

- **Default.** Page titles exclude brand names (`{Record} · {Section} · {Product}`), because titles persist in browser history, tab lists and screenshots on shared machines.
- **Consequence.** Slightly less context in the tab strip. The brand stays visible on the page.
- **Affected.** IA-14, A11Y-SR-07.

<a id="uxd-08"></a>
#### UXD-08 — Brand selection when creating in multi-brand scope

- **Default.** Brand is required, and the last-used brand is a one-click suggestion, not pre-selected ([IA-21](02-information-architecture.md#ia-21)). Quick capture to Inbox is exempt.
- **Consequence.** One extra click when creating from aggregate views. This prevents the highest-impact multi-brand error: creating work in the wrong brand.
- **Affected.** J-01, J-02, J-08.

<a id="uxd-09"></a>
#### UXD-09 — Mentions of inaccessible records in text

- **Default.** Render a neutral **"Restricted item"** token with no title, type, brand, status or icon ([IA-46](02-information-architecture.md#ia-46)). This is the wording 0A proposes in *hierarchy-and-scope §5*.
- **Consequence.** The reader learns that the author linked *something*, which is visible in the author's own words anyway, and learns nothing about it. The alternative, removing the token, garbles sentences. 0C must confirm this is acceptable for its threat model. This case differs from [UXD-28](#uxd-28): here the disclosure is the author's own text, not system-generated relationship metadata.
- **Affected.** J-06, comments, documents.

<a id="uxd-10"></a>
#### UXD-10 — External notification content for sensitive brands

- **Default.** Each brand has a setting: **Standard** (title and snippet in email and browser notifications) or **Minimal** ("You have a new mention in Optestra · Open", with no record title or snippet). Default is Standard. Brands marked sensitive default to Minimal.
- **Consequence.** In-app notifications re-check access at display time ([IA-53](02-information-architecture.md#ia-50)), but sent email cannot be recalled. Minimal mode limits that exposure.
- **Affected.** J-07, DS-42.

<a id="uxd-11"></a>
#### UXD-11 — Agent run scope and reviewer eligibility

- **Default.** A run's effective scope is the **intersection** of the agent's configured scope and the assigning user's access. Eligible reviewers of a run's output must have access to the run's effective scope.
- **Consequence.** Agents can never be used to see more than the assigner can. Reviewers never see output referencing records they cannot access ([IA-48](02-information-architecture.md#ia-48)). Some organizations may want privileged "service" agents. That would be a later, explicitly audited exception owned by 0C and 8B.
- **Affected.** J-09.

<a id="uxd-12"></a>
#### UXD-12 — Default detail-opening mode

- **Default.** Side panel on Medium and larger, full page on Compact ([RS-32](04-responsive-shell.md#rs-32)). A per-user setting offers "Always open full page".
- **Affected.** J-04.

<a id="uxd-13"></a>
#### UXD-13 — "Request access" from not-available pages

- **Default.** Not offered. Offering it would require routing a request to an owner, which confirms the record exists ([ST-41](06-interaction-states.md#st-41)).
- **Alternative.** Offer it only to members of the same brand who lack project access, routed to brand admins, revealing only "a record in this brand". Needs 0C threat-model approval.
- **Affected.** J-04, J-06.

<a id="uxd-14"></a>
#### UXD-14 — Where tests and releases live

- **Default.** Within a project: conditional **Tests** and **Releases** sections (enabled by software templates or a project setting). At brand level: a **Releases** list and release dashboards under Reports. Defects are a task type in Tasks ([IA §5](02-information-architecture.md#5-project-level-sections)).
- **Depends on** [DEP-0A-12](#dep-0a-12). 0A proposes that releases are **brand-scoped** (glossary: Release, scope Brand) and that defects are a task type, which fits this default. The project **Releases** section is therefore a filtered view of the brand's releases that include the project's work, not a separate container.
- **Affected.** J-10.

<a id="uxd-15"></a>
#### UXD-15 — Atomicity of applying AI proposals

- **Default.** Applying a selected set of AI changes is **atomic** (all selected changes apply or none do), because partial application of an AI plan is hard to reason about. Each apply states this before confirming ([ST-80](06-interaction-states.md#st-80)). Very large proposals may be applied per record group, also declared up front.
- **Consequence.** One invalid change blocks the set, mitigated by pre-validation that removes invalid changes from selection ([ST-51](06-interaction-states.md#st-51)). Roadmap 7D mentions both "atomic application" and "partial-failure reporting". This default reads them as: atomic per apply, with partial reporting for operations declared non-atomic.
- **Affected.** J-08, J-03 A5.

<a id="uxd-16"></a>
#### UXD-16 — First brand in onboarding

- **Default.** Creating a first brand is a required onboarding step, pre-filled from the workspace name so it takes one click. Other setup steps are skippable.
- **Consequence.** It guarantees brand context for every brand-owned record from the start. Depends on [DEP-0A-01](#dep-0a-01).
- **Affected.** J-01.

<a id="uxd-17"></a>
#### UXD-17 — Realtime presence

- **Default.** Show presence (who is viewing or editing) only in documents, and only once realtime editing ships. Presence never shows people a viewer could not otherwise see ([IA-47](02-information-architecture.md#ia-47)). Screen readers get presence on demand ("Who's here"), not continuous announcements.
- **Consequence.** No presence on tasks or boards at launch, which avoids realtime infrastructure for low-value signals (roadmap reference architecture favours one-way server push).
- **Affected.** Knowledge, J-05.

<a id="uxd-18"></a>
#### UXD-18 — Notification channels at launch

- **Default.** **In-app** (canonical, complete history), **email** (immediate for mentions, assignments, review requests and failures; digests), and **browser** (opt-in, after a user gesture, never on first visit). No SMS, chat-app or native push at launch. No reply-by-email at launch.
- **Expectations to set in Settings.** Email may be delayed by minutes. Browser notifications depend on browser permission and device state. Quiet hours hold non-security notifications.
- **Affected.** J-07, J-11, J-12.

<a id="uxd-19"></a>
#### UXD-19 — Day-start offset for Today

- **Default.** Users can set the hour their "day" starts (default 00:00) so late-night work stays on the same day ([I18N-16](08-i18n-and-time.md#i18n-16)).
- **Affected.** J-03.

<a id="uxd-20"></a>
#### UXD-20 — Navigation customization

- **Default.** Users can hide primary destinations they never use. Order is fixed. The Compact bottom bar is fixed at five slots ([RS-05](04-responsive-shell.md#rs-05)).
- **Consequence.** Consistency for help, documentation and team support. Some users would prefer Projects in the bottom bar; revisit with usage data.

<a id="uxd-21"></a>
#### UXD-21 — Supported browsers and versions

- **Default.** Latest two major versions of Chrome, Edge, Firefox and Safari (macOS), Safari on the latest two iOS versions, and Chrome on Android. Older browsers get a supported-browser notice, not a broken experience.
- **Affected.** RS-65; 12C environment matrix.

<a id="uxd-22"></a>
#### UXD-22 — Accessibility of user-generated media

- **Default.** The product provides alt-text prompts for images in documents, caption-track upload and display for videos, transcripts for voice capture, and accessible players and previews. Authors are responsible for the content of their media.
- **Affected.** [A11Y-SR-09](07-accessibility.md#a11y-sr-09), J-10 (test recordings as evidence).

<a id="uxd-23"></a>
#### UXD-23 — Localization scope at launch

- **Default.** English UI strings. All locale formats (dates, numbers, currency, week start, timezones). English natural-language date parsing. RTL-ready layouts ([I18N-31](08-i18n-and-time.md#i18n-31)) without shipping RTL translations.
- **Consequence.** International users get correct formats from day one, and translation becomes a content project rather than a re-architecture.

<a id="uxd-24"></a>
#### UXD-24 — Back-filling requirement IDs

- **Default.** After 0A's catalog is accepted, replace "*FEATURES › Section*" citations in this set with requirement IDs, and add an ID column to the destination coverage matrix ([IA §9](02-information-architecture.md#9-destination-coverage-matrix)). No rules change.

<a id="uxd-25"></a>
#### UXD-25 — Offline write queue scope

- **Default.** Queue offline: quick capture, comments, and single-field edits on records the user could already edit. Everything consequential requires a connection ([ST-05](06-interaction-states.md#st-05)).
- **Consequence.** Capture and quick updates (launch requirement: "capture, schedule, update and complete work from desktop and mobile web") survive flaky mobile connections, and risky actions never run late and unexpectedly. Requires a local store and conflict handling (2D).

<a id="uxd-26"></a>
#### UXD-26 — Complex-table behavior

- **Default.** A full grid with frozen first column and cell editing on Medium and larger. A card list with chosen fields on Compact, with an optional horizontally scrolling grid toggle. Cell editing on Compact happens through the record ([RS-53](04-responsive-shell.md#rs-53)). Column resize and reorder are always available by menu ([A11Y-PA-05](07-accessibility.md#a11y-pa-05)). Very wide tables (more than 12 visible columns) prompt the user to save a narrower view for Compact.
- **Consequence.** Tables stay usable on phones without pretending a 20-column grid fits. Spreadsheet-style editing is a larger-screen activity.

<a id="uxd-27"></a>
#### UXD-27 — Live-update mechanism

- **Default.** Clients receive change notices by one-way server push (per the roadmap's reference architecture), with polling as fallback. UI behavior is always [ST-07](06-interaction-states.md#st-07): banners and "updates" chips, never auto-reflow under the pointer.
- **Consequence.** No bidirectional realtime infrastructure until 4D needs it.

<a id="uxd-28"></a>
#### UXD-28 — Relationships to records the viewer cannot read

- **Decision.** Omit relationships whose other end the viewer cannot read ([IA-42](02-information-architecture.md#ia-42)). Do not reveal the relationship, its type, its count, or a derived condition caused solely by it. A manual blocked flag with a permission-safe reason remains visible.
- **Reason.** A placeholder, count, or derived blocker would disclose system-generated metadata about an unauthorized record and would create inconsistent leakage across views, search, notifications, AI, exports, and APIs.
- **Operational mitigation.** Notify the responsible owner when a hidden dependency affects assigned work. The owner can supply a manual, permission-safe status or reason without naming the restricted record. Authorized viewers continue to see the full relationship.
- **Status.** Approved during the Phase 0A/0E architecture review. The product hierarchy contract and IA-42 were reconciled at the same time; Phase 0C must preserve the rule in the authorization threat model.
- **Affected.** J-04, J-06, boards, timelines, the Blocked condition everywhere.

<a id="uxd-29"></a>
#### UXD-29 — Search scope, results, and an honest index

- **Default.** Search opens at `/workspaces/{ws}/search` (and with `/` when single-key shortcuts are on, and from the command palette). It searches the brands in the shell's current scope, says so, and offers **Search all my brands** ([IA-10](02-information-architecture.md#ia-10)). The whole search (words, filters, position) is in the address, so a link is a search and Back restores it. Results show type, brand, title and excerpt with matches marked as text (also bold, and the system mark colours in forced colours), the project, the person it belongs to (members only), the last update, and the record that holds it. Counts and facets are of what the person can open ([IA-41](02-information-architecture.md#ia-41)); nothing about a hidden record is hinted ([IA-40](02-information-architecture.md#ia-40)). Only a submitted search is remembered (never typing or the palette's live lookups), and recent searches are personal, listed before anything is typed, and can be forgotten one by one or all at once.
- **Honest index.** When recent changes are not searchable yet, or some records failed to index, the page says so, with how many (of what the person can read) and how long the oldest has waited, and marks the affected results "Updating" or "May be out of date"; it never presents an incomplete index as complete. Administrators see persistent failures on Home.
- **Consequence.** A person never has to wonder whether a missing result is hidden, deleted, or merely not indexed yet; the first two look identical by design, the third is stated.
- **Not built.** Scrolling to and highlighting the match inside the destination (no destination can address one comment or passage yet), an owner filter for other people (needs a people picker), concept search (OD-31), and attachment text.
- **Affected.** J-07, Search, the command palette, Home.

<a id="uxd-30"></a>
#### UXD-30 — A figure with its rule, its state, and its records

- **Default.** Metrics opens at `/workspaces/{ws}/metrics` with one figure at a time: the metric, its version when there is more than one, a brand, and (for a windowed metric) the local dates it covers. The whole state, including which records are listed, is in the address, so a link is a figure and Back restores it. The headline is the number the definition calls the figure (a percentage, or "2 of 5"), under a state said **in words** (Complete; Partial: some data is missing; Estimated; Nothing to measure yet; Not available yet), never by colour alone.
- **The rule is always one step away.** "How this is counted" opens what is counted and out of what, how it is rolled up, the zone, what it is computed from, who sees it, and what it does **not** claim (a figure of work finished is not value delivered). What is missing is a list above the figure ("3: some counted tasks have no estimate"), not a footnote. A figure that cannot be measured says "Nothing to measure yet", never 0% or 100%; a source that does not exist yet says which phase provides it and shows no number.
- **Freshness.** When derived data is behind or failing the page says so with the reconciliation state and when it was last checked, and offers administrators "Check status history now"; when some tasks' history was rebuilt rather than recorded it says how many. A lagging source is never presented as current.
- **Records.** Each figure lists the groups of records it is made of with their counts ("Done tasks (2)"); choosing one lists them (paged, "Show more") as links to the task or project. A person never sees a count they cannot open, and a list never has a different length from its count.
- **Layout.** Breakdowns are tables that become stacked cards at 320 px with each cell labelled; controls are labelled and 44 px tall; borders and state text survive forced colours; nothing animates, so reduced motion changes nothing.
- **Consequence.** A person never has to wonder whether a number is complete, how it was made, or whether work they cannot see is inside it: the first two are stated, the third is true by construction and tested.
- **Not built.** Dashboard layout, widgets, saved and scheduled reports (5D); charts; comparing two scopes side by side; a per-person performance view.
- **Affected.** Metrics, Projects (the portfolio keeps 5B's figures), Home.

<a id="uxd-31"></a>
#### UXD-31 — Assisted capture and daily plans

- **Default.** Help is optional, labelled, and explicit. In the Capture dialog, "Interpret with AI" shows the estimate (and that a synthetic model spends nothing) and asks for confirmation; the result marks the person's own words it used, shows each value the server derived (dates as a weekday, date, and zone), and keeps ambiguous values as choices. Saving with the interpretation is a checkbox, released the moment the text changes. "Speak instead" records only after the person presses Record, shows elapsed time against the limit with Stop and Cancel, or accepts an uploaded file; the transcript is shown for editing (with a synthetic label and a low-confidence warning when relevant) and becomes the capture text only when the person chooses.
- **States.** Unconfigured, AI off, storage unavailable, microphone denied, unsupported browser, offline, empty transcript, too long, and failed are each named, with typing and pasting always available. Busy states are announced and cancellable.
- **Plans.** "Plan this day" on Today opens a plan with totals, what is planned and why, what is not and why, postponement suggestions (unselected), locked work, and missing estimates as questions with optional assumptions. "Create plan proposal" opens the proposal page, where block times are edited in the browser's zone, conflicts are shown on the block, and a changed day is rebased explicitly before approval.
- **Layout.** Controls are labelled and 44 px tall; marks and state text survive forced colours; nothing animates; 320 px and 200% zoom do not scroll sideways.
- **Consequence.** Nothing is saved, scheduled, or applied without a deliberate step, and the person can always see where a value came from.
- **Not built.** Live speech providers; agents planning on a person's behalf (8A); multi-day planning.
- **Affected.** Capture dialog, Today, Plan my day, Change proposals.

## 4. UX risk register

| ID | Risk | Likelihood / impact | Mitigation in this set | Early-warning evidence | Owner phase |
|---|---|---|---|---|---|
| <a id="uxr-01"></a>UXR-01 | Users mistake aggregated views for one brand and act in the wrong brand (create, send, publish) | Medium / High | Brand markers everywhere ([IA-20](02-information-architecture.md#ia-20)); explicit brand on create ([IA-21](02-information-architecture.md#ia-21)); scope follows records ([IA-25](02-information-architecture.md#ia-25)); brand named in Tier 2 confirmations ([ST-33](06-interaction-states.md#st-33)) | Records moved between brands soon after creation; support tickets | 1C, 1E, 2A |
| <a id="uxr-02"></a>UXR-02 | Side-channel leakage of unauthorized information (counts, autocomplete, URLs, titles, emails, timing, error differences) | Medium / High | [IA §10](02-information-architecture.md#10-permission-safe-display-rules); identical not-available state ([ST-41](06-interaction-states.md#st-41)); opaque URLs; minimal-content email ([UXD-10](#uxd-10)). Timing equivalence is an engineering control (0C/0D) | Authorization test failures; security review findings | 0C, 1D, 5A, 11B |
| <a id="uxr-03"></a>UXR-03 | Over-trust in AI and agents (automation bias): users accept proposals or outputs without reading | High / High | No success styling for AI/agent completion ([ST-60](06-interaction-states.md#st-60)); citations and kind labels ([ST-56](06-interaction-states.md#st-56)); scope deviations first ([ST-52](06-interaction-states.md#st-52)); automated checks labelled as evidence, not decisions | Very short review durations; high post-acceptance revert rates | 7D, 8D, 12D |
| <a id="uxr-04"></a>UXR-04 | Review fatigue: too many approvals lead to rubber-stamping or bottlenecks | Medium / Medium | One Reviews queue ([IA-06](02-information-architecture.md#ia-06)); low-impact actions allowed by explicit policy (*FEATURES › Agents*); per-change selection | Reviews-queue age; bulk accepts | 8D, 10C |
| <a id="uxr-05"></a>UXR-05 | Notification fatigue leads users to mute everything and miss failures | High / Medium | Grouping, digests, mutes; failure notifications are never grouped away ([IA-55](02-information-architecture.md#ia-50)); tray shows failures until acknowledged ([IA-12](02-information-architecture.md#ia-12)) | Mute rates; unread failure notifications | 4B |
| <a id="uxr-06"></a>UXR-06 | Mobile users blocked by tier-V editors or dense views | Medium / Medium | Parity tiers with safety actions and "Continue on a larger screen" ([RS §8](04-responsive-shell.md#8-feature-parity-tiers)); adapted views ([RS §7](04-responsive-shell.md#7-complex-view-adaptations)) | Compact attempts on tier-V screens | 1E, 3B |
| <a id="uxr-07"></a>UXR-07 | Keyboard shortcuts conflict with assistive technology or browsers | Medium / Medium | Layers, conflict list and disable setting ([A11Y-KB-07](07-accessibility.md#a11y-kb-07)); AT testing before key-map freeze | Accessibility test findings; shortcut-disable rate | 1E |
| <a id="uxr-08"></a>UXR-08 | Timezone and date-semantics errors cause missed deadlines across brands | Medium / High | I18N-10 to I18N-17; date-only vs instant distinction; worked example; dual display | Overdue disputes; support tickets about dates | 0A, 3C, 6C |
| <a id="uxr-09"></a>UXR-09 | Optimistic updates silently reverting, confusing users | Low / Medium | Visible revert with inline error and assertive announcement ([ST-10](06-interaction-states.md#st-10)) | Error-rate telemetry on optimistic writes | 2D |
| <a id="uxr-10"></a>UXR-10 | 0A terminology differs from provisional terms, causing UI string and doc rework | Medium / Low | Provisional terms flagged with DEP IDs; term-base approach ([I18N-35](08-i18n-and-time.md#i18n-35)) | 0A review outcome | Phase 0 exit |
| <a id="uxr-11"></a>UXR-11 | The functional token palette ships as the de facto visual identity and looks generic | Medium / Low | Explicitly a baseline; a later visual pass may change hues if contrast pairs pass ([DS-21](05-design-system.md#ds-21)) | Product-owner feedback | Post-1E |
| <a id="uxr-12"></a>UXR-12 | Founder dashboards become dense and alarming, reducing calm and trust | Medium / Medium | Calm by default ([P-12](01-principles-and-users.md#p-12)); banner limits ([ST-22](06-interaction-states.md#st-22)); progressive disclosure | 12D usability findings | 5D |
| <a id="uxr-13"></a>UXR-13 | Offline queued edits conflict on reconnection and confuse users | Low / Medium | Narrow queue scope ([UXD-25](#uxd-25)); explicit Pending sync and conflict views | Conflict rate after reconnection | 2D |
| <a id="uxr-14"></a>UXR-14 | Virtualized large lists break screen-reader navigation and find-in-page | Medium / Medium | Row-count semantics and in-list search ([DS-60](05-design-system.md#ds-60)) | Accessibility test findings | 3B, 11D |
| <a id="uxr-15"></a>UXR-15 | Cancellation or limit flows are perceived as manipulative | Low / High | No dark patterns; one skippable offer at most; prices visible before commitment (J-12) | Cancellation complaints; reviews | 10A |

## 5. Dependencies on 0B, 0C and 0D

| Owner | Needed for | UX constraint this set imposes |
|---|---|---|
| 0B | Opaque stable identifiers usable in URLs; soft deletion and recovery data; version history for documents and records; change notices for live updates | URLs contain no names ([IA-44](02-information-architecture.md#ia-44)); restore returns records to their location ([ST-46](06-interaction-states.md#st-46)) |
| 0C | Effective-permission evaluation for every list, count, search, snippet, notification, activity entry and AI citation; guest grants; agent scope intersection | Absent-not-hidden ([IA-40](02-information-architecture.md#ia-40)); counts of authorized items only ([IA-41](02-information-architecture.md#ia-41)); not-found and not-authorized indistinguishable ([ST-41](06-interaction-states.md#st-41)); consequence previews need a "who gains access" computation ([ST-30](06-interaction-states.md#st-30)) |
| 0D | Async job states, error format with field mapping, idempotency, retry bounds, notification event schema, usage metering for estimates | Execution states must map to [ST-60](06-interaction-states.md#st-60); errors must map to fields ([ST-76](06-interaction-states.md#st-76)); retries must be safe to offer ([ST-64](06-interaction-states.md#st-64)); cost estimates need pre-run metering ([ST-62](06-interaction-states.md#st-62)) |

## 6. Design work intentionally deferred

| Deferred | To | Why not now |
|---|---|---|
| High-fidelity screen designs for each feature | Each phase brief | Brief non-goal; this set defines behavior and constraints they must meet |
| Final visual identity, product name, illustration style, logo | Product owner / later visual pass | Brief non-goal |
| Final keyboard map | 1E | Needs assistive-technology testing ([A11Y-KB-07](07-accessibility.md#a11y-kb-07)) |
| Exact thresholds (save-indicator delay tuning, AI cost confirm threshold, freshness thresholds, bulk preview threshold) | 1E, 7A, 5C, 2D | Need measurement; defaults given here are starting points |
| Automation builder, workflow editor and permission-matrix interaction design | 8A, 2C, 1D/10C | Domain detail not yet defined; tier-V boundaries set in [RS §8](04-responsive-shell.md#8-feature-parity-tiers) |
| Dashboard widget catalogue and chart types | 5C/5D | Depends on the metrics model |
| Onboarding copy, templates and sample-data content | 10B | Depends on template families |
| Email template designs | 4B | Rules set in [DS-42](05-design-system.md#ds-42), [IA-53](02-information-architecture.md#ia-50) |
| Help-centre information architecture | 10D | Outside the product shell |
