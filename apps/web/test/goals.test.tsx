import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import {
  goals,
  portfolios,
  type Checkin,
  type CreatedCheckin,
  type Goal,
  type GoalDetail,
  type KeyResult,
  type PageOf,
  type Portfolio,
  type PortfolioDependencies,
  type PortfolioOrphans,
  type PortfolioOverview,
  type PortfolioProject,
  type Progress,
} from '../src/goals/client.ts';
import { useIdempotency } from '../src/goals/hooks.ts';
import { currentQuarter, rangeOf, shiftSel } from '../src/goals/periods.ts';
import { ProjectGoalsCard } from '../src/goals/project-goals.tsx';
import { ProgressView } from '../src/goals/shared.tsx';
import { TrashSection } from '../src/goals/trash.tsx';
import { GoalPage } from '../src/pages/goal-detail-pages.tsx';
import { GoalsPage } from '../src/pages/goal-pages.tsx';
import { PortfolioPage } from '../src/pages/portfolio-pages.tsx';
import { projects } from '../src/projects/client.ts';
import { Router } from '../src/router.tsx';
import {
  canSee,
  matchRoute,
  navEntries,
  ROUTE_INDEX,
  routeHref,
  type Access,
} from '../src/shell/registry.ts';
import { StepUpProvider } from '../src/stepup.tsx';
import { collab as people, tenancy } from '../src/tenancy/client.ts';

/**
 * Phase 5B web (goals, key results, check-ins, linked work, portfolio health): what is rendered
 * from the API's own figures, explanations and incompleteness, guests, conflict recovery that keeps
 * typed text, check-in retries that cannot double-submit, read-only states, and keyboard behaviour.
 */

// Pages register palette commands; the provider itself is covered by the shell tests.
vi.mock('../src/shell/commands.tsx', async (orig) => ({
  ...(await orig<typeof import('../src/shell/commands.tsx')>()),
  useRegisterCommands: vi.fn(),
}));

const WS = 'ws_A';
const BASE = '/workspaces/ws_A';

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.spyOn(people, 'people').mockResolvedValue([]);
  vi.spyOn(projects, 'list').mockResolvedValue({ data: [], total: null });
  vi.spyOn(tenancy, 'listBrands').mockResolvedValue({ data: [], page: { has_more: false } });
  vi.spyOn(portfolios, 'list').mockResolvedValue(page([]));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

const wrap = (ui: React.ReactNode) =>
  render(
    <Router>
      <StepUpProvider>{ui}</StepUpProvider>
    </Router>,
  );
const err = (
  code: string,
  status: number,
  extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {},
) => new ApiError({ code, status, message: code, ...extra });
function page<T>(data: T[], extra: Partial<PageOf<T>> = {}): PageOf<T> {
  return { data, page: { limit: 25, has_more: false }, ...extra };
}

const harbor = {
  kind: 'brand' as const,
  id: 'br_harbor',
  name: 'Harbor',
  short_name: null,
  color: '#1d5bd6',
  icon: 'circle',
  archived: false,
};
const progress = (over: Partial<Progress> = {}): Progress => ({
  percent: 40,
  source: 'manual_percent',
  explanation: 'The percentage in the latest check-in.',
  work: null,
  key_results: null,
  incomplete: [],
  ...over,
});
const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 'goal_1',
  type: 'goal',
  title: 'Grow signups',
  description: null,
  scope: { kind: 'workspace' },
  owner: { id: 'mem_1', name: 'Ada Owner', type: 'member' },
  status: 'active',
  period: {
    kind: 'quarter',
    start: '2026-10-01',
    end: '2026-12-31',
    label: '2026 Q4',
    calendar: true,
    state: 'current',
  },
  basis: 'manual',
  metric: { unit: null, baseline: null, target: null, current: null },
  progress: progress(),
  latest: { checkin: 'gci_1', at: '2026-10-05T10:00:00.000Z', confidence: 'at_risk' },
  freshness: {
    update_state: 'fresh',
    period_state: 'current',
    stale_after_days: 14,
    recalculation: { state: 'current', computed_at: '2026-10-05T10:00:00.000Z' },
  },
  work: { visible_links: 3, active_links: 2, relative_to: 'viewer' },
  key_results_count: 0,
  lifecycle_state: 'active',
  version: 3,
  ...over,
});
const kr = (id: string, title: string, over: Partial<KeyResult> = {}): KeyResult => ({
  id,
  type: 'key_result',
  title,
  owner: { id: 'mem_1', name: 'Ada Owner', type: 'member' },
  basis: 'manual',
  metric: { unit: null, baseline: null, target: null, current: null },
  progress: progress({ percent: 25 }),
  latest: { checkin: null, at: null, confidence: null },
  lifecycle_state: 'active',
  version: 1,
  ...over,
});
const CAPS = { update: true, check_in: true, archive: true, trash: true };
const detail = (over: Partial<GoalDetail> = {}): GoalDetail => ({
  ...goal(),
  key_results: [],
  links: [],
  capabilities: { ...CAPS },
  as_of: '2026-10-08T10:00:00.000Z',
  ...over,
});
const created = (over: Partial<CreatedCheckin> = {}): CreatedCheckin => ({
  id: 'gci_9',
  type: 'goal_checkin',
  source: 'manual',
  key_result: null,
  value: null,
  progress_percent: null,
  confidence: 'at_risk',
  note: 'Shipped the beta',
  author: { id: 'mem_1', name: 'Ada Owner', type: 'member' },
  created_at: '2026-10-08T10:00:00.000Z',
  goal: { id: 'goal_1', version: 4 },
  confidence_label: 'At risk',
  ...over,
});

// -----------------------------------------------------------------------------------------------

describe('routes and guests', () => {
  const caps = {} as Access['capabilities'];
  const member: Access = { principal: 'member', capabilities: caps, hidden: [] };
  const guest: Access = { principal: 'guest', capabilities: caps, hidden: [] };

  it('goals, a goal, and the portfolio are canonical routes; the portfolio wins over a project id', () => {
    expect(matchRoute(`${BASE}/goals`)?.def.id).toBe('goals');
    expect(matchRoute(`${BASE}/goals/goal_1`)).toMatchObject({
      def: { id: 'goal' },
      params: { ws: 'ws_A', goal: 'goal_1' },
    });
    expect(matchRoute(`${BASE}/projects/portfolio`)?.def.id).toBe('portfolio');
    expect(matchRoute(`${BASE}/projects/prj_1`)?.def.id).toBe('project');
    expect(routeHref('goal', { ws: 'ws_A', goal: 'goal_1' })).toBe(`${BASE}/goals/goal_1`);
  });

  it('guests get no Goals or Portfolio navigation or routes; members do', () => {
    for (const id of ['goals', 'goal', 'portfolio'])
      expect(canSee(ROUTE_INDEX.get(id)!, guest), id).toBe(false);
    for (const id of ['goals', 'goal', 'portfolio'])
      expect(canSee(ROUTE_INDEX.get(id)!, member), id).toBe(true);
    expect(navEntries('primary', guest).map((r) => r.id)).not.toContain('goals');
    expect(navEntries('workspace', guest).map((r) => r.id)).not.toContain('portfolio');
    expect(navEntries('primary', member).map((r) => r.id)).toContain('goals');
    expect(navEntries('workspace', member).map((r) => r.id)).toContain('portfolio');
    // A destination a person hid stays hidden (the same predicate as every other surface).
    expect(navEntries('primary', { ...member, hidden: ['goals'] }).map((r) => r.id)).not.toContain(
      'goals',
    );
  });

  it('the Goals destination is no longer an unavailable placeholder', () => {
    expect(ROUTE_INDEX.get('goals')?.phase).toBeNull();
  });
});

