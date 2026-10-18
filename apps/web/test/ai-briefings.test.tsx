import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BriefingPage, BriefingSettingsPage, BriefingsPage } from '../src/ai/briefings-page.tsx';
import { clearProposalDrafts } from '../src/shell/drafts.ts';
import { Router } from '../src/router.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

const WS = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const BRF = 'brf_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TSK = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function serve(routes: Record<string, (body: any) => Response>) {
  const calls: Array<{ method: string; path: string; body: any; key: string | null }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, path, body, key: new Headers(init?.headers).get('idempotency-key') });
      for (const [k, fn] of Object.entries(routes)) {
        const [m, suffix] = k.split(' ') as [string, string];
        if (m === method && path.endsWith(suffix)) return fn(body);
      }
      return json(404, { error: { code: 'not_found', status: 404, message: 'Not found' } });
    }),
  );
  return calls;
}

const briefing = (over: Record<string, unknown> = {}) => ({
  id: BRF,
  type: 'briefing',
  kind: 'owner_daily',
  kind_label: 'Daily briefing',
  scope: { key: 'workspace' },
  trigger: 'schedule',
  state: 'published',
  failure_code: null,
  timezone: 'UTC',
  window: { start: '2026-10-17T00:00:00Z', end: '2026-10-18T08:00:00Z' },
  baseline: null,
  first: true,
  regenerates: null,
  mode: 'fact_only',
  content: 'present',
  published_at: '2026-10-18T08:00:00Z',
  created_at: '2026-10-18T08:00:00Z',
  version: 2,
  schedule: null,
  availability: 'available',
  delivery: { in_app: 'delivered', email: 'suppressed', email_reason: 'provider_unconfigured' },
  coverage: { sections: { completed: { state: 'truncated', shown: 20, total: 31 } } },
  statements: [
    {
      position: 0,
      section: 'overview',
      kind: 'fact',
      key: 'overview.window',
      text: 'This is your first daily briefing for this scope, so there is no earlier briefing to compare with.',
      refs: [],
      figures: null,
      correction: null,
      corrections: [],
    },
    {
      position: 1,
      section: 'completed',
      kind: 'calculation',
      key: 'completed.count',
      text: '31 tasks you can read were marked done in this window.',
      refs: [{ type: 'task', id: TSK, version: 3 }],
      figures: { total: 31 },
      correction: null,
      corrections: [],
    },
    {
      position: 2,
      section: 'agent_runs',
      kind: 'unavailable',
      key: 'agent_runs.foundation',
      text: 'Agent-run review is not available yet.',
      refs: [],
      figures: null,
      correction: null,
      corrections: [],
    },
  ],
  ...over,
});

const detail = () =>
  render(
    <Router>
      <BriefingPage ws={WS} id={BRF} />
    </Router>,
  );

