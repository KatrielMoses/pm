# Record hierarchy and scope contract

Status: proposed (Phase 0A), awaiting architect review. Terms are defined in the [glossary](glossary.md). Lifecycle effects referenced here are specified in [lifecycle-and-states.md](lifecycle-and-states.md) and [deletion-retention-history.md](deletion-retention-history.md).

This document defines **what owns what, what merely links to what, and who can see it**. Physical tables, keys, and indexes are Phase 0B; permission roles and evaluation order are Phase 0C. The rules here are the semantics those phases must implement.

Normative words: **must** = contract; **should** = default unless a later approved decision says otherwise; **recommended** = proposal pending product-owner confirmation (each one links to an [open decision](open-decisions.md)).

## 1. Scope levels

Every tenant record has exactly one **owning scope**. The scope sets who can be granted access, which settings apply, and what happens to the record when its container changes lifecycle.

| Scope | Meaning | Carries |
|---|---|---|
| Platform | Data outside any tenant: sign-in identities, platform templates, public help content. | No workspace. Never returned by tenant queries except platform templates (read-only). |
| Workspace | The tenant boundary. Nothing crosses it except a person's identity being a member of several workspaces. | `workspace` |
| Brand | A business or product line inside one workspace. | `workspace` + exactly one `brand` |
| Project | Work inside one brand. | `workspace` + `brand` + `project` |
| Task | Work item inside one brand, optionally inside one project. | `workspace` + `brand` + optional `project` |
| Personal | Data that belongs to one person inside one workspace (their Inbox, Today, preferences). | `workspace` + `owner person`; may reference brand-scoped records but does not grant access to them |

**Brand context is never implied.** A brand-scoped record stores its brand explicitly. It is not derived at read time from a parent that might later move.

## 2. Scope of every major record

"Brand: exactly one" means the record cannot exist without a brand and cannot belong to two. "Workspace-or-brand" means the creator chooses one owning scope. The record then belongs to that brand, or to the workspace with no brand.

