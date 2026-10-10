# ADR-0008: Identity and sessions (Phase 1B) — decisions and deviations

Status: **accepted and implemented** (Phase 1B review 01). The ten proposed choices B1–B10 have
the dispositions below. B1 and B2 are recorded at the authoritative Phase 0 sources. B8 was rejected
and replaced by a stored `locked` state. No item awaits approval.

## Decisions inside the brief

| # | Topic | Decision | Why |
|---|---|---|---|
| I1 | Browser session | Server-side session in `identity.session`; opaque 256-bit cookie value, stored only as SHA-256. No JWT. | Brief; instant revocation |
| I2 | Cookie | `pm_session` (`__Secure-pm_session` when `COOKIE_SECURE=true`), `HttpOnly`, `SameSite=Lax`, `Path=/v1`, no `Domain` (host-only). Rotated on sign-in, MFA completion, password reset/change, MFA enrol/disable. Sign-in continuation uses a separate `pm_continue` cookie (`Path=/v1/auth`, `SameSite=Strict`). | Brief; narrow path; Lax keeps OAuth callbacks working |
| I3 | CSRF | Origin allow-list on every unsafe `/v1` request **and** a synchronizer token: `X-CSRF-Token = HMAC(AUTH_SIGNING_KEY, "csrf" ‖ session id)`, returned in the `x-csrf-token` response header of authenticated reads. Unauthenticated unsafe routes still require an allowed Origin. | Brief (origin check plus synchronizer); stateless to verify |
| I4 | Passwords | Argon2id through `node:crypto.argon2` (no native addon). Defaults m=64 MiB, t=3, p=1, concurrency semaphore 4. Byte limit 1024 UTF-8 bytes, rejected (never truncated). | Benchmark ≈ 64 ms per hash on Apple M5 at the defaults; the semaphore bounds memory to ≈ 256 MiB per process |
| I5 | One-time tokens | 256-bit random, base64url, stored as SHA-256 in `identity.verification_token` (purpose, expiry, consumed). Links put the token in the URL **fragment** (`#token=`), so it never reaches server logs, `Referer`, or proxies. Mail delivery carries a vault reference only; the vault entry is destroyed after send. | Brief: raw tokens shown/sent once; C4 never in ordinary tables |
| I6 | Enumeration resistance | Registration, resend, and recovery always answer the same acknowledgement; a response-time floor (`AUTH_RESPONSE_FLOOR_MS`, default 400 ms) and a dummy Argon2 verification for unknown accounts equalise timing class; rate-limit keys are per source and per email, so a limited response says nothing about existence. Registering an existing address sends the owner an "already registered" notice instead. | Brief |
| I7 | Abuse controls | Postgres buckets `ops.rate_limit_bucket`, keyed by `HMAC(signing key, policy ‖ dimension)` (no raw IP or email stored). Escalating temporary blocks 30 s × 2^strikes, capped at 15 min. **No permanent lockout.** Policy numbers are operational defaults, overridable with `RATE_LIMIT_POLICIES`, and are **not published**. | Brief: lockout promises and global numbers remain unset |
| I8 | Step-up | 0D §11.2 exactly: `403 step_up_required` with a challenge bound to session, account, action, target hash, and idempotency-key hash; verification returns a single-use token; repeated failures store the terminal `locked` state (see B8); the client retries the same request with `Step-Up` and the same `Idempotency-Key`. Token consumed in the action's transaction. | Brief |
| I9 | MFA | TOTP (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step, replay-protected by last-used step). Seed stored in the secret vault, referenced from `identity.mfa_factor.secret_ref`, destroyed on disable/re-enrol. 10 recovery codes of 80 random bits each, stored only as SHA-256 (high entropy, so a slow hash adds nothing), single use; regenerate replaces all. | Brief; authenticator compatibility |
| I10 | Secret vault | `SecretVault` interface in `@pm/config`. Only adapter shipped: `DevDatabaseVault` (AES-256-GCM, key `DEV_VAULT_KEY`), **refused at startup in deployed modes**. | Brief: KMS boundary with non-production adapter |
| I11 | Mail | Outbox-style `identity.mail_delivery` rows, delivered by the worker (`identity.mail_delivery` job). Local transport `capture` writes files to `MAIL_CAPTURE_DIR`; refused in deployed modes. | Brief: mail via outbox; no vendor chosen |
| I12 | OAuth | Provider boundary (`OAuthProvider`: authorization URL with PKCE S256, state, nonce; code exchange; verified claims). Only the deterministic `local` provider ships, refused in deployed modes. State is a one-time token (`oauth_state`) bound to the browser via a cookie. Linking starts only from a signed-in session (CSRF-protected) and binds to that account; OAuth sign-in matches only a linked provider subject. No auto-link by email. | Brief: no commercial provider without approval |
| I13 | Device data | Sessions record a user-agent **family** label and a network **prefix** (IPv4 /24, IPv6 /48), never the full IP or UA string. | Data minimisation |
| I14 | Cleanup | Recurring platform job `identity.cleanup` (every 15 min) deletes expired tokens, challenges, sessions past `SESSION_RETENTION_MS`, delivered mail past `MAIL_RETENTION_MS`, expired vault entries, and stale rate-limit buckets. | Brief |

