/**
 * Phase 1E shell contracts shared by the API and the browser app (browser-safe: no Node imports
 * and no generated registry import). The 0E sources are docs/ux/02 (IA) and 04 (RS); the
 * decisions are in docs/engineering/adr/0012-application-shell-navigation.md.
 *
 * Everything here is bounded and allow-listed: destinations, command identifiers (the only values
 * the `shell.commands` metric accepts), view-state fields, and scope tokens. Decoders build fresh
 * objects from allow-listed keys only, so stored or URL state can never inject prototype keys.
 */

/** IA-01 primary destinations, in their fixed order. */
export const SHELL_DESTINATIONS = [
  'home',
  'today',
  'inbox',
  'my_work',
  'projects',
  'calendar',
  'knowledge',
  'goals',
  'reports',
] as const;
export type ShellDestination = (typeof SHELL_DESTINATIONS)[number];

/** Destinations whose content belongs to a later phase (rendered as honest unavailable states). */
export const DESTINATION_PHASE: Readonly<Record<ShellDestination, string | null>> = {
  home: null,
  today: '3C',
  inbox: '2E',
  my_work: '3B',
  projects: null,
  calendar: '3B',
  knowledge: '4C',
  goals: '5B',
  reports: '5D',
};

/** Start pages a person may choose (IA-04); `shared` is the guest home. */
export const START_DESTINATIONS = [...SHELL_DESTINATIONS, 'shared'] as const;
export type StartDestination = (typeof START_DESTINATIONS)[number];

/** UXD-20: destinations may be hidden (never reordered); Home always stays. */
export const HIDEABLE_DESTINATIONS = SHELL_DESTINATIONS.filter((d) => d !== 'home');

/** Typed personal preferences (0B `account_preference`). Values are the only accepted ones. */
export const PREFERENCE_VALUES = {
  theme: ['system', 'light', 'dark'],
  density: ['comfortable', 'compact'],
  motion: ['system', 'reduce'],
  shortcuts: ['auto', 'on', 'off'],
  record_open: ['panel', 'full_page'],
} as const;
export type PreferenceKey = keyof typeof PREFERENCE_VALUES;

export interface Preferences {
  theme: (typeof PREFERENCE_VALUES.theme)[number];
  density: (typeof PREFERENCE_VALUES.density)[number];
  motion: (typeof PREFERENCE_VALUES.motion)[number];
  shortcuts: (typeof PREFERENCE_VALUES.shortcuts)[number];
  record_open: (typeof PREFERENCE_VALUES.record_open)[number];
  start_destination: StartDestination | null;
  hidden_destinations: ShellDestination[];
}

/** Device-local preferences (this browser only, never synced): the sidebar's collapsed state. */
export const DEVICE_PREFERENCE_VALUES = { sidebar: ['expanded', 'collapsed'] } as const;
export type DevicePreferences = { sidebar: (typeof DEVICE_PREFERENCE_VALUES.sidebar)[number] };

/**
 * The one personal-preference contract and where each field lives (RS-20–22): `account` values are
 * server-synced across devices (0B `account_preference`); `device` values stay in this browser.
 */
export const PREFERENCE_STORAGE = {
  theme: 'account',
  density: 'account',
  motion: 'account',
  shortcuts: 'account',
  record_open: 'account',
  start_destination: 'account',
  hidden_destinations: 'account',
  sidebar: 'device',
} as const satisfies Record<keyof Preferences | keyof DevicePreferences, 'account' | 'device'>;

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  theme: 'system',
  density: 'comfortable',
  motion: 'system',
  shortcuts: 'auto',
  record_open: 'panel',
  start_destination: null,
  hidden_destinations: [],
});

/**
 * The fixed shell command registry: every palette command and shortcut has one stable identifier
 * from this list. `shell.commands{command}` accepts nothing else.
 */
export const SHELL_COMMAND_IDS = [
  'palette.open',
  'shortcuts.reference',
  'scope.switch',
  'theme.light',
  'theme.dark',
  'theme.system',
  'sidebar.toggle',
  'focus.next_region',
  'focus.previous_region',
  'go.home',
  'go.today',
  'go.inbox',
  'go.my_work',
  'go.projects',
  'go.calendar',
  'go.knowledge',
  'go.goals',
  'go.reports',
  'go.shared',
  'go.recent',
  'go.people',
  'go.teams',
  'go.workspace_settings',
  'go.access_settings',
  'go.preferences',
  'go.account_security',
  'go.workspaces',
  'brand.create',
  'people.invite',
  'team.create',
  'favorite.toggle',
  'project.create',
] as const;
export type ShellCommandId = (typeof SHELL_COMMAND_IDS)[number];
export const SHELL_COMMAND_TRIGGERS = ['palette', 'shortcut'] as const;
export type ShellCommandTrigger = (typeof SHELL_COMMAND_TRIGGERS)[number];

