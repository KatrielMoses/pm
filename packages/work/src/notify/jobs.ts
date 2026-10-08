import { newPublicId, newUuidV7 } from '@pm/contracts';
import {
  sql,
  type PlatformDiscovery,
  type TenantDatabase,
  type WorkspaceTransaction,
} from '@pm/db';
import { errorFields, type Logger, type Metrics } from '@pm/observability';
import { writeOutboxEvent, type JobHandler, type RecurringJob } from '@pm/platform';
import { validZone } from '../time/semantics.ts';
import { DEFAULT_WORK_SETTINGS, type WorkSettings } from '../validation.ts';
import { activePerson, principalOf, readableRecords } from './access.ts';
import { NotificationFanOut } from './fanout.ts';
import { composeEmail, externalLine, type NotificationRow } from './render.ts';
import {
  afterFailure,
  dueDigestSlot,
  quietEndsAt,
  resolveMode,
  retryDelayMs,
  SECURITY_TYPES,
  type ModeRow,
  type NotificationType,
} from './semantics.ts';
import { systemExec } from './system.ts';
import { classifyTransportError, DeliveryError, type EmailProvider } from './transport.ts';

export const NOTIFY_JOB_KINDS = { dispatch: 'notify.dispatch' } as const;

/** Every minute: deliveries due, digests, deadline notices, and retention (4B). */
export const NOTIFY_SCHEDULES: readonly RecurringJob[] = [
  {
    kind: NOTIFY_JOB_KINDS.dispatch,
    queue: 'default',
    intervalMs: 60_000,
    maxAttempts: 3,
    timeoutSeconds: 120,
  },
];

export interface NotifyJobDeps {
  tenant: TenantDatabase;
  discovery: PlatformDiscovery;
  email: EmailProvider;
  /** The public origin links point at. */
  origin: string;
  metrics: Metrics;
  logger: Logger;
  settings?: WorkSettings;
  arrayMax?: number;
}

const LEASE_MS = 2 * 60_000;
const DAY = 86_400_000;

/**
 * The notification dispatcher (ADR-0024 D5, D8). Per workspace with work: deferred deliveries leave
 * quiet hours, unacknowledged browser deliveries expire, due digests are assembled from still
 * authorized unread items, due-soon and overdue notices fire once per task and due date, and old
 * notifications age out. Email deliveries are then claimed with a lease and sent: a delivery is
 * `delivered` only after the provider acknowledges it, a crash between send and mark means the lease
 * lapses and the message is retried under the same message id, and failures are classified into
 * bounded retries with backoff, dead letters, and permanent failures an administrator can see.
 */
export function notifyDispatchHandler(d: NotifyJobDeps): JobHandler {
  return {
    kind: NOTIFY_JOB_KINDS.dispatch,
    queue: 'default',
    maxAttempts: 3,
    timeoutMs: 120_000,
    async handle() {
      const s = d.settings ?? DEFAULT_WORK_SETTINGS;
      const now = new Date();
      const retentionBefore = new Date(now.getTime() - s.notifyRetentionDays * DAY);
      const workspaces = await d.discovery.discoverNotificationWork(
        now,
        retentionBefore,
        s.notifyDiscoveryMax,
      );
      for (const ws of workspaces) {
        try {
          await runNotifyWorkspace(d, ws, now);
        } catch (err) {
          d.metrics.count('notify.deliveries', 1, { channel: 'email', outcome: 'sweep_error' });
          d.logger.warn('notify.sweep_failed', errorFields(err));
        }
      }
    },
  };
}

/** One workspace's sweep at `now` (exported so tests and the handler share one path). */
export async function runNotifyWorkspace(
  d: NotifyJobDeps,
  workspaceId: string,
  now: Date,
): Promise<void> {
  const s = d.settings ?? DEFAULT_WORK_SETTINGS;
  await d.tenant.withWorkspace(workspaceId, { module: 'work' }, async (tx) => {
    await releaseDeferred(tx, d, s, now);
    await expireBrowser(tx, d, s, now);
    await assembleDigests(tx, d, s, now);
    await deadlineNotices(tx, d, s, now);
    await ageOut(tx, s, now);
  });
  if (d.email.state === 'unconfigured') await suppressUnconfigured(workspaceId, d, now);
  else {
    const ids = await claim(workspaceId, d, s, now);
    for (const id of ids) await sendOne(workspaceId, id, d, s, now);
  }
}

