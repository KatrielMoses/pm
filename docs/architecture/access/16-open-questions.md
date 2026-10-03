# 16. Contradictions, proposed amendments, and open questions

## 16.1 Contradictions and narrow amendments to accepted contracts

<a id="ac-01"></a>
### AC-01: "At most once" external effects versus the approved delivery decision — resolved
- **Status:** resolved: applied to 0A lifecycle §8 rule 2, 0B ADR-08 and 0B §9.6 (verified in Phase 0 integration). The text below is kept as history.
- **Conflict:** `ROADMAP_CHECKLIST.md` (Phase 0B acceptance) records that external delivery is "at-least-once internally and provider-dependent deduplication externally". These passages still promise at-most-once external effects:
  - 0A [lifecycle-and-states §8](../../product/lifecycle-and-states.md#8-retries-reruns-and-idempotency) rule 2 ("executed **at most once** per logical operation");
  - 0B [ADR-08](../data/12-decisions.md#adr-08) consequences ("at-most-once external effects");
  - 0B [09 §9.6](../data/09-concurrency-consistency.md#96-idempotency-logical-operations-and-attempts).

  Outbound webhooks retry with backoff (INT-014), which is at least once by definition.
- **Proposed amendment:**
  - "Each external effect is attempted under a stable effect key and event ID. Automatic retries are at least once, and the receiver or provider deduplicates by that key where it supports it."
  - "Effects whose outcome is unknown and whose destination cannot deduplicate are not retried automatically. They wait for human confirmation (0B `unknown` state)."
  - "The product never claims exactly-once external delivery."
- **Authorization impact:** none. Every delivery attempt is authorized at delivery time.

<a id="ac-02"></a>
### AC-02: Trash visibility in 0E ST-46 — resolved
- **Status:** resolved: applied to 0E ST-46 (verified in Phase 0 integration). The text below is kept as history.
- **Conflict:** [ST-46](../../ux/06-interaction-states.md#st-46) says Trash is "visible only to users who could access the record before deletion". The 0C brief prescribes current effective permission, with guests excluded.
- **Proposed amendment:** "Visible to users whose current access to the record's scope would allow editing it, and to Trash managers within their authorized scopes. Guests never see Trash." UX layout is unchanged.

<a id="ac-03"></a>
### AC-03: Additive refinements to the 0B data model required by this model — resolved
- **Status:** resolved: applied to the 0B model and prose in Phase 0 integration; the integration validator checks every listed addition. The text below is kept as history.
These are **not** contradictions. They are narrow additions or refinements for the 0B owner to apply:

| Change | Reason |
|---|---|
| `access.record_grant`: one row per record, with `share_group_id` and `grantee_key`; drop `include_children` and `selected_child_ids` | AZ-05 |
| New `access.field_policy` (record type, scope, field, read/edit/guest/index settings) | [07](07-field-secret-derived-data.md) |
| New `access.permission_epoch` (workspace, principal, agent class) | [13 §13.5](13-permission-changes-and-revocation.md#135-permission-epochs-and-cache-invalidation) |
| New `access.service_principal` (accountable owner, grants, state) referenced by service tokens | [09 §9.6](09-execution-delegation.md#96-api-tokens-and-oauth-clients) |
| New `access.support_access_grant` (scope, level, expiry, granted by) | [02 §2.5](02-principals-and-execution-identity.md#25-support-access-and-impersonation) |
| `work.project.access_mode`, `allow_record_shares`; `knowledge.document.access_mode` | DQ-02 resolution |
| `access.workspace_policy` keys: `self_approval_mode`, `require_independent_for`, `members_invite_guests`, `limited_members_can_export`, `limited_members_tokens`, `limited_members_ai`, `limited_members_agents`, `read_only_ai`, `members_configure_agents`, `admins_manage_billing`, `comment_on_archived`, `workspace_records_default_level`, `share_max_expiry`, `token_max_lifetime` | Matrix `policy:` cells |
| `automation.automation.suspended_reason`; owner-authority suspension on connections, service principals, webhook subscriptions | [09](09-execution-delegation.md) |
| `execution.job` / `operation`: `effective_principal_type/id`, `initiating_membership_id`, `delegation_chain`, `epochs_at_enqueue` | [09 §9.7](09-execution-delegation.md#97-background-jobs) |
| `access.role_assignment`: `elevated boolean`, `reason`, `expires_at` for break-glass elevation | [04 §4.4](04-effective-permissions.md#44-restrictions-and-sensitive-scopes) |

<a id="ac-04"></a>
### AC-04: Guest grants in 0B §3.9 — resolved
- **Status:** resolved: applied to 0B §3.9 (verified in Phase 0 integration). The text below is kept as history.
- **Conflict:** [0B §3.9](../data/03-tenancy-brand-sharing.md#39-guests) says guests use "record grants and explicit project/record role assignments". The approved decision and this brief allow guests explicitly shared records only.
- **Proposed amendment:** "Guests use only record grants (shares). Project and brand role assignments are not available to guests."

<a id="ac-05"></a>
### AC-05: Administrator export of a departed member's personal data in 0A — resolved
- **Status:** resolved: applied to 0A deletion §3 and recorded in ROADMAP_CHECKLIST.md (verified in Phase 0 integration). The text below is kept as history.
- **Conflict:** [0A deletion §3](../../product/deletion-retention-history.md#3-brand-workspace-and-account-deletion) lets personal-scope data of a removed member be deleted "unless an admin exports it first". Personal records are owner-only ([04 §4.1](04-effective-permissions.md#41-scopes-and-where-grants-attach)), and administrators cannot read them.
- **Proposed amendment:** "Personal-scope data of a departed member is deleted after the recovery period. Any administrator export requires a distinct, audited capability that is not enabled until the product owner approves it on privacy grounds (AQ-07)."

<a id="ac-06"></a>
### AC-06: Dispatcher BYPASSRLS in 0B §10.4 — resolved
- **Status:** resolved: applied to 0B §10.4 and recorded in ROADMAP_CHECKLIST.md (verified in Phase 0 integration). The text below is kept as history.
- **Conflict:** [0B §10.4](../data/10-postgresql-guidance.md#104-row-level-security-defense-in-depth) allows "a dedicated role with narrowly scoped BYPASSRLS" for cross-workspace jobs. The 0C brief requires that ordinary roles cannot bypass RLS and that there is no wildcard tenant context.
- **Proposed amendment:** replace it with payload-free `SECURITY DEFINER` scheduling functions plus per-workspace processing ([12 §12.3–12.4](12-rls-and-application-policy.md#123-database-roles)).

## 16.2 Blockers for Phase 0D (platform contracts)

| ID | Question | Assumption here |
|---|---|---|
| <a id="aq-01"></a>AQ-01 | Error envelope for `not_found`, `forbidden`, `approval_required`, `step_up_required`, `suspended`, `unauthenticated`; the uniform not-found contract, including headers and timing | Shapes as in [generated/threats-and-tests.md](generated/threats-and-tests.md#response-shapes) |
| <a id="aq-02"></a>AQ-02 | Token and OAuth scope string vocabulary (action families × read/write × brand list); run-bound token format for external agents | Families follow matrix action prefixes |
| <a id="aq-03"></a>AQ-03 | Execution-context fields in job, operation, and webhook envelopes (effective principal, initiating human, delegation chain, epochs); per-destination field allow-list declaration | As in [02 §2.2](02-principals-and-execution-identity.md#22-the-execution-context) |
| <a id="aq-04"></a>AQ-04 | SSE subscription contract: subscribe scope, close-on-epoch-change semantics, reconnect | As in [08 §8.6](08-search-reporting-notifications-caches.md#86-sse-change-notices-and-live-updates-uxd-27) |
| <a id="aq-05"></a>AQ-05 | Step-up challenge protocol in API and UI (window length, error code, binding to action) | Session-bound, action-bound, human-only |

## 16.3 Deferred to the owning implementation phase

| ID | Question | Owner | Default |
|---|---|---|---|
| <a id="aq-06"></a>AQ-06 | Array-versus-temporary-table threshold for large grant sets; EXPLAIN benchmarks per principal shape | 1D / 2B | Arrays ≤ ~10k elements |
| <a id="aq-09"></a>AQ-09 | Which core fields are policy-controllable; field policy UI | 2C | Cost, budget, rate, and internal custom fields |
| <a id="aq-10"></a>AQ-10 | Default maximum token and share lifetimes | 6B / 1D | Workspace-configurable; conservative defaults |
| <a id="aq-11"></a>AQ-11 | Statistical thresholds for the not-found timing-uniformity tests | 11B | CI on a quiet runner |
| <a id="aq-17"></a>AQ-17 | Custom role editor and delegable capability allow-list | 10C | Base role minus capabilities |

## 16.4 Product-owner approval (legal, commercial, public promises)

| ID | Question | Related | Default until decided |
|---|---|---|---|
| <a id="aq-07"></a>AQ-07 | May administrators export a departed member's personal-scope data? | AC-05, OD-39 | No |
| <a id="aq-08"></a>AQ-08 | Platform break-glass access without customer consent (incident or legal), and its notification obligations | AZ-14 | Not available |
| <a id="aq-12"></a>AQ-12 | Public unauthenticated links | OD-27 | Disabled |
| <a id="aq-13"></a>AQ-13 | "Request access" alternative that reveals "a record in this brand exists" | UXD-13 | Not offered |
| <a id="aq-14"></a>AQ-14 | Whether members may invite guests by default, and whether guests consume seats | OD-44 | Off; seat rule commercial |
| <a id="aq-15"></a>AQ-15 | Whether administrators manage billing by default | OD-44 | Owner only |
| <a id="aq-16"></a>AQ-16 | Confirm the self-approval auto default and its labelling wording | OD-20 | As prescribed by the brief |
