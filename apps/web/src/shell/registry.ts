import {
  DESTINATION_PHASE,
  SHELL_DESTINATIONS,
  type ShellCommandId,
  type ShellDestination,
} from '@pm/contracts/shell';
import type { ShellCapabilities } from './client.ts';

/**
 * The one route registry (NAV-001, NAV-012). Every shell surface reads it: sidebar, rail, Compact
 * bottom bar and More sheet, breadcrumbs, page titles, the command palette's Go to group, and the
 * go-to shortcuts. `main.tsx` maps every id to a component through an exhaustive record, so a
 * destination cannot exist in navigation without a page, and the permission predicate here is the
 * same one each surface applies (absent, not disabled; IA-02, IA-40).
 */

export type ShellKind = 'workspace' | 'personal' | 'minimal';

export interface Access {
  principal: 'member' | 'guest';
  capabilities: ShellCapabilities;
  hidden: readonly ShellDestination[];
}

export type NavPlacement = 'primary' | 'personal' | 'workspace' | 'admin';

export interface NavEntry {
  placement: NavPlacement;
  label: string;
  /** Rail label (RS: icon + short label). */
  short: string;
  icon: string;
  order: number;
}

export interface RouteDef {
  id: string;
  pattern: string;
  shell: ShellKind;
  /** Section name used in page titles and as a breadcrumb crumb. */
  section: string;
  nav?: NavEntry;
  destination?: ShellDestination;
  /** The URL carries the brand scope (`?scope=`) on this route (IA-24). */
  scopeSensitive?: boolean;
  /**
   * The query string is this page's own state (a search and its filters), not a navigation: the
   * shell does not re-read the workspace context when only it changes. Every request the page
   * makes is authorized by the server on its own.
   */
  stateInQuery?: boolean;
  /** Content belongs to a later phase: the page is an honest unavailable state (no data). */
  phase?: string | null;
  command?: ShellCommandId;
  /**
   * A Go to command for a route outside the closed `ShellCommandId` set (5B Portfolio): listed in
   * the palette under the same permission predicate, not counted by shell telemetry.
   */
  extraCommand?: string;
  shortcut?: string;
  /** Permission predicate shared by every surface. Absent means everyone in the shell kind. */
  visible?: (a: Access) => boolean;
}

const member = (a: Access) => a.principal === 'member';
const DEST_ICON: Record<ShellDestination, string> = {
  home: '⌂',
  today: '☀',
  inbox: '⇩',
  my_work: '✓',
  projects: '▦',
  calendar: '▤',
  knowledge: '❏',
  goals: '◎',
  reports: '▥',
};
const DEST_LABEL: Record<ShellDestination, string> = {
  home: 'Home',
  today: 'Today',
  inbox: 'Inbox',
  my_work: 'My Work',
  projects: 'Projects',
  calendar: 'Calendar',
  knowledge: 'Knowledge',
  goals: 'Goals',
  reports: 'Reports',
};
const DEST_SHORTCUT: Partial<Record<ShellDestination, string>> = {
  home: 'G H',
  today: 'G T',
  inbox: 'G I',
  my_work: 'G W',
  projects: 'G P',
  calendar: 'G C',
  knowledge: 'G K',
  goals: 'G O',
  reports: 'G R',
};

export const destinationLabel = (d: ShellDestination) => DEST_LABEL[d];

const destinations: RouteDef[] = SHELL_DESTINATIONS.map((d, i) => ({
  id: d,
  pattern: `/workspaces/:ws/${d.replace('_', '-')}`,
  shell: 'workspace',
  section: DEST_LABEL[d],
  destination: d,
  scopeSensitive: true,
  // 5B ships the Goals destination and 5D the Reports destination; the contract's phase table still
  // names them as upcoming.
  phase: d === 'goals' || d === 'reports' ? null : DESTINATION_PHASE[d],
  command: `go.${d}` as ShellCommandId,
  ...(DEST_SHORTCUT[d] ? { shortcut: DEST_SHORTCUT[d] } : {}),
  nav: {
    placement: 'primary',
    label: DEST_LABEL[d],
    short: d === 'my_work' ? 'Work' : DEST_LABEL[d],
    icon: DEST_ICON[d],
    order: i,
  },
  // Guests get the reduced shell (IA-05); hidden destinations are a personal choice (UXD-20).
  visible: (a) => member(a) && (d === 'home' || !a.hidden.includes(d)),
}));

