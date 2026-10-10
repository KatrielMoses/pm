import { newPublicId, newUuidV7, type InternalEventType } from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import type { Metrics } from '@pm/observability';
import { writeOutboxEvent, type InternalEvent, type OutboxConsumer } from '@pm/platform';
import { validZone } from '../time/semantics.ts';
import { activePerson, placementOf, principalOf, readableRecords, type Person } from './access.ts';
import {
  dedupeKey,
  groupKey,
  isNotificationType,
  quietEndsAt,
  resolveMode,
  SECURITY_TYPES,
  type Mode,
  type ModeRow,
  type NotificationType,
} from './semantics.ts';
import { systemExec } from './system.ts';

/** The bounds fan-out reads (registered 0D parameters, owner 4B). */
export interface FanOutSettings {
  notifyFanoutRecipientsMax: number;
  notifyDedupeWindowMinutes: number;
  notifyEmailPerHourMax: number;
  notifyFactsMaxBytes: number;
  principalContextArrayMax: number;
}

/** What one event means to people: a type, a record, and who it concerns. */
export interface Candidate {
  type: NotificationType;
  recordId: string | null;
  actorId: string | null;
  recipients: string[];
  facts: Record<string, string | number | boolean | null>;
  /** Pins the dedupe key to an occasion (a day, a reminder) instead of a time bucket. */
  occasion?: string | null;
}

/** Events that notify people: the 0D `notification` consumers whose sources exist today. */
export const FANOUT_EVENTS = [
  'work.task.assigned',
  'work.task.delegated',
  'relations.mention.created',
  'knowledge.document.mention_added',
  'collab.comment.created',
  'collab.review.requested',
  'collab.review.withdrawn',
  'collab.review.decided',
  'access.grant.created',
  'access.grant.revoked',
  'access.role.assigned',
  'access.role.revoked',
  'planning.task_reminder.fired',
  'relations.relationship.created',
  'integrations.sync.failed',
  'integrations.connection.health_changed',
  'integrations.connection.disconnected',
] as const satisfies readonly InternalEventType[];

const NIL_UUID = '00000000-0000-7000-8000-000000000000';
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * Phase 4B fan-out (ADR-0024 D1): one durable outbox consumer turns canonical events into
 * notifications. Per recipient it checks that the person is active and can read the record now,
 * resolves their preferences into modes per channel, writes one deduplicated row, and queues the
 * email and browser deliveries those modes call for (held by quiet hours, rolled into a digest, or
 * dropped when muted). The consumer is idempotent: the inbox receipt makes a redelivered event a
 * no-op, and the unique dedupe key makes a repeated one collapse.
 */
export class NotificationFanOut implements OutboxConsumer {
  readonly name = 'notify.fanout';
  readonly eventTypes = FANOUT_EVENTS;
  readonly #s: FanOutSettings;
  readonly #metrics: Metrics | undefined;

  constructor(settings: FanOutSettings, metrics?: Metrics) {
    this.#s = settings;
    this.#metrics = metrics;
  }

  async handle(tx: WorkspaceTransaction, event: InternalEvent): Promise<void> {
    for (const c of await this.candidates(tx, event)) await this.persist(tx, event.event_id, c);
  }

  // ---------------------------------------------------------------------------------------------
  // Meaning: which event concerns whom
  // ---------------------------------------------------------------------------------------------

  /**
   * The record a notification names: a 4E deliverable is reviewed through its task, so its
   * notifications point at (and are re-authorized against) the task.
   */
  protected async notifiableRecord(tx: WorkspaceTransaction, id: string): Promise<string> {
    const d = await tx.db
      .selectFrom('files.deliverable')
      .select('task_id')
      .where('id', '=', id)
      .executeTakeFirst();
    return d?.task_id ?? id;
  }

