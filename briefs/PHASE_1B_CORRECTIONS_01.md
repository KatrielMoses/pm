# Corrective Developer Brief — Phase 1B Review 01

## Objective

Close the remaining contract-consistency gaps in the otherwise working Phase 1B implementation. Preserve the completed identity flows and avoid unrelated redesign.

Phase 1B remains incomplete until the authoritative Phase 0 sources, generated contracts, database state model, runtime behavior, tests, and documentation agree.

## Read first

- `briefs/PHASE_1B_IDENTITY_AND_SESSIONS.md`;
- the Phase 1B completion report;
- `docs/engineering/adr/0008-identity-and-sessions.md`;
- authoritative Phase 0 data, access-policy, and platform-contract source files and their generators.

Do not edit `BUILD_ROADMAP.md` or mark `ROADMAP_CHECKLIST.md` complete. Do not solve these issues with implementation-only allow-lists that leave the accepted source contracts unchanged.

## Review decision on the ten proposed choices

The following are accepted:

- **B3:** closed, id-less response envelopes for genuine non-resource authentication results;
- **B4:** the append-only identity security-event buffer as a temporary Phase 1B sink, provided Phase 1F migrates/drains it without loss or duplication;
- **B5:** explicitly platform-scoped, workspace-free jobs and idempotency keys with mutually exclusive tenant/platform database context;
- **B6:** deterministic application-normalized `email_key` with database uniqueness instead of `citext`;
- **B7:** recovery codes as individually lockable hash rows;
- **B9:** OAuth sign-in only for already-linked identities;
- **B10:** WebAuthn boundary only, with no support claim.

The following are accepted in principle but incomplete until reconciled at the authoritative sources:

- **B1:** public prefixes `ses_`, `mfa_`, and `oid_`;
- **B2:** account-level actions `account.mfa_enroll`, `account.mfa_disable`, and `account.recovery_codes_regenerate`.

**B8 is rejected.** `locked` is an accepted stored step-up challenge state, not merely an inferred response condition. Persist it explicitly.

The provider-neutral production posture is also accepted. A KMS/secret-store adapter, mail provider, public-registration bot protection, and any commercial OAuth provider remain later deployment decisions; their absence does not by itself block Phase 1B acceptance while deployed modes continue to fail closed.

## Required corrections

### 1. Register the new public IDs at the authoritative 0D source

- Add `ses_` for `identity.session`, `mfa_` for `identity.mfa_factor`, and `oid_` for `identity.oauth_identity` to the authoritative platform registry source.
- Regenerate all derived registry documentation and TypeScript artifacts using the existing generator.
- Remove `packages/contracts/src/pending.ts` and every special parser path for pending prefixes. There must be one registry and one validation path.
- Add collision, format, entity-owner, generation-drift, and ordinary envelope tests.
- Update ADR-0008 from “needs approval” to the accepted decision and cite the authoritative registry entry.

Do not hand-edit generated files or weaken the generator/validator.

### 2. Register account security actions at the authoritative 0C source

Add these actions to the canonical access-policy action catalog:

- `account.mfa_enroll`;
- `account.mfa_disable`;
- `account.recovery_codes_regenerate`.

They are personal, human-only, non-delegable account-security actions owned by the authenticated account. Map them to SEC-006/ADM-013 as appropriate. Mark the destructive/sensitive actions for step-up consistently with the implemented flow; enrollment must require a fresh password or equivalent high-assurance proof without creating an impossible “MFA required before first MFA” loop.

Then:

- update the permission/risk/step-up metadata and threat/authorization tests at the authoritative source;
- regenerate all access-policy outputs;
- remove `ACCOUNT_STEP_UP_ACTIONS` as a separately maintained pending catalog, or derive the runtime subset from the generated canonical registry;
- ensure the Phase 0 cross-validator proves that every runtime step-up action exists in 0C and every required risk/step-up invariant holds;
- update ADR-0008 from “needs approval” to the accepted source-backed decision.

Do not represent account ownership as workspace membership and do not grant any tenant capability.

### 3. Persist the `locked` step-up state

The accepted model states are `pending`, `verified`, `consumed`, `expired`, `cancelled`, and `locked`. Add `locked` to the database constraint and runtime contract.

On the failed attempt that reaches `STEP_UP_MAX_ATTEMPTS`, atomically transition the challenge to `locked`. Once locked:

- it can never verify or yield a token, even if configuration later changes;
- further verification attempts return the safe locked/rate-limited response without incrementing or mutating unrelated state;
- cancellation, expiry cleanup, retention, and security-event behavior are deterministic and documented;
- concurrent final attempts cannot produce both a verified and locked result;
- the security event records the transition without secrets.

Use a new ordered migration rather than rewriting migration history already exercised by CI. Update typed schema, service logic, documentation, and tests.

Add integration tests for:

- exact transition into stored `locked`;
- persistence across process restart and configuration change;
- concurrent final correct/incorrect proofs with one valid terminal outcome;
- rejection of replay and verification after lock;
- cleanup/retention of locked challenges;
- migration up/down/checksum behavior.

### 4. Close documentation status and non-resource envelope terminology

- Change ADR-0008 from `proposed` to an accepted/implemented status once the corrections pass.
- Record the decisions above without leaving “pending approval” language in code or docs.
- Document B3 as a closed set of **non-resource** response types. Authentication acknowledgements/results are not platform status singletons, so rename the helper/type if practical or clearly correct its contract documentation. It must remain impossible for an ordinary resource to omit its public ID.
- Record B4's mandatory Phase 1F migration rule: drain/copy each buffered event idempotently into the immutable sink, preserve original event identity/time, verify counts/checksums, then remove the buffer only through a later contract migration.
- Ensure the Phase 1F brief can consume this handoff without reverse-engineering Phase 1B.

## Required verification

Run one clean verification from a clean dependency/build state, with no skipped acceptance gate:

1. frozen dependency install with no cycle warning;
2. complete Phase 0 validation and generated-file drift checks;
3. formatting, lint, SQL safety, complete workspace graph, and type checks;
4. unit/component tests;
5. all migrations from empty PostgreSQL plus down/up/checksum verification;
6. full containerized integration/RLS/security/concurrency suite;
7. application build and process smoke tests;
8. browser and accessibility tests;
9. dependency, license, and secret scans;
10. production-image build and runtime smoke.

The new tests must be included in the same clean run. Preserve the existing identity security and leak tests.

## Acceptance criteria

- The three new prefixes exist only in the authoritative/generated registry path; no pending-prefix bypass remains.
- The three account-security actions exist in the canonical 0C action registry with correct ownership, risk, delegation, step-up, requirement, and threat-test metadata; runtime code consumes the canonical contract.
- `locked` is a real persisted terminal challenge state with concurrency-safe behavior.
- All ten ADR decisions have an explicit accepted/deferred/rejected disposition and no stale “awaiting approval” language remains.
- B3 cannot be used to omit IDs from ordinary resources.
- B4 has an explicit, lossless Phase 1F handoff contract.
- Phase 0 validation and the complete clean CI/image gate pass with nothing skipped.

## Required completion response

Return:

1. Concise correction summary.
2. Every changed file and migration.
3. Authoritative prefix/action source changes and regenerated outputs.
4. Stored locked-state transition and concurrency behavior.
5. ADR status and final disposition of B1–B10.
6. Test additions and updated counts.
7. Clean verification command, exit status, immutable CI run/commit, PostgreSQL image, and production-image evidence.
8. Any remaining deviation, limitation, or skipped/failed gate.

Do not report Phase 1B complete while any prefix/action remains implementation-only, `locked` remains derived, or any acceptance gate is skipped.
