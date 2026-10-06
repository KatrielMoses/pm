import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseDuration,
  TimeApprovalsPage,
  TimerCard,
  WorkTimePanel,
} from '../src/pages/time-pages.tsx';
import { Router } from '../src/router.tsx';
import { matchRoute } from '../src/shell/registry.ts';
import { StepUpProvider } from '../src/stepup.tsx';
import {
  clock,
  spoken,
  stopwatch,
  time,
  type TimeEntry,
  type Timesheet,
} from '../src/time/client.ts';
import { flushActions, pendingActions, queueAction } from '../src/time/offline.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

const wrap = (ui: React.ReactNode) =>
  render(
    <Router>
      <StepUpProvider>{ui}</StepUpProvider>
    </Router>,
  );

const entry = (extra: Partial<TimeEntry> = {}): TimeEntry => ({
  id: 'te_1',
  type: 'time_entry',
  target: { type: 'task', id: 'tsk_1', title: 'Write copy' },
  brand: { id: 'brd_1', name: 'Harbor' },
  person: { id: 'mem_1', name: 'Ana' },
  source: 'timer',
  state: 'running',
  started_at: '2026-10-06T09:00:00.000Z',
  ended_at: null,
  running_since: '2026-10-06T09:30:00.000Z',
  work_date: '2026-10-06',
  tz: 'UTC',
  duration_seconds: 600,
  hours: 0.17,
  billable: false,
  note: '',
  auto_stopped: false,
  segments: [],
  status: 'open',
  own: true,
  editable: true,
  version: 2,
  ...extra,
});

describe('time routes and formatting (3D)', () => {
  it('registers the Time, approvals, and report routes for members', () => {
    expect(matchRoute('/workspaces/ws_A/time')).toMatchObject({ def: { id: 'time' } });
    expect(matchRoute('/workspaces/ws_A/time/approvals')).toMatchObject({
      def: { id: 'time_approvals' },
    });
    expect(matchRoute('/workspaces/ws_A/time/report')).toMatchObject({
      def: { id: 'time_report' },
    });
  });

  it('reads durations people type and shows them without rounding up', () => {
    expect(parseDuration('1:30')).toBe(90);
    expect(parseDuration('90')).toBe(90);
    expect(parseDuration('1.5h')).toBe(90);
    expect(parseDuration('1h 30m')).toBe(90);
    expect(parseDuration('45m')).toBe(45);
    for (const bad of ['', '0', '-5', '1:75', 'soon', '0:00'])
      expect(parseDuration(bad)).toBeNull();
    expect(clock(5459)).toBe('1:30');
    expect(stopwatch(3661)).toBe('1:01:01');
    expect(spoken(3660)).toBe('1 hour 1 minute');
    expect(spoken(120)).toBe('2 minutes');
  });
});

describe('the live timer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-10-06T10:00:00Z') });
  });

  it('computes elapsed time from the server clock and announces state changes, not ticks', async () => {
    // The device clock is 5 minutes slow; the server clock decides.
    vi.spyOn(time, 'timer').mockResolvedValue({
      timer: entry(),
      server_now: '2026-10-06T10:05:00.000Z',
      max_seconds: 86400,
    });
    const action = vi
      .spyOn(time, 'action')
      .mockResolvedValue(entry({ state: 'paused', duration_seconds: 2700, running_since: null }));
    wrap(<TimerCard ws="ws_A" />);
    // 600 s closed + 35 min since 09:30 on the server clock.
    const timer = await screen.findByRole('timer');
    expect(timer.textContent).toMatch(/^0:45:0\d$/);
    expect(timer.getAttribute('aria-live')).toBe('off');
    expect(screen.getByRole('link', { name: 'Write copy' })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Pause' })));
    expect(action).toHaveBeenCalledWith('ws_A', 'te_1', 'pause', {});
    expect(screen.getByText('Timer paused.')).toBeTruthy();
  });

  it('keeps a stop pressed offline on the device and sends it once when back online', async () => {
    vi.spyOn(time, 'timer').mockResolvedValue({
      timer: entry(),
      server_now: '2026-10-06T10:00:00.000Z',
      max_seconds: 86400,
    });
    const action = vi.spyOn(time, 'action').mockResolvedValue(entry({ state: 'stopped' }));
    wrap(<TimerCard ws="ws_A" />);
    await screen.findByRole('timer');
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const before = Date.now();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop and save' })));
    const after = Date.now();
    expect(screen.getByText(/stopped on this device/)).toBeTruthy();
    const queued = pendingActions();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ ws: 'ws_A', te: 'te_1', verb: 'stop' });
    // The instant the person pressed Stop (the clock moves with real time in this test).
    const at = Date.parse(queued[0]!.at);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    expect(action).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    // The flush is asynchronous (storage, then the request): wait for its outcome.
    await vi.waitFor(() => expect(pendingActions()).toEqual([]));
    expect(action).toHaveBeenCalledWith(
      'ws_A',
      'te_1',
      'stop',
      { at: queued[0]!.at },
      queued[0]!.key,
    );
  });

  it('flushes queued actions in order and keeps them while still offline', async () => {
    queueAction({ ws: 'ws_A', te: 'te_1', verb: 'pause' });
    queueAction({ ws: 'ws_A', te: 'te_1', verb: 'stop' });
    const { ApiError } = await import('../src/api.ts');
    const action = vi
      .spyOn(time, 'action')
      .mockRejectedValueOnce(new ApiError({ code: 'network', status: 0, message: 'x' }));
    expect(await flushActions('ws_A')).toBe(0);
    expect(pendingActions()).toHaveLength(2);
    action.mockResolvedValue(entry({ state: 'stopped' }));
    expect(await flushActions('ws_A')).toBe(2);
    expect(action.mock.calls.slice(1).map((c) => c[2])).toEqual(['pause', 'stop']);
  });
});

