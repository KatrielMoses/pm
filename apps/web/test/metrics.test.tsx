import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import {
  metricQueryString,
  metricsApi,
  EMPTY_METRIC_QUERY,
  type MetricCatalog,
  type MetricDefinitionInfo,
  type MetricRecords,
  type MetricResult,
} from '../src/metrics/client.ts';
import { duration, MetricsPage } from '../src/pages/metric-pages.tsx';
import { Router } from '../src/router.tsx';
import { matchRoute } from '../src/shell/registry.ts';

let capabilities: Record<string, boolean> = {};
vi.mock('../src/shell/workspace.tsx', () => ({
  useWorkspaceShell: () => ({
    ws: 'wsp_A',
    context: {
      workspace: { id: 'wsp_A', name: 'Co', capabilities },
      scope: { kind: 'all', brand_ids: [] },
      brands: [
        {
          id: 'br_00000000000000000000000001',
          name: 'Harbor',
          short_name: null,
          color: '#336699',
          icon: 'circle',
          is_sensitive: false,
        },
      ],
    },
    recent: [],
  }),
}));

const WS = 'wsp_A';
const def = (extra: Partial<MetricDefinitionInfo> = {}): MetricDefinitionInfo => ({
  id: 'project.completion',
  version: 1,
  current: true,
  name: 'Completion (by task count)',
  summary: 'The share of tasks that are done.',
  unit: 'percent',
  scopes: ['workspace', 'brand', 'project'],
  window: 'none',
  historical: true,
  numerator: 'Leaf tasks that are done.',
  denominator: 'Leaf tasks that are not cancelled.',
  sources: ['task'],
  timezone: 'none',
  freshness: 'live',
  rollup: { kind: 'ratio_of_sums', note: 'All done leaf tasks over all counted leaf tasks.' },
  incomplete: [],
  authorization: 'Computed only from records the viewer can read.',
  drill: [
    { role: 'numerator', label: 'Done tasks', records: 'task' },
    { role: 'denominator', label: 'Counted tasks', records: 'task' },
  ],
  does_not_claim: 'Measures tasks finished, not value delivered.',
  availability: { state: 'available' },
  changelog: '',
  digest: 'a'.repeat(64),
  ...extra,
});
const catalog = (): MetricCatalog => ({
  type: 'metric_catalog',
  data: [
    def(),
    def({ version: 2, current: false, name: 'Completion (weighted by estimate)' }),
    def({
      id: 'work.cycle_time',
      name: 'Cycle time',
      window: 'window',
      timezone: 'workspace',
      scopes: ['workspace', 'brand', 'project'],
      drill: [{ role: 'included', label: 'Completions measured', records: 'task' }],
    }),
    def({
      id: 'quality.tests',
      name: 'Test results',
      availability: {
        state: 'source_unavailable',
        phase: '9B',
        reason: 'Test runs are recorded from 9B.',
      },
      drill: [],
    }),
  ],
  limits: { window_days_max: 366, default_window_days: 30, drill_page_max: 100, sample_min: 5 },
});
const result = (extra: Partial<MetricResult> = {}): MetricResult => ({
  type: 'metric_result',
  definition: {
    id: 'project.completion',
    version: 1,
    name: 'Completion (by task count)',
    unit: 'percent',
    digest: 'a'.repeat(64),
  },
  scope: { kind: 'workspace', brand: null, project: null, subprojects: null },
  window: null,
  as_of: '2026-10-09T10:00:00.000Z',
  timezone: null,
  state: 'complete',
  value: { percent: 40, basis: 'task_count', tasks: { counted: 5, done: 2, unestimated: 1 } },
  parts: { numerator: 2, denominator: 5 },
  incomplete: [],
  groups: [],
  freshness: { state: 'current', data_as_of: '2026-10-09T10:00:00.000Z', basis: 'live' },
  provenance: { sources: ['task'], authorization: 'viewer', evidence: 'recorded_records' },
  limits: [
    'Measures tasks finished, not value delivered.',
    'Computed only from records the viewer can read.',
  ],
  unavailable: null,
  drill: {
    members: [
      { role: 'numerator', label: 'Done tasks', count: 2 },
      { role: 'denominator', label: 'Counted tasks', count: 5 },
    ],
  },
  reproducibility: {
    definition_digest: 'a'.repeat(64),
    as_of: '2026-10-09T10:00:00.000Z',
    historical: false,
    result_digest: 'b'.repeat(64),
  },
  ...extra,
});
const records = (n: number, next: string | null = null): MetricRecords => ({
  type: 'metric_records',
  member: { role: 'numerator', label: 'Done tasks', records: 'task' },
  total: 3,
  items: Array.from({ length: n }, (_, i) => ({
    record: { type: 'task' as const, id: `tsk_0000000000000000000000000${i + (next ? 0 : 5)}` },
    title: `Task ${i + (next ? 1 : 3)}`,
    brand: null,
    project: { id: 'prj_00000000000000000000000001', name: 'Alpha' },
    status: { category: 'done' },
    due: null,
  })),
  page: { limit: 20, next_cursor: next, truncated: false },
});

