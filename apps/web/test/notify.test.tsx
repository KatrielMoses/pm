import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { BellPanel, BrowserNotifier, capCount } from '../src/notify/bell.tsx';
import { NotificationCentre } from '../src/notify/centre.tsx';
import {
  notifications,
  type Delivery,
  type NotificationItem,
  type Page,
  type Preference,
  type Preferences,
  type Profile,
} from '../src/notify/client.ts';
import { ScopeDefaultsEditor } from '../src/notify/defaults.tsx';
import { NotificationSettings } from '../src/notify/settings.tsx';
import { deliveryReason, relativeTime } from '../src/notify/shared.tsx';
import { projects } from '../src/projects/client.ts';
import { Router } from '../src/router.tsx';
import { matchRoute, routeHref } from '../src/shell/registry.ts';
import { NotificationsMenu } from '../src/shell/layout.tsx';

const WS = 'ws_A';

const err = (
  code: string,
  status: number,
  extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {},
) => new ApiError({ code, status, message: code, ...extra });

const item = (id: string, extra: Partial<NotificationItem> = {}): NotificationItem => ({
  id,
  type: 'notification',
  notification_type: 'mention',
  label: 'Mention',
  state: 'unread',
  occurrences: 1,
  group: null,
  created_at: '2026-10-01T10:00:00.000Z',
  last_occurred_at: '2026-10-01T10:00:00.000Z',
  version: 1,
  available: true,
  summary: `Ada mentioned you (${id})`,
  record: { id: 'tsk_1', type: 'task', title: `Task for ${id}`, archived: false },
  brand: { id: 'br_1', name: 'Harbor', short_name: null, icon: 'Leaf', color: '#2a7a4b' },
  project: null,
  actor: { id: 'mem_1', name: 'Ada', type: 'person' },
  ...extra,
});
const page = <T,>(data: T[], more?: string) => ({
  data,
  page: { limit: 25, has_more: !!more, ...(more ? { next_cursor: more } : {}) },
});

const profile = (extra: Partial<Profile> = {}): Profile => ({
  type: 'notification_profile',
  timezone: null,
  effective_timezone: 'Europe/Lisbon',
  quiet_hours: null,
  email_enabled: true,
  browser_enabled: false,
  browser_permission: 'unknown',
  digest_cadence: 'daily',
  daily_digest_time: '08:00',
  weekly_digest_day: 1,
  weekly_digest_time: '09:00',
  version: 3,
  channels: {
    in_app: { state: 'available' },
    email: { state: 'available', provider: 'configured' },
    browser: { state: 'off', permission: 'unknown' },
  },
  ...extra,
});

const defaults: Preferences['defaults'] = [
  {
    event_type: 'mention',
    label: 'Mention',
    in_app: 'immediate',
    email: 'immediate',
    browser: 'immediate',
    security: false,
  },
  {
    event_type: 'comment',
    label: 'Comment',
    in_app: 'immediate',
    email: 'digest',
    browser: 'muted',
    security: false,
  },
  {
    event_type: 'permission_changed',
    label: 'Access change',
    in_app: 'immediate',
    email: 'immediate',
    browser: 'immediate',
    security: true,
  },
];
const prefs = (data: Preference[] = []): Preferences => ({ data, defaults, limit: 50 });

const counts = (unread: number) => ({
  unread,
  mentions_unread: 1,
  reviews_unread: 0,
  saved: 0,
});

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', `/workspaces/${WS}/notifications`);
  vi.spyOn(projects, 'list').mockResolvedValue({ data: [], total: null });
  vi.spyOn(notifications, 'counts').mockResolvedValue(counts(0));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

const wrap = (ui: React.ReactNode) => render(<Router>{ui}</Router>);
const rowOf = (text: string | RegExp) => screen.getByText(text).closest('li') as HTMLElement;

describe('the route registry knows the two fixed addresses', () => {
  it('matches the centre and the settings page and builds their links', () => {
    expect(matchRoute('/workspaces/ws_A/notifications')).toMatchObject({
      def: { id: 'notifications' },
      params: { ws: 'ws_A' },
    });
    expect(matchRoute('/workspaces/ws_A/settings/notifications')?.def.id).toBe(
      'notification_settings',
    );
    expect(routeHref('notifications', { ws: 'ws_A' })).toBe('/workspaces/ws_A/notifications');
  });
});

describe('plain wording', () => {
  it('words delivery states and reasons without content', () => {
    const base = { state: 'suppressed', failure_class: null, failure_code: null } as const;
    expect(deliveryReason({ ...base, suppress_reason: 'provider_unconfigured' })).toBe(
      "Email isn't set up",
    );
    expect(deliveryReason({ ...base, suppress_reason: 'access_lost' })).toBe(
      'You no longer have access',
    );
    expect(
      deliveryReason({
        state: 'deferred_quiet_hours',
        suppress_reason: null,
        failure_class: null,
        failure_code: null,
      }),
    ).toBe('Held for quiet hours');
    expect(
      deliveryReason({
        state: 'failed',
        suppress_reason: null,
        failure_class: 'transient',
        failure_code: 'provider_unreachable',
      }),
    ).toContain("couldn't be reached");
    expect(relativeTime('2026-10-01T10:00:00Z', Date.parse('2026-10-01T10:00:20Z'))).toBe(
      'just now',
    );
    expect(capCount(120)).toBe('99+');
  });
});

