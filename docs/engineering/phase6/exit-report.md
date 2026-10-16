# Phase 6 integration review and exit gate (P6-IR1)

Status: **developer review complete; awaiting architect acceptance.** Nothing is merged. ADR-0032 to
ADR-0037 stay proposed. Roadmap acceptance is the architect's decision.

Candidate: the accepted 6D head `6b4bb78` (which contains 6E `5917b9e`, 6C `d5e5eb1`, 6B `17ccc67`,
and 6A `9eeee12`), plus the review commits on `codex/phase-6-integration-review` (draft PR #35,
base `codex/phase-6d-csv-portability`). Topology and merge order: [topology.md](topology.md).
The final current-head CI run, its shard results, the PostgreSQL digest, scanner results, and the
image facts are in the PR's acceptance comment and the completion report, not in this file. This
file would go stale with every corrective commit.

## Exit gate

| Evidence | Where |
|---|---|
| A founder connects Google Calendar through the real OAuth redirect, chooses and maps calendars, synchronizes, sees events in Today and the calendar view, puts a block on the calendar, has it moved at the provider (its due date and deadline do not move), settles a conflict, then manages API tokens, webhooks, MCP consent, and a CSV import, export, and rollback. A member sees none of it. Runs on desktop, tablet, and mobile, with a keyboard-only stretch and axe at key states. It covers 320 px, 200% zoom (half width), forced colours, reduced motion, offline and recovery, and disconnect-and-remove. | `e2e/phase6-exit-journey.spec.ts` (AT-328) |
| Provider-transport failure, kept separate and labeled: an injected 503 shows as degraded with plain words, then recovers. | `e2e/phase6-exit-journey.spec.ts` (AT-329) |
| The real Google adapter against a deterministic HTTP contract fixture: OAuth with PKCE and a bound state; multiple calendars; scope narrowing; pagination; incremental checkpoints; 410 recovery; refresh and reauthorization; outage backoff and Retry-After; DST recurrence with EXDATE, moved, cancelled, all-day, and provider-expanded occurrences; two-way links without loops or date changes; conflicts; owner-only Today and capacity; revoke while queued; honest unconfigured and test-double states. | `packages/work/test/integration/calendar-live.test.ts` (AT-317–AT-327) |
| The HTTP surface: sync and conflict resolution envelopes, the OAuth callback (anonymous, tampered, foreign, denied, and success outcomes), calendar reads, and bounded windows. | `apps/api/test/integration/integrations-api.test.ts` |
| Cross-boundary matrix across three workspaces and every role (see below). | `packages/work/test/integration/phase6-matrix.test.ts` (AT-330–AT-344) |
| Migrations walked through every accepted boundary 0009–0051. Each step matches the one-shot catalog, reverses to the prior boundary's exact catalog, and re-applies. 0045–0050 are unchanged. | `packages/db/test/integration/migrations.test.ts` |
| Requirement closure per subphase plus the Phase 6 aggregate. Each owned requirement is closed exactly once by its owner (derived from the catalog). Deferrals have valid owners. Recorded boundaries are kept. The 6C corrections hold. Identifiers have one owner each. All Phase 0–6E validators pass. Runs in verify gate 2. | `docs/engineering/phase6/closure-6*.json`, `docs/engineering/tools/phase6.py` |

## Requirement closure

Totals are derived from `docs/product/requirements/catalog.json` by `phase6.py`, not hard-coded: 56 owned
requirements across 6A–6E, each closed exactly once, and 35 contributions. 6C's seven owned
requirements (INT-026, CAL-006, CAL-007, CAL-008, CAL-012, CAL-014, CAL-015) and its eleven
contributions now cite running code and regression tests.

### Corrections to earlier closures

- **6C:** the first closure marked CAL-012 implemented on a reserved `linked_work_block_id` column, CAL-008 on a `busy` column, CAL-005 on a stored zone, CAL-013 on ADR prose, and PLAN-004 and VIEW-003 on placeholder text. None of that was behavior. Each now has behavior and tests. ADR-0034's D2, D5, and D6 are corrected in place.
- **6A:** the closure is normalized to the standard schema with evidence and its eight contributions. It no longer lists INT-010 (6B) or INT-026 (6C) as its own.
- **Identifiers:** 6B's duplicate `pl-42` is now PL-43. The 6C anchors its migration and ADR already claimed (ADR-42, AZ-42) are written; its contracts are PL-44. AT-315 and AT-316 are registered. Applied migration headers keep their original text (ADR-0037 identifier table).

### Recorded boundaries (kept as recorded; nothing invented)

| Requirement | Boundary | Owner or decision |
|---|---|---|
| DATA-010 | Named vendor import adapters remain incremental after launch; generic CSV is the launch path | OD-33 (open) |
| DATA-013 | AI, agent, and automation history exports | 7A, 8A, 8B |
| AUD-009 | Commercial audit-export entitlement supply; production defaults to denied | 10A |
| CAP-006 | Email capture stays **unresolved** under OD-29 ("Still open"); owner 2E. 6A only lists `email_inbound` as not configured. No address, inbound mail, or sender verification exists, and no approval, provider, or new deferral is invented here. | OD-29 |

## Authorization, isolation, lifecycle, and concurrency matrix

Fixtures: three workspaces. Workspace A has an owner, an administrator, a member with a brand
grant, a brand manager, read-only and limited members, a share-only member, and a guest. It has
Harbor (a normal brand), Vault (a sensitive brand), and a restricted project. Workspaces B and C
belong to other owners; one person is a member of two workspaces.

