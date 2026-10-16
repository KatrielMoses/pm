import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from '../src/integrations/calendar-panel.tsx';
import { IntegrationsPanel } from '../src/integrations/panel.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const WS = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const connection = {
  id: 'conn_1',
  type: 'connection',
  version: 1,
  provider: 'google_calendar',
  auth_kind: 'oauth',
  display_name: 'Google Calendar',
  owner: { id: 'mem_1', name: 'Ada Owner' },
  scopes: ['calendar.read'],
  health: 'connected',
  credential_configured: true,
  key_version: 1,
  last_success_at: '2026-10-10T08:00:00.000Z',
  last_error: 'provider_rate_limited',
  suspended_reason: null,
  outbound_paused: false,
  retention_choice: null,
  provider_configured: true,
  provider_mode: 'test_double',
};

/** A fake server: each request is routed by method and path; anything unknown is a 404. */
function serve(overrides: {
  configured?: boolean;
  connections?: unknown[];
  calendars?: number;
  resolve?: () => Response;
  create?: () => Response;
}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path.endsWith('/integrations/providers'))
      return json(200, {
        data: {
          type: 'integration_providers',
          providers: [
            {
              id: 'google_calendar',
              label: 'Google Calendar',
              phase: '6C',
              scopes: ['calendar.read', 'calendar.write'],
              configured: overrides.configured ?? true,
              unavailable:
                overrides.configured === false
                  ? 'Google Calendar is not configured in this environment.'
                  : null,
            },
          ],
        },
      });
    if (path.endsWith('/integrations/connections') && method === 'GET')
      return json(200, {
        data: {
          type: 'integration_connections',
          connections: overrides.connections ?? [connection],
        },
      });
    if (path.endsWith('/integrations/connections') && method === 'POST')
      return overrides.create?.() ?? json(500, {});
    if (path.endsWith('/conn_1/calendars') && method === 'GET')
      return overrides.calendars
        ? json(overrides.calendars, { error: { code: 'not_found', message: 'Not found.' } })
        : json(200, {
            data: {
              type: 'calendar_sources',
              calendars: [
                {
                  id: 'cal_1',
                  type: 'calendar_source',
                  label: 'Work',
                  timezone: 'Europe/Lisbon',
                  access_role: 'reader',
                  primary: true,
                  selected: true,
                  direction: 'read',
                  two_way_available: false,
                  brand: null,
                  last_synced_at: null,
                },
              ],
            },
          });
    if (path.endsWith('/conn_1/runs'))
      return json(200, {
        data: {
          type: 'sync_runs',
          runs: [
            {
              state: 'failed',
              direction: 'inbound',
              attempt: 1,
              error_code: 'provider_unavailable',
              read_count: 0,
              write_count: 0,
              conflict_count: 0,
              started_at: '2026-10-10T08:00:00.000Z',
              finished_at: '2026-10-10T08:00:01.000Z',
            },
          ],
        },
      });
    if (path.endsWith('/calendar-conflicts'))
      return json(200, {
        data: {
          type: 'calendar_conflicts',
          conflicts: [
            {
              id: 'cnf_1',
              type: 'sync_conflict',
              connection: 'conn_1',
              calendar: 'Work',
              can_keep_local: true,
              event: {
                id: 'cev_1',
                title: 'Standup',
                starts_at: '2026-10-12T09:00:00.000Z',
                ends_at: '2026-10-12T09:30:00.000Z',
                all_day: false,
              },
              block: {
                id: 'blk_1',
                starts_at: '2026-10-12T10:00:00.000Z',
                ends_at: '2026-10-12T10:30:00.000Z',
              },
            },
          ],
        },
      });
    if (path.includes('/conflicts/cnf_1/resolve')) return overrides.resolve?.() ?? json(200, {});
    return json(404, { error: { code: 'not_found', message: 'Not found.' } });
  });
  vi.stubGlobal('fetch', fetch);
  return calls;
}

/** The connection card once its first load has settled (aria-busy="false" and calendars shown). */
async function loadedCard() {
  await waitFor(
    () => {
      const el = document.querySelector('[data-connection="conn_1"]');
      expect(el?.getAttribute('aria-busy')).toBe('false');
      expect(el?.querySelector('[data-conflict]')).toBeTruthy();
    },
    { timeout: 3000 },
  );
  return document.querySelector<HTMLElement>('[data-connection="conn_1"]')!;
}

const section = () => screen.getByRole('region', { name: 'Google Calendar' });