describe('the bell', () => {
  it('names its unread count, caps it visually, refetches on focus and after a change', async () => {
    const spy = vi.spyOn(notifications, 'counts').mockResolvedValue(counts(3));
    wrap(<NotificationsMenu ws={WS} />);
    const bell = await screen.findByRole('button', { name: 'Notifications, 3 unread' });
    expect(bell.textContent).toContain('3');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockResolvedValue(counts(150));
    await act(async () => window.dispatchEvent(new Event('focus')));
    const big = await screen.findByRole('button', { name: 'Notifications, 150 unread' });
    expect(big.textContent).toContain('99+');
    spy.mockResolvedValue(counts(0));
    await act(async () => window.dispatchEvent(new Event('pm:notifications-changed')));
    expect(await screen.findByRole('button', { name: 'Notifications, 0 unread' })).toBeTruthy();
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps a plain name when the count could not be read', async () => {
    vi.spyOn(notifications, 'counts').mockRejectedValue(err('network', 0));
    wrap(<NotificationsMenu ws={WS} />);
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeTruthy();
  });

  it('opens a list of the five most recent with links, marks all read, and links on', async () => {
    vi.spyOn(notifications, 'counts').mockResolvedValue(counts(2));
    const list = vi
      .spyOn(notifications, 'list')
      .mockResolvedValue(page([item('ntf_1'), item('ntf_2', { state: 'read' })]));
    const bulk = vi.spyOn(notifications, 'bulk').mockResolvedValue({ updated: 1 });
    wrap(<NotificationsMenu ws={WS} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 2 unread' }));
    const items = await screen.findByRole('list', { name: 'Recent notifications' });
    expect(list).toHaveBeenCalledWith(WS, { limit: 5 });
    expect(within(items).getAllByRole('listitem')).toHaveLength(2);
    expect(within(items).getByRole('link', { name: 'Task for ntf_1' }).getAttribute('href')).toBe(
      '/workspaces/ws_A/tasks/tsk_1',
    );
    expect(
      screen.getByRole('link', { name: 'Open notification centre' }).getAttribute('href'),
    ).toBe('/workspaces/ws_A/notifications');
    expect(screen.getByRole('link', { name: 'Notification settings' }).getAttribute('href')).toBe(
      '/workspaces/ws_A/settings/notifications',
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Mark all read' })));
    expect(bulk).toHaveBeenCalledWith(WS, { all: { tab: 'all' } }, 'read');
  });

  it('is honest when empty, loading, failed (with Retry), and offline', async () => {
    let finish: (v: Page<NotificationItem>) => void = () => undefined;
    const list = vi
      .spyOn(notifications, 'list')
      .mockReturnValueOnce(new Promise((r) => (finish = r)));
    wrap(<BellPanel ws={WS} close={() => undefined} />);
    expect(screen.getByText('Loading notifications…')).toBeTruthy();
    await act(async () => finish(page<NotificationItem>([])));
    expect(screen.getByText("You're all caught up.")).toBeTruthy();
    cleanup();

    list.mockRejectedValueOnce(err('internal_error', 500)).mockResolvedValueOnce(page([]));
    wrap(<BellPanel ws={WS} close={() => undefined} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/couldn't finish loading/);
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: 'Retry' })));
    expect(await screen.findByText("You're all caught up.")).toBeTruthy();
    cleanup();

    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    list.mockRejectedValueOnce(err('offline', 0));
    wrap(<BellPanel ws={WS} close={() => undefined} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/You're offline/);
  });
});

