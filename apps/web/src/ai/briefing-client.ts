import { api, newIdempotencyKey } from '../api.ts';

/** Phase 7E briefing client (ADR-0042). Every write carries its own Idempotency-Key. */

export type BriefingKind =
  'owner_daily' | 'brand_daily' | 'weekly_review' | 'project_status' | 'release_readiness';

export const KIND_TEXT: Record<BriefingKind, string> = {
  owner_daily: 'Daily briefing (every brand)',
  brand_daily: 'Brand daily briefing',
  weekly_review: 'Weekly review',
  project_status: 'Project status update',
  release_readiness: 'Release-readiness summary',
};

export interface BriefingScopeView {
  key: string;
  brand?: string;
  project?: string;
  label?: string;
}

export interface BriefingSummary {
  id: string;
  type: 'briefing';
  kind: BriefingKind;
  kind_label: string;
  scope: BriefingScopeView;
  trigger: 'schedule' | 'manual' | 'regenerate';
  state: 'queued' | 'published' | 'failed' | 'superseded';
  failure_code: string | null;
  timezone: string;
  window: { start: string; end: string };
  baseline: string | null;
  first: boolean;
  regenerates: string | null;
  mode: 'fact_only';
  content: 'present' | 'erased';
  published_at: string | null;
  created_at: string;
  version: number;
}

export interface BriefingRef {
  type: string;
  id: string;
  version?: number | string;
}

export interface BriefingStatement {
  position: number;
  section: string;
  kind:
    'fact' | 'calculation' | 'excerpt' | 'suggestion' | 'unknown' | 'annotation' | 'unavailable';
  key: string;
  text: string | null;
  refs: BriefingRef[];
  figures: Record<string, unknown> | null;
  correction: { id: string; state: string } | null;
  corrections: Array<{ id: string; state: string }>;
}

export interface SectionCoverage {
  state: 'complete' | 'truncated' | 'partial' | 'unavailable';
  shown: number;
  total: number | null;
  note?: string;
}

export interface Briefing extends BriefingSummary {
  schedule: string | null;
  availability: 'available' | 'withheld' | 'erased' | 'none';
  delivery: { in_app: string; email: string; email_reason: string | null };
  coverage: { sections: Record<string, SectionCoverage>; window_clamped?: boolean } | null;
  statements: BriefingStatement[];
}

export interface BriefingPreview {
  kind: BriefingKind;
  kind_label: string;
  scope: BriefingScopeView;
  timezone: string;
  window: { start: string; end: string; clamped: boolean };
  baseline: { id: string; published_at: string } | null;
  first: boolean;
  mode: 'fact_only';
  generated: { available: false; reason: string };
}

export interface BriefingSchedule {
  id: string;
  type: 'briefing_schedule';
  kind: BriefingKind;
  kind_label: string;
  scope: BriefingScopeView;
  timezone: string;
  local_time: string;
  weekdays: number[];
  channels: Array<'in_app' | 'email'>;
  email: 'off' | 'requested' | 'not_configured';
  enabled: boolean;
  revision: number;
  next_run_at: string | null;
  upcoming: string[];
  version: number;
}

export interface BriefingCorrection {
  id: string;
  type: 'briefing_correction';
  briefing: string | null;
  kind: BriefingKind;
  scope: string;
  statement: string;
  text: string | null;
  state: 'proposed' | 'approved' | 'rejected' | 'superseded' | 'stale' | 'erased';
  revision: number;
  decided_at: string | null;
  created_at: string;
  version: number;
  history?: Array<{ kind: string; revision: number; at: string }>;
}

const w = (ws: string) => `/v1/workspaces/${encodeURIComponent(ws)}`;
const write = (key?: string) => ({ 'idempotency-key': key ?? newIdempotencyKey() });

export const briefingClient = {
  list: async (ws: string) =>
    (
      await api<{ data: { items: BriefingSummary[]; next_cursor: string | null } }>(
        'GET',
        `${w(ws)}/ai/briefings`,
      )
    ).body.data,
  get: async (ws: string, id: string) =>
    (await api<{ data: Briefing }>('GET', `${w(ws)}/ai/briefings/${encodeURIComponent(id)}`)).body
      .data,
  preview: async (ws: string, body: Record<string, unknown>) =>
    (await api<{ data: BriefingPreview }>('POST', `${w(ws)}/ai/briefing-previews`, { body })).body
      .data,
  generate: async (ws: string, body: Record<string, unknown>, key: string) =>
    (await api<{ data: Briefing }>('POST', `${w(ws)}/ai/briefings`, { body, headers: write(key) }))
      .body.data,
  regenerate: async (ws: string, id: string, key: string) =>
    (
      await api<{ data: Briefing }>('POST', `${w(ws)}/ai/briefings/${id}:regenerate`, {
        body: {},
        headers: write(key),
      })
    ).body.data,
  schedules: async (ws: string) =>
    (
      await api<{
        data: {
          items: BriefingSchedule[];
          email: 'configured' | 'not_configured';
          timezone: string;
        };
      }>('GET', `${w(ws)}/ai/briefing-schedules`)
    ).body.data,
  createSchedule: async (ws: string, body: Record<string, unknown>, key: string) =>
    (
      await api<{ data: BriefingSchedule }>('POST', `${w(ws)}/ai/briefing-schedules`, {
        body,
        headers: write(key),
      })
    ).body.data,
  updateSchedule: async (
    ws: string,
    id: string,
    body: Record<string, unknown>,
    version: number,
    key: string,
  ) =>
    (
      await api<{ data: BriefingSchedule }>('PATCH', `${w(ws)}/ai/briefing-schedules/${id}`, {
        body,
        headers: { ...write(key), 'if-match': `"${version}"` },
      })
    ).body.data,
  corrections: async (ws: string) =>
    (
      await api<{ data: { items: BriefingCorrection[] } }>(
        'GET',
        `${w(ws)}/ai/briefing-corrections`,
      )
    ).body.data.items,
  propose: async (ws: string, brf: string, body: Record<string, unknown>, key: string) =>
    (
      await api<{ data: BriefingCorrection }>('POST', `${w(ws)}/ai/briefings/${brf}/corrections`, {
        body,
        headers: write(key),
      })
    ).body.data,
  decide: async (
    ws: string,
    id: string,
    verb: 'approve' | 'reject',
    version: number,
    key: string,
  ) =>
    (
      await api<{ data: BriefingCorrection }>(
        'POST',
        `${w(ws)}/ai/briefing-corrections/${id}:${verb}`,
        { body: {}, headers: { ...write(key), 'if-match': `"${version}"` } },
      )
    ).body.data,
  brands: async (ws: string) =>
    (
      await api<{ data: Array<{ id: string; name: string }> }>(
        'GET',
        `${w(ws)}/brands?state=active`,
      )
    ).body.data,
  projects: async (ws: string) =>
    (await api<{ data: Array<{ id: string; name: string }> }>('GET', `${w(ws)}/projects`)).body
      .data,
};
