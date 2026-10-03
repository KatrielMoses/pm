# Canonical glossary

Status: proposed (Phase 0A), awaiting architect review.

These are the canonical product terms for UI copy, API names, documentation, briefs, and tests. Where a FEATURES.md phrase uses a synonym, the canonical term is listed and the synonym is mapped. Scope rules are specified in [hierarchy-and-scope.md](hierarchy-and-scope.md), states in [lifecycle-and-states.md](lifecycle-and-states.md), time terms in [time-and-scheduling.md](time-and-scheduling.md), and removal terms in [deletion-retention-history.md](deletion-retention-history.md).

Column guide: **Means** is the definition. **Does not mean** lists common misreadings to avoid. **Scope / parent** gives the owning scope ([hierarchy §2](hierarchy-and-scope.md#2-scope-of-every-major-record)). **Do not confuse with** names neighboring terms.

## 1. People, tenancy, and context

| Term | Means | Does not mean | Scope / parent | Do not confuse with |
|---|---|---|---|---|
| **Account** | A person's sign-in identity: email, credentials, MFA, sessions. One per person across all workspaces. | The paying customer, or a workspace. (Billing uses *workspace subscription*.) | Platform | Member, workspace |
| **User** | Generic word for a person using the product. In contracts, use *account* (identity) or *member/guest* (membership). | A seat, or an agent | — | Member, principal |
| **Member** | An account's membership in a workspace with a role (owner, administrator, member, limited member, read-only). | Access to every brand. Brand and project access come from grants. | Workspace | Guest, team |
| **Guest** | A membership that can see **only records explicitly shared with it** (PERM-005). | A public visitor without sign-in, or a member with few grants | Workspace | Read-only member, public view |
| **Owner (workspace)** | The member with ultimate authority over the workspace: billing, deletion, ownership transfer. At least one is required. | The owner of a project or document (a responsibility field) | Workspace | Record owner |
| **Record owner** | The person responsible for a record (project owner, document owner, connection owner). | An access grant. Owners still need permission to read. | The record | Assignee, creator |
| **Team** | A named group of members and guests used for mentions, assignment, and grants. Teams can span brands. | A scope that owns records, or a brand | Workspace | Brand, role |
| **Role** | A named bundle of permissions attached to a member at a scope (0C defines the matrix). | A team | Workspace / brand / project / task | Grant, team |
| **Principal** | Anything that can be authorized and recorded as an actor: person, API token, integration connection, automation, agent. | — | — | Actor type |
| **Actor type** | The kind of actor recorded on every change: `human`, `ai` (on behalf of a person), `automation`, `integration`, `agent`, `system`. | A role | — | Principal |
| **Workspace** | The tenant: an isolated container for brands, members, settings, subscription, and all data. Nothing crosses it. | A brand, or a "team space" | Platform | Brand, account |
| **Brand** | A business, product line, or client inside a workspace, with its own identity, settings, calendar, and records (e.g., MailAccess, API Access, Optestra). | A label, tag, or folder; a separate tenant; a customer account | Workspace | Project, team, workspace |
| **All-brands view** | An **authorized aggregation** of every brand the viewer can access, plus workspace and personal records. | A scope that owns records, or "every brand in the workspace" regardless of access | None (computed per viewer) | Workspace-scoped record |
| **Brand marker** | The visible brand name/icon/color shown on any record in a multi-brand context. | Color alone | — | Label |
| **Context scope** | The explicit workspace / brand / project / task boundary chosen for an AI action, search, or view. | A permission. Scope narrows authorization and never widens it. | — | Grant |
| **Grant / share** | An explicit, auditable permission given to a principal on a scope or record. A **share** is a grant on one record across a brand boundary or to a guest. | A move, or a change of ownership | The shared record | Move, link |
| **Personal record** | Data that belongs to one person in a workspace: Inbox, Today, private views, preferences, timers. | Private brand content | Personal | Private document |

## 2. Work structure

| Term | Means | Does not mean | Scope / parent | Do not confuse with |
|---|---|---|---|---|
| **Project** | A bounded body of work with an owner, goal, scope, and lifecycle, belonging to exactly one brand. | A brand, a goal, or a folder for any record | Brand (or parent project) | Portfolio, goal, milestone |
| **Parent / child project** | Containment between projects of the **same brand**. Children roll up into the parent's reports. | A dependency | Brand | Project dependency |
| **Project dependency** | An association: one project's progress depends on another's (PRJ-011). | Containment | Association | Child project |
| **Phase** | A named, ordered stage of a project that groups tasks over time. | A status, or a milestone | Project | Milestone, status |
| **Milestone** | A significant checkpoint with a date in a project. It is reached when its criteria are met and is not itself work. | A task, a phase, or a release | Project | Deadline, release |
| **Task** | The unit of work. It has exactly one brand and optionally one project, and it carries assignee(s), status, dates, estimates, and acceptance criteria. | A checklist item, a note, or an Inbox item | Brand / project / parent task | Subtask, Inbox item |
| **Subtask** | A task contained by another task, in the same brand and project. It is a full task with depth limits ([OD-08](open-decisions.md#od-08)). | A checklist item | Parent task | Checklist item |
| **Checklist item** | A lightweight checkbox inside a task, with optional assignee and due date. It has no workflow, comments, or time tracking. | A subtask | Task | Subtask, acceptance criterion |
| **Inbox item** | Raw captured input (text, voice transcript, email, form submission, API payload) awaiting triage. It keeps the original text and source (CAP-016). | A task, even when a task is predicted | Personal (brand optional, [OD-03](open-decisions.md#od-03)) | Notification inbox, task |
| **Triage** | Converting an Inbox item into a task, note, or project (with a brand), merging it, or discarding it. | Prioritization of existing tasks | — | Planning |
| **Note** | A lightweight, untitled-capable text record that can be promoted to a task, project, or document. | A document with workflow, a comment, or a task description | Personal or brand/project/task | Document, comment |
| **Today commitment** | A person's decision to work on an item on a specific day, with manual order. It never changes the item's dates. | A due date, deadline, or work block | Personal | Work block, due date |
| **Daily plan** | The set of today's commitments and work blocks, with the end-of-day record of planned versus completed (PLAN-019). | A calendar | Personal | Briefing |
| **Label** | A free-form classifier applied to records. Canonical term for "labels and tags" ([OD-10](open-decisions.md#od-10)). | A custom field, brand, or status | Workspace or brand | Custom field |
| **Follower** | A person subscribed to notifications for a record. Canonical term for "watcher". | An assignee or collaborator | The record | Assignee |
| **Assignee** | A person (or agent) responsible for doing a task. A task may have several (TSK-007). | The owner of the result | Task | Record owner, follower |
| **Collaborator** | A person given an explicit role on a project. | A follower | Project | Member, follower |
| **Dependency** | An association: an item cannot finish (or start) until another does. *Blocks / blocked by* is the default type ([OD-09](open-decisions.md#od-09)). | Containment | Association | Related link |
| **Blocked** | A derived condition: an open blocking dependency, or a manual blocked flag with a reason. | A status category | Derived | Paused |
| **Related link** | A non-blocking association between records. | A dependency | Association | Dependency |
| **Decision (record)** | A recorded choice with context, owner, and date ([OD-15](open-decisions.md#od-15)). | A go/no-go decision (release-specific) | Brand / project | Go/no-go, approval |

## 3. Content, files, and communication

| Term | Means | Does not mean | Scope / parent | Do not confuse with |
|---|---|---|---|---|
| **Document** | A rich-text page with owner, state (draft/current/stale/archived), versions, and optional child pages. | A file upload, or a comment | Workspace / brand, optionally attached to project or task | File, note |
| **Page** | A document, or a child of a document, in a nested tree in the same scope. | A UI screen | Parent document | View |
| **Document version** | An immutable snapshot of a document's content, created on save points or edits. | A file version | Document | File version |
| **Approved source** | A document version verified by an authorized person as reliable for AI use (DOC-017). | The `current` state, or a review of a deliverable | Document version | Accepted deliverable |
| **File** | Stored binary content with metadata (name, type, size, owner, source, version) (FILE-003). | A document, or a link | Host record | Attachment, deliverable |
| **External link (file)** | A reference to content stored elsewhere, which is not copied (FILE-005). | A file | Host record | File |
| **Attachment** | A file or external link attached to exactly one host record. | Every file in the workspace | Host record | Deliverable |
| **Deliverable** | A file, URL, or artifact designated as **the output** of a task, with versions and review state (FILE-006/007). | Any attachment, or evidence | Task | Attachment, artifact, evidence |
| **Expected deliverable type** | The kind of output a task should produce (document, PR, file, URL, test report…) (TSK-022). | A deliverable | Task | Acceptance criteria |
| **Deliverable version** | One submitted iteration of a deliverable. Review and acceptance apply to a version. | A document version | Deliverable | File version |
| **Evidence** | Material that proves a fact: test screenshots, logs, traces, reports, URLs (TEST-009); approval snapshots; environment URLs. It is often evidence-locked ([deletion §5](deletion-retention-history.md#5-records-that-must-remain-immutable-or-retained-as-evidence)). | A deliverable (output of work) | Test result, defect, release, review | Deliverable, artifact |
| **Comment** | A message on a record, with optional threaded replies, reactions, and mentions. | A note, a document suggestion, or an activity entry | Host record | Activity entry |
| **Suggestion** | A proposed edit inside a document that the owner accepts or rejects (DOC-012). | A comment, or an AI proposal | Document | AI change proposal |
| **Mention** | An inline reference to a person, team, agent, or record. It may notify, and it renders per viewer's access. | A share. Mentioning grants no access. | Host content | Share, link |
| **Activity entry** | A human-readable line in a record's history ("Sam moved this to Done"), derived from audit events and filtered by viewer permission. | The audit event itself | Record view | Audit event, notification |
| **Notification** | A message delivered to one recipient about an event, through in-app, email, browser, or digest. | An activity entry, a briefing, or an alert to admins | Personal (recipient) | Activity entry, digest |
| **Digest** | A scheduled bundle of notifications. | A briefing (which is generated and analytical) | Personal | Briefing |

## 4. Goals, planning, and time

| Term | Means | Does not mean | Scope / parent | Do not confuse with |
|---|---|---|---|---|
| **Goal** | A desired outcome with owner, period, status, baseline, target, and unit (GOAL-002). | A project, a task, or a metric | Workspace / brand / project | Key result, project |
| **Key result** | A measurable target contained by a goal. Progress comes from manual updates or linked work. | A task | Goal | Milestone, metric |
| **Portfolio** | A permission-filtered collection of projects shown with health, dates, risks, effort, and budgets. | An owner of projects | Workspace or brand (view-like) | Brand, parent project |
| **Health** | A project's condition (on track / at risk / off track): set manually, or suggested from rules (PRJ-008). | Status, or completion % | Project | Status, derived condition |
| **Estimate** | Expected total effort for a task. | Duration of a work block, or a due date | Task (rolled up to project) | Duration, remaining estimate |
| **Remaining estimate** | Effort still needed. | Estimate minus logged time (not necessarily) | Task | Estimate |
| **Due date** | The internal target date for finishing ([OD-01](open-decisions.md#od-01)). | A deadline, or scheduled time | Task | Deadline, work block |
| **Deadline** | A hard external commitment date that is never changed implicitly. | A due date | Task / project / milestone | Due date |
| **Completion date** | When the record entered a `done`-category status. | The due date | Task / project | Due date |
| **Work block (scheduled work block)** | Calendar time reserved to work on a task: scheduled start/end and duration. A task may have several. | A due date, a calendar event from elsewhere, or a Today commitment | Task, shown on the person's calendar | External event, commitment |
| **Focus block** | A protected work block that auto-scheduling and plan proposals must not move. | A meeting | Personal | Locked item |
| **Working time / working hours** | The recurring windows when a person (or a brand's calendar) is available for work. | Logged time | Personal / brand | Capacity |
| **Capacity** | The available working time in a period after unavailable time is removed. It is compared against committed and scheduled estimates. | Effort logged | Personal; brand reservation | Workload |
| **Brand capacity reservation** | The planned share of a person's capacity for one brand. It is a soft target. | A hard limit | Brand × person | Capacity |
| **Workload** | Assigned or scheduled effort per person and period, compared to capacity. | Capacity | Computed | Capacity |
| **Time entry** | A record of actual time worked on a task or project, with billable flag. | An estimate, or a work block | Brand of the work | Work block |
| **Timesheet** | A person's time entries for a period, submitted for approval, and locked once approved. | A report | Personal (spans brands) | Time report |
| **Recurrence definition (series)** | A rule plus template that generates occurrences. | An occurrence | Task / project / work block | Occurrence |
| **Occurrence** | One independent record generated from a series. | The series | — | Series |

## 5. Workflow, configuration, and review

| Term | Means | Does not mean | Scope / parent | Do not confuse with |
|---|---|---|---|---|
| **Status** | A named workflow position (e.g., "In review"), mapped to one status category. | Lifecycle state, health, or review state | Workflow | Status category, lifecycle |
| **Status category** | One of `planned`, `active`, `paused`, `done`, `cancelled`. Reporting uses categories ([lifecycle §2](lifecycle-and-states.md#2-status-categories)). | A custom status | Platform-fixed | Status |
| **Workflow** | The set of statuses plus allowed transitions, required fields, and approval rules for a record type in a scope. | An automation | Workspace / brand / project | Automation |
| **Transition** | A move between two statuses, which may require fields or approval (WFL-005..007). | A lifecycle change (archive, trash) | Workflow | Lifecycle event |
| **Custom field** | A typed attribute (text, number, currency, %, date, person, label, checkbox, URL, email, calculated, select) defined at a scope. | A label | Workspace / brand / project | Label |
| **Field set** | A reusable bundle of custom fields applied to record types or projects. | A template | Scope | Template |
| **Calculated field** | A read-only field computed by a sandboxed expression. Covers "formula" ([OD-11](open-decisions.md#od-11)). | An automation | Scope | Automation |
| **Template** | A reusable blueprint (project, task, document, automation, agent, workspace) that creates normal records when installed. | A record linked to its template after installation | Platform / workspace / brand | Recurrence series, sample data |
| **Saved view** | A stored query plus presentation settings (filters, sort, group, columns, layout), personal or shared. | Access to the records it shows | Personal or shared to a scope | Report, portfolio |
| **Dashboard / report** | A configured set of widgets or tables over permission-filtered data, which can be scheduled or exported. | A briefing | Personal or shared | Saved view, briefing |
| **Approval** | A required yes/no decision by an authorized reviewer before a transition or action proceeds. | Acceptance of a deliverable (an approval *of a version*) | The gated transition/action | Review, acceptance |
| **Review (request)** | A request for a reviewer to assess a task, deliverable version, document, proposal, or action. It ends as approved/accepted, changes requested, rejected, or withdrawn. | Approval of a workflow transition (a review can satisfy it) | The reviewed item | Approval |
| **Acceptance** | A human reviewer's approval of a **specific deliverable version** against acceptance criteria. It is immutable, with reviewer and time. | Task completion, merge, or deployment | Deliverable version | Completion, verification |
| **Rejection** | A reviewer's refusal of a deliverable or proposal. The work does not satisfy the request. | Changes requested (which invites iteration) | Review | Changes requested |
| **Acceptance criteria** | Testable conditions the output must satisfy (TSK-020). | Definition of done | Task | Definition of done |
| **Definition of done** | The checklist of conditions for considering the work finished (task or project), including process steps (TSK-021, PRJ-005). | Acceptance criteria (which concern the output) | Task / project | Acceptance criteria, success criteria |
| **Success criteria** | Outcome measures for a project (PRJ-005). | Definition of done | Project | Goal |
| **Claimed completion** | An assertion that work is done, without acceptance ([lifecycle §3](lifecycle-and-states.md#3-completion-review-and-acceptance-are-different-facts)). | Completion or acceptance | Activity | Acceptance |

## 6. Automation, AI, agents, and integrations

| Term | Means | Does not mean | Scope / parent | Do not confuse with |
|---|---|---|---|---|
| **Integration** | A supported external system type (Google Calendar, GitHub, generic webhook, test-result ingestion, CSV). | A specific connected account | Platform catalog | Connection |
| **Connection** | An authorized link between a workspace or brand and an external account, with credentials, owner, scopes, and status. | The integration type | Workspace or brand | Integration, API token |
| **Synchronization (sync)** | Moving data between the product and an external system for a connection, incrementally, with checkpoints and conflicts. | An import (one-time) | Connection | Import, webhook |
| **Sync conflict** | A field changed on both sides since the last sync, recorded for resolution (INT-024). | A sync failure | Connection | Error |
| **Webhook (outbound)** | A signed HTTP notification the product sends on events (INT-011/012). | An inbound webhook | Workspace / brand | Inbound webhook |
| **Webhook (inbound)** | A verified HTTP endpoint that external systems call to create or update records (INT-010/013). | An API token | Workspace / brand | Outbound webhook |
| **API token** | A credential with granular scopes. Personal tokens act as their creator; service tokens act as a workspace principal. A token can never exceed its creator's or policy's rights. | A connection | Personal or workspace | Connection |
| **Automation** | A versioned trigger → conditions → actions rule, executed by the system. | A workflow transition rule, or an agent | Brand or workspace | Workflow, agent |
| **Automation run** | One execution of an automation, with per-step states. | The automation definition | Automation | Agent run |
| **AI action** | A single assistant operation (summarize, draft, extract, plan) executed **on behalf of a person** in an explicit context scope, recorded in AI history. | An agent run, or an autonomous action | Person + context scope | Agent run |
| **AI change proposal** | Typed record changes produced by an AI action, applied only after the person approves selected items (AI-023..025). | An applied change | AI action | Suggestion |
| **Agent** | A configured executor (internal AI or external system) with its own profile, tools, model, instructions, limits, approval policy, and **explicit** brand/project scope. | A person, a member, or an automation | Workspace (profile), with allowed brands | AI action, automation |
| **Agent run** | One execution of a task by an agent: attempts, tool calls, progress, artifacts, cost, and terminal state. | Task completion | Task | AI action |
| **Attempt** | One try within a run or operation. Retries add attempts, not runs. | A rerun | Run | Rerun |
| **Tool call** | One invocation by an agent (or AI action) of a tool, with inputs, outputs, and authorization result. | A human action | Run | Integration action |
| **Artifact** | Any output produced by a run (file, text, patch, link). It becomes a deliverable only when returned to the task as one. | A deliverable | Run | Deliverable, evidence |
| **Emergency stop** | A workspace-level control that pauses all agent execution immediately (AGT-025). | Cancelling one run | Workspace | Cancel |
| **MCP-compatible interface** | Tools exposed to external assistants with the same authorization as the API (INT-022). | A separate permission system | Workspace | API |
| **Provenance / source** | Where a record or change came from: capture channel, integration, import batch, AI action, agent run, template. | Actor type alone | Every record and event | Actor type |
| **Briefing** | A generated, source-linked report for a person (owner/brand daily, weekly review, status update), where every statement links to records (BRF-014). | A digest of notifications, or a dashboard | Personal (recipient) | Digest, report |

## 7. Testing, development, and release

| Term | Means | Does not mean | Scope / parent | Do not confuse with |
|---|---|---|---|---|
| **Test case** | A defined check (manual or automated) with steps and expected result, linked to requirements, tasks, and environments. | A test result | Brand / project | Test run |
| **Test suite** | A named group of test cases. | A test run | Brand / project | Release checklist |
| **Test run** | One execution of a suite or a set of cases against a version and environment. It contains results. | A test case | Suite / brand | Agent run |
| **Test result** | The outcome of one case in one run: `passed`, `failed`, `blocked`, `skipped`, `not_run`, or `flaky`, with expected/actual and evidence. | A defect | Test run | Defect |
| **Flaky (test)** | A result that passed only on retry or conflicts with recent history, or a case classified as intermittently failing over time. | A pass | Result / case | Failure |
| **Defect** | A task of type defect recording a fault, with severity, reproducibility, affected version, environment, owner, and the original failure evidence. | A failed test result (which may create a defect) | Brand (task) | Test result |
| **Environment** | A named deployment target (development, staging, production) with URLs and evidence (DEV-015/016). | A brand | Brand | Release |
| **Release** | A versioned delivery with scope, exclusions, blockers, checklist, readiness, decisions, deployed version, known issues, and verification results. | A milestone, or a deployment event | Brand | Milestone, deployment |
| **Release blocker** | An open item (defect, failing required test, unmet checklist item) that must be resolved or explicitly waived before a go decision. | Any open defect | Release (association) | Blocked task |
| **Merged** | Code integrated into a branch, as reported by the git provider. | Verified, deployed, or accepted | External fact | Verified |
| **Deployed** | A version running in an environment. | Verified | External fact | Released, verified |
| **Verification** | Evidence that a fix works or a release behaves correctly: a passing rerun, or an authorized manual check ([lifecycle §4](lifecycle-and-states.md#4-development-and-defect-states)). | Acceptance of a deliverable, or a merge | Defect / release | Acceptance |
| **Go/no-go decision** | An immutable, approved decision on whether a release proceeds, with approver, evidence, and timestamp (TEST-024/025). | A status change | Release | Approval of a task |
| **Rerun** | A deliberate new execution recorded separately (e.g., test rerun after a fix). | A retry | — | Retry |
| **Retry** | Another attempt at the **same** logical operation, which produces one outcome ([lifecycle §8](lifecycle-and-states.md#8-retries-reruns-and-idempotency)). | A rerun | Operation | Rerun |

## 8. Lifecycle, data, and history

| Term | Means | Does not mean | Scope / parent | Do not confuse with |
|---|---|---|---|---|
| **Active** | Normal lifecycle state. | "In progress" (a status category) | Every record | Status `active` category |
| **Paused** | Status category for work deliberately on hold, or an execution state for runs. The two are unrelated. | Archived | — | Archived, waiting |
| **Completed** | Entered a `done`-category status. | Accepted, verified, or archived | Projects / tasks | Accepted |
| **Archive** | Reversible removal from active use. The record becomes read-only and stays findable. | Deletion | Every record | Trash |
| **Soft delete / trash** | Reversible deletion within the recovery period. | Archive, or permanent deletion | Every record | Archive, purge |
| **Restore** | The event that returns an archived or trashed record to its prior state and place. | Undo (session-level reversal) | — | Undo |
| **Purge** | Irreversible removal of content, leaving a tombstone. | Trash | — | Soft delete |
| **Tombstone** | The minimal structural reference left after purge (ID, type, scope, timestamps, actor). It has no content. | A trashed record | — | Archive |
| **Retention** | The rule for how long a data class is kept before purge ([OD-36](open-decisions.md#od-36)). | Backups | Data class | Recovery period |
| **Recovery period** | How long trashed records remain restorable ([OD-34](open-decisions.md#od-34)). | Retention | Workspace | Retention |
| **Legal hold** | A flag that prevents purge regardless of retention ([OD-37](open-decisions.md#od-37)). | Archive | Record / workspace | Retention |
| **Export** | A permission-filtered copy of data in documented formats, with stable IDs and relationships. | A backup, or a sync | Requesting principal | Backup |
| **Backup** | An operational copy for disaster recovery. It is not customer-accessible. | An export | Platform | Export |
| **Audit event** | An append-only record of who or what did what, when, to which target, with previous/new values for material changes. | An activity entry (a filtered rendering of it) | Workspace | Activity entry |
| **Stale** | A derived or set condition: the record hasn't had a meaningful update within its threshold, or the document is marked out of date ([OD-17](open-decisions.md#od-17)). | Archived | Task / document | Overdue |
| **Freshness** | How recent the underlying data or last meaningful update is. It is shown on metrics, results, and tasks (TSK-041, RPT-024). | Last viewed time | — | Staleness |
| **Usage meter** | A counted consumption measure (AI tokens/cost, automation runs, agent runs, storage, API calls) checked against entitlements and limits. | A bill | Workspace (attributed to brand and actor) | Entitlement |
| **Entitlement** | A server-enforced plan capability or limit (BILL-020). | A permission (which governs who, not what the plan includes) | Workspace subscription | Permission |
| **Degraded mode** | Operation while AI or an integration is unavailable. Core work management continues, and affected features show their state (REL-013/014). | An outage of core functions | — | Failure |

## 9. Synonym map (FEATURES wording → canonical term)

| FEATURES wording | Canonical term |
|---|---|
| business (WSB-003) | brand |
| watchers | followers |
| tags | labels |
| scheduled time, duration (TSK-005) | work block start/end, duration |
| target date (PRJ-004) | project due date |
| formula field (WFL-008) | calculated field |
| groups (COL-003) | teams |
| external agent workflow (TSK-008) | external agent |
| claimed completion (BRF-007) | claimed completion (activity), distinct from acceptance |
| intake request (PRJ-017) | intake form submission → Inbox/intake item |
| time sheet (VIEW-011) | timesheet |
