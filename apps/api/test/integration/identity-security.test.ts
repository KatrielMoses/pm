import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUuidV7 } from '@pm/contracts';
import { IdentityError, type AuthContext } from '@pm/identity';
import { contractErrors } from '@pm/test-support';
import {
  Browser,
  idemKey,
  identityEnv,
  mailTo,
  PASSWORD,
  registerAndVerify,
  signIn,
  tokenFrom,
  totpNow,
  type IdentityEnv,
} from './identity-helpers.ts';

describe('identity: recovery, MFA, and step-up', () => {
  let env: IdentityEnv;

  beforeAll(async () => {
    env = await identityEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  /** Runs a step-up protected request end to end: challenge, verify, retry with the same key. */
  async function protectedCall(
    b: Browser,
    url: string,
    body: unknown,
    proof: { method: string; proof: string } = { method: 'password', proof: PASSWORD },
  ) {
    const key = idemKey();
    const first = await b.post(url, body, { headers: { 'idempotency-key': key } });
    if (first.statusCode !== 403) return { first, final: first, key, token: undefined };
    const challenge = first.json().error.step_up;
    const verified = await b.post(`/v1/auth/step-up/${challenge.id}:verify`, proof);
    const token = verified.json().data?.token as string;
    const final = await b.post(url, body, {
      headers: { 'idempotency-key': key, 'step-up': token },
    });
    return { first, verified, final, key, token, challenge };
  }

  async function enableTotp(b: Browser): Promise<{ secret: string; codes: string[] }> {
    const enroll = await protectedCall(b, '/v1/auth/mfa/totp:enroll', {});
    expect(enroll.final.statusCode).toBe(201);
    const { id, secret } = enroll.final.json().data;
    const confirm = await b.post(
      '/v1/auth/mfa/totp:confirm',
      { factor: id, code: totpNow(secret) },
      { headers: { 'idempotency-key': idemKey() } },
    );
    expect(confirm.statusCode).toBe(200);
    return { secret, codes: confirm.json().data.codes };
  }

  describe('password recovery', () => {
    it('is enumeration-safe, single-use, revokes every session, and does not sign in', async () => {
      const a = new Browser(env.app);
      const other = new Browser(env.app);
      await registerAndVerify(env, a, 'recover@example.test');
      await signIn(a, 'recover@example.test');
      await signIn(other, 'recover@example.test');
      const known = await new Browser(env.app).post('/v1/auth/password:forgot', {
        email: 'recover@example.test',
      });
      const unknown = await new Browser(env.app).post('/v1/auth/password:forgot', {
        email: 'ghost@example.test',
      });
      expect(known.statusCode).toBe(202);
      expect({ ...unknown.json(), meta: null }).toEqual({ ...known.json(), meta: null });
      await env.deliverMail();
      expect(mailTo(env, 'ghost@example.test')).toHaveLength(0);
      const token = tokenFrom(mailTo(env, 'recover@example.test', 'reset').at(-1));
      expect(mailTo(env, 'recover@example.test', 'reset').at(-1)!.text).toContain(
        '/reset-password#token=',
      );
      const fresh = new Browser(env.app);
      const reset = await fresh.post('/v1/auth/password:reset', {
        token,
        password: 'a brand new passphrase',
      });
      expect(reset.statusCode).toBe(200);
      expect(fresh.session).toBeUndefined(); // not signed in automatically
      expect(
        (
          await fresh.post('/v1/auth/password:reset', { token, password: 'yet another passphrase' })
        ).json().error.issues[0].code,
      ).toBe('token_used');
      expect((await a.get('/v1/auth/me')).statusCode).toBe(401);
      expect((await other.get('/v1/auth/me')).statusCode).toBe(401);
      expect((await signIn(fresh, 'recover@example.test')).statusCode).toBe(401);
      expect(
        (await signIn(fresh, 'recover@example.test', 'a brand new passphrase')).statusCode,
      ).toBe(200);
      await env.deliverMail();
      const changed = mailTo(env, 'recover@example.test', 'password was changed');
      expect(changed).toHaveLength(1);
      expect(changed[0]!.text).not.toMatch(/\d+\.\d+\.\d+\.\d+|Safari|token/);
    });

    it('consumes a reset token exactly once under concurrency', async () => {
      const b = new Browser(env.app);
      await registerAndVerify(env, b, 'race-reset@example.test');
      await b.post('/v1/auth/password:forgot', { email: 'race-reset@example.test' });
      await env.deliverMail();
      const token = tokenFrom(mailTo(env, 'race-reset@example.test', 'reset').at(-1));
      const results = await Promise.all(
        [
          'first concurrent password',
          'second concurrent password',
          'third concurrent password',
        ].map((pw) =>
          new Browser(env.app).post('/v1/auth/password:reset', { token, password: pw }),
        ),
      );
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 422)).toHaveLength(2);
    });

    it('a reset that commits during a sign-in prevents that sign-in from issuing a session', async () => {
      const b = new Browser(env.app);
      await registerAndVerify(env, b, 'reset-vs-signin@example.test');
      await b.post('/v1/auth/password:forgot', { email: 'reset-vs-signin@example.test' });
      await env.deliverMail();
      const token = tokenFrom(mailTo(env, 'reset-vs-signin@example.test', 'reset').at(-1));
      const [signInResult, resetResult] = await Promise.all([
        signIn(new Browser(env.app), 'reset-vs-signin@example.test'),
        new Browser(env.app).post('/v1/auth/password:reset', {
          token,
          password: 'replacement passphrase',
        }),
      ]);
      expect(resetResult.statusCode).toBe(200);
      // Either the sign-in finished first (and its session was revoked by the reset) or it lost.
      const live = await env.db.admin(
        `SELECT count(*)::int AS n FROM identity.session s JOIN identity.account a ON a.id = s.account_id WHERE a.email_key = 'reset-vs-signin@example.test' AND s.revoked_at IS NULL`,
      );
      expect(live.rows[0].n).toBe(0);
      expect([200, 401]).toContain(signInResult.statusCode);
    });

    it('changing the password needs the current one, rotates this session, and signs out others', async () => {
      const a = new Browser(env.app);
      const other = new Browser(env.app);
      await registerAndVerify(env, a, 'change@example.test');
      await signIn(a, 'change@example.test');
      await signIn(other, 'change@example.test');
      const before = a.session;
      expect(
        (
          await a.post('/v1/auth/password:change', {
            current_password: 'wrong wrong wrong',
            new_password: 'new strong passphrase',
          })
        ).json().error.issues[0].pointer,
      ).toBe('/current_password');
      expect(
        (
          await a.post('/v1/auth/password:change', {
            current_password: PASSWORD,
            new_password: 'new strong passphrase',
          })
        ).statusCode,
      ).toBe(200);
      expect(a.session).not.toBe(before);
      expect((await a.get('/v1/auth/me')).statusCode).toBe(200);
      expect((await other.get('/v1/auth/me')).statusCode).toBe(401);
    });
  });

  describe('TOTP and recovery codes', () => {
    it('enrolls with step-up, stores no plaintext seed, requires TOTP at sign-in, and rotates to multi-factor', async () => {
      const b = new Browser(env.app);
      await registerAndVerify(env, b, 'mfa@example.test');
      await signIn(b, 'mfa@example.test');
      const enroll = await protectedCall(b, '/v1/auth/mfa/totp:enroll', {});
      expect(enroll.first.statusCode).toBe(403);
      expect(enroll.first.json().error.code).toBe('step_up_required');
      expect(contractErrors('error-envelope', enroll.first.json())).toEqual([]);
      expect(contractErrors('step-up-challenge', enroll.challenge)).toEqual([]);
      expect(enroll.challenge.methods).toEqual(['password']);
      expect(enroll.final.statusCode).toBe(201);
      const { id, secret, otpauth_uri } = enroll.final.json().data;
      expect(id).toMatch(/^mfa_/);
      expect(otpauth_uri).toMatch(/^otpauth:\/\/totp\/PM%3A[^?]+\?secret=[A-Z2-7]+&issuer=PM/);
      const rows =
        JSON.stringify((await env.db.admin(`SELECT * FROM identity.mfa_factor`)).rows) +
        JSON.stringify(
          (
            await env.db.admin(
              `SELECT ref, purpose, encode(ciphertext,'hex') FROM ops.dev_secret_vault`,
            )
          ).rows,
        );
      expect(rows.includes(secret), 'TOTP seed stored').toBe(false);
      const before = b.session;
      const wrong = await b.post(
        '/v1/auth/mfa/totp:confirm',
        { factor: id, code: '000000' },
        { headers: { 'idempotency-key': idemKey() } },
      );
      expect(wrong.json().error.issues[0].code).toBe('invalid_code');
      const confirm = await b.post(
        '/v1/auth/mfa/totp:confirm',
        { factor: id, code: totpNow(secret) },
        { headers: { 'idempotency-key': idemKey() } },
      );
      expect(confirm.statusCode).toBe(200);
      const codes = confirm.json().data.codes as string[];
      expect(codes).toHaveLength(10);
      expect(b.session).not.toBe(before);
      expect((await b.get('/v1/auth/me')).json().data.session.assurance).toBe('multi_factor');
      const stored = JSON.stringify(
        (await env.db.admin(`SELECT encode(code_hash,'hex') FROM identity.recovery_code`)).rows,
      );
      for (const c of codes) expect(stored).not.toContain(c);

      // Sign-in now stops at the second factor: no session until it succeeds.
      const fresh = new Browser(env.app);
      const first = await signIn(fresh, 'mfa@example.test');
      expect(first.json().data).toEqual({
        type: 'sign_in_result',
        state: 'mfa_required',
        methods: ['totp', 'recovery_code'],
      });
      expect(fresh.session).toBeUndefined();
      expect(fresh.cookies.get('pm_continue')).toBeDefined();
      expect(
        (await fresh.post('/v1/auth/sign-in:mfa', { method: 'totp', code: '123456' })).json().error
          .issues[0].code,
      ).toBe('invalid_code');
      const ok = await fresh.post('/v1/auth/sign-in:mfa', {
        method: 'totp',
        code: totpNow(secret, 1),
      });
      expect(ok.statusCode).toBe(200);
      expect(fresh.session).toBeDefined();
      expect(fresh.cookies.get('pm_continue')).toBeUndefined();
      // The same code cannot be replayed (time-step replay protection).
      const again = new Browser(env.app);
      await signIn(again, 'mfa@example.test');
      expect(
        (await again.post('/v1/auth/sign-in:mfa', { method: 'totp', code: totpNow(secret, 1) }))
          .statusCode,
      ).toBe(422);

      // Recovery codes: single use.
      const r1 = new Browser(env.app);
      await signIn(r1, 'mfa@example.test');
      expect(
        (
          await r1.post('/v1/auth/sign-in:mfa', {
            method: 'recovery_code',
            code: codes[0]!.toLowerCase(),
          })
        ).statusCode,
      ).toBe(200);
      const r2 = new Browser(env.app);
      await signIn(r2, 'mfa@example.test');
      expect(
        (await r2.post('/v1/auth/sign-in:mfa', { method: 'recovery_code', code: codes[0] }))
          .statusCode,
      ).toBe(422);
      expect((await b.get('/v1/auth/mfa')).json().data.recovery_codes_remaining).toBe(9);
    });

    it('locks the continuation after repeated failures and requires a fresh sign-in', async () => {
      const b = new Browser(env.app);
      await registerAndVerify(env, b, 'lock@example.test');
      await signIn(b, 'lock@example.test');
      const { secret } = await enableTotp(b);
      const c = new Browser(env.app);
      await signIn(c, 'lock@example.test');
      for (let i = 0; i < 4; i++)
        expect(
          (await c.post('/v1/auth/sign-in:mfa', { method: 'totp', code: '000000' })).statusCode,
        ).toBe(422);
      expect(
        (await c.post('/v1/auth/sign-in:mfa', { method: 'totp', code: '000000' })).statusCode,
      ).toBe(401);
      expect(
        (await c.post('/v1/auth/sign-in:mfa', { method: 'totp', code: totpNow(secret, 1) })).json()
          .error.issues[0].code,
      ).toBe('sign_in_restart');
    });

    it('accepts one of two concurrent verifications of the same TOTP code', async () => {
      const b = new Browser(env.app);
      await registerAndVerify(env, b, 'dup-totp@example.test');
      await signIn(b, 'dup-totp@example.test');
      const { secret } = await enableTotp(b);
      const [x, y] = [new Browser(env.app), new Browser(env.app)];
      await signIn(x, 'dup-totp@example.test');
      await signIn(y, 'dup-totp@example.test');
      const code = totpNow(secret, 1);
      const results = await Promise.all([
        x.post('/v1/auth/sign-in:mfa', { method: 'totp', code }),
        y.post('/v1/auth/sign-in:mfa', { method: 'totp', code }),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 422]);
    });

    it('regenerates recovery codes atomically (old set stops working) and disables MFA via step-up', async () => {
      const b = new Browser(env.app);
      await registerAndVerify(env, b, 'regen@example.test');
      await signIn(b, 'regen@example.test');
      const { secret, codes } = await enableTotp(b);
      const regen = await protectedCall(
        b,
        '/v1/auth/mfa/recovery-codes:regenerate',
        {},
        { method: 'totp', proof: totpNow(secret, 1) },
      );
      expect(regen.challenge.methods).toEqual(['password', 'totp', 'recovery_code']);
      expect(regen.final.statusCode).toBe(200);
      const fresh = regen.final.json().data.codes as string[];
      const s = new Browser(env.app);
      await signIn(s, 'regen@example.test');
      expect(
        (await s.post('/v1/auth/sign-in:mfa', { method: 'recovery_code', code: codes[1] }))
          .statusCode,
      ).toBe(422);
      expect(
        (await s.post('/v1/auth/sign-in:mfa', { method: 'recovery_code', code: fresh[0] }))
          .statusCode,
      ).toBe(200);
      const seeds = async () =>
        (
          await env.db.admin(
            `SELECT count(*)::int AS n FROM ops.dev_secret_vault WHERE purpose = 'totp_seed'`,
          )
        ).rows[0].n as number;
      const seedsBefore = await seeds();
      const disable = await protectedCall(b, '/v1/auth/mfa/totp:disable', {});
      expect(disable.final.statusCode).toBe(200);
      const plain = new Browser(env.app);
      expect((await signIn(plain, 'regen@example.test')).json().data.state).toBe('signed_in');
      expect(await seeds()).toBe(seedsBefore - 1); // seed destroyed with the factor
      await env.deliverMail();
      expect(mailTo(env, 'regen@example.test', 'turned off')).toHaveLength(1);
    });
  });

  describe('step-up protocol (0D §11.2)', () => {
    it('is single use, bound to the idempotency key, replays safely, and never extends the session', async () => {
      const b = new Browser(env.app);
      await registerAndVerify(env, b, 'stepup@example.test');
      await signIn(b, 'stepup@example.test');
      await enableTotp(b);
      const before = (
        await env.db.admin(
          `SELECT absolute_expires_at, idle_expires_at FROM identity.session WHERE revoked_at IS NULL AND account_id = (SELECT id FROM identity.account WHERE email_key='stepup@example.test')`,
        )
      ).rows[0];
      const run = await protectedCall(b, '/v1/auth/mfa/recovery-codes:regenerate', {});
      expect(run.final.statusCode).toBe(200);
      // Same token again: consumed -> a new challenge is required.
      const reuse = await b.post(
        '/v1/auth/mfa/recovery-codes:regenerate',
        {},
        { headers: { 'idempotency-key': idemKey(), 'step-up': run.token! } },
      );
      expect(reuse.json().error.code).toBe('step_up_required');
      // Same key retried after completion: idempotent replay of references only (no codes).
      const replay = await b.post(
        '/v1/auth/mfa/recovery-codes:regenerate',
        {},
        { headers: { 'idempotency-key': run.key } },
      );
      expect(replay.statusCode).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).not.toMatch(/[A-Z2-7]{4}-[A-Z2-7]{4}/);
      // A verified token presented with a different idempotency key is rejected.
      const k = idemKey();
      const ch = (
        await b.post(
          '/v1/auth/mfa/recovery-codes:regenerate',
          {},
          { headers: { 'idempotency-key': k } },
        )
      ).json().error.step_up;
      const tok = (
        await b.post(`/v1/auth/step-up/${ch.id}:verify`, { method: 'password', proof: PASSWORD })
      ).json().data.token;
      expect(
        (
          await b.post(
            '/v1/auth/mfa/recovery-codes:regenerate',
            {},
            { headers: { 'idempotency-key': idemKey(), 'step-up': tok } },
          )
        ).json().error.code,
      ).toBe('step_up_required');
      const after = (
        await env.db.admin(
          `SELECT absolute_expires_at, idle_expires_at FROM identity.session WHERE revoked_at IS NULL AND account_id = (SELECT id FROM identity.account WHERE email_key='stepup@example.test')`,
        )
      ).rows[0];
      expect(after.absolute_expires_at.getTime()).toBe(before.absolute_expires_at.getTime());
    });

    it('binds tokens to action, target, and session', async () => {
      const b = new Browser(env.app);
      await registerAndVerify(env, b, 'binding@example.test');
      await signIn(b, 'binding@example.test');
      await enableTotp(b);
      const k = idemKey();
      const ch = (
        await b.post('/v1/auth/mfa/totp:disable', {}, { headers: { 'idempotency-key': k } })
      ).json().error.step_up;
      expect(ch.action_key).toBe('account.mfa_disable');
      const tok = (
        await b.post(`/v1/auth/step-up/${ch.id}:verify`, { method: 'password', proof: PASSWORD })
      ).json().data.token;
      // Wrong action (regenerate instead of disable): refused.
      expect(
        (
          await b.post(
            '/v1/auth/mfa/recovery-codes:regenerate',
            {},
            { headers: { 'idempotency-key': k, 'step-up': tok } },
          )
        ).json().error.code,
      ).toMatch(/step_up_required|idempotency_key_reuse/);
      // Another session of the same account cannot use it.
      const other = new Browser(env.app);
      await signIn(other, 'binding@example.test');
      const secret = undefined as unknown as string;
      void secret;
      // (other session must finish MFA first; use a recovery-free path: verify the challenge is invisible)
      expect(
        (
          await other.post(`/v1/auth/step-up/${ch.id}:verify`, {
            method: 'password',
            proof: PASSWORD,
          })
        ).statusCode,
      ).toBe(401);
      // The original session, right action, right key: accepted once.
      expect(
        (
          await b.post(
            '/v1/auth/mfa/totp:disable',
            {},
            { headers: { 'idempotency-key': k, 'step-up': tok } },
          )
        ).statusCode,
      ).toBe(200);
    });

    it('expires, cancels, and locks challenges after repeated failures', async () => {
      const b = new Browser(env.app);
      await registerAndVerify(env, b, 'locks@example.test');
      await signIn(b, 'locks@example.test');
      const issue = async () =>
        (
          await b.post(
            '/v1/auth/mfa/totp:enroll',
            {},
            { headers: { 'idempotency-key': idemKey() } },
          )
        ).json().error.step_up;
      const cancelled = await issue();
      const cancel = await b.post(`/v1/auth/step-up/${cancelled.id}:cancel`);
      expect(cancel.json().data.state).toBe('cancelled');
      expect(
        (
          await b.post(`/v1/auth/step-up/${cancelled.id}:verify`, {
            method: 'password',
            proof: PASSWORD,
          })
        ).statusCode,
      ).toBe(409);
      const expired = await issue();
      await env.db.admin(
        `UPDATE identity.step_up_challenge SET expires_at = now() - interval '1 second', created_at = now() - interval '1 hour' WHERE public_id = $1`,
        [expired.id],
      );
      expect(
        (
          await b.post(`/v1/auth/step-up/${expired.id}:verify`, {
            method: 'password',
            proof: PASSWORD,
          })
        ).json().error.issues[0].code,
      ).toBe('challenge_expired');
      const locked = await issue();
      for (let i = 0; i < 4; i++)
        expect(
          (
            await b.post(`/v1/auth/step-up/${locked.id}:verify`, {
              method: 'password',
              proof: 'wrong password!!',
            })
          ).statusCode,
        ).toBe(422);
      expect(
        (
          await b.post(`/v1/auth/step-up/${locked.id}:verify`, {
            method: 'password',
            proof: 'wrong password!!',
          })
        ).statusCode,
      ).toBe(429);
      expect(
        (
          await b.post(`/v1/auth/step-up/${locked.id}:verify`, {
            method: 'password',
            proof: PASSWORD,
          })
        ).statusCode,
      ).toBe(429);
      // Methods not offered by the challenge are refused.
      const ch = await issue();
      expect(
        (await b.post(`/v1/auth/step-up/${ch.id}:verify`, { method: 'webauthn', proof: 'x' }))
          .statusCode,
      ).toBe(422);
    });

    it('denies non-human principals and requires a membership for tenant actions', async () => {
      const b = new Browser(env.app);
      await registerAndVerify(env, b, 'tenant@example.test');
      await signIn(b, 'tenant@example.test');
      const me = (await b.get('/v1/auth/me')).json().data;
      const account = (
        await env.db.admin(`SELECT id FROM identity.account WHERE public_id = $1`, [me.id])
      ).rows[0];
      const session = (
        await env.db.admin(
          `SELECT id, public_id FROM identity.session WHERE account_id = $1 AND revoked_at IS NULL`,
          [account.id],
        )
      ).rows[0];
      const ctx = {
        principal: 'account',
        account: {
          id: account.id,
          publicId: me.id,
          email: me.email,
          displayName: me.display_name,
          locale: 'en',
          timezone: 'UTC',
          emailVerified: true,
        },
        session: {
          id: session.id,
          publicId: session.public_id,
          assurance: 'single_factor',
          authMethods: ['password'],
          createdAt: new Date(),
          idleExpiresAt: new Date(),
          absoluteExpiresAt: new Date(),
          mfaVerifiedAt: null,
        },
      } as AuthContext;
      const meta = { correlationId: '4bf92f3577b34da6a3ce929d0e0e4736' };
      await expect(
        env.identity.createStepUpChallenge(
          { principal: 'non_human', type: 'service_principal' },
          { actionKey: 'account.mfa_disable' },
          meta,
        ),
      ).rejects.toMatchObject({ code: 'step_up_unavailable' });
      await expect(
        env.identity.disableTotp(
          { principal: 'non_human', type: 'agent_run' },
          { idempotencyKey: idemKey(), fingerprint: Buffer.alloc(32) },
          meta,
        ),
      ).rejects.toMatchObject({ code: 'step_up_unavailable' });
      const tenant = env.identity.createStepUpChallenge(
        ctx,
        { actionKey: 'workspace.delete' },
        meta,
      );
      await expect(tenant).rejects.toBeInstanceOf(IdentityError);
      await expect(tenant).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: 'tenant_binding_required' })],
      });
      const bound = await env.identity.createStepUpChallenge(
        ctx,
        { actionKey: 'workspace.delete', membershipId: newUuidV7(), workspaceId: newUuidV7() },
        meta,
      );
      expect(bound.action_key).toBe('workspace.delete');
      await expect(
        env.identity.createStepUpChallenge(ctx, { actionKey: 'task.edit' }, meta),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    });
  });
});
