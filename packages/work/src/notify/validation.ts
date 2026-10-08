import { Issues } from '@pm/tenancy';
import { isObject, isPublic } from '../validation.ts';
import { validZone } from '../time/semantics.ts';
import {
  NOTIFICATION_TYPES,
  isNotificationType,
  type Mode,
  type NotificationType,
  type PrefChannel,
} from './semantics.ts';

/** Inputs of the notification platform (ADR-0024): pointer-precise issues, no echoed input. */

const unknown = (b: Record<string, unknown>, allowed: readonly string[], issues: Issues) => {
  for (const k of Object.keys(b))
    if (!allowed.includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
};

export const STATES = ['unread', 'read', 'saved', 'dismissed'] as const;
export type NotificationStateKey = (typeof STATES)[number];
export const TABS = ['all', 'mentions', 'reviews', 'saved'] as const;
export type Tab = (typeof TABS)[number];
const CHANNELS = ['all', 'in_app', 'email', 'browser'] as const;
const MODES = ['immediate', 'digest', 'muted'] as const;

/** `HH:MM` as minutes since midnight. */
export function clockMinutes(v: unknown, pointer: string, issues: Issues): number | undefined {
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
    issues.add(pointer, 'invalid_time', 'Use a time like 08:30.');
    return undefined;
  }
  return Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
}
export const clockText = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export interface ListQuery {
  tab: Tab;
  state: NotificationStateKey | null;
  type: NotificationType | null;
  brand: string | null;
  project: string | null;
  unread: boolean;
  q: string | null;
  group: boolean;
  limit: unknown;
  cursor: unknown;
}

export function parseListQuery(raw: Record<string, unknown>, qMax: number): ListQuery {
  const issues = new Issues();
  unknown(
    raw,
    ['tab', 'state', 'type', 'brand', 'project', 'unread', 'q', 'group', 'limit', 'cursor'],
    issues,
  );
  const tab = raw.tab === undefined ? 'all' : raw.tab;
  if (!(TABS as readonly unknown[]).includes(tab))
    issues.add('/tab', 'invalid_option', 'Choose a tab.');
  const state = raw.state === undefined ? null : raw.state;
  if (state !== null && !(STATES as readonly unknown[]).includes(state))
    issues.add('/state', 'invalid_option', 'Choose a state.');
  const type = raw.type === undefined ? null : raw.type;
  if (type !== null && !isNotificationType(type))
    issues.add('/type', 'invalid_option', 'Choose a type.');
  const ref = (v: unknown, prefix: string, pointer: string) => {
    if (v === undefined) return null;
    if (!isPublic(v, prefix)) {
      issues.add(pointer, 'invalid_reference', 'Choose from the list.');
      return null;
    }
    return v;
  };
  const brand = ref(raw.brand, 'br', '/brand');
  const project = ref(raw.project, 'prj', '/project');
  const flag = (v: unknown, pointer: string) => {
    if (v === undefined) return false;
    if (v === 'true' || v === true) return true;
    if (v === 'false' || v === false) return false;
    issues.add(pointer, 'invalid_option', 'Use true or false.');
    return false;
  };
  const unread = flag(raw.unread, '/unread');
  const group = flag(raw.group, '/group');
  let q: string | null = null;
  if (raw.q !== undefined) {
    if (typeof raw.q !== 'string') issues.add('/q', 'invalid_type', 'Search for text.');
    else if ([...raw.q.trim()].length > qMax)
      issues.add('/q', 'too_long', `Search for at most ${qMax} characters.`);
    else q = raw.q.trim() || null;
  }
  issues.throwIfAny();
  return {
    tab: tab as Tab,
    state: state as NotificationStateKey | null,
    type: type as NotificationType | null,
    brand,
    project,
    unread,
    q,
    group,
    limit: raw.limit,
    cursor: raw.cursor,
  };
}

export function parseStateChange(body: unknown): { state: NotificationStateKey } {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  unknown(b, ['state'], issues);
  if (!(STATES as readonly unknown[]).includes(b.state))
    issues.add('/state', 'invalid_option', 'Choose unread, read, saved, or dismissed.');
  issues.throwIfAny();
  return { state: b.state as NotificationStateKey };
}

export interface BulkInput {
  ids: string[] | null;
  all: { tab: Tab; type: NotificationType | null } | null;
  state: NotificationStateKey;
}