// -------------------------------------------------------------------------------------------
// Profile and mode helpers
// -------------------------------------------------------------------------------------------

async function profileOf(tx: WorkspaceTransaction, member: string) {
  const p = await tx.db
    .selectFrom('notify.profile')
    .selectAll()
    .where('membership_id', '=', member)
    .executeTakeFirst();
  return {
    timezone: p?.timezone ?? null,
    quiet_start_minute: p?.quiet_start_minute ?? null,
    quiet_end_minute: p?.quiet_end_minute ?? null,
    email_enabled: p?.email_enabled ?? true,
    browser_enabled: p?.browser_enabled ?? false,
    digest_cadence: (p?.digest_cadence ?? 'daily') as 'off' | 'daily' | 'weekly',
    daily_digest_minute: p?.daily_digest_minute ?? 480,
    weekly_digest_weekday: p?.weekly_digest_weekday ?? 1,
    weekly_digest_minute: p?.weekly_digest_minute ?? 540,
  };
}

async function zoneOf(
  tx: WorkspaceTransaction,
  accountId: string,
  profileZone: string | null,
): Promise<string> {
  const own = validZone(profileZone);
  if (own) return own;
  const a = await tx.db
    .selectFrom('identity.account')
    .select('timezone')
    .where('id', '=', accountId)
    .executeTakeFirst();
  const ws = await tx.db
    .selectFrom('tenancy.workspace')
    .select('timezone')
    .where('id', '=', tx.workspaceId)
    .executeTakeFirstOrThrow();
  return validZone(a?.timezone) ?? ws.timezone;
}

async function announce(
  tx: WorkspaceTransaction,
  row: { id: string; channel: string; kind: string; recipient_membership_id: string },
  state: string,
  failureClass: string | null,
): Promise<void> {
  await writeOutboxEvent(tx, {
    type: 'notify.delivery.state_changed',
    aggregate: { type: 'notify.notification_delivery', id: row.id, sequence: 0 },
    data: { channel: row.channel, kind: row.kind, state, failure_class: failureClass },
    actor: { type: 'system', id: row.recipient_membership_id },
    context: systemExec(tx.workspaceId, row.recipient_membership_id),
  });
}

// -------------------------------------------------------------------------------------------
// Sweeps inside one workspace transaction
// -------------------------------------------------------------------------------------------

async function releaseDeferred(
  tx: WorkspaceTransaction,
  d: NotifyJobDeps,
  s: WorkSettings,
  now: Date,
) {
  const due = await sql<{
    id: string;
    recipient_membership_id: string;
    type: string | null;
  }>`SELECT dl.id, dl.recipient_membership_id, n.type FROM notify.delivery dl
       LEFT JOIN notify.notification n ON n.workspace_id = dl.workspace_id AND n.id = dl.notification_id
      WHERE dl.state = 'deferred_quiet_hours' AND dl.next_attempt_at <= ${now}
      ORDER BY dl.next_attempt_at, dl.id LIMIT ${s.notifyDeliveryBatchMax}
      FOR UPDATE OF dl SKIP LOCKED`.execute(tx.db);
  for (const r of due.rows) {
    const person = await activePerson(tx, r.recipient_membership_id);
    const profile = await profileOf(tx, r.recipient_membership_id);
    const tz = person ? await zoneOf(tx, person.account_id, profile.timezone) : 'UTC';
    const stillQuiet =
      r.type && SECURITY_TYPES.has(r.type as NotificationType)
        ? null
        : quietEndsAt(now, tz, profile.quiet_start_minute, profile.quiet_end_minute);
    await tx.db
      .updateTable('notify.delivery')
      .set(
        stillQuiet
          ? { next_attempt_at: stillQuiet, updated_at: now }
          : { state: 'pending', updated_at: now, version: sql`version + 1` },
      )
      .where('id', '=', r.id)
      .execute();
  }
}