describe('Briefings (7E)', () => {
  it('shows trust kinds, evidence links, truncation, the first-run label, and honest delivery', async () => {
    serve({ [`GET /ai/briefings/${BRF}`]: () => json(200, { data: briefing() }) });
    detail();
    expect(await screen.findByText(/no earlier briefing to compare with/)).toBeTruthy();
    expect(screen.getByText('Calculation')).toBeTruthy();
    expect(screen.getByText('Not available')).toBeTruthy();
    const evidence = screen.getByRole('list', { name: 'Evidence' });
    expect(evidence.querySelector('a')!.getAttribute('href')).toBe(
      `/workspaces/${WS}/tasks/${TSK}`,
    );
    expect(screen.getByText(/Only the first items are listed/)).toBeTruthy();
    expect(
      screen.getByText(/Email is not configured for this product, so nothing was emailed/),
    ).toBeTruthy();
  });

  it('withholds a briefing wholesale and drops local note drafts when it is no longer available', async () => {
    let state = briefing();
    const calls = serve({
      [`GET /ai/briefings/${BRF}`]: () => json(200, { data: state }),
      [`POST /ai/briefings/${BRF}/corrections`]: () =>
        json(503, { error: { code: 'unavailable', status: 503, message: 'Try again' } }),
    });
    const first = detail();
    await screen.findByText(/31 tasks/);
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a note' })[1]!);
    fireEvent.change(screen.getByLabelText(/Your note or correction/), {
      target: { value: 'Agreed with the client' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Propose note' })));
    expect(await screen.findByText(/kept on this device/)).toBeTruthy();
    const key = calls.find((c) => c.method === 'POST')!.key;
    expect(key).toBeTruthy();
    expect(Object.keys(localStorage).some((k) => k.includes('.ai-briefing.'))).toBe(true);
    first.unmount();
    // The briefing is now withheld: nothing is shown, and the draft is removed.
    state = briefing({ availability: 'withheld', statements: [] });
    detail();
    expect(await screen.findByText('This briefing is withheld')).toBeTruthy();
    expect(screen.queryByText(/31 tasks/)).toBeNull();
    expect(Object.keys(localStorage).some((k) => k.includes('.ai-briefing.'))).toBe(false);
  });

  it('an authoritative refusal while proposing a note removes the unsaved draft (corrective review 01 R2)', async () => {
    serve({
      [`GET /ai/briefings/${BRF}`]: () => json(200, { data: briefing() }),
      [`POST /ai/briefings/${BRF}/corrections`]: () =>
        json(404, { error: { code: 'not_found', status: 404, message: 'Not found' } }),
    });
    detail();
    await screen.findByText(/31 tasks/);
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a note' })[1]!);
    fireEvent.change(screen.getByLabelText(/Your note or correction/), {
      target: { value: 'Quoting a source marker' },
    });
    expect(Object.keys(localStorage).some((k) => k.includes('.ai-briefing.'))).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Propose note' })));
    expect(await screen.findByText(/your unsaved note was removed/)).toBeTruthy();
    expect(Object.keys(localStorage).some((k) => k.includes('.ai-briefing.'))).toBe(false);
  });

  it('a note draft survives a reload until saved, and sign-out cleanup removes it', async () => {
    serve({ [`GET /ai/briefings/${BRF}`]: () => json(200, { data: briefing() }) });
    const first = detail();
    await screen.findByText(/31 tasks/);
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a note' })[1]!);
    fireEvent.change(screen.getByLabelText(/Your note or correction/), {
      target: { value: 'Keep me' },
    });
    first.unmount();
    detail();
    await screen.findByText(/31 tasks/);
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a note' })[1]!);
    expect((screen.getByLabelText(/Your note or correction/) as HTMLTextAreaElement).value).toBe(
      'Keep me',
    );
    clearProposalDrafts();
    expect(Object.keys(localStorage).some((k) => k.includes('.ai-briefing.'))).toBe(false);
  });

  it('previews scope and window before generating, and reuses the key when a generation is ambiguous', async () => {
    let attempts = 0;
    const calls = serve({
      'GET /ai/briefings': () => json(200, { data: { items: [], next_cursor: null } }),
      'GET /brands?state=active': () => json(200, { data: [] }),
      'GET /projects': () => json(200, { data: [] }),
      'POST /ai/briefing-previews': () =>
        json(200, {
          data: {
            kind: 'owner_daily',
            kind_label: 'Daily briefing',
            scope: { key: 'workspace', label: 'every brand you can read' },
            timezone: 'UTC',
            window: { start: '2026-10-17T00:00:00Z', end: '2026-10-18T08:00:00Z', clamped: false },
            baseline: null,
            first: true,
            mode: 'fact_only',
            generated: { available: false, reason: 'AI is not available in this workspace.' },
          },
        }),
      'POST /ai/briefings': () => {
        attempts++;
        return json(503, { error: { code: 'unavailable', status: 503, message: 'Try again' } });
      },
    });
    render(
      <Router>
        <BriefingsPage ws={WS} />
      </Router>,
    );
    expect(await screen.findByText(/No briefings yet/)).toBeTruthy();
    const gen = screen.getByRole('button', { name: 'Generate briefing' }) as HTMLButtonElement;
    expect(gen.disabled).toBe(true);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Preview scope and window' })),
    );
    expect(await screen.findByText(/First briefing for this scope/)).toBeTruthy();
    await act(async () => fireEvent.click(gen));
    await act(async () => fireEvent.click(gen));
    const keys = calls
      .filter((c) => c.method === 'POST' && c.path.endsWith('/ai/briefings'))
      .map((c) => c.key);
    expect(attempts).toBe(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('settings show unconfigured email honestly and list next runs in the schedule zone', async () => {
    serve({
      'GET /ai/briefing-schedules': () =>
        json(200, {
          data: {
            email: 'not_configured',
            timezone: 'Europe/Lisbon',
            items: [
              {
                id: 'bsc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
                type: 'briefing_schedule',
                kind: 'owner_daily',
                kind_label: 'Daily briefing',
                scope: { key: 'workspace' },
                timezone: 'Europe/Lisbon',
                local_time: '07:30',
                weekdays: [1, 2, 3, 4, 5],
                channels: ['in_app', 'email'],
                email: 'not_configured',
                enabled: true,
                revision: 1,
                next_run_at: '2026-10-19T06:30:00Z',
                upcoming: [],
                version: 1,
              },
            ],
          },
        }),
      'GET /ai/briefing-corrections': () => json(200, { data: { items: [] } }),
      'GET /brands?state=active': () => json(200, { data: [] }),
    });
    render(
      <Router>
        <BriefingSettingsPage ws={WS} />
      </Router>,
    );
    expect(await screen.findByText('Email is not configured')).toBeTruthy();
    expect(screen.getByText(/In-app and email \(email not configured\)/)).toBeTruthy();
    expect((screen.getByLabelText('Time zone') as HTMLInputElement).value).toBe('Europe/Lisbon');
  });
});