export function parseBulk(body: unknown, max: number): BulkInput {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  unknown(b, ['ids', 'all', 'state'], issues);
  if (!(STATES as readonly unknown[]).includes(b.state))
    issues.add('/state', 'invalid_option', 'Choose unread, read, saved, or dismissed.');
  let ids: string[] | null = null;
  if (b.ids !== undefined) {
    if (!Array.isArray(b.ids) || !b.ids.length)
      issues.add('/ids', 'required', 'Choose at least one notification.');
    else if (b.ids.length > max) issues.add('/ids', 'too_many', `Choose at most ${max} at once.`);
    else {
      ids = [...new Set(b.ids.map(String))];
      for (const [i, id] of b.ids.entries())
        if (!isPublic(id, 'ntf'))
          issues.add(`/ids/${i}`, 'invalid_reference', 'Choose from the list.');
    }
  }
  let all: BulkInput['all'] = null;
  if (b.all !== undefined) {
    const a = isObject(b.all) ? b.all : {};
    unknown(a, ['tab', 'type'], issues);
    const tab = a.tab === undefined ? 'all' : a.tab;
    if (!(TABS as readonly unknown[]).includes(tab))
      issues.add('/all/tab', 'invalid_option', 'Choose a tab.');
    if (a.type !== undefined && !isNotificationType(a.type))
      issues.add('/all/type', 'invalid_option', 'Choose a type.');
    all = { tab: tab as Tab, type: isNotificationType(a.type) ? a.type : null };
  }
  if ((ids === null) === (all === null) && !issues.list.length)
    issues.add('/', 'invalid', 'Name notifications by id, or choose all in a tab.');
  issues.throwIfAny();
  return { ids, all, state: b.state as NotificationStateKey };
}

export interface PreferenceInput {
  event_type: string;
  scope: 'workspace' | string;
  channel: PrefChannel;
  mode: Mode;
  expires_at: Date | null;
}

function parseRule(
  b: Record<string, unknown>,
  issues: Issues,
  opts: { workspaceScope: boolean },
): Omit<PreferenceInput, 'expires_at'> {
  const type = b.event_type === undefined ? '*' : b.event_type;
  if (type !== '*' && !isNotificationType(type))
    issues.add('/event_type', 'invalid_option', 'Choose a notification type.');
  let scope = String(b.scope ?? '');
  if (
    !(opts.workspaceScope && scope === 'workspace') &&
    !isPublic(scope, 'br') &&
    !isPublic(scope, 'prj') &&
    !isPublic(scope, 'tsk')
  ) {
    issues.add('/scope', 'invalid_reference', 'Choose a brand, project, or task.');
    scope = '';
  }
  if (!(CHANNELS as readonly unknown[]).includes(b.channel))
    issues.add('/channel', 'invalid_option', 'Choose a channel.');
  if (!(MODES as readonly unknown[]).includes(b.mode))
    issues.add('/mode', 'invalid_option', 'Choose immediate, digest, or muted.');
  const channel = b.channel as PrefChannel;
  const mode = b.mode as Mode;
  if (channel === 'all' && mode !== 'muted')
    issues.add('/mode', 'invalid_combination', 'All channels can only be muted.');
  if (mode === 'digest' && channel !== 'email')
    issues.add('/mode', 'invalid_combination', 'Only email can be a digest.');
  return { event_type: type as string, scope, channel, mode };
}

export function parsePreference(body: unknown, now: Date): PreferenceInput {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  unknown(b, ['event_type', 'scope', 'channel', 'mode', 'expires_at'], issues);
  const rule = parseRule(b, issues, { workspaceScope: true });
  let expires: Date | null = null;
  if (b.expires_at !== undefined && b.expires_at !== null) {
    const d = typeof b.expires_at === 'string' ? new Date(b.expires_at) : null;
    if (!d || Number.isNaN(d.getTime()))
      issues.add('/expires_at', 'invalid_date', 'Use a date and time.');
    else if (d.getTime() <= now.getTime())
      issues.add('/expires_at', 'in_the_past', 'Choose a time in the future.');
    else if (rule.mode !== 'muted')
      issues.add('/expires_at', 'invalid_combination', 'Only a mute can end.');
    else expires = d;
  }
  issues.throwIfAny();
  return { ...rule, expires_at: expires };
}

export function parsePreferenceKey(
  q: Record<string, unknown>,
): Omit<PreferenceInput, 'mode' | 'expires_at'> {
  const issues = new Issues();
  unknown(q, ['event_type', 'scope', 'channel'], issues);
  const rule = parseRule({ ...q, mode: 'muted' }, issues, { workspaceScope: true });
  issues.throwIfAny();
  return { event_type: rule.event_type, scope: rule.scope, channel: rule.channel };
}

export function parseScopeDefault(body: unknown): Omit<PreferenceInput, 'expires_at'> {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  unknown(b, ['event_type', 'channel', 'mode'], issues);
  const rule = parseRule({ ...b, scope: 'br_' + '0'.repeat(26) }, issues, {
    workspaceScope: false,
  });
  if (rule.channel === 'all')
    issues.add('/channel', 'invalid_option', 'Choose in-app, email, or browser.');
  issues.throwIfAny();
  return rule;
}

