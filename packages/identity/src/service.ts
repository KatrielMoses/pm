import { randomBytes } from 'node:crypto';
import {
  ACTIONS,
  newPublicId,
  newUuidV7,
  traceIdToUuid,
  type ExecutionContext,
} from '@pm/contracts';
import type { IdentityConfig, SecretVault } from '@pm/config';
import {
  sql,
  type AuthMethod,
  type PlatformDatabase,
  type PlatformTransaction,
  type StepUpMethod,
  type TokenPurpose,
} from '@pm/db';
import type { Logger, Metrics } from '@pm/observability';
import { completeIdempotencyKey, enqueueJob, reserveIdempotencyKey } from '@pm/platform';
import { deviceLabel, networkPrefix, safeReturnPath, userAgentFamily } from './device.ts';
import { EmailFormatError, normalizeEmail } from './email.ts';
import type { MailTemplate } from './mail/templates.ts';
import { pkceChallenge, OAuthProviderError, type OAuthProvider } from './oauth/provider.ts';
import { checkPasswordPolicy, PasswordHasher, type Argon2Params } from './password.ts';
import {
  hashToken,
  isWellFormedToken,
  keyedHash,
  newOpaqueToken,
  sha256,
  withResponseFloor,
} from './primitives.ts';
import type { RateLimiter, RateLimitPolicy } from './rate-limit.ts';
import { hashRecoveryCode, newRecoveryCodes, normalizeRecoveryCode } from './recovery-codes.ts';
import type { SecurityEvent, SecurityEventPort } from './security-events.ts';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp.ts';
import {
  ACCOUNT_STEP_UP_ACTIONS,
  IdentityError,
  issue,
  type AccountView,
  type AuthContext,
  type IssuedSession,
  type NonHumanPrincipal,
  type ProtectedRequest,
  type ReplayResult,
  type RequestMeta,
  type SessionView,
  type StepUpChallengeView,
  type TokenProblem,
} from './types.ts';

/** Anti-bot proof adapter (edge or vendor CAPTCHA later; deterministic in local/test). */
export interface BotProtection {
  verify(proof: unknown): Promise<boolean>;
}
export const noBotProtection: BotProtection = { verify: () => Promise.resolve(true) };
/** Test adapter: only the literal proof "test-pass" succeeds. */
export const testBotProtection: BotProtection = {
  verify: (p) => Promise.resolve(p === 'test-pass'),
};

export interface IdentityDeps {
  db: PlatformDatabase;
  config: IdentityConfig;
  appName: string;
  hasher: PasswordHasher;
  vault: SecretVault;
  limiter: RateLimiter;
  events: SecurityEventPort;
  oauth: ReadonlyMap<string, OAuthProvider>;
  bot: BotProtection;
  signingKey: Buffer;
  logger: Logger;
  metrics: Metrics;
}

/**
 * Authorization decision produced by the 1D policy layer. Only that layer constructs it; 1B
 * exposes no route that can, so administrative session management stays internal until 1D.
 */
export interface ManageOthersDecision {
  readonly action: 'sessions.manage_others';
  readonly allowed: true;
  readonly workspaceId: string;
  readonly actorMembershipId: string;
  readonly actorAccountId: string;
}

const MFA_CONTINUATION_MAX_ATTEMPTS = 5;
const SYSTEM_JOB_PRINCIPAL = {
  type: 'system_job' as const,
  id: '01920000-0000-7000-8000-000000000002',
};
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60_000;

type Flow =
  | 'register'
  | 'verify_email'
  | 'resend_verification'
  | 'sign_in'
  | 'sign_in_mfa'
  | 'sign_out'
  | 'password_reset_request'
  | 'password_reset'
  | 'password_change'
  | 'session_revoke'
  | 'mfa_enroll'
  | 'mfa_confirm'
  | 'mfa_disable'
  | 'recovery_codes'
  | 'step_up_challenge'
  | 'step_up_verify'
  | 'oauth_start'
  | 'oauth_callback'
  | 'oauth_unlink';

const VALID_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone').concat('UTC'));
const DISPLAY_NAME = /^[^\p{Cc}\p{Cs}]{1,120}$/u;

export class IdentityService {
  readonly #d: IdentityDeps;

  constructor(deps: IdentityDeps) {
    this.#d = deps;
  }

  get config(): IdentityConfig {
    return this.#d.config;
  }

  // -------------------------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------------------------