async function expireBrowser(
  tx: WorkspaceTransaction,
  d: NotifyJobDeps,
  s: WorkSettings,
  now: Date,
) {
  const cutoff = new Date(now.getTime() - s.notifyBrowserAckTtlMinutes * 60_000);
  const expired = await tx.db
    .updateTable('notify.delivery')
    .set({ state: 'expired', updated_at: now, version: sql`version + 1` })
    .where('channel', '=', 'browser')
    .where('state', '=', 'pending')
    .where('next_attempt_at', '<', cutoff)
    .returning(['id'])
    .execute();
  if (expired.length)
    d.metrics.count('notify.deliveries', expired.length, {
      channel: 'browser',
      outcome: 'expired',
    });
}

async function assembleDigests(
  tx: WorkspaceTransaction,
  d: NotifyJobDeps,
  s: WorkSettings,
  now: Date,
) {
  const members = await sql<{ recipient_membership_id: string }>`
    SELECT DISTINCT recipient_membership_id FROM notify.notification WHERE digest_pending
     ORDER BY recipient_membership_id LIMIT ${s.notifyDeliveryBatchMax}`.execute(tx.db);
  for (const m of members.rows) {
    const id = m.recipient_membership_id;
    const person = await activePerson(tx, id);
    if (!person) {
      await tx.db
        .updateTable('notify.notification')
        .set({ digest_pending: false })
        .where('recipient_membership_id', '=', id)
        .where('digest_pending', '=', true)
        .execute();
      continue;
    }
    const profile = await profileOf(tx, id);
    const tz = await zoneOf(tx, person.account_id, profile.timezone);
    const slot = dueDigestSlot(profile, tz, now);
    if (!slot) continue;
    const pending = (
      await sql<NotificationRow>`
      SELECT n.id, n.public_id, n.type, n.record_id, n.actor_membership_id, n.facts, n.occurrences, n.state,
             n.group_key, n.created_at, n.last_occurred_at, n.version
        FROM notify.notification n
       WHERE n.recipient_membership_id = ${id} AND n.digest_pending
       ORDER BY n.last_occurred_at DESC, n.id LIMIT 1000`.execute(tx.db)
    ).rows;
    const fresh = pending.filter((n) => n.state === 'unread');
    const principal = await principalOf(tx, person);
    const records = await readableRecords(
      tx,
      principal,
      fresh.flatMap((n) => (n.record_id ? [n.record_id] : [])),
      d.arrayMax ?? 10_000,
    );
    const included = fresh
      .filter(
        (n) =>
          !n.record_id ||
          records.has(n.record_id) ||
          SECURITY_TYPES.has(n.type as NotificationType),
      )
      .slice(0, s.notifyDigestItemsMax);
    const digestId = newUuidV7();
    const made = await tx.db
      .insertInto('notify.digest')
      .values({
        id: digestId,
        workspace_id: tx.workspaceId,
        recipient_membership_id: id,
        period_kind: slot.kind,
        period_start: slot.start,
        period_end: slot.end,
        item_count: included.length,
        state: included.length ? 'assembled' : 'empty',
      })
      .onConflict((oc) =>
        oc
          .columns(['workspace_id', 'recipient_membership_id', 'period_kind', 'period_start'])
          .doNothing(),
      )
      .returning('id')
      .executeTakeFirst();
    // Another worker already assembled this slot: its items are its own.
    if (!made) continue;
    if (included.length)
      await tx.db
        .updateTable('notify.notification')
        .set({ digest_id: digestId, digest_pending: false })
        .where(
          'id',
          'in',
          included.map((n) => n.id),
        )
        .execute();
    // Everything else leaves the queue: read or hidden items are not sent, the rest stay in the centre.
    await tx.db
      .updateTable('notify.notification')
      .set({ digest_pending: false })
      .where('recipient_membership_id', '=', id)
      .where('digest_pending', '=', true)
      .execute();
    d.metrics.count('notify.digests', 1, {
      kind: slot.kind,
      outcome: included.length ? 'assembled' : 'empty',
    });
    if (included.length && profile.email_enabled) {
      const held = quietEndsAt(now, tz, profile.quiet_start_minute, profile.quiet_end_minute);
      await tx.db
        .insertInto('notify.delivery')
        .values({
          id: newUuidV7(),
          public_id: newPublicId('ndl'),
          workspace_id: tx.workspaceId,
          recipient_membership_id: id,
          channel: 'email',
          kind: 'digest',
          digest_id: digestId,
          state: held ? 'deferred_quiet_hours' : 'pending',
          next_attempt_at: held ?? now,
        })
        .execute();
    }
  }
}