export interface ProfileInput {
  timezone?: string | null;
  quiet?: { start: number; end: number } | null;
  email_enabled?: boolean;
  browser_enabled?: boolean;
  browser_permission?: 'unknown' | 'granted' | 'denied';
  digest_cadence?: 'off' | 'daily' | 'weekly';
  daily_digest_minute?: number;
  weekly_digest_weekday?: number;
  weekly_digest_minute?: number;
}

export function parseProfile(body: unknown): ProfileInput {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  unknown(
    b,
    [
      'timezone',
      'quiet_hours',
      'email_enabled',
      'browser_enabled',
      'browser_permission',
      'digest_cadence',
      'daily_digest_time',
      'weekly_digest_day',
      'weekly_digest_time',
    ],
    issues,
  );
  const out: ProfileInput = {};
  if (b.timezone !== undefined) {
    if (b.timezone === null) out.timezone = null;
    else if (validZone(b.timezone)) out.timezone = validZone(b.timezone)!;
    else issues.add('/timezone', 'invalid_timezone', 'Choose a time zone.');
  }
  if (b.quiet_hours !== undefined) {
    if (b.quiet_hours === null) out.quiet = null;
    else if (isObject(b.quiet_hours)) {
      unknown(b.quiet_hours, ['start', 'end'], issues);
      const start = clockMinutes(b.quiet_hours.start, '/quiet_hours/start', issues);
      const end = clockMinutes(b.quiet_hours.end, '/quiet_hours/end', issues);
      if (start !== undefined && end !== undefined) {
        if (start === end)
          issues.add(
            '/quiet_hours/end',
            'invalid_range',
            'Quiet hours need different start and end times.',
          );
        else out.quiet = { start, end };
      }
    } else issues.add('/quiet_hours', 'invalid_type', 'Set a start and end, or null.');
  }
  for (const k of ['email_enabled', 'browser_enabled'] as const)
    if (b[k] !== undefined) {
      if (typeof b[k] === 'boolean') out[k] = b[k];
      else issues.add(`/${k}`, 'invalid_type', 'Use true or false.');
    }
  if (b.browser_permission !== undefined) {
    if (['unknown', 'granted', 'denied'].includes(String(b.browser_permission)))
      out.browser_permission = b.browser_permission as 'unknown' | 'granted' | 'denied';
    else issues.add('/browser_permission', 'invalid_option', 'Choose unknown, granted, or denied.');
  }
  if (b.digest_cadence !== undefined) {
    if (['off', 'daily', 'weekly'].includes(String(b.digest_cadence)))
      out.digest_cadence = b.digest_cadence as 'off' | 'daily' | 'weekly';
    else issues.add('/digest_cadence', 'invalid_option', 'Choose off, daily, or weekly.');
  }
  if (b.daily_digest_time !== undefined)
    out.daily_digest_minute = clockMinutes(b.daily_digest_time, '/daily_digest_time', issues);
  if (b.weekly_digest_time !== undefined)
    out.weekly_digest_minute = clockMinutes(b.weekly_digest_time, '/weekly_digest_time', issues);
  if (b.weekly_digest_day !== undefined) {
    if (
      typeof b.weekly_digest_day === 'number' &&
      Number.isInteger(b.weekly_digest_day) &&
      b.weekly_digest_day >= 1 &&
      b.weekly_digest_day <= 7
    )
      out.weekly_digest_weekday = b.weekly_digest_day;
    else issues.add('/weekly_digest_day', 'invalid_number', 'Use 1 (Monday) to 7 (Sunday).');
  }
  issues.throwIfAny();
  return out;
}

export function parseBrowserAck(body: unknown): { shown: boolean } {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  unknown(b, ['outcome'], issues);
  if (b.outcome !== 'shown' && b.outcome !== 'declined')
    issues.add('/outcome', 'invalid_option', 'Report shown or declined.');
  issues.throwIfAny();
  return { shown: b.outcome === 'shown' };
}

export function parseDeliveryQuery(q: Record<string, unknown>): {
  states: string[];
  channel: string | null;
} {
  const issues = new Issues();
  unknown(q, ['state', 'channel', 'limit', 'cursor'], issues);
  const all = [
    'pending',
    'deferred_quiet_hours',
    'delivered',
    'failed',
    'dead',
    'suppressed',
    'expired',
  ];
  let states = ['failed', 'dead'];
  if (q.state !== undefined) {
    const list = String(q.state).split(',');
    if (!list.length || list.some((s) => !all.includes(s)))
      issues.add('/state', 'invalid_option', 'Choose delivery states.');
    else states = list;
  }
  if (q.channel !== undefined && q.channel !== 'email' && q.channel !== 'browser')
    issues.add('/channel', 'invalid_option', 'Choose email or browser.');
  issues.throwIfAny();
  return { states, channel: (q.channel as string | undefined) ?? null };
}

export { NOTIFICATION_TYPES };
