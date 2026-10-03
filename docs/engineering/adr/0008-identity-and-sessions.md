# ADR-0008: Identity and sessions (Phase 1B) — decisions and deviations

Status: proposed (awaiting product-owner review). Items marked **needs approval** change or extend
an accepted Phase 0 document and must be accepted, amended, or rejected before 1B is called
complete. Everything else is an implementation decision inside the brief.

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
| I8 | Step-up | 0D §11.2 exactly: `403 step_up_required` with a challenge bound to session, account, action, target hash, and idempotency-key hash; verification returns a single-use token; the client retries the same request with `Step-Up` and the same `Idempotency-Key`. Token consumed in the action's transaction. | Brief |
| I9 | MFA | TOTP (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step, replay-protected by last-used step). Seed stored in the secret vault, referenced from `identity.mfa_factor.secret_ref`, destroyed on disable/re-enrol. 10 recovery codes of 80 random bits each, stored only as SHA-256 (high entropy, so a slow hash adds nothing), single use; regenerate replaces all. | Brief; authenticator compatibility |
| I10 | Secret vault | `SecretVault` interface in `@pm/config`. Only adapter shipped: `DevDatabaseVault` (AES-256-GCM, key `DEV_VAULT_KEY`), **refused at startup in deployed modes**. | Brief: KMS boundary with non-production adapter |
| I11 | Mail | Outbox-style `identity.mail_delivery` rows, delivered by the worker (`identity.mail_delivery` job). Local transport `capture` writes files to `MAIL_CAPTURE_DIR`; refused in deployed modes. | Brief: mail via outbox; no vendor chosen |
| I12 | OAuth | Provider boundary (`OAuthProvider`: authorization URL with PKCE S256, state, nonce; code exchange; verified claims). Only the deterministic `local` provider ships, refused in deployed modes. State is a one-time token (`oauth_state`) bound to the browser via a cookie. Linking starts only from a signed-in session (CSRF-protected) and binds to that account; OAuth sign-in matches only a linked provider subject. No auto-link by email. | Brief: no commercial provider without approval |
| I13 | Device data | Sessions record a user-agent **family** label and a network **prefix** (IPv4 /24, IPv6 /48), never the full IP or UA string. | Data minimisation |
| I14 | Cleanup | Recurring platform job `identity.cleanup` (every 15 min) deletes expired tokens, challenges, sessions past `SESSION_RETENTION_MS`, delivered mail past `MAIL_RETENTION_MS`, expired vault entries, and stale rate-limit buckets. | Brief |

## Deviations and additions needing product-owner approval

| # | Topic | Accepted text | Implementation | Why | Cost to change |
|---|---|---|---|---|---|
| B1 | Public-ID prefixes | 0D registry has no prefixes for sessions, MFA factors, or OAuth identities | **Needs approval.** Pending prefixes `ses_`, `mfa_`, `oid_` in `packages/contracts/src/pending.ts`, accepted by the ID parser but kept out of the generated 0D registry | Session revocation, factor management, and unlink need addressable resources | Low (rename prefixes before any external client) |
| B2 | Step-up action keys | 0C action catalog has no account-level MFA actions | **Needs approval.** `account.mfa_enroll`, `account.mfa_disable`, `account.recovery_codes_regenerate` (in `ACCOUNT_STEP_UP_ACTIONS`). These are the only step-up-protected 1B actions; OAuth link/unlink and session revocation rely on the session plus CSRF | 0D §11.2 requires an action key in the challenge | Low (add to 0C or rename) |
| B3 | Singleton envelopes | ADR-0007 D6 limits id-less envelopes to `platform_status` | **Needs approval.** `PLATFORM_SINGLETON_TYPES` extended with `acknowledgement`, `sign_in_result`, `step_up_token`, `recovery_code_set`, `oauth_authorization`; the confinement unit test now covers `apps/api/src/auth/routes.ts` | These responses are not records and have no public ID | Low |
| B4 | Security events | 0D audit/outbox; outbox payloads are capped at C2 | **Needs approval.** Durable `identity.security_event_buffer` (platform scope, C3 payloads such as network prefix) until the 1F audit sink exists; no 0D identity event types are registered | Identity events must not go through the C2 outbox and 1F is not built | Medium (migrate buffer into 1F audit) |
| B5 | Platform-scope execution | ADR-0007 D5 kept `exec.job.workspace_id NOT NULL` | Migration 0010 makes `exec.job.workspace_id` and `exec.idempotency_key.workspace_id` nullable under an explicit `exec.in_platform_scope()` RLS policy (`app.platform_scope='platform'` and no workspace context); operations, attempts, effects, and outbox stay tenant-only (CHECK `workspace_id IS NOT NULL OR operation_id IS NULL`) | Mail delivery, cleanup, and account-level idempotency are not tenant work | Low — this is the additive change D5 anticipated |
| B6 | Email key | 0B suggests a case-insensitive email | `identity.account.email_key text UNIQUE`, normalised by the application (Unicode NFC, trim, IDNA/lower-case domain, lower-cased local part for the key; the display form keeps the original local-part case) instead of `citext` | Deterministic normalisation in one place; no extension dependency | Low |
| B7 | Recovery codes | 0B shows recovery codes on the MFA factor | Child table `identity.recovery_code` (one row per hashed code) | Single-use consumption under row locks | Low |
| B8 | Locked challenge | 0D §11.2 lists a `locked` challenge state | Derived condition: `failed_attempts ≥ STEP_UP_MAX_ATTEMPTS` → `429 rate_limited`; no stored state | Avoids a second source of truth | Low |
| B9 | OAuth registration | — | OAuth sign-in only for an already-linked identity; no account creation via OAuth | Avoids unverified-email account creation until a provider is approved | Low |
| B10 | WebAuthn | 0D lists `webauthn` as a step-up method | Boundary only (method name reserved, filtered from the UI). **WebAuthn is not supported** and is not claimed | Brief: not claimed until tested end to end | — |

## Production blockers (product-owner decisions)

The configuration rejects every local adapter in deployed modes (`dev-database` vault, `capture`
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