/** Record types the shell can navigate to today (palette records, favorites, recents). */
export const NAVIGABLE_RECORD_TYPES = ['brand', 'team', 'project', 'task'] as const;
export type NavigableRecordType = (typeof NAVIGABLE_RECORD_TYPES)[number];

// -----------------------------------------------------------------------------------------------
// Public identifiers (0B §2.2) without importing the generated registry
// -----------------------------------------------------------------------------------------------
const ID_BODY = '[0-9A-HJKMNP-TV-Z]{26}';
export const SHELL_ID_PREFIXES = {
  brand: 'br',
  team: 'team',
  membership: 'mem',
  project: 'prj',
} as const;

export function isShellPublicId(value: unknown, prefixes: readonly string[]): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const sep = value.indexOf('_');
  if (sep < 2 || !prefixes.includes(value.slice(0, sep))) return false;
  return new RegExp(`^${ID_BODY}$`).test(value.slice(sep + 1));
}

// -----------------------------------------------------------------------------------------------
// Scope tokens (IA-24): `all`, `brand:{id}`, `brands:{id},{id}`
// -----------------------------------------------------------------------------------------------
export const MAX_SCOPE_BRANDS = 50;
export type ScopeToken =
  { kind: 'all' } | { kind: 'brand'; brand: string } | { kind: 'brands'; brands: string[] };

/** Parses a URL or stored scope token. Anything malformed is `null` (the caller normalizes). */
export function parseScopeToken(raw: unknown): ScopeToken | null {
  if (typeof raw !== 'string' || raw.length > 64 + MAX_SCOPE_BRANDS * 30) return null;
  if (raw === 'all') return { kind: 'all' };
  const colon = raw.indexOf(':');
  if (colon < 0) return null;
  const kind = raw.slice(0, colon);
  const rest = raw.slice(colon + 1);
  if (kind === 'brand')
    return isShellPublicId(rest, [SHELL_ID_PREFIXES.brand]) ? { kind: 'brand', brand: rest } : null;
  if (kind !== 'brands') return null;
  const ids = rest.split(',');
  if (ids.length < 1 || ids.length > MAX_SCOPE_BRANDS) return null;
  if (!ids.every((id) => isShellPublicId(id, [SHELL_ID_PREFIXES.brand]))) return null;
  const unique = [...new Set(ids)].sort();
  return unique.length === 1
    ? { kind: 'brand', brand: unique[0]! }
    : { kind: 'brands', brands: unique };
}

export function formatScopeToken(scope: ScopeToken): string {
  if (scope.kind === 'all') return 'all';
  if (scope.kind === 'brand') return `brand:${scope.brand}`;
  return `brands:${[...scope.brands].sort().join(',')}`;
}

// -----------------------------------------------------------------------------------------------
// View state (RS-20): registered views, allow-listed fields, versioned decoding
// -----------------------------------------------------------------------------------------------
export type ViewFieldSpec =
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'enums'; values: readonly string[]; max: number }
  | { kind: 'text'; max: number }
  | { kind: 'id'; prefixes: readonly string[] }
  | { kind: 'ids'; prefixes: readonly string[]; max: number }
  | { kind: 'position'; max: number }
  | { kind: 'scope' };

/**
 * Where a field lives (RS-20 table): `url` fields are shareable query parameters; `device` fields
 * are stored per person per device (server); `session` fields live only in this tab's session.
 */
export type ViewFieldStore = 'url' | 'device' | 'session';

export interface ViewFieldDefinition {
  spec: ViewFieldSpec;
  stores: readonly ViewFieldStore[];
}

export interface ViewStateSchema {
  version: number;
  fields: Readonly<Record<string, ViewFieldDefinition>>;
}

const PEOPLE_STATES = ['active', 'suspended', 'removed'] as const;

