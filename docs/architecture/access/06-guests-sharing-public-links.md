# 6. Guests, read-only, sharing, and public links

## 6.1 Guests

- Guests receive **only record grants** (shares). They never receive workspace, brand, or project scope grants (AC-04 amends 0B §3.9 accordingly). A team grant reaches a guest team member only if it is a record grant.
- Guests see no workspace directory, all-brands aggregation, brand lists, parents, children, siblings, or relationships beyond what is explicitly shared (IA-05, IA-47).
- The shared record shows its **owning brand name and icon** (UXD-06), never other brands.
- The guest level is the share level: `read` (view), `comment`, or `edit`. Guests can never `manage`, share onward, move, archive, trash, restore, export, or configure. They also cannot use AI, agents, automations, or tokens (matrix).
- Pickers show only people who participate in records the guest can read (IA-47).
- Guests never see Trash ([11](11-trash-archive-departure.md)), notifications about unshared records, or search results outside their shares.

## 6.2 Read-only role

`read_only` is an internal membership whose effective level is **capped at view** everywhere. It cannot comment, react, review, log time, edit, export (deny by default), or execute. Read-only AI questions are allowed only when the `read_only_ai` policy is on, and proposals can never be applied. It sees the workspace directory and brands it has grants in, like a member.

## 6.3 Share levels

| Share level | Grantee may |
|---|---|
| `read` (default) | View the record's own fields (field policy applies), its own comments and its own attachments; follow; download clean files |
| `comment` | + comment, reply, react, mention participants, act as a designated reviewer |
| `edit` | + update fields, upload attachments, log own time (guests). Never: share, move, archive, trash, restore, delete, configure. |

The level is capped by the **sharer's own level** on the record and by the grantee's role cap (read-only stays view).

## 6.4 Share lifecycle

