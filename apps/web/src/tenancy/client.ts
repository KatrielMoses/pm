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
  capabilities: { configure: boolean; archive: boolean; restore: boolean; mark_sensitive: boolean };
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