/**
 * Due-soon and overdue notices (NTF-005): open tasks due today or tomorrow, and tasks that fell
 * overdue yesterday, in their brand's zone, notify their assignees once per task and due date.
 */
async function deadlineNotices(
  tx: WorkspaceTransaction,
  d: NotifyJobDeps,
  s: WorkSettings,
  now: Date,
) {
  const rows = await sql<{ id: string; due: string; kind: 'due_soon' | 'overdue' }>`
    SELECT t.id, t.due_date::text AS due,
           CASE WHEN t.due_date < (${now}::timestamptz AT TIME ZONE b.timezone)::date THEN 'overdue' ELSE 'due_soon' END AS kind
      FROM work.task t
      JOIN tenancy.brand b ON b.workspace_id = t.workspace_id AND b.id = t.brand_id
      JOIN core.record r ON r.workspace_id = t.workspace_id AND r.id = t.id
     WHERE t.due_date IS NOT NULL AND t.status_category NOT IN ('done', 'cancelled')
       AND r.lifecycle_state = 'active'
       AND t.due_date BETWEEN (${now}::timestamptz AT TIME ZONE b.timezone)::date - 1
                          AND (${now}::timestamptz AT TIME ZONE b.timezone)::date + 1
       AND EXISTS (SELECT 1 FROM work.task_assignee a WHERE a.task_id = t.id)
     ORDER BY t.due_date, t.id LIMIT ${s.notifyDeadlinesBatchMax}`.execute(tx.db);
  if (!rows.rows.length) return;
  const fan = fanOutOf(d, s);
  for (const t of rows.rows) {
    // Only a task that just fell overdue (yesterday) notifies; older overdue work is not re-announced.
    const assignees = (
      await tx.db
        .selectFrom('work.task_assignee')
        .select('membership_id')
        .where('task_id', '=', t.id)
        .execute()
    ).map((a) => a.membership_id);
    await fan.persist(tx, null, {
      type: t.kind,
      recordId: t.id,
      actorId: null,
      recipients: assignees,
      facts: {},
      occasion: `due:${t.due}`,
    });
  }
}

async function ageOut(tx: WorkspaceTransaction, s: WorkSettings, now: Date) {
  const cutoff = new Date(now.getTime() - s.notifyRetentionDays * DAY);
  const old = (
    await tx.db
      .selectFrom('notify.notification')
      .select('id')
      .where('state', '<>', 'saved')
      .where('last_occurred_at', '<', cutoff)
      .orderBy('last_occurred_at')
      .limit(1000)
      .execute()
  ).map((n) => n.id);
  if (old.length) {
    await tx.db.deleteFrom('notify.delivery').where('notification_id', 'in', old).execute();
    await tx.db.deleteFrom('notify.notification').where('id', 'in', old).execute();
  }
  await sql`DELETE FROM notify.delivery dl USING notify.digest g
             WHERE g.workspace_id = dl.workspace_id AND g.id = dl.digest_id AND g.created_at < ${cutoff}
               AND dl.state NOT IN ('pending', 'sending', 'deferred_quiet_hours')`.execute(tx.db);
  await sql`DELETE FROM notify.digest g WHERE g.created_at < ${cutoff}
             AND NOT EXISTS (SELECT 1 FROM notify.notification n WHERE n.workspace_id = g.workspace_id AND n.digest_id = g.id)
             AND NOT EXISTS (SELECT 1 FROM notify.delivery dl WHERE dl.workspace_id = g.workspace_id AND dl.digest_id = g.id)`.execute(
    tx.db,
  );
}

function fanOutOf(d: NotifyJobDeps, s: WorkSettings) {
  return new NotificationFanOut(
    {
      notifyFanoutRecipientsMax: s.notifyFanoutRecipientsMax,
      notifyDedupeWindowMinutes: s.notifyDedupeWindowMinutes,
      notifyEmailPerHourMax: s.notifyEmailPerHourMax,
      notifyFactsMaxBytes: s.notifyFactsMaxBytes,
      principalContextArrayMax: d.arrayMax ?? 10_000,
    },
    d.metrics,
  );
}

// -------------------------------------------------------------------------------------------
// Email delivery
// -------------------------------------------------------------------------------------------

