# Identity and sessions (Phase 1B)

Module `@pm/identity` (`packages/identity`), routes in `apps/api/src/auth/`, web screens in
`apps/web/src/pages/`. Decisions and deviations are in
[ADR-0008](adr/0008-identity-and-sessions.md).

Identity is **platform-scoped**: accounts, sessions, and factors are not workspace rows and have
no tenant RLS. Platform transactions (`PlatformDatabase.withPlatform`) set
`app.platform_scope='platform'` and refuse a workspace context. Authentication proves who a person
is; it never grants authority inside a workspace.

## Data classification

| Data | Class | Where | Notes |
|---|---|---|---|
| Session token, one-time tokens (verification, reset, continuation, OAuth state), step-up tokens | C4 | Never stored raw; SHA-256 only | 256-bit CSPRNG input; raw value shown/sent once |
| Password | C4 | `identity.credential.password_hash` (Argon2id PHC string) | Column grants: `app_rw` only; the worker cannot read it |
| TOTP seed | C4 | Secret vault; `mfa_factor.secret_ref` holds only a reference | Destroyed on disable and on re-enrolment |
| Recovery codes | C4 | `identity.recovery_code.code_hash` (SHA-256 of 80-bit codes) | Shown once |
| Mail token in flight | C4 | Secret vault; `mail_delivery.secret_ref` | Vault entry destroyed after send or at expiry |
| Email, display name, locale, time zone | C3 | `identity.account` | `email_key` is the normalised unique key |
| Network prefix, user-agent family | C3 | `identity.session`, `identity.security_event_buffer` | Full IP and UA never stored |
| Rate-limit keys | C2 | `ops.rate_limit_bucket` | `HMAC(signing key, policy ‖ dimension)`; not reversible to IP or email |

C4 values never enter logs, traces, metrics, audit values, error reports, or URLs that are sent
to third parties. The logger redacts token-, secret-, password-, and cookie-shaped fields; tests
assert that captured logs contain no raw token from the test run.

## Passwords

- Argon2id via `node:crypto.argon2`. Defaults `m=65536 KiB, t=3, p=1` (`ARGON2_*`); a semaphore
  (`ARGON2_MAX_CONCURRENCY`, default 4) bounds memory to about 256 MiB per process.
- Benchmark: about 64 ms per hash on an Apple M5 at the defaults. Re-measure on the chosen hosting
  class before launch; raise `t` if the hash is well under 100 ms there.
- Policy: at least 12 characters, at most 1024 UTF-8 bytes. Longer input is **rejected**, never
  truncated. Hashes are upgraded on sign-in when parameters change.
- Unknown accounts run a dummy verification so sign-in has the same cost profile.

## Sessions

- Opaque cookie, server-side row in `identity.session` (hash, account, auth methods, assurance,
  idle and absolute expiry, network prefix, UA family). No JWT.
- Idle timeout `SESSION_IDLE_TIMEOUT_MS` (default 3 days), absolute `SESSION_ABSOLUTE_TIMEOUT_MS`
  (30 days), `last_seen` written at most every `SESSION_TOUCH_INTERVAL_MS`. These are operational
  defaults, **not published expiry periods**.
- **Rotation** (old session revoked with reason `rotated`, new cookie issued): sign-in, MFA
  completion, password change, MFA enrol/disable. Password reset revokes every session.
- Cookie: `pm_session` / `__Secure-pm_session`; `HttpOnly`, `SameSite=Lax`, `Path=/v1`, host-only;
  `Secure` everywhere except `APP_ENV=local|test` with `COOKIE_SECURE=false`.

## CSRF

1. Every unsafe `/v1` request must carry an `Origin` in `PUBLIC_BASE_URL` ∪ `ALLOWED_ORIGINS`
   (deployed modes: https only). Missing or foreign → `403 forbidden`.
2. Cookie-authenticated unsafe requests also need `X-CSRF-Token`, an HMAC of the session ID under
   `AUTH_SIGNING_KEY`. Authenticated reads return it in the `x-csrf-token` header. Rotating the
   session rotates the token.

## One-time tokens and links

Links put tokens in the URL fragment (`/verify-email#token=…`), so they never reach server logs,
proxies, or `Referer`. The page reads the fragment, clears it with `history.replaceState`, and
POSTs the token. Tokens are single-use (consumed under a row lock) and purpose-bound. A new
verification or reset token supersedes earlier unused ones of the same purpose.

## Enumeration resistance

Registration, resend, and password recovery always return the same `202 acknowledgement` after a
response-time floor (`AUTH_RESPONSE_FLOOR_MS`). Registering an existing email sends the owner an
"account exists" notice instead of a verification link. Sign-in failures return one
`invalid_credentials` error whether the email exists or not. Rate limits apply per source and per
submitted email to existing and unknown accounts alike.

## Abuse controls

Postgres-backed buckets with escalating temporary blocks (30 s doubling, capped at 15 min). There
is no permanent lockout, so an attacker cannot lock a real user out for good. Policies (see
`DEFAULT_POLICIES` in `packages/identity/src/rate-limit.ts`) are operational defaults, overridable
with `RATE_LIMIT_POLICIES` (JSON), and are **not published**. Registration also calls a
bot-protection port: `none` or `test` (local/test only). No provider is chosen.

## Step-up (0D §11.2)

