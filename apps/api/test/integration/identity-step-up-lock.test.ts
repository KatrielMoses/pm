import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIdentityService, IdentityError, type AuthContext } from '@pm/identity';
import {
  Browser,
  idemKey,
  identityEnv,
  PASSWORD,
  registerAndVerify,
  signIn,
  type IdentityEnv,
} from './identity-helpers.ts';

const WRONG = 'definitely not the password';
const META = { correlationId: '4bf92f3577b34da6a3ce929d0e0e4736' };

/** Stored `locked` step-up state (0D §11.2, PL-17; Phase 1B review 01). STEP_UP_MAX_ATTEMPTS = 5. */
describe('identity: stored locked step-up challenges', () => {
  let env: IdentityEnv;

  beforeAll(async () => {
    env = await identityEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  async function signedIn(email: string): Promise<Browser> {
    const b = new Browser(env.app);
    await registerAndVerify(env, b, email);
    await signIn(b, email);
    return b;
  }

  /** Issues a challenge for MFA enrollment (a step-up action with password as the method). */
  async function challenge(b: Browser): Promise<{ id: string }> {
    const r = await b.post(
      '/v1/auth/mfa/totp:enroll',
      {},
      { headers: { 'idempotency-key': idemKey() } },
    );
    expect(r.statusCode).toBe(403);
    return r.json().error.step_up;
  }

  const verify = (b: Browser, id: string, proof: string) =>
    b.post(`/v1/auth/step-up/${id}:verify`, { method: 'password', proof });

  async function row(publicId: string) {
    return (
      await env.db.admin(
        `SELECT state, failed_attempts, locked_at, token_hash, verified_at, version, session_id
         FROM identity.step_up_challenge WHERE public_id = $1`,
        [publicId],
      )
    ).rows[0];
  }

  async function events(sessionId: string) {
    return (
      await env.db.admin(
        `SELECT action, outcome FROM identity.security_event_buffer
         WHERE subject_id = $1 AND category = 'step_up' ORDER BY occurred_at, id`,
        [sessionId],
      )
    ).rows as Array<{ action: string; outcome: string }>;
  }

  it('the failed attempt that reaches the limit stores locked atomically and records the transition', async () => {
    const b = await signedIn('lock-exact@example.test');
    const ch = await challenge(b);
    for (let i = 1; i <= 4; i++) {
      expect((await verify(b, ch.id, WRONG)).statusCode).toBe(422);
      expect(await row(ch.id)).toMatchObject({
        state: 'pending',
        failed_attempts: i,
        locked_at: null,
      });
    }
    const fifth = await verify(b, ch.id, WRONG);
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json().error.code).toBe('rate_limited');
    const locked = await row(ch.id);
    expect(locked).toMatchObject({
      state: 'locked',
      failed_attempts: 5,
      token_hash: null,
      verified_at: null,
    });
    expect(locked.locked_at).toBeInstanceOf(Date);
    const ev = await events(locked.session_id);
    expect(ev.filter((e) => e.action === 'step_up.failed')).toHaveLength(5);
    expect(ev.filter((e) => e.action === 'step_up.locked')).toEqual([
      { action: 'step_up.locked', outcome: 'denied' },
    ]);
    // The transition event carries no proof material.
    const stored = JSON.stringify(
      (
        await env.db.admin(`SELECT * FROM identity.security_event_buffer WHERE subject_id = $1`, [
          locked.session_id,
        ])
      ).rows,
    );
    expect(stored.includes(WRONG), 'proof in event').toBe(false);
    expect(stored.includes(PASSWORD), 'password in event').toBe(false);
  });

  it('after lock, verification and replays are refused without mutating anything; cancel leaves it locked', async () => {
    const b = await signedIn('lock-after@example.test');
    const ch = await challenge(b);
    for (let i = 0; i < 5; i++) await verify(b, ch.id, WRONG);
    const before = await row(ch.id);
    const eventsBefore = (await events(before.session_id)).length;
    for (const proof of [PASSWORD, WRONG, PASSWORD]) {
      const r = await verify(b, ch.id, proof);
      expect(r.statusCode).toBe(429);
      expect(r.json().data).toBeUndefined();
    }
    expect((await b.post(`/v1/auth/step-up/${ch.id}:cancel`)).statusCode).toBe(404);
    const after = await row(ch.id);
    expect(after).toEqual(before);
    expect(await events(before.session_id)).toHaveLength(eventsBefore);
    // The action still needs a fresh challenge; no token ever came from the locked one.
    const retry = await b.post(
      '/v1/auth/mfa/totp:enroll',
      {},
      { headers: { 'idempotency-key': idemKey() } },
    );
    expect(retry.statusCode).toBe(403);
    expect(retry.json().error.step_up.id).not.toBe(ch.id);
  });

  it('stays locked across a process restart with a raised limit; a lowered limit locks without a proof', async () => {
    const b = await signedIn('lock-restart@example.test');
    const ch = await challenge(b);
    for (let i = 0; i < 5; i++) await verify(b, ch.id, WRONG);
    expect((await row(ch.id)).state).toBe('locked');
    const restarted = (maxAttempts: number) =>
      createIdentityService({
        db: env.h.platform,
        config: { ...env.h.config.identity, stepUpMaxAttempts: maxAttempts },
        appName: 'PM',
        logger: env.h.logger,
        metrics: env.h.telemetry.metrics,
      }).service;
    const ctxFor = async (s: ReturnType<typeof restarted>): Promise<AuthContext> => {
      const r = await s.resolveSession(b.session);
      if (r.status !== 'ok') throw new Error('no session');
      return r.ctx;
    };
    // A new process with a much higher limit still refuses the correct proof.
    const lenient = restarted(1000);
    await expect(
      lenient.verifyStepUp(
        await ctxFor(lenient),
        ch.id,
        { method: 'password', proof: PASSWORD },
        META,
      ),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect(await row(ch.id)).toMatchObject({ state: 'locked', failed_attempts: 5 });
    // A pending challenge whose count already meets a lowered limit locks on the next attempt.
    const second = await challenge(b);
    for (let i = 0; i < 2; i++) await verify(b, second.id, WRONG);
    const strict = restarted(2);
    const err = await strict
      .verifyStepUp(await ctxFor(strict), second.id, { method: 'password', proof: PASSWORD }, META)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdentityError);
    expect((err as IdentityError).code).toBe('rate_limited');
    expect(await row(second.id)).toMatchObject({
      state: 'locked',
      failed_attempts: 2,
      token_hash: null,
    });
  });

  it('concurrent final correct and incorrect proofs produce exactly one terminal outcome', async () => {
    const b = await signedIn('lock-race@example.test');
    const outcomes = new Set<string>();
    for (let round = 0; round < 8; round++) {
      const ch = await challenge(b);
      for (let i = 0; i < 4; i++) await verify(b, ch.id, WRONG);
      const [good, bad] = await Promise.all([verify(b, ch.id, PASSWORD), verify(b, ch.id, WRONG)]);
      const r = await row(ch.id);
      if (r.state === 'verified') {
        // The correct proof won the row lock; the wrong one then found a non-pending challenge.
        expect(good.statusCode).toBe(200);
        expect(bad.statusCode).toBe(409);
        expect(r.locked_at).toBeNull();
        expect(r.failed_attempts).toBe(4);
      } else {
        // The wrong proof won and locked it; the correct proof is refused and yields no token.
        expect(r.state).toBe('locked');
        expect(bad.statusCode).toBe(429);
        expect(good.statusCode).toBe(429);
        expect(r.token_hash).toBeNull();
      }
      outcomes.add(r.state);
    }
    expect([...outcomes].every((s) => s === 'verified' || s === 'locked')).toBe(true);
  });

  it('cleanup removes locked challenges past expiry with the other expired challenges and keeps fresh ones', async () => {
    const b = await signedIn('lock-cleanup@example.test');
    const old = await challenge(b);
    const fresh = await challenge(b);
    for (const ch of [old, fresh]) for (let i = 0; i < 5; i++) await verify(b, ch.id, WRONG);
    await env.db.admin(
      `UPDATE identity.step_up_challenge SET created_at = now() - interval '3 days', expires_at = now() - interval '2 days' WHERE public_id = $1`,
      [old.id],
    );
    expect(await env.worker.enqueueDueSchedules(Date.now() + 16 * 60_000)).toBe(1);
    await env.deliverMail(); // runs due platform jobs, including the identity cleanup sweep
    expect(await row(old.id)).toBeUndefined();
    expect((await row(fresh.id)).state).toBe('locked');
  });
});