| Step | Rule |
|---|---|
| Create | Requires `record.share` (manage on the record). Cross-brand and guest shares also follow `sharing.policy` (cross-brand allowed, guest invitations allowed, maximum expiry). A share to an email that is not a member creates a guest invitation (`membership.invite_guest`, policy-gated for members). |
| Children | The sharer may select specific contained records of shareable types. **Each selected record gets its own grant row** in the same share group, validated as a current containment descendant at share time. Children created later are never included (approved decision). A project share covers the project record only; its phases, milestones, tasks, descendants, dependencies, and activity are never implied. |
| Recipient validation | A membership recipient must be an active membership in this workspace. A brand-context recipient must be a brand in this workspace. A team recipient must be a team in this workspace. Email recipients are bound to the invited account on acceptance. |
| Exposure preview | Before creation, the sharer sees exactly what becomes visible: the record, its comments and attachments, and selected children ([13](13-permission-changes-and-revocation.md)). |
| Expiry | Optional `expires_at`, capped by the workspace maximum if set. Expiry is evaluated at query time (AT-034). |
| Revocation | By the sharer or anyone with manage on the record. It takes effect on the next check everywhere (I-12): next read, search, notification render, SSE event, export, AI retrieval. |
| Onward sharing | Prohibited. `record.share` evaluates only **ownership-derived** access (scope grants and implicit role access), never share-derived access (AT-050). |
| Shareable types | One registry lists the record types that may be shared and the levels each enforces. In Phase 2A, `project` is shareable at read, comment, and edit (the API calls read `view`); Phase 2B adds `task` at the same levels. Phases, milestones, decisions, updates, scope items, and every unregistered type are not shareable, even when a `core.record` exists ([AZ-21](15-decisions.md#az-21), AT-116). |
| Project share boundary | A project share shows the project, its criteria and scope items, and only the latest verified update's content and ID. Phases, milestones, decisions, dependencies, children, recurrence, templates, collaborators, history, and counts stay hidden; their endpoints return `not_found` to a share-only reader ([AZ-21](15-decisions.md#az-21)). |
| Task share boundary | A task share shows the task, its checklist, its own criteria items, and its brand marker. The parent, children, project, inherited criteria, relationships, links to unreadable records, history, and assignees' directory data stay hidden; their endpoints return `not_found` to a share-only reader ([AZ-22](15-decisions.md#az-22)). |
| Refusals | A caller who cannot read the target gets `not_found` (AT-115). A caller who can read it but lacks `record.share`, or targets an unshareable type, gets `forbidden` (AT-050, AT-116). Received share authority never satisfies `record.share`. |
| Audit | `grant.created/changed/revoked/expired` audit and security events, plus a notification to the recipient (NTF-007). |

## 6.5 Behavior on shared records

| Surface | Rule |
|---|---|
| Attachments | The record's own attachments are included. Each download request is authorized before receiving a short-lived signed URL. Revocation blocks new URLs immediately; an already issued object-storage URL may remain usable until its short expiry. Sensitive brands may later require proxied streaming for per-request revocation (AT-014). |
| Comments | Included at every level. Comments that mention unreadable records render the neutral "Restricted item" token (UXD-09). |
| Mentions by the grantee | Only of participants and records the grantee can read |
| Relationships | Only those whose other endpoint the grantee can read. Otherwise omitted, including derived conditions (UXD-28). |
| Search | Shared records are searchable by the grantee. Snippets come only from readable fields and parts ([08](08-search-reporting-notifications-caches.md)). |
| Notifications | Only about the shared record and its readable fields. The sensitive brand minimal-content mode applies (UXD-10). |
| Export | Guests cannot export. Members with a share and the export capability may export the shared record's readable fields. |
| AI | The grantee's AI context may include the shared record only for internal users who have AI permission. Guests have no AI. |

## 6.6 When the shared record changes

| Event | Effect on the share |
|---|---|
| Moves within the brand | The grant is unchanged. Breadcrumbs show only readable containers. |
| Moves to another brand (`record.move_brand`) | The grant row stays and `source_brand_id` updates. The recipient now sees the new brand marker. The move confirmation lists active shares so the mover can revoke them (AT-079). |
| Archived | Remains readable at the share level (archive does not change authorization). Writes are blocked. |
| Trashed | Invisible to grantees. Guests never see Trash. |
| Restored | Visible again if the grant is still active and unexpired |
| Purged | Grant rows are deleted by the purge job. The record is not-found. |
| Source brand archived | Records are archived by cascade, and shares behave as for archive |
| Sharer leaves | Shares remain (they are workspace grants, not personal). They are listed for review in the departure workflow. |

## 6.7 Public (unauthenticated) links

- **Disabled by default** and not a launch capability. The `anonymous_public` principal is a reserved class with no allowed actions.
- Launch-safe behavior for "public or guest project views" (PRJ-028) is **authenticated guest** access to explicitly shared records.
- Enabling public links later requires OD-27 approval and a dedicated threat model covering:
  - link entropy and expiry;
  - revocation;
  - rate limiting;
  - search-engine exclusion;
  - content limited to explicitly listed records and fields;
  - no comments;
  - no relationship metadata;
  - no brand aggregation;
  - audit of access by link ID.

## 6.8 Permission-safe not-found

For any target the caller cannot read, the response is **identical** to a nonexistent target in every way:

- the same status code and error body shape;
- no echo of the target's type;
- the same headers and cache directives;
- the same timing envelope: perform the authorization query in both cases, and avoid early returns that skip work only for nonexistent IDs.

Further rules:

- Uniqueness and validation errors never mention hidden records: "This value is already in use" only where the caller could read the conflicting record, otherwise a generic validation error (AT-025).
- Breadcrumbs, page titles, file names, email subjects, and URLs contain no unauthorized names (IA-44).
- **`FORBIDDEN` is returned only for readable targets** (ST-42). It is the only signal that an action is unavailable, and it reveals nothing new (AT-076).
- "Request access" from not-available pages is not offered (UXD-13). The UXD-13 alternative remains rejected by this threat model unless the product owner accepts the disclosure ("a record in this brand exists").
