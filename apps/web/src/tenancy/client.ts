import { api, protectedRequest, type StepUpResolver } from '../api.ts';

/** Typed client for the 1C tenancy API. Every identifier is a public ID. */

export interface WorkspaceSummary {
  id: string;
  type: 'workspace';
  name: string;
  selected: boolean;
}

export interface Workspace {
  id: string;
  type: 'workspace';
  name: string;
  logo_file_ref: string | null;
  timezone: string;
  locale: string;
  currency: string;
  week_start: number;
  state: string;
  version: number;
  capabilities: { configure: boolean; create_brand: boolean };
}

/** The 0B brand operational-status vocabulary (ADR-19); the Phase 0 validator checks this list. */
export const OPERATIONAL_STATUSES = ['operating', 'paused', 'planned'] as const;
export type OperationalStatus = (typeof OPERATIONAL_STATUSES)[number];

export interface Brand {
  id: string;
  type: 'brand';
  name: string;
  short_name: string | null;
  color: string;
  icon: string;
  description: string | null;
  operational_status: OperationalStatus;
  timezone: string;
  is_sensitive: boolean;
  notification_content_mode: 'standard' | 'minimal';
  lifecycle_state: 'active' | 'archived';
  version: number;
  capabilities: {
    configure: boolean;
    archive: boolean;
    restore: boolean;
    mark_sensitive: boolean;
    grant_access?: boolean;
  };
}

export interface BrandSummary {
  id: string;
  name: string;
  short_name: string | null;
  color: string;
  icon: string;
  is_sensitive: boolean;
}

export interface WorkspaceContext {
  workspace: { id: string; name: string; capabilities: Workspace['capabilities'] };
  scope:
    { kind: 'brand'; brand_id: string } | { kind: 'all'; brand_ids: string[] } | { kind: 'none' };
  fallback: null | 'no_selection' | 'stale_selection';
  brands: BrandSummary[];
  archived_brands?: BrandSummary[];
}

export interface WorkingHours {
  schema_version: 1;
  days: Array<{ weekday: number; ranges: Array<{ start: string; end: string }> }>;
}
export interface Priorities {
  schema_version: 1;
  entries: Array<{ kind: 'goal' | 'priority'; text: string }>;
}
export interface CalendarSettings {
  schema_version: 1;
  week_start: number | null;
  show_weekends: boolean;
  default_view: 'week' | 'month' | 'agenda';
  label: string | null;
}
export interface BrandSettings {
  id: string;
  type: 'brand_settings';
  timezone: string;
  working_hours: WorkingHours;
  calendar: CalendarSettings;
  priorities: Priorities;
  version: number;
}

export const BRAND_ICONS = [
  'circle',
  'square',
  'triangle',
  'diamond',
  'star',
  'bolt',
  'leaf',
  'globe',
  'briefcase',
  'rocket',
  'heart',
  'book',
] as const;

export const ICON_GLYPH: Record<string, string> = {
  circle: '●',
  square: '■',
  triangle: '▲',
  diamond: '◆',
  star: '★',
  bolt: 'ϟ',
  leaf: '❦',
  globe: '◍',
  briefcase: '▣',
  rocket: '➶',
  heart: '♥',
  book: '▤',
};

const enc = encodeURIComponent;
const ws = (id: string) => `/v1/workspaces/${enc(id)}`;
const br = (w: string, b: string) => `${ws(w)}/brands/${enc(b)}`;

