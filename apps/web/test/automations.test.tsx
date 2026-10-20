import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AutomationPage, AutomationRunPage, AutomationsPage } from '../src/automations/pages.tsx';
import { Router } from '../src/router.tsx';
import { StepUpProvider } from '../src/stepup.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

const WS = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const AUT = 'auto_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OP = 'op_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const BR = 'br_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const WHK = 'whk_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const automation = (over: Record<string, unknown> = {}) => ({
  id: AUT,
  type: 'automation',
  name: 'Escalate',
  description: null,
  scope: { kind: 'brand', brand: { id: BR, name: 'Harbor' } },
  owner: { id: 'mem_01ARZ3NDEKTSV4RRFFQ69G5FAV', name: 'Ada', active: true },
  state: 'disabled',
  enabled: false,
  suspended_reason: null,
  trigger_kind: null,
  active_revision: null,
  latest_revision: null,
  template: null,
  draft: {
    definition: {
      schema_version: 1,
      trigger: { kind: 'record.created', record: 'task' },
      conditions: null,
      steps: [
        {
          id: 'up',
          type: 'action',
          action: 'task.update',
          params: { fields: { priority: 'high' } },
        },
      ],
    },
    scope: { brands: [BR], projects: [] },
  },
  draft_status: {
    valid: true,
    issues: [],
    unavailable: [],
    actions: ['task.update'],
    outbound: [],
    matches_active: false,
  },
  last_run: null,
  failures_in_a_row: 0,
  capabilities: { configure: true, run: false, activate: true },
  created_at: '2026-10-20T00:00:00Z',
  updated_at: '2026-10-20T00:00:00Z',
  version: 3,
  ...over,
});

function serve(routes: Record<string, (body: any) => Response | Promise<Response>>) {
  const calls: Array<{
    method: string;
    path: string;
    body: any;
    key: string | null;
    ifMatch: string | null;
  }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const headers = new Headers(init?.headers);
      calls.push({
        method,
        path,
        body,
        key: headers.get('idempotency-key'),
        ifMatch: headers.get('if-match'),
      });
      for (const [k, fn] of Object.entries(routes)) {
        const [m, suffix] = k.split(' ') as [string, string];
        if (m === method && path.split('?')[0]!.endsWith(suffix)) return fn(body);
      }
      if (method === 'GET')
        return json(200, {
          data: path.includes('webhook-subscriptions') ? { subscriptions: [] } : [],
        });
      return json(404, { error: { code: 'not_found', status: 404, message: 'Not found' } });
    }),
  );
  return calls;
}
const shell = (ui: ReactNode) =>
  render(
    <Router>
      <StepUpProvider>{ui}</StepUpProvider>
    </Router>,
  );