  protected async candidates(tx: WorkspaceTransaction, e: InternalEvent): Promise<Candidate[]> {
    const actor = str(e.actor.id);
    const data = e.data;
    switch (e.type) {
      case 'work.task.assigned':
        return [
          {
            type: 'assignment',
            recordId: e.aggregate.id,
            actorId: actor,
            recipients: (str(data.assignee_membership_ids) ?? '').split(',').filter(Boolean),
            facts: {},
          },
        ];
      case 'work.task.delegated': {
        const to = str(data.to_membership_id);
        return to
          ? [
              {
                type: 'assignment',
                recordId: e.aggregate.id,
                actorId: actor,
                recipients: [to],
                facts: { delegated: true },
              },
            ]
          : [];
      }
      case 'relations.mention.created': {
        const m = await tx.db
          .selectFrom('relations.mention as m')
          .innerJoin('collab.comment as c', (j) =>
            j.onRef('c.workspace_id', '=', 'm.workspace_id').onRef('c.id', '=', 'm.source_id'),
          )
          .select(['m.target_membership_id', 'm.target_team_id', 'c.host_record_id'])
          .where('m.id', '=', e.aggregate.id)
          .executeTakeFirst();
        if (!m) return [];
        const recipients = m.target_membership_id
          ? [m.target_membership_id]
          : m.target_team_id
            ? await this.teamMembers(tx, m.target_team_id)
            : [];
        return [
          { type: 'mention', recordId: m.host_record_id, actorId: actor, recipients, facts: {} },
        ];
      }
      case 'knowledge.document.mention_added': {
        // A person named in a document (4C): notified like a mention in a comment, if they can read it.
        const m = await tx.db
          .selectFrom('knowledge.document_reference')
          .select(['target_membership_id'])
          .where('id', '=', str(data.reference_id) ?? NIL_UUID)
          .where('document_id', '=', e.aggregate.id)
          .executeTakeFirst();
        return m?.target_membership_id
          ? [
              {
                type: 'mention',
                recordId: e.aggregate.id,
                actorId: actor,
                recipients: [m.target_membership_id],
                facts: {},
                occasion: `doc-mention:${str(data.reference_id)}`,
              },
            ]
          : [];
      }
      case 'collab.comment.created': {
        const host = str(data.host_record_id);
        if (!host) return [];
        const mentioned = await this.mentioned(tx, e.aggregate.id);
        const interested = new Set<string>([
          ...(await this.followers(tx, host)),
          ...(await this.assignees(tx, host)),
          ...(await this.projectOwner(tx, host)),
        ]);
        const recipients = [...interested].filter((x) => !mentioned.has(x));
        return [
          {
            type: 'comment',
            recordId: host,
            actorId: actor,
            recipients,
            facts: { reply: str(data.root_comment_id) !== null },
          },
        ];
      }
      case 'collab.review.requested':
      case 'collab.review.withdrawn': {
        const subject = str(data.subject_ref);
        if (!subject) return [];
        const withdrawn = e.type === 'collab.review.withdrawn';
        const rows = await sql<{ membership_id: string }>`
          SELECT rv.membership_id FROM collab.review_reviewer rv
           WHERE rv.workspace_id = ${tx.workspaceId} AND rv.review_request_id = ${e.aggregate.id}
             ${
               withdrawn
                 ? sql`AND NOT EXISTS (SELECT 1 FROM collab.review_decision d WHERE d.workspace_id = rv.workspace_id
                 AND d.review_request_id = rv.review_request_id AND d.reviewer_membership_id = rv.membership_id)`
                 : sql``
             }
           ORDER BY rv.rank`.execute(tx.db);
        return [
          {
            type: 'review_requested',
            recordId: await this.notifiableRecord(tx, subject),
            actorId: actor,
            recipients: rows.rows.map((r) => r.membership_id),
            facts: withdrawn ? { change: 'withdrawn' } : { kind: str(data.request_kind) },
          },
        ];
      }
      case 'collab.review.decided': {
        if (data.self_approval === true) return [];
        const r = await tx.db
          .selectFrom('collab.review_decision as d')
          .innerJoin('collab.review_request as q', (j) =>
            j
              .onRef('q.workspace_id', '=', 'd.workspace_id')
              .onRef('q.id', '=', 'd.review_request_id'),
          )
          .select(['q.requested_by_membership_id', 'q.subject_record_id', 'd.outcome'])
          .where('d.id', '=', e.aggregate.id)
          .executeTakeFirst();
        return r
          ? [
              {
                type: 'approval_decided',
                recordId: await this.notifiableRecord(tx, r.subject_record_id),
                actorId: actor,
                recipients: [r.requested_by_membership_id],
                facts: { outcome: r.outcome, state: str(data.review_state) },
              },
            ]
          : [];
      }
      case 'access.grant.created':
      case 'access.grant.revoked': {
        const g = await tx.db
          .selectFrom('access.record_grant')
          .select(['record_id', 'grantee_type', 'grantee_id'])
          .where('id', '=', e.aggregate.id)
          .executeTakeFirst();
        if (!g || g.grantee_type === 'brand') return [];
        const recipients =
          g.grantee_type === 'membership'
            ? [g.grantee_id]
            : await this.teamMembers(tx, g.grantee_id);
        return [
          {
            type: 'share_changed',
            recordId: g.record_id,
            actorId: actor,
            recipients,
            facts: { change: e.type === 'access.grant.created' ? 'created' : 'revoked' },
            occasion: `${e.event_id}`,
          },
        ];
      }
      case 'access.role.assigned':
      case 'access.role.revoked': {
        const a = await tx.db
          .selectFrom('access.role_assignment')
          .select(['membership_principal_id'])
          .where('id', '=', e.aggregate.id)
          .executeTakeFirst();
        if (!a?.membership_principal_id) return [];
        return [
          {
            type: 'permission_changed',
            recordId: null,
            actorId: actor,
            recipients: [a.membership_principal_id],
            facts: {
              change: e.type === 'access.role.assigned' ? 'assigned' : 'revoked',
              scope: str(data.scope_type),
            },
            occasion: `${e.event_id}`,
          },
        ];
      }
      case 'planning.task_reminder.fired': {
        const task = str(data.task_id);
        return task && actor
          ? [
              {
                type: 'due_soon',
                recordId: task,
                actorId: null,
                recipients: [actor],
                facts: { reminder: true },
                occasion: `reminder:${e.aggregate.id}`,
              },
            ]
          : [];
      }
      case 'relations.relationship.created': {
        if (data.kind !== 'blocks') return [];
        const to = str(data.to_record_id);
        return to
          ? [
              {
                type: 'blocker',
                recordId: to,
                actorId: actor,
                recipients: await this.assignees(tx, to),
                facts: {},
                occasion: `${e.aggregate.id}`,
              },
            ]
          : [];
      }
      case 'integrations.sync.failed':
      case 'integrations.connection.health_changed':
      case 'integrations.connection.disconnected': {
        const owner = await tx.db
          .selectFrom('integrations.connection')
          .select('owner_membership_id')
          .where('id', '=', e.aggregate.id)
          .executeTakeFirst();
        return owner
          ? [
              {
                type: 'integration_failure',
                recordId: e.aggregate.id,
                actorId: null,
                recipients: [owner.owner_membership_id],
                facts: {
                  health: str(data.health) ?? str(data.terminal_reason) ?? str(data.retention),
                },
              },
            ]
          : [];
      }
      default:
        return [];
    }
  }