  async #flow<T>(flow: Flow, fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    let outcome = 'success';
    try {
      return await fn();
    } catch (err) {
      outcome = err instanceof IdentityError ? err.code : 'error';
      throw err;
    } finally {
      const labels = { flow, outcome };
      this.#d.metrics.count('identity.flow.outcomes', 1, labels);
      this.#d.metrics.record('identity.flow.duration', performance.now() - started, labels);
    }
  }

  async #limit(policy: RateLimitPolicy, dimension: string): Promise<void> {
    const decision = await this.#d.limiter.consume(policy, dimension);
    if (!decision.allowed) {
      this.#d.metrics.count('identity.rate_limited', 1, { policy });
      this.#d.logger.warn('identity.rate_limited', { policy });
      throw new IdentityError('rate_limited', { retryAfterSeconds: decision.retryAfterSeconds });
    }
  }

  #source(meta: RequestMeta): string {
    return networkPrefix(meta.ip) ?? 'unknown';
  }

  #event(
    tx: PlatformTransaction,
    meta: RequestMeta,
    e: Omit<SecurityEvent, 'correlationId' | 'network'>,
  ): Promise<void> {
    return this.#d.events.record(tx, {
      ...e,
      correlationId: meta.correlationId,
      network: { prefix: networkPrefix(meta.ip), userAgentFamily: userAgentFamily(meta.userAgent) },
    });
  }

  #systemContext(meta: RequestMeta): ExecutionContext {
    return {
      workspaceId: null,
      correlationId: meta.correlationId,
      ...(meta.requestId ? { requestId: meta.requestId } : {}),
      ...(meta.traceparent ? { traceparent: meta.traceparent } : {}),
      authenticatedPrincipal: SYSTEM_JOB_PRINCIPAL,
      effectivePrincipal: SYSTEM_JOB_PRINCIPAL,
      delegationChain: [{ type: 'system_job', id: SYSTEM_JOB_PRINCIPAL.id }],
      epochs: { workspace: 0, principal: 0 },
      dataClassLimit: 'C3',
    };
  }

  /**
   * Durable mail request: a `identity.mail_delivery` row plus a platform job, in the caller's
   * transaction (the outbox pattern). A one-time token travels only as a secret-store reference.
   */
  async #enqueueMail(
    tx: PlatformTransaction,
    meta: RequestMeta,
    m: {
      template: MailTemplate;
      recipient: string;
      locale: string;
      accountId: string;
      token?: string;
      tokenExpiresAt?: Date;
    },
  ): Promise<void> {
    const id = newUuidV7();
    const sealedRef = m.token
      ? await this.#d.vault.put('mail_token', m.token, {
          scope: tx,
          ...(m.tokenExpiresAt ? { expiresAt: m.tokenExpiresAt } : {}),
        })
      : null;
    await tx.db
      .insertInto('identity.mail_delivery')
      .values({
        id,
        template: m.template,
        recipient: m.recipient,
        locale: m.locale,
        account_id: m.accountId,
        sealed_ref: sealedRef,
        request_id: meta.requestId ?? null,
        correlation_id: traceIdToUuid(meta.correlationId),
        traceparent: meta.traceparent ?? null,
      })
      .execute();
    await enqueueJob(tx, {
      queue: 'mail',
      kind: 'identity.mail.deliver',
      payloadRef: `mail:${id}`,
      dedupeKey: `mail:${id}`,
      maxAttempts: 8,
      timeoutSeconds: 30,
      context: this.#systemContext(meta),
    });
    this.#d.metrics.count('mail.enqueued', 1, { template: m.template });
  }

  /** Supersedes open tokens of a purpose and issues a new one (issuance lineage recorded). */
  async #rotateToken(
    tx: PlatformTransaction,
    accountId: string,
    purpose: TokenPurpose,
    lifetimeMs: number,
    context: Record<string, unknown> = {},
  ): Promise<{ raw: string; expiresAt: Date }> {
    const open = await tx.db
      .updateTable('identity.verification_token')
      .set({ revoked_at: new Date() })
      .where('account_id', '=', accountId)
      .where('purpose', '=', purpose)
      .where('consumed_at', 'is', null)
      .where('revoked_at', 'is', null)
      .returning(['id', 'created_at'])
      .execute();
    const previous = open.sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
    const token = newOpaqueToken();
    const expiresAt = new Date(Date.now() + lifetimeMs);
    await tx.db
      .insertInto('identity.verification_token')
      .values({
        id: newUuidV7(),
        purpose,
        account_id: accountId,
        token_hash: token.hash,
        expires_at: expiresAt,
        supersedes_token_id: previous?.id ?? null,
        context: JSON.stringify(context),
      })
      .execute();
    return { raw: token.raw, expiresAt };
  }

  /** Issues an independent token (concurrent sign-ins on several devices each keep their own). */
  async #issueToken(
    tx: PlatformTransaction,
    accountId: string,
    purpose: TokenPurpose,
    lifetimeMs: number,
    context: Record<string, unknown>,
  ): Promise<{ raw: string; expiresAt: Date }> {
    const token = newOpaqueToken();
    const expiresAt = new Date(Date.now() + lifetimeMs);
    await tx.db
      .insertInto('identity.verification_token')
      .values({
        id: newUuidV7(),
        purpose,
        account_id: accountId,
        token_hash: token.hash,
        expires_at: expiresAt,
        context: JSON.stringify(context),
      })
      .execute();
    return { raw: token.raw, expiresAt };
  }

  /** Consumes a one-time token atomically, classifying failures without revealing accounts. */
  async #consumeToken(
    tx: PlatformTransaction,
    purpose: TokenPurpose,
    raw: unknown,
  ): Promise<
    | {
        ok: true;
        id: string;
        accountId: string | null;
        context: Record<string, unknown>;
        sealedRef: string | null;
      }
    | { ok: false; problem: TokenProblem }
  > {
    if (!isWellFormedToken(raw)) return { ok: false, problem: 'token_invalid' };
    const row = await tx.db
      .selectFrom('identity.verification_token')
      .select([
        'id',
        'account_id',
        'expires_at',
        'consumed_at',
        'revoked_at',
        'context',
        'sealed_ref',
      ])
      .where('token_hash', '=', hashToken(raw))
      .where('purpose', '=', purpose)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.revoked_at) return { ok: false, problem: 'token_invalid' };
    if (row.consumed_at) return { ok: false, problem: 'token_used' };
    if (row.expires_at.getTime() <= Date.now()) return { ok: false, problem: 'token_expired' };
    await tx.db
      .updateTable('identity.verification_token')
      .set({ consumed_at: new Date() })
      .where('id', '=', row.id)
      .execute();
    return {
      ok: true,
      id: row.id,
      accountId: row.account_id,
      context: row.context,
      sealedRef: row.sealed_ref,
    };
  }

  #tokenError(problem: TokenProblem): IdentityError {
    const messages: Record<TokenProblem, string> = {
      token_invalid: 'This link is not valid. Request a new one.',
      token_expired: 'This link has expired. Request a new one.',
      token_used: 'This link was already used.',
    };
    return new IdentityError('validation_failed', {
      issues: [issue('/token', problem, messages[problem])],
    });
  }

  async #issueSession(
    tx: PlatformTransaction,
    accountId: string,
    methods: AuthMethod[],
    meta: RequestMeta,
    replacing?: { sessionId?: string | undefined; rawToken?: string | undefined },
  ): Promise<IssuedSession> {
    const now = new Date();
    // Session fixation protection: always a new server-generated token; any presented session is
    // revoked and linked as the predecessor.
    let rotatedFrom: string | null = null;
    if (replacing?.sessionId || replacing?.rawToken) {
      let q = tx.db
        .updateTable('identity.session')
        .set({ revoked_at: now, revoke_reason: 'rotated' })
        .where('revoked_at', 'is', null);
      q = replacing.sessionId
        ? q.where('id', '=', replacing.sessionId)
        : q.where('token_hash', '=', hashToken(replacing.rawToken!));
      const prev = await q.returning('id').executeTakeFirst();
      rotatedFrom = prev?.id ?? null;
    }
    const token = newOpaqueToken();
    const multi = methods.some((m) => m === 'totp' || m === 'recovery_code' || m === 'webauthn');
    const absolute = new Date(now.getTime() + this.#d.config.sessionAbsoluteMs);
    const idle = new Date(
      Math.min(now.getTime() + this.#d.config.sessionIdleMs, absolute.getTime()),
    );
    const row = await tx.db
      .insertInto('identity.session')
      .values({
        id: newUuidV7(),
        public_id: newPublicId('ses'),
        account_id: accountId,
        token_hash: token.hash,
        created_at: now,
        last_seen_at: now,
        idle_expires_at: idle,
        absolute_expires_at: absolute,
        auth_methods: methods,
        assurance: multi ? 'multi_factor' : 'single_factor',
        mfa_verified_at: multi ? now : null,
        rotated_from_session_id: rotatedFrom,
        device_label: deviceLabel(meta.userAgent) ?? null,
        network_prefix: networkPrefix(meta.ip) ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { token: token.raw, session: toSessionView(row) };
  }

  async #accountView(tx: PlatformTransaction, accountId: string): Promise<AccountView> {
    const a = await tx.db
      .selectFrom('identity.account')
      .selectAll()
      .where('id', '=', accountId)
      .executeTakeFirstOrThrow();
    return toAccountView(a);
  }

  async #hasActiveTotp(tx: PlatformTransaction, accountId: string): Promise<boolean> {
    const f = await tx.db
      .selectFrom('identity.mfa_factor')
      .select('id')
      .where('account_id', '=', accountId)
      .where('factor_type', '=', 'totp')
      .where('state', '=', 'active')
      .executeTakeFirst();
    return Boolean(f);
  }

  // -------------------------------------------------------------------------------------------
  // Registration and email verification
  // -------------------------------------------------------------------------------------------

  /**
   * Always resolves to the same acknowledgement whether the account is new, unverified, or
   * existing; the difference is only in which mail the (address owner) receives.
   */
  async register(
    input: {
      email: unknown;
      password: unknown;
      displayName: unknown;
      locale?: unknown;
      timezone?: unknown;
      termsVersion: unknown;
      privacyVersion: unknown;
      botProof?: unknown;
    },
    meta: RequestMeta,
  ): Promise<'accepted'> {
    return this.#flow('register', () =>
      withResponseFloor(this.#d.config.responseFloorMs, async () => {
        const issues = [];
        let email: ReturnType<typeof normalizeEmail> | undefined;
        try {
          email = normalizeEmail(input.email);
        } catch (err) {
          if (!(err instanceof EmailFormatError)) throw err;
          issues.push(
            issue('/email', 'invalid_email', 'Enter a valid email address, like name@example.com.'),
          );
        }
        const pw = checkPasswordPolicy(input.password);
        if (pw) issues.push(passwordIssue(pw));
        const displayName =
          typeof input.displayName === 'string' ? input.displayName.normalize('NFC').trim() : '';
        if (!DISPLAY_NAME.test(displayName))
          issues.push(
            issue('/display_name', 'invalid_value', 'Enter your name (up to 120 characters).'),
          );
        const locale =
          typeof input.locale === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(input.locale)
            ? input.locale
            : 'en';
        const timezone =
          typeof input.timezone === 'string' && VALID_TIMEZONES.has(input.timezone)
            ? input.timezone
            : 'UTC';
        const legal = this.#d.config.legal;
        if (
          input.termsVersion !== legal.termsVersion ||
          input.privacyVersion !== legal.privacyVersion
        ) {
          issues.push(
            issue(
              '/accept_terms',
              'acknowledgement_required',
              'Accept the terms of service and privacy notice to continue.',
            ),
          );
        }
        if (!(await this.#d.bot.verify(input.botProof)))
          issues.push(
            issue('/bot_proof', 'verification_required', 'Complete the verification step.'),
          );
        if (issues.length) throw new IdentityError('validation_failed', { issues });
        await this.#limit('register.source', this.#source(meta));
        await this.#limit('register.email', email!.key);

        // Hash on every path so new and existing addresses cost the same.
        const hashed = await this.#d.hasher.hash(input.password as string);
        await this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
          const accountId = newUuidV7();
          const inserted = await tx.db
            .insertInto('identity.account')
            .values({
              id: accountId,
              public_id: newPublicId('acct'),
              primary_email: email!.display,
              email_key: email!.key,
              display_name: displayName,
              locale,
              timezone,
              terms_version: legal.termsVersion,
              privacy_version: legal.privacyVersion,
              legal_acknowledged_at: new Date(),
            })
            .onConflict((oc) => oc.column('email_key').doNothing())
            .returning('id')
            .executeTakeFirst();
          if (inserted) {
            await tx.db
              .insertInto('identity.credential')
              .values({
                account_id: accountId,
                password_hash: hashed.hash,
                password_salt: hashed.salt,
                algorithm: 'argon2id',
                params: JSON.stringify(hashed.params),
              })
              .execute();
            const t = await this.#rotateToken(
              tx,
              accountId,
              'email_verification',
              this.#d.config.emailVerificationTokenMs,
            );
            await this.#enqueueMail(tx, meta, {
              template: 'email_verification',
              recipient: email!.display,
              locale,
              accountId,
              token: t.raw,
              tokenExpiresAt: t.expiresAt,
            });
            await this.#event(tx, meta, {
              category: 'authentication',
              action: 'account.registered',
              outcome: 'success',
              actor: { type: 'human', id: accountId },
              subject: { type: 'account', id: accountId },
            });
            return;
          }
          const existing = await tx.db
            .selectFrom('identity.account')
            .select(['id', 'primary_email', 'locale', 'email_verified_at'])
            .where('email_key', '=', email!.key)
            .executeTakeFirstOrThrow();
          if (existing.email_verified_at) {
            await this.#enqueueMail(tx, meta, {
              template: 'account_exists',
              recipient: existing.primary_email,
              locale: existing.locale,
              accountId: existing.id,
            });
          } else {
            await this.#resendWithinCooldown(tx, meta, existing);
          }
          await this.#event(tx, meta, {
            category: 'authentication',
            action: 'account.register_existing',
            outcome: 'failure',
            actor: { type: 'human' },
            subject: { type: 'account', id: existing.id },
          });
        });
        return 'accepted' as const;
      }),
    );
  }

  async #resendWithinCooldown(
    tx: PlatformTransaction,
    meta: RequestMeta,
    account: { id: string; primary_email: string; locale: string },
  ): Promise<void> {
    const recent = await tx.db
      .selectFrom('identity.verification_token')
      .select('id')
      .where('account_id', '=', account.id)
      .where('purpose', '=', 'email_verification')
      .where('created_at', '>', new Date(Date.now() - this.#d.config.resendCooldownMs))
      .executeTakeFirst();
    if (recent) return;
    const t = await this.#rotateToken(
      tx,
      account.id,
      'email_verification',
      this.#d.config.emailVerificationTokenMs,
    );
    await this.#enqueueMail(tx, meta, {
      template: 'email_verification',
      recipient: account.primary_email,
      locale: account.locale,
      accountId: account.id,
      token: t.raw,
      tokenExpiresAt: t.expiresAt,
    });
  }

  async verifyEmail(token: unknown, meta: RequestMeta): Promise<'verified'> {
    return this.#flow('verify_email', async () => {
      await this.#limit('token.source', this.#source(meta));
      await this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
        const r = await this.#consumeToken(tx, 'email_verification', token);
        if (!r.ok) throw this.#tokenError(r.problem);
        await tx.db
          .updateTable('identity.account')
          .set({
            email_verified_at: sql`coalesce(email_verified_at, now())`,
            updated_at: new Date(),
            version: sql`version + 1`,
          })
          .where('id', '=', r.accountId!)
          .execute();
        await this.#event(tx, meta, {
          category: 'token',
          action: 'email.verified',
          outcome: 'success',
          actor: { type: 'human', id: r.accountId! },
          subject: { type: 'account', id: r.accountId! },
        });
      });
      return 'verified' as const;
    });
  }

  async resendVerification(emailInput: unknown, meta: RequestMeta): Promise<'accepted'> {
    return this.#flow('resend_verification', () =>
      withResponseFloor(this.#d.config.responseFloorMs, async () => {
        let email: ReturnType<typeof normalizeEmail>;
        try {
          email = normalizeEmail(emailInput);
        } catch {
          throw new IdentityError('validation_failed', {
            issues: [
              issue(
                '/email',
                'invalid_email',
                'Enter a valid email address, like name@example.com.',
              ),
            ],
          });
        }
        await this.#limit('resend.source', this.#source(meta));
        await this.#limit('resend.email', email.key);
        await this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
          const account = await tx.db
            .selectFrom('identity.account')
            .select(['id', 'primary_email', 'locale', 'email_verified_at'])
            .where('email_key', '=', email.key)
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
          if (account && !account.email_verified_at)
            await this.#resendWithinCooldown(tx, meta, account);
        });
        return 'accepted' as const;
      }),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Sign-in, MFA continuation, sessions
  // -------------------------------------------------------------------------------------------

  /**
   * Email/password sign-in. Generic failure for unknown accounts and wrong passwords (same work,
   * same response). A session is issued only after every required factor succeeds.
   */
  async signIn(
    input: { email: unknown; password: unknown },
    meta: RequestMeta,
    presentedToken?: string,
  ): Promise<
    | { kind: 'session'; issued: IssuedSession }
    | { kind: 'mfa_required'; continuation: string; methods: StepUpMethod[] }
  > {
    return this.#flow('sign_in', () =>
      withResponseFloor(this.#d.config.responseFloorMs, async () => {
        const invalid = () =>
          new IdentityError('unauthenticated', {
            issues: [issue('/email', 'invalid_credentials', 'The email or password is incorrect.')],
          });
        let email: ReturnType<typeof normalizeEmail> | undefined;
        try {
          email = normalizeEmail(input.email);
        } catch {
          email = undefined;
        }
        await this.#limit('sign_in.source', this.#source(meta));
        if (email) await this.#limit('sign_in.email', email.key);
        const password = typeof input.password === 'string' ? input.password : '';
        const row = email
          ? await this.#d.db.withPlatform({ module: 'identity', readOnly: true }, (tx) =>
              tx.db
                .selectFrom('identity.account as a')
                .innerJoin('identity.credential as c', 'c.account_id', 'a.id')
                .select(['a.id', 'c.password_hash', 'c.password_salt', 'c.params', 'c.version'])
                .where('a.email_key', '=', email.key)
                .where('a.deleted_at', 'is', null)
                .executeTakeFirst(),
            )
          : undefined;
        if (!row) {
          await this.#d.hasher.verifyDummy(password);
          await this.#d.db.withPlatform({ module: 'identity' }, (tx) =>
            this.#event(tx, meta, {
              category: 'authentication',
              action: 'sign_in.password',
              outcome: 'failure',
              actor: { type: 'human' },
            }),
          );
          throw invalid();
        }
        const params = row.params as Argon2Params;
        const ok = await this.#d.hasher.verify(password, {
          hash: row.password_hash,
          salt: row.password_salt,
          params,
        });
        if (!ok) {
          await this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
            await tx.db
              .updateTable('identity.credential')
              .set({ failed_attempts: sql`failed_attempts + 1`, last_failed_at: new Date() })
              .where('account_id', '=', row.id)
              .execute();
            await this.#event(tx, meta, {
              category: 'authentication',
              action: 'sign_in.password',
              outcome: 'failure',
              actor: { type: 'human' },
              subject: { type: 'account', id: row.id },
            });
          });
          throw invalid();
        }
        const rehash = this.#d.hasher.needsRehash(params)
          ? await this.#d.hasher.hash(password)
          : undefined;
        return this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
          // Credential unchanged since verification (a concurrent reset wins).
          const current = await tx.db
            .selectFrom('identity.credential')
            .select('version')
            .where('account_id', '=', row.id)
            .forShare()
            .executeTakeFirst();
          if (!current || current.version !== row.version) throw invalid();
          await tx.db
            .updateTable('identity.credential')
            .set({
              failed_attempts: 0,
              ...(rehash
                ? {
                    password_hash: rehash.hash,
                    password_salt: rehash.salt,
                    params: JSON.stringify(rehash.params),
                    updated_at: new Date(),
                  }
                : {}),
            })
            .where('account_id', '=', row.id)
            .execute();
          if (await this.#hasActiveTotp(tx, row.id)) {
            const t = await this.#issueToken(
              tx,
              row.id,
              'sign_in_continuation',
              this.#d.config.signInContinuationMs,
              {
                credential_version: row.version,
                first_factor: 'password',
              },
            );
            await this.#event(tx, meta, {
              category: 'authentication',
              action: 'sign_in.password',
              outcome: 'success',
              actor: { type: 'human', id: row.id },
              subject: { type: 'account', id: row.id },
            });
            return {
              kind: 'mfa_required' as const,
              continuation: t.raw,
              methods: ['totp', 'recovery_code'] as StepUpMethod[],
            };
          }
          const issued = await this.#issueSession(tx, row.id, ['password'], meta, {
            rawToken: presentedToken,
          });
          await this.#event(tx, meta, {
            category: 'session',
            action: 'session.created',
            outcome: 'success',
            actor: { type: 'human', id: row.id },
            subject: { type: 'session', id: issued.session.id },
          });
          return { kind: 'session' as const, issued };
        });
      }),
    );
  }

  /** Second factor after a successful first factor (password or OAuth). */
  async completeSignIn(
    input: { continuation: unknown; method: unknown; code: unknown },
    meta: RequestMeta,
    presentedToken?: string,
  ): Promise<IssuedSession> {
    return this.#flow('sign_in_mfa', async () => {
      await this.#limit('token.source', this.#source(meta));
      if (!isWellFormedToken(input.continuation)) throw this.#continuationError();
      const continuation = input.continuation;
      const method =
        input.method === 'recovery_code'
          ? 'recovery_code'
          : input.method === 'totp'
            ? 'totp'
            : undefined;
      if (!method)
        throw new IdentityError('validation_failed', {
          issues: [issue('/method', 'invalid_value', 'Choose a verification method.')],
        });
      const found = await this.#d.db.withPlatform({ module: 'identity', readOnly: true }, (tx) =>
        tx.db
          .selectFrom('identity.verification_token')
          .select(['account_id'])
          .where('token_hash', '=', hashToken(continuation))
          .where('purpose', '=', 'sign_in_continuation')
          .executeTakeFirst(),
      );
      if (found?.account_id) await this.#limit('mfa.account', found.account_id);
      const result = await this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
        const row = await tx.db
          .selectFrom('identity.verification_token')
          .select([
            'id',
            'account_id',
            'expires_at',
            'consumed_at',
            'revoked_at',
            'attempts',
            'context',
          ])
          .where('token_hash', '=', hashToken(continuation))
          .where('purpose', '=', 'sign_in_continuation')
          .forUpdate()
          .executeTakeFirst();
        if (
          !row ||
          row.consumed_at ||
          row.revoked_at ||
          row.expires_at.getTime() <= Date.now() ||
          row.attempts >= MFA_CONTINUATION_MAX_ATTEMPTS
        ) {
          return { ok: false as const, kind: 'restart' as const };
        }
        const accountId = row.account_id!;
        const passed = await this.#verifySecondFactor(tx, accountId, method, input.code);
        if (!passed) {
          const attempts = row.attempts + 1;
          await tx.db
            .updateTable('identity.verification_token')
            .set({
              attempts,
              ...(attempts >= MFA_CONTINUATION_MAX_ATTEMPTS ? { revoked_at: new Date() } : {}),
            })
            .where('id', '=', row.id)
            .execute();
          await this.#event(tx, meta, {
            category: 'authentication',
            action: `sign_in.${method}`,
            outcome: 'failure',
            actor: { type: 'human', id: accountId },
            subject: { type: 'account', id: accountId },
          });
          return {
            ok: false as const,
            kind:
              attempts >= MFA_CONTINUATION_MAX_ATTEMPTS
                ? ('restart' as const)
                : ('invalid_code' as const),
          };
        }
        const cred = await tx.db
          .selectFrom('identity.credential')
          .select('version')
          .where('account_id', '=', accountId)
          .forShare()
          .executeTakeFirst();
        const ctx = row.context as { credential_version?: number; first_factor?: string };
        if (ctx.first_factor === 'password' && cred?.version !== ctx.credential_version)
          return { ok: false as const, kind: 'restart' as const };
        await tx.db
          .updateTable('identity.verification_token')
          .set({ consumed_at: new Date() })
          .where('id', '=', row.id)
          .execute();
        const first: AuthMethod = ctx.first_factor === 'oauth' ? 'oauth' : 'password';
        const issued = await this.#issueSession(tx, accountId, [first, method], meta, {
          rawToken: presentedToken,
        });
        await this.#event(tx, meta, {
          category: 'session',
          action: 'session.created',
          outcome: 'success',
          actor: { type: 'human', id: accountId },
          subject: { type: 'session', id: issued.session.id },
        });
        return { ok: true as const, issued };
      });
      if (!result.ok) {
        if (result.kind === 'restart') throw this.#continuationError();
        throw new IdentityError('validation_failed', {
          issues: [
            issue('/code', 'invalid_code', "That code didn't work. Check it and try again."),
          ],
        });
      }
      return result.issued;
    });
  }

  #continuationError(): IdentityError {
    return new IdentityError('unauthenticated', {
      issues: [issue('/continuation', 'sign_in_restart', 'Your sign-in expired. Sign in again.')],
    });
  }

  /** TOTP (replay-protected) or one-time recovery code; consumes the proof atomically. */
  async #verifySecondFactor(
    tx: PlatformTransaction,
    accountId: string,
    method: 'totp' | 'recovery_code' | 'password',
    code: unknown,
  ): Promise<boolean> {
    if (method === 'recovery_code') {
      const normalized = normalizeRecoveryCode(code);
      if (!normalized) return false;
      const used = await tx.db
        .updateTable('identity.recovery_code')
        .set({ used_at: new Date() })
        .where('account_id', '=', accountId)
        .where('code_hash', '=', hashRecoveryCode(normalized))
        .where('used_at', 'is', null)
        .where('revoked_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      return Boolean(used);
    }
    if (method === 'password') {
      const cred = await tx.db
        .selectFrom('identity.credential')
        .select(['password_hash', 'password_salt', 'params'])
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      if (!cred || typeof code !== 'string') {
        await this.#d.hasher.verifyDummy(typeof code === 'string' ? code : '');
        return false;
      }
      return this.#d.hasher.verify(code, {
        hash: cred.password_hash,
        salt: cred.password_salt,
        params: cred.params as Argon2Params,
      });
    }
    const factor = await tx.db
      .selectFrom('identity.mfa_factor')
      .select(['id', 'secret_ref', 'last_used_step'])
      .where('account_id', '=', accountId)
      .where('factor_type', '=', 'totp')
      .where('state', '=', 'active')
      .forUpdate()
      .executeTakeFirst();
    if (!factor?.secret_ref) return false;
    const secret = await this.#d.vault.get(factor.secret_ref, { scope: tx });
    if (!secret) return false;
    const step = verifyTotp(secret, code);
    if (step === undefined || (factor.last_used_step !== null && step <= factor.last_used_step))
      return false;
    // Atomic replay guard: a concurrent verification of the same code loses here.
    const updated = await tx.db
      .updateTable('identity.mfa_factor')
      .set({
        last_used_step: step,
        last_used_at: new Date(),
        updated_at: new Date(),
        version: sql`version + 1`,
      })
      .where('id', '=', factor.id)
      .where((eb) => eb.or([eb('last_used_step', 'is', null), eb('last_used_step', '<', step)]))
      .returning('id')
      .executeTakeFirst();
    return Boolean(updated);
  }

  /**
   * Resolves a session cookie on every authenticated request: revoked, idle-expired, or
   * absolute-expired sessions are rejected; last-seen is written at most every touch interval.
   */
  async resolveSession(
    raw: string | undefined,
  ): Promise<
    { status: 'ok'; ctx: AuthContext } | { status: 'none' | 'invalid' | 'expired' | 'revoked' }
  > {
    if (raw === undefined) return { status: 'none' };
    if (!isWellFormedToken(raw)) return { status: 'invalid' };
    return this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
      const row = await tx.db
        .selectFrom('identity.session as s')
        .innerJoin('identity.account as a', 'a.id', 's.account_id')
        .selectAll('s')
        .select([
          'a.public_id as account_public_id',
          'a.primary_email',
          'a.display_name',
          'a.locale',
          'a.timezone',
          'a.email_verified_at',
          'a.deleted_at',
        ])
        .where('s.token_hash', '=', hashToken(raw))
        .executeTakeFirst();
      if (!row || row.deleted_at) return { status: 'invalid' as const };
      if (row.revoked_at) return { status: 'revoked' as const };
      const now = Date.now();
      if (now >= row.absolute_expires_at.getTime() || now >= row.idle_expires_at.getTime())
        return { status: 'expired' as const };
      let session = row;
      if (now - row.last_seen_at.getTime() >= this.#d.config.sessionTouchMs) {
        const idle = new Date(
          Math.min(now + this.#d.config.sessionIdleMs, row.absolute_expires_at.getTime()),
        );
        await tx.db
          .updateTable('identity.session')
          .set({ last_seen_at: new Date(now), idle_expires_at: idle })
          .where('id', '=', row.id)
          .execute();
        session = { ...row, last_seen_at: new Date(now), idle_expires_at: idle };
      }
      return {
        status: 'ok' as const,
        ctx: {
          principal: 'account' as const,
          account: {
            id: row.account_id,
            publicId: row.account_public_id,
            email: row.primary_email,
            displayName: row.display_name,
            locale: row.locale,
            timezone: row.timezone,
            emailVerified: row.email_verified_at !== null,
          },
          session: toSessionView(session),
        },
      };
    });
  }

  async signOut(ctx: AuthContext, meta: RequestMeta): Promise<void> {
    return this.#flow('sign_out', () =>
      this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
        await this.#revoke(tx, ctx.account.id, 'sign_out', { only: ctx.session.id });
        await this.#event(tx, meta, {
          category: 'session',
          action: 'session.signed_out',
          outcome: 'success',
          actor: { type: 'human', id: ctx.account.id },
          subject: { type: 'session', id: ctx.session.id },
        });
      }),
    );
  }

  async #revoke(
    tx: PlatformTransaction,
    accountId: string,
    reason:
      | 'sign_out'
      | 'sign_out_everywhere'
      | 'revoked_by_owner'
      | 'password_reset'
      | 'password_changed'
      | 'mfa_changed'
      | 'administrative',
    scope: { only?: string; except?: string } = {},
  ): Promise<number> {
    let q = tx.db
      .updateTable('identity.session')
      .set({ revoked_at: new Date(), revoke_reason: reason, version: sql`version + 1` })
      .where('account_id', '=', accountId)
      .where('revoked_at', 'is', null);
    if (scope.only) q = q.where('id', '=', scope.only);
    if (scope.except) q = q.where('id', '!=', scope.except);
    const res = await q.executeTakeFirst();
    return Number(res.numUpdatedRows);
  }

  async listSessions(ctx: AuthContext): Promise<
    Array<{
      publicId: string;
      deviceLabel: string | null;
      createdAt: Date;
      lastSeenAt: Date;
      current: boolean;
      state: 'active' | 'revoked' | 'expired';
    }>
  > {
    const rows = await this.#d.db.withPlatform({ module: 'identity', readOnly: true }, (tx) =>
      tx.db
        .selectFrom('identity.session')
        .select([
          'id',
          'public_id',
          'device_label',
          'created_at',
          'last_seen_at',
          'revoked_at',
          'idle_expires_at',
          'absolute_expires_at',
        ])
        .where('account_id', '=', ctx.account.id)
        .where((eb) =>
          eb.or([
            eb('revoked_at', 'is', null),
            eb('revoked_at', '>', new Date(Date.now() - 7 * 86_400_000)),
          ]),
        )
        .orderBy('last_seen_at', 'desc')
        .orderBy('id', 'desc')
        .limit(50)
        .execute(),
    );
    const now = Date.now();
    return rows.map((r) => ({
      publicId: r.public_id,
      deviceLabel: r.device_label,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      current: r.id === ctx.session.id,
      state: r.revoked_at
        ? 'revoked'
        : now >= r.idle_expires_at.getTime() || now >= r.absolute_expires_at.getTime()
          ? 'expired'
          : 'active',
    }));
  }

  /** Revokes one of the caller's other sessions. Repeating it is harmless. */
  async revokeSession(
    ctx: AuthContext,
    sessionPublicId: unknown,
    meta: RequestMeta,
  ): Promise<void> {
    return this.#flow('session_revoke', () =>
      this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
        const target =
          typeof sessionPublicId === 'string'
            ? await tx.db
                .selectFrom('identity.session')
                .select(['id', 'revoked_at'])
                .where('public_id', '=', sessionPublicId)
                .where('account_id', '=', ctx.account.id)
                .executeTakeFirst()
            : undefined;
        if (!target) throw new IdentityError('not_found');
        if (target.id === ctx.session.id) {
          throw new IdentityError('validation_failed', {
            issues: [issue('/session', 'current_session', 'Use "Sign out" to end this session.')],
          });
        }
        if (!target.revoked_at) {
          await this.#revoke(tx, ctx.account.id, 'revoked_by_owner', { only: target.id });
          await this.#event(tx, meta, {
            category: 'session',
            action: 'session.revoked',
            outcome: 'success',
            actor: { type: 'human', id: ctx.account.id },
            subject: { type: 'session', id: target.id },
          });
        }
      }),
    );
  }

  /** Revokes all other sessions (or every session, including this one, with `includeCurrent`). */
  async revokeOtherSessions(
    ctx: AuthContext,
    meta: RequestMeta,
    includeCurrent = false,
  ): Promise<number> {
    return this.#flow(includeCurrent ? 'sign_out' : 'session_revoke', () =>
      this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
        const n = await this.#revoke(
          tx,
          ctx.account.id,
          includeCurrent ? 'sign_out_everywhere' : 'revoked_by_owner',
          includeCurrent ? {} : { except: ctx.session.id },
        );
        await this.#event(tx, meta, {
          category: 'session',
          action: includeCurrent ? 'session.signed_out_everywhere' : 'session.revoked_others',
          outcome: 'success',
          actor: { type: 'human', id: ctx.account.id },
          subject: { type: 'account', id: ctx.account.id },
        });
        if (n > 0)
          await this.#enqueueMail(tx, meta, {
            template: 'sessions_revoked',
            recipient: ctx.account.email,
            locale: ctx.account.locale,
            accountId: ctx.account.id,
          });
        return n;
      }),
    );
  }

  /**
   * Internal, authorization-ready command for `sessions.manage_others` (0C, step-up). Not exposed
   * by any route until 1D supplies memberships, the policy decision, and the step-up binding.
   */
  async revokeAccountSessionsAsAdministrator(
    decision: ManageOthersDecision,
    targetAccountId: string,
    meta: RequestMeta,
  ): Promise<number> {
    if (decision.action !== 'sessions.manage_others' || decision.allowed !== true)
      throw new IdentityError('forbidden');
    return this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
      const n = await this.#revoke(tx, targetAccountId, 'administrative');
      await this.#d.events.record(tx, {
        category: 'session',
        action: 'session.revoked_by_administrator',
        outcome: 'success',
        actor: { type: 'human', id: decision.actorAccountId },
        subject: { type: 'account', id: targetAccountId },
        correlationId: meta.correlationId,
      });
      return n;
    });
  }

  async me(ctx: AuthContext): Promise<{
    account: AccountView;
    session: SessionView;
    mfa: { totp: boolean; recoveryCodesRemaining: number };
  }> {
    const mfa = await this.mfaStatus(ctx);
    return {
      account: ctx.account,
      session: ctx.session,
      mfa: {
        totp: mfa.totp?.state === 'active',
        recoveryCodesRemaining: mfa.recoveryCodesRemaining,
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Password recovery and change
  // -------------------------------------------------------------------------------------------

  async requestPasswordReset(emailInput: unknown, meta: RequestMeta): Promise<'accepted'> {
    return this.#flow('password_reset_request', () =>
      withResponseFloor(this.#d.config.responseFloorMs, async () => {
        let email: ReturnType<typeof normalizeEmail>;
        try {
          email = normalizeEmail(emailInput);
        } catch {
          throw new IdentityError('validation_failed', {
            issues: [
              issue(
                '/email',
                'invalid_email',
                'Enter a valid email address, like name@example.com.',
              ),
            ],
          });
        }
        await this.#limit('recovery.source', this.#source(meta));
        await this.#limit('recovery.email', email.key);
        await this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
          const account = await tx.db
            .selectFrom('identity.account')
            .select(['id', 'primary_email', 'locale'])
            .where('email_key', '=', email.key)
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
          if (!account) return;
          const recent = await tx.db
            .selectFrom('identity.verification_token')
            .select('id')
            .where('account_id', '=', account.id)
            .where('purpose', '=', 'password_reset')
            .where('created_at', '>', new Date(Date.now() - this.#d.config.resendCooldownMs))
            .executeTakeFirst();
          if (recent) return;
          const t = await this.#rotateToken(
            tx,
            account.id,
            'password_reset',
            this.#d.config.passwordResetTokenMs,
          );
          await this.#enqueueMail(tx, meta, {
            template: 'password_reset',
            recipient: account.primary_email,
            locale: account.locale,
            accountId: account.id,
            token: t.raw,
            tokenExpiresAt: t.expiresAt,
          });
          await this.#event(tx, meta, {
            category: 'token',
            action: 'password_reset.requested',
            outcome: 'success',
            actor: { type: 'human' },
            subject: { type: 'account', id: account.id },
          });
        });
        return 'accepted' as const;
      }),
    );
  }

  /**
   * Consumes the reset token and replaces the credential atomically; revokes every session and
   * every outstanding recovery/continuation token. Does not sign the user in.
   */
  async resetPassword(
    input: { token: unknown; password: unknown },
    meta: RequestMeta,
  ): Promise<'reset'> {
    return this.#flow('password_reset', async () => {
      const pw = checkPasswordPolicy(input.password);
      if (pw) throw new IdentityError('validation_failed', { issues: [passwordIssue(pw)] });
      await this.#limit('token.source', this.#source(meta));
      const hashed = await this.#d.hasher.hash(input.password as string);
      await this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
        const r = await this.#consumeToken(tx, 'password_reset', input.token);
        if (!r.ok) throw this.#tokenError(r.problem);
        const accountId = r.accountId!;
        await tx.db
          .updateTable('identity.credential')
          .set({
            password_hash: hashed.hash,
            password_salt: hashed.salt,
            params: JSON.stringify(hashed.params),
            password_changed_at: new Date(),
            failed_attempts: 0,
            updated_at: new Date(),
            version: sql`version + 1`,
          })
          .where('account_id', '=', accountId)
          .execute();
        await this.#revoke(tx, accountId, 'password_reset');
        await tx.db
          .updateTable('identity.verification_token')
          .set({ revoked_at: new Date() })
          .where('account_id', '=', accountId)
          .where('purpose', 'in', ['password_reset', 'sign_in_continuation'])
          .where('consumed_at', 'is', null)
          .where('revoked_at', 'is', null)
          .execute();
        // Possession of the reset link proves control of the mailbox.
        await tx.db
          .updateTable('identity.account')
          .set({
            email_verified_at: sql`coalesce(email_verified_at, now())`,
            updated_at: new Date(),
            version: sql`version + 1`,
          })
          .where('id', '=', accountId)
          .execute();
        const a = await this.#accountView(tx, accountId);
        await this.#enqueueMail(tx, meta, {
          template: 'password_changed',
          recipient: a.email,
          locale: a.locale,
          accountId,
        });
        await this.#event(tx, meta, {
          category: 'authentication',
          action: 'password.reset',
          outcome: 'success',
          actor: { type: 'human', id: accountId },
          subject: { type: 'account', id: accountId },
        });
      });
      return 'reset' as const;
    });
  }

  /** Authenticated change: current password required; other sessions revoked; this one rotated. */
  async changePassword(
    ctx: AuthContext,
    input: { currentPassword: unknown; newPassword: unknown },
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    return this.#flow('password_change', async () => {
      const pw = checkPasswordPolicy(input.newPassword);
      if (pw)
        throw new IdentityError('validation_failed', {
          issues: [{ ...passwordIssue(pw), pointer: '/new_password' }],
        });
      await this.#limit('mfa.account', ctx.account.id);
      const current = await this.#d.db.withPlatform({ module: 'identity', readOnly: true }, (tx) =>
        this.#verifySecondFactor(tx, ctx.account.id, 'password', input.currentPassword),
      );
      if (!current) {
        throw new IdentityError('validation_failed', {
          issues: [
            issue(
              '/current_password',
              'invalid_credentials',
              'Your current password is incorrect.',
            ),
          ],
        });
      }
      const hashed = await this.#d.hasher.hash(input.newPassword as string);
      return this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
        await tx.db
          .updateTable('identity.credential')
          .set({
            password_hash: hashed.hash,
            password_salt: hashed.salt,
            params: JSON.stringify(hashed.params),
            password_changed_at: new Date(),
            updated_at: new Date(),
            version: sql`version + 1`,
          })
          .where('account_id', '=', ctx.account.id)
          .execute();
        await this.#revoke(tx, ctx.account.id, 'password_changed', { except: ctx.session.id });
        const issued = await this.#issueSession(tx, ctx.account.id, ctx.session.authMethods, meta, {
          sessionId: ctx.session.id,
        });
        await this.#enqueueMail(tx, meta, {
          template: 'password_changed',
          recipient: ctx.account.email,
          locale: ctx.account.locale,
          accountId: ctx.account.id,
        });
        await this.#event(tx, meta, {
          category: 'authentication',
          action: 'password.changed',
          outcome: 'success',
          actor: { type: 'human', id: ctx.account.id },
          subject: { type: 'account', id: ctx.account.id },
        });
        return issued;
      });
    });
  }

  // -------------------------------------------------------------------------------------------
  // Protected actions: idempotency + step-up in the action's own transaction
  // -------------------------------------------------------------------------------------------

  async #protected<T>(
    ctx: AuthContext | NonHumanPrincipal,
    action: (typeof ACCOUNT_STEP_UP_ACTIONS)[number] | undefined,
    target: { type: string; id: string } | undefined,
    req: ProtectedRequest,
    meta: RequestMeta,
    fn: (
      tx: PlatformTransaction,
      ctx: AuthContext,
    ) => Promise<{ status: number; refs: Array<{ id: string; type: string }>; result: T }>,
  ): Promise<T | ReplayResult> {
    if (ctx.principal !== 'account') throw new IdentityError('step_up_unavailable');
    if (!/^[A-Za-z0-9_.:-]{16,128}$/.test(req.idempotencyKey)) {
      throw new IdentityError('validation_failed', {
        issues: [
          issue(
            '/headers/idempotency-key',
            'idempotency_key_required',
            'An Idempotency-Key header (16-128 characters) is required.',
          ),
        ],
      });
    }
    const principal = { type: 'account' as const, id: ctx.account.id };
    const outcome = await this.#d.db
      .withPlatform({ module: 'identity' }, async (tx) => {
        const reserved = await reserveIdempotencyKey(tx, {
          principal,
          key: req.idempotencyKey,
          fingerprint: req.fingerprint,
          retentionMs: IDEMPOTENCY_RETENTION_MS,
        });
        if (reserved.outcome === 'replay')
          return { kind: 'replay' as const, status: reserved.response.status };
        if (reserved.outcome === 'in_progress')
          throw new IdentityError('idempotency_in_progress', { retryAfterSeconds: 1 });
        if (reserved.outcome === 'key_reuse') throw new IdentityError('idempotency_key_reuse');
        if (action) {
          const consumed = req.stepUpToken
            ? await this.#consumeStepUp(tx, ctx, action, target, req, meta)
            : false;
          if (!consumed) throw new StepUpNeeded();
        }
        const done = await fn(tx, ctx);
        await completeIdempotencyKey(tx, principal, req.idempotencyKey, {
          status: done.status,
          resource_refs: done.refs,
        });
        return { kind: 'done' as const, result: done.result };
      })
      .catch(async (err: unknown) => {
        if (!(err instanceof StepUpNeeded)) throw err;
        const challenge = await this.createStepUpChallenge(
          ctx,
          { actionKey: action!, target, idempotencyKey: req.idempotencyKey },
          meta,
        );
        throw new IdentityError('step_up_required', { challenge });
      });
    if (outcome.kind === 'replay') return { replayed: true, status: outcome.status };
    return outcome.result;
  }

  // -------------------------------------------------------------------------------------------
  // MFA (TOTP + recovery codes)
  // -------------------------------------------------------------------------------------------

  async mfaStatus(ctx: AuthContext): Promise<{
    totp: { publicId: string; state: string; verifiedAt: Date | null } | null;
    recoveryCodesRemaining: number;
  }> {
    return this.#d.db.withPlatform({ module: 'identity', readOnly: true }, async (tx) => {
      const f = await tx.db
        .selectFrom('identity.mfa_factor')
        .select(['public_id', 'state', 'verified_at'])
        .where('account_id', '=', ctx.account.id)
        .where('factor_type', '=', 'totp')
        .where('state', 'in', ['pending', 'active'])
        .executeTakeFirst();
      const codes = await tx.db
        .selectFrom('identity.recovery_code')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('account_id', '=', ctx.account.id)
        .where('used_at', 'is', null)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      return {
        totp: f ? { publicId: f.public_id, state: f.state, verifiedAt: f.verified_at } : null,
        recoveryCodesRemaining: Number(codes?.n ?? 0),
      };
    });
  }

  /** Step-up protected (account.mfa_enroll). Returns the secret once; it is stored only in the vault. */
  async beginTotpEnrollment(
    ctx: AuthContext | NonHumanPrincipal,
    req: ProtectedRequest,
    meta: RequestMeta,
  ) {
    return this.#flow('mfa_enroll', () =>
      this.#protected(ctx, 'account.mfa_enroll', undefined, req, meta, async (tx, c) => {
        if (await this.#hasActiveTotp(tx, c.account.id)) throw new IdentityError('conflict');
        // Read references before clearing them: RETURNING would yield the new (NULL) values.
        const pending = await tx.db
          .selectFrom('identity.mfa_factor')
          .select(['id', 'secret_ref'])
          .where('account_id', '=', c.account.id)
          .where('factor_type', '=', 'totp')
          .where('state', '=', 'pending')
          .forUpdate()
          .execute();
        for (const p of pending) {
          await tx.db
            .updateTable('identity.mfa_factor')
            .set({
              state: 'revoked',
              revoked_at: new Date(),
              secret_ref: null,
              updated_at: new Date(),
            })
            .where('id', '=', p.id)
            .execute();
          if (p.secret_ref) await this.#d.vault.destroy(p.secret_ref, { scope: tx });
        }
        const secret = newTotpSecret();
        const ref = await this.#d.vault.put('totp_seed', secret, { scope: tx });
        const publicId = newPublicId('mfa');
        await tx.db
          .insertInto('identity.mfa_factor')
          .values({
            id: newUuidV7(),
            public_id: publicId,
            account_id: c.account.id,
            factor_type: 'totp',
            label: 'Authenticator app',
            secret_ref: ref,
          })
          .execute();
        return {
          status: 201,
          refs: [{ id: publicId, type: 'mfa_factor' }],
          result: {
            factorPublicId: publicId,
            secret,
            otpauthUri: otpauthUri(secret, c.account.email, this.#d.appName),
          },
        };
      }),
    );
  }

  /**
   * Confirms enrollment with a current code, activates the factor, issues recovery codes (shown
   * once), and rotates the session to multi-factor assurance.
   */
  async confirmTotpEnrollment(
    ctx: AuthContext,
    input: { factor: unknown; code: unknown },
    req: ProtectedRequest,
    meta: RequestMeta,
  ) {
    return this.#flow('mfa_confirm', () =>
      this.#protected(ctx, undefined, undefined, req, meta, async (tx, c) => {
        await this.#limit('mfa.account', c.account.id);
        const factor =
          typeof input.factor === 'string'
            ? await tx.db
                .selectFrom('identity.mfa_factor')
                .select(['id', 'secret_ref', 'public_id'])
                .where('public_id', '=', input.factor)
                .where('account_id', '=', c.account.id)
                .where('state', '=', 'pending')
                .forUpdate()
                .executeTakeFirst()
            : undefined;
        if (!factor?.secret_ref) throw new IdentityError('not_found');
        const secret = await this.#d.vault.get(factor.secret_ref, { scope: tx });
        const step = secret ? verifyTotp(secret, input.code) : undefined;
        if (step === undefined) {
          throw new IdentityError('validation_failed', {
            issues: [
              issue(
                '/code',
                'invalid_code',
                "That code didn't work. Check the time on your device and try again.",
              ),
            ],
          });
        }
        await tx.db
          .updateTable('identity.mfa_factor')
          .set({
            state: 'active',
            verified_at: new Date(),
            last_used_step: step,
            last_used_at: new Date(),
            updated_at: new Date(),
            version: sql`version + 1`,
          })
          .where('id', '=', factor.id)
          .execute();
        const codes = await this.#replaceRecoveryCodes(tx, c.account.id);
        const issued = await this.#issueSession(
          tx,
          c.account.id,
          [...new Set<AuthMethod>([...c.session.authMethods, 'totp'])],
          meta,
          { sessionId: c.session.id },
        );
        await this.#enqueueMail(tx, meta, {
          template: 'mfa_enabled',
          recipient: c.account.email,
          locale: c.account.locale,
          accountId: c.account.id,
        });
        await this.#event(tx, meta, {
          category: 'secret',
          action: 'mfa.enabled',
          outcome: 'success',
          actor: { type: 'human', id: c.account.id },
          subject: { type: 'account', id: c.account.id },
        });
        return {
          status: 200,
          refs: [{ id: factor.public_id, type: 'mfa_factor' }],
          result: { recoveryCodes: codes, issued },
        };
      }),
    );
  }

  async #replaceRecoveryCodes(tx: PlatformTransaction, accountId: string): Promise<string[]> {
    const prev = await tx.db
      .updateTable('identity.recovery_code')
      .set({ revoked_at: new Date() })
      .where('account_id', '=', accountId)
      .where('used_at', 'is', null)
      .where('revoked_at', 'is', null)
      .returning('generation')
      .execute();
    const latest = await tx.db
      .selectFrom('identity.recovery_code')
      .select((eb) => eb.fn.max('generation').as('g'))
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    const generation = Math.max(Number(latest?.g ?? 0), ...prev.map((p) => p.generation)) + 1;
    const codes = newRecoveryCodes();
    await tx.db
      .insertInto('identity.recovery_code')
      .values(
        codes.map((code) => ({
          id: newUuidV7(),
          account_id: accountId,
          generation,
          code_hash: hashRecoveryCode(normalizeRecoveryCode(code)!),
        })),
      )
      .execute();
    return codes;
  }

  /** Step-up protected (account.mfa_disable). The password remains a usable sign-in method. */
  async disableTotp(
    ctx: AuthContext | NonHumanPrincipal,
    req: ProtectedRequest,
    meta: RequestMeta,
  ) {
    return this.#flow('mfa_disable', () =>
      this.#protected(
        ctx,
        'account.mfa_disable',
        { type: 'account', id: ctx.principal === 'account' ? ctx.account.id : '' },
        req,
        meta,
        async (tx, c) => {
          const hasPassword = await tx.db
            .selectFrom('identity.credential')
            .select('account_id')
            .where('account_id', '=', c.account.id)
            .executeTakeFirst();
          const linked = await tx.db
            .selectFrom('identity.oauth_identity')
            .select('id')
            .where('account_id', '=', c.account.id)
            .where('state', '=', 'linked')
            .executeTakeFirst();
          if (!hasPassword && !linked) throw new IdentityError('conflict');
          const factors = await tx.db
            .selectFrom('identity.mfa_factor')
            .select(['id', 'secret_ref', 'public_id'])
            .where('account_id', '=', c.account.id)
            .where('factor_type', '=', 'totp')
            .where('state', 'in', ['pending', 'active'])
            .forUpdate()
            .execute();
          if (!factors.length) throw new IdentityError('not_found');
          for (const f of factors) {
            await tx.db
              .updateTable('identity.mfa_factor')
              .set({
                state: 'revoked',
                revoked_at: new Date(),
                secret_ref: null,
                updated_at: new Date(),
                version: sql`version + 1`,
              })
              .where('id', '=', f.id)
              .execute();
            if (f.secret_ref) await this.#d.vault.destroy(f.secret_ref, { scope: tx });
          }
          await tx.db
            .updateTable('identity.recovery_code')
            .set({ revoked_at: new Date() })
            .where('account_id', '=', c.account.id)
            .where('used_at', 'is', null)
            .where('revoked_at', 'is', null)
            .execute();
          await this.#enqueueMail(tx, meta, {
            template: 'mfa_disabled',
            recipient: c.account.email,
            locale: c.account.locale,
            accountId: c.account.id,
          });
          await this.#event(tx, meta, {
            category: 'secret',
            action: 'mfa.disabled',
            outcome: 'success',
            actor: { type: 'human', id: c.account.id },
            subject: { type: 'account', id: c.account.id },
          });
          return {
            status: 200,
            refs: factors.map((f) => ({ id: f.public_id, type: 'mfa_factor' })),
            result: { disabled: true },
          };
        },
      ),
    );
  }

  /** Step-up protected. The previous set stops working in the same transaction. */
  async regenerateRecoveryCodes(
    ctx: AuthContext | NonHumanPrincipal,
    req: ProtectedRequest,
    meta: RequestMeta,
  ) {
    return this.#flow('recovery_codes', () =>
      this.#protected(
        ctx,
        'account.recovery_codes_regenerate',
        { type: 'account', id: ctx.principal === 'account' ? ctx.account.id : '' },
        req,
        meta,
        async (tx, c) => {
          if (!(await this.#hasActiveTotp(tx, c.account.id))) throw new IdentityError('conflict');
          const codes = await this.#replaceRecoveryCodes(tx, c.account.id);
          await this.#enqueueMail(tx, meta, {
            template: 'recovery_codes_regenerated',
            recipient: c.account.email,
            locale: c.account.locale,
            accountId: c.account.id,
          });
          await this.#event(tx, meta, {
            category: 'secret',
            action: 'recovery_codes.regenerated',
            outcome: 'success',
            actor: { type: 'human', id: c.account.id },
            subject: { type: 'account', id: c.account.id },
          });
          return {
            status: 200,
            refs: [{ id: c.account.publicId, type: 'account' }],
            result: { recoveryCodes: codes },
          };
        },
      ),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Step-up (0D §11.2)
  // -------------------------------------------------------------------------------------------

  async #methodsFor(tx: PlatformTransaction, accountId: string): Promise<StepUpMethod[]> {
    const methods: StepUpMethod[] = [];
    const cred = await tx.db
      .selectFrom('identity.credential')
      .select('account_id')
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    if (cred) methods.push('password');
    if (await this.#hasActiveTotp(tx, accountId)) methods.push('totp', 'recovery_code');
    return methods;
  }

  #targetHash(target: { type: string; id: string } | undefined): Buffer | null {
    return target ? sha256(`${target.type}:${target.id}`) : null;
  }

  /**
   * Issues a pending challenge bound to (session, account, membership/workspace, action, target,
   * idempotency key). Tenant actions require a concrete membership and workspace; account-level
   * actions must be registered. Non-human principals cannot step up.
   */
  async createStepUpChallenge(
    ctx: AuthContext | NonHumanPrincipal,
    request: {
      actionKey: string;
      target?: { type: string; id: string } | undefined;
      idempotencyKey?: string;
      membershipId?: string;
      workspaceId?: string;
    },
    meta: RequestMeta,
  ): Promise<StepUpChallengeView> {
    return this.#flow('step_up_challenge', async () => {
      if (ctx.principal !== 'account') throw new IdentityError('step_up_unavailable');
      const tenantAction = ACTIONS.find((a) => a.key === request.actionKey);
      const accountAction = (ACCOUNT_STEP_UP_ACTIONS as readonly string[]).includes(
        request.actionKey,
      );
      if (tenantAction) {
        if (!tenantAction.stepUp)
          throw new IdentityError('validation_failed', {
            issues: [
              issue('/action_key', 'step_up_not_applicable', 'This action does not use step-up.'),
            ],
          });
        if (!request.membershipId || !request.workspaceId) {
          throw new IdentityError('validation_failed', {
            issues: [
              issue(
                '/action_key',
                'tenant_binding_required',
                'This action needs a workspace membership.',
              ),
            ],
          });
        }
      } else if (!accountAction) {
        throw new IdentityError('validation_failed', {
          issues: [issue('/action_key', 'unsupported_field', 'Unknown action.')],
        });
      }
      await this.#limit('step_up.account', ctx.account.id);
      return this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
        const methods = await this.#methodsFor(tx, ctx.account.id);
        if (!methods.length) throw new IdentityError('step_up_unavailable');
        const publicId = newPublicId('stp');
        const expiresAt = new Date(Date.now() + this.#d.config.stepUpChallengeMs);
        await tx.db
          .insertInto('identity.step_up_challenge')
          .values({
            id: newUuidV7(),
            public_id: publicId,
            account_id: ctx.account.id,
            session_id: ctx.session.id,
            membership_id: request.membershipId ?? null,
            workspace_id: request.workspaceId ?? null,
            action_key: request.actionKey,
            target_type: request.target?.type ?? null,
            target_hash: this.#targetHash(request.target),
            methods,
            challenge_nonce_hash: sha256(randomBytes(32)),
            idempotency_key_hash: request.idempotencyKey ? sha256(request.idempotencyKey) : null,
            expires_at: expiresAt,
          })
          .execute();
        await this.#event(tx, meta, {
          category: 'step_up',
          action: 'step_up.issued',
          outcome: 'success',
          actor: { type: 'human', id: ctx.account.id },
          subject: { type: 'session', id: ctx.session.id },
        });
        return challengeView({
          public_id: publicId,
          action_key: request.actionKey,
          methods,
          expires_at: expiresAt,
          state: 'pending',
        });
      });
    });
  }

  /**
   * Verifies a proof for a pending challenge. Failures are counted (and committed); at the limit
   * the challenge is locked. Success returns a single-use token valid for STEP_UP_WINDOW. A
   * step-up never extends the session.
   */
  async verifyStepUp(
    ctx: AuthContext | NonHumanPrincipal,
    challengePublicId: unknown,
    input: { method: unknown; proof: unknown },
    meta: RequestMeta,
  ): Promise<{ token: string; expiresAt: Date; challenge: StepUpChallengeView }> {
    return this.#flow('step_up_verify', async () => {
      if (ctx.principal !== 'account') throw new IdentityError('step_up_unavailable');
      await this.#limit('step_up.account', ctx.account.id);
      const result = await this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
        const ch =
          typeof challengePublicId === 'string'
            ? await tx.db
                .selectFrom('identity.step_up_challenge')
                .selectAll()
                .where('public_id', '=', challengePublicId)
                .where('account_id', '=', ctx.account.id)
                .where('session_id', '=', ctx.session.id)
                .forUpdate()
                .executeTakeFirst()
            : undefined;
        if (!ch) return { kind: 'not_found' as const };
        if (ch.state !== 'pending') return { kind: 'not_pending' as const };
        if (ch.expires_at.getTime() <= Date.now()) {
          await tx.db
            .updateTable('identity.step_up_challenge')
            .set({ state: 'expired', version: sql`version + 1` })
            .where('id', '=', ch.id)
            .execute();
          return { kind: 'expired' as const };
        }
        if (ch.failed_attempts >= this.#d.config.stepUpMaxAttempts)
          return { kind: 'locked' as const, until: ch.expires_at };
        const method = input.method as StepUpMethod;
        const allowed = (ch.methods as string[]).includes(method) && method !== 'webauthn';
        const ok =
          allowed &&
          (await this.#verifySecondFactor(
            tx,
            ctx.account.id,
            method as 'password' | 'totp' | 'recovery_code',
            input.proof,
          ));
        if (!ok) {
          const attempts = ch.failed_attempts + 1;
          await tx.db
            .updateTable('identity.step_up_challenge')
            .set({ failed_attempts: attempts, version: sql`version + 1` })
            .where('id', '=', ch.id)
            .execute();
          await this.#event(tx, meta, {
            category: 'step_up',
            action: 'step_up.failed',
            outcome: 'failure',
            actor: { type: 'human', id: ctx.account.id },
            subject: { type: 'session', id: ctx.session.id },
          });
          return attempts >= this.#d.config.stepUpMaxAttempts
            ? { kind: 'locked' as const, until: ch.expires_at }
            : { kind: 'invalid' as const };
        }
        const token = newOpaqueToken();
        const tokenExpiresAt = new Date(Date.now() + this.#d.config.stepUpWindowMs);
        await tx.db
          .updateTable('identity.step_up_challenge')
          .set({
            state: 'verified',
            verified_at: new Date(),
            verified_method: method,
            token_hash: token.hash,
            token_expires_at: tokenExpiresAt,
            version: sql`version + 1`,
          })
          .where('id', '=', ch.id)
          .execute();
        await this.#event(tx, meta, {
          category: 'step_up',
          action: 'step_up.verified',
          outcome: 'success',
          actor: { type: 'human', id: ctx.account.id },
          subject: { type: 'session', id: ctx.session.id },
        });
        return {
          kind: 'ok' as const,
          token: token.raw,
          tokenExpiresAt,
          challenge: challengeView({ ...ch, state: 'verified' }),
        };
      });
      switch (result.kind) {
        case 'ok':
          return {
            token: result.token,
            expiresAt: result.tokenExpiresAt,
            challenge: result.challenge,
          };
        case 'not_found':
          throw new IdentityError('not_found');
        case 'not_pending':
          throw new IdentityError('conflict');
        case 'expired':
          throw new IdentityError('validation_failed', {
            issues: [
              issue(
                '/challenge',
                'challenge_expired',
                'This confirmation expired. Try the action again.',
              ),
            ],
          });
        case 'locked':
          throw new IdentityError('rate_limited', {
            retryAfterSeconds: Math.max(1, Math.ceil((result.until.getTime() - Date.now()) / 1000)),
          });
        case 'invalid':
          throw new IdentityError('validation_failed', {
            issues: [issue('/proof', 'invalid_proof', "That didn't work. Check it and try again.")],
          });
      }
    });
  }

  async cancelStepUp(
    ctx: AuthContext,
    challengePublicId: unknown,
    meta: RequestMeta,
  ): Promise<StepUpChallengeView> {
    return this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
      const ch =
        typeof challengePublicId === 'string'
          ? await tx.db
              .updateTable('identity.step_up_challenge')
              .set({ state: 'cancelled', cancelled_at: new Date(), version: sql`version + 1` })
              .where('public_id', '=', challengePublicId)
              .where('account_id', '=', ctx.account.id)
              .where('session_id', '=', ctx.session.id)
              .where('state', 'in', ['pending', 'verified'])
              .returningAll()
              .executeTakeFirst()
          : undefined;
      if (!ch) throw new IdentityError('not_found');
      await this.#event(tx, meta, {
        category: 'step_up',
        action: 'step_up.cancelled',
        outcome: 'success',
        actor: { type: 'human', id: ctx.account.id },
        subject: { type: 'session', id: ctx.session.id },
      });
      return challengeView(ch);
    });
  }

  /** Consumes a step-up token in the action's transaction: single use, fully bound. */
  async #consumeStepUp(
    tx: PlatformTransaction,
    ctx: AuthContext,
    action: string,
    target: { type: string; id: string } | undefined,
    req: ProtectedRequest,
    meta: RequestMeta,
  ): Promise<boolean> {
    if (!isWellFormedToken(req.stepUpToken)) return false;
    const targetHash = this.#targetHash(target);
    const consumed = await tx.db
      .updateTable('identity.step_up_challenge')
      .set({ state: 'consumed', consumed_at: new Date(), version: sql`version + 1` })
      .where('token_hash', '=', hashToken(req.stepUpToken))
      .where('state', '=', 'verified')
      .where('token_expires_at', '>', new Date())
      .where('account_id', '=', ctx.account.id)
      .where('session_id', '=', ctx.session.id)
      .where('action_key', '=', action)
      .where((eb) =>
        targetHash ? eb('target_hash', '=', targetHash) : eb('target_hash', 'is', null),
      )
      .where((eb) =>
        eb.or([
          eb('idempotency_key_hash', 'is', null),
          eb('idempotency_key_hash', '=', sha256(req.idempotencyKey)),
        ]),
      )
      .returning('id')
      .executeTakeFirst();
    if (consumed) {
      await this.#event(tx, meta, {
        category: 'step_up',
        action: 'step_up.consumed',
        outcome: 'success',
        actor: { type: 'human', id: ctx.account.id },
        subject: { type: 'session', id: ctx.session.id },
      });
    }
    return Boolean(consumed);
  }

  // -------------------------------------------------------------------------------------------
  // OAuth (provider-neutral; local/test provider only)
  // -------------------------------------------------------------------------------------------

  oauthProviders(): Array<{ id: string; displayName: string }> {
    return [...this.#d.oauth.values()].map((p) => ({ id: p.id, displayName: p.displayName }));
  }

  #redirectUri(provider: string): string {
    return `${this.#d.config.publicOrigin}/v1/auth/oauth/${provider}/callback`;
  }

  /** Creates state, nonce, and a PKCE verifier; returns the provider authorization URL. */
  async startOAuth(
    providerId: unknown,
    intent: 'sign_in' | 'link',
    ctx: AuthContext | undefined,
    returnPath: unknown,
    meta: RequestMeta,
  ): Promise<string> {
    return this.#flow('oauth_start', async () => {
      const provider = typeof providerId === 'string' ? this.#d.oauth.get(providerId) : undefined;
      if (!provider) throw new IdentityError('not_found');
      if (intent === 'link' && !ctx) throw new IdentityError('unauthenticated');
      await this.#limit('oauth.source', this.#source(meta));
      const state = newOpaqueToken();
      const nonce = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      await this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
        const expiresAt = new Date(Date.now() + this.#d.config.oauthStateMs);
        const sealed = await this.#d.vault.put('oauth_flow', JSON.stringify({ nonce, verifier }), {
          scope: tx,
          expiresAt,
        });
        await tx.db
          .insertInto('identity.verification_token')
          .values({
            id: newUuidV7(),
            purpose: 'oauth_state',
            account_id: intent === 'link' ? ctx!.account.id : null,
            token_hash: state.hash,
            expires_at: expiresAt,
            context: JSON.stringify({
              provider: provider.id,
              intent,
              return_path: safeReturnPath(
                returnPath,
                intent === 'link' ? '/account/security' : '/onboarding',
              ),
              session_id: ctx?.session.id ?? null,
            }),
            sealed_ref: sealed,
          })
          .execute();
      });
      return provider.authorizationUrl({
        state: state.raw,
        nonce,
        codeChallenge: pkceChallenge(verifier),
        redirectUri: this.#redirectUri(provider.id),
      });
    });
  }

  /**
   * Callback: consumes state (single use), checks provider error, exchanges the code with the PKCE
   * verifier, and verifies the nonce. Never links an account by matching email.
   */
  async completeOAuth(
    providerId: string,
    params: { state?: unknown; code?: unknown; error?: unknown },
    meta: RequestMeta,
    ctx: AuthContext | undefined,
    presentedToken?: string,
  ): Promise<
    | { kind: 'session'; issued: IssuedSession; returnPath: string }
    | { kind: 'mfa_required'; continuation: string; methods: StepUpMethod[]; returnPath: string }
    | { kind: 'linked'; returnPath: string }
    | {
        kind: 'error';
        reason:
          | 'state_invalid'
          | 'state_expired'
          | 'replay'
          | 'denied'
          | 'exchange_failed'
          | 'nonce_mismatch'
          | 'not_linked'
          | 'link_collision'
          | 'link_session_mismatch';
      }
  > {
    return this.#flow('oauth_callback', async () => {
      const provider = this.#d.oauth.get(providerId);
      if (!provider) return { kind: 'error' as const, reason: 'state_invalid' as const };
      await this.#limit('oauth.source', this.#source(meta));
      const flow = await this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
        const r = await this.#consumeToken(tx, 'oauth_state', params.state);
        if (!r.ok)
          return {
            ok: false as const,
            reason:
              r.problem === 'token_used'
                ? ('replay' as const)
                : r.problem === 'token_expired'
                  ? ('state_expired' as const)
                  : ('state_invalid' as const),
          };
        const context = r.context as {
          provider: string;
          intent: 'sign_in' | 'link';
          return_path: string;
          session_id: string | null;
        };
        if (context.provider !== provider.id || !r.sealedRef)
          return { ok: false as const, reason: 'state_invalid' as const };
        const sealed = await this.#d.vault.get(r.sealedRef, { scope: tx });
        await this.#d.vault.destroy(r.sealedRef, { scope: tx });
        if (!sealed) return { ok: false as const, reason: 'state_expired' as const };
        return {
          ok: true as const,
          context,
          accountId: r.accountId,
          secrets: JSON.parse(sealed) as { nonce: string; verifier: string },
        };
      });
      if (!flow.ok) return { kind: 'error' as const, reason: flow.reason };
      if (typeof params.error === 'string' || typeof params.code !== 'string')
        return { kind: 'error' as const, reason: 'denied' as const };
      let claims;
      try {
        claims = await provider.exchangeCode({
          code: params.code,
          codeVerifier: flow.secrets.verifier,
          redirectUri: this.#redirectUri(provider.id),
        });
      } catch (err) {
        if (err instanceof OAuthProviderError)
          return { kind: 'error' as const, reason: 'exchange_failed' as const };
        throw err;
      }
      if (claims.nonce !== flow.secrets.nonce)
        return { kind: 'error' as const, reason: 'nonce_mismatch' as const };
      const returnPath = flow.context.return_path;

      return this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
        const existing = await tx.db
          .selectFrom('identity.oauth_identity')
          .selectAll()
          .where('provider', '=', provider.id)
          .where('subject', '=', claims.subject)
          .forUpdate()
          .executeTakeFirst();
        if (flow.context.intent === 'link') {
          if (
            !ctx ||
            ctx.account.id !== flow.accountId ||
            ctx.session.id !== flow.context.session_id
          )
            return { kind: 'error' as const, reason: 'link_session_mismatch' as const };
          if (existing && existing.state === 'linked' && existing.account_id !== ctx.account.id) {
            await this.#event(tx, meta, {
              category: 'authentication',
              action: 'oauth.link_collision',
              outcome: 'denied',
              actor: { type: 'human', id: ctx.account.id },
              subject: { type: 'account', id: ctx.account.id },
            });
            return { kind: 'error' as const, reason: 'link_collision' as const };
          }
          if (existing) {
            await tx.db
              .updateTable('identity.oauth_identity')
              .set({
                account_id: ctx.account.id,
                state: 'linked',
                linked_at: new Date(),
                unlinked_at: null,
                provider_email: claims.email ?? null,
                provider_display_name: claims.displayName ?? null,
                version: sql`version + 1`,
              })
              .where('id', '=', existing.id)
              .execute();
          } else {
            await tx.db
              .insertInto('identity.oauth_identity')
              .values({
                id: newUuidV7(),
                public_id: newPublicId('oid'),
                account_id: ctx.account.id,
                provider: provider.id,
                subject: claims.subject,
                provider_email: claims.email ?? null,
                provider_display_name: claims.displayName ?? null,
              })
              .execute();
          }
          await this.#enqueueMail(tx, meta, {
            template: 'oauth_linked',
            recipient: ctx.account.email,
            locale: ctx.account.locale,
            accountId: ctx.account.id,
          });
          await this.#event(tx, meta, {
            category: 'authentication',
            action: 'oauth.linked',
            outcome: 'success',
            actor: { type: 'human', id: ctx.account.id },
            subject: { type: 'account', id: ctx.account.id },
          });
          return { kind: 'linked' as const, returnPath };
        }
        if (!existing || existing.state !== 'linked') {
          await this.#event(tx, meta, {
            category: 'authentication',
            action: 'sign_in.oauth',
            outcome: 'failure',
            actor: { type: 'human' },
          });
          return { kind: 'error' as const, reason: 'not_linked' as const };
        }
        await tx.db
          .updateTable('identity.oauth_identity')
          .set({ last_sign_in_at: new Date() })
          .where('id', '=', existing.id)
          .execute();
        if (await this.#hasActiveTotp(tx, existing.account_id)) {
          const t = await this.#issueToken(
            tx,
            existing.account_id,
            'sign_in_continuation',
            this.#d.config.signInContinuationMs,
            { first_factor: 'oauth' },
          );
          return {
            kind: 'mfa_required' as const,
            continuation: t.raw,
            methods: ['totp', 'recovery_code'] as StepUpMethod[],
            returnPath,
          };
        }
        const issued = await this.#issueSession(tx, existing.account_id, ['oauth'], meta, {
          rawToken: presentedToken,
        });
        await this.#event(tx, meta, {
          category: 'session',
          action: 'session.created',
          outcome: 'success',
          actor: { type: 'human', id: existing.account_id },
          subject: { type: 'session', id: issued.session.id },
        });
        return { kind: 'session' as const, issued, returnPath };
      });
    });
  }

  async listOAuthIdentities(
    ctx: AuthContext,
  ): Promise<
    Array<{ publicId: string; provider: string; providerEmail: string | null; linkedAt: Date }>
  > {
    const rows = await this.#d.db.withPlatform({ module: 'identity', readOnly: true }, (tx) =>
      tx.db
        .selectFrom('identity.oauth_identity')
        .select(['public_id', 'provider', 'provider_email', 'linked_at'])
        .where('account_id', '=', ctx.account.id)
        .where('state', '=', 'linked')
        .orderBy('linked_at', 'desc')
        .execute(),
    );
    return rows.map((r) => ({
      publicId: r.public_id,
      provider: r.provider,
      providerEmail: r.provider_email,
      linkedAt: r.linked_at,
    }));
  }

  /** Refuses to remove the last usable sign-in method. */
  async unlinkOAuthIdentity(ctx: AuthContext, publicId: unknown, meta: RequestMeta): Promise<void> {
    return this.#flow('oauth_unlink', () =>
      this.#d.db.withPlatform({ module: 'identity' }, async (tx) => {
        const target =
          typeof publicId === 'string'
            ? await tx.db
                .selectFrom('identity.oauth_identity')
                .select(['id', 'state'])
                .where('public_id', '=', publicId)
                .where('account_id', '=', ctx.account.id)
                .forUpdate()
                .executeTakeFirst()
            : undefined;
        if (!target) throw new IdentityError('not_found');
        if (target.state === 'unlinked') return;
        const password = await tx.db
          .selectFrom('identity.credential')
          .select('account_id')
          .where('account_id', '=', ctx.account.id)
          .executeTakeFirst();
        const others = await tx.db
          .selectFrom('identity.oauth_identity')
          .select('id')
          .where('account_id', '=', ctx.account.id)
          .where('state', '=', 'linked')
          .where('id', '!=', target.id)
          .executeTakeFirst();
        if (!password && !others) {
          throw new IdentityError('validation_failed', {
            issues: [
              issue(
                '/identity',
                'last_sign_in_method',
                'Add a password or another sign-in method before removing this one.',
              ),
            ],
          });
        }
        await tx.db
          .updateTable('identity.oauth_identity')
          .set({ state: 'unlinked', unlinked_at: new Date(), version: sql`version + 1` })
          .where('id', '=', target.id)
          .execute();
        await this.#enqueueMail(tx, meta, {
          template: 'oauth_unlinked',
          recipient: ctx.account.email,
          locale: ctx.account.locale,
          accountId: ctx.account.id,
        });
        await this.#event(tx, meta, {
          category: 'authentication',
          action: 'oauth.unlinked',
          outcome: 'success',
          actor: { type: 'human', id: ctx.account.id },
          subject: { type: 'account', id: ctx.account.id },
        });
      }),
    );
  }

  /** CSRF synchronizer token derived from the session (rotates with the session). */
  csrfToken(sessionId: string): string {
    return keyedHash(this.#d.signingKey, 'csrf', sessionId).toString('base64url');
  }
}

