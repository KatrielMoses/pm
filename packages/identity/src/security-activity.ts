import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { sql, type PlatformDatabase } from '@pm/db';
import type { AuthContext } from './types.ts';

/**
 * Own-account security activity (Phase 1F): the signed-in account's account-level security events
 * from `audit.security_event`. Ownership is the only access rule: events where the account is the
 * actor or the subject, or whose subject is one of the account's own sessions. Tenant events
 * (workspace_id set) never appear. Output is display-safe: no internal UUIDs, raw IPs, tokens,
 * emails, or user-agent strings; the network context is shown masked.
 */

export interface SecurityActivityItem {
  occurredAt: string;
  category: string;
  action: string;
  outcome: 'success' | 'failure' | 'denied';
  /** True when the event concerns the session making this request. */
  thisSession: boolean;
  /** Device label of the account's own session, when the event concerns one. */
  device: string | null;
  network: string | null;
  client: string | null;
}

export interface SecurityActivityPage {
  items: SecurityActivityItem[];
  nextCursor: string | null;
}

/** "203.0.113.0/24" → "203.0.113.*"; "2001:db8:1::/48" → "2001:db8:1:*". */
export function maskNetwork(prefix: string | null): string | null {
  if (!prefix) return null;
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.0\/24$/.exec(prefix);
  if (v4) return `${v4[1]}.*`;
  const v6 = /^([0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,2})::\/48$/.exec(prefix);
  if (v6) return `${v6[1]}:*`;
  return null;
}

function cursorKey(signingKey: Buffer): Buffer {
  return createHmac('sha256', signingKey).update('cursor:security-activity').digest();
}

/** Opaque, authenticated keyset cursor: the position never leaks event ids or times. */
export function sealCursor(
  signingKey: Buffer,
  accountId: string,
  pos: { t: string; i: string },
): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', cursorKey(signingKey), iv);
  c.setAAD(Buffer.from(accountId));
  const body = Buffer.concat([c.update(JSON.stringify(pos), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

export function openCursor(
  signingKey: Buffer,
  accountId: string,
  cursor: string,
): { t: string; i: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url');
    if (raw.length < 29) return null;
    const d = createDecipheriv('aes-256-gcm', cursorKey(signingKey), raw.subarray(0, 12));
    d.setAAD(Buffer.from(accountId));
    d.setAuthTag(raw.subarray(12, 28));
    const pos = JSON.parse(
      Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'),
    ) as {
      t: unknown;
      i: unknown;
    };
    if (typeof pos.t !== 'string' || typeof pos.i !== 'string') return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(pos.t)) return null;
    if (!/^[0-9a-f-]{36}$/.test(pos.i)) return null;
    return { t: pos.t, i: pos.i };
  } catch {
    return null;
  }
}

export class InvalidCursorError extends Error {
  constructor() {
    super('invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

export async function listOwnSecurityActivity(
  db: PlatformDatabase,
  signingKey: Buffer,
  ctx: AuthContext,
  options: { limit?: number; cursor?: string | undefined } = {},
): Promise<SecurityActivityPage> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const pos = options.cursor ? openCursor(signingKey, ctx.account.id, options.cursor) : null;
  if (options.cursor && !pos) throw new InvalidCursorError();
  const rows = await db.withPlatform({ module: 'identity', readOnly: true }, async (tx) => {
    const r = await sql<{
      id: string;
      t: string;
      category: string;
      action: string;
      outcome: 'success' | 'failure' | 'denied';
      subject_type: string | null;
      subject_id: string | null;
      network_prefix: string | null;
      user_agent_family: string | null;
      device_label: string | null;
    }>`
      SELECT e.id,
             to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t,
             e.category, e.action, e.outcome, e.subject_type, e.subject_id,
             e.network_prefix, e.user_agent_family, s.device_label
      FROM audit.security_event e
      LEFT JOIN identity.session s
        ON e.subject_type = 'session' AND s.id = e.subject_id AND s.account_id = ${ctx.account.id}
      WHERE e.workspace_id IS NULL
        AND (e.actor_id = ${ctx.account.id}
             OR (e.subject_type = 'account' AND e.subject_id = ${ctx.account.id})
             OR (e.subject_type = 'session' AND s.id IS NOT NULL))
        ${pos ? sql`AND (e.occurred_at, e.id) < (${pos.t}::timestamptz, ${pos.i}::uuid)` : sql``}
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT ${limit + 1}`.execute(tx.db);
    return r.rows;
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      occurredAt: r.t,
      category: r.category,
      action: r.action,
      outcome: r.outcome,
      thisSession: r.subject_type === 'session' && r.subject_id === ctx.session.id,
      device: r.device_label,
      network: maskNetwork(r.network_prefix),
      client: r.user_agent_family,
    })),
    nextCursor:
      rows.length > limit && last
        ? sealCursor(signingKey, ctx.account.id, { t: last.t, i: last.id })
        : null,
  };
}