## Review dispositions (B1–B10)

| # | Topic | Disposition | Final decision | Where it is recorded |
|---|---|---|---|---|
| B1 | Public-ID prefixes | **Accepted; registered at source** | `ses_` → `identity.session`, `mfa_` → `identity.mfa_factor`, `oid_` → `identity.oauth_identity`, owner module `identity`. One registry and one validation path: the generated `ID_PREFIXES` (the pending catalog and its parser path are removed) | 0D `platform/contracts/registry.json` `id_prefixes`; 0B `public_id_prefix` on the three entities; decision PL-17 in `docs/architecture/platform/19-decisions.md` |
| B2 | Account step-up actions | **Accepted; registered at source** | `account.mfa_enroll` (R3), `account.mfa_disable` (R4), `account.recovery_codes_regenerate` (R3): kind `personal`, scope `personal`, `own` for every role (never a tenant capability), step-up, no approver or entitlement, SEC-006 (+ SEC-005 for recovery codes). Human-only: step-up is unavailable to non-human principals and no 0D scope may list them. Enrollment accepts a password step-up when no factor exists. ADM-013 (workspace ownership transfer) does not apply to own-account security, so it is not mapped. Runtime `ACCOUNT_STEP_UP_ACTIONS` is derived from the generated 0C `ACTIONS`; the Phase 0 validator checks every runtime `#protected(...)` action | 0C `access/policy/policy.json`; threat T-35 and tests AT-081…086 in `threats.json`; decision AZ-17 in `docs/architecture/access/15-decisions.md`; `phase0.py` section "step-up actions and challenge states" |
| B3 | Id-less responses | **Accepted** | A closed set of **non-resource** response types (`NON_RESOURCE_TYPES`: `platform_status`, `acknowledgement`, `sign_in_result`, `step_up_token`, `recovery_code_set`, `oauth_authorization`) built only by `nonResourceEnvelope`. These are not resources and not "singletons". The builder refuses any type outside the set and any registered 0D resource type. A unit test proves no member collides with a resource type, and a confinement test limits callers to `/v1/status` and the auth routes. Ordinary resources must use `successEnvelope`, which requires a registered public ID | `packages/contracts/src/envelopes.ts` |
| B4 | Security events | **Accepted (temporary sink); handed off in 1F** | Append-only `identity.security_event_buffer` until the 1F immutable audit sink existed. 1F executed the handoff below (ADR-0009 F8); the buffer is retired only by a later contract migration | This ADR, [§ Phase 1F handoff](#phase-1f-handoff-security-event-buffer) |
| B5 | Platform-scope execution | **Accepted** | Migration 0010: `exec.job.workspace_id` and `exec.idempotency_key.workspace_id` nullable only under `exec.in_platform_scope()` (`app.platform_scope='platform'` and no workspace context). Tenant and platform contexts are mutually exclusive; operations, attempts, effects, and outbox stay tenant-only | Migration 0010; [database.md](../database.md#platform-scope-migration-0010) |
| B6 | Email key | **Accepted** | `identity.account.email_key text UNIQUE`, normalised by the application (Unicode NFC, trim, IDNA/lower-case domain, lower-cased local part; the display form keeps the original case) instead of `citext` | Migration 0011 |
| B7 | Recovery codes | **Accepted** | Child table `identity.recovery_code`, one SHA-256 row per code, consumed under row locks | Migration 0011 |
| B8 | Locked challenge | **Rejected → replaced** | `locked` is a **stored terminal state**. Migration 0012 adds it to the state constraint, with `locked_at` and consistency checks (locked ⇔ `locked_at`; locked rows hold no token). The failed verification that reaches `STEP_UP_MAX_ATTEMPTS` sets `pending → locked` atomically under the row lock, see [identity.md](../identity.md#step-up-0d-112) | 0D step-up-challenge schema state enum and §11.2; parameter `STEP_UP_MAX_ATTEMPTS`; 0B `identity.step_up_challenge`; PL-17; migration 0012 |
| B9 | OAuth registration | **Accepted** | OAuth sign-in only for an already-linked identity; no account creation via OAuth | Service and tests |
| B10 | WebAuthn | **Accepted (boundary only)** | Method name reserved and filtered from the UI. **WebAuthn is not supported** and is not claimed | — |

## Phase 1F handoff: security-event buffer

The buffer holds every identity security event since 1B. Application roles may only INSERT into it,
and no job deletes from it. Its rows match the 0D `security-event` fields: `id` (UUIDv7, the
event's identity), `occurred_at`, `category`, `action`, `outcome`, actor, subject, `workspace_id`
(null in 1B), `network_prefix`, `user_agent_family`, `correlation_id`, and `retention_class
= 'R-AUDIT'`. Phase 1F must move it into the immutable sink **without loss or duplication**:

1. **Cut over writers first.** Point `SecurityEventPort` at the 1F sink, or dual-write to both,
   so no event lands only in the buffer after the drain starts.
2. **Drain idempotently.** Copy each buffered row into the sink keyed by its original `id`
   (insert-if-absent), in `occurred_at, id` order and in bounded batches. Keep the original `id`
   and `occurred_at`; never re-stamp them. Re-running the drain must add nothing.
3. **Verify.** For the whole buffer, and per day of `occurred_at`, compare the buffer and the sink
   on the row count and on a SHA-256 over the canonical serialization of the copied fields, ordered
   by `id`. Any mismatch stops the process; the buffer stays.
4. **Retire only by contract migration.** After verification, and after a release in which nothing
   writes to the buffer, a later `-- migrate:phase contract` migration revokes the INSERT grants and
   drops `identity.security_event_buffer`. No expand migration or job deletes buffered events.
5. **Prove it.** 1F integration tests cover a drain re-run (no duplicates), a drain interrupted
   mid-batch (resumes without loss), and count/checksum equality before the drop.

## Deployment decisions (accepted as later decisions; deployed modes fail closed)

The provider-neutral posture is accepted: these choices do not block Phase 1B acceptance. The
configuration rejects every local adapter in deployed modes (`dev-database` vault, `capture`
mail, `local` OAuth, `test` bot protection, `COOKIE_SECURE=false`). Consequences:

1. **Startup blocker:** the API and worker need a secret store/KMS adapter for `SECRET_VAULT`
   (MFA seeds, in-flight mail tokens); none is approved, so neither starts in a deployed mode.
2. **Startup blocker:** the worker needs a mail provider for `MAIL_TRANSPORT`.
3. **Launch decision:** bot protection for registration. `BOT_PROTECTION=none` starts, relying on
   rate limits alone; a provider needs approval before public registration opens.
4. **Launch decision:** any commercial OAuth provider (none enabled; password sign-in works alone).
5. **Unset by design:** published expiry periods, lockout behaviour, and rate-limit numbers.

## Not in scope (unchanged)

Identity never grants tenant authority: no workspace, membership, or role is created or inferred
from authentication. Phase 1C/1D connect authenticated principals to memberships; see
[identity.md](../identity.md#how-membership-connects).