class StepUpNeeded extends Error {
  constructor() {
    super('step-up needed');
    this.name = 'StepUpNeeded';
  }
}

function passwordIssue(problem: 'too_short' | 'too_long' | 'invalid') {
  const messages = {
    too_short: 'Use at least 12 characters.',
    too_long: 'Use at most 256 characters.',
    invalid: 'Enter a password without control characters.',
  };
  return issue('/password', problem === 'invalid' ? 'invalid_value' : problem, messages[problem]);
}

function toSessionView(r: {
  id: string;
  public_id: string;
  assurance: 'single_factor' | 'multi_factor';
  auth_methods: AuthMethod[];
  created_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  mfa_verified_at: Date | null;
}): SessionView {
  return {
    id: r.id,
    publicId: r.public_id,
    assurance: r.assurance,
    authMethods: r.auth_methods,
    createdAt: r.created_at,
    idleExpiresAt: r.idle_expires_at,
    absoluteExpiresAt: r.absolute_expires_at,
    mfaVerifiedAt: r.mfa_verified_at,
  };
}

function toAccountView(a: {
  id: string;
  public_id: string;
  primary_email: string;
  display_name: string;
  locale: string;
  timezone: string;
  email_verified_at: Date | null;
}): AccountView {
  return {
    id: a.id,
    publicId: a.public_id,
    email: a.primary_email,
    displayName: a.display_name,
    locale: a.locale,
    timezone: a.timezone,
    emailVerified: a.email_verified_at !== null,
  };
}

function challengeView(c: {
  public_id: string;
  action_key: string;
  methods: StepUpMethod[];
  expires_at: Date;
  state: StepUpChallengeView['state'];
}): StepUpChallengeView {
  return {
    id: c.public_id,
    type: 'step_up_challenge',
    action_key: c.action_key,
    methods: c.methods,
    expires_at: c.expires_at.toISOString(),
    state: c.state,
    verify: `/v1/auth/step-up/${c.public_id}:verify`,
    cancel: `/v1/auth/step-up/${c.public_id}:cancel`,
  };
}
