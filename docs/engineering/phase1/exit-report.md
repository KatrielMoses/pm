# Phase 1 integration review and exit gate (P1-IR1)

Status: **developer review complete; awaiting product-owner acceptance.** This report is not
accepted until the product owner records P1-IR1. Nothing is merged.

Candidate: the Phase 1E head `5f636c8` (1A–1F, 0020 migrations), plus the narrow integration fixes
listed below on `phase-1-integration-review`.

## Exit gate

BUILD_ROADMAP Phase 1 exit gate: *a user can securely create a workspace with three isolated brands,
invite a scoped guest, switch contexts, and prove isolation with automated authorization tests.*

| Evidence | Where |
|---|---|
| Ten-step journey on real web/API/worker processes and PostgreSQL at desktop, tablet, and mobile widths, with axe at every major state (no sleeps, retries, skips, or longer timeouts) | `e2e/exit-journey.spec.ts` |
| Cross-surface isolation matrix: three workspaces, all six roles plus a guest, sensitive, archived, and trashed brands, forged identifiers, direct `app_rw`/`app_worker`, and access changes checked on the same pooled connection and by the worker's freshness check | `packages/tenancy/test/integration/phase1-matrix.test.ts` |
| Migrations stepped through every accepted subphase boundary (0009, 0012, 0016, 0018, 0019, 0020) match the one-shot catalog; each step reverses to the prior boundary's exact catalog and re-applies | `packages/db/test/integration/migrations.test.ts` |
| Machine-readable requirement closure and drift checks, run in verify gate 2 | `docs/engineering/phase1/closure.json`, `docs/engineering/tools/phase1.py` |

### Journey steps

1. Register, verify the email, and sign in. The credential is Argon2id.
2. Create a workspace. Deep links and API responses carry CSP, `nosniff`, `no-referrer`, and
   `DENY`.
3. Create three brands. One is marked sensitive (with step-up), one is archived and restored, and
   the favorite follows the brand.
4. Scope: one brand, several brands, and All. Each survives reload and Back/Forward.
5. Invite a member through the real mailed invitation.
6. Invite a guest with exactly one test-only fixture record. This is the only fixture: no product
   record type exists before Phase 2, and the 1D suites use the same fixture.
7. Both accept. The access review names exactly the brand that is then enforced. The guest sees
   one record and nothing else in the UI or the API.
8. Revoke, suspend, and remove:
   - a revoked invitation is unavailable;
   - a revoked brand grant disappears from favorites and Back history;
   - a suspended guest's next request fails;
   - a removed member's sessions end and their personal lists are erased.
9. Last-owner protection (UI and database), the append-only audit trail of every step, and
   navigation cleanup.
10. Sign out:
    - drafts and per-tab state are cleared;
    - the device key and appearance stay;
    - device-stored view state returns on the next sign-in.

## Requirement closure

`phase1.py` passes with 64 owned requirements and 39 contributions:

- 49 implemented;
- 15 foundations, each with deferral targets and an accepted source;
- 39 contributions with evidence.

WSB-008 is now owned by 2A, with 1D contributing (OD-04, decided). The validator also enforces the
architect's decisions: the hosting-dependent requirements stay foundations with exactly their
approved deferrals, and WSB-008's ownership stays 2A.

Every evidence citation is checked to exist.

Foundations and why each is accepted:

| Requirement | Deferred to | Accepted by | Open decision |
|---|---|---|---|
| SEC-001 in transit, SEC-002 at rest | 11B (production verification once hosting exists) | **architect, 2026-10-04**; roadmap 1A scope, ADR-0005 | OD-43 hosting |
| SEC-012 infrastructure scanning | 11B | roadmap 1A/11B | — |
| SEC-017 backups | 11C (real backups, restoration tests, recovery evidence) | **architect, 2026-10-04**; roadmap 1A ("backup policy") | OD-42, OD-43 |
| REL-007 monitoring and alerting | 11C, 11F (backend, alert rules, escalation, procedures) | **architect, 2026-10-04**; roadmap 1A/11C/11F, catalog | — |
| WSB-007 separation for later record types | 2A, 2B, 4C, 4E | catalog | OD-06 |
| PRJ-027 project permissions | 2A | catalog, ADR-0011 F4 | — |
| PRJ-028 guest project views | 3A | catalog, ADR-0011 F4 | OD-27 |
| COL-004, PERM-003 project, task, document, and integration levels | 2B, 4C, 6A | ADR-0011 F4 | — |
| WSB-015 brand marker on later surfaces | 4B, 5A, 7B | catalog, ADR-0010 D12 | — |
| NAV-008 pinned views | 3A | ADR-0012 F4, VIEW-019 | — |
| AUD-005 activity filters | 3B | catalog | — |
| AUD-008 AI and agent history | 7A, 8C | catalog | OD-36 |
| SEC-020 retention controls | 10C, 11B | catalog, roadmap 1F | OD-36, OD-37 |