| Record | Owning scope | Brand | May exist without a project? | Contained by (parent) | Notes |
|---|---|---|---|---|---|
| Account (sign-in identity) | Platform | — | — | — | One per person. Membership links it to workspaces. |
| Workspace | Workspace | — | — | — | Tenant root; owns the subscription. |
| Member / guest (membership) | Workspace | — | — | Workspace | Grants are attached at workspace, brand, project, record level ([§6](#6-access-and-authorization-concepts)). |
| Team | Workspace | — | — | Workspace | A set of people; can span brands. Teams receive grants; a team is not a scope. |
| Brand | Brand | itself | — | Workspace | Owns its settings: working calendar, AI instructions, notification rules, goals. |
| Project (incl. child project) | Brand | exactly one | — | Brand, or a parent project **in the same brand** | Parent/child projects never cross brands. |
| Phase, milestone | Project | inherits | No | Project | |
| Task | Brand | exactly one | **Yes** ([OD-02](open-decisions.md#od-02)) | Brand, or project, or parent task | Projectless tasks belong to the brand directly. |
| Subtask | Brand | same as parent task | Same project as parent | Parent task | Depth limited ([OD-08](open-decisions.md#od-08)); cycles prohibited. |
| Checklist item | Task | inherits | — | Task | Not a task: no assignee-level workflow, no dates beyond an optional due date. |
| Inbox item | Personal | **optional** ([OD-03](open-decisions.md#od-03)) | Yes | Owner's Inbox | Gets a brand when triaged. Becomes a task, note, project, or is discarded. |
| Note | Brand **or** Personal | optional until filed | Yes | Brand/project/task when filed | A lightweight document; promotable to task, project, or document. |
| Today commitment | Personal | references the item's brand | — | Owner's day plan | Never changes the referenced item's dates. |
| Document / page | Workspace-or-brand, optionally attached to project or task | at most one | Yes | Workspace, brand, project, task, or parent page in the **same scope** | Child pages inherit the parent page's scope. |
| File (stored) / attachment | Inherits from host record | host's brand (or none for workspace-level host) | Yes | Exactly one host: workspace, brand, project, task, document, or comment | "Attachment" = a file or external link attached to a host. |
| Deliverable | Task | inherits | Task may be projectless | Task | A file, URL, or artifact designated as a task output, with versions and review state. |
| Comment | Inherits from host | host's | — | Exactly one host record | Thread replies are contained by the root comment. |
| Activity entry / audit event | Workspace; tagged with brand of the affected record at event time | as tagged | — | Not contained: references records | Append-only; survives record purge as a tombstone reference. |
| Notification | Personal (recipient) | tagged with source brand | — | Recipient | Content re-checked against recipient's access at delivery and at display. |
| Goal, key result | Workspace, brand, **or** project | per scope | Yes | Workspace / brand / project; key result contained by goal | Links to projects/tasks are associations. |
| Portfolio | Workspace or brand (a saved, permission-filtered collection of projects) | per scope | — | — | A view-like grouping; not an owner of projects. |
| Custom field definition, field set, workflow, status | Workspace, brand, or project | per scope | — | Scope | Narrower scopes may override broader defaults ([§7](#7-configuration-inheritance)). |
| Saved view, dashboard, report configuration | Personal, or shared to a workspace/brand/project | per scope | — | Owner or scope | A query. **Never grants access** to the records it returns. |
| Template | Platform, workspace, or brand | per scope | — | Scope | Installing creates normal records in the target scope. |
| Integration connection | Workspace or brand | per scope | — | Scope | A workspace-level connection maps external resources to brands (e.g., repository → brand/project). |
| Synchronized external record (issue, PR, calendar event) | Brand of its mapping; unmapped items stay in the connection's staging area | via mapping | Yes | Connection | Unmapped items are visible only to people who manage the connection. |
| Webhook subscription, API token | Personal token (acts as the user) or workspace service token | token's declared brand list | — | Owner/workspace | A token can never exceed its creator's or the workspace policy's permissions. |
| Automation | Brand or workspace | per scope | — | Scope | Workspace automations must declare the brands they may act in. |
| Agent profile | Workspace | **explicit allowed-brand list** (not ownership) | — | Workspace | Brand scope is a permission boundary for the agent, not the profile's owner. |
| Agent run, tool call, artifact | Brand of the task the run executes | exactly one | Follows task | Task (run); run (tool calls, artifacts) | |
| AI action (assistant request) and AI history entry | The scope the user selected (brand, project, task, or workspace-wide) | brand if brand-scoped; multi-brand actions record every brand in context | — | Initiating person + scope | |
| Briefing | Personal (recipient) | owner briefing = multi-brand; brand briefing = one | — | Recipient | Every statement carries its source record's brand. |
| Time entry | Brand of the task or project it is logged against | exactly one | Logged against a task or project | Person + task/project | |
| Timesheet | Personal (person + period), spanning brands | — | — | Person | Approval is per entry/brand line by people authorized for that brand. |
| Working hours, time off | Personal (person, in workspace) | — | — | Person | |
| Brand capacity reservation | Brand × person | exactly one | — | Brand | |
| Test case, suite | Brand | exactly one | Yes | Brand or project | |
| Test run / test result | Brand | exactly one | Yes | Suite or case; results contained by run | |
| Defect | A task with defect type | exactly one | Yes | As task | Retains original failure evidence. |
| Environment | Brand | exactly one | Yes | Brand | dev / staging / production per brand or product. |
| Release, release checklist, go/no-go decision | Brand | exactly one | May link several projects **in the same brand** | Brand | Decisions are contained by the release and immutable. |

## 3. Containment versus association

**Containment** (ownership) answers "where does this live, and what happens to it when its container changes?" A record has **at most one container**. Containment **never crosses a brand boundary.**

**Association** (a link) answers "what is this related to?" A record may have many associations. Associations **do not move, archive, delete, or grant access** to either end.

| Containment (lifecycle cascades) | Association (no cascade, no access) |
|---|---|
| workspace ⊃ brand ⊃ project ⊃ child project | task ↔ goal / key result |
| project ⊃ phase, milestone, task | task ↔ task: depends-on/blocks, related |
| task ⊃ subtask, checklist item, deliverable | document ↔ any record (links, mentions, embeds of other records) |
| any record ⊃ its comments, uploaded attachments | test case ↔ requirement, task, release, environment |
| document ⊃ child pages, versions | pull request / commit ↔ task, defect |
| goal ⊃ key results | release ↔ tasks, defects, milestones (scope membership) |
| agent run ⊃ attempts, tool calls, artifacts | agent profile ↔ allowed brands/projects |
| test run ⊃ test results | a shared record ↔ the brand it is shared into |
| release ⊃ checklist, decisions | portfolio / saved view ↔ records it returns |

### 3.1 Lifecycle effects on children

| Parent action | Contained children | Associations |
|---|---|---|
| **Archive** | Become *archived by cascade* (read-only, hidden from active views). Each child records whether it was archived itself or through its parent. | Unchanged; the counterpart shows the link with an "archived" marker. |
| **Restore from archive** | Children archived **by this cascade** return to active. Children archived independently before the parent stay archived. | Unchanged. |
| **Soft delete (move to trash)** | Trashed together as one **deletion batch**. Children already in the trash stay in their own earlier batch. | Hidden from both ends while trashed; restored with the record. Automations and notifications do not fire for the hidden link. |
| **Restore from trash** | The whole batch is restored to its prior lifecycle state and location. A child can be restored alone only if its container is active. Otherwise the user must restore the container, or (tasks only) restore it as a projectless task in the same brand. | Re-attached where the counterpart still exists and is not purged. |
| **Purge** | Purged with the batch. | Replaced by a **tombstone** reference ("Deleted item"). Title and content are not retained. |
| **Move (change container)** | Moves the full containment subtree (subtasks, checklist, comments, attachments, deliverables, runs). | Kept. Cross-brand moves re-validate them ([§5.4](#54-moving-a-record-to-another-brand)). |
| **Complete / cancel** (workflow status) | **No automatic cascade.** Completing a parent with open children is allowed only after a confirmation that lists them. The user chooses to leave, complete, or cancel each one. | None. |

Archiving or completing a **goal** never archives or completes linked projects (association). Archiving a **brand** archives all its brand-scoped records by cascade, pauses its integrations and automations, and blocks new agent runs. Runs already executing must be cancelled or allowed to finish before the archive completes; the user chooses in the confirmation.

## 4. The all-brands view

The all-brands view is an **authorized aggregation, not a scope.**

- It shows the union of: records in every brand where the person holds at least read access; workspace-scoped records they can read; their personal records; and records explicitly shared with them.
- It **owns nothing.** Nothing can be created "in all brands". Creating from the all-brands view must either ask for a brand or place the item in the person's Inbox (personal, no brand yet).
- Permission evaluation is **per record**, never per view. A person with access to two of three brands sees two brands' records and no counts, totals, or placeholders that reveal the third, unless [OD-07](open-decisions.md#od-07) decides otherwise.
- Aggregates (owner dashboard, founder capacity, owner briefing) are computed **only from records the viewer may read**. A total that depends on hidden records must say it is partial: "Totals cover 2 of your 2 visible brands", never "3 brands".
- Brand filters (WSB-019) narrow the aggregation and are expressed as a list of brands. "All" means "all brands I'm authorized for at query time", re-evaluated on every load. It is not a stored list.

## 5. Cross-brand rules

### 5.1 Brand identity must always be visible

Wherever records from more than one brand can appear together, every record shows a **brand marker**: name or short name plus icon/color, never color alone. This applies to lists, boards, calendars, search results, notifications (in-app and email subject/body), briefings, AI answers and citations, agent runs, exports, and activity feeds. In single-brand contexts the marker may be reduced to the page header. It still appears for shared records that come from another brand.

### 5.2 Explicit sharing

A **share** is a separate, auditable grant record. It makes **one record** of brand A visible inside brand B's context or to named people/teams. It never changes ownership.

| Property | Rule |
|---|---|
| Who can share | People with *share* permission on the source record ([0C](../../BUILD_ROADMAP.md) defines the role mapping). |
| What is shared | The record's own fields, its comments, and its own attachments. **Not** its parents, siblings, linked records, or the source brand's activity feed. Its containment children are excluded **unless the sharer explicitly includes them** in the share, and the confirmation then lists them. |
| Access level | Read-only by default; comment or edit only if the sharer chooses it and holds that level themselves. Never *delete*, *share onward*, *move*, or *configure*. ([OD-04](open-decisions.md#od-04)) |
| Ownership | Stays with the source brand. Source-brand settings (workflow, fields, notification rules, AI instructions) keep applying. |
| Visibility of links inside a shared record | Mentions or links to records the recipient cannot read render as "Restricted item". The title, brand, and status are not shown. |
| Before sharing | The UI must show exactly what becomes visible and to whom (PERM-012). Sharing a record with attachments or comments lists them. |
| Revocation | Immediate. Takes effect on the next read, search, AI retrieval, notification delivery, and export. Cached copies (e.g., notification previews already rendered) must be re-checked before display. |
| Audit | Share created/changed/revoked events record sharer, recipient, level, and record. Shares are listed on the record and in an admin report. |
| Expiry | Optional expiry date on a share. Expired shares behave as revoked. |

The record does not become brand B's: it appears in B's views with A's brand marker and cannot be filed into B's projects. Work that brand B owns needs its own record in B, which **may link** to A's record (an association).

### 5.3 Relationships across brands

| Relationship | Allowed across brands? | Rule |
|---|---|---|
| Containment (project ⊃ task, task ⊃ subtask, page ⊃ child page, release ⊃ projects) | **No** | Validation rejects it. |
| Dependency / blocks, related task | **Yes** ([OD-05](open-decisions.md#od-05)) | Creator must be able to read both ends. Each end shows the other's brand marker to authorized viewers. For a viewer who cannot read the other end, omit the relationship, its count and type, and any derived condition caused solely by it. Notify the responsible owner, who may add a permission-safe manual reason. |
| Goal ↔ project/task link | Yes for workspace-scoped goals. Brand goals link only within their brand. | Workspace goals exist to span brands. |
| Document link or mention | Yes | Rendered per viewer access, as in [§5.2](#52-explicit-sharing). |
| Time entry on another brand's task | No | Time is logged in the brand that owns the work. |

### 5.4 Moving a record to another brand

Moving changes **ownership**. It is a distinct, explicit action and never a side effect of editing, sharing, or triaging.

- It requires *move* permission in the source brand and *create* permission in the target.
- It moves the containment subtree. Cross-brand links are re-validated: links the user could not create in the target are listed in the confirmation and kept as associations only if they remain valid.
- The target brand's workflow, fields, and rules apply after the move. Status and custom-field values that do not exist in the target must be mapped in the confirmation, not dropped silently.
- Shares, automations bound to the source brand, and agent assignments limited to the source brand are re-evaluated. Anything that would stop applying is listed before confirmation.
- The audit history records old and new brand. Activity from before the move stays tagged with the old brand.

### 5.5 Preventing accidental exposure

These are contract rules, and Phase 0C/1C must test them:

1. Every query, search, AI retrieval, export, integration push, webhook payload, agent context, notification, and briefing applies the **same per-record authorization**. There is no separate "AI permission" or "search permission" for reading content.
2. Pickers (assignee, project, mention, link) show only records and people the actor may reference in the **target record's brand**.
3. Automations, agents, integrations, and API tokens act with an **explicit principal and brand scope**. An automation in brand A cannot create or read records in brand B unless it is a workspace automation that declares B.
4. Notification and email content is limited to what the recipient can read **at delivery time**. If they lost access between event and delivery, the notification is dropped or rendered without content.
5. Counts, previews, autocompletion, error messages ("already exists"), and URL lookups must not reveal the existence or title of unreadable records.
6. Exports and AI context include only records the requesting principal can read. Any secrets are redacted (SEC-014).

### 5.6 Cross-brand examples

**Example A — aggregation.** Katriel owns the brands MailAccess, API Access, and Optestra. A contractor, Sam, is a member of Optestra only. Katriel's all-brands Today shows 9 items with three brand markers. Sam's all-brands Today shows only Optestra items. It shows no "+6 hidden" count, and the founder-capacity widget is not available to Sam.

**Example B — explicit share.** An Optestra spec document "Evidence ingestion format" is shared read-only into API Access so that brand's team can build an exporter. API Access members see the document with an Optestra marker. Its child page "Pricing assumptions" is not shared, so it does not appear in their search, and the parent's link to it renders as "Restricted item". Revoking the share removes the document from API Access search immediately. The next owner briefing for an API Access-only member no longer cites it.

**Example C — cross-brand dependency.** A MailAccess task "Use API Access rate-limit SDK" depends on an API Access task "Publish SDK v1". Katriel created the link and sees both ends. A MailAccess-only member sees neither the dependency nor a derived blocked condition caused solely by it. Katriel is notified and can add a permission-safe manual blocked reason for the MailAccess team. The restricted member cannot open, search for, or receive AI summaries of the API Access task.

**Example D — prevented exposure.** An AI request scoped to "MailAccess / all projects" asks "what is blocking launch?". Retrieval excludes the API Access task even though Katriel can read it, because the selected scope is MailAccess. The answer cites only the MailAccess task and states that the blocker lives in another brand outside the selected scope. If Katriel widens the scope, the context panel shows the added brand before the action runs (AI-006).

**Example E — move versus share.** A task created in Optestra actually belongs to API Access. Sharing would leave it owned by Optestra, which is wrong. Katriel uses **Move to brand**. The confirmation maps the "QA review" status (which API Access does not have) to "In review" and warns that one Optestra-only automation will stop applying. The audit log records the move.

## 6. Access and authorization concepts

0C owns the role matrix. 0A fixes these semantics:

- **Principal types**: person (member or guest), team (as a grant holder), API token, integration connection, automation, agent. AI actions run **as the initiating person**, limited further by the selected context scope.
- **Grants attach to a scope or record**: workspace, brand, project, document, view, field, integration, or an individual record (shares). Narrower grants can add access to specific records. They can only remove access where 0C defines explicit restriction for sensitive brands/projects (PERM-006) and field-level hiding.
- **Guests** see only records explicitly shared with them, including only child records individually selected at share time. Future children are never included automatically. They never see the all-brands aggregation beyond their grants, workspace member directories, or unshared brands.
- **Agents** hold their own grants, which can be narrower than (and never broader than) the assigning person's at assignment time. Tool permissions are separate from record permissions (PERM-008).
- **Ownership** of records (project owner, document owner, connection owner) is a responsibility field, not an access grant. When a member leaves, ownership is reassigned by an admin. Records never become ownerless silently (PERM-014).

## 7. Configuration inheritance

Statuses/workflows, custom fields, notification rules, AI instructions, working calendars, and default views resolve **most specific first**: project → brand → workspace → platform default. An override replaces the inherited value for that scope. It is not merged silently: a project workflow is either inherited or fully defined. Records always store the concrete status/field values they hold, so changing an inherited configuration never rewrites history. 0B defines the migration behavior when a status is removed.

## 8. Contracts handed to later phases

| Phase | Must implement from this document |
|---|---|
| 0B | Owning-scope columns per record type; containment versus association relationships; deletion batches; tombstones; cross-brand link validation; move semantics. |
| 0C | Per-record evaluation shared by every read path; share grants; guest rules; agent and token principals; restriction of sensitive brands; non-disclosure rules (§5.5). |
| 0D | Brand marker in every API/webhook/notification envelope; actor/principal type on every event. |
| 0E | Brand marker component; "Restricted item" rendering; move-versus-share confirmations. |
