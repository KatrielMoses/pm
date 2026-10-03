# 14. Threat model and verification matrix

The 35 threats and 86 authorization tests are machine-readable in [policy/threats.json](policy/threats.json) and rendered in [generated/threats-and-tests.md](generated/threats-and-tests.md).

## 14.1 Coverage

| Required category (brief) | Threats | Example tests |
|---|---|---|
| Cross-workspace ID substitution | T-01, T-02 | AT-001…AT-004 |
| Cross-brand traversal: parents, children, dependencies, mentions, activity, notifications, files, exports, search, AI, reports, APIs | T-03…T-08, T-34 | AT-005…AT-020, AT-077, AT-079 |
| Hidden counts, snippets, timing, error differences | T-09…T-11, T-33 | AT-021…AT-027, AT-076, AT-078 |
| Restricted projects in visible brands | T-12, T-13 | AT-028…AT-032 |
| Revoked or expired shares, tokens, sessions | T-14, T-15 | AT-033…AT-038 |
| Team membership changes | T-16 | AT-039, AT-040 |
| Field-level leaks (formulas, conflicts, history, export, AI) | T-17 | AT-041…AT-045 |
| Background-job and cache staleness | T-18, T-19 | AT-046…AT-049 |
| Guest escalation and onward sharing | T-20, T-21 | AT-050…AT-056 |
| Agent and tool scope expansion, confused deputy | T-22…T-24 | AT-057…AT-062, AT-080 |
| Webhook and integration spoofing | T-25, T-26 | AT-063…AT-065, AT-017 |
| Support and admin misuse | T-27, T-28 | AT-066…AT-068 |
| Owner transfer and departed members | T-29, T-30 | AT-069…AT-072 |
| RLS context leakage | T-31, T-32 | AT-073…AT-075 |

## 14.2 Test record shape

Each test states:

- **principal** (a role or principal type);
- **setup/scope**;
- **action** (a matrix key);
- the **surface** under test;
- **expected** allow/deny;
- the **response shape** (`not_found`, `omitted`, `forbidden`, `redacted`, `conflict_filtered`, …);
- **must stay silent**: the secondary surfaces where nothing about the hidden data may appear.

The validator requires every hidden-data denial to list silent surfaces. The default silent set for hidden records is: search, snippets, AI context, export, in-app and email notifications, activity, counts and facets, SSE notices, webhook payloads, and error messages.

## 14.3 How the tests run (implementation guidance for 1C/1D/11B)

- **Fixtures:** a seeded multi-tenant fixture with two workspaces, three brands (one sensitive), a restricted project, teams, a guest with shares (including selected children), a read-only member, a limited member, agents, automations, a connection, and tokens. Each test applies its setup on top.
- **Surface probes:** for each silent surface the harness queries the surface for any trace of the hidden record's ID, public ID, title, and unique sentinel strings planted in hidden fields. Searching for the sentinel across responses, notifications, emails (captured), webhooks (captured), exports, AI context logs (test provider), and SSE streams catches indirect leaks.
- **Not-found uniformity:** for each `not_found` test, compare status, body, headers, and the latency distribution against a nonexistent ID (statistical threshold, run in CI on a quiet runner).
- **Property tests:** randomly generate grant graphs and check that SQL list results equal the per-record `effective_level ≥ view` results for every principal. This proves that the compiled predicate and the algorithm agree, with no post-filtering.
- **Matrix conformance:** every route and command declares its action key. A test asserts each declared key exists in the matrix and that each role's denial is enforced.
- **Regression gate:** the authorization suite is part of the Phase 1 exit gate and the 11B security verification (LA-015, LA-016, LA-022).

## 14.4 Residual risks accepted (pending review)

| Risk | Why accepted | Owner |
|---|---|---|
| A user's own notification row shows "You no longer have access to this item" (IA-53) | It reveals only that a notification the user already received concerned a record now unavailable | 0E / 4B |
| A readable record answers `FORBIDDEN` for disallowed actions (ST-42) | It reveals nothing beyond the readable record | — |
| External content already sent cannot be recalled | Inherent. It is recorded and visible in audit (I-12). | 4B, 6B, 8C |
| Mentions render a neutral "Restricted item" token | Approved OD-05 contract: the author's own text already discloses that a reference exists | 4A |
