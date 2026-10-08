# Developer Brief — Phase 1B: Identity and Sessions

## Objective

Build the complete first-party identity and session foundation. A person must be able to register, verify an email address, sign in and out, recover a password, manage and remotely revoke sessions, configure MFA, and satisfy an action-bound step-up challenge. The result must be secure, accessible, observable, abuse-resistant, and ready for workspace onboarding in Phase 1C.

Deliver working UI, APIs, migrations, background cleanup/delivery adapters, and automated evidence. Do not implement workspace membership or business features.

## Read first

- `FEATURES.md`, especially SEC-003 through SEC-009, SEC-021, A11Y-011, PERM-013, and ADM-013;
- `BUILD_ROADMAP.md`, `ROADMAP_CHECKLIST.md`, and the accepted Phase 0 contracts;
- `docs/architecture/data/generated/logical-model.md`, identity entities;
- `docs/architecture/platform/11-scopes-and-step-up.md`;
- `docs/architecture/access/01-invariants-and-trust-boundaries.md`;
- `docs/architecture/access/02-principals-and-execution-identity.md`;
- `docs/architecture/access/10-approvals-separation-of-duties.md`;
- `docs/architecture/access/13-permission-changes-and-revocation.md`;
- `docs/ux/`, especially form, error, accessibility, responsive, and destructive-action rules;
- Phase 1A implementation ADRs and engineering commands.

Run the full Phase 0 validator before and after the work. Do not edit `BUILD_ROADMAP.md`, mark the checklist complete, weaken existing gates, or push/commit unless the product owner asks.

## Prescribed security boundaries

- Use the existing modular monolith. Identity owns authentication; it grants no workspace authority. A valid account/session alone must never imply tenant access.
- Store opaque session and one-time tokens only as SHA-256 hashes of at least 256 bits of cryptographically secure random input. Show or send raw tokens once only.
- Hash passwords with Argon2id. Record algorithm/version/parameters with the credential so parameters can be raised on successful authentication. Choose defensible server-benchmarked defaults, impose a maximum input byte length, and document the benchmark. Never silently truncate.
- Use server-side sessions in PostgreSQL and an opaque cookie. Do not use a self-contained JWT as the browser session.
- The session cookie must be `HttpOnly`, `Secure` outside explicit local HTTP development, `SameSite=Lax` or stricter, host-only where deployment permits, narrowly pathed, and rotated on sign-in, password reset, privilege-sensitive changes, and MFA completion. Protect state-changing cookie-authenticated requests against CSRF using an origin check plus a synchronizer or signed double-submit token.
- Never reveal whether an account exists through registration, verification resend, password recovery, status code, body, timing class, email behavior visible to the caller, or rate-limit response.
- Verification, recovery, MFA, OAuth, and session secrets are C4 and must never enter logs, traces, metrics, audit values, error reports, URLs copied to third parties, or ordinary application tables in plaintext.
- MFA secrets must use the existing secret-store/KMS adapter boundary. For local/test only, provide an explicitly non-production adapter with strict startup rejection in production modes.
- OAuth in this phase means a secure provider-neutral boundary plus one deterministic local/test provider. Do not choose or ship a real commercial identity provider without product-owner approval.
- Published expiry periods, account lockout promises, and global rate-limit numbers remain unset. Use named configuration with safe defaults and document that these are operational defaults, not promises.

## Required data model and migrations

Extend the ordered migration stream without editing previously applied migrations. Create the `identity` schema and implement the accepted entities:

