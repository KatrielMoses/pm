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
