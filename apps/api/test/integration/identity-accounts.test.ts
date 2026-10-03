import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractErrors } from '@pm/test-support';
import {
  Browser,
  identityEnv,
  mailTo,
  PASSWORD,
  registerAndVerify,
  signIn,
  tokenFrom,
  type IdentityEnv,
} from './identity-helpers.ts';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('identity: registration, verification, sign-in, sessions', () => {
  let env: IdentityEnv;
  const legal = () => env.identity.config.legal;
  const registration = (email: string, extra: Record<string, unknown> = {}) => ({
    email,
    password: PASSWORD,
    display_name: 'Synthetic Person',
    terms_version: legal().termsVersion,
    privacy_version: legal().privacyVersion,
    bot_proof: 'test-pass',
    ...extra,
  });

  beforeAll(async () => {
    env = await identityEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  describe('registration and email verification', () => {
    it('registers, emails a single-use verification link, verifies, and continues to onboarding', async () => {
      const b = new Browser(env.app);
      const r = await b.post('/v1/auth/register', registration('Ada.Example@Example.TEST'));
      expect(r.statusCode).toBe(202);
      expect(r.json().data).toEqual({ type: 'acknowledgement', status: 'check_email' });
      expect(b.session).toBeUndefined(); // no session before verification + sign-in
      await env.deliverMail();
      const mail = mailTo(env, 'Ada.Example@example.test', 'verify');
      expect(mail).toHaveLength(1);
      expect(mail[0]!.to).toBe('Ada.Example@example.test'); // delivery form keeps the local-part case
      expect(mail[0]!.text).toContain(
        `${env.identity.config.publicOrigin}/verify-email/confirm#token=`,
      );
      expect(mail[0]!.text).not.toMatch(UUID);
      const token = tokenFrom(mail[0]);
      expect((await b.post('/v1/auth/email:verify', { token })).statusCode).toBe(200);
      const again = await b.post('/v1/auth/email:verify', { token });
      expect(again.statusCode).toBe(422);
      expect(again.json().error.issues[0].code).toBe('token_used');
      const account = await env.db.admin(
        `SELECT email_verified_at, email_key FROM identity.account WHERE email_key = 'ada.example@example.test'`,
      );
      expect(account.rows[0].email_verified_at).not.toBeNull();
    });

    it('answers identically for new, unverified, and existing addresses (no enumeration)', async () => {
      const b = new Browser(env.app);
      await registerAndVerify(env, b, 'existing@example.test');
      await b.post('/v1/auth/register', registration('pending@example.test'));
      const shape = (r: Awaited<ReturnType<Browser['post']>>) => ({
        status: r.statusCode,
        data: r.json().data,
        keys: Object.keys(r.json()).sort(),
        cookies: r.headers['set-cookie'],
      });
      const fresh = await b.post('/v1/auth/register', registration('brand-new@example.test'));
      const pending = await b.post('/v1/auth/register', registration('pending@example.test'));
      const existing = await b.post('/v1/auth/register', registration('EXISTING@example.test'));
      expect(shape(pending)).toEqual(shape(fresh));
      expect(shape(existing)).toEqual(shape(fresh));
      await env.deliverMail();
      // The owner of the existing address learns about the attempt; the caller learns nothing.
      expect(mailTo(env, 'existing@example.test', 'sign-in help')).toHaveLength(1);
      const accounts = await env.db.admin(
        `SELECT count(*)::int AS n FROM identity.account WHERE email_key = 'existing@example.test'`,
      );
      expect(accounts.rows[0].n).toBe(1);
    });

    it('validates input with field-level issues and never echoes passwords', async () => {
      const b = new Browser(env.app);
      const r = await b.post(
        '/v1/auth/register',
        registration('not-an-email', {
          password: 'Zq9!x',
          display_name: '',
          terms_version: 'old',
          bot_proof: 'nope',
        }),
      );
      expect(r.statusCode).toBe(422);
      expect(contractErrors('error-envelope', r.json())).toEqual([]);
      const pointers = r
        .json()
        .error.issues.map((i: { pointer: string; code: string }) => `${i.pointer}:${i.code}`);
      expect(pointers).toEqual(
        expect.arrayContaining([
          '/email:invalid_email',
          '/password:too_short',
          '/display_name:invalid_value',
          '/accept_terms:acknowledgement_required',
          '/bot_proof:verification_required',
        ]),
      );
      expect(r.body).not.toContain('Zq9!x');
      const long = await b.post(
        '/v1/auth/register',
        registration('long@example.test', { password: 'x'.repeat(1025) }),
      );
      expect(long.json().error.issues[0]).toMatchObject({ pointer: '/password', code: 'too_long' });
    });

    it('classifies expired and superseded links, and resend respects the cooldown', async () => {
      const b = new Browser(env.app);
      await b.post('/v1/auth/register', registration('resend@example.test'));
      await env.deliverMail();
      const first = tokenFrom(mailTo(env, 'resend@example.test', 'verify').at(-1));
      // Within the cooldown a resend is acknowledged but sends nothing new.
      await b.post('/v1/auth/email:resend', { email: 'resend@example.test' });
      await env.deliverMail();
      expect(mailTo(env, 'resend@example.test', 'verify')).toHaveLength(1);
      // After the cooldown a new link supersedes the old one (lineage recorded).
      await env.db.admin(
        `UPDATE identity.verification_token SET created_at = now() - interval '2 minutes' WHERE purpose = 'email_verification'`,
      );
      await b.post('/v1/auth/email:resend', { email: 'resend@example.test' });
      await env.deliverMail();
      const second = tokenFrom(mailTo(env, 'resend@example.test', 'verify').at(-1));
      expect(second).not.toBe(first);
      expect(
        (await b.post('/v1/auth/email:verify', { token: first })).json().error.issues[0].code,
      ).toBe('token_invalid');
      const lineage = await env.db.admin(
        `SELECT count(*)::int AS n FROM identity.verification_token WHERE supersedes_token_id IS NOT NULL`,
      );
      expect(lineage.rows[0].n).toBeGreaterThan(0);
      await env.db.admin(
        `UPDATE identity.verification_token SET expires_at = now() - interval '1 second', created_at = now() - interval '2 days' WHERE consumed_at IS NULL AND revoked_at IS NULL AND purpose = 'email_verification'`,
      );
      expect(
        (await b.post('/v1/auth/email:verify', { token: second })).json().error.issues[0].code,
      ).toBe('token_expired');
      expect(
        (await b.post('/v1/auth/email:verify', { token: 'x'.repeat(43) })).json().error.issues[0]
          .code,
      ).toBe('token_invalid');
      // Resend for unknown addresses is acknowledged identically.
      const unknown = await b.post('/v1/auth/email:resend', { email: 'nobody@example.test' });
      expect(unknown.statusCode).toBe(202);
    });

    it('handles concurrent duplicate registrations with one account', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          new Browser(env.app).post('/v1/auth/register', registration('race@example.test')),
        ),
      );
      expect(results.map((r) => r.statusCode)).toEqual([202, 202, 202, 202, 202]);
      const n = await env.db.admin(
        `SELECT count(*)::int AS n FROM identity.account WHERE email_key = 'race@example.test'`,
      );
      expect(n.rows[0].n).toBe(1);
    });
  });

  describe('sign-in, cookies, and sessions', () => {
    it('signs in with a generic failure for unknown accounts and wrong passwords', async () => {
      const b = new Browser(env.app);
      await registerAndVerify(env, b, 'signin@example.test');
      const wrong = await signIn(b, 'signin@example.test', 'wrong password!!');
      const unknown = await signIn(b, 'nobody-here@example.test');
      for (const r of [wrong, unknown]) {
        expect(r.statusCode).toBe(401);
        expect(r.json().error.issues).toEqual([
          {
            pointer: '/email',
            code: 'invalid_credentials',
            message: 'The email or password is incorrect.',
          },
        ]);
      }
      const strip = (r: typeof wrong) => ({
        ...r.json().error,
        request_id: '',
        correlation_id: '',
      });
      expect(strip(wrong)).toEqual(strip(unknown));
      const ok = await signIn(b, 'SIGNIN@example.test');
      expect(ok.statusCode).toBe(200);
      expect(ok.json().data).toEqual({ type: 'sign_in_result', state: 'signed_in' });
    });

    it('issues an opaque HttpOnly, SameSite, API-pathed, host-only cookie and stores only its hash', async () => {
      const b = new Browser(env.app);
      await registerAndVerify(env, b, 'cookie@example.test');
      const r = await signIn(b, 'cookie@example.test');
      const cookie = ([] as string[])
        .concat(r.headers['set-cookie'] ?? [])
        .find((c) => c.startsWith('pm_session='))!;
      expect(cookie).toMatch(
        /^pm_session=[A-Za-z0-9_-]{43}; Path=\/v1; SameSite=Lax; HttpOnly; Max-Age=\d+$/,
      );
      expect(cookie).not.toMatch(/Domain=/i);
      const raw = b.session!;
      const stored = await env.db.admin(
        `SELECT encode(token_hash, 'hex') AS h FROM identity.session s JOIN identity.account a ON a.id = s.account_id WHERE a.email_key = 'cookie@example.test'`,
      );
      expect(stored.rows[0].h).toHaveLength(64);
      const dump = JSON.stringify((await env.db.admin(`SELECT * FROM identity.session`)).rows);
      expect(dump.includes(raw), 'raw token stored').toBe(false);
      // Network context is a prefix, never the address; the user agent is reduced to a label.
      const meta = await env.db.admin(
        `SELECT network_prefix, device_label FROM identity.session ORDER BY created_at DESC LIMIT 1`,
      );
      expect(meta.rows[0]).toEqual({
        network_prefix: '203.0.113.0/24',
        device_label: 'Safari on macOS',
      });
      expect(dump).not.toContain('203.0.113.10');
    });

    it('rotates the session on sign-in (fixation protection) and reports identity only via /me', async () => {
      const b = new Browser(env.app);
      await registerAndVerify(env, b, 'rotate@example.test');
      await signIn(b, 'rotate@example.test');
      const first = b.session!;
      await signIn(b, 'rotate@example.test');
      expect(b.session).not.toBe(first);
      const old = new Browser(env.app);
      old.cookies.set('pm_session', first);
      expect((await old.get('/v1/auth/me')).statusCode).toBe(401);
      const me = await b.get('/v1/auth/me');
      expect(me.statusCode).toBe(200);
      expect(contractErrors('success-envelope', me.json())).toEqual([]);
      const data = me.json().data;
      expect(Object.keys(data).sort()).toEqual([
        'display_name',
        'email',
        'email_verified',
        'id',
        'locale',
        'mfa',
        'session',
        'timezone',
        'type',
      ]);
      expect(data.id).toMatch(/^acct_/);
      expect(JSON.stringify(me.json())).not.toMatch(/workspace|membership|role/i);
      expect(me.body).not.toMatch(UUID);
    });

    it('enforces origin and CSRF checks on cookie-authenticated state changes', async () => {
      const b = new Browser(env.app);
      await registerAndVerify(env, b, 'csrf@example.test');
      await signIn(b, 'csrf@example.test');
      expect(
        (await b.post('/v1/auth/sessions:revoke-others', {}, { origin: 'https://evil.example' }))
          .statusCode,
      ).toBe(403);
      expect(
        (await b.post('/v1/auth/sessions:revoke-others', {}, { origin: null })).statusCode,
      ).toBe(403);
      expect(
        (await b.post('/v1/auth/sessions:revoke-others', {}, { csrf: null })).json().error.issues[0]
          .code,
      ).toBe('csrf_token');
      expect(
        (await b.post('/v1/auth/sessions:revoke-others', {}, { csrf: 'forged-token-value' }))
          .statusCode,
      ).toBe(403);
      expect((await b.post('/v1/auth/sessions:revoke-others')).statusCode).toBe(200);
      // Login CSRF: a cross-site sign-in attempt is refused before credentials are checked.
      expect(
        (
          await new Browser(env.app).post(
            '/v1/auth/sign-in',
            { email: 'csrf@example.test', password: PASSWORD },
            { origin: 'https://evil.example' },
          )
        ).statusCode,
      ).toBe(403);
    });

    it('lists own sessions and revokes another session effective on its next request', async () => {
      const laptop = new Browser(env.app);
      const phone = new Browser(env.app);
      phone.userAgent =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
      phone.ip = '2001:db8:1234:5678::1';
      await registerAndVerify(env, laptop, 'sessions@example.test');
      await signIn(laptop, 'sessions@example.test');
      await signIn(phone, 'sessions@example.test');
      const list = (await laptop.get('/v1/auth/sessions')).json();
      expect(contractErrors('collection-page', list)).toEqual([]);
      const active = list.data.filter((s: { state: string }) => s.state === 'active');
      expect(active).toHaveLength(2);
      const other = active.find((s: { current: boolean }) => !s.current);
      expect(other.device).toBe('Safari on iOS');
      expect(JSON.stringify(list)).not.toContain('2001:db8');
      expect((await phone.get('/v1/auth/me')).statusCode).toBe(200);
      expect((await laptop.post(`/v1/auth/sessions/${other.id}:revoke`)).statusCode).toBe(200);
      expect((await laptop.post(`/v1/auth/sessions/${other.id}:revoke`)).statusCode).toBe(200); // idempotent
      const next = await phone.get('/v1/auth/me');
      expect(next.statusCode).toBe(401);
      expect(phone.session).toBeUndefined(); // cookie cleared
      const current = list.data.find((s: { current: boolean }) => s.current);
      expect(
        (await laptop.post(`/v1/auth/sessions/${current.id}:revoke`)).json().error.issues[0].code,
      ).toBe('current_session');
      expect(
        (await laptop.post(`/v1/auth/sessions/ses_00000000000000000000000000:revoke`)).statusCode,
      ).toBe(404);
      expect((await laptop.post(`/v1/auth/sessions/${current.id}:explode`)).statusCode).toBe(404);
    });

    it('signs out everywhere, revoking every session including the current one', async () => {
      const a = new Browser(env.app);
      const c = new Browser(env.app);
      await registerAndVerify(env, a, 'everywhere@example.test');
      await signIn(a, 'everywhere@example.test');
      await signIn(c, 'everywhere@example.test');
      expect((await a.post('/v1/auth/sessions:revoke-all')).statusCode).toBe(200);
      expect((await a.get('/v1/auth/me')).statusCode).toBe(401);
      expect((await c.get('/v1/auth/me')).statusCode).toBe(401);
      await env.deliverMail();
      expect(mailTo(env, 'everywhere@example.test', 'signed out')).toHaveLength(1);
    });

    it('enforces idle and absolute expiry on every request', async () => {
      const b = new Browser(env.app);
      await registerAndVerify(env, b, 'expiry@example.test');
      await signIn(b, 'expiry@example.test');
      await env.db.admin(
        `UPDATE identity.session SET idle_expires_at = now() - interval '1 second' WHERE account_id = (SELECT id FROM identity.account WHERE email_key = 'expiry@example.test')`,
      );
      expect((await b.get('/v1/auth/me')).statusCode).toBe(401);
      await signIn(b, 'expiry@example.test');
      await env.db.admin(
        `UPDATE identity.session SET absolute_expires_at = now(), idle_expires_at = now(), created_at = now() - interval '1 day', last_seen_at = now() - interval '1 day' WHERE revoked_at IS NULL AND account_id = (SELECT id FROM identity.account WHERE email_key = 'expiry@example.test')`,
      );
      expect((await b.get('/v1/auth/me')).statusCode).toBe(401);
    });

    it('updates last-seen with bounded write frequency', async () => {
      const b = new Browser(env.app);
      await registerAndVerify(env, b, 'touch@example.test');
      await signIn(b, 'touch@example.test');
      const seen = async () =>
        (
          await env.db.admin(
            `SELECT last_seen_at FROM identity.session WHERE revoked_at IS NULL AND account_id = (SELECT id FROM identity.account WHERE email_key = 'touch@example.test')`,
          )
        ).rows[0].last_seen_at.getTime();
      const t0 = await seen();
      await b.get('/v1/auth/me');
      expect(await seen()).toBe(t0); // within the touch interval: no write
      await env.db.admin(
        `UPDATE identity.session SET last_seen_at = now() - interval '5 minutes', created_at = now() - interval '5 minutes' WHERE revoked_at IS NULL AND account_id = (SELECT id FROM identity.account WHERE email_key = 'touch@example.test')`,
      );
      await b.get('/v1/auth/me');
      expect(await seen()).toBeGreaterThan(t0 - 1000);
    });

    it('sign-out ends only the current session and never implies tenant access', async () => {
      const b = new Browser(env.app);
      await registerAndVerify(env, b, 'signout@example.test');
      await signIn(b, 'signout@example.test');
      expect((await b.post('/v1/auth/sign-out')).statusCode).toBe(204);
      expect(b.session).toBeUndefined();
      expect((await b.get('/v1/auth/me')).statusCode).toBe(401);
      // No tenant data exists for identity alone: tenant tables stay empty and unreachable.
      const memberships = await env.db.admin(`SELECT count(*)::int AS n FROM tenancy.workspace`);
      expect(memberships.rows[0].n).toBe(0);
    });
  });
});