- `identity.account`: stable internal and public IDs, canonical primary email, display name, IANA timezone, locale, day-start offset, email-verification state/time, row version, created/updated/deleted timestamps, and pseudonymization support. Enforce case-insensitive uniqueness with race-safe database constraints.
- `identity.credential`: one-to-one account credential, password hash plus algorithm/parameter metadata, password-change time, failed-attempt metadata needed for abuse controls, and strict column privileges.
- `identity.mfa_factor`: factor type/state, label, secret reference or WebAuthn public credential data, recovery-code hashes where applicable, created/verified/last-used/revoked times, and optimistic versioning. Never store a TOTP seed or recovery code in plaintext.
- `identity.session`: account, token hash, creation/last-seen/idle/absolute expiry, revoked time/reason, credential/MFA assurance, rotation lineage, and privacy-minimized device metadata. Do not store raw IP addresses indefinitely; document the bounded security representation and retention.
- `identity.oauth_identity`: provider and immutable subject, account, provider email/display metadata only when needed, link/unlink state, and unique `(provider, subject)`.
- `identity.verification_token`: explicit purpose, subject/account reference as appropriate, token hash, expiry, consumed/revoked times, attempt state, and issuance lineage. A token is single-use and purpose-bound.
- `identity.step_up_challenge`: exactly the accepted Phase 0D fields and states, including session/account/membership/workspace/action/target binding, methods, nonce/token hashes, attempts, expiry, and consumption.

Add indexes for token lookup, active session listing, expiry cleanup, case-insensitive email lookup, and abuse-control queries. Add check constraints for states and timestamp ordering. Identity is platform-scoped; do not fabricate tenant RLS on identity rows. Instead use narrowly privileged repository methods, column grants, and server-side ownership checks.

Provide reversible down migrations for local/test verification. Do not couple this migration to Phase 1F tables: emit security events through a typed port with a durable Phase 1A outbox fallback until 1F supplies the final sink.

## Required API and browser flows

Use Phase 0D envelopes, public IDs, error vocabulary, idempotency rules, request IDs, and safe errors. Exact route grouping may follow existing conventions, but provide these behaviors:

### Registration and email verification

- Registration accepts email, password, display name, locale/timezone defaults, required legal acknowledgements as version references, and explicit anti-bot proof through an adapter when configured.
- Normalize email for comparison without making unsupported assumptions about provider-specific aliases. Preserve an appropriate display/delivery form.
- Return the same safe acknowledgement whether a new account was created, an unverified account already exists, or the email belongs to an existing account.
- Create or rotate a single-use verification token transactionally and enqueue delivery through a provider-neutral mail adapter using the durable outbox. Do not send mail inside the request transaction.
- Implement verification, resend with cooldown, expired/already-used handling, and a clear recovery route.
- Do not create a workspace automatically; successful verification continues to a Phase 1C-compatible onboarding placeholder.

### Sign-in and sign-out

- Support email/password sign-in with generic failure responses, abuse controls, optional MFA continuation, session fixation protection, and credential rehash on successful sign-in when parameters are outdated.
- Issue a server-side session and secure cookie only after all required factors succeed.
- Implement current-session sign-out and an all-own-sessions revocation operation. Revocation must affect the next request, not merely cookie expiry.
- Provide `GET /v1/auth/me` with account identity and assurance state only. Do not include memberships or infer a workspace.

### Password recovery

- Recovery request always returns a generic acknowledgement and schedules delivery through the outbox.
- Reset tokens are short-lived, single-use, purpose-bound, superseded safely, and consumed atomically with credential replacement.
- A successful reset rotates the credential and revokes every existing session and outstanding recovery token for the account. It must not automatically sign the user in unless a separately documented, security-reviewed session issuance step succeeds.
- Notify the account through the mail adapter after a password change without including sensitive metadata.

### Session management

- Provide an authenticated UI/API to list one's sessions with privacy-safe device/browser approximation, created time, last activity, current-session marker, and revocation state.
- Allow revoking one other session and all other sessions. Make repeat revocation idempotent.
- Update `last_seen_at` with bounded write frequency rather than on every request.
- Enforce configurable idle and absolute expiry on every authenticated request. Expired/revoked sessions return the accepted unauthenticated response and clear the cookie.
- Build an internal, authorization-ready command for `sessions.manage_others`, but do not expose admin session management before Phase 1D supplies memberships and permissions.

### MFA foundation

- Fully implement TOTP enrollment, confirmation, challenge, disablement, and one-time recovery codes. Generate recovery codes once, show once, store only hashes, allow regeneration, and invalidate the previous set atomically.
- Require current password or an already valid high-assurance proof before enrolling, regenerating, or disabling MFA. Disabling MFA and recovery-code regeneration must use the step-up protocol.
- Prevent an account from being left without a usable sign-in/recovery method through an accidental partial operation.
- Add a WebAuthn-capable adapter/data boundary and challenge contract, but a production WebAuthn UI is not required in this brief. Do not claim WebAuthn support until it is end-to-end tested.