function at(search: string) {
  window.history.replaceState({}, '', `/workspaces/${WS}/metrics${search}`);
}
const renderPage = () =>
  render(
    <Router>
      <MetricsPage ws={WS} />
    </Router>,
  );

beforeEach(() => {
  capabilities = {};
  at('');
  vi.spyOn(metricsApi, 'catalog').mockResolvedValue(catalog());
  vi.spyOn(metricsApi, 'get').mockResolvedValue(result());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('metrics requests and routing (5C)', () => {
  it('builds one query string for the figure, its records, and its export, from only what is set', () => {
    expect(metricQueryString(EMPTY_METRIC_QUERY)).toBe('');
    const q = {
      ...EMPTY_METRIC_QUERY,
      metric: 'work.cycle_time',
      version: '1',
      brand: 'br_1',
      from: '2026-03-01',
      to: '2026-03-31',
    };
    expect(metricQueryString(q)).toBe('version=1&brand=br_1&from=2026-03-01&to=2026-03-31');
    expect(metricQueryString(q, { member: 'included', cursor: '' })).toBe(
      'version=1&brand=br_1&from=2026-03-01&to=2026-03-31&member=included',
    );
    expect(metricsApi.exportHref(WS, q)).toBe(
      `/v1/workspaces/${WS}/metrics/work.cycle_time/export?version=1&brand=br_1&from=2026-03-01&to=2026-03-31`,
    );
  });

  it('is a registered workspace page whose address is its own state', () => {
    const hit = matchRoute(`/workspaces/${WS}/metrics`);
    expect(hit?.def).toMatchObject({
      id: 'metrics',
      stateInQuery: true,
      extraCommand: 'go.metrics',
    });
  });

  it('shows long durations in the unit a person reads', () => {
    expect([30, 90, 7200, 86_400, 172_800, 1_000_000].map(duration)).toEqual([
      '30 s',
      '2 min',
      '2 h',
      '24 h',
      '2 days',
      '11.6 days',
    ]);
  });
});

describe('metrics page (5C)', () => {
  it('shows the figure, its state, what is counted, the records behind it, and an export', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { level: 2, name: /Completion \(by task count\)/ }),
    ).toBeTruthy();
    expect(screen.getByText('40%')).toBeTruthy();
    expect(screen.getByText('Complete')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download as CSV' }).getAttribute('href')).toBe(
      `/v1/workspaces/${WS}/metrics/project.completion/export?`,
    );
    const how = screen.getByText('How this is counted').closest('details')!;
    expect(how.textContent).toContain('Leaf tasks that are done.');
    expect(how.textContent).toContain('All done leaf tasks over all counted leaf tasks');
    expect(how.textContent).toContain('Measures tasks finished, not value delivered.');
    expect(metricsApi.get).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ metric: 'project.completion' }),
      expect.anything(),
    );
  });

  it('says what is missing instead of presenting a partial figure as complete', async () => {
    vi.spyOn(metricsApi, 'get').mockResolvedValue(
      result({
        state: 'partial',
        incomplete: [
          {
            code: 'unestimated_tasks',
            count: 3,
            message: 'Some counted tasks have no estimate and carry no weight.',
          },
        ],
      }),
    );
    renderPage();
    expect(await screen.findByText(/Partial: some data is missing/)).toBeTruthy();
    const list = screen.getByRole('list', { name: 'What is missing' });
    expect(within(list).getByText(/3: Some counted tasks have no estimate/)).toBeTruthy();
  });

  it('shows an unavailable source as unavailable, never as a number', async () => {
    at('?metric=quality.tests');
    vi.spyOn(metricsApi, 'get').mockResolvedValue(
      result({
        definition: {
          id: 'quality.tests',
          version: 1,
          name: 'Test results',
          unit: 'count',
          digest: 'c'.repeat(64),
        },
        state: 'unavailable',
        value: null,
        parts: null,
        drill: { members: [] },
        unavailable: { phase: '9B', reason: 'Test runs are recorded from 9B.' },
      }),
    );
    renderPage();
    expect(await screen.findByText('Not available until phase 9B')).toBeTruthy();
    expect(screen.getByText('Not available yet')).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Download as CSV' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Records behind this figure' })).toBeNull();
  });

  it('warns when derived data is behind or failing, and offers the repair only to people who can configure', async () => {
    const lagging = result({
      freshness: {
        state: 'degraded',
        data_as_of: '2026-10-09T10:00:00.000Z',
        basis: 'ledger',
        ledger: {
          reconciliation: 'failing',
          last_success_at: null,
          tasks_with_assumed_history: 2,
          tasks_with_repaired_history: 1,
        },
      },
    });
    vi.spyOn(metricsApi, 'get').mockResolvedValue(lagging);
    renderPage();
    expect(await screen.findByText('Some data could not be brought up to date')).toBeTruthy();
    expect(screen.getByText(/1 task had history rebuilt/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check status history now' })).toBeNull();
    cleanup();
    capabilities = { configure: true };
    const reconcile = vi
      .spyOn(metricsApi, 'reconcile')
      .mockResolvedValue({ status: 202, body: {} });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Check status history now' }));
    await waitFor(() => expect(reconcile).toHaveBeenCalledWith(WS));
    expect(await screen.findByText(/A check of the status history is scheduled/)).toBeTruthy();
  });

  it('lists the records behind a figure, loads more by the server’s cursor, and keeps the choice in the address', async () => {
    const get = vi
      .spyOn(metricsApi, 'records')
      .mockResolvedValueOnce(records(2, 'c1'))
      .mockResolvedValueOnce(records(1));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Done tasks \(2\)/ }));
    expect(window.location.search).toContain('member=numerator');
    expect(await screen.findByRole('heading', { level: 3, name: 'Done tasks (3)' })).toBeTruthy();
    const list = await screen.findByRole('list', { name: '' }).catch(() => null);
    void list;
    await waitFor(() => expect(screen.getAllByRole('link', { name: /^Task \d$/ })).toHaveLength(2));
    expect(screen.getAllByRole('link', { name: /^Task \d$/ })[0]!.getAttribute('href')).toMatch(
      /^\/workspaces\/wsp_A\/tasks\/tsk_/,
    );
    expect(
      screen.getByRole('button', { name: /Done tasks \(2\)/ }).getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getAllByRole('link', { name: /^Task \d$/ })).toHaveLength(3));
    expect(get).toHaveBeenLastCalledWith(
      WS,
      expect.objectContaining({ member: 'numerator' }),
      'c1',
    );
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('lets a person pick a version, a brand, and a window, and sends exactly those', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 2 });
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '2' } });
    await waitFor(() =>
      expect(metricsApi.get).toHaveBeenLastCalledWith(
        WS,
        expect.objectContaining({ version: '2' }),
        expect.anything(),
      ),
    );
    fireEvent.change(screen.getByLabelText('Brand'), {
      target: { value: 'br_00000000000000000000000001' },
    });
    await waitFor(() =>
      expect(metricsApi.get).toHaveBeenLastCalledWith(
        WS,
        expect.objectContaining({ brand: 'br_00000000000000000000000001', version: '2' }),
        expect.anything(),
      ),
    );
    fireEvent.change(screen.getByLabelText('Metric'), { target: { value: 'work.cycle_time' } });
    await waitFor(() =>
      expect(metricsApi.get).toHaveBeenLastCalledWith(
        WS,
        expect.objectContaining({ metric: 'work.cycle_time', version: '' }),
        expect.anything(),
      ),
    );
    fireEvent.change(await screen.findByLabelText('From'), { target: { value: '2026-03-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-03-31' } });
    await waitFor(() =>
      expect(metricsApi.get).toHaveBeenLastCalledWith(
        WS,
        expect.objectContaining({ from: '2026-03-01', to: '2026-03-31' }),
        expect.anything(),
      ),
    );
    expect(window.location.search).toContain('metric=work.cycle_time');
  });

  it('shows a refused or unavailable request as a problem, not as an empty figure', async () => {
    at('?metric=project.completion&project=prj_00000000000000000000000009');
    vi.spyOn(metricsApi, 'get').mockRejectedValue(
      new ApiError({
        code: 'validation_failed',
        status: 422,
        message: 'That project is not available.',
      }),
    );
    renderPage();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('40%')).toBeNull();
  });

  it('works at a 320 px width: every control is labelled, and tables carry their headers as data labels', async () => {
    vi.spyOn(metricsApi, 'get').mockResolvedValue(
      result({
        groups: [
          {
            project: { id: 'prj_1', name: 'Alpha' },
            percent: 40,
            numerator: 2,
            denominator: 5,
            state: 'complete',
          },
        ],
      }),
    );
    renderPage();
    await screen.findByRole('heading', { level: 2 });
    for (const name of ['Metric', 'Version', 'Brand'])
      expect(screen.getByLabelText(name)).toBeTruthy();
    const region = screen.getByRole('region', { name: 'Breakdown' });
    expect(region.getAttribute('tabindex')).toBe('0');
    const table = within(region).getByRole('table');
    expect(table.querySelectorAll('td[data-label]').length).toBeGreaterThan(0);
    expect(within(table).getByRole('cell', { name: 'Alpha' })).toBeTruthy();
    expect(table.querySelector('caption')?.textContent).toBe('Breakdown');
  });
});