  protected async followers(tx: WorkspaceTransaction, record: string): Promise<string[]> {
    return (
      await tx.db
        .selectFrom('relations.follower')
        .select('membership_id')
        .where('record_id', '=', record)
        .execute()
    ).map((r) => r.membership_id);
  }
  protected async assignees(tx: WorkspaceTransaction, task: string): Promise<string[]> {
    return (
      await tx.db
        .selectFrom('work.task_assignee')
        .select('membership_id')
        .where('task_id', '=', task)
        .execute()
    ).map((r) => r.membership_id);
  }
  protected async projectOwner(tx: WorkspaceTransaction, project: string): Promise<string[]> {
    const p = await tx.db
      .selectFrom('work.project')
      .select('owner_membership_id')
      .where('id', '=', project)
      .executeTakeFirst();
    return p ? [p.owner_membership_id] : [];
  }
  protected async teamMembers(tx: WorkspaceTransaction, team: string): Promise<string[]> {
    return (
      await tx.db
        .selectFrom('tenancy.team_member')
        .select('membership_id')
        .where('team_id', '=', team)
        .limit(this.#s.notifyFanoutRecipientsMax)
        .execute()
    ).map((r) => r.membership_id);
  }
  /** People a comment mentions (they get the mention, not a second comment notice). */
  protected async mentioned(tx: WorkspaceTransaction, comment: string): Promise<Set<string>> {
    const rows = await tx.db
      .selectFrom('relations.mention')
      .select(['target_membership_id', 'target_team_id'])
      .where('source_id', '=', comment)
      .execute();
    const out = new Set<string>();
    for (const r of rows) {
      if (r.target_membership_id) out.add(r.target_membership_id);
      if (r.target_team_id)
        for (const m of await this.teamMembers(tx, r.target_team_id)) out.add(m);
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Persistence: authorization, preferences, deduplication, delivery rows
  // ---------------------------------------------------------------------------------------------

  async persist(
    tx: WorkspaceTransaction,
    sourceEventId: string | null,
    c: Candidate,
  ): Promise<void> {
    const now = new Date();
    const seen = new Set<string>();
    const recipients = c.recipients
      .filter((id) => id !== c.actorId && !seen.has(id) && !!seen.add(id))
      .slice(0, this.#s.notifyFanoutRecipientsMax);
    if (!recipients.length) return;
    const place = c.recordId ? await placementOf(tx, c.recordId) : null;
    // A notification about a record that does not exist (or is not one we name) goes nowhere.
    if (c.recordId && !place) return this.count(c.type, 'skipped_record');
    for (const id of recipients) {
      const person = await activePerson(tx, id);
      if (!person) {
        this.count(c.type, 'skipped_recipient');
        continue;
      }
      // Read access is decided now, for the recipient (security notices about lost access still go).
      if (c.recordId && !SECURITY_TYPES.has(c.type)) {
        const ok = await readableRecords(
          tx,
          await principalOf(tx, person),
          [c.recordId],
          this.#s.principalContextArrayMax,
        );
        if (!ok.has(c.recordId)) {
          this.count(c.type, 'skipped_access');
          continue;
        }
      }
      await this.deliverTo(tx, sourceEventId, c, person, place, now);
    }
  }

  protected async deliverTo(
    tx: WorkspaceTransaction,
    sourceEventId: string | null,
    c: Candidate,
    person: Person,
    place: { record: string; brand: string | null; project: string | null } | null,
    now: Date,
  ): Promise<void> {
    const prefs = (await tx.db
      .selectFrom('notify.preference')
      .select(['event_type', 'scope_kind', 'scope_record_id', 'channel', 'mode', 'expires_at'])
      .where('membership_id', '=', person.id)
      .execute()) as ModeRow[];
    const scopeIds = [place?.brand, place?.project].filter((x): x is string => !!x);
    const defaults = scopeIds.length
      ? ((await tx.db
          .selectFrom('notify.scope_default')
          .select(['event_type', 'scope_kind', 'scope_record_id', 'channel', 'mode'])
          .where('scope_record_id', 'in', scopeIds)
          .execute()) as ModeRow[])
      : [];
    const scopes = {
      record: place?.record ?? null,
      project: place?.project ?? null,
      brand: place?.brand ?? null,
    };
    const mode = (channel: 'in_app' | 'email' | 'browser'): Mode =>
      resolveMode(c.type, channel, scopes, prefs, defaults, now).mode;
    // Muting the notification centre mutes the notification (it is the row every channel hangs on).
    if (mode('in_app') === 'muted') return this.count(c.type, 'muted');

    const profile = await tx.db
      .selectFrom('notify.profile')
      .selectAll()
      .where('membership_id', '=', person.id)
      .executeTakeFirst();
    const facts = this.trim(c.facts);
    const key = dedupeKey(
      c.type,
      c.recordId,
      c.actorId,
      now,
      this.#s.notifyDedupeWindowMinutes,
      c.occasion ?? null,
    );

    // Decide the external channels before writing, so the row carries its digest flag.
    const emailMode = mode('email');
    const browserMode = mode('browser');
    const emailOn = (profile?.email_enabled ?? true) && emailMode !== 'muted';
    let digest = emailOn && emailMode === 'digest';
    let emailNow = emailOn && emailMode === 'immediate';
    if (
      emailNow &&
      (await this.emailsLastHour(tx, person.id, now)) >= this.#s.notifyEmailPerHourMax
    ) {
      // Over the hourly limit: the rest roll into the next digest instead of being dropped.
      emailNow = false;
      digest = true;
    }
    const browserNow =
      browserMode === 'immediate' &&
      !!profile?.browser_enabled &&
      profile.browser_permission === 'granted';

    const id = newUuidV7();
    const inserted = await tx.db
      .insertInto('notify.notification')
      .values({
        id,
        public_id: newPublicId('ntf'),
        workspace_id: tx.workspaceId,
        recipient_membership_id: person.id,
        type: c.type,
        record_id: c.recordId,
        actor_membership_id: c.actorId,
        source_event_id: sourceEventId,
        dedupe_key: key,
        group_key: groupKey(c.type, c.recordId),
        facts: JSON.stringify(facts),
        digest_pending: digest,
      })
      .onConflict((oc) =>
        // An occasion (one reminder, one due date, one event) happens once: repeating it is a no-op,
        // not another occurrence. Time-bucket repeats collapse and reopen.
        c.occasion
          ? oc.columns(['workspace_id', 'recipient_membership_id', 'dedupe_key']).doNothing()
          : oc.columns(['workspace_id', 'recipient_membership_id', 'dedupe_key']).doUpdateSet({
              occurrences: sql`notify.notification.occurrences + 1`,
              last_occurred_at: now,
              // New activity reopens a read or dismissed item; a saved one stays saved.
              state: sql`CASE WHEN notify.notification.state IN ('read', 'dismissed') THEN 'unread' ELSE notify.notification.state END`,
              state_changed_at: sql`CASE WHEN notify.notification.state IN ('read', 'dismissed') THEN now() ELSE notify.notification.state_changed_at END`,
              version: sql`notify.notification.version + 1`,
            }),
      )
      .returning(['id', sql<boolean>`(xmax = 0)`.as('created')])
      .executeTakeFirst();
    if (!inserted?.created) return this.count(c.type, 'collapsed');
    this.count(c.type, 'created');

    const tz = validZone(profile?.timezone) ?? (await this.accountZone(tx, person.account_id));
    const held = SECURITY_TYPES.has(c.type)
      ? null
      : quietEndsAt(
          now,
          tz,
          profile?.quiet_start_minute ?? null,
          profile?.quiet_end_minute ?? null,
        );
    for (const [channel, want] of [
      ['email', emailNow],
      ['browser', browserNow],
    ] as const)
      if (want)
        await tx.db
          .insertInto('notify.delivery')
          .values({
            id: newUuidV7(),
            public_id: newPublicId('ndl'),
            workspace_id: tx.workspaceId,
            recipient_membership_id: person.id,
            channel,
            kind: 'notification',
            notification_id: inserted.id,
            state: held ? 'deferred_quiet_hours' : 'pending',
            next_attempt_at: held ?? now,
          })
          .execute();
    await writeOutboxEvent(tx, {
      type: 'notify.notification.created',
      aggregate: { type: 'notify.notification', id: inserted.id, sequence: 0 },
      data: { type: c.type, record_id: c.recordId },
      actor: { type: 'system', id: person.id },
      context: systemExec(tx.workspaceId, person.id),
    });
  }

  protected trim(facts: Candidate['facts']): Candidate['facts'] {
    const out: Candidate['facts'] = {};
    let size = 2;
    for (const [k, v] of Object.entries(facts)) {
      const cost = JSON.stringify([k, v]).length;
      if (size + cost > this.#s.notifyFactsMaxBytes) break;
      out[k] = typeof v === 'string' ? v.slice(0, 200) : v;
      size += cost;
    }
    return out;
  }

  protected async emailsLastHour(
    tx: WorkspaceTransaction,
    member: string,
    now: Date,
  ): Promise<number> {
    const r = await tx.db
      .selectFrom('notify.delivery')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('recipient_membership_id', '=', member)
      .where('channel', '=', 'email')
      .where('kind', '=', 'notification')
      .where('created_at', '>', new Date(now.getTime() - 3_600_000))
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  protected async accountZone(tx: WorkspaceTransaction, accountId: string): Promise<string> {
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

  protected count(type: NotificationType, outcome: string) {
    if (isNotificationType(type)) this.#metrics?.count('notify.fanout', 1, { type, outcome });
  }
}