| Check | Result |
|---|---|
| Connection ownership and provider scopes never widen record permissions. Members who can see a connection get `forbidden` on test, sync, and disconnect. A hidden connection gets the same opaque `not_found` as an unknown identifier. | pass (AT-330) |
| Hidden, foreign, and unknown identifiers fail identically across connections, calendars, conflicts, subscriptions, deliveries, tokens, MCP clients, and import jobs. No titles, foreign IDs, tokens, or secrets appear in errors. | pass (AT-331) |
| API-token scopes and MCP consent never widen access. Authorization is re-checked on every request and immediately after a grant is revoked. | pass (AT-332, AT-333) |
| The public API and MCP run the same task command with provenance (`api`, `mcp`). An idempotency replay applies once. A destructive MCP tool requires confirmation. | pass (AT-334) |
| Departure and revocation stop tokens, consent, webhooks, connections, and queued sync. | pass (AT-335) |
| Webhooks: duplicate and out-of-order events and overlapping sweeps deliver at least once with no duplicate rows, with bounded retry, dead-letter, and admin replay. No response bodies are stored. Inbound webhooks refuse a bad signature, a stale timestamp, and a replayed event ID. | pass (AT-336, AT-337) |
| Portability: exports never reveal Vault or restricted work, and formulas are neutralized. Imports bind to their preview; rollback of a stale version is refused; cross-workspace references are refused; error reports stay private. | pass (AT-338, AT-339) |
| Audit export needs the entitlement and fresh verification, and never rides a record export. | pass (AT-340) |
| Calendars: a member's events, conflicts, and busy time never reach an administrator; departure ends the connection's authority. | pass (AT-341, AT-324) |
| Lifecycle: archive and restore never resurrect revoked authority. Purge removes calendar rows, sync rows, and the vault secret. | pass (AT-342) |
| A person in two workspaces keeps each workspace's delegation apart. | pass (AT-343) |
| Logs, traces, audit, and MCP provenance never carry a token, client secret, webhook secret, or provider access or refresh token. | pass (AT-344) |

## Integration fixes made in this review

- **MCP provenance:** migration 0049 added `mcp` to the audit and capture source kinds but not to `core.record`, so every MCP-created record failed. 0051 adds it; its rollback relabels such records `api`.
- **6A HTTP:** the sync and conflict-resolve routes put resource data in a non-resource envelope, which raised a 500. Both are fixed, with an HTTP regression test. Also in 6A: a retried delivery now records one run with a growing attempt count (it used to break the run's unique key), and `#replaceSecret` keeps the loaded row's vault reference current.
- **6B:**
  - Brand-scoped webhook subscriptions were visible to, and replayable by, administrators without that brand. They are now as unknown as the brand.
  - Projecting the same internal event twice created duplicate deliveries. The public event ID is now derived from the internal one, and the existing uniqueness holds.
  - Overlapping sweeps re-sent claimed deliveries. They now use `FOR UPDATE SKIP LOCKED`.
- **6E:** listing OAuth clients failed for members (an ambiguous column), and `pm.tasks.complete` always failed (it passed its confirmation flag into the command).
- **6D:** a malformed import job ID raised a raw database error. It now returns `not_found`.
- **Lifecycle:** purging a calendar connection failed on the new calendar tables. It now removes them.
- **Policies:** the 0047 and 0050 tenant policies now use `exec.current_workspace_id()` with `WITH CHECK`.
- **Web:**
  - The API tokens page read the wrong envelope level and failed on load. It now reads the right level and gains revoke and webhook settings.
  - Placeholder "arrives in 6C" copy is replaced where behavior now exists.

## Configuration and honesty

- **Google Calendar** is configured only when `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, and `GOOGLE_CALENDAR_REDIRECT_URI` are all set. Deployed environments accept https endpoints only. Otherwise the connection catalog says it is not configured, and readiness is unaffected.
- **The test double** (`GOOGLE_CALENDAR_LOOPBACK_ENABLED`) reports `provider_mode: test_double` and refuses to publish blocks.
- **The provider contract fixture** is a test-support HTTP server for automated acceptance. It is never configured in a deployed environment, and its results are never presented as live synchronization.

## Not covered by automation (manual or live acceptance)

- A real Google account, consent screen, and live API. See [manual-smoke.md](manual-smoke.md) §1. The automated evidence proves the adapter against the documented protocol through a deterministic fixture, not against Google's servers.
- Screen-reader announcements and real-device ergonomics (manual-smoke §3). Axe, keyboard-only use, reflow, forced colours, and reduced motion are automated.

## Residual risks and limitations

- Calendar event titles are stored as plain text inside workspace RLS. The 0B model's "encrypted at rest" target needs a secret store or KMS, which is not approved (DQ-28).
- Sync runs call the provider inside the workspace transaction, bounded by `GOOGLE_CALENDAR_TIMEOUT_MS` and `CALENDAR_SYNC_PAGES_MAX`. A slow provider lengthens that transaction, up to those bounds.
- Recurring rules outside the shared engine's subset (ordinal BYDAY, BYSETPOS, RDATE, and similar) depend on the provider's instance expansion inside the sync horizon.
- All-day events use the calendar's own zone for day bounds.
- Webhook subscriptions still have no delete or disable command (6B scope as accepted). Replay does not check a delivery's state.
- Live Google credential testing and screen-reader acceptance remain manual, as recorded above.