## Integration fixes in this branch

Each fix is narrow, has a regression test, and is described in its commit.

- **A session that ends while a tab is open.** Found by journey step 8. When a member was removed
  (sessions revoked), Back to a workspace page showed "Loading" with "Check your connection".
  Access still failed closed. Now a 401 from the workspace context re-reads the session, and the
  tab goes to Sign in as a fresh load would. Test: `apps/web/test/shell.test.tsx`, "sessions that
  end while a tab is open". It fails without the fix.
- **Rail link without an accessible name.** Found by the tablet journey's axe check. At Medium
  width the personal shell's "Workspaces" link lost its name, because the visible short label is
  `aria-hidden` and the full label is hidden. It now has the same `title` fallback as every other
  rail link.
- **Undocumented configuration key.** Found by the closure check. `SECRET_PROVIDER` is now in
  `environments.md`.

## Reviews

- **Reliability.** No sleeps, retries, skips, or longer timeouts were added. The `goTo` "More"
  failure seen twice in 1E CI (runs 37199290059 and 37201537775, Medium width) has not recurred
  in later runs or in any local run. Its fail-fast diagnostics (`e2e/support.ts`) are kept, so a
  recurrence prints the rendered navigation. **Status: unexplained, not recurring, monitored.**
- **Security and privacy.**
  - Security headers are asserted on deep links and API responses.
  - No secrets in logs, which is existing coverage.
  - The journey's database URLs and captured mail stay in the test process environment and are
    never printed.
  - CI traces and HTML reports stay off.
  - URLs carry public IDs only.
  - A local verify log was scanned: no connection strings, passwords, signing keys, or one-time
    tokens.
- **Operations.** Readiness truthfulness, bounded telemetry labels (`registry-drift.test.ts`), the
  non-root image, and the hourly `views.cleanup` job are unchanged and covered by existing gates.
  No cloud resources exist, so the running cost is zero until hosting (OD-43).

## Decisions recorded (architect, 2026-10-04)

1. **WSB-008 (cross-brand sharing): owned by 2A, and OD-04 is decided.**
   - 1D remains the generic exact-record-grant foundation. 2A delivers the first user-facing
     sharing, for projects.
   - Record types are non-shareable by default. Each record-owning phase registers its type's
     shareability and supported levels.
   - Levels are `view`, `comment`, and `edit`, capped by the module and by what the sharer may
     grant. Guests are capped at `edit`.
   - Access received through a share never permits onward sharing.
   - A share covers only explicitly selected records.

   Recorded in the catalog, the OD-04 entry, ADR-0010 D11, the regenerated catalog and summary, and
   `closure.json`.
2. **Hosting-dependent requirements: approved deferrals.**
   - SEC-001 and SEC-002 complete in 11B.
   - SEC-017 completes in 11C.
   - REL-007 completes in 11C and 11F.

   Their Phase 1 work stays an accepted foundation; none is marked implemented.
3. **Phase 0 status labels: reconciled as status metadata only.**
   - Updated: the architecture, product, and UX READMEs, and the 0A contract documents' status
     lines. They now cite P0-W1…W4 and P0-IR1.
   - No contract text changed. Historical reports (the Phase 0 exit-gate report and the UX
     decisions log) are unchanged.
4. **Assistive technology: deferred to 11E.** No NVDA, JAWS, or VoiceOver pass has been run, and
   none is claimed (ADR-0012 F6). See [manual-smoke.md](manual-smoke.md).

## Related

- [topology.md](topology.md): branch stack, checks, and merge order.
- [manual-smoke.md](manual-smoke.md): the product owner's short manual pass and the assistive
  technology limitation.