### OAuth-ready sign-in boundary

- Define provider adapters for authorization request creation, state/nonce/PKCE validation, code exchange, and immutable provider-subject retrieval.
- Implement and test the flow against a deterministic local/test provider, including replay, state mismatch, nonce mismatch, expired callback, provider denial, and account-link collision.
- Do not auto-link solely because provider email matches an existing account. Require an authenticated link flow or an explicit verified-email policy approved for that provider later.
- Provide account UI for viewing and unlinking identities; refuse unlinking when it would remove the last usable sign-in method.

### Step-up authentication

- Implement the Phase 0D challenge, verify, cancel, token, and consumption protocol exactly, including `stp_` public IDs, action/target/session/account/membership binding, same idempotency key on retry, single use, expiry, rate-limited failures, and locked challenges.
- Support password, TOTP, and recovery-code proofs according to the account's configured methods. Preserve the original form input client-side and automatically retry after successful verification.
- A step-up proof never extends the session. Non-human principals receive `step_up_unavailable`.
- Because memberships arrive later, support nullable membership/workspace only for account-level actions; reject tenant action challenges without a concrete membership/workspace rather than weakening the binding.

## Abuse protection and input safety

- Add layered, adapter-backed rate limiting for registration, sign-in, resend, recovery, token verification, MFA, and OAuth callbacks using privacy-preserving keys. Include per-source and per-account/email-derived dimensions without storing plaintext identifiers in the limiter.
- Use escalating delays and bounded temporary challenge/account protections; do not create a permanent denial-of-service vector through unauthenticated lockout.
- Make responses enumeration-resistant and add bounded request sizes, schema validation, Unicode handling, safe redirects, and allow-listed return paths.
- Add hooks for edge-level bot protection but keep local/test deterministic and free of paid services.
- Record security-relevant outcomes through a typed event port. Never record passwords, raw tokens, proofs, TOTP secrets, recovery codes, OAuth codes, cookies, complete IP addresses, or user agents as unrestricted values.

## UX, responsive, and accessibility requirements

Build polished routes/screens for register, verify-email pending/result, sign-in, forgot/reset password, MFA challenge, account security, session list/revocation, MFA setup/recovery codes, OAuth identities, and step-up modal/page.

- Follow the accepted 0E tokens and form patterns; do not create a second design system.
- Every flow must cover initial, submitting, success, invalid, expired, rate-limited, offline, server-error, and safe retry states.
- Validation summaries and field errors must be programmatically associated, keyboard accessible, announced appropriately, and must not clear valid input after failure.
- Focus must move predictably on route changes and modal errors. Password-manager paste/autofill must work; do not block paste.
- Provide show-password controls with accessible names, Caps Lock indication where feasible, and password requirements before submission.
- Recovery codes must support copy/download/print with explicit confirmation that the user stored them; ensure they do not enter analytics or logs.
- Session revocation and MFA disablement require clear confirmation proportional to impact. Do not use dark patterns.
- Support desktop, tablet, and narrow mobile layouts, 200% zoom, reduced motion, high contrast, and screen-reader operation.

## Email delivery boundary

- Create templates for verification, password reset, password-changed alert, and security-sensitive session/MFA notifications.
- In local/test, capture mail in a deterministic in-memory or local mailbox visible only to tests/developers. No real provider is required.
- Links must use an allow-listed configured public origin, contain only the opaque one-time token, and avoid email addresses or internal IDs.
- Outbox retries are at-least-once; token consumption makes duplicate delivery harmless. Avoid exposing account existence through delivery behavior.

## Observability, privacy, and maintenance

- Add bounded metrics for outcome classes and latency by flow, rate-limit activations, active/revoked session counts as safe aggregates, token cleanup, and mail enqueue/delivery outcomes. No email, account, session, IP, token, provider subject, or error text may be a metric label.
- Propagate request/correlation/trace context through mail and cleanup jobs.
- Add cleanup jobs for expired/consumed verification tokens, challenges, and sessions using the Phase 1A worker. Jobs must be idempotent, leased, retryable, and workspace-free platform jobs through an explicitly safe path.
- Add log/redaction tests for all identity inputs and outputs.
- Document data classifications, retention configuration hooks, operational response for credential compromise, session revocation semantics, and how 1D will connect membership policy.

