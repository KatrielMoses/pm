# 4. Scope hierarchy and the effective-permission algorithm

## 4.1 Scopes and where grants attach

| Scope | Grants that attach | Flows to |
|---|---|---|
| Workspace | Implicit (owner and administrator: manage; member and read-only: workspace default level, normally view); workspace-scope role assignments (internal users only) | **Workspace-scoped records only** (`brand_id IS NULL`), unless a document is restricted. **Never** to brands. |
| Brand | Implicit (owner and administrator, **non-sensitive** brands only); brand role assignments to memberships or teams | Every record in the brand **except** inside restricted projects or documents |
| Project | Project role assignments | The project, its tasks and hosted children, and descendant projects **until a restricted descendant** |
| Document (page tree) | Document role assignments on a document | The document and its child pages until a restricted descendant |
| Record | Record grants (shares) to a membership, team, or brand context | **That record only**. Never children, parents, or related records (I-05). |
| Field | Field policy ([07](07-field-secret-derived-data.md)) | Narrows which fields of readable records are visible or editable |
| Integration connection | Connection role (manage/view) | The connection's configuration and health, never synced data by itself |
| Personal | Ownership | Only the owner. No role or grant reaches another person's personal records. |

**Containment carries scope grants; it never carries share grants.** A share of project P gives the grantee P itself. The children selected at share time each receive their own grant row (AZ-05), and nothing else.

## 4.2 Grant precedence and conflicts

1. **Tenant isolation** first. A target in another workspace is NONE, and nothing can change that (I-03).
2. **Restrictions remove inherited access at their path.** A restricted project, document, or sensitive brand removes implicit role access and all grants inherited from **broader** scopes (workspace, brand, ancestor project). Restriction wins over an inherited allow at the same or a broader path.
3. **Explicit grants at or below the restricted path** count: a project grant on the restricted project itself, or on a descendant inside it that is not further restricted, and record grants on individual records.
   - Restricted projects disallow **new** record shares unless the project's `allow_record_shares` setting is on (default off). This prevents a manager from tunneling around the restriction.
4. Among the grants that count, the **maximum level** wins (grants are additive).
5. The **role cap** is applied last: `read_only` → view; `guest` → share level, max edit.
6. **Lifecycle:** writes require `active`. Archived records allow read, plus comment only where workspace policy allows it. Trashed records are reachable only through Trash rules ([11](11-trash-archive-departure.md)). Purged records are NONE.
7. **Expiry and revocation:** grants with `state <> 'active'` or `expires_at <= now()` do not count, evaluated at query time.

There is no per-person deny list. To exclude someone from part of a brand, restrict the project and grant the others explicitly. This keeps evaluation monotonic and compilable.

## 4.3 Algorithm

```text
effective_level(ctx, r):                          # r = target record (or host of a hosted child)
  if r.workspace_id != ctx.workspace_id: return NONE                  # I-03
  if not ctx.membership_active or ctx.principal_suspended: return NONE
  if r.lifecycle == 'purged': return NONE
  if r.is_personal:                                                    # Inbox, Today, notifications, …
      return MANAGE if r.owner_membership_id == ctx.membership_id else NONE

  lv = NONE
  restricted_path = r.project_id in ctx.restricted_projects_eff or r.doc_root in ctx.restricted_docs_eff
  if r.brand_id is None:                                               # workspace-scoped record
      if not restricted_path: lv = max(lv, ctx.workspace_level)        # owner/admin manage; member default view; guest NONE
  else:
      if not restricted_path:
          lv = max(lv, ctx.brand_level[r.brand_id])                    # implicit (non-sensitive) ∪ brand grants
  lv = max(lv, ctx.project_level.get(r.project_id, NONE))              # explicit grants expanded down the tree,
                                                                       # stopping at restricted descendants
  lv = max(lv, ctx.document_level.get(r.doc_root_or_self, NONE))
  lv = max(lv, max_share_level(r.id, ctx.subject_keys))                # record grants: exact record only
  lv = min(lv, ctx.role_cap)                                           # read_only=view, guest=edit
  if r.lifecycle == 'archived': lv = min(lv, COMMENT if ctx.policy.comment_on_archived else VIEW)
  if r.lifecycle == 'trashed':  lv = trash_level(ctx, r)               # see 11 §11.1
  return lv

authorize(ctx, action, r):
  cell = matrix[action][ctx.role]                                      # role capability
  if cell == deny: return DENY
  if action.entitlement and not ctx.entitled(action.entitlement): return DENY
  if cell == own and not owns(ctx, r): return DENY
  if cell.startswith('policy:') and not ctx.policy[cell.key]: return DENY
  lv = effective_level(ctx, r)
  if lv == NONE: return NOT_FOUND                                      # indistinguishable (I-07)
  need = action.required_level or level_from(cell)                     # e.g. grant:manage → manage
  if cell != implicit and lv < need: return FORBIDDEN if lv >= VIEW else NOT_FOUND
  for gate in action.gates: (lifecycle, completion gates, separation of duties, step-up, approval, delegation scope)
      if not gate.ok: return gate.result                               # FORBIDDEN / APPROVAL_REQUIRED / STEP_UP_REQUIRED
  return ALLOW
```

