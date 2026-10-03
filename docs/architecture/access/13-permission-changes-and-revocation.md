# 13. Permission changes, exposure preview, and revocation

## 13.1 Effective-permission preview (PERM-011)

- `access.preview` (owner, administrator, or managers of a scope) shows, for one membership, team, or service principal:
  - role and caps;
  - implicit access;
  - scope grants with their source (direct or team), restrictions, and record grants;
  - field policies;
  - execution capabilities;
  - the resulting level per brand and project.
- **The preview is limited to scopes the previewer manages.** Outside them, nothing is shown: no counts and no "has other access" hints. The previewer must not learn about records, brands, or projects they cannot see (AZ-10).
- **"Why can X see this?"** is answered for a record the previewer can read. The answer is the winning path, e.g. "Brand grant (edit) on API Access via team Engineering", or "Share by Ana, read, expires 1 Nov". Ancestors or siblings the previewer cannot read are omitted from the explanation.

## 13.2 Exposure warnings before changes (PERM-012)

Every change that can increase access computes the **delta** before commit and requires confirmation:

| Change | Delta shown (only within scopes the actor manages) |
|---|---|
| Role change (e.g., member → administrator) | Brands that gain implicit access; capabilities gained |
| Scope grant / team grant | Count of records by type newly readable or editable, with sample titles |
| Adding a person to a team | Every scope the team holds grants in. **The actor must have grantable authority over all of them**, otherwise the change is rejected (AT-039). |
| Removing a restriction (project or document unrestricted; brand no longer sensitive) | Principals who gain access, with counts |
| Field policy loosening | Fields becoming visible, and to whom |
| Share | The record, its comments and attachments, and selected children ([06 §6.4](06-guests-sharing-public-links.md#64-share-lifecycle)) |
| Agent profile or automation scope widening | Scopes and tool classes added |

Changes that only reduce access (revocations, restrictions) need confirmation only where the 0E tiers require it.

## 13.3 Revocation

| What is revoked | Immediate effect (next check) | In-flight work |
|---|---|---|
| Share | Reads, search, AI, exports, notifications, SSE | Queued notifications are re-authorized at send. External content already sent is unrecallable and recorded. |
| Scope grant, role downgrade, team removal | Same | Agent runs and jobs recheck at the next step |
| Membership removal / departure | Sessions, tokens, and consents revoked; streams closed | See [11 §11.5](11-trash-archive-departure.md#115-departed-members) |
| Session (`sessions.manage_*`) | The next request is unauthenticated (AT-038) | The open stream is closed |
| API token / OAuth consent | The next call is unauthenticated (AT-036) | Long-running API-initiated operations recheck the principal at each step |
| Connection disconnect | No further sync or outbound disclosure | Pending external effects in `pending` state are cancelled. `sent` and `unknown` remain as recorded. |
| Agent run cancel / emergency stop | No new tool calls | Effects in `pending` are cancelled. Effects already sent are listed in the cancellation report (ST-63). |
| Queued jobs | Re-evaluated at execution | Cancelled if the principal is invalid |

**Limitation (recorded, not hidden):** content already delivered externally (emails, webhooks, provider writes, exports a user downloaded, AI provider requests) cannot be recalled. The product records what was sent, when, and to whom, and shows it in audit.

## 13.4 Audit of permission changes

Every material change emits an immutable audit event **and** a security event (I-17):

- role assignment or removal;
- team membership;
- grant and share create, change, or revoke;
- restriction change;
- field policy change;
- elevation;
- support access grant and every support action;
- token and consent create or revoke;
- policy setting change;
- ownership transfer;
- denied R3/R4 attempts.

Each event records the actor, the target principal, the scope, old and new values, and the exposure delta summary.

## 13.5 Permission epochs and cache invalidation

Proposed `access.permission_epoch` (AC-03):

| Epoch | Bumped when | Used by |
|---|---|---|
| `workspace_epoch` | Any change to roles, scope grants, restrictions, field policies, team grants, workspace policy, brand sensitivity, membership state | Workspace-level cached sets (restricted projects); every principal's context |
| `principal_epoch[principal]` | Changes affecting one principal (their role, their team membership, their record grants, session or token revocation) | That principal's visibility context, SSE subscriptions, agent runs and jobs acting as them |
| `agent_class_epoch` | Emergency stop and resume | All agent runs |

- Epoch bumps happen **in the same transaction** as the change. The read path fetches the current epochs with one indexed lookup per request, step, or tool call, and compares them with the cached context key. Any mismatch rebuilds the context.
- An epoch never decreases.
- Record grants are always evaluated in the query (semi-join), so share changes take effect even without an epoch bump. The bump additionally invalidates SSE subscriptions and the "shared with me" caches.
