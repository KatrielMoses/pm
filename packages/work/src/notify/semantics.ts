import { addDays, isoWeekday, localDay } from '../time/semantics.ts';

/**
 * Pure rules of the Phase 4B notification platform (ADR-0024): types and defaults, how a person's
 * preferences, mute scopes, and scope defaults resolve to one delivery mode, quiet hours, digest
 * slots, deduplication and grouping keys, retry timing, and the safe wording of each event. No
 * database, no clock, no authorization: the services own those.
 */

export const NOTIFICATION_TYPES = [
  'assignment',
  'mention',
  'comment',
  'review_requested',
  'approval_decided',
  'blocker',
  'due_soon',
  'overdue',
  'integration_failure',
  'automation_failure',
  'agent_failure',
  'agent_output_ready',
  'spend_threshold',
  'permission_changed',
  'share_changed',
  'briefing_ready',
  'export_ready',
  'hidden_dependency_affects_assignee',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type Channel = 'in_app' | 'email' | 'browser';
export type PrefChannel = Channel | 'all';
export type Mode = 'immediate' | 'digest' | 'muted';
export type NotifyScopeKind = 'workspace' | 'brand' | 'project' | 'record';

/** Security notices: quiet hours never hold them, and they are never grouped away. */
export const SECURITY_TYPES: ReadonlySet<NotificationType> = new Set([
  'permission_changed',
  'share_changed',
]);
/** Failures and spending: shown with warning styling and never grouped with low-value items. */
export const FAILURE_TYPES: ReadonlySet<NotificationType> = new Set([
  'integration_failure',
  'automation_failure',
  'agent_failure',
  'spend_threshold',
]);
/** Low-value repeats that collapse into "3 comments on…" (COL-019). */
const GROUPABLE: ReadonlySet<NotificationType> = new Set([
  'comment',
  'blocker',
  'due_soon',
  'overdue',
  'hidden_dependency_affects_assignee',
]);

export const isNotificationType = (v: unknown): v is NotificationType =>
  typeof v === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(v);

/**
 * The explicit, privacy-safe defaults (UXD-18). In-app is always complete. Email is immediate for
 * what needs a person (mentions, assignments, reviews and approvals, failures, security notices)
 * and a digest for the rest. Browser is opt-in: it is immediate only for the same urgent set, and
 * only once the person turns it on and their browser permits it.
 */
const EMAIL_IMMEDIATE: ReadonlySet<NotificationType> = new Set([
  'assignment',
  'mention',
  'review_requested',
  'approval_decided',
  'integration_failure',
  'automation_failure',
  'agent_failure',
  'spend_threshold',
  'permission_changed',
  'share_changed',
  'export_ready',
]);

export function systemDefault(type: NotificationType, channel: Channel): Mode {
  if (channel === 'in_app') return 'immediate';
  if (channel === 'browser') return EMAIL_IMMEDIATE.has(type) ? 'immediate' : 'muted';
  return EMAIL_IMMEDIATE.has(type) ? 'immediate' : 'digest';
}

export interface ModeRow {
  event_type: string;
  scope_kind: NotifyScopeKind;
  scope_record_id: string | null;
  channel: PrefChannel;
  mode: Mode;
  expires_at?: Date | string | null;
}
export interface ScopeIds {
  record: string | null;
  project: string | null;
  brand: string | null;
}
export interface Resolved {
  mode: Mode;
  source:
    'record' | 'project' | 'brand' | 'workspace' | 'project_default' | 'brand_default' | 'system';
}

/** The best-matching row in one scope: an exact type beats `*`, and an exact channel beats `all`. */
function best(
  rows: readonly ModeRow[],
  type: NotificationType,
  channel: Channel,
  match: (r: ModeRow) => boolean,
  now: Date,
): ModeRow | null {
  let found: ModeRow | null = null;
  let score = -1;
  for (const r of rows) {
    if (!match(r)) continue;
    if (r.expires_at && new Date(r.expires_at).getTime() <= now.getTime()) continue;
    if (r.event_type !== '*' && r.event_type !== type) continue;
    if (r.channel !== 'all' && r.channel !== channel) continue;
    const s = (r.event_type === type ? 2 : 0) + (r.channel === channel ? 1 : 0);
    if (s > score) {
      found = r;
      score = s;
    }
  }
  return found;
}

/**
 * Resolves one delivery mode: the person's own rows from the most specific scope outward (record,
 * project, brand, workspace), then the project's and the brand's administrator defaults, then the
 * system default. A more specific scope always wins, whatever its mode; an expired row is ignored.
 */
export function resolveMode(
  type: NotificationType,
  channel: Channel,
  scopes: ScopeIds,
  prefs: readonly ModeRow[],
  defaults: readonly ModeRow[],
  now: Date,
): Resolved {
  const levels: Array<['record' | 'project' | 'brand', string | null]> = [
    ['record', scopes.record],
    ['project', scopes.project],
    ['brand', scopes.brand],
  ];
  for (const [kind, id] of levels) {
    if (!id) continue;
    const r = best(
      prefs,
      type,
      channel,
      (x) => x.scope_kind === kind && x.scope_record_id === id,
      now,
    );
    if (r) return { mode: r.mode, source: kind };
  }
  const ws = best(prefs, type, channel, (x) => x.scope_kind === 'workspace', now);
  if (ws) return { mode: ws.mode, source: 'workspace' };
  for (const [kind, id] of [
    ['project', scopes.project],
    ['brand', scopes.brand],
  ] as const) {
    if (!id) continue;
    const d = best(
      defaults,
      type,
      channel,
      (x) => x.scope_kind === kind && x.scope_record_id === id,
      now,
    );
    if (d)
      return { mode: d.mode, source: kind === 'project' ? 'project_default' : 'brand_default' };
  }
  return { mode: systemDefault(type, channel), source: 'system' };
}

// -------------------------------------------------------------------------------------------
// Quiet hours and digest slots
// -------------------------------------------------------------------------------------------

/** Minutes since local midnight in `tz`. */
export function localMinutes(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const h = Number(parts.find((p) => p.type === 'hour')!.value);
  const m = Number(parts.find((p) => p.type === 'minute')!.value);
  return h * 60 + m;
}

/** Whether `minute` falls in the window `[start, end)`, which may wrap past midnight. */
export function inQuietWindow(start: number | null, end: number | null, minute: number): boolean {
  if (start === null || end === null) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/**
 * When the current quiet window ends (null: not in quiet hours). Computed from the local clock, so
 * a DST change inside the window can move the instant by an hour; the delivery sweep re-checks
 * quiet hours when it runs and defers again if needed.
 */
export function quietEndsAt(
  now: Date,
  tz: string,
  start: number | null,
  end: number | null,
): Date | null {
  if (start === null || end === null) return null;
  const minute = localMinutes(now, tz);
  if (!inQuietWindow(start, end, minute)) return null;
  const wait = (end - minute + 1440) % 1440 || 1440;
  const seconds = now.getUTCSeconds();
  return new Date(now.getTime() + wait * 60_000 - seconds * 1000 - now.getUTCMilliseconds());
}

export interface DigestProfile {
  digest_cadence: 'off' | 'daily' | 'weekly';
  daily_digest_minute: number;
  weekly_digest_weekday: number;
  weekly_digest_minute: number;
}
export interface DigestSlot {
  kind: 'daily' | 'weekly';
  /** The slot's local date as UTC midnight: the deterministic key of the digest. */
  start: Date;
  end: Date;
}

/**
 * The digest slot that is due now in the person's zone, or null when digests are off: the latest
 * slot whose time has passed (today's daily slot, or yesterday's before it; the latest weekly slot
 * on the chosen weekday). Catching up the latest slot after an outage is deliberate; older slots
 * are never sent late. A person chooses one cadence, so one digest carries each item.
 */
export function dueDigestSlot(profile: DigestProfile, tz: string, now: Date): DigestSlot | null {
  if (profile.digest_cadence === 'off') return null;
  const today = localDay(now, tz);
  const minute = localMinutes(now, tz);
  const at = (day: string) => new Date(`${day}T00:00:00Z`);
  if (profile.digest_cadence === 'daily') {
    const day = minute >= profile.daily_digest_minute ? today : addDays(today, -1);
    return { kind: 'daily', start: at(day), end: at(addDays(day, 1)) };
  }
  const back = (isoWeekday(today) - profile.weekly_digest_weekday + 7) % 7;
  const day =
    back === 0 && minute < profile.weekly_digest_minute
      ? addDays(today, -7)
      : addDays(today, -back);
  return { kind: 'weekly', start: at(day), end: at(addDays(day, 7)) };
}

// -------------------------------------------------------------------------------------------
// Deduplication, grouping, retry
// -------------------------------------------------------------------------------------------

/**
 * Repeats of the same kind about the same record by the same person inside one time bucket share a
 * key and collapse into one notification (NTF-011). `extra` pins a key to a day or version for
 * notices that must fire once per occasion (due soon, overdue).
 */
export function dedupeKey(
  type: NotificationType,
  recordId: string | null,
  actorId: string | null,
  now: Date,
  windowMinutes: number,
  extra: string | null = null,
): string {
  const bucket = extra ?? String(Math.floor(now.getTime() / (windowMinutes * 60_000)));
  return `${type}|${recordId ?? '-'}|${actorId ?? '-'}|${bucket}`;
}

/** The key under which low-value repeats about one record group in a list (COL-019). */
export function groupKey(type: NotificationType, recordId: string | null): string | null {
  return recordId && GROUPABLE.has(type) ? `${type}|${recordId}` : null;
}

/** Delay before attempt `attempt + 1` after `attempt` failures: doubles from `baseSeconds`, capped. */
export function retryDelayMs(attempt: number, baseSeconds: number, maxSeconds: number): number {
  const exp = Math.max(attempt - 1, 0);
  return Math.min(maxSeconds, baseSeconds * 2 ** Math.min(exp, 20)) * 1000;
}

export type FailureClass = 'transient' | 'permanent' | 'unconfigured' | 'rate_limited';

/** What happens to a delivery after a failure of this class on its `attempts`-th attempt. */
export function afterFailure(
  cls: FailureClass,
  attempts: number,
  maxAttempts: number,
): 'retry' | 'failed' | 'dead' | 'suppressed' {
  if (cls === 'unconfigured') return 'suppressed';
  if (cls === 'permanent') return 'failed';
  return attempts >= maxAttempts ? 'dead' : 'retry';
}

// -------------------------------------------------------------------------------------------
// Words
// -------------------------------------------------------------------------------------------

const PHRASES: Record<NotificationType, string> = {
  assignment: 'assigned you',
  mention: 'mentioned you',
  comment: 'commented',
  review_requested: 'asked you to review',
  approval_decided: 'decided your review',
  blocker: 'is blocked',
  due_soon: 'is due soon',
  overdue: 'is overdue',
  integration_failure: 'An integration needs attention',
  automation_failure: 'An automation needs attention',
  agent_failure: 'An agent run needs attention',
  agent_output_ready: 'An agent has output ready',
  spend_threshold: 'Usage is nearing a limit',
  permission_changed: 'Your access changed',
  share_changed: 'Sharing changed',
  briefing_ready: 'Your briefing is ready',
  export_ready: 'Your export is ready',
  hidden_dependency_affects_assignee: 'Something outside your view affects this',
};
const LABEL: Record<NotificationType, string> = {
  assignment: 'Assignment',
  mention: 'Mention',
  comment: 'Comment',
  review_requested: 'Review requested',
  approval_decided: 'Review decided',
  blocker: 'Blocked',
  due_soon: 'Due soon',
  overdue: 'Overdue',
  integration_failure: 'Integration failure',
  automation_failure: 'Automation failure',
  agent_failure: 'Agent failure',
  agent_output_ready: 'Agent output',
  spend_threshold: 'Spending limit',
  permission_changed: 'Access change',
  share_changed: 'Sharing change',
  briefing_ready: 'Briefing',
  export_ready: 'Export',
  hidden_dependency_affects_assignee: 'Dependency',
};
export const typeLabel = (t: NotificationType) => LABEL[t];

/**
 * The event as a short sentence, from facts and display names the recipient may read; nothing here
 * can carry a title or text, so a sentence never discloses more than the viewer can see. `outcome`
 * facts word review decisions.
 */
export function sentence(
  type: NotificationType,
  facts: Record<string, string | number | boolean | null>,
  actorName: string | null,
  occurrences = 1,
): string {
  const who = actorName ?? 'Someone';
  const n = occurrences > 1 ? ` (${occurrences} times)` : '';
  switch (type) {
    case 'approval_decided': {
      const o = facts.outcome;
      const verb =
        o === 'approved'
          ? 'approved'
          : o === 'changes_requested'
            ? 'asked for changes to'
            : o === 'rejected'
              ? 'rejected'
              : 'decided';
      return `${who} ${verb} your review request${n}`;
    }
    case 'review_requested':
      return facts.change === 'withdrawn'
        ? `${who} withdrew a review request${n}`
        : `${who} asked you to review${n}`;
    case 'assignment':
      return facts.delegated === true
        ? `${who} handed this over to you${n}`
        : `${who} assigned you${n}`;
    case 'comment':
      return `${who} ${facts.reply === true ? 'replied' : 'commented'}${n}`;
    case 'mention':
      return `${who} mentioned you${n}`;
    case 'blocker':
      return `This is now blocked${n}`;
    case 'due_soon':
      return facts.reminder === true ? `Your reminder is here${n}` : `This is due soon${n}`;
    case 'overdue':
      return `This is overdue${n}`;
    case 'share_changed':
      return facts.change === 'revoked'
        ? `Sharing of this was removed${n}`
        : `This was shared with you${n}`;
    case 'permission_changed':
      return facts.change === 'revoked'
        ? `Some of your access was removed${n}`
        : `You were given access${n}`;
    default:
      return `${PHRASES[type]}${n}`;
  }
}

/** The external, minimal-content line: names the brand and the kind, never a record (UXD-10). */
export function minimalLine(type: NotificationType, brandName: string | null): string {
  const where = brandName ? ` in ${brandName}` : '';
  const a = /^[aeiou]/i.test(LABEL[type]) ? 'an' : 'a';
  return `You have ${a} ${LABEL[type].toLowerCase()} notification${where}`;
}