export const VIEW_STATE_SCHEMAS = {
  /** The per-device default scope for a workspace (IA-24). */
  'shell.scope': {
    version: 1,
    fields: { scope: { spec: { kind: 'scope' }, stores: ['device'] } },
  },
  'people.list': {
    version: 1,
    fields: {
      state: { spec: { kind: 'enum', values: PEOPLE_STATES }, stores: ['url', 'device'] },
      kind: { spec: { kind: 'enum', values: ['member', 'guest'] }, stores: ['url', 'device'] },
      // Free text stays in the URL only: search input is never stored server-side.
      q: { spec: { kind: 'text', max: 100 }, stores: ['url'] },
      sort: { spec: { kind: 'enum', values: ['name', 'role'] }, stores: ['url', 'device'] },
      anchor: { spec: { kind: 'id', prefixes: ['mem'] }, stores: ['device', 'session'] },
      position: { spec: { kind: 'position', max: 10_000 }, stores: ['device', 'session'] },
    },
  },
  'recent.list': {
    version: 1,
    fields: {
      type: {
        spec: { kind: 'enum', values: NAVIGABLE_RECORD_TYPES },
        stores: ['url', 'device'],
      },
      brand: { spec: { kind: 'id', prefixes: ['br'] }, stores: ['url'] },
      // Scroll is restored by anchor item, then by its former position (RS-20).
      anchor: {
        spec: { kind: 'id', prefixes: ['br', 'team', 'prj'] },
        stores: ['device', 'session'],
      },
      position: { spec: { kind: 'position', max: 10_000 }, stores: ['device', 'session'] },
      // Selection lives only in this tab's session and is pruned to visible items.
      selected: {
        spec: { kind: 'ids', prefixes: ['br', 'team', 'prj'], max: 200 },
        stores: ['session'],
      },
    },
  },
} as const satisfies Record<string, ViewStateSchema>;
export type ViewKey = keyof typeof VIEW_STATE_SCHEMAS;
export const VIEW_KEYS = Object.keys(VIEW_STATE_SCHEMAS) as ViewKey[];

export type ViewStateValue = Record<string, string | string[]>;
export type DecodeFailure = 'malformed' | 'version' | 'too_large' | 'field' | 'unknown_view';
export type DecodeResult =
  { ok: true; state: ViewStateValue; dropped: number } | { ok: false; reason: DecodeFailure };

/** Hard upper bound for any serialized view state (the configured limit may be lower). */
export const VIEW_STATE_HARD_MAX_BYTES = 16_384;

export function isViewKey(key: unknown): key is ViewKey {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(VIEW_STATE_SCHEMAS, key);
}

function decodeField(spec: ViewFieldSpec, value: unknown): string | string[] | undefined {
  switch (spec.kind) {
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value) ? value : undefined;
    case 'enums': {
      if (!Array.isArray(value) || value.length > spec.max) return undefined;
      const out = [...new Set(value)].filter(
        (v): v is string => typeof v === 'string' && spec.values.includes(v),
      );
      return out.length === value.length ? out : undefined;
    }
    case 'text':
      return typeof value === 'string' &&
        value.length <= spec.max &&
        // eslint-disable-next-line no-control-regex
        !/[\u0000-\u001f\u007f]/.test(value)
        ? value
        : undefined;
    case 'id':
      return isShellPublicId(value, spec.prefixes) ? value : undefined;
    case 'ids': {
      if (!Array.isArray(value) || value.length > spec.max) return undefined;
      const ok = value.every((v) => isShellPublicId(v, spec.prefixes));
      return ok ? [...new Set(value as string[])] : undefined;
    }
    case 'position':
      return typeof value === 'string' && /^\d{1,6}$/.test(value) && Number(value) <= spec.max
        ? value
        : undefined;
    case 'scope': {
      const t = parseScopeToken(value);
      return t ? formatScopeToken(t) : undefined;
    }
  }
}

/**
 * Decodes view state for one store. Unknown keys and invalid values are dropped (never copied),
 * so a corrupt or hostile document degrades to defaults instead of failing the page. Size,
 * version, and shape violations reject the whole document.
 */
export function decodeViewState(
  key: unknown,
  input: unknown,
  options: { store: ViewFieldStore; version?: number; maxBytes?: number },
): DecodeResult {
  if (!isViewKey(key)) return { ok: false, reason: 'unknown_view' };
  const schema: ViewStateSchema = VIEW_STATE_SCHEMAS[key];
  if (options.version !== undefined && options.version !== schema.version)
    return { ok: false, reason: 'version' };
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    return { ok: false, reason: 'malformed' };
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(input)).length;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (size > Math.min(options.maxBytes ?? VIEW_STATE_HARD_MAX_BYTES, VIEW_STATE_HARD_MAX_BYTES))
    return { ok: false, reason: 'too_large' };
  const source = input as Record<string, unknown>;
  const state: ViewStateValue = {};
  let dropped = 0;
  for (const name of Object.keys(source)) {
    const def = Object.prototype.hasOwnProperty.call(schema.fields, name)
      ? schema.fields[name]
      : undefined;
    const value =
      def && def.stores.includes(options.store) ? decodeField(def.spec, source[name]) : undefined;
    if (value === undefined) dropped++;
    else state[name] = value;
  }
  return { ok: true, state, dropped };
}

