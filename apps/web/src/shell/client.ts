import type {
  NavigableRecordType,
  Preferences,
  ShellCommandId,
  ShellCommandTrigger,
  ViewKey,
  ViewStateValue,
} from '@pm/contracts/shell';
import { api } from '../api.ts';
import type { BrandSummary, Workspace } from '../tenancy/client.ts';
import { deviceKey } from './device.ts';

/** Typed client for the 1E shell API. Every identifier is a public ID. */

/** The one brand-marker shape (WSB-015): owning brand, workspace, or "no brand yet". */
export type BrandMarkerData =
  | {
      kind: 'brand';
      id: string;
      name: string;
      short_name: string | null;
      color: string;
      icon: string;
      archived: boolean;
    }
  | { kind: 'workspace' }
  | { kind: 'unbranded' };

export interface NavTarget {
  id: string;
  type: NavigableRecordType;
  label: string;
  brand: BrandMarkerData;
  lifecycle_state: 'active' | 'archived';
}

export interface RecentItem extends NavTarget {
  visited_at: string;
}

type BaseCapabilities = Workspace['capabilities'];
export interface ShellCapabilities extends BaseCapabilities {
  manage_people: boolean;
  invite_members: boolean;
  invite_guests: boolean;
  manage_teams: boolean;
  preview_access: boolean;
  configure_sharing: boolean;
  transfer_ownership: boolean;
  view_directory: boolean;
}

export type Scope =
  | { kind: 'brand'; brand_id: string }
  | { kind: 'brands'; brand_ids: string[] }
  | { kind: 'all'; brand_ids: string[] }
  | { kind: 'none' };

export interface ShellContext {
  workspace: { id: string; name: string; capabilities: ShellCapabilities };
  principal: 'member' | 'guest';
  scope: Scope;
  scope_token: string | null;
  fallback: null | 'no_selection' | 'stale_selection' | 'narrowed' | 'invalid';
  brands: BrandSummary[];
  archived_brands?: BrandSummary[];
}

export interface PreferencesData extends Preferences {
  version: number;
}

export interface ViewStateData {
  key: ViewKey;
  schema_version: number;
  state: ViewStateValue;
  version: number;
}

const enc = encodeURIComponent;
const ws = (id: string) => `/v1/workspaces/${enc(id)}`;
const device = () => ({ 'x-device-key': deviceKey() });

export const shell = {
  context: async (id: string, scope: string | null, includeArchived = true) => {
    const q = new URLSearchParams();
    if (scope) q.set('scope', scope);
    if (includeArchived) q.set('include_archived', 'true');
    return (
      await api<{ data: ShellContext }>('GET', `${ws(id)}/context?${q.toString()}`, {
        headers: device(),
      })
    ).body.data;
  },
  select: async (
    id: string,
    body:
      | { scope: 'all' }
      | { scope: 'brand'; brand_id: string }
      | { scope: 'brands'; brand_ids: string[] },
  ) =>
    (await api<{ data: ShellContext }>('POST', `${ws(id)}:select`, { body, headers: device() }))
      .body.data,

  preferences: async () =>
    (await api<{ data: PreferencesData }>('GET', '/v1/auth/preferences')).body.data,
  updatePreferences: async (patch: Partial<Preferences>, ifMatch?: number) =>
    (
      await api<{ data: PreferencesData }>('PATCH', '/v1/auth/preferences', {
        body: patch,
        headers: ifMatch !== undefined ? { 'if-match': `"${ifMatch}"` } : {},
      })
    ).body.data,

  pins: async (id: string) =>
    (await api<{ data: NavTarget[] }>('GET', `${ws(id)}/navigation/pins`)).body.data,
  favorites: async (id: string) =>
    (await api<{ data: NavTarget[] }>('GET', `${ws(id)}/favorites`)).body.data,
  addFavorite: async (id: string, target: string) =>
    (await api<{ data: { target: NavTarget } }>('PUT', `${ws(id)}/favorites/${enc(target)}`)).body
      .data.target,
  removeFavorite: async (id: string, target: string) => {
    await api('DELETE', `${ws(id)}/favorites/${enc(target)}`);
  },
  moveFavorite: async (id: string, target: string, after: string | null) =>
    (
      await api<{ data: NavTarget[] }>('POST', `${ws(id)}/favorites/${enc(target)}:move`, {
        body: { after },
      })
    ).body.data,

  recent: async (
    id: string,
    query: { limit?: number | 'sidebar'; type?: string; brand?: string } = {},
  ) => {
    const q = new URLSearchParams();
    if (query.limit !== undefined) q.set('limit', String(query.limit));
    if (query.type) q.set('type', query.type);
    if (query.brand) q.set('brand', query.brand);
    return (await api<{ data: RecentItem[] }>('GET', `${ws(id)}/recent?${q.toString()}`)).body.data;
  },
  recordVisit: async (id: string, target: string) => {
    await api('POST', `${ws(id)}/recent`, { body: { target } });
  },
  clearRecent: async (id: string) => {
    await api('POST', `${ws(id)}/recent:clear`);
  },
  removeRecent: async (id: string, target: string) => {
    await api('DELETE', `${ws(id)}/recent/${enc(target)}`);
  },

  viewState: async (id: string, key: ViewKey) =>
    (
      await api<{ data: ViewStateData }>('GET', `${ws(id)}/view-state/${enc(key)}`, {
        headers: device(),
      })
    ).body.data,
  saveViewState: async (
    id: string,
    key: ViewKey,
    body: { schema_version: number; state: ViewStateValue },
  ) =>
    (
      await api<{ data: ViewStateData }>('PUT', `${ws(id)}/view-state/${enc(key)}`, {
        body,
        headers: device(),
      })
    ).body.data,

  targets: async (id: string, q: string) =>
    (await api<{ data: NavTarget[] }>('GET', `${ws(id)}/navigation/targets?q=${enc(q)}`)).body.data,

  events: async (body: {
    commands?: Array<{ command: ShellCommandId; trigger: ShellCommandTrigger }>;
    decode_failures?: Array<{ source: 'url' | 'local'; reason: string }>;
  }) => {
    await api('POST', '/v1/shell/events', { body });
  },
};