describe('Automations (8A)', () => {
  it('lists automations with their state, offers starter templates, and shows usage against technical limits only', async () => {
    serve({
      'GET /automations': () =>
        json(200, {
          data: [
            automation({
              state: 'active',
              enabled: true,
              last_run: {
                id: OP,
                status: 'failed',
                reason: null,
                created_at: '2026-10-20T00:00:00Z',
              },
              failures_in_a_row: 2,
            }),
          ],
          capabilities: { create: true, workspace_scope: false },
        }),
      'GET /automation-templates': () =>
        json(200, {
          data: {
            type: 'automation_templates',
            data: [
              {
                key: 'escalate_overdue',
                name: 'Escalate tasks on their due date',
                description: 'At 9:00 on the due date…',
                needs: ['timezone'],
                trigger_kind: 'date',
              },
            ],
          },
        }),
      'GET /automation-usage': () =>
        json(200, {
          data: {
            type: 'automation_usage',
            period_start: '2026-10-01',
            measured: { runs: 12, runs_finished: 11, steps: 30 },
            technical_limits: { runs_per_month: 10000, active_runs_per_automation: 20 },
            plan_entitlement: {
              status: 'unavailable',
              owner_phase: '10A',
              note: 'Plan limits arrive with billing.',
            },
          },
        }),
      'GET /brands': () => json(200, { data: [{ id: BR, name: 'Harbor' }] }),
    });
    shell(<AutomationsPage ws={WS} />);
    const list = await screen.findByRole('list', { name: 'Automations' });
    expect(within(list).getByRole('link', { name: 'Escalate' })).toBeTruthy();
    expect(within(list).getByText('Active')).toBeTruthy();
    expect(within(list).getByText(/2 failures in a row/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Export run history (CSV)' }).getAttribute('href'),
    ).toBe(`/v1/workspaces/${WS}/portability/exports/automation_history.csv`);
    expect(
      await screen.findByRole('option', { name: 'Escalate tasks on their due date' }),
    ).toBeTruthy();
    expect(screen.getByText('12 of 10000')).toBeTruthy();
    expect(screen.getByText('Not available yet')).toBeTruthy();
  });

  it('edits only the draft, keeps unsaved edits across a reload and an offline save, and shows future options as unavailable', async () => {
    const calls = serve({ [`GET /automations/${AUT}`]: () => json(200, { data: automation() }) });
    const first = shell(<AutomationPage ws={WS} id={AUT} />);
    const name = await screen.findByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Escalate faster' } });
    expect(screen.getByText('Unsaved changes.')).toBeTruthy();
    // Future sources and agent workflows are listed where they would be configured, never usable.
    expect(
      (screen.getByRole('option', { name: /A test result arrives/ }) as HTMLOptionElement).disabled,
    ).toBe(true);
    expect(
      (screen.getAllByRole('option', { name: /Run an agent workflow/ })[0] as HTMLOptionElement)
        .disabled,
    ).toBe(true);
    first.unmount();
    shell(<AutomationPage ws={WS} id={AUT} />);
    expect(((await screen.findByLabelText('Name')) as HTMLInputElement).value).toBe(
      'Escalate faster',
    );
    expect(screen.getByText('Unsaved edits restored')).toBeTruthy();
    // Offline: nothing is lost and the person is told so.
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save draft' })));
    expect(
      await screen.findByText(/You are offline. Your edits are kept on this device/),
    ).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Escalate faster');
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('names the standing disclosure and the unknown-outcome rule before turning on a webhook step', async () => {
    const outbound = automation({
      draft_status: {
        valid: true,
        issues: [],
        unavailable: [],
        actions: ['webhook.send'],
        outbound: [{ node: 'send', webhook: WHK, fields: ['priority', 'status'] }],
        matches_active: false,
      },
    });
    const calls = serve({
      [`GET /automations/${AUT}`]: () => json(200, { data: outbound }),
      'GET /webhook-subscriptions': () =>
        json(200, {
          data: {
            subscriptions: [
              { id: WHK, destination_url: 'https://hooks.example.test/in', state: 'active' },
            ],
          },
        }),
      [`POST /automations/${AUT}:activate`]: () =>
        json(200, {
          data: { ...outbound, state: 'active', enabled: true, active_revision: 1, version: 4 },
        }),
    });
    shell(<AutomationPage ws={WS} id={AUT} />);
    await screen.findByLabelText('Name');
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'Turn on' })));
    const dialog = await screen.findByRole('dialog', {
      name: 'Approve what this automation sends',
    });
    expect(
      within(dialog).getByText(
        /priority, status of the triggering record to https:\/\/hooks.example.test\/in/,
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText(/it is not sent again automatically/)).toBeTruthy();
    const approve = within(dialog).getByRole('button', {
      name: 'Approve and turn on',
    }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(within(dialog).getByLabelText('I approve this standing disclosure'));
    await act(async () => fireEvent.click(approve));
    const sent = calls.find((c) => c.path.endsWith(':activate'))!;
    expect(sent.body).toEqual({
      approvals: [{ node: 'send', webhook: WHK, fields: ['priority', 'status'] }],
    });
    expect(sent.ifMatch).toBe('"3"');
  });

  it('explains a run, retries it from the failed step with one key, and offers reconciliation of an uncertain send', async () => {
    const run = {
      id: OP,
      type: 'automation_run',
      automation: { id: AUT, name: 'Escalate' },
      revision: 1,
      status: 'failed',
      reason: 'required',
      operation_state: 'failed',
      trigger: { kind: 'record.created', record: null },
      chain_depth: 0,
      steps_executed: 2,
      retries: 0,
      wake_at: null,
      created_at: '2026-10-20T00:00:00Z',
      started_at: '2026-10-20T00:00:00Z',
      ended_at: '2026-10-20T00:00:01Z',
      duration_ms: 1000,
      explanation: 'A step failed. Earlier steps are kept; retry runs the failed step again.',
      reconciliation_required: false,
      effects: [],
      steps: [
        {
          node: '_conditions',
          attempt: 1,
          kind: 'conditions',
          action: null,
          state: 'succeeded',
          failure_class: null,
          code: null,
          decision: { result: true },
          targets: [],
          started_at: '2026-10-20T00:00:00Z',
          ended_at: '2026-10-20T00:00:00Z',
          duration_ms: 1,
        },
        {
          node: 'gate',
          attempt: 1,
          kind: 'action',
          action: 'task.update',
          state: 'failed',
          failure_class: 'validation_failed',
          code: 'required',
          decision: null,
          targets: [],
          started_at: '2026-10-20T00:00:00Z',
          ended_at: '2026-10-20T00:00:01Z',
          duration_ms: 5,
        },
      ],
      capabilities: { retry: true, cancel: false, reconcile: false },
    };
    let fail = true;
    const calls = serve({
      [`GET /automation-runs/${OP}`]: () => json(200, { data: { type: 'automation_run', run } }),
      [`POST /automation-runs/${OP}:retry`]: () => {
        if (fail) {
          fail = false;
          throw new TypeError('Failed to fetch');
        }
        return json(202, {
          data: {
            type: 'automation_run',
            run: {
              ...run,
              status: 'queued',
              retries: 1,
              capabilities: { retry: false, cancel: true, reconcile: false },
            },
          },
        });
      },
    });
    shell(<AutomationRunPage ws={WS} aut={AUT} run={OP} />);
    expect(await screen.findByText(/Earlier steps are kept/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Steps table' })).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Retry from the failed step' });
    await act(async () => fireEvent.click(retry));
    await act(async () => fireEvent.click(retry));
    const retries = calls.filter((c) => c.path.endsWith(':retry'));
    // A dropped connection keeps the key: the second attempt is a replay, never a second retry.
    expect(retries).toHaveLength(2);
    expect(retries[0]!.key).toBe(retries[1]!.key);
    cleanup();
    serve({
      [`GET /automation-runs/${OP}`]: () =>
        json(200, {
          data: {
            type: 'automation_run',
            run: {
              ...run,
              status: 'waiting',
              reason: 'reconciliation_required',
              reconciliation_required: true,
              effects: [
                {
                  key: 'k',
                  state: 'unknown',
                  version: 2,
                  reason: 'outcome_unknown',
                  destination: 'automation webhook',
                },
              ],
              capabilities: { retry: false, cancel: false, reconcile: true },
            },
          },
        }),
    });
    shell(<AutomationRunPage ws={WS} aut={AUT} run={OP} />);
    expect(await screen.findByText(/It will not be sent again automatically/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'It was received' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop this run' })).toBeTruthy();
  });
});