describe('the notification centre', () => {
  it('shows tabs with aria-current, rows with text markers, brand, actor, time and counts', async () => {
    window.history.replaceState(null, '', `/workspaces/${WS}/notifications?tab=mentions`);
    const list = vi.spyOn(notifications, 'list').mockResolvedValue(
      page([
        item('ntf_1', {
          occurrences: 3,
          summary: 'Ada mentioned you',
          project: { id: 'prj_1', name: 'Launch' },
        }),
        item('ntf_2', { state: 'saved', summary: 'Ben mentioned you' }),
      ]),
    );
    wrap(<NotificationCentre ws={WS} />);
    expect(screen.getByRole('link', { name: 'Mentions' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('link', { name: 'All' }).getAttribute('aria-current')).toBeNull();
    const row = await waitFor(() => rowOf(/Ada mentioned you/));
    expect(list).toHaveBeenCalledWith(WS, { tab: 'mentions' });
    expect(within(row).getByText(/Unread/)).toBeTruthy(); // a word, not only colour
    expect(within(row).getByText('3 times')).toBeTruthy();
    expect(within(row).getByText('from Ada')).toBeTruthy();
    expect(within(row).getByText('in Launch')).toBeTruthy();
    expect(within(row).getByText('Harbor')).toBeTruthy();
    expect(within(row).getByRole('link', { name: 'Task for ntf_1' })).toBeTruthy();
    expect(row.querySelector('time')?.getAttribute('title')).toBeTruthy();
    expect(within(rowOf(/Ben mentioned you/)).getByText(/Saved/)).toBeTruthy();
    const actions = within(row).getByRole('group', { name: /Ada mentioned you/ });
    expect(
      within(actions)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Mark read', 'Save', 'Dismiss']);
  });

  it('says what it is doing: loading, empty, failed with Retry, offline', async () => {
    const list = vi
      .spyOn(notifications, 'list')
      .mockRejectedValueOnce(err('offline', 0))
      .mockResolvedValueOnce(page([]));
    wrap(<NotificationCentre ws={WS} />);
    expect(screen.getByText('Loading notifications…')).toBeTruthy();
    expect(await screen.findByText("You're offline")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Try again' })));
    expect(await screen.findByText("You're all caught up.")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('searches (at most 100 characters) and announces the count politely', async () => {
    const list = vi
      .spyOn(notifications, 'list')
      .mockResolvedValueOnce(page([item('ntf_1'), item('ntf_2')]))
      .mockResolvedValueOnce(page([item('ntf_2')]));
    wrap(<NotificationCentre ws={WS} />);
    await screen.findByText(/\(ntf_1\)/);
    const live = screen
      .getAllByRole('status')
      .find(
        (n) =>
          n.getAttribute('aria-live') === 'polite' && /notifications/.test(n.textContent ?? ''),
      )!;
    expect(live.textContent).toBe('2 notifications.');
    const box = screen.getByLabelText('Search notifications', {
      selector: 'input',
    }) as HTMLInputElement;
    expect(box.maxLength).toBe(100);
    fireEvent.change(box, { target: { value: 'launch' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Search' })));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(WS, { tab: 'all', q: 'launch' }));
    await waitFor(() => expect(live.textContent).toBe('1 notification match "launch".'));
    expect(window.location.search).toContain('q=launch');
  });

  it('filters by type, brand, project and unread, and shows dismissed on request', async () => {
    vi.spyOn(projects, 'list').mockResolvedValue({
      data: [{ id: 'prj_1', name: 'Launch' } as never],
      total: null,
    });
    const list = vi.spyOn(notifications, 'list').mockResolvedValue(page([item('ntf_1')]));
    wrap(<NotificationCentre ws={WS} />);
    await screen.findByText(/\(ntf_1\)/);
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'mention' } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(WS, { tab: 'all', type: 'mention' }));
    fireEvent.change(await screen.findByLabelText('Project'), { target: { value: 'prj_1' } });
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(WS, { tab: 'all', type: 'mention', project: 'prj_1' }),
    );
    await act(async () => fireEvent.click(screen.getByLabelText('Unread only')));
    await waitFor(() =>
      expect((list.mock.calls.at(-1)![1] as { unread?: boolean }).unread).toBe(true),
    );
    await act(async () => fireEvent.click(screen.getByLabelText('Show dismissed')));
    await waitFor(() =>
      expect((list.mock.calls.at(-1)![1] as { state?: string }).state).toBe('dismissed'),
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Clear filters' })));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(WS, { tab: 'all' }));
  });

  it('loads more by cursor', async () => {
    const list = vi
      .spyOn(notifications, 'list')
      .mockResolvedValueOnce(page([item('ntf_1')], 'c1'))
      .mockResolvedValueOnce(page([item('ntf_2')]));
    wrap(<NotificationCentre ws={WS} />);
    await screen.findByText(/\(ntf_1\)/);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Load more notifications' })),
    );
    expect(list).toHaveBeenLastCalledWith(WS, { tab: 'all', cursor: 'c1' });
    expect(await screen.findByText(/\(ntf_2\)/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more notifications' })).toBeNull();
  });

  it('changes state at once, then keeps it; dismiss moves focus to the next row', async () => {
    vi.spyOn(notifications, 'list').mockResolvedValue(page([item('ntf_1'), item('ntf_2')]));
    const set = vi
      .spyOn(notifications, 'setState')
      .mockImplementation(async (_ws, id, state) => item(id, { state }));
    wrap(<NotificationCentre ws={WS} />);
    const first = await waitFor(() => rowOf(/ntf_1\)/));
    await act(async () =>
      fireEvent.click(within(first).getByRole('button', { name: 'Mark read' })),
    );
    expect(set).toHaveBeenCalledWith(WS, 'ntf_1', 'read');
    expect(within(first).getByRole('button', { name: 'Mark unread' })).toBeTruthy();
    expect(within(first).queryByText(/Unread/)).toBeNull();
    await act(async () => fireEvent.click(within(first).getByRole('button', { name: 'Save' })));
    expect(within(first).getByRole('button', { name: 'Unsave' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await act(async () => fireEvent.click(within(first).getByRole('button', { name: 'Dismiss' })));
    expect(set).toHaveBeenLastCalledWith(WS, 'ntf_1', 'dismissed');
    expect(screen.queryByText(/ntf_1\)/)).toBeNull();
    expect(document.activeElement?.id).toBe('ntf-row-ntf_2');
    // Last row: focus falls to the list heading.
    await act(async () =>
      fireEvent.click(within(rowOf(/ntf_2\)/)).getByRole('button', { name: 'Dismiss' })),
    );
    expect(document.activeElement?.tagName).toBe('H2');
    expect(await screen.findByText("You're all caught up.")).toBeTruthy();
  });

  it('puts a row back, with a message and Retry, when the change is refused or offline', async () => {
    vi.spyOn(notifications, 'list').mockResolvedValue(page([item('ntf_1'), item('ntf_2')]));
    const set = vi
      .spyOn(notifications, 'setState')
      .mockRejectedValueOnce(err('rate_limited', 429, { retryAfterSeconds: 12 }))
      .mockRejectedValueOnce(err('offline', 0))
      .mockImplementation(async (_ws, id, state) => item(id, { state }));
    wrap(<NotificationCentre ws={WS} />);
    const first = await waitFor(() => rowOf(/ntf_1\)/));
    await act(async () => fireEvent.click(within(first).getByRole('button', { name: 'Dismiss' })));
    // Back where it was, still unread, with the reason.
    const rows = screen.getAllByRole('listitem').filter((li) => li.id.startsWith('ntf-row-'));
    expect(rows.map((r) => r.id)).toEqual(['ntf-row-ntf_1', 'ntf-row-ntf_2']);
    expect(within(rows[0]!).getByText(/Unread/)).toBeTruthy();
    let alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Try again in 12 seconds/);
    expect(alert.textContent).toMatch(/back as it was/);
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: 'Retry' })));
    alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/offline/i);
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: 'Retry' })));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(set).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/ntf_1\)/)).toBeNull(); // the third try went through
  });

  it('a 404 on a row says it is no longer available and the refresh drops it', async () => {
    const list = vi
      .spyOn(notifications, 'list')
      .mockResolvedValueOnce(page([item('ntf_1'), item('ntf_2')]))
      .mockResolvedValueOnce(page([item('ntf_2')]));
    vi.spyOn(notifications, 'setState').mockRejectedValue(err('not_found', 404));
    wrap(<NotificationCentre ws={WS} />);
    const first = await waitFor(() => rowOf(/ntf_1\)/));
    await act(async () =>
      fireEvent.click(within(first).getByRole('button', { name: 'Mark read' })),
    );
    expect(screen.getByText('This notification is no longer available to you.')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/no longer available to you/);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Refresh the list' })),
    );
    await waitFor(() => expect(screen.queryByText(/no longer available to you/)).toBeNull());
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/\(ntf_2\)/)).toBeTruthy();
  });

  it('shows only the server words, time, and state controls for an item that is no longer available', async () => {
    vi.spyOn(notifications, 'list').mockResolvedValue(
      page([
        item('ntf_1', {
          available: false,
          summary: 'You no longer have access to this item',
          record: null,
          brand: null,
          actor: null,
        }),
      ]),
    );
    wrap(<NotificationCentre ws={WS} />);
    const row = await waitFor(() => rowOf('You no longer have access to this item'));
    expect(within(row).queryByRole('link')).toBeNull();
    expect(within(row).queryByText(/from /)).toBeNull();
    expect(row.querySelector('time')).toBeTruthy();
    expect(
      within(row)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Mark read', 'Save', 'Dismiss']);
  });

  it('marks a notification read when its link is opened', async () => {
    vi.spyOn(notifications, 'list').mockResolvedValue(page([item('ntf_1')]));
    const set = vi
      .spyOn(notifications, 'setState')
      .mockResolvedValue(item('ntf_1', { state: 'read' }));
    wrap(<NotificationCentre ws={WS} />);
    const row = await waitFor(() => rowOf(/ntf_1\)/));
    fireEvent.click(within(row).getByRole('link', { name: 'Task for ntf_1' }));
    expect(set).toHaveBeenCalledWith(WS, 'ntf_1', 'read');
  });

  it('acts on a selection, and marks the whole tab read', async () => {
    vi.spyOn(notifications, 'list').mockResolvedValue(
      page([item('ntf_1'), item('ntf_2'), item('ntf_3')]),
    );
    const bulk = vi.spyOn(notifications, 'bulk').mockResolvedValue({ updated: 2 });
    wrap(<NotificationCentre ws={WS} />);
    await screen.findByText(/ntf_1\)/);
    expect(
      (screen.getByRole('button', { name: 'Mark selected read' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByLabelText('Select: Ada mentioned you (ntf_1)'));
    fireEvent.click(screen.getByLabelText('Select: Ada mentioned you (ntf_2)'));
    expect(screen.getByText('2 selected')).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Mark selected read' })),
    );
    expect(bulk).toHaveBeenCalledWith(WS, { ids: ['ntf_1', 'ntf_2'] }, 'read');
    const set = vi
      .spyOn(notifications, 'setState')
      .mockImplementation(async (_ws, id, state) => item(id, { state }));
    fireEvent.click(screen.getByLabelText('Select: Ada mentioned you (ntf_3)'));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss selected' })),
    );
    expect(set).toHaveBeenCalledWith(WS, 'ntf_3', 'dismissed'); // one item is a plain change
    expect(document.activeElement?.tagName).toBe('H2');
  });

  it('marks all read for the tab in one request', async () => {
    window.history.replaceState(null, '', `/workspaces/${WS}/notifications?tab=reviews`);
    const list = vi.spyOn(notifications, 'list').mockResolvedValue(page([item('ntf_1')]));
    const bulk = vi.spyOn(notifications, 'bulk').mockResolvedValue({ updated: 4 });
    wrap(<NotificationCentre ws={WS} />);
    await screen.findByText(/ntf_1\)/);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Mark all read' })));
    expect(bulk).toHaveBeenCalledWith(WS, { all: { tab: 'reviews' } }, 'read');
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(
      screen.getAllByRole('status').some((s) => s.textContent === 'Marked 4 notifications read.'),
    ).toBe(true);
  });

  it('groups similar rows and expands them from their ids', async () => {
    window.history.replaceState(null, '', `/workspaces/${WS}/notifications?group=true`);
    const list = vi.spyOn(notifications, 'list').mockResolvedValue(
      page([
        item('ntf_1', {
          notification_type: 'comment',
          group: 'g1',
          group_count: 3,
          group_ids: ['ntf_1', 'ntf_2', 'ntf_3'],
        }),
      ]),
    );
    const get = vi
      .spyOn(notifications, 'get')
      .mockImplementation(async (_ws, id) => item(id, { summary: `Similar ${id}` }));
    const bulk = vi.spyOn(notifications, 'bulk').mockResolvedValue({ updated: 3 });
    wrap(<NotificationCentre ws={WS} />);
    expect(((await screen.findByLabelText('Group similar')) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(list).toHaveBeenCalledWith(WS, { tab: 'all', group: true });
    const more = await screen.findByRole('button', { name: '+2 similar' });
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByText(/Similar ntf_2/)).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
    // Actions on the lead apply to the whole group.
    const row = rowOf(/ntf_1\)/);
    expect(within(row).getByText('Applies to all 3 similar')).toBeTruthy();
    await act(async () => fireEvent.click(within(row).getByRole('button', { name: 'Mark read' })));
    expect(bulk).toHaveBeenCalledWith(WS, { ids: ['ntf_1', 'ntf_2', 'ntf_3'] }, 'read');
  });
});