## Required automated tests

At minimum, include:

- unit tests for normalization, password limits/hash verification/rehash, token hashing, expiry, cookie flags, CSRF/origin checks, TOTP windows, recovery codes, redirect safety, and limiter keys;
- migration up/down/checksum and constraint/index tests on real PostgreSQL;
- API integration tests for every happy path and error state above;
- concurrency tests for duplicate registration, simultaneous token consumption, password reset versus sign-in, session rotation, duplicate MFA verification, and OAuth callback replay;
- enumeration tests comparing response status/body shape and bounded timing behavior for existing/non-existing accounts;
- session fixation, revoked-next-request, idle/absolute expiry, all-session revocation, pooled-connection isolation, and cookie/CSRF tests;
- OAuth state/nonce/PKCE and unsafe-linking tests with the local provider;
- step-up binding, single-use, same-idempotency-key retry, cancellation, expiry, lockout, wrong action/target/session, and non-human denial tests;
- browser tests for registration through verification, password reset, sign-in/out, TOTP enrollment/challenge/recovery, remote sign-out, and step-up continuation at desktop and mobile widths;
- accessibility checks plus keyboard-only critical paths;
- security redaction tests and existing Phase 1A RLS/job/image gates.

Use a real PostgreSQL container for integration acceptance. Tests may inspect captured local mail, but must never print raw secrets into CI output or retained reports.

## Non-goals

- Workspace/brand creation or selection (1C).
- Memberships, invitations, roles, guest access, workspace security-policy administration, or admin revocation of another user (1D).
- Final application shell/navigation (1E).
- Final immutable audit/security-event tables, deletion batches, tombstones, and recovery UI (1F). Use the typed port described above.
- Personal API tokens, service principals, OAuth client authorization/consent, or integration OAuth connections (later phases).
- A production email, OAuth, CAPTCHA, KMS, or hosting vendor.
- Social-provider-specific account-link policy.
- Production WebAuthn claims.

## Acceptance criteria

- A new person can register, receive a captured verification email, verify, sign in, complete required TOTP, and sign out through accessible responsive UI.
- Password recovery is enumeration-safe, single-use, transactional, and revokes all sessions.
- Users can list and remotely revoke their own sessions; revocation takes effect on the next request.
- TOTP and recovery-code lifecycle works without plaintext secret persistence or leakage.
- The local/test OAuth flow proves the provider-neutral boundary and rejects replay or unsafe linking.
- Step-up is action/target/session bound, single-use, and correctly resumes an idempotent action.
- Identity never grants tenant authority and no 1C/1D behavior is prematurely implemented.
- Abuse controls, CSRF defenses, cookie settings, input validation, observability redaction, cleanup jobs, migrations, real-database tests, browser tests, accessibility checks, scans, and the complete existing verification pipeline pass.
- Phase 0 validation remains green and the production image still passes its full smoke gate.

## Required completion response

Return:

1. Outcome summary and exact runtime/package versions changed.
2. Every file changed and each migration added.
3. Data-model and security decisions, including Argon2id benchmark/parameters, session/token design, cookie/CSRF rules, expiry configuration, IP/device minimization, and secret adapter behavior.
4. Implemented API routes, browser flows, email templates, jobs, and explicit deferred items.
5. Test inventory and counts by unit, database/integration, browser, accessibility, security, and concurrency category.
6. The clean verification command, exit status, immutable CI run/commit if used, and confirmation that Testcontainers and production-image gates ran without skips.
7. Scan results and evidence that no raw credential, token, MFA secret, recovery code, OAuth code, cookie, email, or full IP leaked into logs/artifacts.
8. Any deviation, limitation, failed/skipped gate, or decision needing product-owner approval.

Do not call Phase 1B complete if any required gate is skipped, a real identity provider is silently selected, or workspace authority is inferred from authentication.
