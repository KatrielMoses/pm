# Authorization and policy model (Phase 0C)

Status: **proposed: developer complete, awaiting solutions-architect review.** Nothing here marks a roadmap item complete.

One server-side authorization model for every surface: UI, API, search, exports, notifications, reports, AI retrieval, agents, automations, integrations, webhooks, background jobs, and support/administration tools. It builds on the accepted 0A contracts ([`docs/product/`](../../product/README.md)), the 0E UX foundation ([`docs/ux/`](../../ux/README.md)), the 0B data architecture ([`docs/architecture/data/`](../data/README.md)), and the approved decisions in `ROADMAP_CHECKLIST.md`.

## Reading order

| # | Document | Brief section |
|---|---|---|
| 1 | [01-invariants-and-trust-boundaries.md](01-invariants-and-trust-boundaries.md) | Security model, invariants I-01…I-18, trust boundaries, failure modes |
| 2 | [02-principals-and-execution-identity.md](02-principals-and-execution-identity.md) | Principal types, the execution context, support access |
| 3 | [03-roles-actions-capabilities.md](03-roles-actions-capabilities.md) | Default roles, access levels, action vocabulary, custom roles |
| 4 | [04-effective-permissions.md](04-effective-permissions.md) | Scope hierarchy, restrictions, the algorithm, pseudocode, SQL predicates |
| 5 | [05-permission-matrix.md](05-permission-matrix.md) | How to read the matrix; non-delegable, entitlement, step-up, and second-approval rules |
| 6 | [06-guests-sharing-public-links.md](06-guests-sharing-public-links.md) | Guests, read-only, shares, public links, not-found behavior |
| 7 | [07-field-secret-derived-data.md](07-field-secret-derived-data.md) | Field policy, secrets, derived outputs |
| 8 | [08-search-reporting-notifications-caches.md](08-search-reporting-notifications-caches.md) | Query-time and delivery-time enforcement, cache rules |
| 9 | [09-execution-delegation.md](09-execution-delegation.md) | AI, agents, automations, integrations, tokens, jobs |
| 10 | [10-approvals-separation-of-duties.md](10-approvals-separation-of-duties.md) | Self-approval, independent approval, risk classification |
| 11 | [11-trash-archive-departure.md](11-trash-archive-departure.md) | Trash, archive, retention, departed users |
| 12 | [12-rls-and-application-policy.md](12-rls-and-application-policy.md) | PostgreSQL RLS, roles, pooling, workers |
| 13 | [13-permission-changes-and-revocation.md](13-permission-changes-and-revocation.md) | Preview, exposure warnings, revocation, epochs |
| 14 | [14-threat-model.md](14-threat-model.md) | Abuse cases and the verification approach |
| 15 | [15-decisions.md](15-decisions.md) | ADRs AZ-01…AZ-16 and explicit resolutions of 0B DQ-01…DQ-08 |
| 16 | [16-open-questions.md](16-open-questions.md) | Contradictions found, proposed 0B amendments, open questions |

## Machine-readable policy and generated references

| Artifact | Role |
|---|---|
| [policy/policy.json](policy/policy.json) | **Authoritative policy**: invariants, 17 principal types, 6 default roles, 4 access levels, 98 actions with per-role cells, risk and approval classes, 14 agent tool classes |
| [policy/threats.json](policy/threats.json) | 34 threats in 14 categories, 80 authorization tests with expected result, response shape, and surfaces that must stay silent |
| [generated/permission-matrix.md](generated/permission-matrix.md) | Rendered matrix (98 actions × 6 roles), with flags and action descriptions |
| [generated/principals-roles.md](generated/principals-roles.md) | Invariants, principals, roles, levels, risk and approval classes |
| [generated/threats-and-tests.md](generated/threats-and-tests.md) | Threat register and test matrix |
| [tools/accesspolicy.py](tools/accesspolicy.py) | Validator and renderer (Python 3.8+, standard library only) |

## Validation

```sh
python3 docs/architecture/access/tools/accesspolicy.py validate
python3 docs/architecture/data/tools/datamodel.py validate
python3 docs/product/tools/reqcat.py validate
```

`accesspolicy.py validate` checks:

- **Matrix completeness and cell syntax.**
- **Role rules:**
  - guests hold no implicit, manage, or administrative access, and receive grants only on records;
  - the read-only role is capped at view;
  - limited members have no implicit record access;
  - non-delegable actions are owner-only;
  - every R4 action requires step-up.
- **Grantable authority:** no role can assign a role that exceeds it on any action.
- **Agent tool classes:** R3/R4 classes require human approval.
- **Threat and test coverage:** every threat has a test, every required category is covered, and every hidden-data denial names the surfaces that must stay silent.
- **Cross-references:** requirement IDs, 0B entities, invariants, threats, tests, `OD-`/`UXD-`/`ADR-`/`DQ-`/`AZ-`/`AQ-`/`AC-` references, links and anchors. It also checks that 15-decisions.md resolves DQ-01…DQ-08 explicitly.
- **Generated files** are up to date.

## The model in one paragraph

Tenant isolation comes first and is structural (RLS backstop plus composite keys). Inside a workspace, a principal's **effective access level** on a record (`view` < `comment` < `edit` < `manage`) is the maximum of:

- implicit role access on non-sensitive brands (owner and administrator only);
- workspace, brand, and project **scope grants** that flow down containment until a **restricted** project or document stops them;
- explicit **record grants** (shares) on that exact record.

That maximum is then capped by the role's level cap (read-only: view; guest: the share level). Actions require a level **and** a role capability (the matrix) and pass lifecycle, entitlement, risk, and approval gates. Execution layers intersect this with their own explicit grants and can only shrink. Everything compiles to SQL predicates over `scope_key`, `project_id`, and record-grant semi-joins, so lists, counts, search, and aggregates are filtered **before** pagination.