export const tenancy = {
  listWorkspaces: async () =>
    (await api<{ data: WorkspaceSummary[] }>('GET', '/v1/workspaces')).body.data,
  createWorkspace: async (body: unknown, stepUp: StepUpResolver) =>
    (
      await protectedRequest<{ data: Workspace & { first_brand: Brand | null } }>(
        'POST',
        '/v1/workspaces',
        body,
        stepUp,
      )
    ).body.data,
  getWorkspace: async (id: string) => (await api<{ data: Workspace }>('GET', ws(id))).body.data,
  updateWorkspace: async (id: string, body: unknown, stepUp: StepUpResolver) =>
    (await protectedRequest<{ data: Workspace }>('PATCH', ws(id), body, stepUp)).body.data,
  context: async (id: string, includeArchived = false) =>
    (
      await api<{ data: WorkspaceContext }>(
        'GET',
        `${ws(id)}/context${includeArchived ? '?include_archived=true' : ''}`,
      )
    ).body.data,
  select: async (id: string, body: { scope?: 'brand' | 'all'; brand_id?: string }) =>
    (await api<{ data: WorkspaceContext }>('POST', `${ws(id)}:select`, { body })).body.data,
  listBrands: async (id: string, state: 'active' | 'archived', cursor?: string) =>
    (
      await api<{
        data: Brand[];
        page: { has_more: boolean; next_cursor?: string; total?: { value: number } };
      }>(
        'GET',
        `${ws(id)}/brands?state=${state}&include_total=true${cursor ? `&cursor=${enc(cursor)}` : ''}`,
      )
    ).body,
  getBrand: async (w: string, b: string) => (await api<{ data: Brand }>('GET', br(w, b))).body.data,
  createBrand: async (w: string, body: unknown, stepUp: StepUpResolver) =>
    (await protectedRequest<{ data: Brand }>('POST', `${ws(w)}/brands`, body, stepUp)).body.data,
  updateBrand: async (w: string, b: string, body: unknown, stepUp: StepUpResolver) =>
    (await protectedRequest<{ data: Brand }>('PATCH', br(w, b), body, stepUp)).body.data,
  archive: async (w: string, b: string, version: number, stepUp: StepUpResolver) =>
    (
      await protectedRequest<{ data: Brand }>('POST', `${br(w, b)}:archive`, {}, stepUp, {
        ifMatch: version,
      })
    ).body.data,
  restore: async (w: string, b: string, version: number, stepUp: StepUpResolver) =>
    (
      await protectedRequest<{ data: Brand }>('POST', `${br(w, b)}:restore`, {}, stepUp, {
        ifMatch: version,
      })
    ).body.data,
  setSensitivity: async (
    w: string,
    b: string,
    value: boolean,
    version: number,
    stepUp: StepUpResolver,
  ) =>
    (
      await protectedRequest<{ data: Brand }>(
        'POST',
        `${br(w, b)}:set-sensitivity`,
        { is_sensitive: value },
        stepUp,
        {
          ifMatch: version,
        },
      )
    ).body.data,
  getSettings: async (w: string, b: string) =>
    (await api<{ data: BrandSettings }>('GET', `${br(w, b)}/settings`)).body.data,
  putSettings: async (
    w: string,
    b: string,
    ns: 'working-hours' | 'calendar' | 'priorities',
    body: unknown,
    version: number,
    stepUp: StepUpResolver,
  ) =>
    (
      await protectedRequest<{ data: BrandSettings }>(
        'PUT',
        `${br(w, b)}/settings/${ns}`,
        body,
        stepUp,
        {
          ifMatch: version,
        },
      )
    ).body.data,
};

/** Builds a 0D field-merge request from the values the form loaded and the values it now holds. */
export function mergeRequest<T extends Record<string, unknown>>(
  version: number,
  base: T,
  next: Partial<T>,
): { version: number; changes: Record<string, { base: unknown; value: unknown }> } {
  const changes: Record<string, { base: unknown; value: unknown }> = {};
  for (const [k, v] of Object.entries(next))
    if (JSON.stringify(base[k] ?? null) !== JSON.stringify(v ?? null))
      changes[k] = { base: base[k] ?? null, value: v ?? null };
  return { version, changes };
}

/** Browser-derived defaults for a new workspace; all remain editable before submission. */
export function browserDefaults(): {
  timezone: string;
  locale: string;
  currency: string;
  week_start: number;
} {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let locale = 'en';
  try {
    locale = Intl.getCanonicalLocales(navigator.language || 'en')[0] ?? 'en';
  } catch {
    // keep default
  }
  const region = locale.split('-')[1];
  const byRegion: Record<string, string> = {
    US: 'USD',
    GB: 'GBP',
    IN: 'INR',
    JP: 'JPY',
    CA: 'CAD',
    AU: 'AUD',
    BR: 'BRL',
    MX: 'MXN',
    CH: 'CHF',
    CN: 'CNY',
    DE: 'EUR',
    FR: 'EUR',
    ES: 'EUR',
    IT: 'EUR',
    NL: 'EUR',
    PT: 'EUR',
    IE: 'EUR',
    BE: 'EUR',
    AT: 'EUR',
    FI: 'EUR',
  };
  const currency = (region && byRegion[region]) || 'USD';
  const week_start =
    region === 'US' || region === 'CA' || region === 'JP' || region === 'BR' ? 7 : 1;
  return { timezone, locale, currency, week_start };
}

