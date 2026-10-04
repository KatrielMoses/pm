# ADR-0011: Membership, roles, invitations, teams, sharing, and ownership (Phase 1D)

Status: **implemented; acceptance pending CI.** Engineering detail: [tenancy.md](../tenancy.md#phase-1d-collaboration).
Extends ADR-0010 (1C). Accepted sources:
- 0C: AZ-19, T-37/T-38, AT-095…107;
- 0B: membership, team, team_member, invitation, ownership_transfer, workspace_policy, share_group, record_grant;
- 0D: PL-20.

## Context

1D turns the single-owner foundation into collaboration on the canonical 1C tables. It adds members and guests, built-in roles, teams, brand grants, explicit record shares, permission previews, ownership transfer, and immediate revocation. 1C's nine-item handoff (ADR-0010) is implemented as described below. No parallel membership, role, or grant system was introduced, and there is no "is admin" bypass.

## Decisions

| # | Topic | Decision |
|---|---|---|
| E1 | Sources first | Registered before use: 0C `invitation.accept` (account command), `ownership.accept`, and `membership.leave` (AZ-19); the `workspace_policy` field map (type, safe default, governing action); threats T-37/T-38. 0B columns for membership, team, invitation (`inv`), and ownership transfer (`otr`). 0D prefixes, five events, five metrics, and three parameters (PL-20). The Phase 0 validator, generated contracts, and drift tests cover them all. |
| E2 | Migration 0019 | Membership transition guard and departure metadata. Teams as `core.record` extensions. Team principals on role assignments. Deferred **role-shape** constraint: guests hold no assignments or teams; active/suspended members hold exactly one workspace role; removed members hold no authority. `access.workspace_policy`, `tenancy.invitation` (guarded state machine, one pending per email), `access.share_group` / `access.record_grant` (0B indexes plus FK-covering indexes; terms immutable; active → revoked/expired terminal), `tenancy.ownership_transfer` (one pending per workspace). The `core.record` owner FK (deferred from 1F). The `invitation_acceptance` token purpose and the `workspace_invitation` mail template. Column-scoped UPDATE grants only; memberships are never deleted. **Re-run the role bootstrap** (explicit `TEMPORARY` for the application roles). |
| E3 | Compiler | `policy.ts` implements 0C §4.2–§4.3 for the scopes that exist: role cells (`implicit`, `deny`, `own`, `policy:x`, `grant:<level>`); implicit owner/admin manage on non-sensitive brands; direct and team brand grants (max wins); exact record grants; the role cap last (read-only → view, guest → share level ≤ edit); archived reads (comment by policy); workspace-scoped records at the workspace level (never flowing into brands). `decideRecord` evaluates onward sharing from ownership-derived access only (AT-050). |
| E4 | SQL predicate | `visibility.ts` compiles one predicate (workspace branch, brand set, record-grant semi-join over subject keys) applied before ordering, pagination, and counts, and identical for single reads. Above `PRINCIPAL_CONTEXT_ARRAY_MAX`, read-write transactions use transaction-scoped temporary tables (0C §4.5). Read-only transactions, where PostgreSQL forbids temporary tables, use an equivalent `unnest` row-set semi-join. All three strategies are tested to give identical results. |
| E5 | Invitations | Inviter rules from 0C §3.1. Normalized email with one pending invitation per email. "Already a member" and "already invited" are told only to inviters, who can see the directory anyway; unknown emails behave like any other. The token is hashed in `identity.verification_token`. The raw token is sealed for the durable mail job and destroyed after send. Invitation row, token, mail, and audit commit in one workspace transaction. Mail carries no workspace or inviter name. Acceptance is an account command: verified, active (re-read) account, email equal to the invitation, single-use token, rate limit. The inviter's authority is re-checked at acceptance. A same-account repeat returns the original result; anyone else gets `not_found`. Guests: at least one record share and never role assignments. |
| E6 | Preview engine | `preview.ts` explains a member's effective access (role, cap, implicit, direct and team sources with expiry, record shares) only within brands the previewer may inspect. Proposed changes are compared before and after through the same compiler. Brand changes, counts by type, capabilities, and affected people are reported; nothing hidden is enumerated. Applying requires a short-lived HMAC fingerprint over viewer, change, epochs, and diff, recomputed under row locks. A mismatch is `conflict` (`preview_stale`). |
| E7 | Changes | Role, suspend, remove, brand grant/revoke, and team add/remove all go through preview → apply. `membership.manage` changes need step-up. Grantable authority applies throughout: owners are managed only by owners; nobody grants a role or level they lack; adding to a team needs authority over every scope the team holds. A sensitive brand always keeps at least one explicit manager. |
| E8 | Departure | Removal and leaving run in one transaction:<br>• registered ownership hooks (record owners reassigned to a chosen active member; the inviter's pending invitations and tokens revoked; pending transfers cancelled) — removal fails with an actionable plan when an assignee is required and missing;<br>• assignments and team memberships deleted;<br>• grants held solely by the membership revoked;<br>• membership `removed` with a reason;<br>• every session of the account revoked (0C §11.5);<br>• queued and leased jobs acting as the member cancelled;<br>• epochs bumped;<br>• audit, security, and outbox events written.<br>Suspension keeps sessions (the account may belong to other workspaces) and fails on the next check. `principalFreshness` lets deferred consumers stop (`revoked`) or rebuild (`changed`). |
| E9 | Ownership transfer | `ownership.transfer` (owner, step-up) creates a pending transfer with an expiry. `ownership.accept` (the recipient's own, step-up) adds the owner role and optionally demotes the previous owner to administrator. The deferred last-owner trigger guarantees at least one owner at every commit, including concurrent demotions. |
| E10 | Workspace policy | A missing row means the generated safe defaults. Each field's governing action is enforced, and `admins_manage_billing` is owner-only. Loosening requires `confirm_exposure`. Sharing fields need step-up. `public_links_enabled` is fixed false (OD-27). |
| E11 | Shares | One share group per action, with one fixed grant row per selected record (source plus explicitly listed current children, re-validated). There are no descendants or future records. Cross-brand shares follow policy. Expiry is capped by `share_max_expiry`. Revocation is immediate (query-time evaluation). |
| E12 | Lazy expiry | Expiry is evaluated at use: tokens, invitations (shown as expired; closed before a new invitation to the same email), transfers (closed when read), and shares (query predicate). There is no background sweeper in 1D. |

## Deviations and limitations

| # | Item | Disposition requested |
|---|---|---|
| F1 | Unauthenticated invitation landing shows no workspace detail until the invited email signs in | Privacy-preserving choice; accept |
| F2 | Suspension does not revoke account sessions (removal does) | 0C §11.5 covers removal; accept |
| F3 | Policy fields beyond sharing/guest toggles are API-settable but have minimal UI (the four relevant toggles) | Later admin UI (1E/10A) |
| F4 | Project, document, field, and connection scopes: schema and compiler extension points only | Owning phases (2B, 4C, 6A) |
| F5 | Seat/plan limits: `SeatPort` hook, default unlimited (OD-44 unset) | Billing phase |
| F6 | Notifications: outbox events only; no notification product | 4B |
| F7 | Expired rows flip lazily (E12) | Accept, or add a sweeper later |
| F8 | Already-sent mail cannot be recalled (recorded in audit, not hidden) | 0C §13.3 |

## Consequences

Authority comes only from canonical rows: membership state, one workspace role, scope assignments (direct or through active teams), and exact record grants. The isolation, concurrency, preview-equals-enforcement, and EXPLAIN suites prove it across three workspaces and all six roles.