A protected action without a fresh step-up returns `403 step_up_required` with a challenge
(`id`, `methods`, `expires_at`). The challenge is bound to the session, account, action key, target
hash, and idempotency-key hash. `POST /v1/auth/step-up/{id}:verify` with a password, TOTP code, or
recovery code returns a single-use token. The client retries the **same** request with
`Step-Up` and the same `Idempotency-Key`; the token is consumed inside the action's
transaction. The web app keeps the original form mounted beneath the step-up dialog and resumes it
after verification.

Step-up actions come from the generated 0C registry. Workspace actions need a membership. The
own-account actions `account.mfa_enroll`, `account.mfa_disable`, and
`account.recovery_codes_regenerate` (AZ-17) must not carry one.

**Challenge states** (0D schema, generated `STEP_UP_CHALLENGE_STATES`): `pending`, `verified`,
`consumed`, `expired`, `cancelled`, `locked`.

| Event | Rule |
|---|---|
| Wrong proof below the limit | `failed_attempts + 1`, `step_up.failed` event, `422 invalid_proof` |
| Wrong proof reaching `STEP_UP_MAX_ATTEMPTS` | In the same row-locked transaction: `state = 'locked'`, `locked_at`, the final count, `step_up.failed` and `step_up.locked` (outcome `denied`) events. Answer `429 rate_limited` |
| Any attempt on a locked challenge | `429 rate_limited`. The proof is not checked; no count, state, or event changes. Abuse rate limits still apply |
| Pending challenge whose count already meets a lowered limit | Locked on the next attempt without checking the proof |
| Raised limit after locking | Irrelevant: `locked` is stored and terminal, so it never verifies or yields a token |
| Concurrent final attempts | `SELECT … FOR UPDATE` serializes them. Either the correct proof wins (`verified`, and the late wrong proof gets `409`), or the wrong proof wins (`locked`, and the correct proof gets `429` with no token). Never both |
| Cancel | Only `pending`/`verified` challenges cancel. Terminal states, including `locked`, answer `404` and stay unchanged |
| Retention | Locked challenges are deleted by `identity.cleanup` once `expires_at` is a day past, like other expired challenges |

The database enforces locked ⇔ `locked_at` and that a locked row has no token or verification
(migration 0012).

## OAuth boundary

`OAuthProvider` covers the authorization URL (PKCE S256, state, nonce), code exchange, and verified
claims. Only the deterministic `local` provider ships, for tests; deployed modes refuse it. Sign-in
works only for a provider subject already linked to an account. Linking starts from a signed-in
session. Accounts are never created or linked automatically because an email matches.

## Mail

Flows write `identity.mail_delivery` rows plus a platform job in the same transaction. The worker
renders the template, fetches the token from the vault, sends through the configured transport
(`capture` locally), then destroys the vault entry. Raw tokens never sit in an ordinary table.

## Revocation semantics

Every request resolves the session from the database, so revocation is immediate; there is no
cached or self-contained credential to wait out. Reasons recorded: `sign_out`,
`sign_out_everywhere`, `revoked_by_owner`, `password_reset`, `password_changed`, `rotated`,
`mfa_changed`, `administrative`. Users can revoke one session, all others, or all.
`revokeAccountSessionsAsAdministrator` exists but needs a `ManageOthersDecision` that only the 1D
policy layer can construct; no route exposes it in 1B.

## Credential-compromise response (runbook)

1. **One account:** the user resets their password, which revokes all sessions and sends a
   notice. Otherwise an operator revokes all sessions for the account (administrative path once 1D
   exists; until then by a reviewed SQL update setting `revoked_at` and
   `revoke_reason='administrative'`).
2. **Signing key (`AUTH_SIGNING_KEY`) exposed:** rotate the key. CSRF tokens and rate-limit keys
   change; sessions survive because they are hash-matched, not signed. Users reload once.
3. **Database read exposure:** session and token hashes cannot be replayed as cookies. Revoke all
   sessions (`UPDATE identity.session SET revoked_at=now(), revoke_reason='administrative'`) and
   force password resets as policy decides. TOTP seeds sit in the vault, not the database.
4. **Vault key exposed:** rotate the vault key and require MFA re-enrolment.

Application-driven steps (reset, user revocation) write security events to
`identity.security_event_buffer` (ADR-0008 B4). Manual SQL steps do not, so record them in the
incident log.

## Retention hooks

The recurring `identity.cleanup` job (queue `maintenance`, every 15 minutes, platform scope)
deletes:

- expired or consumed tokens and challenges;
- sessions revoked or expired longer ago than `SESSION_RETENTION_MS`;
- mail rows older than `MAIL_RETENTION_MS`;
- expired vault entries;
- rate-limit buckets idle for 24 h.

`identity.security_event_buffer` is never swept: it is append-only and is drained into the 1F
immutable sink under the [ADR-0008 handoff contract](adr/0008-identity-and-sessions.md#phase-1f-handoff-security-event-buffer).
Account deletion and the security-event sink belong to later phases (1F audit; deletion policy in
`docs/product/deletion-retention-history.md`).

## How membership connects

1B ends at an authenticated `AuthContext` (account, session, assurance, auth methods). It creates
no workspace, membership, role, or permission and infers none. The onboarding screen says that
workspace setup arrives in a later release. In 1C/1D:

- 1C creates workspaces and memberships keyed by `identity.account.id`.
- 1D's policy layer takes the `AuthContext` plus membership and decides every workspace action.
  Workspace step-up requirements reuse the same challenge mechanism with 0C action keys.
- Workspace policies such as "require MFA" read `session.assurance`; identity does not enforce
  them.