export const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

export function timeZones(): string[] {
  try {
    const list = Intl.supportedValuesOf('timeZone');
    return list.includes('UTC') ? list : ['UTC', ...list];
  } catch {
    return ['UTC'];
  }
}

export function currencies(): string[] {
  try {
    return Intl.supportedValuesOf('currency');
  } catch {
    return ['USD', 'EUR', 'GBP'];
  }
}

// -------------------------------------------------------------------------------------------
// Collaboration (1D)
// -------------------------------------------------------------------------------------------

export type RoleKey =
  'owner' | 'administrator' | 'member' | 'limited_member' | 'read_only' | 'guest';
export const ROLE_LABEL: Record<RoleKey, string> = {
  owner: 'Owner',
  administrator: 'Administrator',
  member: 'Member',
  limited_member: 'Limited member',
  read_only: 'Read-only',
  guest: 'Guest',
};
export const ROLE_HELP: Record<RoleKey, string> = {
  owner: 'Full control, including ownership transfer and workspace deletion.',
  administrator: 'Manages the workspace, people, and every non-sensitive brand.',
  member: 'Sees workspace-wide items and the brands they are given access to.',
  limited_member: 'Sees only the brands and items they are given access to.',
  read_only: 'Can view what they have access to, but cannot change anything.',
  guest: 'Sees only specific items shared with them. No people list or brands.',
};
export const LEVEL_LABEL: Record<string, string> = {
  view: 'View',
  comment: 'Comment',
  edit: 'Edit',
  manage: 'Manage',
};

export interface Member {
  id: string;
  type: 'membership';
  display_name: string;
  email: string | null;
  kind: 'member' | 'guest';
  role: RoleKey | null;
  state: 'invited' | 'active' | 'suspended' | 'removed';
  joined_at: string | null;
  is_you: boolean;
  version: number;
  teams: string[];
  capabilities: { change_role: boolean; suspend: boolean; reactivate: boolean; remove: boolean };
}

export interface Invitation {
  id: string;
  type: 'invitation';
  email: string;
  kind: 'member' | 'guest';
  role: RoleKey | null;
  state: 'pending' | 'accepted' | 'revoked' | 'expired';
  expires_at: string;
  send_count: number;
  brands: Array<{ id: string; name: string | null; level: string }>;
  records: Array<{ id: string; level: string }>;
}

export interface ExposureDiff {
  brands: Array<{
    brand: { id: string; name: string };
    before: string | null;
    after: string | null;
  }>;
  records_gained: Record<string, number>;
  records_lost: Record<string, number>;
  capabilities_gained: string[];
  capabilities_lost: string[];
  affected_members: number;
  increases_access: boolean;
}

export type Change =
  | { kind: 'role'; member: string; role: RoleKey }
  | { kind: 'suspend' | 'remove'; member: string }
  | {
      kind: 'brand_grant';
      brand: string;
      principal: string;
      level: string;
      expires_at: string | null;
    }
  | { kind: 'brand_revoke'; brand: string; principal: string }
  | { kind: 'team_add' | 'team_remove'; team: string; member: string };

export interface Explanation {
  member: Member;
  explanation: {
    kind: string;
    role: RoleKey | null;
    role_cap: string | null;
    workspace_level: string | null;
    brands: Array<{
      brand: { id: string; name: string; is_sensitive: boolean };
      level: string | null;
      sources: Array<{
        via: 'implicit' | 'direct' | 'team';
        level: string;
        team: string | null;
        expires_at: string | null;
      }>;
    }>;
    capabilities: Record<string, boolean>;
  };
  shares: Array<{
    record: { id: string; type: string };
    level: string;
    via: string;
    expires_at: string | null;
  }>;
}

