import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import {
  dashboards,
  insights,
  reports,
  type Catalog,
  type Dashboard,
  type Filters,
  type MetricValue,
  type Report,
  type WidgetMeta,
  type WidgetOutcome,
  type WidgetRecords,
} from '../src/insights/client.ts';
import { LayoutEditor } from '../src/insights/editor.tsx';
import { FilterBar } from '../src/insights/filters.tsx';
import { formatValue, freshnessText } from '../src/insights/format.ts';
import { DashboardPage, ReportPage, ReportsPage } from '../src/pages/insight-pages.tsx';
import { WidgetCard, type WidgetApi } from '../src/insights/widget.tsx';
import { projects } from '../src/projects/client.ts';
import { Router } from '../src/router.tsx';
import { canSee, matchRoute, ROUTE_INDEX, routeHref, type Access } from '../src/shell/registry.ts';
import { StepUpProvider } from '../src/stepup.tsx';
import { collab as people } from '../src/tenancy/client.ts';

/**
 * Phase 5D web (dashboards and reports): every figure renders with its scope, source, freshness,
 * and estimated or incomplete labels; each widget loads and fails on its own; a widget the person
 * cannot see is absent; drill-through lists only what the API returns; layout editing works from
 * the keyboard; a paused schedule says why and who can resume it.
 */

vi.mock('../src/shell/commands.tsx', async (orig) => ({
  ...(await orig<typeof import('../src/shell/commands.tsx')>()),
  useRegisterCommands: vi.fn(),
}));

