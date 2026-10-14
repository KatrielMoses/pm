# 11. Authentication scopes and step-up protocol (resolves AQ-02 and AQ-05)

## 11.1 Scope vocabulary (AQ-02)

There are 19 scopes, in the format `<family>:<access>` ([generated/registries.md](generated/registries.md#token-and-oauth-scopes)). Each maps to 0C action keys and lists the principal types that may hold it. The validator checks both against 0C.

| Rule | Contract |
|---|---|
| Meaning | A scope **limits** which action families a credential may attempt. It never grants record access: effective access = principal's current access (0C §4) ∩ scope ∩ brand list. |
| Brand list | Tokens and OAuth grants may carry `brands: [br_…]`. Requests outside the list behave as if those brands' records do not exist (`not_found` error). |
| Personal API tokens | Any subset of scopes the creator could use. Write scopes need step-up at creation (0C §9.6). Expiry is bounded by workspace policy. |
| Service principals | Scopes from the registry for `service_principal`, plus explicit grants. Never scopes for step-up actions (validator rule). |
| OAuth / MCP clients | The client registration declares the maximum scopes. A member grants a subset and optional brand allow-list. Tokens are workspace-bound, short-lived, and hash-only; consent/client revocation invalidates them at the next request. Refresh is not part of the 6E foundation. |
| Integration connections | Internal capability set derived from configured features (sync directions, mapped scopes). Provider OAuth scopes are separate and recorded on the connection. |
| Run-bound agent credentials | Issued per agent run for external agents. Scopes are derived from the run's granted tool classes (0C §9.3). Bound to `op_…` and the run scope snapshot. **Expires when the run reaches a terminal state** or on cancel or emergency stop. Never usable for step-up actions. |
| Inbound webhooks | Fixed to one intake action (for example `tests:ingest` or `capture:write`) |

## 11.2 Step-up challenges (AQ-05)

Step-up applies to the 27 actions flagged SU in the 0C matrix (all R4 actions, the 0E ST-33 cases, and the three personal account-security actions `account.mfa_enroll`, `account.mfa_disable`, and `account.recovery_codes_regenerate`).

1. A request for a step-up action without a valid step-up token returns the `step_up_required` error with a `step-up-challenge` object:
   - `id: stp_…`, `action_key`;
   - `target` (record reference, if any);
   - `methods` (`password`, `totp`, `webauthn`, `recovery_code`, per account configuration);
   - `expires_at` (`STEP_UP_CHALLENGE_LIFETIME`);
   - `state: pending`;
   - `verify` and `cancel` links.
2. The client completes `POST /v1/auth/step-up/{stp}:verify` with the method's proof. WebAuthn uses a server nonce bound to the challenge ID.
3. On success the server returns a **step-up token**:
   - bound to (session, account, membership, `action_key`, target hash);
   - single-use;
   - valid for `STEP_UP_WINDOW`.
4. The client retries the original request with header `Step-Up: <token>` and the **same** `Idempotency-Key`.
5. The server verifies the binding, consumes the token (single use, so replay fails with `step_up_required`), and proceeds. All other checks (authorization, approvals) still run.

| Concern | Rule |
|---|---|
| Replay | Tokens are single-use and bound to session, action, and target. Challenges expire. Failed verifications are rate-limited, and repeated failures lock the challenge. |
| Locking | The failed verification that reaches `STEP_UP_MAX_ATTEMPTS` atomically stores `state: locked` (terminal). A locked challenge never verifies or yields a token, even if the parameter later changes. Further attempts return `rate_limited` and change nothing. Cancelling it changes nothing. It is removed with other expired challenges. |
| Cancellation | `POST …/{stp}:cancel` → `state: cancelled`. The original action does not proceed. |
| Audit | `security-event` with category `step_up` for challenge issued, verified, failed, and consumed, and the consuming action's audit event references the step-up ID |
| UI continuation | The original request's input is preserved client-side (0E ST-02). After verification the client resubmits automatically and shows the result. |
| Non-human principals | Tokens, service principals, agents, automations, and integrations receive the `step_up_unavailable` error. Step-up is human-only. |
| Session freshness | A step-up never extends the session. It is a separate, action-scoped proof. |