describe('Google Calendar settings (6C)', () => {
  it('says plainly when the provider is not configured and offers no connect button', async () => {
    serve({ configured: false, connections: [] });
    render(<IntegrationsPanel ws={WS} />);
    expect(
      await screen.findByText('Google Calendar is not configured in this environment.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect Google Calendar' })).toBeNull();
  });

  it('connects through the provider: the browser goes to the authorization address', async () => {
    const calls = serve({
      connections: [],
      create: () =>
        json(201, {
          data: { ...connection, authorization_url: 'https://accounts.google.com/o/oauth2/auth?x' },
        }),
    });
    const assign = vi.spyOn(browser, 'assign').mockImplementation(() => undefined);
    render(<IntegrationsPanel ws={WS} />);
    const button = await screen.findByRole('button', { name: 'Connect Google Calendar' });
    expect((screen.getByLabelText('Connection name') as HTMLInputElement).value).toBe(
      'Google Calendar',
    );
    fireEvent.click(screen.getByLabelText('Allow moving events (two-way)'));
    await act(async () => fireEvent.click(button));
    expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/auth?x');
    const create = calls.find((c) => c.method === 'POST')!;
    expect(create.body).toEqual({
      provider: 'google_calendar',
      auth_kind: 'oauth',
      display_name: 'Google Calendar',
      scopes: ['calendar.read', 'calendar.write'],
    });
    expect(section().getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Opening Google to authorize…')).toBeTruthy();
  });

  it('announces the callback outcome and removes it from the address', async () => {
    window.history.replaceState(
      null,
      '',
      `/workspaces/${WS}/settings/integrations?connection=conn_1&calendar=denied`,
    );
    serve({ connections: [] });
    render(<IntegrationsPanel ws={WS} />);
    expect(
      (await screen.findAllByRole('alert')).some((a) => /access was declined/.test(a.textContent!)),
    ).toBe(true);
    expect(window.location.search).toBe('');
    expect(window.location.pathname).toBe(`/workspaces/${WS}/settings/integrations`);
  });

  it('shows the owner calendars, runs, and conflicts with an honest test-double label', async () => {
    serve({});
    render(<IntegrationsPanel ws={WS} />);
    const card = await loadedCard();
    expect(within(card).getByText('Test double — not a real Google account')).toBeTruthy();
    expect(within(card).getByText(/asked us to slow down/)).toBeTruthy();
    expect(within(card).getByRole('checkbox', { name: /^Include\s*Work$/ })).toBeTruthy();
    const direction = within(card).getByLabelText(/^Direction\s*for Work$/) as HTMLSelectElement;
    expect(
      (within(direction).getByRole('option', { name: 'Two-way' }) as HTMLOptionElement).disabled,
    ).toBe(true);
    expect(within(card).getByRole('button', { name: 'Save calendars' })).toBeTruthy();
    expect(within(card).getByText('Failed')).toBeTruthy();
    expect(card.querySelector('[data-conflict="cnf_1"] strong')!.textContent).toBe('Standup');
    expect(within(card).getByRole('button', { name: /^Keep my plan\s*for Standup$/ })).toBeTruthy();
    expect(within(card).getByRole('button', { name: /^Unlink\s*Standup$/ })).toBeTruthy();
    expect(within(card).getByRole('button', { name: /^Sync now/ })).toBeTruthy();
    expect(within(card).getByRole('button', { name: /^Reauthorize/ })).toBeTruthy();
    expect(within(card).getByRole('button', { name: /^Disconnect/ })).toBeTruthy();
  });

  it('shows a refused conflict resolution as an alert and settles', async () => {
    serve({
      resolve: () =>
        json(409, {
          error: {
            code: 'conflict',
            message: 'Conflict.',
            issues: [
              {
                pointer: '/resolution',
                code: 'locked',
                message: 'The block is locked. Unlock it, then choose again.',
              },
            ],
          },
        }),
    });
    render(<IntegrationsPanel ws={WS} />);
    const card = await loadedCard();
    const button = within(card).getByRole('button', {
      name: /^Use the calendar's time\s*for Standup$/,
    });
    await act(async () => fireEvent.click(button));
    await waitFor(() => expect(card.getAttribute('aria-busy')).toBe('false'));
    expect(within(card).getByRole('alert').textContent).toBe(
      'The block is locked. Unlock it, then choose again.',
    );
  });

  it('treats another member connection as not theirs without an error', async () => {
    serve({ calendars: 404 });
    render(<IntegrationsPanel ws={WS} />);
    expect(await screen.findByText(/This calendar belongs to Ada Owner/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save calendars' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