/** No provider: due email is recorded as suppressed with the reason, never as delivered. */
async function suppressUnconfigured(workspaceId: string, d: NotifyJobDeps, now: Date) {
  await d.tenant.withWorkspace(workspaceId, { module: 'work' }, async (tx) => {
    const rows = await tx.db
      .updateTable('notify.delivery')
      .set({
        state: 'suppressed',
        suppress_reason: 'provider_unconfigured',
        updated_at: now,
        version: sql`version + 1`,
      })
      .where('channel', '=', 'email')
      .where('state', '=', 'pending')
      .where('next_attempt_at', '<=', now)
      .returning(['id', 'channel', 'kind', 'recipient_membership_id'])
      .execute();
    for (const r of rows) await announce(tx, r, 'suppressed', 'unconfigured');
    if (rows.length)
      d.metrics.count('notify.deliveries', rows.length, {
        channel: 'email',
        outcome: 'unconfigured',
      });
  });
}

async function claim(
  workspaceId: string,
  d: NotifyJobDeps,
  s: WorkSettings,
  now: Date,
): Promise<string[]> {
  return d.tenant.withWorkspace(workspaceId, { module: 'work' }, async (tx) => {
    const r = await sql<{ id: string }>`
      UPDATE notify.delivery SET state = 'sending', lease_until = ${new Date(now.getTime() + LEASE_MS)},
             attempts = attempts + 1, updated_at = ${now}, version = version + 1
       WHERE id IN (
         SELECT id FROM notify.delivery
          WHERE channel = 'email' AND ((state = 'pending' AND next_attempt_at <= ${now})
             OR (state = 'sending' AND lease_until <= ${now}))
          ORDER BY next_attempt_at, id LIMIT ${s.notifyDeliveryBatchMax} FOR UPDATE SKIP LOCKED)
       RETURNING id`.execute(tx.db);
    return r.rows.map((x) => x.id);
  });
}

type Outcome =
  | { kind: 'send'; to: string; subject: string; text: string; html: string; messageId: string }
  | { kind: 'suppress'; reason: string }
  | { kind: 'defer'; until: Date };