export const ROUTES: readonly RouteDef[] = [
  ...destinations,
  {
    id: 'project',
    pattern: '/workspaces/:ws/projects/:prj',
    shell: 'workspace',
    section: 'Projects',
    // Guests open shared projects from Shared with me; the API decides what each person can read.
  },
  {
    id: 'project_section',
    pattern: '/workspaces/:ws/projects/:prj/:section',
    shell: 'workspace',
    section: 'Projects',
  },
  {
    id: 'tasks',
    pattern: '/workspaces/:ws/tasks',
    shell: 'workspace',
    section: 'Tasks',
    visible: member,
  },
  // 2E: notes and intake forms (the Inbox is the `inbox` destination).
  { id: 'notes', pattern: '/workspaces/:ws/notes', shell: 'workspace', section: 'Inbox' },
  { id: 'note', pattern: '/workspaces/:ws/notes/:note', shell: 'workspace', section: 'Inbox' },
  {
    id: 'intake_forms',
    pattern: '/workspaces/:ws/forms',
    shell: 'workspace',
    section: 'Inbox',
    visible: member,
  },
  {
    id: 'intake_form',
    pattern: '/workspaces/:ws/forms/:form',
    shell: 'workspace',
    section: 'Inbox',
    visible: member,
  },
  {
    id: 'task',
    pattern: '/workspaces/:ws/tasks/:tsk',
    shell: 'workspace',
    section: 'Tasks',
    // Guests open shared tasks from Shared with me; the API decides what each person can read.
  },
  {
    id: 'shared',
    pattern: '/workspaces/:ws/shared',
    shell: 'workspace',
    section: 'Shared with me',
    command: 'go.shared',
    nav: { placement: 'primary', label: 'Shared with me', short: 'Shared', icon: '⇄', order: 0 },
    // Guests' home (IA-05); members reach shared items through My Work in its owning phase.
    visible: (a) => a.principal === 'guest',
  },
  // 5A: permission-aware search across records the person can read; the whole state is in the URL.
  {
    id: 'search',
    pattern: '/workspaces/:ws/search',
    shell: 'workspace',
    section: 'Search',
    command: 'go.search',
    shortcut: '/',
    stateInQuery: true,
    // Guests search what is shared with them; the API decides what each person can read.
  },
  // 3A: saved views (personal and shared with the person); drafts open at `views/new?entity=`.
  {
    id: 'views',
    pattern: '/workspaces/:ws/views',
    shell: 'workspace',
    section: 'Views',
    command: 'go.views',
    nav: { placement: 'personal', label: 'Saved views', short: 'Views', icon: '☰', order: 2 },
  },
  { id: 'view', pattern: '/workspaces/:ws/views/:view', shell: 'workspace', section: 'Views' },
  {
    id: 'favorites',
    pattern: '/workspaces/:ws/favorites',
    shell: 'workspace',
    section: 'Favorites',
    nav: { placement: 'personal', label: 'Favorites', short: 'Favorites', icon: '☆', order: 0 },
  },
  {
    id: 'recent',
    pattern: '/workspaces/:ws/recent',
    shell: 'workspace',
    section: 'Recently viewed',
    command: 'go.recent',
    shortcut: 'G V',
    nav: { placement: 'personal', label: 'All recent', short: 'Recent', icon: '↺', order: 1 },
  },
  {
    id: 'people',
    pattern: '/workspaces/:ws/people',
    shell: 'workspace',
    section: 'People',
    command: 'go.people',
    nav: { placement: 'workspace', label: 'People', short: 'People', icon: '☺', order: 0 },
    visible: (a) => member(a) && a.capabilities.view_directory,
  },
  {
    id: 'invite',
    pattern: '/workspaces/:ws/people/invite',
    shell: 'workspace',
    section: 'People',
    visible: (a) => member(a) && (a.capabilities.invite_members || a.capabilities.invite_guests),
  },
  {
    id: 'person',
    pattern: '/workspaces/:ws/people/:mem',
    shell: 'workspace',
    section: 'People',
    visible: (a) => member(a) && a.capabilities.view_directory,
  },
  {
    id: 'teams',
    pattern: '/workspaces/:ws/teams',
    shell: 'workspace',
    section: 'Teams',
    command: 'go.teams',
    nav: { placement: 'workspace', label: 'Teams', short: 'Teams', icon: '⚇', order: 1 },
    visible: (a) => member(a) && a.capabilities.view_directory,
  },
  {
    id: 'team',
    pattern: '/workspaces/:ws/teams/:team',
    shell: 'workspace',
    section: 'Teams',
    visible: (a) => member(a) && a.capabilities.view_directory,
  },
  {
    id: 'brand_new',
    pattern: '/workspaces/:ws/brands/new',
    shell: 'workspace',
    section: 'Brands',
    visible: (a) => member(a) && a.capabilities.create_brand,
  },
  {
    id: 'brand',
    pattern: '/workspaces/:ws/brands/:brand',
    shell: 'workspace',
    section: 'Brand settings',
    visible: member,
  },
  {
    id: 'first_brand',
    pattern: '/workspaces/:ws/first-brand',
    shell: 'workspace',
    section: 'Brands',
    visible: (a) => member(a) && a.capabilities.create_brand,
  },
  {
    id: 'workspace_settings',
    pattern: '/workspaces/:ws/settings',
    shell: 'workspace',
    section: 'Workspace settings',
    command: 'go.workspace_settings',
    nav: {
      placement: 'admin',
      label: 'Workspace settings',
      short: 'Settings',
      icon: '⚙',
      order: 0,
    },
    visible: (a) => member(a) && a.capabilities.configure,
  },
  {
    id: 'access_settings',
    pattern: '/workspaces/:ws/settings/access',
    shell: 'workspace',
    section: 'Sharing and ownership',
    command: 'go.access_settings',
    nav: {
      placement: 'admin',
      label: 'Sharing and ownership',
      short: 'Sharing',
      icon: '⚿',
      order: 1,
    },
    visible: (a) => member(a) && a.capabilities.view_directory,
  },
  // 2C (0E Phase 2C note): workflow and field administration at a chosen scope, and the
  // approvals queue. Pages decide authority per scope; members see the entry points.
  {
    id: 'api_access',
    pattern: '/workspaces/:ws/settings/api',
    shell: 'workspace',
    section: 'API and webhooks',
    visible: member,
  },
  {
    id: 'workflows',
    pattern: '/workspaces/:ws/settings/workflows',
    shell: 'workspace',
    section: 'Workflows',
    nav: { placement: 'admin', label: 'Workflows', short: 'Workflows', icon: '⇉', order: 2 },
    visible: member,
  },
  {
    id: 'fields',
    pattern: '/workspaces/:ws/settings/fields',
    shell: 'workspace',
    section: 'Custom fields',
    nav: { placement: 'admin', label: 'Custom fields', short: 'Fields', icon: '▤', order: 3 },
    visible: member,
  },
  {
    id: 'field_sets',
    pattern: '/workspaces/:ws/settings/field-sets',
    shell: 'workspace',
    section: 'Field sets',
    visible: member,
  },
  // 3D: time tracking (my week and timesheet), timesheet approvals, and reports with export.
  {
    id: 'time',
    pattern: '/workspaces/:ws/time',
    shell: 'workspace',
    section: 'Time',
    nav: { placement: 'workspace', label: 'Time', short: 'Time', icon: '◷', order: 2 },
    visible: member,
  },
  {
    id: 'time_approvals',
    pattern: '/workspaces/:ws/time/approvals',
    shell: 'workspace',
    section: 'Time',
    visible: member,
  },
  {
    id: 'time_report',
    pattern: '/workspaces/:ws/time/report',
    shell: 'workspace',
    section: 'Time',
    visible: member,
  },
  // 3E: working hours, time off, capacity by day and brand, team allocation, reservations.
  {
    id: 'capacity',
    pattern: '/workspaces/:ws/capacity',
    shell: 'workspace',
    section: 'Capacity',
    nav: { placement: 'workspace', label: 'Capacity', short: 'Capacity', icon: '◔', order: 3 },
    visible: member,
  },
  {
    id: 'approvals',
    pattern: '/workspaces/:ws/approvals',
    shell: 'workspace',
    section: 'Approvals',
    visible: member,
  },
  // 5B: a goal, and the project portfolio (health, dependencies, goal coverage). Goals and
  // portfolios are for members; the API refuses guests, so the routes are absent for them.
  {
    id: 'goal',
    pattern: '/workspaces/:ws/goals/:goal',
    shell: 'workspace',
    section: 'Goals',
    visible: member,
  },
  // 5C: the metrics model (figures with their definitions and the records behind them). The page
  // state is in the URL; the API decides what each person can read.
  {
    id: 'metrics',
    pattern: '/workspaces/:ws/metrics',
    shell: 'workspace',
    section: 'Metrics',
    extraCommand: 'go.metrics',
    stateInQuery: true,
    nav: { placement: 'workspace', label: 'Metrics', short: 'Metrics', icon: '∑', order: 5 },
    visible: member,
  },
  {
    id: 'portfolio',
    pattern: '/workspaces/:ws/projects/portfolio',
    shell: 'workspace',
    section: 'Projects',
    extraCommand: 'go.portfolio',
    nav: { placement: 'workspace', label: 'Portfolio', short: 'Portfolio', icon: '▥', order: 4 },
    visible: (a) => member(a) && !a.hidden.includes('projects'),
  },
  // 5D: a dashboard and a saved report. Dashboards are for members; a report may also be opened by
  // someone it was explicitly shared with (the API decides what each person may read).
  {
    id: 'dashboard',
    pattern: '/workspaces/:ws/dashboards/:dash',
    shell: 'workspace',
    section: 'Reports',
    visible: member,
  },
  {
    id: 'report',
    pattern: '/workspaces/:ws/reports/:rpt',
    shell: 'workspace',
    section: 'Reports',
  },
  // 4C: a document page (the Knowledge destination is the tree of pages).
  {
    id: 'document',
    pattern: '/workspaces/:ws/documents/:doc',
    shell: 'workspace',
    section: 'Knowledge',
    // Guests open shared documents from Shared with me; the API decides what each person can read.
  },
  // 4B: the notification centre and the person's notification settings. These addresses appear
  // in email and browser notifications, so they never change.
  {
    id: 'notifications',
    pattern: '/workspaces/:ws/notifications',
    shell: 'workspace',
    section: 'Notifications',
  },
  {
    id: 'notification_settings',
    pattern: '/workspaces/:ws/settings/notifications',
    shell: 'workspace',
    section: 'Notification settings',
  },
  {
    id: 'workspace_root',
    pattern: '/workspaces/:ws',
    shell: 'workspace',
    section: 'Home',
  },
  // Personal (signed in, no workspace in the URL)
  {
    id: 'preferences',
    pattern: '/settings/preferences',
    shell: 'personal',
    section: 'Preferences',
    command: 'go.preferences',
    nav: { placement: 'personal', label: 'Preferences', short: 'Prefs', icon: '⚙', order: 2 },
  },
  {
    id: 'account_security',
    pattern: '/account/security',
    shell: 'personal',
    section: 'Account security',
    command: 'go.account_security',
    nav: {
      placement: 'personal',
      label: 'Account security',
      short: 'Security',
      icon: '⚷',
      order: 3,
    },
  },
  {
    id: 'workspaces',
    pattern: '/workspaces',
    shell: 'personal',
    section: 'Workspaces',
    command: 'go.workspaces',
  },
  { id: 'onboarding', pattern: '/onboarding', shell: 'personal', section: 'Workspaces' },
  // Signed-out visitors land here from the mail link first, so the page manages its own session.
  {
    id: 'accept_invitation',
    pattern: '/invitations/accept',
    shell: 'minimal',
    section: 'Invitations',
  },
  // Minimal shell (signed out or pre-session)
  { id: 'sign_in', pattern: '/sign-in', shell: 'minimal', section: 'Sign in' },
  { id: 'sign_in_verify', pattern: '/sign-in/verify', shell: 'minimal', section: 'Sign in' },
  { id: 'register', pattern: '/register', shell: 'minimal', section: 'Create account' },
  { id: 'verify_email', pattern: '/verify-email', shell: 'minimal', section: 'Verify email' },
  {
    id: 'verify_confirm',
    pattern: '/verify-email/confirm',
    shell: 'minimal',
    section: 'Verify email',
  },
  {
    id: 'forgot_password',
    pattern: '/forgot-password',
    shell: 'minimal',
    section: 'Reset password',
  },
  { id: 'reset_password', pattern: '/reset-password', shell: 'minimal', section: 'Reset password' },
  { id: 'status', pattern: '/status', shell: 'minimal', section: 'Status' },
  { id: 'harness', pattern: '/_harness/lifecycle', shell: 'minimal', section: 'Harness' },
  { id: 'root', pattern: '/', shell: 'minimal', section: 'Loading' },
] as const satisfies readonly RouteDef[];

