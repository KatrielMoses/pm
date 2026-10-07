import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESTINATION_PHASE } from '@pm/contracts/shell';
import { TodayPage } from '../src/pages/today-pages.tsx';
import { planning, type TodayView } from '../src/planning/client.ts';
import { Router } from '../src/router.tsx';
import { matchRoute } from '../src/shell/registry.ts';
import { StepUpProvider } from '../src/stepup.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const wrap = (ui: React.ReactNode) =>
  render(
    <Router>
      <StepUpProvider>{ui}</StepUpProvider>
    </Router>,
  );
const brief = (id: string, title: string, extra = {}) => ({
  id,
  title,
  brand: { id: 'br_1', name: 'Harbor' },
  due_date: null,
  deadline_date: null,
  estimate_minutes: 30,
  ...extra,
});
const commitment = (id: string, title: string, extra = {}) => ({
  task: { ...brief(id, title), status_category: 'active' },
  rank: 'a',
  locked: false,
  outcome: 'open' as const,
  carried_to: null,
  source: 'manual' as const,
  done: false,
  blocks: [],
  version: 2,
  ...extra,
});
const view = (extra: Partial<TodayView> = {}): TodayView => ({
  day: '2026-10-07',
  tz: 'Europe/Lisbon',
  today: '2026-10-07',
  server_now: '2026-10-07T09:00:00Z',
  closed: false,
  committed: [commitment('tsk_A', 'Write copy'), commitment('tsk_B', 'Review', { locked: true })],
  scheduled: [
    {
      id: 'blk_1',
      type: 'work_block',
      task: { id: 'tsk_A', title: 'Write copy' },
      unavailable: false,
      title: null,
      starts_at: '2026-10-07T09:00:00Z',
      ends_at: '2026-10-07T10:00:00Z',
      minutes: 60,
      source_tz: 'Europe/Lisbon',
      focus: true,
      locked: false,
      prep_minutes: 0,
      buffer_minutes: 15,
      source: 'manual',
      series: null,
      warnings: ['after_deadline'],
      version: 0,
    },
    {
      id: 'blk_2',
      type: 'work_block',
      task: null,
      unavailable: true,
      title: null,
      starts_at: '2026-10-07T11:00:00Z',
      ends_at: '2026-10-07T12:00:00Z',
      minutes: 60,
      source_tz: 'UTC',
      focus: false,
      locked: false,
      prep_minutes: 0,
      buffer_minutes: 0,
      source: 'manual',
      series: null,
      warnings: [],
      version: 0,
    },
  ],
  overdue: { items: [brief('tsk_C', 'Late report', { committed: false })], has_more: false },
  due_today: { items: [], has_more: false },
  upcoming_deadlines: {
    items: [brief('tsk_A', 'Write copy', { committed: true })],
    has_more: false,
  },
  totals: {
    committed: 2,
    estimate_minutes: 60,
    unestimated: 0,
    block_minutes: 120,
    focus_minutes: 60,
  },
  available_minutes: null,
  record: null,
  can_shutdown: true,
  ...extra,
});

describe('Today (3C)', () => {
  it('is a live destination', () => {
    expect(DESTINATION_PHASE.today).toBeNull();
    expect(matchRoute('/workspaces/ws_A/today')).toMatchObject({
      def: { id: 'today', phase: null },
    });
  });

  it('shows the plan with honest absences, separate sections, and busy time without its task', async () => {
    vi.spyOn(planning, 'today').mockResolvedValue(view());
    vi.spyOn(planning, 'series').mockResolvedValue([]);
    wrap(<TodayPage ws="ws_A" />);
    await act(async () => undefined);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Today');
    expect(screen.getByText(/arrive with capacity planning \(3E\)/)).toBeTruthy();
    expect(screen.getByText(/arrive with calendar sync \(6C\)/)).toBeTruthy();
    const overdue = screen.getByRole('region', { name: 'Overdue' });
    expect(
      within(overdue).getByRole('button', { name: 'Add Late report to this day' }),
    ).toBeTruthy();
    const upcoming = screen.getByRole('region', { name: 'Upcoming deadlines' });
    expect(within(upcoming).getByText('On today')).toBeTruthy();
    const scheduled = screen.getByRole('region', { name: 'Scheduled' });
    expect(within(scheduled).getByText('Ends after the deadline')).toBeTruthy();
    expect(within(scheduled).getByText('Busy (unavailable item)')).toBeTruthy();
    expect(within(scheduled).getByText('Focus')).toBeTruthy();
  });

  it('reorders by keyboard-reachable buttons and never moves locked items', async () => {
    vi.spyOn(planning, 'today').mockResolvedValue(view());
    vi.spyOn(planning, 'series').mockResolvedValue([]);
    const update = vi.spyOn(planning, 'update').mockResolvedValue({} as never);
    wrap(<TodayPage ws="ws_A" />);
    await act(async () => undefined);
    const list = screen.getByRole('list', { name: 'Committed tasks in order' });
    const button = (text: string) =>
      within(list)
        .getAllByRole('button')
        .find((b) => b.textContent === text) as HTMLButtonElement;
    expect(button('Move up Review').disabled).toBe(true);
    expect(button('Remove Review').disabled).toBe(true);
    expect(button('Unlock Review').getAttribute('aria-pressed')).toBe('true');
    await act(async () => fireEvent.click(button('Move down Write copy')));
    expect(update).toHaveBeenCalledWith(
      'ws_A',
      '2026-10-07',
      'tsk_A',
      2,
      { after: 'tsk_B' },
      expect.anything(),
    );
  });

  it('shuts down with a decision per unfinished task; locked ones can only stay', async () => {
    vi.spyOn(planning, 'today').mockResolvedValue(view());
    vi.spyOn(planning, 'series').mockResolvedValue([]);
    const shutdown = vi.spyOn(planning, 'shutdown').mockResolvedValue({
      day: '2026-10-07',
      closed_by: 'shutdown',
      committed: 2,
      completed: 0,
      carried: 1,
      returned: 0,
      dropped: 1,
      planned_minutes: 60,
      unestimated: 0,
      block_minutes: 120,
      focus_minutes: 60,
      actual_seconds: 0,
    });
    wrap(<TodayPage ws="ws_A" />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Shut down the day…' }));
    const dialog = screen.getByRole('dialog', { name: 'Shut down the day' });
    expect(
      (within(dialog).getAllByLabelText('What happens to it')[1] as HTMLSelectElement).disabled,
    ).toBe(true);
    await act(async () =>
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close the day' })),
    );
    expect(shutdown).toHaveBeenCalledWith(
      'ws_A',
      '2026-10-07',
      [
        { task: 'tsk_A', action: 'carry' },
        { task: 'tsk_B', action: 'leave' },
      ],
      expect.anything(),
    );
    expect(screen.getByText(/Day closed: 0 done, 1 carried over/)).toBeTruthy();
  });
});
