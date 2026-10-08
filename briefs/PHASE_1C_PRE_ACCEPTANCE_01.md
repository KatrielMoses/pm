# Pre-Acceptance Corrective Brief — Phase 1C Review 01

## Objective

Reconcile three implementation additions with their authoritative Phase 0 contracts before creating the branch/commit and running the no-skip CI acceptance gate. Preserve the working Phase 1C implementation and avoid unrelated redesign.

Phase 1C remains incomplete until these corrections and the complete CI run pass.

## Accepted ADR-0010 decisions

The following dispositions are accepted:

- D3: canonical personal `tenancy.scope_preference` entity;
- D4: narrowly scoped NOLOGIN `pm_directory` role and definer functions, with role-bootstrap ordering documented and tested;
- D5: `workspace_context` as a closed non-resource response;
- D6: optional conflict details already defined by the 0D error schema;
- D8: runtime-supported IANA timezone identifiers and aliases, stored as validated identifiers without inventing a private canonicalization table;
- D9: archived brands are read-only until comments introduce the documented exception;
- D10: brand trash/purge product actions remain deferred;
- D11: WSB-008 foundation only, with no implicit cross-brand sharing;
- D12: WSB-015 shared brand-presentation contract, with universal placement deferred to 1E and owning modules.

D1, D2, and D7 are accepted in principle but must be registered at their authoritative sources now, not deferred to a later contract revision.

## Required corrections

### 1. Register `workspace.create` in the canonical 0C action catalog

Add `workspace.create` to the authoritative access-policy source and regenerate all derived outputs.

Required semantics:

- account/personal platform action performed by a verified human account before tenant context exists;
- requirement WSB-001;
- risk classification consistent with `brand.create` and the cost/side effects of creating a tenant;
- no workspace role cell may grant it because no membership exists yet;
- non-human principals, service tokens, agents, automations, integrations, and delegated OAuth/API scopes cannot exercise it unless a future explicit contract changes that rule;
- it creates authority only by atomically creating the canonical workspace, active owner membership, and owner assignment already implemented;
- rate limiting, email verification, idempotency, and account state remain mandatory gates.

Update the policy validator/threat tests so every runtime authorization action exists in the canonical catalog and `workspace.create` cannot accidentally acquire tenant or delegated scope semantics. Remove ADR language treating workspace creation as an unregistered action.

### 2. Register the brand operational-status vocabulary in 0B

Replace the undefined `status brand_status` model text with the actual distinct business field and values:

- `operational_status`;
- `operating`, `paused`, and `planned`;
- explicit statement that archive/trash/purge remain `core.record.lifecycle_state` and are never represented by operational status.

Update the authoritative model source, relevant prose/decision record, generated data documentation, and validators. Ensure migration checks, TypeScript contracts, API schemas, and UI options consume one generated or centrally validated vocabulary rather than maintaining divergent lists.

Add drift tests proving the database constraint and runtime vocabulary match 0B.

### 3. Register Phase 1C telemetry in the authoritative 0D registry

Add the implemented bounded signals to the 0D telemetry source with their exact types, areas, and allowed labels:

- `tenancy.commands{command,outcome}`;
- `tenancy.authz_decisions{action_key,outcome}`;
- `tenancy.context_failures{reason}`;
- `tenancy.context_fallbacks{reason}`;
- `tenancy.rls_denials{module}`.

Register or document the `tenant_isolation` readiness component in the authoritative health/readiness contract as appropriate. Regenerate outputs and add runtime-to-registry validation so an emitted metric name/type/label set cannot silently diverge. Preserve the forbidden-label checks and confirm no workspace, brand, membership, account, public ID, name, timezone, or content label is allowed.

### 4. Finalize ADR-0010 for the CI candidate

- Change D1, D2, and D7 from deferred deviations to accepted, source-backed decisions.
- Mark ADR-0010 `implemented; acceptance pending CI` until the complete gate passes.
- Preserve the exact Phase 1D handoff.
- Remove stale wording about a “next contract revision.”

## Local verification before commit authorization

Run all locally available gates again after reconciliation:

- Phase 0 integration and generated-file drift checks;
- format, lint, SQL safety, workspace graph, Dockerfile manifest, and type checks;
- unit/component tests;
- complete embedded-PostgreSQL developer suite;
- build, process smoke, and browser/accessibility tests.

Report updated counts and the final diff/branch plan. Do not commit, push, or open the PR until the product owner explicitly authorizes those external changes.

## CI acceptance requirements after authorization

The eventual draft PR must run one clean `scripts/verify.sh` with no developer skip flags and no skipped gates, including Testcontainers PostgreSQL, pinned scanners, and the real production-image build/runtime smoke. Phase 1C cannot be accepted from the embedded/skip run.

## Required response

Return:

1. Authoritative 0C action, 0B vocabulary, and 0D telemetry changes.
2. Generated outputs and drift/validator tests.
3. ADR-0010 final D1–D12 dispositions.
4. Every changed file beyond the existing Phase 1C tree.
5. Updated local test counts and locally available gate results.
6. Proposed branch, commit scope, and draft-PR base, while confirming that no commit or push occurred.
7. Any remaining deviation or limitation.

Do not report Phase 1C complete or create the acceptance PR while any of the three additions remains implementation-only.
