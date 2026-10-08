import { api, newIdempotencyKey } from '../api.ts';
import type { BrandMarkerData } from '../shell/client.ts';

/**
 * Typed client for the 4B notification API (ADR-0024). Every identifier is a public ID. Writes carry
 * an `Idempotency-Key` (a caller that may retry after an unknown outcome passes its own key, so the
 * retry replays instead of applying twice). The profile needs `If-Match`; a notification's state
 * accepts it.
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

/** The same short labels the server uses (used for filters, where the server sends none). */
export const TYPE_LABEL: Record<NotificationType, string> = {
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

export const QUERY_MAX_CHARS = 100;

export type NotificationState = 'unread' | 'read' | 'saved' | 'dismissed';
export type Tab = 'all' | 'mentions' | 'reviews' | 'saved';
export const TABS: Array<[Tab, string]> = [
  ['all', 'All'],
  ['mentions', 'Mentions'],
  ['reviews', 'Reviews'],
  ['saved', 'Saved'],
];

export interface NotificationItem {
  id: string;
  type: 'notification';
  notification_type: NotificationType;
  label: string;
  state: NotificationState;
  occurrences: number;
  group: string | null;
  group_count?: number;
  group_ids?: string[];
  created_at: string;
  last_occurred_at: string;
  version: number;
  available: boolean;
  summary: string;
  record: { id: string; type: 'task' | 'project'; title: string; archived: boolean } | null;
  brand: {
    id: string;
    name: string;
    short_name: string | null;
    icon: string;
    color: string;
  } | null;
  project: { id: string; name: string } | null;
  actor: { id: string; name: string; type: 'person' } | null;
}

export interface Page<T> {
  data: T[];
  page: { limit: number; has_more: boolean; next_cursor?: string };
}

export interface Counts {
  unread: number;
  mentions_unread: number;
  reviews_unread: number;
  saved: number;
}

export interface ListQuery {
  tab?: Tab;
  state?: NotificationState;
  type?: string;
  brand?: string;
  project?: string;
  unread?: boolean;
  q?: string;
  group?: boolean;
  limit?: number;
  cursor?: string;
}

export type BrowserPermission = 'unknown' | 'granted' | 'denied';
export type DigestCadence = 'off' | 'daily' | 'weekly';

export interface Profile {
  type: 'notification_profile';
  timezone: string | null;
  effective_timezone: string;
  quiet_hours: { start: string; end: string } | null;
  email_enabled: boolean;
  browser_enabled: boolean;
  browser_permission: BrowserPermission;
  digest_cadence: DigestCadence;
  daily_digest_time: string;
  weekly_digest_day: number;
  weekly_digest_time: string;
  version: number;
  channels: {
    in_app: { state: string };
    email: { state: 'available' | 'not_configured'; provider?: string };
    browser: { state: 'on' | 'off'; permission: BrowserPermission };
  };
}

export type ProfilePatch = Partial<
  Pick<
    Profile,
    | 'timezone'
    | 'quiet_hours'
    | 'email_enabled'
    | 'browser_enabled'
    | 'browser_permission'
    | 'digest_cadence'
    | 'daily_digest_time'
    | 'weekly_digest_day'
    | 'weekly_digest_time'
  >
>;

export type Mode = 'immediate' | 'digest' | 'muted';
export type PrefChannel = 'all' | 'in_app' | 'email' | 'browser';

export interface Preference {
  event_type: string;
  scope: string | null;
  scope_kind: 'workspace' | 'brand' | 'project' | 'record';
  scope_name: string | null;
  channel: PrefChannel;
  mode: Mode;
  expires_at: string | null;
}
export interface DefaultRow {
  event_type: NotificationType;
  label: string;
  in_app: Mode;
  email: Mode;
  browser: Mode;
  security: boolean;
}
export interface Preferences {
  data: Preference[];
  defaults: DefaultRow[];
  limit: number;
}

export interface PendingBrowser {
  delivery: string;
  notification: string;
  title: string;
  path: string;
}

export type DeliveryState =
  | 'pending'
  | 'sending'
  | 'delivered'
  | 'failed'
  | 'dead'
  | 'suppressed'
  | 'deferred_quiet_hours'
  | 'expired';

export interface Delivery {
  id: string;
  type: 'notification_delivery';
  channel: 'email' | 'browser' | 'in_app';
  kind: 'notification' | 'digest';
  state: DeliveryState;
  attempts: number;
  failure_class: string | null;
  failure_code: string | null;
  suppress_reason: string | null;
  notification: string | null;
  notification_type: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
  recipient?: { id: string; name: string };
}

export interface ScopeDefault {
  event_type: string;
  channel: 'in_app' | 'email' | 'browser';
  mode: Mode;
}

const w = (ws: string) => `/v1/workspaces/${ws}`;
const qs = (o: Record<string, string | number | boolean | undefined>) => {
  const e = Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== false);
  return e.length ? `?${e.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}` : '';
};

interface WriteOptions {
  ifMatch?: number | undefined;
  key?: string | undefined;
}
async function write<T>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body: unknown,
  o: WriteOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { 'idempotency-key': o.key ?? newIdempotencyKey() };
  if (o.ifMatch !== undefined) headers['if-match'] = `"${o.ifMatch}"`;
  return (await api<{ data: T }>(method, path, { body, headers })).body.data;
}