const WS = 'ws_A';

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.spyOn(people, 'people').mockResolvedValue([]);
  vi.spyOn(projects, 'list').mockResolvedValue({ data: [], total: null } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

const wrap = (ui: React.ReactNode) =>
  render(
    <Router>
      <StepUpProvider>{ui}</StepUpProvider>
    </Router>,
  );
const err = (code: string, status: number) => new ApiError({ code, status, message: code });

const NO_FILTERS: Filters = { range: null, brands: [], projects: [], people: [], statuses: [] };
const meta = (over: Partial<WidgetMeta> = {}): WidgetMeta => ({
  id: 'open',
  metric: 'tasks.open',
  title: 'Open tasks',
  size: 'medium',
  params: {},
  available: true,
  ...over,
});
const value = (over: Partial<MetricValue> = {}): MetricValue => ({
  state: 'ok',
  metric: 'tasks.open',
  version: 1,
  label: 'Open tasks',
  unit: 'count',
  value: 12,
  breakdown: [],
  columns: [
    { key: 'label', label: 'Group' },
    { key: 'count', label: 'Count' },
  ],
  rows: [{ cells: { label: 'Open tasks', count: 12 }, link: null }],
  incomplete: [],
  estimated: false,
  notes: [],
  covers: 'Work you can read in every brand you can access',
  range: null,
  applied: { range: false, brands: false, projects: false, people: false, statuses: false },
  source: { kind: 'work_query', label: 'Tasks and projects (saved-view query engine)' },
  freshness: { as_of: '2026-10-09T09:00:00.000Z', basis: 'live', source_as_of: null, stale: false },
  drill: true,
  ...over,
});
const api = (
  outcome: WidgetOutcome | Error,
  records?: WidgetRecords[],
): WidgetApi & { calls: number } => {
  let page = 0;
  const a = {
    calls: 0,
    widget: vi.fn(async () => {
      a.calls++;
      if (outcome instanceof Error) throw outcome;
      return { widget: meta(), outcome };
    }),
    records: vi.fn(
      async () =>
        records?.[page++] ??
        ({
          columns: [],
          rows: [],
          page: { limit: 5, has_more: false },
          covers: '',
          as_of: '',
          type: 'widget_records',
          widget: meta(),
        } as WidgetRecords),
    ),
  };
  return a;
};

describe('widget card (5D)', () => {
  it('shows the figure with what it covers, where it came from, and how fresh it is', async () => {
    wrap(<WidgetCard ws={WS} meta={meta()} api={api(value())} filters={null} reloadKey={0} />);
    const card = await screen.findByRole('region', { name: 'Open tasks' });
    expect(within(card).getByLabelText('Open tasks: 12')).toBeTruthy();
    expect(within(card).getByText(/Work you can read in every brand/)).toBeTruthy();
    expect(within(card).getByText(/Source: Tasks and projects/)).toBeTruthy();
    expect(within(card).getByText(/Computed from current records/)).toBeTruthy();
  });

  it('labels estimated and incomplete figures in words, never by colour alone', async () => {
    wrap(
      <WidgetCard
        ws={WS}
        meta={meta()}
        api={api(
          value({
            estimated: true,
            incomplete: ['count_capped', 'no_measurement'],
            notes: ['Planned time is the sum of estimates.'],
          }),
        )}
        filters={null}
        reloadKey={0}
      />,
    );
    await screen.findByText('Estimated');
    expect(screen.getByText('Incomplete')).toBeTruthy();
    expect(screen.getByText(/the true number is higher/)).toBeTruthy();
    expect(screen.getByText(/Some items have no measurement/)).toBeTruthy();
    expect(screen.getByText(/Planned time is the sum of estimates/)).toBeTruthy();
  });

  it('warns when a derived source is out of date and says which filters do not apply', async () => {
    wrap(
      <WidgetCard
        ws={WS}
        meta={meta()}
        api={api(
          value({
            freshness: {
              as_of: '2026-10-09T09:00:00.000Z',
              basis: 'derived',
              source_as_of: '2026-10-01T00:00:00.000Z',
              stale: true,
            },
            applied: {
              range: false,
              brands: true,
              projects: false,
              people: false,
              statuses: false,
            },
          }),
        )}
        filters={null}
        reloadKey={0}
      />,
    );
    await screen.findByText('Out of date');
    expect(
      screen.getByText(
        /Not applied here: date range, project filter, person filter, status filter/,
      ),
    ).toBeTruthy();
  });

  it('offers the same data as a table, and keeps a stacked layout hook for narrow screens', async () => {
    wrap(<WidgetCard ws={WS} meta={meta()} api={api(value())} filters={null} reloadKey={0} />);
    const summary = await screen.findByText('View data');
    fireEvent.click(summary);
    const table = screen.getByRole('table', { name: 'Open tasks: data' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual(['Group', 'Count']);
    expect(within(table).getByText('12').getAttribute('data-label')).toBe('Count');
  });

  it('drills into records page by page, with links only for records that have a page', async () => {
    const rec = (n: number, more: boolean): WidgetRecords => ({
      type: 'widget_records',
      widget: meta(),
      columns: [{ key: 'title', label: 'Task' }],
      rows: [{ cells: { title: `Task ${n}` }, link: { type: 'task', id: `tsk_${n}` } }],
      page: { limit: 1, has_more: more, ...(more ? { next_cursor: 'c1' } : {}) },
      covers: 'Work you can read in every brand you can access',
      as_of: '',
    });
    const a = api(value(), [rec(1, true), rec(2, false)]);
    wrap(<WidgetCard ws={WS} meta={meta()} api={a} filters={null} reloadKey={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show records' }));
    const dialog = await screen.findByRole('dialog');
    const link = await within(dialog).findByRole('link', { name: 'Task 1' });
    expect(link.getAttribute('href')).toBe('/workspaces/ws_A/tasks/tsk_1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Load more' }));
    await within(dialog).findByRole('link', { name: 'Task 2' });
    expect(within(dialog).queryByRole('button', { name: 'Load more' })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('fails on its own with a retry, and offline reads as offline', async () => {
    const a = api(err('internal_error', 500));
    wrap(<WidgetCard ws={WS} meta={meta()} api={a} filters={null} reloadKey={0} />);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Couldn't load Open tasks/)).toBeTruthy();
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(a.calls).toBe(2));
    cleanup();
    wrap(
      <WidgetCard
        ws={WS}
        meta={meta()}
        api={api(err('offline', 0))}
        filters={null}
        reloadKey={0}
      />,
    );
    expect(await screen.findByText(/You're offline/)).toBeTruthy();
  });

  it('is absent when the person cannot see its source, and says so only for unavailable metrics', async () => {
    const { container } = wrap(
      <WidgetCard
        ws={WS}
        meta={meta()}
        api={api({
          state: 'unavailable',
          metric: 'tasks.open',
          reason: 'no_access',
          message: 'This widget is not available to you.',
        })}
        filters={null}
        reloadKey={0}
      />,
    );
    await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull());
    expect(screen.queryByRole('region')).toBeNull();
    cleanup();
    wrap(
      <WidgetCard
        ws={WS}
        meta={meta({ metric: 'work.cycle_time', title: 'Cycle time' })}
        api={api({
          state: 'unavailable',
          metric: 'work.cycle_time',
          reason: 'not_available',
          message: 'This metric is not available.',
        })}
        filters={null}
        reloadKey={0}
      />,
    );
    expect(await screen.findByText('This metric is not available.')).toBeTruthy();
  });

  it('asks again when the filters or the refresh key change', async () => {
    const a = api(value());
    const { rerender } = wrap(
      <WidgetCard ws={WS} meta={meta()} api={a} filters={null} reloadKey={0} />,
    );
    await screen.findByLabelText('Open tasks: 12');
    rerender(
      <Router>
        <StepUpProvider>
          <WidgetCard
            ws={WS}
            meta={meta()}
            api={a}
            filters={{ ...NO_FILTERS, people: ['me'] }}
            reloadKey={0}
          />
        </StepUpProvider>
      </Router>,
    );
    await waitFor(() => expect(a.calls).toBe(2));
  });
});

describe('formatting (5D)', () => {
  it('shows exact figures for tooltips and compact ones above ten thousand', () => {
    expect(formatValue('count', 12_345).short).toMatch(/12\.3K|12\.3k|12K/i);
    expect(formatValue('count', 12_345).exact).toMatch(/12,?345/);
    expect(formatValue('seconds', 5400).short).toBe('1.5 h');
    expect(formatValue('percent', 41.5).exact).toBe('41.5 percent');
    expect(formatValue('count', null).short).toBe('—');
    expect(
      freshnessText({
        as_of: '2026-10-09T09:00:00.000Z',
        basis: 'derived',
        source_as_of: null,
        stale: true,
      }),
    ).toContain('out of date');
  });
});

describe('filters (5D)', () => {
  it('narrows by date, person, and status and can be cleared', () => {
    const onChange = vi.fn();
    wrap(<FilterBar ws={WS} value={NO_FILTERS} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Date range'), { target: { value: 'last_30_days' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...NO_FILTERS, range: { preset: 'last_30_days' } });
    fireEvent.change(screen.getByLabelText('Person'), { target: { value: 'me' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...NO_FILTERS, people: ['me'] });
    fireEvent.click(screen.getByLabelText('Active'));
    expect(onChange).toHaveBeenLastCalledWith({ ...NO_FILTERS, statuses: ['active'] });
  });
  it('offers custom dates and a clear button once something is chosen', () => {
    const onChange = vi.fn();
    wrap(
      <FilterBar
        ws={WS}
        value={{
          ...NO_FILTERS,
          range: { from: '2026-01-01', to: '2026-02-01' },
          statuses: ['done'],
        }}
        onChange={onChange}
      />,
    );
    expect(screen.getByLabelText('From')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onChange).toHaveBeenCalledWith(NO_FILTERS);
  });
});

const catalog: Catalog = {
  type: 'insight_metrics',
  metrics: [
    {
      key: 'tasks.open',
      version: 1,
      label: 'Open tasks',
      description: '',
      category: 'work',
      unit: 'count',
      source: { kind: 'work_query', label: 'q' },
      applies: { range: false, brands: true, projects: true, people: true, statuses: true },
    },
    {
      key: 'tasks.overdue',
      version: 1,
      label: 'Overdue tasks',
      description: '',
      category: 'work',
      unit: 'count',
      source: { kind: 'work_query', label: 'q' },
      applies: { range: false, brands: true, projects: true, people: true, statuses: true },
    },
  ],
  not_available: [
    {
      key: 'work.cycle_time',
      label: 'Cycle time',
      requirement: 'RPT-007',
      owner_phase: '5C',
      reason: 'Cycle time needs the metrics model definition.',
    },
  ],
};

describe('layout editor (5D)', () => {
  it('reorders, removes, and adds widgets from the keyboard and announces each change', async () => {
    vi.spyOn(insights, 'catalog').mockResolvedValue(catalog);
    const onSave = vi.fn().mockResolvedValue(undefined);
    wrap(
      <LayoutEditor
        ws={WS}
        widgets={[meta({ id: 'a', title: 'First' }), meta({ id: 'b', title: 'Second' })]}
        max={3}
        onSave={onSave}
        onClose={() => undefined}
      />,
    );
    await screen.findByText('Not available yet');
    fireEvent.click(screen.getByRole('button', { name: 'Move First down' }));
    expect(screen.getByRole('status').textContent).toMatch(/First moved to position 2 of 2/);
    fireEvent.change(screen.getByLabelText('Add a widget'), { target: { value: 'tasks.overdue' } });
    expect(screen.getByRole('status').textContent).toMatch(/Overdue tasks added/);
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByLabelText('Add a widget').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Second' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save widgets' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls[0]![0] as Array<{ id: string; metric: string }>;
    expect(saved.map((w) => w.id)).toEqual(['a', 'w1']);
    fireEvent.click(screen.getByText('Not available yet'));
    expect(screen.getByText(/Cycle time needs the metrics model definition/)).toBeTruthy();
  });

  it('keeps the person’s work and says what went wrong when saving fails', async () => {
    vi.spyOn(insights, 'catalog').mockResolvedValue(catalog);
    const onSave = vi.fn().mockRejectedValue(err('conflict', 409));
    wrap(
      <LayoutEditor
        ws={WS}
        widgets={[meta({ id: 'a', title: 'First' })]}
        max={3}
        onSave={onSave}
        onClose={() => undefined}
      />,
    );
    await screen.findByLabelText('Add a widget');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save widgets' }));
    await screen.findByRole('alert');
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Renamed');
  });
});

const dash = (over: Partial<Dashboard> = {}): Dashboard => ({
  id: 'dash_1',
  type: 'dashboard',
  title: 'Overview',
  description: null,
  kind: 'owner',
  scope: { kind: 'workspace' },
  owner: { id: 'mem_1', name: 'Ada Owner', type: 'member' },
  widgets: [
    meta({ id: 'a', title: 'Open tasks' }),
    meta({ id: 'b', title: 'Overdue tasks', metric: 'tasks.overdue' }),
  ],
  filters: NO_FILTERS,
  lifecycle_state: 'active',
  capabilities: { update: true, archive: true, restore: true, trash: true, export: true },
  created_at: null,
  updated_at: null,
  version: 2,
  ...over,
});
const rep = (over: Partial<Report> = {}): Report => ({
  id: 'rpt_1',
  type: 'report_definition',
  title: 'Weekly',
  description: null,
  scope: { kind: 'workspace' },
  owner: { id: 'mem_1', name: 'Ada Owner', type: 'member' },
  widgets: [meta({ id: 'a', title: 'Open tasks' })],
  filters: NO_FILTERS,
  access: 'placement',
  schedule: null,
  subscribed: false,
  recipients_count: null,
  shares_count: null,
  lifecycle_state: 'active',
  capabilities: {
    update: true,
    schedule: true,
    share: true,
    archive: true,
    restore: true,
    trash: true,
    export: true,
  },
  created_at: null,
  updated_at: null,
  version: 4,
  ...over,
});

describe('pages (5D)', () => {
  it('lists dashboards and reports and creates one with suggested widgets', async () => {
    vi.spyOn(dashboards, 'list').mockResolvedValue({
      data: [dash()],
      page: { limit: 25, has_more: false },
    });
    vi.spyOn(reports, 'list').mockResolvedValue({
      data: [
        rep({
          schedule: {
            frequency: 'weekly',
            weekday: 1,
            monthday: null,
            minute: 480,
            timezone: 'UTC',
            description: 'Every Monday at 08:00 UTC',
            next_run_at: null,
            last_run_at: null,
            suspended: { reason: 'owner_departed', at: null },
          },
        }),
      ],
      page: { limit: 25, has_more: false },
    });
    const create = vi.spyOn(dashboards, 'create').mockResolvedValue(dash({ id: 'dash_2' }));
    wrap(<ReportsPage ws={WS} />);
    expect(await screen.findByRole('link', { name: 'Overview' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Weekly' })).toBeTruthy();
    expect(screen.getByText(/Every Monday at 08:00 UTC · Paused/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New dashboard' }));
    fireEvent.change(await screen.findByLabelText(/Title/), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create dashboard' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const body = create.mock.calls[0]![1];
    expect(body).toMatchObject({ title: 'Mine', kind: 'personal' });
    expect(body.layout?.widgets.map((w) => w.metric)).toContain('tasks.open');
  });

  it('shows a dashboard to a viewer without edit rights and hides edit actions', async () => {
    vi.spyOn(dashboards, 'get').mockResolvedValue(
      dash({
        capabilities: {
          update: false,
          archive: false,
          restore: false,
          trash: false,
          export: false,
        },
      }),
    );
    vi.spyOn(dashboards, 'widget').mockResolvedValue({
      type: 'widget_result',
      widget: meta(),
      filters: NO_FILTERS,
      outcome: value(),
    });
    wrap(<DashboardPage ws={WS} dash="dash_1" />);
    expect(await screen.findByRole('heading', { name: 'Overview', level: 1 })).toBeTruthy();
    await screen.findAllByLabelText('Open tasks: 12');
    expect(screen.queryByRole('button', { name: 'Edit widgets' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export all as CSV' })).toBeNull();
    expect(screen.getByRole('link', { name: 'All dashboards and reports' })).toBeTruthy();
  });

  it('exports with the filters currently on screen and saves the file', async () => {
    vi.spyOn(dashboards, 'get').mockResolvedValue(dash());
    vi.spyOn(dashboards, 'widget').mockResolvedValue({
      type: 'widget_result',
      widget: meta(),
      filters: NO_FILTERS,
      outcome: value(),
    });
    const exp = vi
      .spyOn(dashboards, 'export')
      .mockResolvedValue({
        blob: new Blob(['x']),
        filename: 'overview.csv',
        contentType: 'text/csv',
      });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    wrap(<DashboardPage ws={WS} dash="dash_1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Export all as CSV' }));
    await waitFor(() =>
      expect(exp).toHaveBeenCalledWith(WS, 'dash_1', { format: 'csv', filters: null }),
    );
    expect(await screen.findByText('Exported CSV.')).toBeTruthy();
  });

  it('says a paused schedule is paused and why, and lets an authorized person take it over', async () => {
    const paused = rep({
      recipients_count: 2,
      schedule: {
        frequency: 'weekly',
        weekday: 1,
        monthday: null,
        minute: 480,
        timezone: 'UTC',
        description: 'Every Monday at 08:00 UTC',
        next_run_at: null,
        last_run_at: null,
        suspended: { reason: 'owner_departed', at: null },
      },
    });
    vi.spyOn(reports, 'get').mockResolvedValue(paused);
    vi.spyOn(reports, 'widget').mockResolvedValue({
      type: 'widget_result',
      widget: meta(),
      filters: NO_FILTERS,
      outcome: value(),
    });
    const resume = vi.spyOn(reports, 'resume').mockResolvedValue(rep());
    wrap(<ReportPage ws={WS} report="rpt_1" />);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/This schedule is paused/)).toBeTruthy();
    expect(within(alert).getByText(/left the workspace/)).toBeTruthy();
    fireEvent.click(within(alert).getByRole('button', { name: 'Resume and take over' }));
    await waitFor(() => expect(resume).toHaveBeenCalled());
    expect(await screen.findByText(/You are now accountable for it/)).toBeTruthy();
  });

  it('a person who reaches a report only through a share cannot edit, schedule, or share it', async () => {
    vi.spyOn(reports, 'get').mockResolvedValue(
      rep({
        access: 'share',
        scope: { kind: 'shared' },
        capabilities: {
          update: false,
          schedule: false,
          share: false,
          archive: false,
          restore: false,
          trash: false,
          export: false,
        },
      }),
    );
    vi.spyOn(reports, 'widget').mockResolvedValue({
      type: 'widget_result',
      widget: meta(),
      filters: NO_FILTERS,
      outcome: value({ covers: 'The records shared with you' }),
    });
    wrap(<ReportPage ws={WS} report="rpt_1" />);
    await screen.findByText(/The records shared with you/);
    for (const name of ['Edit widgets', 'Schedule', 'Recipients', 'Share', 'Move to trash'])
      expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('a revoked or unknown report is the one not-available state', async () => {
    vi.spyOn(reports, 'get').mockRejectedValue(err('not_found', 404));
    wrap(<ReportPage ws={WS} report="rpt_gone" />);
    expect(await screen.findByText(/may have been moved or deleted/i)).toBeTruthy();
  });

  it('lets a recipient stop their own emails', async () => {
    vi.spyOn(reports, 'get').mockResolvedValue(
      rep({
        subscribed: true,
        capabilities: {
          update: false,
          schedule: false,
          share: false,
          archive: false,
          restore: false,
          trash: false,
          export: false,
        },
      }),
    );
    vi.spyOn(reports, 'widget').mockResolvedValue({
      type: 'widget_result',
      widget: meta(),
      filters: NO_FILTERS,
      outcome: value(),
    });
    const leave = vi.spyOn(reports, 'leave').mockResolvedValue(rep());
    wrap(<ReportPage ws={WS} report="rpt_1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop emailing me this report' }));
    await waitFor(() => expect(leave).toHaveBeenCalled());
  });
});

describe('routes (5D)', () => {
  const member: Access = {
    principal: 'member',
    capabilities: {} as never,
    hidden: [],
  } as unknown as Access;
  const guest: Access = {
    principal: 'guest',
    capabilities: {} as never,
    hidden: [],
  } as unknown as Access;
  it('registers the Reports destination, the dashboard, and the report routes', () => {
    expect(matchRoute('/workspaces/ws_A/reports')?.def.id).toBe('reports');
    expect(matchRoute('/workspaces/ws_A/reports/rpt_1')?.def.id).toBe('report');
    expect(matchRoute('/workspaces/ws_A/dashboards/dash_1')?.def.id).toBe('dashboard');
    expect(routeHref('dashboard', { ws: 'ws_A', dash: 'dash_1' })).toBe(
      '/workspaces/ws_A/dashboards/dash_1',
    );
    expect(ROUTE_INDEX.get('reports')?.phase).toBeNull();
  });
  it('shows dashboards to members only, and a report to anyone it was shared with', () => {
    expect(canSee(ROUTE_INDEX.get('dashboard')!, member)).toBe(true);
    expect(canSee(ROUTE_INDEX.get('dashboard')!, guest)).toBe(false);
    expect(canSee(ROUTE_INDEX.get('report')!, guest)).toBe(true);
    expect(canSee(ROUTE_INDEX.get('reports')!, guest)).toBe(false);
  });
});

void act;