/** Rechecks everything at send time: the person, their choices, quiet hours, and what they may read. */
async function prepare(
  tx: WorkspaceTransaction,
  d: NotifyJobDeps,
  s: WorkSettings,
  deliveryId: string,
  now: Date,
): Promise<{
  outcome: Outcome;
  account: string | null;
  row: {
    id: string;
    channel: string;
    kind: string;
    recipient_membership_id: string;
    attempts: number;
  } | null;
}> {
  const row = await tx.db
    .selectFrom('notify.delivery')
    .selectAll()
    .where('id', '=', deliveryId)
    .executeTakeFirst();
  if (!row || row.state !== 'sending')
    return { outcome: { kind: 'suppress', reason: 'superseded' }, account: null, row: null };
  const head = {
    id: row.id,
    channel: row.channel,
    kind: row.kind,
    recipient_membership_id: row.recipient_membership_id,
    attempts: row.attempts,
  };
  const person = await activePerson(tx, row.recipient_membership_id);
  if (!person)
    return {
      outcome: { kind: 'suppress', reason: 'recipient_unavailable' },
      account: null,
      row: head,
    };
  const profile = await profileOf(tx, person.id);
  if (!profile.email_enabled)
    return {
      outcome: { kind: 'suppress', reason: 'email_disabled' },
      account: person.account_id,
      row: head,
    };
  const ws = await tx.db
    .selectFrom('tenancy.workspace')
    .select('public_id')
    .where('id', '=', tx.workspaceId)
    .executeTakeFirstOrThrow();
  const principal = await principalOf(tx, person);
  const arrayMax = d.arrayMax ?? 10_000;
  const base = d.origin.replace(/\/$/, '');
  const footer = `You can change what you get by email: ${base}/workspaces/${ws.public_id}/settings/notifications`;

  let rows: NotificationRow[];
  let digestKind: string | null = null;
  if (row.kind === 'notification') {
    rows = (
      await sql<NotificationRow>`
      SELECT n.id, n.public_id, n.type, n.record_id, n.actor_membership_id, n.facts, n.occurrences, n.state,
             n.group_key, n.created_at, n.last_occurred_at, n.version
        FROM notify.notification n WHERE n.id = ${row.notification_id}`.execute(tx.db)
    ).rows;
    const n = rows[0];
    if (!n)
      return {
        outcome: { kind: 'suppress', reason: 'superseded' },
        account: person.account_id,
        row: head,
      };
    // Quiet hours and the person's current choices still apply when the message is about to leave.
    if (!SECURITY_TYPES.has(n.type as NotificationType)) {
      const tz = await zoneOf(tx, person.account_id, profile.timezone);
      const until = quietEndsAt(now, tz, profile.quiet_start_minute, profile.quiet_end_minute);
      if (until)
        return { outcome: { kind: 'defer', until }, account: person.account_id, row: head };
    }
    const prefs = (await tx.db
      .selectFrom('notify.preference')
      .select(['event_type', 'scope_kind', 'scope_record_id', 'channel', 'mode', 'expires_at'])
      .where('membership_id', '=', person.id)
      .execute()) as ModeRow[];
    const place = n.record_id
      ? await sql<{ brand_id: string | null; project_id: string | null }>`
          SELECT r.brand_id, COALESCE(t.project_id, w.id) AS project_id FROM core.record r
            LEFT JOIN work.task t ON t.workspace_id = r.workspace_id AND t.id = r.id
            LEFT JOIN work.project w ON w.workspace_id = r.workspace_id AND w.id = r.id WHERE r.id = ${n.record_id}`.execute(
          tx.db,
        )
      : null;
    const scopes = {
      record: n.record_id,
      project: place?.rows[0]?.project_id ?? null,
      brand: place?.rows[0]?.brand_id ?? null,
    };
    const mode = resolveMode(n.type as NotificationType, 'email', scopes, prefs, [], now).mode;
    if (mode === 'muted')
      return {
        outcome: { kind: 'suppress', reason: 'muted' },
        account: person.account_id,
        row: head,
      };
  } else {
    const g = await tx.db
      .selectFrom('notify.digest')
      .select('period_kind')
      .where('id', '=', row.digest_id!)
      .executeTakeFirst();
    digestKind = g?.period_kind ?? 'daily';
    rows = (
      await sql<NotificationRow>`
      SELECT n.id, n.public_id, n.type, n.record_id, n.actor_membership_id, n.facts, n.occurrences, n.state,
             n.group_key, n.created_at, n.last_occurred_at, n.version
        FROM notify.notification n WHERE n.digest_id = ${row.digest_id} AND n.state = 'unread'
       ORDER BY n.last_occurred_at DESC, n.id LIMIT ${s.notifyDigestItemsMax}`.execute(tx.db)
    ).rows;
    const tz = await zoneOf(tx, person.account_id, profile.timezone);
    const until = quietEndsAt(now, tz, profile.quiet_start_minute, profile.quiet_end_minute);
    if (until) return { outcome: { kind: 'defer', until }, account: person.account_id, row: head };
  }
  const lines: Array<{ line: string; url: string }> = [];
  for (const n of rows) {
    const e = await externalLine(tx, principal, n, ws.public_id, arrayMax);
    if (e) lines.push({ line: e.line, url: `${base}${e.path}` });
  }
  if (!lines.length)
    return {
      outcome: { kind: 'suppress', reason: row.kind === 'digest' ? 'no_content' : 'access_lost' },
      account: person.account_id,
      row: head,
    };
  const subject =
    row.kind === 'digest'
      ? `Your ${digestKind} digest: ${lines.length} ${lines.length === 1 ? 'item' : 'items'}`
      : lines[0]!.line;
  const mail = composeEmail(subject, lines, footer);
  return {
    outcome: { kind: 'send', to: '', ...mail, messageId: row.public_id },
    account: person.account_id,
    row: head,
  };
}