/** Reads a view's URL-owned fields from query parameters (unknown parameters are ignored). */
export function viewStateFromSearch(key: ViewKey, search: URLSearchParams): DecodeResult {
  const schema: ViewStateSchema = VIEW_STATE_SCHEMAS[key];
  const raw: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(schema.fields)) {
    if (!def.stores.includes('url')) continue;
    const values = search.getAll(name);
    if (!values.length) continue;
    raw[name] = def.spec.kind === 'enums' ? values : values[0];
  }
  return decodeViewState(key, raw, { store: 'url' });
}

/** Writes a view's URL-owned fields into query parameters, preserving unrelated parameters. */
export function viewStateToSearch(
  key: ViewKey,
  state: ViewStateValue,
  base: URLSearchParams,
): URLSearchParams {
  const schema: ViewStateSchema = VIEW_STATE_SCHEMAS[key];
  const out = new URLSearchParams(base);
  for (const [name, def] of Object.entries(schema.fields)) {
    if (!def.stores.includes('url')) continue;
    out.delete(name);
    const v = state[name];
    if (Array.isArray(v)) for (const x of v) out.append(name, x);
    else if (typeof v === 'string' && v !== '') out.set(name, v);
  }
  return out;
}

/** Only the fields a store owns (for example the device subset of a full view state). */
export function pickStore(
  key: ViewKey,
  state: ViewStateValue,
  store: ViewFieldStore,
): ViewStateValue {
  const schema: ViewStateSchema = VIEW_STATE_SCHEMAS[key];
  const out: ViewStateValue = {};
  for (const [name, def] of Object.entries(schema.fields))
    if (def.stores.includes(store) && state[name] !== undefined) out[name] = state[name]!;
  return out;
}

// -----------------------------------------------------------------------------------------------
// Fractional ranks for ordered personal lists (0B concurrency `ordered`)
// -----------------------------------------------------------------------------------------------
const RANK_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const RANK_MAX_LENGTH = 64;

function midpoint(a: string, b: string | null): string {
  const zero = RANK_DIGITS[0]!;
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? zero) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const lo = a ? RANK_DIGITS.indexOf(a[0]!) : 0;
  const hi = b !== null ? RANK_DIGITS.indexOf(b[0]!) : RANK_DIGITS.length;
  if (hi - lo > 1) return RANK_DIGITS[Math.round((lo + hi) / 2)]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return RANK_DIGITS[lo]! + midpoint(a.slice(1), null);
}

function validRank(r: string | null): boolean {
  return r === null || (/^[0-9A-Za-z]{1,64}$/.test(r) && !r.endsWith(RANK_DIGITS[0]!));
}

/**
 * A rank strictly between `before` and `after` (null means an open end), comparing as byte
 * strings (the database column uses the C collation). Keys never end in the zero digit, so a key
 * always exists between two distinct keys. Returns null when the result would exceed
 * RANK_MAX_LENGTH characters or the inputs are invalid; the caller then rebalances.
 */
export function rankBetween(before: string | null, after: string | null): string | null {
  if (!validRank(before) || !validRank(after)) return null;
  if (before !== null && after !== null && before >= after) return null;
  const r = midpoint(before ?? '', after);
  return r.length <= RANK_MAX_LENGTH ? r : null;
}

/** Evenly spaced, fixed-width ranks for `n` items (rebalancing). */
export function evenRanks(n: number): string[] {
  const base = RANK_DIGITS.length;
  const width = Math.max(1, Math.ceil(Math.log(n + 1) / Math.log(base))) + 1;
  const span = base ** width;
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    let v = Math.floor((span * i) / (n + 1));
    if (v % base === 0) v += 1; // no trailing zero digit; spacing is at least `base`
    let s = '';
    for (let k = 0; k < width; k++) {
      s = RANK_DIGITS[v % base]! + s;
      v = Math.floor(v / base);
    }
    out.push(s);
  }
  return out;
}

// -----------------------------------------------------------------------------------------------
// Projects (Phase 2A, 0B ADR-21): browser-safe vocabularies shared by the API and the web app
// -----------------------------------------------------------------------------------------------

