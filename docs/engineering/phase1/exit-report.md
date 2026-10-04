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

`phase1.py` passes with 65 owned requirements and 38 contributions:

- 49 implemented;
- 16 foundations, each with deferral targets and an accepted source;
- 38 contributions with evidence.

Every evidence citation is checked to exist.

Foundations and why each is accepted:

| Requirement | Deferred to | Accepted by | Open decision |
|---|---|---|---|
| SEC-001 in transit, SEC-002 at rest | 11B | roadmap 1A scope, ADR-0005 | OD-43 hosting |
| SEC-012 infrastructure scanning | 11B | roadmap 1A/11B | — |
| SEC-017 backups | 11C | roadmap 1A ("backup policy") | OD-42, OD-43 |
| REL-007 alerting | 11C, 11F | roadmap 1A/11C/11F, catalog | — |
| WSB-007 separation for later record types | 2A, 2B, 4C, 4E | catalog | OD-06 |
| WSB-008 cross-brand sharing | **none named** | ADR-0010 D11 | OD-04 |
| PRJ-027, PRJ-028 project permissions, guest views | 2A, 3A | catalog, ADR-0011 F4 | OD-27 |
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

## Findings for the product owner

1. **WSB-008 has no destination subphase.** ADR-0010 D11 accepts "foundation only", and OD-04
   (which record types are shareable across brands) is open. Choose an owning subphase or record
   an explicit scope decision.
2. **1A requirements that are foundation-only until hosting exists:** SEC-001, SEC-002, SEC-017,
   REL-007. They rest on the accepted provider-neutral decision. Confirm the 11B, 11C, and 11F
   deferrals.
3. **Phase 0 summary documents still say "proposed / awaiting review"**, although Phase 0 is
   accepted:
   - `docs/architecture/{data,access,platform}/README.md`;
   - `docs/ux/README.md`, including its requirement-references paragraph;
   - `docs/product/README.md`.

   This is reported, not edited: changing accepted Phase 0 documents is a Phase 0 decision.
4. **Assistive technology.** No NVDA, JAWS, or VoiceOver pass has been run (ADR-0012 F6; 11E). See
   [manual-smoke.md](manual-smoke.md).

## Related

- [topology.md](topology.md): branch stack, checks, and merge order.
- [manual-smoke.md](manual-smoke.md): the product owner's short manual pass and the assistive
  technology limitation.