describe('time on a task', () => {
  it('shows planned, logged, and remaining effort and logs time with a typed duration', async () => {
    vi.spyOn(time, 'summary').mockResolvedValue({
      target: { type: 'task', id: 'tsk_1' },
      planned: { estimate_minutes: 120, remaining_estimate_minutes: null },
      actual: {
        seconds: 5400,
        hours: 1.5,
        billable_seconds: 1800,
        non_billable_seconds: 3600,
        mine_seconds: 5400,
        entries: 2,
      },
      remaining: { minutes: 30, open_tasks: 1, unestimated_open_tasks: 0, method: 'x' },
      live_timer: null,
    });
    vi.spyOn(time, 'entries').mockResolvedValue({
      data: [entry({ state: 'stopped', running_since: null })],
      page: { has_more: false },
    });
    const create = vi
      .spyOn(time, 'create')
      .mockResolvedValue(entry({ state: 'stopped', duration_seconds: 5400 }));
    wrap(<WorkTimePanel ws="ws_A" target="tsk_1" canLog />);
    await act(async () => undefined);
    expect(screen.getByText('Estimate').nextElementSibling!.textContent).toContain('2:00');
    expect(screen.getByText('Remaining').nextElementSibling!.textContent).toContain('0:30');
    fireEvent.click(screen.getByText('Log time', { selector: 'summary' }));
    fireEvent.change(screen.getByLabelText(/Time spent/), { target: { value: 'soon' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Log time' })));
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter the time spent/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Time spent/), { target: { value: '1:30' } });
    fireEvent.click(screen.getByLabelText('Billable'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Log time' })));
    expect(create).toHaveBeenCalledWith(
      'ws_A',
      expect.objectContaining({ target: 'tsk_1', duration_minutes: 90, billable: true }),
      expect.anything(),
    );
    expect(screen.getByText(/Logged 1 hour 30 minutes/)).toBeTruthy();
  });

  it('offers no logging where the person may not log time', async () => {
    vi.spyOn(time, 'summary').mockResolvedValue({
      target: { type: 'task', id: 'tsk_1' },
      planned: { estimate_minutes: null },
      actual: {
        seconds: 0,
        hours: 0,
        billable_seconds: 0,
        non_billable_seconds: 0,
        mine_seconds: 0,
        entries: 0,
      },
      remaining: { minutes: null, open_tasks: 1, unestimated_open_tasks: 1, method: 'x' },
      live_timer: null,
    });
    vi.spyOn(time, 'entries').mockResolvedValue({ data: [], page: { has_more: false } });
    wrap(<WorkTimePanel ws="ws_A" target="tsk_1" canLog={false} />);
    await act(async () => undefined);
    expect(screen.queryByRole('button', { name: 'Start timer' })).toBeNull();
    expect(screen.queryByText('Log time')).toBeNull();
  });
});

describe('approvals', () => {
  it('lists only decidable lines with approve, return, and unlock actions labelled by brand', async () => {
    const sheet: Timesheet = {
      id: 'tsh_1',
      type: 'timesheet',
      person: { id: 'mem_2', name: 'Bo' },
      period: { start: '2026-09-07', end: '2026-09-13' },
      state: 'submitted',
      submitted_at: '2026-09-14T08:00:00Z',
      own: false,
      lines: [
        {
          brand: { id: 'brd_1', name: 'Harbor' },
          state: 'pending',
          submitted: { seconds: 3600, billable_seconds: 0, entries: 1, hours: 1 },
          decisions: [],
          locks: [],
          locked: false,
          can_approve: true,
          can_unlock: false,
        },
      ],
      entries: [entry({ state: 'stopped' })],
      version: 3,
    };
    vi.spyOn(time, 'approvals').mockResolvedValue([sheet]);
    const decide = vi.spyOn(time, 'decide').mockResolvedValue({ ...sheet, state: 'approved' });
    wrap(<TimeApprovalsPage ws="ws_A" />);
    await act(async () => undefined);
    expect(screen.getByRole('heading', { name: /Bo · week of/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Waiting' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Approve Harbor' })));
    expect(decide).toHaveBeenCalledWith(
      'ws_A',
      'tsh_1',
      3,
      { brand: 'brd_1', decision: 'approve' },
      expect.anything(),
    );
    expect(screen.queryByRole('button', { name: 'Unlock…' })).toBeNull();
  });
});
