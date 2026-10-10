import { sql, type PlatformDatabase } from '@pm/db';
import { keyedHash } from './primitives.ts';

/**
 * Named rate-limit policies (0D parameter RATE_LIMIT_POLICIES). Values are operational defaults,
 * not published promises, and can be overridden by configuration.
 */
export const DEFAULT_POLICIES = {
  'register.source': { limit: 20, windowMs: 60 * 60_000 },
  'register.email': { limit: 5, windowMs: 60 * 60_000 },
  'sign_in.source': { limit: 60, windowMs: 15 * 60_000 },
  'sign_in.email': { limit: 10, windowMs: 15 * 60_000 },
  'resend.source': { limit: 20, windowMs: 60 * 60_000 },
  'resend.email': { limit: 5, windowMs: 60 * 60_000 },
  'recovery.source': { limit: 20, windowMs: 60 * 60_000 },
  'recovery.email': { limit: 5, windowMs: 60 * 60_000 },
  'token.source': { limit: 60, windowMs: 15 * 60_000 },
  'mfa.account': { limit: 10, windowMs: 15 * 60_000 },
  'step_up.account': { limit: 20, windowMs: 15 * 60_000 },
  'oauth.source': { limit: 60, windowMs: 15 * 60_000 },
  // Account command (0C AZ-18): new workspaces per account; replays of the same key are free.
  'workspace.create': { limit: 10, windowMs: 60 * 60_000 },
  // Account command (0C AZ-19): invitation acceptance attempts per account.
  'invitation.accept': { limit: 30, windowMs: 60 * 60_000 },
  // Invitations sent per inviting membership (resends included).
  'invitation.send': { limit: 100, windowMs: 60 * 60_000 },
  // 2E: capture commands per membership (CAPTURE_RATE_PER_MINUTE) and intake submissions per
  // membership and form (INTAKE_SUBMISSIONS_PER_HOUR); the work settings override both.
  'capture.member': { limit: 60, windowMs: 60_000 },
  'intake.submit': { limit: 20, windowMs: 60 * 60_000 },
  // 6B public API (per principal). Quotas are operational, not a published promise.
  'api.read': { limit: 600, windowMs: 60_000 },
  'api.write': { limit: 120, windowMs: 60_000 },
  'api.export': { limit: 20, windowMs: 60_000 },
  'webhook.inbound': { limit: 120, windowMs: 60_000 },
} as const satisfies Record<string, { limit: number; windowMs: number }>;
export type RateLimitPolicy = keyof typeof DEFAULT_POLICIES;

/** Escalating, bounded block: base × 2^strikes, capped (never a permanent lockout). */
export const BLOCK_BASE_MS = 30_000;
export const BLOCK_MAX_MS = 15 * 60_000;

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(policy: RateLimitPolicy, dimension: string): Promise<RateLimitDecision>;
}

/**
 * PostgreSQL-backed limiter (adapter; an edge/Redis-free store). Keys are HMAC(signing key,
 * policy, dimension), so the table never holds plaintext emails, IP prefixes, or account IDs.
 */
export class PostgresRateLimiter implements RateLimiter {
  readonly #db: PlatformDatabase;
  readonly #key: Buffer;
  readonly #policies: Record<string, { limit: number; windowMs: number }>;

  constructor(
    db: PlatformDatabase,
    signingKey: Buffer,
    overrides: Readonly<Record<string, { limit: number; windowMs: number }>> = {},
  ) {
    this.#db = db;
    this.#key = signingKey;
    this.#policies = { ...DEFAULT_POLICIES, ...overrides };
  }

  async consume(policy: RateLimitPolicy, dimension: string): Promise<RateLimitDecision> {
    const p = this.#policies[policy]!;
    const keyHash = keyedHash(this.#key, `rate-limit:${policy}`, dimension);
    const row = await this.#db.withPlatform({ module: 'identity' }, async (tx) => {
      const res = await sql<{ hits: number; strikes: number; blocked_until: Date | null }>`
        INSERT INTO ops.rate_limit_bucket AS b (policy, key_hash, window_start, hits, strikes, updated_at)
        VALUES (${policy}, ${keyHash}, now(), 1, 0, now())
        ON CONFLICT (policy, key_hash) DO UPDATE SET
          window_start = CASE WHEN b.window_start < now() - make_interval(secs => ${p.windowMs / 1000}) THEN now() ELSE b.window_start END,
          hits = CASE WHEN b.window_start < now() - make_interval(secs => ${p.windowMs / 1000}) THEN 1 ELSE b.hits + 1 END,
          strikes = CASE WHEN b.blocked_until IS NOT NULL AND b.blocked_until < now() - make_interval(secs => ${p.windowMs / 1000}) THEN 0 ELSE b.strikes END,
          updated_at = now()
        RETURNING hits, strikes, blocked_until`.execute(tx.db);
      const r = res.rows[0]!;
      if (r.blocked_until && r.blocked_until.getTime() > Date.now()) return r;
      if (r.hits > p.limit) {
        const blockMs = Math.min(BLOCK_MAX_MS, BLOCK_BASE_MS * 2 ** r.strikes);
        const blocked = await sql<{ blocked_until: Date }>`
          UPDATE ops.rate_limit_bucket SET blocked_until = now() + make_interval(secs => ${blockMs / 1000}), strikes = strikes + 1
          WHERE policy = ${policy} AND key_hash = ${keyHash} RETURNING blocked_until`.execute(
          tx.db,
        );
        return { ...r, blocked_until: blocked.rows[0]!.blocked_until };
      }
      return { ...r, blocked_until: null };
    });
    if (row.blocked_until && row.blocked_until.getTime() > Date.now()) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((row.blocked_until.getTime() - Date.now()) / 1000),
        ),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/** Test/development limiter that never blocks. */
export class NoopRateLimiter implements RateLimiter {
  consume(): Promise<RateLimitDecision> {
    return Promise.resolve({ allowed: true, retryAfterSeconds: 0 });
  }
}
