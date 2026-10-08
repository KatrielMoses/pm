# 15. Authorization decisions (ADRs) and 0B question resolutions

All decisions are **proposed (Phase 0C)**, pending solutions-architect acceptance. Settled tenant-isolation and hidden-metadata decisions are applied, not reopened.

## 15.1 Resolutions of Phase 0B DQ-01 … DQ-08

<a id="resolve-dq-01"></a>
**DQ-01 — grant granularity compiles to SQL. Resolved: yes.**
- Grants exist at five levels: workspace (internal users), brand, project (and document trees), record (shares), and field.
- A restriction flag on brand sensitivity, projects, and documents stops inheritance.
- The context reduces to brand arrays, a workspace level, effective-restricted project and document arrays, granted project and document arrays (expanded down `ancestor_ids`), and a record-grant semi-join on `(record_id, grantee_key)`.
- There are no attribute-based rules that need per-row application evaluation ([04 §4.5](04-effective-permissions.md#45-compiling-to-sql)).
- Visibility-keyed derived caches are valid at `(scope_key, project_id)` granularity plus record grants.

<a id="resolve-dq-02"></a>
**DQ-02 — restricted projects. Resolved.**
- A brand grant flows to every non-restricted project in the brand.
- `work.project.access_mode = restricted` stops brand grants, implicit role access, and ancestor-project grants. Only an explicit grant on the project (or a restricted descendant's own grant) counts.
- Restriction is inherited by descendants for the purpose of stopping broader grants.
- Restricted projects disallow new record shares unless `allow_record_shares` is on.
- The same mechanism applies to document trees. Sensitive brands remove implicit owner and administrator access ([04 §4.2](04-effective-permissions.md#42-grant-precedence-and-conflicts), [§4.4](04-effective-permissions.md#44-restrictions-and-sensitive-scopes)).

<a id="resolve-dq-03"></a>
**DQ-03 — RLS mechanics. Resolved.**
- Transaction-local `SET LOCAL app.workspace_id`, `FORCE ROW LEVEL SECURITY`, and a fail-closed policy when the setting is unset.
- No application, worker, or support role has `BYPASSRLS`.
- Cross-tenant scheduling uses payload-free `SECURITY DEFINER` functions, then per-workspace transactions.
- Migration and restore use separate audited identities ([12](12-rls-and-application-policy.md)). This amends 0B §10.4 (AC-06).

<a id="resolve-dq-04"></a>
**DQ-04 — dynamic subtree shares. Resolved: not allowed.**
- Shares include only records individually selected at share time, each as its own grant row in a share group.
- Future children are never included.
- Scope grants (project role assignments) do flow down containment. They are a different mechanism, unavailable to guests ([06 §6.4](06-guests-sharing-public-links.md#64-share-lifecycle)).

<a id="resolve-dq-05"></a>
**DQ-05 — agent run scope. Resolved: both.**
- At run start, the scope profile grants ∩ assigner access ∩ assignment scope is snapshotted for audit and reproducibility.
- It is re-evaluated at every tool call against current epochs, so access can only shrink.
- Revocation wins over the snapshot ([09 §9.3](09-execution-delegation.md#93-agents)).

<a id="resolve-dq-06"></a>
**DQ-06 — free/busy. Resolved (approved decision applied).**
- Anonymous colleague free/busy is off.
- People always see their own full availability.
- Colleagues see only commitments they can read. Hidden commitments contribute nothing to capacity, conflicts, or aggregates (AT-022).
- A future free/busy policy would be a separate, explicit, per-person setting.

<a id="resolve-dq-07"></a>
**DQ-07 — field-level permissions and derived outputs. Resolved.**
- One field policy is applied by every serializer, query compiler, formula visibility computation, conflict response, audit and activity display, notification renderer, search indexer, exporter, and AI context builder.
- Outputs derived from hidden fields are hidden unless a reviewed disclosure-safe policy exists.
- Queries referencing unreadable fields fail closed ([07](07-field-secret-derived-data.md)).

<a id="resolve-dq-08"></a>
**DQ-08 — Trash. Resolved: current effective permission.**
- Visibility requires a current level ≥ edit; restore also needs a valid destination.
- `trash.manage` administrators are limited to their authorized scopes.
- Guests never see Trash ([11 §11.1](11-trash-archive-departure.md#111-trash-resolves-dq-08)). This amends 0E ST-46 (AC-02).

## 15.2 Architecture decision records

<a id="az-01"></a>
### AZ-01: One server-side decision function, compiled to SQL; no post-filtering
- **Decision:** The effective-permission algorithm is defined once and compiled into SQL predicates applied before sorting, pagination, and aggregation. Single-record checks reuse the same predicate.
- **Alternatives:** Application-side filtering of collections (breaks counts and pagination, and leaks totals). A separate authorization service queried per row (latency, cannot filter in SQL).
- **Consequences:** Policy features are limited to what compiles. The query compiler becomes security-critical code with property tests.

<a id="az-02"></a>
### AZ-02: Ordered access levels plus a role capability matrix; no bespoke policy language
- **Decision:** Four ordered record levels, a 98-action matrix over 6 roles, and policy flags in a workspace policy record.
- **Alternatives:** A relationship-based (Zanzibar-style) graph store (strong but extra infrastructure; relationship traversal conflicts with "relationships never grant access"). An embedded policy language such as Cedar or Rego (expressive but harder to compile into list predicates and to preview). Full ABAC (does not compile).
- **Consequences:** Previews and exposure deltas are simple to compute. Rare needs (time-of-day rules, attribute conditions) are out of scope.

<a id="az-03"></a>
### AZ-03: Implicit access only for owner and administrator, excluding sensitive brands; owner-only elevation
- **Decision:** Owners and administrators get implicit manage on non-sensitive brands. Sensitive brands and restricted projects require explicit grants. `access.elevate_sensitive` is owner-only, step-up, reasoned, time-boxed, notified, and audited.
- **Alternatives:** Owners see everything (violates "owner does not silently bypass"). No implicit access (unusable for founders).
- **Consequences:** A founder sees everything by default. Sensitive data needs deliberate configuration.

<a id="az-04"></a>
### AZ-04: Restrictions are scope flags; no per-principal deny entries
- **Decision:** Restrictions are expressed as project and document `access_mode`, brand `is_sensitive`, and field policies. There is no individual deny list.
- **Alternatives:** Per-principal denies (non-monotonic, hard to compile and explain).
- **Consequences:** Excluding one person means restricting the scope and granting others explicitly, which is clearer to audit.

<a id="az-05"></a>
### AZ-05: One grant row per shared record, grouped by share
- **Decision:** `access.record_grant` stores one row per record with `share_group_id` and a `grantee_key`. Selected children each get a row at share time. This amended (superseded) the former 0B `include_children/selected_child_ids` columns; applied to the model in Phase 0 integration (AC-03).
- **Alternatives:** An array of child IDs on one row (awkward semi-joins, harder revocation per child).
- **Consequences:** Simple, indexable semi-joins. Revoking a share group revokes all its rows.

<a id="az-06"></a>
### AZ-06: Guests hold record grants only
- **Decision:** Guests have no scope grants and no workspace access. Team scope grants do not apply to guest members.
- **Alternatives:** Guest project memberships (dynamic exposure of new tasks, which contradicts the approved "explicit, fixed" rule).
- **Consequences:** Collaborating with a guest on new work requires sharing each new record. The share UI makes this easy, and it is explicit by design.

<a id="az-07"></a>
### AZ-07: Field policy with intersection semantics for derived outputs
- **Decision:** Field visibility applies to every surface. Derived outputs take the intersection of their inputs' visibility. Queries over hidden fields fail closed.
- **Alternatives:** Masking values (signals existence). Post-filtering derived values (inconsistent).
- **Consequences:** Some shared views fail for some viewers, with a clear message.

<a id="az-08"></a>
### AZ-08: Query-time authorization; projections store scope keys only
- **Decision:** Search, metrics, activity, notifications, and caches never hold allow/deny as truth. Authorization is evaluated at query or delivery time.
- **Alternatives:** ACL-in-index (needs reindex on revocation, and risks staleness).
- **Consequences:** Revocation is instant. Query predicates are heavier but indexed.

<a id="az-09"></a>
### AZ-09: Permission epochs for cache invalidation and live rechecks
- **Decision:** Workspace, principal, and agent-class epochs are bumped transactionally and read on every request, step, and tool call.
- **Alternatives:** TTL-only caches (stale access for the TTL). No caching (expensive context builds).
- **Consequences:** One indexed lookup per request. Immediate invalidation.

<a id="az-10"></a>
### AZ-10: Previews and exposure deltas limited to scopes the actor manages
- **Decision:** Previews show only scopes the previewer manages, with no hints beyond them. Changes that widen access show deltas.
- **Alternatives:** Full effective-access dumps (leak to partial administrators).
- **Consequences:** Full pictures require owner-level or broad management rights.

<a id="az-11"></a>
### AZ-11: Delegation by intersection with snapshot plus live recheck; accountable owners
- **Decision:** AI, agents, automations, integrations, tokens, and jobs intersect with their delegator or accountable owner. Snapshots support audit, live checks support safety. A service principal is suspended when its owner loses authority.
- **Alternatives:** Service principals with standalone authority (confused-deputy risk). Snapshot-only (stale after revocation).
- **Consequences:** Departures pause automations and runs until reassignment, which is deliberately visible.

<a id="az-12"></a>
### AZ-12: Self-approval auto mode and independence when available
- **Decision:** `self_approval_mode = auto` allows labelled self-approval only while exactly one approval-capable human exists. Independent approval is required for flagged actions when another approver exists. Execution layers never approve.
- **Alternatives:** Always forbid (blocks solo founders). Always allow (weakens team evidence).
- **Consequences:** Behavior changes automatically when the team grows. Labels keep the evidence honest.

<a id="az-13"></a>
### AZ-13: RLS for tenant isolation only; no BYPASSRLS roles
- **Decision:** As in [12](12-rls-and-application-policy.md).
- **Alternatives:** RLS for all authorization (does not express grants or fields well, and is hard to test). A BYPASSRLS dispatcher (wildcard tenant access).
- **Consequences:** Definer functions need careful review. Workers are per-workspace.

<a id="az-14"></a>
### AZ-14: No impersonation; customer-granted support access
- **Decision:** Support acts as itself under a customer-issued, read-only-by-default, time-boxed grant. Break-glass without consent is not a launch capability.
- **Alternatives:** Impersonation (silent identity confusion, poor audit).
- **Consequences:** Some support cases need customer cooperation.

<a id="az-15"></a>
### AZ-15: Uniform not-found; FORBIDDEN only for readable targets
- **Decision:** As in [06 §6.8](06-guests-sharing-public-links.md#68-permission-safe-not-found).
- **Alternatives:** 403 for every unauthorized target (existence oracle).
- **Consequences:** Clients cannot distinguish "deleted" from "never existed" without access. This is intended.

<a id="az-16"></a>
### AZ-16: Trash uses current permission; guests excluded
- **Decision:** As in the DQ-08 resolution.
- **Alternatives:** Permission as of deletion (would require storing historical ACLs, and resurrects access after revocation).
- **Consequences:** Someone who lost access cannot restore what they deleted. An administrator with authority can.

<a id="az-17"></a>
### AZ-17: Own-account security actions are personal, human-only, and step-up protected (Phase 1B amendment)
- **Decision:** Three personal actions cover the account's own second factor: `account.mfa_enroll` (R3), `account.mfa_disable` (R4), and `account.recovery_codes_regenerate` (R3). All require step-up. They act on the authenticated account outside any workspace, so the matrix shows `own` for every role, and holding one is never a tenant capability. They are human-only: step-up is unavailable to non-human principals, and no scope may list them. Enrollment accepts a password step-up when no factor exists yet, so a first factor never requires MFA. Threat T-35 and tests AT-081…086 cover them. SEC-006, plus SEC-005 for recovery codes.
- **Alternatives:** Reusing the workspace `security.configure` action (would tie personal security to tenant administration). Marking them non-delegable in the matrix sense (owner-only would deny every other member their own MFA).
- **Consequences:** The 0C action count becomes 101 and the step-up count 27. Runtime code takes the step-up subset from the generated registry, and the integration validator checks it.

<a id="az-18"></a>
### AZ-18: Workspace creation is an account command (Phase 1C amendment)
- **Decision:** `workspace.create` (R2, the same class as `brand.create`) is a personal-kind action registered in `account_commands`. A verified human account performs it before any tenant context exists. Every workspace role cell is `deny`: no membership exists yet, so no role can confer it, and holding a role in another workspace never does. Only the `account` principal may exercise it. Tokens, service principals, OAuth clients, integrations, automations, AI, agents, support, and system jobs cannot, and no 0D scope may list it. The mandatory gates are a verified email, an active (not deleted) account, a per-account rate limit, and an Idempotency-Key. It creates authority only by atomically creating the canonical workspace, the active owner membership, and the bootstrap owner assignment (WSB-001). Threat T-36 and tests AT-087…094 cover it.
- **Alternatives:** An unregistered runtime command (authorization outside the catalog). An `own` cell per role (would read as a tenant capability). A workspace-scoped action (no workspace exists to scope it).
- **Consequences:** The 0C action count becomes 102 and the personal kind 8. The validator requires every all-deny personal action to be a registered account command with human-only principals and all four gates. The integration validator checks that runtime authorization uses only catalog actions and that `workspace.create` never reaches tenant or delegated evaluation.

<a id="az-19"></a>
### AZ-19: Invitation acceptance, ownership acceptance, leaving, and workspace policy fields (Phase 1D amendment)
- **Decision:**
  - `invitation.accept` (R2) is an account command like `workspace.create`: every role cell is `deny`, and only the human account principal may perform it. Its gates add a verified email equal to the invitation's normalized email and a single-use, unexpired token. It creates exactly the role assignment (internal) or record grants (guest) the invitation proposed.
  - `ownership.accept` (R4, step-up) is the recipient side of `ownership.transfer`: `own` for internal roles (only a transfer addressed to the caller's membership), `deny` for guests.
  - `membership.leave` (R2) is `own` for every role and is refused for the last active owner or while registered owned resources cannot be reassigned or suspended.
  - None of the three is delegable, and no 0D scope may list them.
  - `workspace_policy` in `policy.json` gives each 0B `access.workspace_policy` column a type, a safe default, and its governing action (`sharing.policy.configure`, `workspace.configure`, or the owner-only `billing.manage` for `admins_manage_billing`).
- **Alternatives:**
  - Treating acceptance as a side effect of sign-in (authority without an authorization decision).
  - One generic `workspace.configure` for every policy key (an administrator could enable `admins_manage_billing` for themselves).
- **Consequences:**
  - The 0C action count becomes 105 (admin 51, personal 10).
  - The validator checks that the policy fields equal the 0B columns, that `public_links_enabled` defaults to false, and that no role can configure a field that gates its own matrix cells.
  - Threats T-37 and T-38, with tests AT-095…107, cover invitation abuse, ownership, and departure.

<a id="az-20"></a>
### AZ-20: Personal navigation is a hint, never authority (Phase 1E amendment)
- **Decision:**
  - Favorites, recents, view state, and preferences are managed under `personal.manage_own` (`own` for every role, including guests). They store identifiers only and never confer access.
  - Every displayed or activated entry is re-authorized through the same compiler and visibility predicate as the target's own read. Unreadable entries are omitted with no placeholder, count, or hint, and removed opportunistically.
  - Shell navigation, breadcrumbs, the command palette, and shortcuts are filtered by the principal's capabilities. Unavailable entries are absent, not disabled.
  - URL and stored scopes are validated server-side. Inaccessible brands are dropped and the scope is narrowed, never broadened.
  - Shared-view pins use `views.configure` and are re-authorized at display.
- **Alternatives:** Client-side filtering of a server list of all favorites (leaks through the response). Showing "unavailable" entries (reveals prior existence).
- **Consequences:** Threat T-39 with tests AT-108…114 covers stale, forged, guest, malformed-state, scope, palette, and departure cases. No new action is needed, so the 0C action count stays 105.

<a id="az-21"></a>
### AZ-21: Project authority, restriction, and shareable types (Phase 2A amendment)
- **Decision:**
  - **Collaborators.** Project collaborators are project-scoped `access.role_assignment` rows (view, comment, edit, manage). No other table confers project authority. Owners and administrators have implicit access only to non-restricted projects in non-sensitive brands; sensitive brands and restricted projects need explicit grants.
  - **Ownership.** The project owner is accountable responsibility (I-10), never authority. Creating, transferring ownership of, or restricting a project creates or keeps an explicit project manage grant for the responsible manager. A deferred guard keeps one eligible manager on every active project.
  - **Restriction.** A restricted project stops brand, workspace, and ancestor-project grants for itself and its descendants. Only explicit project grants and exact record grants count. `allow_record_shares` defaults to false.
  - **Shares.** One shareability registry names the shareable record types and their enforced levels. A project share grants exactly the project representation plus its intrinsic, non-addressable facts: criteria items and scope items (scope, exclusion, risk, assumption, constraint), and the latest verified update's content and public ID (PRJ-025). It never grants phases, milestones, decisions or open questions, dependencies, child projects, recurrence configuration, templates, collaborators, grants, audit or activity, verification history (verifier, time), unverified or older updates, or update counts. Each overview section is authorized on its own; a separate authority may show more. Direct child endpoints return `not_found` to a share-only reader. Unreadable targets return `not_found` (AT-115); readable targets without `record.share`, or of an unshareable type, return `forbidden` (AT-050, AT-116).
  - **New actions.** `project.verify_update` (OD-16) and `project.manage_recurrence` (OD-14). The action count becomes 107.
- **Alternatives:** A `project_member` level (a second authority source). Owner as implicit manager (contradicts I-10). Returning `not_found` for every share refusal (hides real permission errors from people who can see the record).
- **Consequences:** The compiled visibility predicate gains the restricted-project subtraction and the project-grant branch of §4.5. Preview and enforcement stay one engine.

<a id="az-22"></a>
### AZ-22: Task authority, assignment, and the task share (Phase 2B amendment)
- **Decision:**
  - **Visibility.** A project-contained task follows its project's chain (brand access until a restricted project, then explicit project grants); a projectless task follows its brand. Both use the one compiled predicate, before pagination, counts, rollups, history, and relationships. No owner or administrator bypass.
  - **Responsibility is not authority.** Creators, assignees, and labels never grant access. Only active internal members may be assigned; an assignment to a task the person cannot read stays invisible to them (AT-117).
  - **Task share.** `task` is shareable at view, comment, and edit (stored view = read). A share grants the task representation, its checklist, and its own criteria items, plus the owning brand marker. It never grants the parent, children, project, inherited project criteria, assignees' directory data, labels beyond their displayed names, dependencies or related endpoints, links to records the reader cannot read, history, comments, attachments, or future descendants. Commands that a share excludes return `not_found` to a share-only reader (AT-118). No onward sharing.
  - **Relationships.** `record.relate` on the source plus readability of both endpoints at creation; every display re-authorizes both and omits unreadable counterparts with no count or clue (AT-119).
  - **Completion override.** Completing with incomplete required criteria, or a parent with incomplete descendants, needs `task.override_completion` and a reason; the recorded count covers only descendants the actor can read (AT-120).
  - **Cross-brand move.** The existing `record.move_brand`, decided at manage in both the source and the destination brand, with preview and confirmation (AT-121).
  - **Labels.** `label.manage` at brand scope.
  - **New actions.** `task.override_completion` and `label.manage`. The action count becomes 109.
- **Alternatives:** Assignment as a grant (contradicts I-10). Shares implying children or the project (contradicts OD-04). A separate task permission table (a second authority source).
- **Consequences:** The compiled predicate's governing-project derivation gains tasks; preview and enforcement stay one engine.

<a id="az-26"></a>
### AZ-26: Reusable queries and saved views (Phase 3A amendment)
- **Decision:**
  - **A view grants nothing.** Every query, saved or ad hoc, runs the engine-compiled visibility predicate and field allow-list of the person running it. The query AST cannot express scope or permissions. A shared view returns each viewer's own rows (AT-146).
  - **Before disclosure.** Rows, totals, group counts and labels, filter-value labels, cursors, and exports are all computed from the same authorized predicate. A filter value naming a hidden brand, project, member, label, milestone, status, or option resolves to nothing, exactly like an unknown value, with the same statements and timing (AT-147). People fields (owner, assignee, assigned by) and fields that are not `all_readers` (or not guest-visible for guests) are `unsupported_field` for those who may not use them, identical to unknown fields (AT-151).
  - **Personal views.** Personal saved views, the person's own default view, and per-view state are `personal.manage_own`: only the owner sees or changes them, with no owner or administrator bypass (AT-148).
  - **Sharing.** `view.share` is decided at exactly one scope (workspace, brand, or project), never through record shares (AT-149). Re-sharing moves the view; unsharing returns it to its owner and removes its pins and scope defaults at once. The same decision governs changing or deleting a shared definition.
  - **Defaults and pins.** `views.configure` at the brand, project, or workspace sets defaults and pins (AT-150). Only a view shared with that exact scope (or the workspace, for defaults) qualifies, and a database trigger repeats the pin rule. Every default and pin is re-authorized for each viewer at display and skipped silently when unreadable.
  - **Cursors and exports.** Cursors are MAC-bound to the workspace, principal, and query fingerprint, and refused for anyone or anything else (AT-152). Direct exports re-run the requester's current predicate at request time and store nothing, so no artifact outlives a revocation (AT-153); each is audited with an `export` security event.
  - **No new actions.** The action count stays 120.
- **Alternatives:** Materialized shared result sets (they would freeze and widen access). Views carrying their creator's authority (a second authority source). Stored export files before 4E (they would need re-authorization on download and storage the platform does not have yet).
- **Consequences:** Threat T-44 with tests AT-146 to AT-153.
<a id="az-32"></a>
### AZ-32: Notifications (Phase 4B amendment)
- **Decision:**
  - **Authorized twice.** A notification is created only for an active member who can read the record now (security notices about access excepted), and its summary, record, brand, project, and actor are rendered at display from what that person can read at that moment. A row about something no longer readable shows only "You no longer have access to this item" with its time and state (AT-198, AT-199).
  - **Delivery.** Email and browser content is re-authorized when sent. A delivery whose recipient lost access, left, or switched the channel off is suppressed with a reason and carries nothing. Brands set to minimal content, and every sensitive brand, send only the brand name and the kind of event (AT-200, AT-201).
  - **Own state only.** Reading, saving, dismissing, preferences, quiet hours, digests, and delivery history are the person's own. Another person's notification, delivery, preference, or profile is `not_found`, the same as an unknown one (AT-202, AT-203).
  - **Preferences never widen.** A preference only quiets or defers delivery of what authorization already allows. Security notices (`permission_changed`, `share_changed`) cannot be muted or held by quiet hours. A mute scope the person cannot read is refused with the same issue as an unknown one (AT-204).
  - **Defaults.** Brand and project defaults need `notifications.configure_scope`, rank below every personal choice, and are audited. Delivery health (failed and dead-lettered deliveries) needs `health.view` and shows recipient, channel, class, and code, never content or addresses; a retry needs `workspace.configure` and is audited (AT-205, AT-206).
  - **Digests.** A digest is assembled and sent only with items the recipient can still read; hidden items are omitted, not redacted, and carry no count (AT-207).
  - **No new actions.** The action count stays 122.
- **Alternatives:** Storing titles in notification rows (stale and leaky after revocation). Delivering email before rechecking access (cannot be recalled). A per-brand switch for security notices (a way to hide a permission change from its subject).
- **Consequences:** Threat T-50 with tests AT-198 to AT-207.

<a id="az-31"></a>
### AZ-31: Comments, mentions, following, and reviews (Phase 4A amendment)
- **Decision:**
  - **Through the host.** Every comment, reaction, mention, follower, review, and assignment fact is authorized through its host record on each read and write. An unknown and an unreadable comment, record, or review are one `not_found` (AT-185, AT-197). A share carries the record and its comments at the share's level, nothing more (AT-192).
  - **Commenting.** `record.comment` covers comments, replies, reactions, and mentions. Read-only members and read-level shares are `forbidden` (AT-186). An archived record needs the `comment_on_archived` policy.
  - **Mentions.** An author may name only active members who can read the host, teams, and records the author can read. Hidden, unknown, ineligible, and agent targets share one `not_mentionable` issue. Guests may not mention people, teams, or records (AT-187). A mention grants nothing and is shown only while its target is visible to the viewer.
  - **Edit and delete (OD-38).** Only the author edits (`comment.edit_own`), and only inside the window (AT-188, AT-189). A person with manage on the record (`comment.moderate`) deletes, never edits, and reads revision trails together with the author (AT-190).
  - **Following (OD-10).** `record.follow` needs only the right to read the record. A follow is the person's own, and is never inherited. A follow the person can no longer read is omitted everywhere (AT-191).
  - **Reviews.** `review.request` is authority over the record through ownership. `review.decide` belongs to a named reviewer who is eligible when deciding, on the version they reviewed, once (AT-193). Deciding one's own request needs the workspace self-approval policy and no `require_independent_for` entry (AT-194). Reviews are visible to readers through ownership and to the people involved.
  - **Delegation and history.** `record.delegate` is a current assignee handing over to an active member who can read the task (AT-195). The history is outside a share. Neither changes anyone's access.
  - **Activity.** Collaboration events appear in activity without bodies, and any change naming a record, person, or value the viewer cannot read is dropped (AT-196).
  - **No new actions.** The action count stays 122.
- **Alternatives:** Letting administrators edit comments (a silent rewrite of another person's words). Followers derived from assignment (disclosure and noise). Showing reviewers' names to every reader (people are directory facts).
- **Consequences:** Threat T-49 with tests AT-185 to AT-197.

<a id="az-30"></a>
### AZ-30: Capacity and cross-brand conflicts (Phase 3E amendment)
- **Decision:**
  - **Personal settings.** Working hours, the weekly override, holiday observance, and time off are `personal.manage_own`. Only their owner changes them. Someone else's time-off entry is `not_found`.
  - **New actions.** `capacity.view` (workspace or brand) lets a person see others' availability, allocation, reservations, and conflicts. `capacity.reserve` (brand) sets reservations. Owners and administrators hold both implicitly, and members need a manage grant. The action count is now 122.
  - **Others' time off.** With `capacity.view`, time off shows only as unavailable minutes. Kinds, labels, and entries stay private (AT-180).
  - **What a viewer sees.** Your own view lists all your blocks, and blocks on work you cannot read become unbranded busy time. For anyone else, the view shows only blocks and estimates on tasks the viewer can read, in brands where the viewer holds `capacity.view` (AT-179). Estimates come from the 3A compiled query with the viewer's predicate. A brand the viewer cannot read is never named, counted, or used to apply a holiday (AT-181).
  - **Refusals.** Without `capacity.view`, another person's capacity is `not_found` (AT-177) and a team read is `forbidden` (AT-178). A reservation without `capacity.reserve` is `forbidden`, and in an unreadable brand it is `not_found` (AT-182). Brand holidays are changed under `brand.configure`.
  - **Revocation.** Visibility is decided on each read, so losing a grant removes access at once (AT-183). Strangers get the same `not_found` on every capacity route (AT-184).
- **Alternatives:** Free/busy for everyone (off by default; time-and-scheduling §5). Showing time-off kinds to managers (personal data). A capacity cache filtered per viewer (it could outlive a revocation).
- **Consequences:** Threat T-48 with tests AT-177 to AT-184.

<a id="az-29"></a>
### AZ-29: Today and manual planning (Phase 3C amendment)
- **Decision:**
  - **Personal.** Today commitments, work blocks, block series, and daily records use `personal.manage_own`: only their owner reads or changes them, with no owner or administrator bypass (AT-169).
  - **Work it names.** Committing a task, scheduling a block for it, or creating a series for it needs the task to be readable now (`record.read`, view); hidden and unknown tasks are one `not_found` (AT-170). A block or commitment never grants anything.
  - **Revocation.** When the owner can no longer read a task, its commitments drop out of Today and its blocks remain as busy time without a title or link (AT-171); plans and records never reveal the task.
  - **Lists.** Overdue, due-today, and upcoming-deadline sections run the 3A query engine with the viewer's own predicate (AT-172).
  - **Dates.** Planning commands never change due dates or deadlines; changing a due date after moving a block is a separate, explicit task edit under `record.update` (AT-173).
  - **Locks.** Locked commitments and blocks are never moved, reordered, carried, or removed by any command until the person unlocks them (AT-174); focus blocks refuse overlapping blocks (AT-175).
  - **Records.** Daily records are append-only (AT-176).
  - **No new actions.**
- **Alternatives:** Shared or manager-visible plans (personal data; OD-03 pattern). Letting a block grant read access to its task (contradicts I-10).
- **Consequences:** Planning rows are filtered by owner in every query in addition to workspace RLS.

<a id="az-28"></a>
### AZ-28: Core view layouts (Phase 3B amendment)
- **Decision:**
  - **One record set.** Every layout renders the records the person's own compiled 3A query returns. Layout facts are computed only for those records: workload totals, Gantt dependencies (both endpoints must be returned), milestones and progress of returned projects (progress counts readable leaf tasks only, OD-13), and the person's own time. Hidden records never change a column count, bar, arrow, cell, total, or percentage (AT-162 to AT-164, AT-167).
  - **Activity** covers returned records the person can read through ownership; history is outside a share (AZ-22, AT-165). Every record and person a change names is re-authorized, changes to fields they cannot read are dropped, and entries with nothing left are omitted (IA-43).
  - **Changes go through the canonical commands.**
    - Board status moves preview and apply the workflow transition with the record version. Gated moves (required fields, approval, confirmation) change nothing and are reported per item (AT-166).
    - Priority moves and timeline date shifts are field merges with base values and versions. Dependency-aware shifts are explicit and per item.
    - No layout changes a deadline. Every command needs `record.update` (AT-168).
  - **No new actions.** The action count is unchanged.
- **Alternatives:** Layout-specific aggregates computed with a broader predicate (they would leak through counts). Board moves that write `status_id` directly (they would bypass gates).
- **Consequences:** Threat T-46 with tests AT-162 to AT-168.

<a id="az-27"></a>
### AZ-27: Time tracking, timesheets, approvals, and unlock (Phase 3D amendment)
- **Decision:**
  - **Logging.** `time.log_own` (record, comment) is decided on the task or project at every write (create, edit, move to another target, timer start and resume). A share at comment or above grants it, guests included; read-only roles never log (AT-154).
  - **Reading.** An entry is readable through its work's compiled visibility (view; archived work included, trashed and hidden work never). Guests read only their own entries. Lists, totals, reports, summaries, timesheets, approval views, and exports run the same predicate inside SQL, so hidden work is never named or counted (AT-155).
  - **Own entries only.** Only the owner changes an entry; anyone else gets `not_found`. After losing access, a person may still pause, stop, or discard their own live timer (target and note withheld); resuming needs `time.log_own` again (AT-156).
  - **Submission.** `timesheet.submit_own` (personal; guests denied) by the period's owner only.
  - **Approval.** `timesheet.approve` (brand, manage) is decided now, per brand line. The approver must be able to read every entry in the line; otherwise `forbidden` (`incomplete_visibility`) (AT-157). Self-approval follows the workspace policy (OD-20: `auto` allows it only while one approval-capable member exists) and is recorded and labelled (AT-158). Being an approver grants no access.
  - **Unlock (OD-26).** `timesheet.unlock` (admin, brand, R3, step-up): workspace owners and administrators only, with a reason. It appends an `unlock` row, writes a `permission` security event, and requires the line to be submitted and approved again (AT-159).
  - **Locks.** Submitted or approved time cannot be created, changed, moved between brands, or deleted by anyone through any path; the database guard repeats the rule (AT-160).
  - **Exports.** A time export contains only what the requester can read at request time and writes an `export` security event (AT-161).
  - **No new actions.** The four 0C actions (`time.log_own`, `timesheet.submit_own`, `timesheet.approve`, `timesheet.unlock`) are implemented unchanged.
- **Alternatives:** Approver authority from the timesheet owner's manager relationship (no such relationship exists; brand manage is the canonical authority). Unlock by brand managers (OD-26 chose workspace admins).
- **Consequences:** Time rows are filtered by the viewer's predicate in addition to workspace RLS; the per-person lock serializes approval with every edit it protects.

<a id="az-25"></a>
### AZ-25: Inbox and universal capture (Phase 2E amendment)
- **Decision:**
  - **Personal capture.** Capture, Inbox, notes, merge, and parse previews use `personal.manage_own`: only the owner sees or changes their items and notes, with no owner or administrator bypass (OD-03, AT-138). Brand context on a personal item grants nothing.
  - **Resolution.** Parsing resolves brands, projects, members, and labels only among those the person can read. Unknown and hidden names are reported identically as unresolved, with the same statements (AT-139).
  - **Triage and conversion.** Turning an item or note into a task or project requires `record.create` at the destination brand or project chain, decided at preview and again at apply (AT-140, AT-141). Converting to a note or discarding is personal.
  - **Intake forms.** `intake.manage` (admin, brand) configures forms (AT-145). `intake.submit` (brand, view) lets readers of the brand submit (AT-143, AT-144). Members only while OD-28 is open; guests are refused. Submitting reveals nothing about the queue.
  - **New actions.** `intake.manage`, `intake.submit`. The action count becomes 120.
- **Alternatives:** A shared brand intake queue visible to managers (OD-03 keeps items personal; a queue owner triages). Anonymous forms (OD-28 is open).
- **Consequences:** Personal rows are filtered by owner in every query in addition to workspace RLS.

<a id="az-24"></a>
### AZ-24: Task interaction quality (Phase 2D amendment)
- **Decision:**
  - **Personal state.** `task.remind` and `task.snooze` (record, view) are personal: they grant nothing, change nothing on the task, and are never shown to anyone else. The reminder worker rechecks `record.read` before firing; a reminder on a task that became unreadable is cancelled without notice (AT-134, AT-135).
  - **Recurrence.** `task.manage_recurrence` (record, manage) mirrors `project.manage_recurrence`; each occurrence needs `record.create` in the brand (and the project), rechecked per occurrence, and a series whose owner lost it pauses (AT-136). Occurrences never copy assignees, shares, approvals, relationships, comments, history, or field values the owner could not read.
  - **Templates.** Creating or versioning task templates is `templates.manage`; applying one is `record.create` at the explicit brand or project. Content the applier may not set is omitted and reported by kind, never by value (AT-137).
  - **Signals and duplicates.** Freshness, blocked, missing-data, and duplicate signals are computed only from records and fields the viewer can read; unreadable blockers and candidates are omitted with no count or placeholder (AT-130, AT-131).
  - **Bulk, ordering, and undo.** Bulk commands authorize every item with that item's own action. Unreadable items in an explicit set are reported as `not_found`, exactly like unknown identifiers (AT-132). Ordering commands are `record.update` on the moved task. Bulk status options and previews count only readable tasks the caller may edit; each item's target and missing required fields come from the evaluator under the 2C field policy (review 01). Undo entries belong to their actor alone and re-run current authorization and version checks (AT-133).
  - **New actions.** `task.remind`, `task.snooze`, and `task.manage_recurrence`. The action count becomes 118.
- **Alternatives:** Reminders as shared task facts (would expose personal state). A bulk-specific permission (a second authority source).
- **Consequences:** No new access tables; personal rows are RLS-limited to their account.

<a id="az-23"></a>
### AZ-23: Workflow configuration, transitions, approvals, and field policy (Phase 2C amendment)
- **Decision:**
  - **Configuration.** `workflow.configure` and `fields.configure` are decided at the configuration's own scope: workspace, brand (`decideBrand`, so sensitive brands need an explicit manage grant), or project (`decideProject`, so restricted projects need explicit project manage). There is no owner or administrator bypass, and nobody configures above their grantable authority. Changing a workflow or field scope never changes record authority.
  - **Transitions.** `workflow.transition` (record, edit) covers preview and apply, including Complete, Cancel, and Reopen. A generic edit that changes status runs the same evaluator (AT-122). Required fields are checked on the final merged record under lock, and a missing field leaves the record unchanged (AT-123).
  - **Approvals.** `workflow.approval_request` (record, edit) and `workflow.approval_decide` (record, view, plus policy eligibility). Eligibility is manage on the record (`one_manager`) or being a named approver (`all_named_approvers`). An approver who cannot read the record gets `not_found`, and their queue omits the request (AT-124). Being an approver grants no access. Self-approval needs the transition flag and the workspace `self_approval` policy (OD-20). Agents and other non-human principals never decide. Any change to the record, transition, or permission makes a request or preview stale (AT-125).
  - **Field policy.** `access.field_policy` (0C §7.1) is applied to custom fields through `field.value_read` and `field.value_edit` by every serializer, error, count, audit display, and serialization. Hidden fields are absent, not null (AT-126). A formula is readable only where every input is readable (AT-127). `field.formula_inspect` explains inputs only under the same rule.
  - **References.** Person and label values never grant access (AT-128).
  - **New actions.** `workflow.transition`, `workflow.approval_request`, `workflow.approval_decide`, `field.value_read`, `field.value_edit`, `field.formula_inspect`. The action count becomes 115.
- **Alternatives:** Approval rights as an access grant (contradicts I-10). UI-only field hiding (contradicts I-18). A separate approval permission table (a second authority source).
- **Consequences:** The compiled context gains readable and editable custom field keys per (record kind, scope). Preview and enforcement stay one evaluator.
