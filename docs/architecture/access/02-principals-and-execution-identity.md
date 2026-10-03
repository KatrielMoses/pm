# 2. Principals, actors, and execution identity

The full principal list (17 types, with the 0B entity that stores each) is in [generated/principals-roles.md](generated/principals-roles.md#principal-types).

## 2.1 Principal classes

| Class | Principals | Can hold grants? | Can act? |
|---|---|---|---|
| Human | `account` (identity only), `member`, `guest` | Memberships hold scope grants (not guests) and record grants | Yes |
| Grant holder | `team` | Yes (scope grants, record grants) | No: a team never acts |
| Delegated | `api_token_personal`, `oauth_client`, `ai_action`, `agent_run`, `tool_invocation` | Only narrowing scopes. Effective access = the delegator's **current** access ∩ the delegated scope. | Yes, as the delegator plus a recorded tool identity |
| Service | `service_principal`, `integration_connection`, `inbound_webhook`, `automation`, `agent_profile` | Explicit grants, bounded at configuration by the configurer's grantable authority and re-checked against the accountable owner's current authority | Yes, as itself, on behalf of its accountable owner |
| Platform | `support_operator`, `system_job` | No tenant grants. Support access grants are customer-issued, scoped, and time-boxed. | Only within the grant or the job kind's allow-list |
| Disabled | `anonymous_public` | — | Disabled by default (OD-27) |

**Accountable owner:** every service principal has an owning membership. When that membership loses authority or leaves, the service principal is **suspended** until an authorized person reassigns it ([11 §11.5](11-trash-archive-departure.md#115-departed-members)).

## 2.2 The execution context

Every request, job, run, and tool call carries an immutable execution context, built server-side only:

| Field | Meaning | Example: AI action | Example: agent tool call | Example: automation step |
|---|---|---|---|---|
| `workspace_id` | The single tenant context | W | W | W |
| `authenticated_principal` | Who presented credentials | session of Ana | agent run R (internal) or connector credential (external) | automation A (scheduler) |
| `initiating_human` | The human whose action started the chain, if any | Ana | Ana (assigner) | Owner O (configured A); the triggering user is recorded but grants nothing |
| `effective_principal` | Whose access is evaluated | Ana ∩ selected context | R: profile ∩ Ana ∩ assignment scope | A: declared scope ∩ O's current authority ∩ trigger scope |
| `delegation_chain` | Ordered list of narrowing steps | [Ana, ai_action] | [Ana, agent_profile P, run R, tool T] | [O, automation A, run X] |
| `tool_identity` | The tool, connector, or provider invoked | model provider | tool `code_change` | webhook destination |
| `delegated_scope` | Explicit scope narrowing | brands/projects/records chosen | run scope snapshot | declared brands/projects |
| `audit_actor` | What audit records (0B §7.1) | `actor_type=ai`, `on_behalf_of=Ana` | `actor_type=agent`, `actor_id=R`, `on_behalf_of=Ana` | `actor_type=automation`, `actor_id=A`, `on_behalf_of=O` |
| `epochs` | Permission epochs read at evaluation | workspace + principal epochs | re-read every tool call | re-read every run and step |
| `operation_id`, `attempt_id`, `correlation_id` | Execution identity (0B §7.6) | ✓ | ✓ | ✓ |

The context is never constructed from client-supplied fields (I-09). The workspace comes from the route or the token binding and is verified against the membership. A body field such as `brand_id` is treated as data to validate, never as an authority claim.

## 2.3 Human principals

- **Account:** an identity with no tenant rights. A request selects one membership (one workspace).
- **Member:** membership with a role from owner, administrator, member, limited member, or read-only ([03](03-roles-actions-capabilities.md)). Holds scope grants and record grants, directly or through teams.
- **Guest:** membership of kind guest. Holds **only record grants** (shares) at a share level ≤ edit. Has no scope grants, workspace directory, aggregation, trash, or onward sharing ([06](06-guests-sharing-public-links.md)).
- **Team:** a set of memberships (members, limited members, read-only, and guests). Grants to a team apply to each member, then pass through that member's role cap. A guest in a team receives only the team's **record grants**, never its scope grants.

## 2.4 Delegated and service principals (summary)

Detail is in [09](09-execution-delegation.md).

| Principal | Effective access |
|---|---|
| `api_token_personal` | Creator's current access ∩ token scopes (action families, brand list, read/write), until expiry or revocation |
| `service_principal` | Explicit scope grants and capabilities, bounded at creation by the creator's grantable authority, re-checked against the accountable owner's current authority, suspended if the owner leaves |
| `oauth_client` (MCP and external assistants) | Consenting user's current access ∩ consented scopes ∩ client registration scopes |
| `integration_connection` | Inbound: writes only into mapped brand/project scopes. Outbound: records in mapped scope ∩ connection owner's current read access ∩ destination field allow-list. |
| `inbound_webhook` | One configured intake action into one configured scope; no read |
| `automation` | Declared scope and actions ∩ accountable owner's current authority ∩ trigger record scope |
| `ai_action` | Initiating human's current access ∩ selected context |
| `agent_profile` → `agent_run` → `tool_invocation` | Profile grants ∩ assigner's access ∩ assignment scope (snapshot at start), re-evaluated at every tool call; tool class grant and approval class per call |
| `system_job` | Durable workspace + effective principal. System-only jobs hold only their kind's capability allow-list. |

## 2.5 Support access and impersonation

- **No impersonation.** Platform support never authenticates as a customer user and never acts with a customer's identity. Impersonation is **disabled** and there is no feature flag to enable it at launch.
- **Default access: none.** A `support_operator` has no tenant access.
- **Customer-issued support access grant** (`support_access.grant` action, owner or administrator with step-up):
  - scoped to the workspace (optionally to brands);
  - **read-only by default**;
  - time-boxed with an explicit expiry;
  - revocable at any time.
  Every support read and action is evaluated as principal `support_operator`, intersected with the grant, and audited with `actor_type = system`, `actor_id = support operator`. The audit is visible to the customer's admins. A support grant never includes sensitive brands unless they are explicitly listed, and never includes personal records or secrets.
- **Break-glass** (security incident or legal obligation without customer consent) is not a launch capability. If adopted, it requires two platform approvers, a recorded reason, the narrowest scope, automatic expiry, and customer notification unless legally prohibited (AQ-08).
- Support tooling uses its own identity provider and roles. It cannot read tenant tables without going through the same execution context (RLS-scoped per workspace, [12](12-rls-and-application-policy.md)).