describe('progress and its explanation', () => {
  it('a progress bar has a value and text; the rule is in a disclosure with incompleteness', () => {
    render(
      <ProgressView
        label="Progress of Launch"
        progress={progress({
          percent: 25,
          source: 'linked_work',
          explanation: 'Done tasks as a share of the tasks you can read.',
          work: { done: 1, total: 4 },
          incomplete: ['no_readable_work'],
        })}
      />,
    );
    const bar = screen.getByRole('progressbar', { name: 'Progress of Launch' });
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
    expect(bar.getAttribute('aria-valuetext')).toBe('25 percent');
    expect(screen.getByText('25%')).toBeTruthy();
    const summary = screen.getByText('How is this calculated?').closest('summary')!;
    const details = summary.closest('details')!;
    expect(details.querySelector('summary')).toBe(summary);
    expect(
      within(details).getByText('Done tasks as a share of the tasks you can read.'),
    ).toBeTruthy();
    expect(
      within(details).getByText(
        /1 of 4 tasks you can read is done|1 of 4 tasks you can read are done/,
      ),
    ).toBeTruthy();
    expect(within(details).getByText(/nothing to count/)).toBeTruthy();
    fireEvent.click(summary);
    expect(details.open).toBe(true);
  });

  it('no measurement is text, not an empty bar passed off as zero', () => {
    render(
      <ProgressView
        label="Progress of X"
        progress={progress({ percent: null, incomplete: ['no_measurement'] })}
      />,
    );
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(bar.getAttribute('aria-valuetext')).toBe('No progress measured yet');
    expect(screen.getByText('No progress yet')).toBeTruthy();
    expect(screen.getByText('No measurement has been recorded yet.')).toBeTruthy();
  });
});

describe('periods', () => {
  it('the default is the current quarter and moves by quarter across years', () => {
    const q = currentQuarter(new Date(2026, 9, 8));
    expect(rangeOf(q)).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(rangeOf(shiftSel(q, 1))).toEqual({ from: '2027-01-01', to: '2027-03-31' });
    expect(rangeOf(shiftSel(q, -1))).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(rangeOf({ ...q, mode: 'custom', start: '2026-10-05', end: '2026-10-01' })).toBeNull();
  });
});

describe('Goals list', () => {
  const ws = goal({ id: 'goal_ws', title: 'Reach 1,000 users' });
  const brandGoal = goal({
    id: 'goal_b',
    title: 'Win Harbor renewals',
    scope: { kind: 'brand', brand: harbor },
    progress: progress({ percent: null, incomplete: ['no_measurement'] }),
    latest: { checkin: null, at: null, confidence: null },
    freshness: {
      update_state: 'never',
      period_state: 'current',
      stale_after_days: 14,
      recalculation: { state: 'current', computed_at: null },
    },
    work: { visible_links: 0, active_links: 0, relative_to: 'viewer' },
  });
  const stale = goal({
    id: 'goal_s',
    title: 'Ship the API',
    scope: { kind: 'project', brand: harbor, project: { id: 'prj_1', name: 'API' } },
    freshness: {
      update_state: 'stale',
      period_state: 'current',
      stale_after_days: 14,
      recalculation: { state: 'failing', computed_at: null },
    },
    work: { visible_links: 2, active_links: 0, relative_to: 'viewer' },
  });
  const listed = () =>
    vi.spyOn(goals, 'list').mockResolvedValue(
      page([brandGoal, stale, ws], {
        as_of: '2026-10-08T10:00:00.000Z',
        scope_note:
          'Only goals you can read are listed; progress from linked work covers the work you can read.',
      }),
    );

  it('shows workspace goals first, then per brand, each with progress, rule, confidence, freshness, and linked work', async () => {
    listed();
    wrap(<GoalsPage ws={WS} />);
    await screen.findByRole('heading', { level: 2, name: 'Workspace goals' });
    const order = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent ?? '')
      .filter((t) => t === 'Workspace goals' || t.includes('Harbor'));
    expect(order[0]).toBe('Workspace goals');
    expect(order[1]).toContain('Harbor');
    expect(screen.getByText(/Only goals you can read are listed/)).toBeTruthy();
    expect(screen.getByText(/As of /)).toBeTruthy();
    // Progress with its rule for every row.
    expect(screen.getAllByRole('progressbar')).toHaveLength(3);
    expect(screen.getAllByText('How is this calculated?', { exact: false })).toHaveLength(3);
    // Confidence, freshness, and the viewer-relative linked work cues.
    expect(screen.getAllByText('At risk').length).toBeGreaterThan(0);
    expect(screen.getByText('No update yet')).toBeTruthy();
    expect(screen.getByText(/^Stale: last updated/)).toBeTruthy();
    expect(screen.getByText('Recalculation failing')).toBeTruthy();
    expect(screen.getByText(/3 linked work items you can see, 2 active\./)).toBeTruthy();
    expect(screen.getByText(/^No linked work you can see\./)).toBeTruthy();
    expect(screen.getAllByText('No active work you can see')).toHaveLength(2);
    expect(screen.getAllByText(/Owner: Ada Owner/)).toHaveLength(3);
    const link = screen.getByRole('link', { name: 'Ship the API' });
    expect(link.getAttribute('href')).toBe(`${BASE}/goals/goal_s`);
  });

  it('asks for the current quarter and moves with the period buttons', async () => {
    const list = listed();
    wrap(<GoalsPage ws={WS} />);
    await screen.findByRole('heading', { level: 2, name: 'Workspace goals' });
    const q = currentQuarter();
    const first = list.mock.calls[0]![1]!;
    expect({ from: first.from, to: first.to }).toEqual(rangeOf(q));
    fireEvent.click(screen.getByRole('button', { name: 'Next quarter' }));
    await waitFor(() => {
      const last = list.mock.calls.at(-1)![1]!;
      expect({ from: last.from, to: last.to }).toEqual(rangeOf(shiftSel(q, 1)));
    });
    expect(screen.getByText(/Showing goals whose period overlaps/)).toBeTruthy();
  });

  it('filters are sent to the API, and archived goals are an explicit switch', async () => {
    const list = listed();
    wrap(<GoalsPage ws={WS} />);
    await screen.findByRole('heading', { level: 2, name: 'Workspace goals' });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'active' } });
    fireEvent.change(screen.getByLabelText('Update freshness'), { target: { value: 'stale' } });
    fireEvent.click(screen.getByLabelText('Show archived goals instead'));
    await waitFor(() => {
      const last = list.mock.calls.at(-1)![1]!;
      expect(last).toMatchObject({ status: 'active', update: 'stale', archived: 'true' });
    });
  });

  it('an empty period says so and offers to create a goal', async () => {
    vi.spyOn(goals, 'list').mockResolvedValue(page([]));
    wrap(<GoalsPage ws={WS} />);
    expect(await screen.findByText(/No goals match for/)).toBeTruthy();
    expect(
      screen.getAllByRole('button', { name: /Create goal|Create a goal/ }).length,
    ).toBeGreaterThan(0);
  });

  it('a failed load offers a retry; offline reads as offline', async () => {
    const list = vi
      .spyOn(goals, 'list')
      .mockRejectedValueOnce(err('offline', 0))
      .mockResolvedValueOnce(page([ws]));
    wrap(<GoalsPage ws={WS} />);
    expect(await screen.findByText("You're offline")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { level: 2, name: 'Workspace goals' });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('exports with the current filters and announces the file', async () => {
    listed();
    const file = vi.spyOn(goals, 'exportFile').mockResolvedValue({
      text: 'a,b',
      filename: 'goals-2026-10-08.csv',
      contentType: 'text/csv',
    });
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    wrap(<GoalsPage ws={WS} />);
    await screen.findByRole('heading', { level: 2, name: 'Workspace goals' });
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText('Exported goals-2026-10-08.csv.')).toBeTruthy();
    expect(file.mock.calls[0]![1]).toBe('csv');
  });
});