export interface Team {
  id: string;
  type: 'team';
  name: string;
  description: string | null;
  lifecycle_state: 'active' | 'archived';
  version: number;
  members: Array<{ id: string; display_name: string }>;
  brand_access: Array<{
    brand: { id: string; name: string };
    level: string;
    expires_at: string | null;
  }>;
  capabilities: { manage: boolean };
}

export interface BrandAccess {
  brand: { id: string; name: string; is_sensitive: boolean };
  implicit: 'none' | 'owners_and_administrators';
  grants: Array<{
    principal: { type: 'membership' | 'team'; id: string; name: string };
    level: string;
    expires_at: string | null;
    source: string;
  }>;
}

export interface OwnershipTransfer {
  id: string;
  from: { id: string; display_name: string };
  to: { id: string; display_name: string };
  demote_previous: boolean;
  expires_at: string;
  capabilities: { accept: boolean; cancel: boolean };
}

export type PolicySettings = Record<string, { value: unknown; editable: boolean }>;

export const collab = {
  people: async (w: string, q: { state?: string; q?: string } = {}) => {
    const params = new URLSearchParams(
      Object.entries(q).filter(([, v]) => v) as Array<[string, string]>,
    );
    return (
      await api<{ data: Member[] }>('GET', `${ws(w)}/people${params.size ? `?${params}` : ''}`)
    ).body.data;
  },
  explanation: async (w: string, m: string) =>
    (await api<{ data: Explanation }>('GET', `${ws(w)}/people/${enc(m)}/access`)).body.data,
  departurePlan: async (w: string, m: string) =>
    (
      await api<{
        data: { items: Array<{ hook: string; owned: number; requiresAssignee: boolean }> };
      }>('GET', `${ws(w)}/people/${enc(m)}/departure-plan`)
    ).body.data.items,
  preview: async (w: string, change: Change) =>
    (
      await api<{ data: { diff: ExposureDiff; preview_token: string } }>(
        'POST',
        `${ws(w)}/access:preview`,
        { body: { change } },
      )
    ).body.data,
  apply: async (w: string, change: Change, previewToken: string, stepUp: StepUpResolver) =>
    (
      await protectedRequest<{ data: { applied: string } }>(
        'POST',
        `${ws(w)}/access:apply`,
        { change, preview_token: previewToken },
        stepUp,
      )
    ).body.data,
  remove: async (
    w: string,
    m: string,
    previewToken: string,
    reassignTo: string | null,
    stepUp: StepUpResolver,
  ) =>
    (
      await protectedRequest<{ data: Member }>(
        'POST',
        `${ws(w)}/people/${enc(m)}:remove`,
        { preview_token: previewToken, ...(reassignTo ? { reassign_to: reassignTo } : {}) },
        stepUp,
      )
    ).body.data,
  reactivate: async (w: string, m: string, stepUp: StepUpResolver) =>
    (
      await protectedRequest<{ data: Member }>(
        'POST',
        `${ws(w)}/people/${enc(m)}:reactivate`,
        {},
        stepUp,
      )
    ).body.data,
  leave: async (w: string, reassignTo: string | null, stepUp: StepUpResolver) =>
    (
      await protectedRequest<{ data: unknown }>(
        'POST',
        `${ws(w)}:leave`,
        reassignTo ? { reassign_to: reassignTo } : {},
        stepUp,
      )
    ).body.data,
  invitations: async (w: string) =>
    (await api<{ data: Invitation[] }>('GET', `${ws(w)}/invitations`)).body.data,
  invite: async (w: string, body: unknown, stepUp: StepUpResolver) =>
    (await protectedRequest<{ data: Invitation }>('POST', `${ws(w)}/invitations`, body, stepUp))
      .body.data,
  resend: async (w: string, i: string, stepUp: StepUpResolver) =>
    (
      await protectedRequest<{ data: Invitation }>(
        'POST',
        `${ws(w)}/invitations/${enc(i)}:resend`,
        {},
        stepUp,
      )
    ).body.data,
  revokeInvitation: async (w: string, i: string, stepUp: StepUpResolver) =>
    (
      await protectedRequest<{ data: Invitation }>(
        'POST',
        `${ws(w)}/invitations/${enc(i)}:revoke`,
        {},
        stepUp,
      )
    ).body.data,
  inspect: async (token: string) =>
    (
      await api<{
        data: {
          status: 'ready' | 'email_mismatch';
          workspace_name?: string;
          inviter?: string;
          kind?: string;
          role?: RoleKey | null;
          expires_at?: string;
        };
      }>('POST', '/v1/invitations:inspect', { body: { token } })
    ).body.data,
  accept: async (token: string, stepUp: StepUpResolver) =>
    (
      await protectedRequest<{ data: { workspace: { id: string; name: string }; status: string } }>(
        'POST',
        '/v1/invitations:accept',
        { token },
        stepUp,
      )
    ).body.data,
  teams: async (w: string, state: 'active' | 'archived' = 'active') =>
    (await api<{ data: Team[] }>('GET', `${ws(w)}/teams?state=${state}`)).body.data,
  team: async (w: string, t: string) =>
    (await api<{ data: Team }>('GET', `${ws(w)}/teams/${enc(t)}`)).body.data,
  createTeam: async (w: string, body: unknown, stepUp: StepUpResolver) =>
    (await protectedRequest<{ data: Team }>('POST', `${ws(w)}/teams`, body, stepUp)).body.data,
  archiveTeam: async (w: string, t: string, archived: boolean, stepUp: StepUpResolver) =>
    (
      await protectedRequest<{ data: Team }>(
        'POST',
        `${ws(w)}/teams/${enc(t)}:${archived ? 'archive' : 'restore'}`,
        {},
        stepUp,
      )
    ).body.data,
  brandAccess: async (w: string, b: string) =>
    (await api<{ data: BrandAccess }>('GET', `${ws(w)}/brands/${enc(b)}/access`)).body.data,
  shared: async (w: string) =>
    (
      await api<{
        data: Array<{
          id: string;
          type: string;
          brand: { name: string; icon: string; color: string } | null;
        }>;
      }>('GET', `${ws(w)}/shared`)
    ).body.data,
  policy: async (w: string) =>
    (await api<{ data: { settings: PolicySettings } }>('GET', `${ws(w)}/policy`)).body.data
      .settings,
  updatePolicy: async (
    w: string,
    changes: Record<string, unknown>,
    confirm: boolean,
    stepUp: StepUpResolver,
  ) =>
    (
      await protectedRequest<{ data: { settings: PolicySettings } }>(
        'PATCH',
        `${ws(w)}/policy`,
        { changes, confirm_exposure: confirm },
        stepUp,
      )
    ).body.data.settings,
  transfer: async (w: string) =>
    (
      await api<{ data: { transfer: OwnershipTransfer | null } }>(
        'GET',
        `${ws(w)}/ownership-transfer`,
      )
    ).body.data.transfer,
  requestTransfer: async (w: string, to: string, demotePrevious: boolean, stepUp: StepUpResolver) =>
    (
      await protectedRequest<{ data: OwnershipTransfer }>(
        'POST',
        `${ws(w)}/ownership-transfer`,
        { to, demote_previous: demotePrevious },
        stepUp,
      )
    ).body.data,
  acceptTransfer: async (w: string, t: string, stepUp: StepUpResolver) =>
    (
      await protectedRequest<{ data: unknown }>(
        'POST',
        `${ws(w)}/ownership-transfer/${enc(t)}:accept`,
        {},
        stepUp,
      )
    ).body.data,
  cancelTransfer: async (w: string, t: string, stepUp: StepUpResolver) =>
    (
      await protectedRequest<{ data: unknown }>(
        'POST',
        `${ws(w)}/ownership-transfer/${enc(t)}:cancel`,
        {},
        stepUp,
      )
    ).body.data,
};

/** Pending invitation token kept across sign-in/registration (session storage; never the URL). */
export const pendingInvitation = {
  key: 'pm.pending-invitation',
  set(token: string) {
    try {
      sessionStorage.setItem(this.key, token);
    } catch {
      // storage unavailable: the recipient can reopen the link
    }
  },
  get(): string | null {
    try {
      return sessionStorage.getItem(this.key);
    } catch {
      return null;
    }
  },
  clear() {
    try {
      sessionStorage.removeItem(this.key);
    } catch {
      // ignore
    }
  },
};