async function sendOne(
  workspaceId: string,
  deliveryId: string,
  d: NotifyJobDeps,
  s: WorkSettings,
  now: Date,
): Promise<void> {
  const prepared = await d.tenant.withWorkspace(workspaceId, { module: 'work' }, (tx) =>
    prepare(tx, d, s, deliveryId, now),
  );
  const { outcome, row, account } = prepared;
  if (!row) return;
  const finish = (fn: (tx: WorkspaceTransaction) => Promise<void>) =>
    d.tenant.withWorkspace(workspaceId, { module: 'work' }, fn);
  if (outcome.kind === 'suppress')
    return finish(async (tx) => {
      await tx.db
        .updateTable('notify.delivery')
        .set({
          state: 'suppressed',
          suppress_reason: outcome.reason as never,
          lease_until: null,
          updated_at: now,
          version: sql`version + 1`,
        })
        .where('id', '=', row.id)
        .execute();
      await announce(tx, row, 'suppressed', null);
      d.metrics.count('notify.deliveries', 1, { channel: 'email', outcome: 'suppressed' });
    });
  if (outcome.kind === 'defer')
    return finish(async (tx) => {
      await tx.db
        .updateTable('notify.delivery')
        .set({
          state: 'deferred_quiet_hours',
          next_attempt_at: outcome.until,
          lease_until: null,
          attempts: Math.max(row.attempts - 1, 0),
          updated_at: now,
          version: sql`version + 1`,
        })
        .where('id', '=', row.id)
        .execute();
      d.metrics.count('notify.deliveries', 1, { channel: 'email', outcome: 'deferred' });
    });

  // The address is read only now, from the account of a person who is still an active member, and
  // is never stored with the notification.
  const address = account
    ? await d.tenant.withWorkspace(workspaceId, { module: 'work', readOnly: true }, async (tx) => {
        const a = await tx.db
          .selectFrom('identity.account')
          .select('primary_email')
          .where('id', '=', account)
          .executeTakeFirst();
        return a?.primary_email ?? null;
      })
    : null;
  if (!address)
    return finish(async (tx) => {
      await tx.db
        .updateTable('notify.delivery')
        .set({
          state: 'suppressed',
          suppress_reason: 'recipient_unavailable',
          lease_until: null,
          updated_at: now,
          version: sql`version + 1`,
        })
        .where('id', '=', row.id)
        .execute();
      await announce(tx, row, 'suppressed', null);
    });

  let sent: { providerMessageId: string } | null = null;
  let failure: DeliveryError | null = null;
  try {
    sent = await d.email.send({
      id: outcome.messageId,
      to: address,
      subject: outcome.subject,
      text: outcome.text,
      html: outcome.html,
    });
  } catch (err) {
    failure = classifyTransportError(err);
  }
  await finish(async (tx) => {
    if (sent) {
      await tx.db
        .updateTable('notify.delivery')
        .set({
          state: 'delivered',
          delivered_at: new Date(),
          provider_message_id: sent.providerMessageId.slice(0, 200),
          ack_source: 'provider',
          lease_until: null,
          failure_class: null,
          failure_code: null,
          updated_at: new Date(),
          version: sql`version + 1`,
        })
        .where('id', '=', row.id)
        .execute();
      await announce(tx, row, 'delivered', null);
      d.metrics.count('notify.deliveries', 1, { channel: 'email', outcome: 'delivered' });
      return;
    }
    const f = failure!;
    const next = afterFailure(f.failureClass, row.attempts, s.notifyDeliveryMaxAttempts);
    if (next === 'retry') {
      await tx.db
        .updateTable('notify.delivery')
        .set({
          state: 'pending',
          next_attempt_at: new Date(
            Date.now() +
              retryDelayMs(row.attempts, s.notifyRetryBaseSeconds, s.notifyRetryMaxSeconds),
          ),
          lease_until: null,
          failure_class: f.failureClass,
          failure_code: f.code,
          updated_at: new Date(),
          version: sql`version + 1`,
        })
        .where('id', '=', row.id)
        .execute();
      d.metrics.count('notify.deliveries', 1, { channel: 'email', outcome: 'retry' });
      return;
    }
    await tx.db
      .updateTable('notify.delivery')
      .set(
        next === 'suppressed'
          ? {
              state: 'suppressed',
              suppress_reason: 'provider_unconfigured',
              lease_until: null,
              failure_class: f.failureClass,
              failure_code: f.code,
            }
          : { state: next, lease_until: null, failure_class: f.failureClass, failure_code: f.code },
      )
      .where('id', '=', row.id)
      .execute();
    await tx.db
      .updateTable('notify.delivery')
      .set({ updated_at: new Date(), version: sql`version + 1` })
      .where('id', '=', row.id)
      .execute();
    await announce(tx, row, next, f.failureClass);
    d.metrics.count('notify.deliveries', 1, { channel: 'email', outcome: next });
  });
}