describe('creating a goal', () => {
  it('the dialog closes with Escape and returns focus to the button that opened it', async () => {
    vi.spyOn(goals, 'list').mockResolvedValue(page([]));
    wrap(<GoalsPage ws={WS} />);
    await screen.findByText(/No goals match for/);
    const opener = screen.getAllByRole('button', { name: 'Create goal' })[0]!;
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Create goal' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('a brand goal needs an explicit brand choice; nothing is sent until one is made', async () => {
    vi.spyOn(goals, 'list').mockResolvedValue(page([]));
    vi.spyOn(tenancy, 'listBrands').mockResolvedValue({
      data: [{ id: 'br_harbor', name: 'Harbor' } as never],
      page: { has_more: false },
    });
    const create = vi.spyOn(goals, 'create').mockResolvedValue(detail());
    wrap(<GoalsPage ws={WS} />);
    await screen.findByText(/No goals match for/);
    fireEvent.click(screen.getAllByRole('button', { name: 'Create goal' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Create goal' });
    fireEvent.change(within(dialog).getByLabelText(/^Title/), {
      target: { value: 'Win renewals' },
    });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'One brand' }));
    const brand = within(dialog).getByLabelText(/^Brand/) as HTMLSelectElement;
    expect(brand.value).toBe('');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create goal' }));
    expect(
      await within(dialog).findAllByText(/Choose which brand this goal belongs to/),
    ).not.toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
    await waitFor(() => expect(brand.querySelectorAll('option')).toHaveLength(2));
    fireEvent.change(brand, { target: { value: 'br_harbor' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create goal' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const body = create.mock.calls[0]![1];
    expect(body).toMatchObject({
      title: 'Win renewals',
      brand: 'br_harbor',
      status: 'active',
      basis: 'manual',
    });
    expect(body.period.kind).toBe('quarter');
  });

  it('validation errors from the API point at the field and keep what was typed', async () => {
    vi.spyOn(goals, 'list').mockResolvedValue(page([]));
    vi.spyOn(goals, 'create').mockRejectedValue(
      err('validation_failed', 422, {
        issues: [
          {
            pointer: '/metric/target',
            code: 'invalid_number',
            message: 'The target must differ from the baseline.',
          },
        ],
      }),
    );
    wrap(<GoalsPage ws={WS} />);
    await screen.findByText(/No goals match for/);
    fireEvent.click(screen.getAllByRole('button', { name: 'Create goal' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Create goal' });
    fireEvent.change(within(dialog).getByLabelText(/^Title/), { target: { value: 'Keep me' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create goal' }));
    expect(
      await within(dialog).findAllByText('The target must differ from the baseline.'),
    ).not.toHaveLength(0);
    expect((within(dialog).getByLabelText(/^Title/) as HTMLInputElement).value).toBe('Keep me');
  });
});

describe('goal page', () => {
  it('shows progress with its rule, key results, only the links returned, and the freshness state', async () => {
    vi.spyOn(goals, 'get').mockResolvedValue(
      detail({
        basis: 'key_results',
        progress: progress({
          percent: 25,
          source: 'key_results',
          explanation: 'The plain average of the key results that have a measurement.',
          key_results: { counted: 1, total: 2 },
          incomplete: ['unmeasured_key_results'],
        }),
        key_results: [
          kr('kr_1', 'Reach 1,000 users'),
          kr('kr_2', 'Cut churn', {
            progress: progress({ percent: null, incomplete: ['no_measurement'] }),
          }),
        ],
        key_results_count: 2,
        links: [
          {
            target: {
              id: 'prj_1',
              type: 'project',
              name: 'Launch site',
              status_category: 'active',
              brand: harbor,
            },
            key_result: null,
          },
        ],
        work: { visible_links: 1, active_links: 1, relative_to: 'viewer' },
        freshness: {
          update_state: 'stale',
          period_state: 'current',
          stale_after_days: 14,
          recalculation: { state: 'failing', computed_at: null },
        },
      }),
    );
    vi.spyOn(goals, 'checkins').mockResolvedValue(page([]));
    wrap(<GoalPage ws={WS} goal="goal_1" />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Grow signups' })).toBeTruthy();
    expect(
      screen.getByText('The plain average of the key results that have a measurement.'),
    ).toBeTruthy();
    expect(screen.getByText(/1 of 2 key results has a measurement/)).toBeTruthy();
    expect(screen.getByText(/left out of the average/)).toBeTruthy();
    expect(
      screen.getByRole('progressbar', { name: 'Progress of key result Reach 1,000 users' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Launch site' }).getAttribute('href')).toBe(
      `${BASE}/projects/prj_1`,
    );
    expect(screen.getByText(/can differ between people/)).toBeTruthy();
    expect(screen.getByText('The last check-in is more than 14 days old.')).toBeTruthy();
    expect(
      screen.getByText('Recalculation is failing; stored figures may be out of date.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Recalculate now' })).toBeTruthy();
    // Headings stay in order: one h1, sections as h2, rows as h3.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 3, name: 'Cut churn' })).toBeTruthy();
  });

  it('Recalculate now calls the endpoint and says it is done', async () => {
    vi.spyOn(goals, 'get').mockResolvedValue(
      detail({
        freshness: {
          update_state: 'fresh',
          period_state: 'current',
          stale_after_days: 14,
          recalculation: { state: 'pending', computed_at: null },
        },
      }),
    );
    vi.spyOn(goals, 'checkins').mockResolvedValue(page([]));
    const recalc = vi.spyOn(goals, 'recalculate').mockResolvedValue(detail({ version: 4 }));
    wrap(<GoalPage ws={WS} goal="goal_1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Recalculate now' }));
    expect(await screen.findByText('Recalculated.')).toBeTruthy();
    expect(recalc).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Recalculate now' })).toBeNull();
  });

  it('an archived goal is read-only and says why', async () => {
    vi.spyOn(goals, 'get').mockResolvedValue(
      detail({
        lifecycle_state: 'archived',
        capabilities: { update: false, check_in: false, archive: true, trash: true },
        key_results: [kr('kr_1', 'Reach 1,000 users')],
      }),
    );
    vi.spyOn(goals, 'checkins').mockResolvedValue(page([]));
    wrap(<GoalPage ws={WS} goal="goal_1" />);
    expect(await screen.findByText('This goal is archived')).toBeTruthy();
    expect(screen.getByText(/It is read-only/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit goal' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record check-in' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add key result' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Link work' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Edit Reach/ })).toBeNull();
    expect(screen.getByText('This goal is archived, so check-ins are closed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restore from archive' })).toBeTruthy();
  });

  it('a closed goal explains that check-ins are closed', async () => {
    vi.spyOn(goals, 'get').mockResolvedValue(
      detail({
        status: 'achieved',
        capabilities: { update: true, check_in: false, archive: true, trash: true },
      }),
    );
    vi.spyOn(goals, 'checkins').mockResolvedValue(page([]));
    wrap(<GoalPage ws={WS} goal="goal_1" />);
    expect(await screen.findByText('This goal is achieved')).toBeTruthy();
    expect(screen.getByText(/Check-ins are closed\. Set the status back to Active/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record check-in' })).toBeNull();
  });

  it('a goal that is no longer available shows the standard state and nothing about it', async () => {
    for (const code of ['not_found', 'forbidden'] as const) {
      vi.spyOn(goals, 'get').mockRejectedValue(err(code, code === 'forbidden' ? 403 : 404));
      const view = wrap(<GoalPage ws={WS} goal="goal_1" />);
      expect(
        await screen.findByRole('heading', { level: 1, name: "This page isn't available" }),
      ).toBeTruthy();
      expect(screen.queryByText('Grow signups')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      view.unmount();
      vi.restoreAllMocks();
      vi.spyOn(people, 'people').mockResolvedValue([]);
    }
  });

  it('access revoked mid-session: the next write switches the page to the standard state', async () => {
    vi.spyOn(goals, 'get').mockResolvedValue(detail());
    vi.spyOn(goals, 'checkins').mockResolvedValue(page([]));
    vi.spyOn(goals, 'checkin').mockRejectedValue(err('not_found', 404));
    wrap(<GoalPage ws={WS} goal="goal_1" />);
    fireEvent.change(await screen.findByLabelText('Note (optional)'), {
      target: { value: 'hello' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record check-in' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: "This page isn't available" }),
    ).toBeTruthy();
    expect(screen.queryByText('Grow signups')).toBeNull();
  });

  it('moving a key result sends the one it should follow', async () => {
    const krs = [kr('kr_a', 'A'), kr('kr_b', 'B'), kr('kr_c', 'C')];
    vi.spyOn(goals, 'get').mockResolvedValue(detail({ basis: 'key_results', key_results: krs }));
    vi.spyOn(goals, 'checkins').mockResolvedValue(page([]));
    const update = vi.spyOn(goals, 'updateKeyResult').mockResolvedValue(krs[0]!);
    wrap(<GoalPage ws={WS} goal="goal_1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Move down: A/ }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0]!.slice(1, 5)).toEqual(['goal_1', 'kr_a', 1, { after: 'kr_b' }]);
    expect((screen.getByRole('button', { name: /Move up: A/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('removing a link is a labelled action that names the work', async () => {
    vi.spyOn(goals, 'get').mockResolvedValue(
      detail({
        links: [
          {
            target: {
              id: 'tsk_1',
              type: 'task',
              name: 'Fix login',
              status_category: 'active',
              brand: harbor,
            },
            key_result: null,
          },
        ],
      }),
    );
    vi.spyOn(goals, 'checkins').mockResolvedValue(page([]));
    const remove = vi.spyOn(goals, 'removeLink').mockResolvedValue(detail());
    wrap(<GoalPage ws={WS} goal="goal_1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove link to Fix login' }));
    await waitFor(() => expect(remove).toHaveBeenCalled());
    expect(remove.mock.calls[0]!.slice(1, 4)).toEqual(['goal_1', 'tsk_1', null]);
  });
});

describe('linked-work drill-down', () => {
  it('lists the tasks behind a linked-work figure from the server, with its coverage note', async () => {
    vi.spyOn(goals, 'checkins').mockResolvedValue(page([]));
    vi.spyOn(goals, 'get').mockResolvedValue(
      detail({
        basis: 'linked_work',
        progress: progress({ percent: 50, source: 'linked_work', work: { done: 1, total: 2 } }),
      }),
    );
    const work = vi.spyOn(goals, 'work').mockResolvedValue({
      type: 'goal_work',
      data: [
        {
          id: 'tsk_1',
          type: 'task',
          title: 'Fix login',
          status: { category: 'done' },
          done: true,
          due_date: null,
          project: { id: 'prj_1', name: 'Apollo' },
        },
        {
          id: 'tsk_2',
          type: 'task',
          title: 'Write docs',
          status: { category: 'active' },
          done: false,
          due_date: '2026-10-20',
          project: null,
        },
      ],
      summary: { done: 1, total: 2 },
      coverage: {
        truncated: false,
        relative_to: 'viewer',
        note: 'Tasks you can read inside the linked projects.',
      },
      as_of: '2026-10-08T10:00:00.000Z',
    });
    wrap(<GoalPage ws={WS} goal="goal_1" />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Show the tasks counted' }))[0]!);
    const region = await screen.findByRole('region', { name: 'Tasks counted' });
    expect(work.mock.calls[0]!.slice(1)).toEqual(['goal_1', undefined]);
    expect(within(region).getByRole('link', { name: 'Write docs' }).getAttribute('href')).toBe(
      `${BASE}/tasks/tsk_2`,
    );
    expect(within(region).getByText('Tasks you can read inside the linked projects.')).toBeTruthy();
  });
});

describe('editing with a version conflict', () => {
  it('keeps what was typed, offers the latest version, and then saves against it', async () => {
    const get = vi.spyOn(goals, 'get').mockResolvedValue(detail({ version: 3 }));
    vi.spyOn(goals, 'checkins').mockResolvedValue(page([]));
    const update = vi
      .spyOn(goals, 'update')
      .mockRejectedValueOnce(err('conflict', 409, { conflict: { current_version: 4 } }))
      .mockResolvedValueOnce(detail({ version: 5, title: 'My title' }));
    wrap(<GoalPage ws={WS} goal="goal_1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit goal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit goal' });
    fireEvent.change(within(dialog).getByLabelText(/^Title/), { target: { value: 'My title' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(
      await within(dialog).findByText('This goal changed while you were editing'),
    ).toBeTruthy();
    expect(update.mock.calls[0]![2]).toBe(3);
    expect((within(dialog).getByLabelText(/^Title/) as HTMLInputElement).value).toBe('My title');

    get.mockResolvedValue(detail({ version: 4, description: 'Changed by someone else' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Load latest version' }));
    expect(await within(dialog).findByText('Latest version loaded')).toBeTruthy();
    expect((within(dialog).getByLabelText(/^Title/) as HTMLInputElement).value).toBe('My title');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    // The retry carries the latest version and only the field this person changed.
    expect(update.mock.calls[1]![2]).toBe(4);
    expect(update.mock.calls[1]![3]).toEqual({ title: 'My title' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Goal saved.')).toBeTruthy();
  });

  it('a lifecycle conflict says to reload and offers it', async () => {
    const get = vi.spyOn(goals, 'get').mockResolvedValue(detail());
    vi.spyOn(goals, 'checkins').mockResolvedValue(page([]));
    vi.spyOn(goals, 'verb').mockRejectedValue(err('precondition_failed', 412));
    wrap(<GoalPage ws={WS} goal="goal_1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Archive this goal?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive goal' }));
    const reload = await screen.findAllByRole('button', { name: 'Reload the latest version' });
    get.mockClear();
    fireEvent.click(reload[0]!);
    await waitFor(() => expect(get).toHaveBeenCalled());
  });
});

describe('check-ins', () => {
  const fill = async () => {
    fireEvent.change(await screen.findByLabelText('Note (optional)'), {
      target: { value: 'Shipped the beta' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'At risk' }));
  };

  it('keeps the draft and reuses the same Idempotency-Key when a failed send is retried', async () => {
    vi.spyOn(goals, 'get').mockResolvedValue(detail());
    vi.spyOn(goals, 'checkins').mockResolvedValue(page([]));
    const checkin = vi
      .spyOn(goals, 'checkin')
      .mockRejectedValueOnce(err('network', 0))
      .mockResolvedValueOnce(created());
    wrap(<GoalPage ws={WS} goal="goal_1" />);
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Record check-in' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/offline or the connection dropped/)).toBeTruthy();
    expect(within(alert).getByText(/cannot record it twice/)).toBeTruthy();
    expect((screen.getByLabelText('Note (optional)') as HTMLTextAreaElement).value).toBe(
      'Shipped the beta',
    );
    expect((screen.getByRole('radio', { name: 'At risk' }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(checkin).toHaveBeenCalledTimes(2));
    const [first, second] = checkin.mock.calls;
    expect(first![4]).toMatch(/^web-/);
    expect(second![4]).toBe(first![4]);
    expect(second![2]).toEqual(first![2]);
    expect(first![2]).toEqual({ confidence: 'at_risk', note: 'Shipped the beta' });
    await waitFor(() =>
      expect((screen.getByLabelText('Note (optional)') as HTMLTextAreaElement).value).toBe(''),
    );
    expect(screen.getAllByText('Check-in recorded.').length).toBeGreaterThan(0);
  });

  it('a changed draft is a new request with a new key', async () => {
    vi.spyOn(goals, 'get').mockResolvedValue(detail());
    vi.spyOn(goals, 'checkins').mockResolvedValue(page([]));
    const checkin = vi.spyOn(goals, 'checkin').mockRejectedValue(err('network', 0));
    wrap(<GoalPage ws={WS} goal="goal_1" />);
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Record check-in' }));
    await screen.findByRole('alert');
    fireEvent.change(screen.getByLabelText('Note (optional)'), {
      target: { value: 'Shipped the beta, mostly' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record check-in' }));
    await waitFor(() => expect(checkin).toHaveBeenCalledTimes(2));
    expect(checkin.mock.calls[1]![4]).not.toBe(checkin.mock.calls[0]![4]);
  });

  it('an unsent note survives a reload', async () => {
    vi.spyOn(goals, 'get').mockResolvedValue(detail());
    vi.spyOn(goals, 'checkins').mockResolvedValue(page([]));
    const first = wrap(<GoalPage ws={WS} goal="goal_1" />);
    fireEvent.change(await screen.findByLabelText('Note (optional)'), {
      target: { value: 'half-typed' },
    });
    first.unmount();
    wrap(<GoalPage ws={WS} goal="goal_1" />);
    expect(((await screen.findByLabelText('Note (optional)')) as HTMLTextAreaElement).value).toBe(
      'half-typed',
    );
    expect(screen.getByText('Your unsent note from earlier is back.')).toBeTruthy();
  });

  it('asks for a value when there is a target, and a percentage when there is not', async () => {
    vi.spyOn(goals, 'checkins').mockResolvedValue(page([]));
    vi.spyOn(goals, 'get').mockResolvedValue(
      detail({ metric: { unit: 'users', baseline: 0, target: 1000, current: 100 } }),
    );
    const checkin = vi.spyOn(goals, 'checkin').mockResolvedValue(created({ value: 400 }));
    const view = wrap(<GoalPage ws={WS} goal="goal_1" />);
    fireEvent.change(await screen.findByLabelText('New value (users)'), {
      target: { value: '400' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record check-in' }));
    await waitFor(() => expect(checkin).toHaveBeenCalled());
    expect(checkin.mock.calls[0]![2]).toEqual({ value: 400 });
    view.unmount();
    vi.restoreAllMocks();
    vi.spyOn(people, 'people').mockResolvedValue([]);
    vi.spyOn(goals, 'checkins').mockResolvedValue(page([]));
    vi.spyOn(goals, 'get').mockResolvedValue(detail());
    wrap(<GoalPage ws={WS} goal="goal_1" />);
    const pct = await screen.findByLabelText('Progress (percent, 0 to 100)');
    fireEvent.change(pct, { target: { value: '140' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record check-in' }));
    expect(await screen.findByText('Use a percentage from 0 to 100.')).toBeTruthy();
  });

  it('a goal measured by key results takes confidence and a note only', async () => {
    vi.spyOn(goals, 'checkins').mockResolvedValue(page([]));
    vi.spyOn(goals, 'get').mockResolvedValue(
      detail({ basis: 'key_results', key_results: [kr('kr_1', 'Users')] }),
    );
    wrap(<GoalPage ws={WS} goal="goal_1" />);
    await screen.findByLabelText('Note (optional)');
    expect(
      screen.getByText(
        /computed from the key results, so a check-in here records confidence and a note only/,
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/^Progress \(percent/)).toBeNull();
  });

  it('history is newest first and labels computed roll-ups', async () => {
    const rows: Checkin[] = [
      {
        id: 'gci_2',
        type: 'goal_checkin',
        source: 'computed',
        key_result: null,
        value: null,
        progress_percent: 50,
        confidence: null,
        note: null,
        author: null,
        created_at: '2026-10-07T10:00:00.000Z',
      },
      {
        id: 'gci_1',
        type: 'goal_checkin',
        source: 'manual',
        key_result: null,
        value: null,
        progress_percent: 30,
        confidence: 'on_track',
        note: 'Good week',
        author: { id: 'mem_1', name: 'Ada Owner', type: 'member' },
        created_at: '2026-10-05T10:00:00.000Z',
      },
    ];
    vi.spyOn(goals, 'get').mockResolvedValue(detail({ basis: 'key_results' }));
    vi.spyOn(goals, 'checkins').mockResolvedValue(page(rows));
    wrap(<GoalPage ws={WS} goal="goal_1" />);
    const list = await screen.findByRole('list', { name: 'Check-in history, newest first' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('Computed from key results');
    expect(items[0]!.textContent).toContain('50% progress');
    expect(items[1]!.textContent).toContain('Ada Owner');
    expect(items[1]!.textContent).toContain('Good week');
    expect(items[1]!.textContent).toContain('On track');
  });

  it('records a key result check-in from a dialog that closes with Escape', async () => {
    vi.spyOn(goals, 'checkins').mockResolvedValue(page([]));
    vi.spyOn(goals, 'get').mockResolvedValue(
      detail({ basis: 'key_results', key_results: [kr('kr_1', 'Users')] }),
    );
    wrap(<GoalPage ws={WS} goal="goal_1" />);
    const opener = await screen.findByRole('button', { name: 'Check in on Users' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Check in: Users' });
    expect(
      (within(dialog).getByLabelText('What are you updating?') as HTMLSelectElement).value,
    ).toBe('kr_1');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('idempotency keys', () => {
  it('the same body keeps its key; a different body gets a new one; reset starts over', () => {
    let hook!: ReturnType<typeof useIdempotency>;
    const Probe = () => {
      hook = useIdempotency();
      return null;
    };
    render(<Probe />);
    const a = hook.keyFor({ note: 'x' });
    expect(hook.keyFor({ note: 'x' })).toBe(a);
    const b = hook.keyFor({ note: 'y' });
    expect(b).not.toBe(a);
    hook.reset();
    expect(hook.keyFor({ note: 'y' })).not.toBe(b);
  });
});

// ---- Portfolio --------------------------------------------------------------------------------

const row = (over: Partial<PortfolioProject> = {}): PortfolioProject => ({
  id: 'prj_1',
  type: 'project',
  name: 'Apollo',
  brand: harbor,
  status: { category: 'active', label: 'Active' },
  priority: 'high',
  owner: { id: 'mem_1', name: 'Ada Owner', type: 'member' },
  dates: { start: '2026-09-01', target: '2026-10-01', deadline: null, next_deadline: '2026-10-01' },
  declared_health: { value: 'on_track', source: 'manual' },
  health: {
    value: 'off_track',
    label: 'Off track',
    reasons: [
      {
        code: 'target_passed',
        severity: 'off_track',
        message: 'The target date (2026-10-01) passed 7 days ago.',
        facts: { days_late: 7 },
      },
    ],
    incomplete: ['no_time_budget'],
    differs_from_declared: true,
  },
  progress: { done: 2, total: 8, percent: 25, basis: 'readable_leaf_tasks' },
  tasks: { open: 6, overdue: 3, blocked: 1 },
  effort: { open_estimate_minutes: 600, unestimated_open_tasks: 2, logged_minutes: 120 },
  budget: {
    money: { amount: 5000, currency: 'EUR', spend: null },
    time: { minutes: 1200, logged_minutes: 120 },
    ai: { micros: 1_000_000, usage: null },
  },
  goals: { direct: 1, inherited: 0, linked: true },
  dependencies: { blocking: 1, blocked_by: 0 },
  version: 1,
  ...over,
});
const overview = (over: Partial<PortfolioOverview> = {}): PortfolioOverview => ({
  type: 'portfolio_overview',
  data: [
    row(),
    row({
      id: 'prj_2',
      name: 'Borealis',
      declared_health: null,
      health: {
        value: 'unknown',
        label: 'Not enough information',
        reasons: [],
        incomplete: ['no_dates', 'no_tasks'],
        differs_from_declared: false,
      },
      progress: { done: 0, total: 0, percent: null, basis: 'readable_leaf_tasks' },
      goals: { direct: 0, inherited: 0, linked: false },
    }),
  ],
  summary: {
    projects: 2,
    by_status: { planned: 0, active: 2, paused: 0, done: 0, cancelled: 0 },
    by_health: { off_track: 1, at_risk: 0, on_track: 0, complete: 0, unknown: 1 },
    schedule: {
      overdue_projects: 1,
      due_in_30_days: 1,
      upcoming: [{ id: 'prj_2', name: 'Borealis', date: '2026-10-20', kind: 'target' }],
    },
    effort: { open_estimate_minutes: 600, unestimated_open_tasks: 2, logged_minutes: 120 },
    budgets: {
      money: {
        by_currency: [{ currency: 'EUR', budgeted: 5000, projects: 1 }],
        spend_tracked: false,
      },
      time: { budgeted_minutes: 1200, logged_minutes: 120, over_budget_projects: 0, projects: 1 },
      ai: { budgeted_micros: 1_000_000, usage_tracked: false, projects: 1 },
    },
    goals: { projects_without_goals: 1 },
    dependencies: { open: 2, overdue: 1, late: 0 },
  },
  page: { limit: 100, has_more: false },
  coverage: {
    evaluated_projects: 2,
    truncated: false,
    scope: 'readable_projects',
    note: 'Covers the projects, tasks, goals, and time you can read. Work you cannot read changes no figure here.',
    not_tracked: ['money_spend', 'ai_usage'],
  },
  as_of: '2026-10-08T10:00:00.000Z',
  computed: 'live',
  ...over,
});

describe('Portfolio health', () => {
  it('shows coverage, the summary, and what is not tracked; health carries its rules and declared value', async () => {
    vi.spyOn(portfolios, 'overview').mockResolvedValue(overview());
    wrap(<PortfolioPage ws={WS} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Portfolio' })).toBeTruthy();
    expect(
      await screen.findByText(/Covers the projects, tasks, goals, and time you can read/),
    ).toBeTruthy();
    expect(screen.getByText(/As of /)).toBeTruthy();
    expect(
      screen.getByText(
        /2 projects evaluated from the projects you can read\. Computed live for you\./,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Money spend and AI usage are not tracked yet, so budgets show what was set, not what was used.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show projects without goals' })).toBeTruthy();

    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual(['Project', 'Health', 'Status', 'Progress', 'Next date', 'Owner']);
    expect(table.querySelector('caption')).toBeTruthy();
    // Health is a word and a shape; the project's own declared health sits beside it.
    expect(within(table).getByText('Off track')).toBeTruthy();
    expect(within(table).getByText(/Declared: On track/)).toBeTruthy();
    expect(within(table).getByText('Not enough information')).toBeTruthy();
    expect(within(table).getAllByRole('progressbar')).toHaveLength(2);
  });

  it('a row expands by keyboard-operable button to the rules, what was not evaluated, and budgets', async () => {
    vi.spyOn(portfolios, 'overview').mockResolvedValue(overview());
    wrap(<PortfolioPage ws={WS} />);
    const toggle = await screen.findByRole('button', { name: 'Why and details for Apollo' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.tagName).toBe('BUTTON');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBeTruthy();
    const details = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(
      within(details).getByText('The target date (2026-10-01) passed 7 days ago.'),
    ).toBeTruthy();
    expect(within(details).getByText(/Not fully evaluated: no time budget is set/)).toBeTruthy();
    expect(details.textContent).toContain(
      'Declared by the project: On track (differs from the computed health above).',
    );
    expect(within(details).getByText(/Spend is not tracked yet/)).toBeTruthy();
    expect(within(details).getByText(/AI usage is not tracked yet/)).toBeTruthy();
    expect(
      within(details).getByText('2 of 8 tasks you can read are done.', { exact: false }),
    ).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(details.id)).toBeNull();
  });

  it('says why a quiet project is not "fine": incompleteness is listed', async () => {
    vi.spyOn(portfolios, 'overview').mockResolvedValue(overview());
    wrap(<PortfolioPage ws={WS} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Why and details for Borealis' }));
    expect(
      screen.getByText(
        /Not fully evaluated: no start, target, or deadline date is set; no tasks you can read are counted/,
      ),
    ).toBeTruthy();
    expect(screen.getByText('No health rule flagged this project.')).toBeTruthy();
    expect(screen.getByText('No goal you can see is linked to this project.')).toBeTruthy();
  });

  it('a truncated result is announced as incomplete', async () => {
    vi.spyOn(portfolios, 'overview').mockResolvedValue(
      overview({
        coverage: { ...overview().coverage, truncated: true },
        page: { limit: 100, has_more: true },
      }),
    );
    wrap(<PortfolioPage ws={WS} />);
    expect(
      await screen.findByText(/Incomplete: more projects match than could be evaluated/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show more projects' })).toBeTruthy();
  });

  it('filters are sent to the API (status, health, brand, owner)', async () => {
    const o = vi.spyOn(portfolios, 'overview').mockResolvedValue(overview());
    wrap(<PortfolioPage ws={WS} />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Active' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Off track' }));
    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'me' } });
    await waitFor(() => {
      expect(o.mock.calls.at(-1)![1]).toMatchObject({
        status: 'active',
        health: 'off_track',
        owner: 'me',
      });
    });
  });

  it('exports the filtered view and announces the file', async () => {
    vi.spyOn(portfolios, 'overview').mockResolvedValue(overview());
    const file = vi.spyOn(portfolios, 'exportFile').mockResolvedValue({
      text: 'a',
      filename: 'portfolio-2026-10-08.csv',
      contentType: 'text/csv',
    });
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    wrap(<PortfolioPage ws={WS} />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Export health as CSV' }));
    expect(await screen.findByText('Exported portfolio-2026-10-08.csv.')).toBeTruthy();
    expect(file).toHaveBeenCalledWith(WS, 'csv', {});
  });

  it('an export the server refuses explains what to do', async () => {
    vi.spyOn(portfolios, 'overview').mockResolvedValue(overview());
    vi.spyOn(portfolios, 'exportFile').mockRejectedValue(
      err('validation_failed', 422, {
        issues: [
          {
            code: 'too_many',
            message: 'Narrow the filters: this export would not cover every project.',
          },
        ],
      }),
    );
    wrap(<PortfolioPage ws={WS} />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Export health as JSON' }));
    expect(
      await screen.findByText('Narrow the filters: this export would not cover every project.'),
    ).toBeTruthy();
  });
});

describe('Portfolio dependencies and orphans', () => {
  const deps: PortfolioDependencies = {
    type: 'portfolio_dependencies',
    data: [
      {
        blocker_project: { id: 'prj_1', name: 'Apollo', brand: harbor },
        blocked_project: { id: 'prj_2', name: 'Borealis', brand: harbor },
        counts: { resolved: 1, open: 1, overdue: 1, late: 0 },
        edges: [
          {
            blocker: {
              id: 'tsk_1',
              title: 'Ship API',
              status_category: 'active',
              due: '2026-10-01',
            },
            blocked: {
              id: 'tsk_2',
              title: 'Build UI',
              status_category: 'planned',
              due: '2026-10-10',
            },
            state: 'overdue',
          },
        ],
      },
    ],
    summary: { open: 1, overdue: 1, late: 0, resolved: 1 },
    coverage: {
      evaluated_projects: 2,
      truncated: false,
      note: 'Only dependencies between work you can read are shown; a dependency on work you cannot read is not counted.',
    },
    as_of: '2026-10-08T10:00:00.000Z',
    computed: 'live',
  };
  const orphans: PortfolioOrphans = {
    type: 'portfolio_orphans',
    projects: {
      data: [
        {
          id: 'prj_2',
          type: 'project',
          name: 'Borealis',
          brand: harbor,
          status: { category: 'active', label: 'Active' },
          owner: null,
          reason: 'no_linked_goal',
        },
      ],
      truncated: false,
    },
    goals: {
      data: [
        {
          id: 'goal_9',
          type: 'goal',
          title: 'Quiet goal',
          scope: 'brand',
          brand: harbor,
          owner: { id: 'mem_1', name: 'Ada Owner', type: 'member' },
          period_end: '2026-12-31',
          reason: 'no_active_work',
        },
      ],
      truncated: false,
    },
    coverage: {
      relative_to: 'viewer',
      note: 'Findings cover the goals, projects, and work you can read. A goal or project that looks unlinked may be linked to something you cannot read.',
    },
    as_of: '2026-10-08T10:00:00.000Z',
    computed: 'live',
  };

  it('dependencies show pairs with state counts as text and drill into the edges', async () => {
    window.history.replaceState(null, '', `${BASE}/projects/portfolio?view=dependencies`);
    vi.spyOn(portfolios, 'dependencies').mockResolvedValue(deps);
    wrap(<PortfolioPage ws={WS} />);
    expect(
      await screen.findByText(/Only dependencies between work you can read are shown/),
    ).toBeTruthy();
    expect(screen.getByText('Blocker overdue: 1')).toBeTruthy();
    expect(screen.getByText('Open: 1')).toBeTruthy();
    expect(screen.getByText('Resolved: 1')).toBeTruthy();
    const summary = screen.getByText(/Show the task dependencies/).closest('summary')!;
    expect(summary.closest('details')!.textContent).toContain('Ship API');
    expect(screen.getByRole('link', { name: 'Build UI' }).getAttribute('href')).toBe(
      `${BASE}/tasks/tsk_2`,
    );
    expect(
      screen.getByRole('link', { name: 'Goal coverage' }).getAttribute('aria-current'),
    ).toBeNull();
    expect(screen.getByRole('link', { name: 'Dependencies' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('orphan findings are labelled as relative to the viewer', async () => {
    window.history.replaceState(null, '', `${BASE}/projects/portfolio?view=orphans`);
    vi.spyOn(portfolios, 'orphans').mockResolvedValue(orphans);
    wrap(<PortfolioPage ws={WS} />);
    expect(await screen.findByText(/relative to you \(viewer\)/)).toBeTruthy();
    expect(
      screen.getByText(/may be linked to something you cannot read/, { selector: 'p.gl-warn' }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Findings cover the goals, projects, and work you can read/),
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Projects without a goal you can see' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Borealis' })).toBeTruthy();
    expect(screen.getByText('No active work you can see')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Quiet goal' }).getAttribute('href')).toBe(
      `${BASE}/goals/goal_9`,
    );
  });

  it('with nothing found, orphans say so without implying anything hidden', async () => {
    window.history.replaceState(null, '', `${BASE}/projects/portfolio?view=orphans`);
    vi.spyOn(portfolios, 'orphans').mockResolvedValue({
      ...orphans,
      projects: { data: [], truncated: false },
      goals: { data: [], truncated: false },
    });
    wrap(<PortfolioPage ws={WS} />);
    expect(await screen.findByText(/has a goal you can see/)).toBeTruthy();
    expect(screen.getByText(/has active work you can see/)).toBeTruthy();
  });
});

describe('Saved portfolios', () => {
  const saved: Portfolio = {
    id: 'pf_1',
    type: 'portfolio',
    name: 'Q4 launches',
    description: null,
    scope: { kind: 'workspace' },
    owner: { id: 'mem_1', name: 'Ada Owner', type: 'member' },
    projects: ['prj_1'],
    projects_count: 1,
    lifecycle_state: 'active',
    capabilities: { update: true, archive: true, trash: true },
    version: 2,
  };

  it('creates a portfolio, then saves its projects with the new version; hidden members are explained', async () => {
    window.history.replaceState(null, '', `${BASE}/projects/portfolio?view=portfolios`);
    vi.spyOn(projects, 'list').mockResolvedValue({
      data: [
        { id: 'prj_1', name: 'Apollo', brand: harbor } as never,
        { id: 'prj_2', name: 'Borealis', brand: harbor } as never,
      ],
      total: null,
    });
    const create = vi
      .spyOn(portfolios, 'create')
      .mockResolvedValue({ ...saved, projects: [], projects_count: 0, version: 1 });
    const setProjects = vi.spyOn(portfolios, 'setProjects').mockResolvedValue(saved);
    wrap(<PortfolioPage ws={WS} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create portfolio' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create portfolio' });
    expect(
      within(dialog).getByText(
        /Members you cannot read are kept in the portfolio but are not shown or counted for you/,
      ),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Q4 launches' } });
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: /Apollo/ }));
    expect(within(dialog).getByText('1 selected.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create portfolio' }));
    await waitFor(() => expect(setProjects).toHaveBeenCalled());
    expect(create.mock.calls[0]![1]).toEqual({ name: 'Q4 launches' });
    expect(setProjects.mock.calls[0]!.slice(1, 4)).toEqual(['pf_1', 1, ['prj_1']]);
  });

  it('lists saved portfolios with the count of members the person can read', async () => {
    window.history.replaceState(null, '', `${BASE}/projects/portfolio?view=portfolios`);
    vi.spyOn(portfolios, 'list').mockResolvedValue(page([saved]));
    wrap(<PortfolioPage ws={WS} />);
    expect(await screen.findByRole('heading', { level: 3, name: 'Q4 launches' })).toBeTruthy();
    expect(screen.getByText(/1 project you can read/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View health of Q4 launches' })).toBeTruthy();
  });

  it('a stale edit keeps the typed name and offers the latest version', async () => {
    window.history.replaceState(null, '', `${BASE}/projects/portfolio?view=portfolios`);
    const list = vi.spyOn(portfolios, 'list').mockResolvedValue(page([saved]));
    const update = vi
      .spyOn(portfolios, 'update')
      .mockRejectedValueOnce(err('conflict', 409, { conflict: { current_version: 3 } }))
      .mockResolvedValueOnce({ ...saved, name: 'Mine', version: 4 });
    wrap(<PortfolioPage ws={WS} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Q4 launches' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit portfolio' });
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Mine' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save portfolio' }));
    expect(
      await within(dialog).findByText('This portfolio changed while you were editing'),
    ).toBeTruthy();
    list.mockResolvedValue(page([{ ...saved, version: 3 }]));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Load latest version' }));
    expect(await within(dialog).findByText('Latest version loaded')).toBeTruthy();
    expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Mine');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save portfolio' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]![2]).toBe(3);
  });
});

describe('project Goals card', () => {
  const project = { id: 'prj_1', name: 'Apollo', brand: harbor };

  it('lists the goals the viewer can read, with a link to each and to Goals', async () => {
    vi.spyOn(goals, 'ofProject').mockResolvedValue(page([goal({ title: 'Ship Apollo' })]));
    wrap(<ProjectGoalsCard ws={WS} project={project} canEdit />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Goals' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ship Apollo' }).getAttribute('href')).toBe(
      `${BASE}/goals/goal_1`,
    );
    expect(screen.getByRole('heading', { level: 4, name: 'Ship Apollo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Link to a goal' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a goal for this project' })).toBeTruthy();
  });

  it('without edit rights there are no change buttons; with no goal it says so plainly', async () => {
    vi.spyOn(goals, 'ofProject').mockResolvedValue(page([]));
    wrap(<ProjectGoalsCard ws={WS} project={project} canEdit={false} />);
    expect(await screen.findByText('No goal you can see is linked to this project.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Link to a goal' })).toBeNull();
  });

  it('a refusal (guest, or access lost) renders nothing at all', async () => {
    const ofProject = vi.spyOn(goals, 'ofProject').mockRejectedValue(err('forbidden', 403));
    const view = wrap(<ProjectGoalsCard ws={WS} project={project} canEdit />);
    await waitFor(() => expect(ofProject).toHaveBeenCalled());
    await act(async () => undefined);
    expect(view.container.textContent).toBe('');
  });

  it('links the project to a chosen goal', async () => {
    vi.spyOn(goals, 'ofProject').mockResolvedValue(page([]));
    vi.spyOn(goals, 'list').mockResolvedValue(
      page([
        goal({ id: 'goal_ws', title: 'Company goal' }),
        goal({
          id: 'goal_other',
          title: 'Other brand goal',
          scope: { kind: 'brand', brand: { ...harbor, id: 'br_other', name: 'Other' } },
        }),
        goal({
          id: 'goal_proj',
          title: 'A project goal',
          scope: { kind: 'project', brand: harbor, project: { id: 'prj_9', name: 'X' } },
        }),
      ]),
    );
    const add = vi.spyOn(goals, 'addLink').mockResolvedValue(detail());
    wrap(<ProjectGoalsCard ws={WS} project={project} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Link to a goal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link this project to a goal' });
    const select = within(dialog).getByLabelText('Goal') as HTMLSelectElement;
    await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(1));
    // Only goals a project can be linked to are offered.
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Choose a goal',
      'Company goal (2026 Q4)',
    ]);
    fireEvent.change(select, { target: { value: 'goal_ws' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Link project' }));
    await waitFor(() => expect(add).toHaveBeenCalled());
    expect(add.mock.calls[0]!.slice(1, 3)).toEqual(['goal_ws', { target: 'prj_1' }]);
  });
});

describe('Trash', () => {
  const item = {
    id: 'goal_t',
    type: 'goal' as const,
    title: 'Old goal',
    lifecycle_state: 'trashed' as const,
    version: 5,
  };

  it('lists what can be restored, restores it, and reports it', async () => {
    vi.spyOn(goals, 'trashed').mockResolvedValue(page([item]));
    const verb = vi
      .spyOn(goals, 'verb')
      .mockResolvedValue({ id: 'goal_t', type: 'goal', lifecycle_state: 'active' });
    const restored = vi.fn();
    wrap(<TrashSection ws={WS} kind="goal" onRestored={restored} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show trash' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Old goal' }));
    await waitFor(() => expect(verb).toHaveBeenCalled());
    expect(verb.mock.calls[0]!.slice(1, 4)).toEqual(['goal_t', 'restore', 5]);
    expect(await screen.findByText('Restored Old goal.')).toBeTruthy();
    expect(restored).toHaveBeenCalled();
    expect(screen.getByText('The trash is empty.')).toBeTruthy();
  });

  it('permanent delete asks first, and Cancel keeps the focus on Cancel and changes nothing', async () => {
    vi.spyOn(portfolios, 'trashed').mockResolvedValue(
      page([
        { id: 'pf_t', type: 'portfolio', name: 'Old pf', lifecycle_state: 'trashed', version: 2 },
      ]),
    );
    const verb = vi
      .spyOn(portfolios, 'verb')
      .mockResolvedValue({ id: 'pf_t', lifecycle_state: 'purged' });
    wrap(<TrashSection ws={WS} kind="portfolio" onRestored={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show trash' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Old pf permanently' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Delete this portfolio permanently?',
    });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(verb).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Old pf permanently' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Delete permanently',
      }),
    );
    await waitFor(() => expect(verb).toHaveBeenCalled());
    expect(verb.mock.calls[0]!.slice(1, 4)).toEqual(['pf_t', 'purge', 2]);
    expect(await screen.findByText('Permanently deleted Old pf.')).toBeTruthy();
  });

  it('a refusal is explained and the item stays', async () => {
    vi.spyOn(goals, 'trashed').mockResolvedValue(page([item]));
    vi.spyOn(goals, 'verb').mockRejectedValue(err('forbidden', 403));
    wrap(<TrashSection ws={WS} kind="goal" onRestored={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show trash' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Old goal' }));
    expect(await screen.findByText(/don't have permission/)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Old goal' })).toBeTruthy();
  });

  it('an archived goal whose capabilities deny restore offers no restore button', async () => {
    vi.spyOn(goals, 'checkins').mockResolvedValue(page([]));
    vi.spyOn(goals, 'get').mockResolvedValue(
      detail({
        lifecycle_state: 'archived',
        capabilities: {
          update: false,
          check_in: false,
          archive: false,
          restore: false,
          trash: false,
        },
      }),
    );
    wrap(<GoalPage ws={WS} goal="goal_1" />);
    await screen.findByText('This goal is archived');
    expect(screen.queryByRole('button', { name: 'Restore from archive' })).toBeNull();
  });
});

describe('styles', () => {
  let block = '';
  beforeAll(async () => {
    // The stylesheet is read as text (a dynamic import keeps Node built-ins out of the app bundle's lint rule).
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(`${process.cwd()}/apps/web/src/styles.css`, 'utf8');
    block = css.slice(css.indexOf('Phase 5B goals and portfolio'));
  });

  it('keeps borders and the progress fill visible in forced-colours mode', () => {
    expect(block).toMatch(/@media \(forced-colors: active\)[^@]*\.gl-bar-fill/);
    expect(block).toMatch(/\.gl-chip[\s\S]*border: 1px solid CanvasText/);
    expect(block).toContain('Highlight');
  });

  it('removes animation under reduced motion', () => {
    expect(block).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[^@]*\.gl-bar-fill[^}]*transition: none/,
    );
  });

  it('tables become stacked cards on narrow screens, and only max-width queries are added', () => {
    expect(block).toMatch(/@media \(max-width: 720px\)[\s\S]*\.gl-table tr[\s\S]*display: block/);
    expect(block).not.toMatch(/min-width: \d+px\)/);
  });

  it('every control meets the touch target size', () => {
    expect(block).toMatch(/\.gl-explain summary \{[^}]*min-height: 44px/);
    expect(block).toMatch(/\.gl-link \{[^}]*min-height: 44px/);
  });
});