/** A change other parts of the page (the bell) should react to. */
export const NOTIFICATIONS_CHANGED = 'pm:notifications-changed';
export const PROFILE_CHANGED = 'pm:notification-profile-changed';
export const announceNotificationsChanged = () =>
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
export const announceProfileChanged = () => window.dispatchEvent(new Event(PROFILE_CHANGED));

export const markerOf = (b: NonNullable<NotificationItem['brand']>): BrandMarkerData => ({
  kind: 'brand',
  id: b.id,
  name: b.name,
  short_name: b.short_name,
  color: b.color,
  icon: b.icon,
  archived: false,
});

export const notifications = {
  // ---- The person's notifications ----------------------------------------------------------
  async list(ws: string, q: ListQuery = {}, signal?: AbortSignal) {
    return (
      await api<Page<NotificationItem>>(
        'GET',
        `${w(ws)}/me/notifications${qs({ ...q, unread: q.unread || undefined, group: q.group || undefined })}`,
        signal ? { signal } : {},
      )
    ).body;
  },
  async counts(ws: string) {
    return (await api<{ data: Counts }>('GET', `${w(ws)}/me/notifications/counts`)).body.data;
  },
  async get(ws: string, ntf: string) {
    return (await api<{ data: NotificationItem }>('GET', `${w(ws)}/me/notifications/${ntf}`)).body
      .data;
  },
  async setState(ws: string, ntf: string, state: NotificationState, o: WriteOptions = {}) {
    return write<NotificationItem>('PATCH', `${w(ws)}/me/notifications/${ntf}`, { state }, o);
  },
  async bulk(
    ws: string,
    body: { ids: string[] } | { all: { tab: Tab; type?: string } },
    state: NotificationState,
    o: WriteOptions = {},
  ) {
    return write<{ updated: number }>(
      'POST',
      `${w(ws)}/me/notification-bulk`,
      { ...body, state },
      o,
    );
  },

  // ---- Profile and preferences -------------------------------------------------------------
  async profile(ws: string) {
    return (await api<{ data: Profile }>('GET', `${w(ws)}/me/notification-profile`)).body.data;
  },
  async saveProfile(ws: string, patch: ProfilePatch, version: number, key?: string) {
    return write<Profile>('PUT', `${w(ws)}/me/notification-profile`, patch, {
      ifMatch: version,
      key,
    });
  },
  async preferences(ws: string) {
    return (await api<Preferences>('GET', `${w(ws)}/me/notification-preferences`)).body;
  },
  async setPreference(
    ws: string,
    body: {
      event_type: string;
      scope: string;
      channel: PrefChannel;
      mode: Mode;
      expires_at?: string;
    },
  ) {
    return write<unknown>('PUT', `${w(ws)}/me/notification-preferences`, body);
  },
  async removePreference(
    ws: string,
    key: { event_type: string; scope: string; channel: PrefChannel },
  ) {
    return write<unknown>(
      'DELETE',
      `${w(ws)}/me/notification-preferences${qs({ event_type: key.event_type, scope: key.scope, channel: key.channel })}`,
      {},
    );
  },

  // ---- Browser notifications ---------------------------------------------------------------
  async browserPending(ws: string) {
    return (
      await api<{ data: PendingBrowser[] }>('GET', `${w(ws)}/me/notifications/browser-pending`)
    ).body.data;
  },
  async ack(ws: string, ndl: string, outcome: 'shown' | 'declined') {
    return write<unknown>('POST', `${w(ws)}/me/notification-deliveries/${ndl}/ack`, { outcome });
  },

  // ---- Deliveries --------------------------------------------------------------------------
  async myDeliveries(ws: string, o: { cursor?: string; limit?: number } = {}) {
    return (
      await api<Page<Delivery>>(
        'GET',
        `${w(ws)}/me/notification-deliveries${qs({ limit: 10, ...o })}`,
      )
    ).body;
  },
  async health(ws: string, o: { cursor?: string; limit?: number } = {}) {
    return (
      await api<Page<Delivery> & { email: 'configured' | 'capture' | 'unconfigured' }>(
        'GET',
        `${w(ws)}/notification-deliveries${qs({ limit: 10, ...o })}`,
      )
    ).body;
  },
  async retry(ws: string, ndl: string) {
    return write<{ id: string; state: string }>(
      'POST',
      `${w(ws)}/notification-deliveries/${ndl}/retry`,
      {},
    );
  },

  // ---- Defaults for a brand or project ------------------------------------------------------
  async scopeDefaults(ws: string, kind: 'brands' | 'projects', id: string) {
    return (
      await api<{ data: ScopeDefault[] }>('GET', `${w(ws)}/${kind}/${id}/notification-defaults`)
    ).body.data;
  },
  async setScopeDefault(ws: string, kind: 'brands' | 'projects', id: string, body: ScopeDefault) {
    return write<unknown>('PUT', `${w(ws)}/${kind}/${id}/notification-defaults`, body);
  },
  async removeScopeDefault(
    ws: string,
    kind: 'brands' | 'projects',
    id: string,
    key: { event_type: string; channel: string },
  ) {
    return write<unknown>(
      'DELETE',
      `${w(ws)}/${kind}/${id}/notification-defaults${qs({ event_type: key.event_type, channel: key.channel })}`,
      {},
    );
  },
};