`ctx.subject_keys` = {membership ID} ∪ {team IDs of active team memberships} ∪ {brand IDs where the principal's brand level ≥ view through a non-restricted path}. The last part lets shares to a *brand context* apply to that brand's members. It is not included for guests.

**Execution layers** run the same function with `ctx` describing the delegated principal, and then intersect: `lv = min(lv_principal, lv_delegator, lv_scope)` ([09](09-execution-delegation.md)).

## 4.4 Restrictions and sensitive scopes

| Mechanism | Effect | Who sets it |
|---|---|---|
| `brand.is_sensitive` | Owner and administrator lose **implicit** access. Only explicit brand, project, or record grants count. Aggregates for those users exclude the brand. | `brand.mark_sensitive` (owner, administrator; step-up) |
| `project.access_mode = restricted` | Brand grants, implicit access, and ancestor-project grants stop here. Explicit grants on this project (or below) are required. | `access.restrict_scope` (manage on the project) |
| `document.access_mode = restricted` | Same, for document page trees | `access.restrict_scope` |
| Field policy | Narrows visible or editable fields ([07](07-field-secret-derived-data.md)) | `access.restrict_scope` (field scope) |

**Controlled elevation (break-glass):** `access.elevate_sensitive` is owner-only, non-delegable, step-up, and requires a reason. It creates an explicit, **time-boxed** grant on the sensitive brand or restricted project. It writes audit and security events and notifies the scope's managers. There is no silent bypass. **Creator grants:** whoever creates a brand, or marks a brand sensitive or a project/document restricted, receives an explicit manage grant on that scope in the same transaction. A solo founder therefore never locks themselves out, and the explicit grant shows up in previews and audit.

## 4.5 Compiling to SQL

### Visibility context (built once per request, cached by epochs)

| Parameter | Content |
|---|---|
| `:ws` | Workspace ID (also `SET LOCAL app.workspace_id`) |
| `:brand_view`, `:brand_edit`, `:brand_manage` | `uuid[]` of brands where the brand level ≥ that level (implicit non-sensitive ∪ brand grants, capped) |
| `:ws_level` | Level on workspace-scoped records |
| `:restricted_projects` | `uuid[]` of projects that are restricted **or have a restricted ancestor**: the "effective restricted" set, computed from `ancestor_ids`, cached per workspace epoch |
| `:proj_view` (…`_edit`, `_manage`) | `uuid[]` of projects with explicit grants, expanded to descendants that are not under a further restricted project, capped by role |
| `:restricted_docs`, `:doc_view` | Document equivalents (by page-tree root and `ancestor_ids`) |
| `:subjects` | Subject keys (membership, teams, eligible brand contexts) |
| `:me` | Membership ID (personal records) |

Sizes are small in practice: brands ≤ tens; restricted sets ≤ hundreds; granted projects ≤ thousands. Arrays above ~10,000 elements switch to a transaction-scoped temporary table joined in the same way.

### List query (tasks), filtered before pagination

```sql
SELECT t.id, t.public_id, t.title, t.status_id, t.due_date            -- columns from the field allow-list only
FROM work.task t
WHERE t.workspace_id = :ws                                            -- plus RLS backstop
  AND t.lifecycle_state = 'active'
  AND (
        ( t.scope_key = ANY(:brand_view)
          AND (t.project_id IS NULL OR t.project_id <> ALL(:restricted_projects)) )
     OR ( t.project_id = ANY(:proj_view) )
     OR EXISTS (SELECT 1 FROM access.record_grant g
                 WHERE g.workspace_id = :ws AND g.record_id = t.id
                   AND g.grantee_key = ANY(:subjects)
                   AND g.state = 'active'
                   AND (g.expires_at IS NULL OR g.expires_at > now()))
      )
  AND (t.due_date, t.id) > (:cursor_due, :cursor_id)                  -- keyset pagination
  AND <user filters compiled only from fields readable by this viewer>
ORDER BY t.due_date, t.id
LIMIT :page_size;
```

- **Counts and facets** use the identical `WHERE` with `count(*)` / `GROUP BY`. Totals therefore always match the rows a viewer could page through (IA-41).
- **Read-only role:** the `_view` arrays are the only ones populated. Write affordances for each row on the page are computed with the `_edit`/`_manage` arrays for those page rows only. That decorates rows; it does not filter collections.
- **Guests:** `:brand_view`, `:proj_view` are empty, `:ws_level` is NONE, and `:subjects` = {guest membership, guest's teams}. Only the record-grant branch can match.
- **Workspace-scoped records:** add `OR (t.brand_id IS NULL AND :ws_level >= 'view' AND <not restricted doc>)` for tables that allow workspace scope.
- **Personal tables:** `WHERE owner_membership_id = :me` replaces the whole visibility predicate.
- **Hosted children** (comments, attachments, field values) join their host and apply the host predicate.

### Single-record check

Single-record reads use **the same compiled predicate** with `AND t.id = :id`. This avoids a second, divergent implementation. Zero rows → `NOT_FOUND`. For writes, the command loads the row `FOR UPDATE` through the edit-level predicate, then runs the gates.

### Derived conditions per viewer (UXD-28)

```sql
-- "Blocked" for task t, as seen by this viewer
t.manual_blocked_reason IS NOT NULL
OR EXISTS (
  SELECT 1 FROM relations.record_relationship rr
  JOIN work.task b ON b.id = rr.from_record_id
  WHERE rr.to_record_id = t.id AND rr.kind = 'blocks'
    AND b.lifecycle_state = 'active' AND b.status_category NOT IN ('done','cancelled')
    AND <visibility predicate applied to b>                            -- hidden blockers contribute nothing
)
```

The same pattern applies to dependency arrows, relationship lists, related-record counts, and goal links. Both endpoints must pass the visibility predicate.

### Indexes that make this cheap

The predicate is designed to hit the 0B indexes:

- `(workspace_id, scope_key, …) WHERE lifecycle_state='active'`;
- `(workspace_id, project_id, …)`;
- on `access.record_grant`: `(workspace_id, record_id, grantee_key) WHERE state='active'`, and `(workspace_id, grantee_key, record_id)` for "shared with me".

Planner behavior is verified with `EXPLAIN` tests in 1D/2B for representative principal shapes: owner, brand member, restricted-project member, guest with many shares.

## 4.6 Worked example

Katriel (owner) has the brands MailAccess, API Access, and Optestra. Optestra is sensitive. Sam is a member with a brand grant of edit on API Access. API Access has a restricted project "Pricing", where only Lee holds an explicit project grant. Guest Gia has a read share on one API Access task.

| Viewer | Sees in API Access | Sees in Optestra | Why |
|---|---|---|---|
| Katriel | Everything, including Pricing (owner implicit manage; Pricing is restricted, but Katriel created it and holds the creator's explicit manage grant) | Everything (explicit creator grant on the sensitive brand) | Implicit access + explicit grants |
| Administrator Ana (no explicit grants) | Everything except Pricing | Nothing | Restricted project and sensitive brand stop implicit access. Ana can use no elevation (owner-only). |
| Sam | All non-Pricing records, edit | Nothing | Brand grant stops at the restricted project |
| Lee | Pricing only (and anything else granted) | Nothing | Explicit project grant |
| Gia | The single shared task, read-only, with the API Access brand marker (UXD-06). No project crumb unless the project was also shared. No relationships to unshared records. | Nothing | Record grant only |