describe('notification settings: profile', () => {
  const open = async (p = profile(), d = prefs()) => {
    vi.spyOn(notifications, 'profile').mockResolvedValue(p);
    vi.spyOn(notifications, 'preferences').mockResolvedValue(d);
    vi.spyOn(notifications, 'myDeliveries').mockResolvedValue(page([]));
    vi.spyOn(notifications, 'health').mockRejectedValue(err('forbidden', 403));
    wrap(<NotificationSettings ws={WS} />);
    await screen.findByRole('heading', { name: 'Time, quiet hours, and digest' });
  };

  it('says honestly that email is not set up, and never says "sent"', async () => {
    await open(
      profile({
        channels: {
          ...profile().channels,
          email: { state: 'not_configured', provider: 'unconfigured' },
        },
      }),
    );
    expect(
      screen.getAllByText("Email isn't set up for this workspace yet, so nothing is sent.").length,
    ).toBeGreaterThan(0);
  });

  it('saves with the profile version, quiet hours and a weekly digest, and explains quiet hours', async () => {
    const save = vi
      .spyOn(notifications, 'saveProfile')
      .mockResolvedValue(profile({ version: 4, digest_cadence: 'weekly' }));
    await open();
    fireEvent.click(
      screen.getByLabelText('Hold email and browser notifications during quiet hours'),
    );
    expect(screen.getByText(/Security notices and the in-app centre are never held/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Quiet hours start'), { target: { value: '21:30' } });
    fireEvent.change(screen.getByLabelText('Quiet hours end'), { target: { value: '06:45' } });
    fireEvent.change(screen.getByLabelText('Send me a digest'), { target: { value: 'weekly' } });
    fireEvent.change(screen.getByLabelText('Weekly digest day'), { target: { value: '5' } });
    expect(screen.getByText(/one digest at a time/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'Europe/Paris' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save settings' })));
    expect(save).toHaveBeenCalledWith(
      WS,
      {
        timezone: 'Europe/Paris',
        quiet_hours: { start: '21:30', end: '06:45' },
        email_enabled: true,
        digest_cadence: 'weekly',
        daily_digest_time: '08:00',
        weekly_digest_day: 5,
        weekly_digest_time: '09:00',
      },
      3,
      expect.any(String),
    );
    expect(screen.getAllByRole('status').some((s) => s.textContent === 'Saved.')).toBe(true);
  });

  it('refuses identical quiet-hour times without asking the server', async () => {
    const save = vi.spyOn(notifications, 'saveProfile');
    await open();
    fireEvent.click(
      screen.getByLabelText('Hold email and browser notifications during quiet hours'),
    );
    fireEvent.change(screen.getByLabelText('Quiet hours start'), { target: { value: '07:00' } });
    fireEvent.change(screen.getByLabelText('Quiet hours end'), { target: { value: '07:00' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save settings' })));
    expect(screen.getByText(/different start and end times/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it('on a 409 reloads the latest version, keeps the edits, and saves again with the new version', async () => {
    const save = vi
      .spyOn(notifications, 'saveProfile')
      .mockRejectedValueOnce(err('conflict', 409, { conflict: { current_version: 9 } }))
      .mockResolvedValueOnce(profile({ version: 10 }));
    await open();
    fireEvent.change(screen.getByLabelText('Send me a digest'), { target: { value: 'off' } });
    vi.mocked(notifications.profile).mockResolvedValue(
      profile({ version: 9, email_enabled: false }),
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save settings' })));
    expect(screen.getByRole('alert').textContent).toMatch(/kept your edits/);
    expect((screen.getByLabelText('Send me a digest') as HTMLSelectElement).value).toBe('off');
    // What they did not touch takes the newer value from the other change.
    expect((screen.getByLabelText('Email me notifications') as HTMLInputElement).checked).toBe(
      false,
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save settings' })));
    expect(save.mock.calls[1]![2]).toBe(9);
    expect(save.mock.calls[1]![1]).toMatchObject({ digest_cadence: 'off', email_enabled: false });
  });

  it('keeps edits when offline and retries with the same request key', async () => {
    const save = vi
      .spyOn(notifications, 'saveProfile')
      .mockRejectedValueOnce(err('offline', 0))
      .mockResolvedValueOnce(profile({ version: 4 }));
    await open();
    fireEvent.click(screen.getByLabelText('Email me notifications'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save settings' })));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Your edits are kept here/);
    expect((screen.getByLabelText('Email me notifications') as HTMLInputElement).checked).toBe(
      false,
    );
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: 'Retry' })));
    expect(save.mock.calls[1]![3]).toBe(save.mock.calls[0]![3]);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  static made: Array<{ title: string; options: NotificationOptions | undefined }> = [];
  static fail = false;
  onclick: (() => void) | null = null;
  constructor(title: string, options?: NotificationOptions) {
    if (FakeNotification.fail) throw new TypeError('Illegal constructor');
    FakeNotification.made.push({ title, options });
  }
  close() {}
}

describe('browser notifications', () => {
  beforeEach(() => {
    FakeNotification.permission = 'default';
    FakeNotification.requestPermission.mockClear();
    FakeNotification.made = [];
    FakeNotification.fail = false;
    vi.stubGlobal('Notification', FakeNotification);
    vi.spyOn(notifications, 'profile').mockResolvedValue(profile());
    vi.spyOn(notifications, 'preferences').mockResolvedValue(prefs());
    vi.spyOn(notifications, 'myDeliveries').mockResolvedValue(page([]));
    vi.spyOn(notifications, 'health').mockRejectedValue(err('forbidden', 403));
  });
  const openSettings = async () => {
    wrap(<NotificationSettings ws={WS} />);
    await screen.findByRole('heading', { name: 'Browser notifications' });
  };

  it('asks for permission only when the button is clicked, then saves granted', async () => {
    const save = vi
      .spyOn(notifications, 'saveProfile')
      .mockResolvedValue(
        profile({ version: 4, browser_enabled: true, browser_permission: 'granted' }),
      );
    await openSettings();
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    FakeNotification.permission = 'granted';
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Turn on browser notifications' })),
    );
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      WS,
      { browser_enabled: true, browser_permission: 'granted' },
      3,
    );
    expect(
      screen.getAllByRole('status').some((s) => s.textContent === 'Browser notifications are on.'),
    ).toBe(true);
  });

  it('explains how to re-enable when denied, and does not ask again on its own', async () => {
    const save = vi
      .spyOn(notifications, 'saveProfile')
      .mockResolvedValue(
        profile({ version: 4, browser_enabled: true, browser_permission: 'denied' }),
      );
    await openSettings();
    FakeNotification.permission = 'denied';
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Turn on browser notifications' })),
    );
    expect(save).toHaveBeenCalledWith(
      WS,
      { browser_enabled: true, browser_permission: 'denied' },
      3,
    );
    expect(screen.getByText('Your browser is blocking notifications for this site')).toBeTruthy();
    expect(screen.getByText(/site settings/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Turn on browser notifications' })).toBeNull();
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('says so, and offers no button, when the browser has no notifications', async () => {
    vi.stubGlobal('Notification', undefined);
    await openSettings();
    expect(screen.getAllByText(/doesn't support notifications/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Turn on browser notifications' })).toBeNull();
  });

  it('shows what is waiting, reports shown, and reports declined if the browser refuses', async () => {
    FakeNotification.permission = 'granted';
    vi.spyOn(notifications, 'profile').mockResolvedValue(
      profile({ browser_enabled: true, browser_permission: 'granted' }),
    );
    const pending = vi
      .spyOn(notifications, 'browserPending')
      .mockResolvedValueOnce([
        {
          delivery: 'ndl_1',
          notification: 'ntf_1',
          title: 'Harbor · Ada mentioned you: Plan',
          path: '/workspaces/ws_A/tasks/tsk_1',
        },
      ])
      .mockResolvedValueOnce([
        {
          delivery: 'ndl_2',
          notification: 'ntf_2',
          title: 'Another',
          path: '/workspaces/ws_A/tasks/tsk_2',
        },
      ])
      .mockResolvedValue([]);
    const ack = vi.spyOn(notifications, 'ack').mockResolvedValue({});
    wrap(<BrowserNotifier ws={WS} />);
    await waitFor(() => expect(ack).toHaveBeenCalledWith(WS, 'ndl_1', 'shown'));
    expect(FakeNotification.made).toEqual([
      { title: 'Harbor · Ada mentioned you: Plan', options: { tag: 'ndl_1' } },
    ]);
    FakeNotification.fail = true;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(ack).toHaveBeenCalledWith(WS, 'ndl_2', 'declined'));
    expect(pending).toHaveBeenCalled();
  });

  it('never polls while not turned on or not permitted', async () => {
    FakeNotification.permission = 'denied';
    vi.spyOn(notifications, 'profile').mockResolvedValue(
      profile({ browser_enabled: true, browser_permission: 'denied' }),
    );
    const pending = vi.spyOn(notifications, 'browserPending').mockResolvedValue([]);
    wrap(<BrowserNotifier ws={WS} />);
    await act(async () => undefined);
    expect(pending).not.toHaveBeenCalled();
  });
});

describe('notification settings: preferences and mutes', () => {
  const open = async (d: Preferences) => {
    vi.spyOn(notifications, 'profile').mockResolvedValue(profile());
    const get = vi.spyOn(notifications, 'preferences').mockResolvedValue(d);
    vi.spyOn(notifications, 'myDeliveries').mockResolvedValue(page([]));
    vi.spyOn(notifications, 'health').mockRejectedValue(err('forbidden', 403));
    wrap(<NotificationSettings ws={WS} />);
    await screen.findByRole('heading', { name: 'What you get, by type' });
    return get;
  };

  it('lists defaults, marks security as always on, and saves or clears an override', async () => {
    const set = vi.spyOn(notifications, 'setPreference').mockResolvedValue({});
    const remove = vi.spyOn(notifications, 'removePreference').mockResolvedValue({});
    const get = await open(prefs());
    expect(screen.getByText("Always on. Security notices can't be muted.")).toBeTruthy();
    expect(screen.queryByLabelText('Email for Access change')).toBeNull();
    const select = screen.getByLabelText('Email for Comment') as HTMLSelectElement;
    expect(select.value).toBe('default');
    expect(within(select).getByRole('option', { name: 'Default: In the digest' })).toBeTruthy();
    get.mockResolvedValue(
      prefs([
        {
          event_type: 'comment',
          scope: 'workspace',
          scope_kind: 'workspace',
          scope_name: null,
          channel: 'email',
          mode: 'muted',
          expires_at: null,
        },
      ]),
    );
    await act(async () => fireEvent.change(select, { target: { value: 'muted' } }));
    expect(set).toHaveBeenCalledWith(WS, {
      event_type: 'comment',
      scope: 'workspace',
      channel: 'email',
      mode: 'muted',
    });
    await waitFor(() =>
      expect((screen.getByLabelText('Email for Comment') as HTMLSelectElement).value).toBe('muted'),
    );
    get.mockResolvedValue(prefs());
    await act(async () =>
      fireEvent.change(screen.getByLabelText('Email for Comment'), {
        target: { value: 'default' },
      }),
    );
    expect(remove).toHaveBeenCalledWith(WS, {
      event_type: 'comment',
      scope: 'workspace',
      channel: 'email',
    });
    expect(screen.getByText(/0 of 50 saved choices/)).toBeTruthy();
  });

  it('lists mutes with scope names and expiry, removes one, and says so for a place no longer open', async () => {
    const remove = vi.spyOn(notifications, 'removePreference').mockResolvedValue({});
    const get = await open(
      prefs([
        {
          event_type: '*',
          scope: 'br_1',
          scope_kind: 'brand',
          scope_name: 'Harbor',
          channel: 'all',
          mode: 'muted',
          expires_at: '2099-01-01T10:00:00.000Z',
        },
        {
          event_type: 'comment',
          scope: null,
          scope_kind: 'project',
          scope_name: null,
          channel: 'email',
          mode: 'muted',
          expires_at: null,
        },
      ]),
    );
    const mutes = screen.getByRole('list', { name: 'Your mutes' });
    const [harbor, gone] = within(mutes).getAllByRole('listitem');
    expect(harbor!.textContent).toContain('Brand: Harbor');
    expect(harbor!.textContent).toContain('All notifications');
    expect(harbor!.textContent).toMatch(/until /);
    expect(gone!.textContent).toContain('A place you can no longer open');
    expect(within(gone!).queryByRole('button')).toBeNull();
    get.mockResolvedValue(prefs());
    await act(async () =>
      fireEvent.click(within(harbor!).getByRole('button', { name: /^Remove mute: Brand: Harbor/ })),
    );
    expect(remove).toHaveBeenCalledWith(WS, { event_type: '*', scope: 'br_1', channel: 'all' });
  });

  it('adds a mute for a project with an expiry', async () => {
    vi.spyOn(projects, 'list').mockResolvedValue({
      data: [{ id: 'prj_1', name: 'Launch' } as never],
      total: null,
    });
    const set = vi.spyOn(notifications, 'setPreference').mockResolvedValue({});
    await open(prefs());
    await screen.findByRole('option', { name: 'Launch' });
    fireEvent.change(screen.getByLabelText('Mute'), { target: { value: 'prj_1' } });
    fireEvent.change(screen.getByLabelText('What to mute'), { target: { value: 'comment' } });
    fireEvent.change(screen.getByLabelText('For how long'), { target: { value: 'day' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add mute' })));
    const body = set.mock.calls[0]![1];
    expect(body).toMatchObject({
      event_type: 'comment',
      scope: 'prj_1',
      channel: 'all',
      mode: 'muted',
    });
    expect(Date.parse(body.expires_at!) - Date.now()).toBeGreaterThan(23 * 3600_000);
  });

  it('tells the person the cap was reached', async () => {
    vi.spyOn(notifications, 'setPreference').mockRejectedValue(
      err('validation_failed', 422, {
        issues: [{ code: 'too_many', message: 'You can keep at most 50 notification choices.' }],
      }),
    );
    await open(prefs());
    fireEvent.change(screen.getByLabelText('Mute'), { target: { value: '' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add mute' })));
    expect(screen.getByText('Choose what to mute.')).toBeTruthy();
  });
});

describe('notification settings: deliveries', () => {
  const delivery = (id: string, extra: Partial<Delivery> = {}): Delivery => ({
    id,
    type: 'notification_delivery',
    channel: 'email',
    kind: 'notification',
    state: 'suppressed',
    attempts: 0,
    failure_class: null,
    failure_code: null,
    suppress_reason: 'provider_unconfigured',
    notification: 'ntf_1',
    notification_type: 'mention',
    created_at: '2026-10-01T10:00:00.000Z',
    updated_at: '2026-10-01T10:00:00.000Z',
    delivered_at: null,
    ...extra,
  });
  const base = () => {
    vi.spyOn(notifications, 'profile').mockResolvedValue(profile());
    vi.spyOn(notifications, 'preferences').mockResolvedValue(prefs());
  };

  it('shows recent deliveries in plain words, never content', async () => {
    base();
    vi.spyOn(notifications, 'health').mockRejectedValue(err('forbidden', 403));
    vi.spyOn(notifications, 'myDeliveries').mockResolvedValue(
      page([
        delivery('ndl_1'),
        delivery('ndl_2', {
          channel: 'browser',
          state: 'suppressed',
          suppress_reason: 'access_lost',
        }),
        delivery('ndl_3', { state: 'deferred_quiet_hours', suppress_reason: null }),
        delivery('ndl_4', { state: 'delivered', suppress_reason: null, kind: 'digest' }),
      ]) as never,
    );
    wrap(<NotificationSettings ws={WS} />);
    const list = await screen.findByRole('list', { name: 'Recent deliveries' });
    const rows = within(list)
      .getAllByRole('listitem')
      .map((r) => r.textContent);
    expect(rows[0]).toMatch(/Email · Mention · Not sent · Email isn't set up/);
    expect(rows[1]).toMatch(/Browser · Mention · Not sent · You no longer have access/);
    expect(rows[2]).toMatch(/Held until quiet hours end · Held for quiet hours/);
    expect(rows[3]).toMatch(/Digest email · Mention · Delivered/);
  });

  it('hides delivery health from people who are not administrators', async () => {
    base();
    vi.spyOn(notifications, 'myDeliveries').mockResolvedValue(page([]));
    const health = vi.spyOn(notifications, 'health').mockRejectedValue(err('forbidden', 403));
    wrap(<NotificationSettings ws={WS} />);
    await screen.findByText(/Nothing has been sent to you/);
    await waitFor(() => expect(health).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Delivery health' })).toBeNull();
  });

  it('shows failed deliveries to administrators and retries one with a clear result', async () => {
    base();
    vi.spyOn(notifications, 'myDeliveries').mockResolvedValue(page([]));
    const health = vi.spyOn(notifications, 'health').mockResolvedValue({
      ...page(
        [
          delivery('ndl_1', {
            state: 'dead',
            suppress_reason: null,
            failure_class: 'permanent',
            failure_code: 'provider_rejected',
            attempts: 5,
            recipient: { id: 'mem_2', name: 'Milo Member' },
          }),
          delivery('ndl_2', {
            state: 'failed',
            suppress_reason: null,
            failure_class: 'transient',
            failure_code: 'provider_unreachable',
            attempts: 2,
            recipient: { id: 'mem_3', name: 'Rae Reader' },
          }),
        ],
        'next',
      ),
      email: 'configured',
    });
    const retry = vi
      .spyOn(notifications, 'retry')
      .mockResolvedValueOnce({ id: 'ndl_1', state: 'pending' })
      .mockRejectedValueOnce(
        err('conflict', 409, {
          issues: [{ code: 'not_retryable', message: 'Only a failed delivery can be retried.' }],
        }),
      );
    wrap(<NotificationSettings ws={WS} />);
    const section = (await screen.findByRole('heading', { name: 'Delivery health' })).closest(
      'section',
    )!;
    expect(within(section).getByText(/Email is set up and sending/)).toBeTruthy();
    const list = within(section).getByRole('list', { name: 'Failed deliveries' });
    expect(within(list).getAllByRole('listitem')[0]!.textContent).toMatch(
      /Milo Member · Email · Mention · Failed, no more tries · A permanent problem: The provider rejected it · 5 attempts/,
    );
    await act(async () =>
      fireEvent.click(
        within(section).getByRole('button', { name: /^Retry delivery to Milo Member/ }),
      ),
    );
    expect(retry).toHaveBeenCalledWith(WS, 'ndl_1');
    expect(within(section).getByText(/Queued again for Milo Member/)).toBeTruthy();
    expect(within(section).queryByText(/Milo Member ·/)).toBeNull();
    await act(async () =>
      fireEvent.click(
        within(section).getByRole('button', { name: /^Retry delivery to Rae Reader/ }),
      ),
    );
    expect(within(section).getByRole('alert').textContent).toMatch(/can't be retried/);
    health.mockResolvedValueOnce({
      ...page([
        delivery('ndl_9', {
          state: 'failed',
          suppress_reason: null,
          failure_class: 'transient',
          failure_code: 'transport_error',
          recipient: { id: 'm', name: 'Zed' },
        }),
      ]),
      email: 'configured',
    });
    await act(async () =>
      fireEvent.click(within(section).getByRole('button', { name: 'Load more failed deliveries' })),
    );
    expect(health).toHaveBeenLastCalledWith(WS, { cursor: 'next' });
    expect(await within(section).findByText(/Zed ·/)).toBeTruthy();
  });

  it('says plainly when email is not set up for the workspace', async () => {
    base();
    vi.spyOn(notifications, 'myDeliveries').mockResolvedValue(page([]));
    vi.spyOn(notifications, 'health').mockResolvedValue({
      ...page([]),
      email: 'unconfigured',
    });
    wrap(<NotificationSettings ws={WS} />);
    const section = (await screen.findByRole('heading', { name: 'Delivery health' })).closest(
      'section',
    )!;
    expect(
      within(section).getByText("Email isn't set up for this workspace yet, so nothing is sent."),
    ).toBeTruthy();
    expect(within(section).getByText('No deliveries have failed.')).toBeTruthy();
  });
});

describe('defaults for a brand or project', () => {
  it('is hidden when the server refuses to show it, and edits when it does', async () => {
    const get = vi.spyOn(notifications, 'scopeDefaults').mockRejectedValue(err('not_found', 404));
    const { container } = wrap(
      <ScopeDefaultsEditor ws={WS} kind="brands" id="br_1" name="Harbor" />,
    );
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    cleanup();

    get
      .mockReset()
      .mockResolvedValue([{ event_type: 'comment', channel: 'email', mode: 'digest' }]);
    const set = vi.spyOn(notifications, 'setScopeDefault').mockResolvedValue({});
    const remove = vi.spyOn(notifications, 'removeScopeDefault').mockResolvedValue({});
    wrap(<ScopeDefaultsEditor ws={WS} kind="projects" id="prj_1" name="Launch" />);
    const list = await screen.findByRole('list', { name: 'Defaults' });
    expect(list.textContent).toContain('Comment · Email: In the digest');
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'in_app' } });
    fireEvent.change(screen.getByLabelText('Default'), { target: { value: 'muted' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save default' })));
    expect(set).toHaveBeenCalledWith(WS, 'projects', 'prj_1', {
      event_type: '*',
      channel: 'in_app',
      mode: 'muted',
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Remove default/ })));
    expect(remove).toHaveBeenCalledWith(WS, 'projects', 'prj_1', {
      event_type: 'comment',
      channel: 'email',
    });
    set.mockRejectedValue(err('forbidden', 403));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save default' })));
    expect(screen.getByRole('alert').textContent).toMatch(/don't have permission to change/);
  });
});