export type RouteId = (typeof ROUTES)[number]['id'] | ShellDestination;

export const ROUTE_INDEX: ReadonlyMap<string, RouteDef> = new Map(ROUTES.map((r) => [r.id, r]));

/** Matches a path against the registry (most specific pattern first: literals before params). */
export function matchRoute(path: string): { def: RouteDef; params: Record<string, string> } | null {
  const ordered = [...ROUTES].sort(
    (a, b) =>
      b.pattern.split('/').length - a.pattern.split('/').length ||
      a.pattern.split(':').length - b.pattern.split(':').length,
  );
  for (const def of ordered) {
    const p = def.pattern.split('/');
    const s = path.split('/');
    if (p.length !== s.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < p.length && ok; i++) {
      const part = p[i]!;
      const seg = s[i]!;
      if (part.startsWith(':')) {
        if (!/^[A-Za-z0-9_]{1,64}$/.test(seg)) ok = false;
        else params[part.slice(1)] = seg;
      } else if (part !== seg) ok = false;
    }
    if (ok) return { def, params };
  }
  return null;
}

/** Builds a route's URL from its pattern; the scope query is added for scope-sensitive routes. */
export function routeHref(
  id: string,
  params: Record<string, string>,
  query: Record<string, string | undefined> = {},
): string {
  const def = ROUTE_INDEX.get(id);
  if (!def) throw new Error(`unknown route ${id}`);
  const path = def.pattern.replace(/:([a-z]+)/g, (_m, k: string) => {
    const v = params[k];
    if (!v) throw new Error(`missing ${k} for ${id}`);
    return encodeURIComponent(v);
  });
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) q.set(k, v);
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}

export function canSee(def: RouteDef, access: Access | null): boolean {
  if (def.shell !== 'workspace') return true;
  if (!access) return false;
  return def.visible ? def.visible(access) : true;
}

/** Navigation entries for one placement, in order, filtered by the shared predicate. */
export function navEntries(placement: NavPlacement, access: Access | null): RouteDef[] {
  return ROUTES.filter((r) => r.nav?.placement === placement && canSee(r, access)).sort(
    (a, b) => a.nav!.order - b.nav!.order,
  );
}

/** Compact bottom bar: exactly five slots (RS-05), never customized (UXD-20). */
export const COMPACT_SLOTS = ['home', 'today', 'inbox', 'my_work'] as const;

/** Document title (IA-14): `{record} · {section} · {product}`; brand names are never included. */
export function documentTitle(
  product: string,
  section: string,
  record?: { title: string; isBrand?: boolean } | null,
): string {
  const parts = [record && !record.isBrand ? record.title : null, section, product].filter(
    (x, i, all): x is string => Boolean(x) && all.indexOf(x) === i,
  );
  return parts.join(' · ');
}
