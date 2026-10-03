import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  Browser,
  identityEnv,
  idemKey,
  mailTo,
  PASSWORD,
  registerAndVerify,
  signIn,
  tokenFrom,
  totpNow,
  type IdentityEnv,
} from './identity-helpers.ts';

describe('identity: OAuth boundary (local provider)', () => {
  let env: IdentityEnv;

  beforeAll(async () => {
    env = await identityEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  /** Starts a flow and drives the local provider's consent step; returns the callback URL. */
  async function authorize(
    b: Browser,
    intent: 'sign_in' | 'link',
    loginHint: string,
    decision: 'approve' | 'deny' = 'approve',
  ): Promise<string> {
    const start = await b.post('/v1/auth/oauth/local:start', {
      intent,
      return_to: intent === 'link' ? '/account/security' : '/onboarding',
    });
    expect(start.statusCode).toBe(200);
    const url = new URL(start.json().data.url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    url.searchParams.set('decision', decision);
    url.searchParams.set('login_hint', loginHint);
    const consent = await b.get(`${url.pathname}${url.search}`);
    expect(consent.statusCode).toBe(303);
    return (
      new URL(consent.headers.location as string).pathname +
      new URL(consent.headers.location as string).search
    );
  }

  const location = (r: LightMyRequestResponse) => r.headers.location as string;

  it('links an identity from an authenticated session and signs in with it afterwards', async () => {
    const b = new Browser(env.app);
    await registerAndVerify(env, b, 'oauth-link@example.test');
    await signIn(b, 'oauth-link@example.test');
    const callback = await authorize(b, 'link', 'linker');
    const done = await b.get(callback);
    expect(done.statusCode).toBe(303);
    expect(location(done)).toBe('/account/security?linked=1');
    const ids = (await b.get('/v1/auth/oauth/identities')).json().data;
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatchObject({ provider: 'local', type: 'oauth_identity' });
    expect(ids[0].id).toMatch(/^oid_/);
    const fresh = new Browser(env.app);
    const signedIn = await fresh.get(await authorize(fresh, 'sign_in', 'linker'));
    expect(location(signedIn)).toBe('/onboarding');
    expect(fresh.session).toBeDefined();
    expect((await fresh.get('/v1/auth/me')).json().data.session.auth_methods).toEqual(['oauth']);
  });

  it('never links by matching email and reports unlinked subjects', async () => {
    const b = new Browser(env.app);
    // The local provider asserts "<hint>@local.test"; an account with that address exists.
    await registerAndVerify(env, b, 'victim@local.test');
    const attacker = new Browser(env.app);
    const r = await attacker.get(await authorize(attacker, 'sign_in', 'victim'));
    expect(location(r)).toBe('/sign-in?oauth_error=not_linked');
    expect(attacker.session).toBeUndefined();
    const links = await env.db.admin(
      `SELECT count(*)::int AS n FROM identity.oauth_identity WHERE subject = 'local|victim'`,
    );
    expect(links.rows[0].n).toBe(0);
  });

  it('rejects state mismatch, replayed callbacks, expired state, denial, and nonce mismatch', async () => {
    const b = new Browser(env.app);
    await registerAndVerify(env, b, 'oauth-errors@example.test');
    await signIn(b, 'oauth-errors@example.test');
    await b.get(await authorize(b, 'link', 'errs'));
    const fresh = new Browser(env.app);
    // State mismatch: a well-formed state that was never issued.
    const forged = await fresh.get(
      `/v1/auth/oauth/local/callback?state=${'A'.repeat(43)}&code=whatever`,
    );
    expect(location(forged)).toBe('/sign-in?oauth_error=state_invalid');
    // Replay: the same callback twice.
    const cb = await authorize(fresh, 'sign_in', 'errs');
    expect(location(await fresh.get(cb))).toBe('/onboarding');
    expect(location(await new Browser(env.app).get(cb))).toBe('/sign-in?oauth_error=replay');
    // Expired state.
    const late = new Browser(env.app);
    const lateCb = await authorize(late, 'sign_in', 'errs');
    await env.db.admin(
      `UPDATE identity.verification_token SET expires_at = now() - interval '1 second', created_at = now() - interval '1 hour' WHERE purpose = 'oauth_state' AND consumed_at IS NULL`,
    );
    expect(location(await late.get(lateCb))).toBe('/sign-in?oauth_error=state_expired');
    // Provider denial.
    const denied = new Browser(env.app);
    expect(location(await denied.get(await authorize(denied, 'sign_in', 'errs', 'deny')))).toBe(
      '/sign-in?oauth_error=denied',
    );
    // Nonce mismatch in the returned claims.
    const n = new Browser(env.app);
    const nonceCb = await authorize(n, 'sign_in', 'errs');
    env.localOAuth.tamperNonce = true;
    try {
      expect(location(await n.get(nonceCb))).toBe('/sign-in?oauth_error=nonce_mismatch');
    } finally {
      env.localOAuth.tamperNonce = false;
    }
    // PKCE / code replay at the provider: a code exchanged once cannot be exchanged again.
    await expect(
      env.localOAuth.exchangeCode({ code: 'never-issued', codeVerifier: 'x', redirectUri: 'y' }),
    ).rejects.toMatchObject({ reason: 'invalid_grant' });
  });

  it('refuses link collisions and links only from the session that started the flow', async () => {
    const a = new Browser(env.app);
    const c = new Browser(env.app);
    await registerAndVerify(env, a, 'owner-a@example.test');
    await registerAndVerify(env, c, 'owner-c@example.test');
    await signIn(a, 'owner-a@example.test');
    await signIn(c, 'owner-c@example.test');
    await a.get(await authorize(a, 'link', 'shared'));
    const collision = await c.get(await authorize(c, 'link', 'shared'));
    expect(location(collision)).toBe('/account/security?oauth_error=link_collision');
    // A link flow started by A cannot be completed by C's browser.
    const hijack = await authorize(a, 'link', 'other-subject');
    expect(location(await c.get(hijack))).toBe(
      '/account/security?oauth_error=link_session_mismatch',
    );
  });

  it('unlinks identities but never the last usable sign-in method', async () => {
    const b = new Browser(env.app);
    await registerAndVerify(env, b, 'unlink@example.test');
    await signIn(b, 'unlink@example.test');
    await b.get(await authorize(b, 'link', 'unlinker'));
    const [identity] = (await b.get('/v1/auth/oauth/identities')).json().data;
    // Simulate an OAuth-only account (no password credential) to exercise the guard.
    await env.db.admin(
      `DELETE FROM identity.credential WHERE account_id = (SELECT id FROM identity.account WHERE email_key = 'unlink@example.test')`,
    );
    const refused = await b.post(`/v1/auth/oauth/identities/${identity.id}:unlink`);
    expect(refused.json().error.issues[0].code).toBe('last_sign_in_method');
    await env.db.admin(
      `INSERT INTO identity.credential (account_id, password_hash, password_salt, algorithm, params) SELECT id, decode(repeat('00', 32), 'hex'), decode(repeat('00', 16), 'hex'), 'argon2id', '{"v":19,"m":19456,"t":2,"p":1,"len":32}' FROM identity.account WHERE email_key = 'unlink@example.test'`,
    );
    expect((await b.post(`/v1/auth/oauth/identities/${identity.id}:unlink`)).statusCode).toBe(200);
    expect((await b.get('/v1/auth/oauth/identities')).json().data).toEqual([]);
  });

  it('requires MFA after an OAuth first factor when TOTP is enabled', async () => {
    const b = new Browser(env.app);
    await registerAndVerify(env, b, 'oauth-mfa@example.test');
    await signIn(b, 'oauth-mfa@example.test');
    const key = idemKey();
    const ch = (
      await b.post('/v1/auth/mfa/totp:enroll', {}, { headers: { 'idempotency-key': key } })
    ).json().error.step_up;
    const tok = (
      await b.post(`/v1/auth/step-up/${ch.id}:verify`, { method: 'password', proof: PASSWORD })
    ).json().data.token;
    const { id, secret } = (
      await b.post(
        '/v1/auth/mfa/totp:enroll',
        {},
        { headers: { 'idempotency-key': key, 'step-up': tok } },
      )
    ).json().data;
    await b.post(
      '/v1/auth/mfa/totp:confirm',
      { factor: id, code: totpNow(secret) },
      { headers: { 'idempotency-key': idemKey() } },
    );
    await b.get(await authorize(b, 'link', 'mfa-user'));
    const fresh = new Browser(env.app);
    const r = await fresh.get(await authorize(fresh, 'sign_in', 'mfa-user'));
    expect(location(r)).toBe('/sign-in/verify');
    expect(fresh.session).toBeUndefined();
    expect(
      (await fresh.post('/v1/auth/sign-in:mfa', { method: 'totp', code: totpNow(secret, 1) }))
        .statusCode,
    ).toBe(200);
    expect((await fresh.get('/v1/auth/me')).json().data.session.auth_methods).toEqual([
      'oauth',
      'totp',
    ]);
  });
});

describe('identity: abuse controls, timing, jobs, and redaction', () => {
  let env: IdentityEnv;

  beforeAll(async () => {
    env = await identityEnv({
      RATE_LIMIT_POLICIES: JSON.stringify({
        'sign_in.email': { limit: 3, windowMs: 60_000 },
        'sign_in.source': { limit: 1000, windowMs: 60_000 },
        'register.source': { limit: 1000, windowMs: 60_000 },
        'register.email': { limit: 1000, windowMs: 60_000 },
        'recovery.source': { limit: 1000, windowMs: 60_000 },
        'recovery.email': { limit: 2, windowMs: 60_000 },
        'token.source': { limit: 1000, windowMs: 60_000 },
      }),
      AUTH_RESPONSE_FLOOR_MS: '250',
    });
  });
  afterAll(async () => {
    await env.close();
  });

  it('rate-limits per email key with escalating, bounded blocks and identical responses for unknown emails', async () => {
    const b = new Browser(env.app);
    await registerAndVerify(env, b, 'limited@example.test');
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++)
      statuses.push((await signIn(b, 'limited@example.test', 'wrong password!!')).statusCode);
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    const unknown: number[] = [];
    for (let i = 0; i < 5; i++)
      unknown.push((await signIn(b, 'nobody-limited@example.test', 'wrong password!!')).statusCode);
    expect(unknown).toEqual(statuses); // limiter behaviour is identical for unknown addresses
    const blocked = await signIn(b, 'limited@example.test');
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(15 * 60);
    // The limiter stores only keyed hashes.
    const buckets = JSON.stringify(
      (await env.db.admin(`SELECT policy, encode(key_hash,'hex') FROM ops.rate_limit_bucket`)).rows,
    );
    expect(buckets).not.toContain('limited@example.test');
    expect(buckets).not.toContain('203.0.113');
  });

  it('keeps registration, resend, and recovery responses in one timing class', async () => {
    const b = new Browser(env.app);
    await registerAndVerify(env, b, 'timed@example.test');
    const time = async (fn: () => Promise<unknown>) => {
      const s = performance.now();
      await fn();
      return performance.now() - s;
    };
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 3; i++) {
      known.push(
        await time(() =>
          new Browser(env.app).post('/v1/auth/email:resend', { email: 'timed@example.test' }),
        ),
      );
      unknown.push(
        await time(() =>
          new Browser(env.app).post('/v1/auth/email:resend', { email: `absent-${i}@example.test` }),
        ),
      );
    }
    const median = (xs: number[]) => xs.sort((x, y) => x - y)[1]!;
    for (const t of [...known, ...unknown]) expect(t).toBeGreaterThanOrEqual(240);
    expect(Math.abs(median(known) - median(unknown))).toBeLessThan(120);
  });

  it('delivers mail at least once with links built from the public origin, then destroys the token copy', async () => {
    const b = new Browser(env.app);
    await b.post('/v1/auth/register', {
      email: 'mailer@example.test',
      password: PASSWORD,
      display_name: 'Mailer',
      terms_version: env.identity.config.legal.termsVersion,
      privacy_version: env.identity.config.legal.privacyVersion,
      bot_proof: 'test-pass',
    });
    const pending = await env.db.admin(
      `SELECT count(*)::int AS n FROM ops.dev_secret_vault WHERE purpose = 'mail_token'`,
    );
    expect(pending.rows[0].n).toBeGreaterThan(0);
    await env.deliverMail();
    const m = mailTo(env, 'mailer@example.test', 'verify');
    expect(m).toHaveLength(1);
    expect(m[0]!.html).toContain(
      `${env.identity.config.publicOrigin}/verify-email/confirm#token=${tokenFrom(m[0])}`,
    );
    const sent = await env.db.admin(
      `SELECT state, sealed_ref FROM identity.mail_delivery WHERE recipient = 'mailer@example.test'`,
    );
    expect(sent.rows[0].state).toBe('sent');
    const remaining = await env.db.admin(
      `SELECT count(*)::int AS n FROM ops.dev_secret_vault WHERE ref = $1`,
      [sent.rows[0].sealed_ref],
    );
    expect(remaining.rows[0].n).toBe(0);
    // Re-running the job for an already-sent delivery sends nothing new.
    await env.db
      .admin(`INSERT INTO exec.job (id, workspace_id, queue, kind, max_attempts, timeout_seconds, payload_ref, authenticated_principal_type, authenticated_principal_id, effective_principal_type, effective_principal_id, delegation_chain, workspace_epoch_at_enqueue, principal_epoch_at_enqueue, data_class_limit, correlation_id)
      SELECT '01920000-0000-7000-8000-0000000000aa', NULL, 'mail', 'identity.mail.deliver', 3, 30, 'mail:' || id, 'system_job', '01920000-0000-7000-8000-000000000002', 'system_job', '01920000-0000-7000-8000-000000000002', '[{"type":"system_job","id":"01920000-0000-7000-8000-000000000002"}]', 0, 0, 'C3', correlation_id FROM identity.mail_delivery WHERE recipient = 'mailer@example.test'`);
    const before = env.transport.messages.length;
    await env.deliverMail();
    expect(env.transport.messages.length).toBe(before);
  });

  it('cleanup removes expired tokens, ended sessions, challenges, mail, and secrets; it is idempotent', async () => {
    const b = new Browser(env.app);
    await registerAndVerify(env, b, 'cleanup@example.test');
    await signIn(b, 'cleanup@example.test');
    await b.post('/v1/auth/sign-out');
    await env.db.admin(
      `UPDATE identity.session SET revoked_at = now() - interval '400 days', created_at = now() - interval '401 days', last_seen_at = now() - interval '401 days', idle_expires_at = now() - interval '400 days', absolute_expires_at = now() - interval '399 days' WHERE revoked_at IS NOT NULL`,
    );
    await env.db.admin(
      `UPDATE identity.verification_token SET created_at = now() - interval '10 days', expires_at = now() - interval '9 days', consumed_at = CASE WHEN consumed_at IS NULL THEN NULL ELSE now() - interval '9 days' END, revoked_at = CASE WHEN revoked_at IS NULL THEN NULL ELSE now() - interval '9 days' END`,
    );
    await env.db.admin(`UPDATE identity.mail_delivery SET created_at = now() - interval '30 days'`);
    const count = async (t: string) =>
      (await env.db.admin(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n as number;
    expect(await count('identity.session')).toBeGreaterThan(0);
    // Earlier worker cycles already ran the recurring sweep; advance its clock past the interval.
    expect(await env.worker.enqueueDueSchedules(Date.now() + 16 * 60_000)).toBe(1);
    await env.deliverMail(); // runs every due platform job, including the sweep
    const job = await env.db.admin(
      `SELECT state FROM exec.job WHERE kind = 'identity.cleanup' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(job.rows[0].state).toBe('succeeded');
    expect(await count(`identity.session WHERE revoked_at < now() - interval '1 day'`)).toBe(0);
    expect(
      await count(`identity.verification_token WHERE expires_at < now() - interval '2 days'`),
    ).toBe(0);
    expect(await count('identity.mail_delivery')).toBe(0);
    // Second run (dedupe key allows a new instance once the first finished): nothing left, no errors.
    expect(await env.worker.enqueueDueSchedules(Date.now() + 60 * 60_000)).toBe(1);
    await env.deliverMail();
    const states = await env.db.admin(`SELECT state FROM exec.job WHERE kind = 'identity.cleanup'`);
    expect(states.rows.every((r) => r.state === 'succeeded')).toBe(true);
  });

  it('never writes passwords, tokens, MFA seeds, recovery codes, OAuth codes, cookies, emails, or full IPs to logs, spans, metrics, or security events', async () => {
    const b = new Browser(env.app);
    await registerAndVerify(env, b, 'redact-me@example.test');
    await signIn(b, 'redact-me@example.test');
    await b.post('/v1/auth/password:forgot', { email: 'redact-me@example.test' });
    await env.deliverMail();
    const token = tokenFrom(mailTo(env, 'redact-me@example.test', 'reset').at(-1));
    await b.post('/v1/auth/password:reset', { token, password: 'Zz-unique-passphrase-91' });
    await signIn(b, 'redact-me@example.test', 'Zz-unique-passphrase-91');
    await b.get('/v1/auth/me');
    // MFA: step-up token, TOTP seed, recovery codes.
    const key = idemKey();
    const ch = (
      await b.post('/v1/auth/mfa/totp:enroll', {}, { headers: { 'idempotency-key': key } })
    ).json().error.step_up;
    const stepUpToken = (
      await b.post(`/v1/auth/step-up/${ch.id}:verify`, {
        method: 'password',
        proof: 'Zz-unique-passphrase-91',
      })
    ).json().data.token as string;
    const { id, secret } = (
      await b.post(
        '/v1/auth/mfa/totp:enroll',
        {},
        { headers: { 'idempotency-key': key, 'step-up': stepUpToken } },
      )
    ).json().data;
    const codes = (
      await b.post(
        '/v1/auth/mfa/totp:confirm',
        { factor: id, code: totpNow(secret) },
        { headers: { 'idempotency-key': idemKey() } },
      )
    ).json().data.codes as string[];
    // OAuth: authorization code and state from the provider redirect.
    const start = await b.post('/v1/auth/oauth/local:start', {
      intent: 'link',
      return_to: '/account/security',
    });
    const consentUrl = new URL(start.json().data.url);
    consentUrl.searchParams.set('decision', 'approve');
    consentUrl.searchParams.set('login_hint', 'redactor');
    const consent = await b.get(`${consentUrl.pathname}${consentUrl.search}`);
    const callback = new URL(consent.headers.location as string);
    expect((await b.get(callback.pathname + callback.search)).statusCode).toBe(303);
    // A second device signs in with a recovery code.
    const other = new Browser(env.app);
    await signIn(other, 'redact-me@example.test', 'Zz-unique-passphrase-91');
    expect(
      (await other.post('/v1/auth/sign-in:mfa', { method: 'recovery_code', code: codes[0] }))
        .statusCode,
    ).toBe(200);
    await env.deliverMail();
    const logs = env.h.sink.lines.join('\n');
    const secrets = [
      PASSWORD,
      'Zz-unique-passphrase-91',
      token,
      b.session!,
      other.session!,
      b.csrf!,
      stepUpToken,
      secret,
      ...codes,
      ...codes.map((c) => c.replace(/-/g, '')),
      callback.searchParams.get('code')!,
      callback.searchParams.get('state')!,
      'redact-me@example.test',
      '203.0.113.10',
      'Macintosh; Intel Mac OS X',
    ];
    expect(secrets.every((s) => typeof s === 'string' && s.length >= 8)).toBe(true);
    // Labels are indexes: a failure must not print the secret into CI output.
    secrets.forEach((s, i) => expect(logs.includes(s), `log leak #${i}`).toBe(false));
    // Spans carry no identity values either.
    const spans = JSON.stringify(
      env.h.telemetry.spans!.getFinishedSpans().map((s) => s.attributes),
    );
    secrets.forEach((s, i) => expect(spans.includes(s), `span leak #${i}`).toBe(false));
    // Metric labels: flows and outcomes only.
    const { resourceMetrics } = await env.h.telemetry.metricReader!.collect();
    const labels = JSON.stringify(
      resourceMetrics.scopeMetrics.flatMap((sm) =>
        sm.metrics
          .filter(
            (m) =>
              m.descriptor.name.startsWith('identity.') || m.descriptor.name.startsWith('mail.'),
          )
          .flatMap((m) => m.dataPoints.map((d) => d.attributes)),
      ),
    );
    expect(labels).toContain('"flow":"sign_in"');
    secrets.forEach((s, i) => expect(labels.includes(s), `metric leak #${i}`).toBe(false));
    // Security events: minimized network context, no secrets.
    const events = JSON.stringify(
      (await env.db.admin(`SELECT * FROM identity.security_event_buffer`)).rows,
    );
    expect(events).toContain('203.0.113.0/24');
    secrets.forEach((s, i) => expect(events.includes(s), `event leak #${i}`).toBe(false));
  });
});