/** The immutable platform project statuses (seeded by migration 0021), in their fixed order. */
export const PROJECT_STATUSES = [
  { key: 'planned', name: 'Planned', category: 'planned' },
  { key: 'active', name: 'Active', category: 'active' },
  { key: 'on_hold', name: 'On hold', category: 'paused' },
  { key: 'completed', name: 'Completed', category: 'done' },
  { key: 'cancelled', name: 'Cancelled', category: 'cancelled' },
] as const;
export type ProjectStatusKey = (typeof PROJECT_STATUSES)[number]['key'];
export type StatusCategory = (typeof PROJECT_STATUSES)[number]['category'];
export const PROJECT_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type ProjectPriority = (typeof PROJECT_PRIORITIES)[number];
export const PROJECT_HEALTH = ['on_track', 'at_risk', 'off_track'] as const;
export type ProjectHealth = (typeof PROJECT_HEALTH)[number];
export const SCOPE_ITEM_KINDS = ['scope', 'exclusion', 'risk', 'assumption', 'constraint'] as const;
export type ScopeItemKind = (typeof SCOPE_ITEM_KINDS)[number];
export const CRITERIA_KINDS = ['success', 'definition_of_done'] as const;
export const PHASE_STATUSES = ['planned', 'active', 'completed'] as const;
export const MILESTONE_STATUSES = ['planned', 'reached', 'missed', 'cancelled'] as const;
export const DECISION_KINDS = ['decision', 'open_question'] as const;
/** Kind-specific states (OD-15): decisions proposed → decided → superseded; questions open → resolved. */
export const DECISION_STATES = {
  decision: ['proposed', 'decided', 'superseded'],
  open_question: ['open', 'resolved'],
} as const;
export const PROJECT_SHARE_LEVELS = ['view', 'comment', 'edit'] as const;

/**
 * Project sections in their fixed visible order (0E IA §5, Phase 2A decision 7). `phase` null
 * means the section works in 2A; otherwise it is an addressable route with an honest unavailable
 * state. Tests and Releases are addressable but their tabs stay absent until enabled (UXD-14).
 */
/** Phase 2B immutable platform task statuses (0B ADR-22); 2C adds custom statuses. */
export const TASK_STATUSES = [
  { key: 'backlog', name: 'Backlog', category: 'planned' },
  { key: 'todo', name: 'To do', category: 'planned' },
  { key: 'in_progress', name: 'In progress', category: 'active' },
  { key: 'blocked', name: 'Blocked', category: 'paused' },
  { key: 'done', name: 'Done', category: 'done' },
  { key: 'cancelled', name: 'Cancelled', category: 'cancelled' },
] as const;
export type TaskStatusKey = (typeof TASK_STATUSES)[number]['key'];
export const TASK_CRITERIA_KINDS = ['acceptance', 'definition_of_done'] as const;
export const DELIVERABLE_TYPES = [
  'document',
  'file',
  'url',
  'pull_request',
  'test_report',
  'other',
] as const;
export type DeliverableType = (typeof DELIVERABLE_TYPES)[number];
export const RELATIONSHIP_KINDS = ['blocks', 'blocked_by', 'related'] as const;
export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];
export const LABEL_COLORS = [
  '#6b7280',
  '#dc2626',
  '#ea580c',
  '#ca8a04',
  '#16a34a',
  '#0891b2',
  '#2563eb',
  '#7c3aed',
  '#db2777',
] as const;

export const PROJECT_SECTIONS = [
  { key: 'overview', label: 'Overview', phase: null, conditional: false },
  { key: 'tasks', label: 'Tasks', phase: null, conditional: false },
  { key: 'timeline', label: 'Timeline', phase: null, conditional: false },
  { key: 'calendar', label: 'Calendar', phase: '3B', conditional: false },
  { key: 'documents', label: 'Documents', phase: '4C', conditional: false },
  { key: 'files', label: 'Files', phase: '4E', conditional: false },
  { key: 'activity', label: 'Activity', phase: '3B', conditional: false },
  { key: 'time', label: 'Time', phase: '3D', conditional: false },
  { key: 'costs', label: 'Costs', phase: '5C', conditional: false },
  { key: 'reports', label: 'Reports', phase: '5D', conditional: false },
  { key: 'settings', label: 'Settings', phase: null, conditional: false },
  { key: 'tests', label: 'Tests', phase: '9B', conditional: true },
  { key: 'releases', label: 'Releases', phase: '9D', conditional: true },
] as const;
export type ProjectSectionKey = (typeof PROJECT_SECTIONS)[number]['key'];
