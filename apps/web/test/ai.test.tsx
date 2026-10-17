import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiPage, AiSettingsPage } from '../src/ai/ai-pages.tsx';
import { Router } from '../src/router.tsx';
import { StepUpProvider } from '../src/stepup.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const WS = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const RUN = 'op_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const money = (micros: string, display: string) => ({ micros, display, currency: 'USD' });
const usage = {
  period: { start: '2026-10-01', end: '2026-11-01' },
  consumed: money('10.000000', '$0.00001'),
  reserved: money('0.000000', '$0.00'),
  monthly_allowance: money('1000000.000000', '$1.00'),
  remaining_allowance: money('999990.000000', '$0.99999'),
  hard_limit: money('1000000.000000', '$1.00'),
  available_before_hard_limit: money('999990.000000', '$0.99999'),
  limits_configured: false,
  tokens: {
    input: { consumed: 1, reserved: 0, hard_limit: 2 },
    output: { consumed: 1, reserved: 0, hard_limit: 2 },
  },
};
const model = {
  key: 'fixture/synthetic-messages@2026-10-17',
  label: 'Synthetic test model (protocol fixture, no provider)',
  provider: 'fixture',
  model_id: 'synthetic-messages',
  synthetic: true,
  approved_for_workspace_data: true,
  privacy: {
    training_exclusion: 'synthetic',
    retention: 'none_synthetic',
    zero_retention: false,
    statement: 'Synthetic test model.',
  },
  price: {
    version: 'synthetic-2026-10-17',
    synthetic: true,
    input_per_million_tokens: '$1.00',
    output_per_million_tokens: '$2.00',
  },
};
const run = (state: string, extra: Record<string, unknown> = {}) => ({
  id: RUN,
  type: 'ai_run',
  version: 1,
  state,
  status:
    state === 'succeeded'
      ? 'Completed'
      : state === 'running'
        ? 'Running'
        : state === 'cancelled'
          ? 'Cancelled'
          : 'Queued',
  terminal_reason: null,
  waiting_reason: null,
  cancelling: false,
  synthetic: true,
  initiator: 'mem_1',
  brand: null,
  model: {
    key: model.key,
    label: model.label,
    provider: 'fixture',
    model_id: 'synthetic-messages',
  },
  created_at: '2026-10-17T10:00:00Z',
  ended_at: null,
  estimate: { max_cost: money('5.000000', '$0.000005'), output_token_bound: 64 },
  cost: {
    settled: money('0.000000', '$0.00'),
    unknown_reserved: money('0.000000', '$0.00'),
    note: null,
  },
  attempts: [],
  can_cancel: !['succeeded', 'cancelled'].includes(state),
  can_retry: false,
  cancellation_note:
    'A request already sent to the provider cannot be recalled, and it may still be charged.',
  ...extra,
});

function serve(
  opts: {
    availability?: string;
    history?: Record<string, unknown>;
    settings?: Record<string, unknown>;
  } = {},
) {
  const calls: Array<{
    method: string;
    path: string;
    body: unknown;
    headers: Record<string, string>;
  }> = [];
  let state = 'queued';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        path,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      if (path.endsWith('/ai') && method === 'GET')
        return json(200, {
          data: {
            type: 'ai_overview',
            availability: opts.availability ?? 'ready',
            reason:
              opts.availability === 'unconfigured'
                ? 'AI is not configured for this deployment. Everything else works as usual; continue manually.'
                : 'AI is available.',
            can_execute: true,
            model,
            synthetic: true,
            funding: 'synthetic',
            max_output_tokens: 64,
            confirm_above: money('0.000000', '$0.00'),
            usage,
            manual_fallback:
              'AI is optional. Every task, project, and plan can be created and completed without it.',
          },
        });
      if (path.includes('/ai/runs?') && method === 'GET')
        return json(200, {
          data: {
            type: 'ai_runs',
            items: [
              run(
                'succeeded',
                opts.history ?? {
                  content: {
                    state: 'withheld',
                    note: 'A source used by this run is no longer available to you, so its prompt and output are withheld.',
                    prompt: null,
                    redactions: 0,
                    output: null,
                  },
                },
              ),
            ],
            next_cursor: null,
          },
        });
      if (path.endsWith('/ai/estimates'))
        return json(200, {
          data: {
            type: 'ai_estimate',
            synthetic: true,
            model,
            input_token_bound: 100,
            output_token_bound: 64,
            max_cost: money('5.000000', '$0.000005'),
            basis: 'Upper bound.',
            redactions: 1,
            context: [],
            usage,
            confirm_required: true,
            within_limits: true,
            blocked_meter: null,
            blocked_reason: null,
          },
        });
      if (path.endsWith('/ai/test-runs')) return json(202, { data: run('queued') });
      if (path.endsWith(`/ai/runs/${RUN}:retry`)) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (body.confirm_cost !== true)
          return json(409, {
            error: {
              code: 'conflict',
              status: 409,
              message: 'Conflict',
              issues: [
                {
                  pointer: '/confirm_cost',
                  code: 'confirmation_required',
                  message: 'This run could cost up to $0.000010. Confirm to start it.',
                },
              ],
            },
          });
        return json(202, { data: run('queued') });
      }
      if (path.endsWith(`/ai/runs/${RUN}:cancel`)) {
        state = 'cancelled';
        return json(202, { data: run('cancelled') });
      }
      if (path.endsWith(`/ai/runs/${RUN}`)) {
        state = state === 'queued' ? 'running' : state;
        if (opts.history) return json(200, { data: run('failed', opts.history) });
        return json(200, {
          data: run(
            state,
            state === 'succeeded'
              ? {
                  content: {
                    state: 'present',
                    note: null,
                    prompt: 'Hi',
                    redactions: 0,
                    output: { text: 'Synthetic fixture reply', completeness: 'complete' },
                  },
                }
              : {},
          ),
        });
      }
      if (path.endsWith('/ai/settings'))
        return json(200, {
          data: {
            type: 'ai_settings',
            version: 2,
            availability: 'ready',
            reason: 'AI is available.',
            transport: 'fixture',
            enabled: true,
            model_key: model.key,
            key_source: 'deployment',
            workspace_key: {
              set: false,
              available: false,
              note: 'Workspace-provided keys are off in this deployment until their commercial terms are approved (OD-46).',
            },
            max_data_class: 'C2',
            confirm_above: money('0.000000', '$0.00'),
            models: [model],
            limits: [
              {
                meter: 'ai.cost',
                unit: 'usd_micros',
                monthly_allowance: '1000000.000000',
                hard_limit: '1000000.000000',
                configured: false,
              },
            ],
            warning_thresholds_bp: [8000, 10000],
            can_manage_providers: true,
            can_configure_limits: true,
            ...opts.settings,
          },
        });
      if (path.endsWith('/ai/usage'))
        return json(200, {
          data: {
            type: 'ai_usage',
            usage,
            runs: [],
            awaiting_reconciliation: [
              {
                run: RUN,
                attempt: 1,
                reserved: money('5.000000', '$0.000005'),
                provider_request_id: 'req_fixture_1',
              },
            ],
            can_reconcile: true,
          },
        });
      return json(404, { error: { code: 'not_found', status: 404, message: 'Not found' } });
    }),
  );
  return calls;
}

const page = (el: ReactElement) =>
  render(
    <Router>
      <StepUpProvider>{el}</StepUpProvider>
    </Router>,
  );

describe('AI test runs page (7A)', () => {
  it('labels the synthetic model, estimates first, and starts only after the cost is confirmed', async () => {
    const calls = serve();
    page(<AiPage ws={WS} />);
    expect(await screen.findByText('Synthetic test model')).toBeTruthy();
    expect(screen.getByText('Remaining allowance')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Request/), {
      target: { value: 'Summarize sk-ant-secret' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Estimate cost' })));
    expect(await screen.findByText(/1 credential\(s\) will be removed/)).toBeTruthy();
    const startButton = screen.getByRole('button', { name: 'Start test run' }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I confirm this run may cost up to/));
    expect(startButton.disabled).toBe(false);
    await act(async () => fireEvent.click(startButton));
    const start = calls.find((c) => c.path.endsWith('/ai/test-runs'))!;
    expect(start.body).toMatchObject({ prompt: 'Summarize sk-ant-secret', confirm_cost: true });
    expect(start.headers['idempotency-key']).toMatch(/.+/);
    expect(await screen.findByRole('heading', { name: 'Current run' })).toBeTruthy();
    // Cancelling says plainly what cannot be recalled.
    expect(screen.getByText(/cannot be recalled/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel run' })));
    expect(await screen.findAllByText('Cancelled')).toBeTruthy();
  });

  it('shows withheld history honestly and offers the export', async () => {
    serve();
    page(<AiPage ws={WS} />);
    const list = await screen.findByRole('list', { name: 'AI runs' });
    expect(list.textContent).toContain('Completed');
    expect(
      screen.getByRole('link', { name: /Export your AI history/ }).getAttribute('href'),
    ).toContain('/portability/exports/ai_history.csv');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /View/ })));
    expect(await screen.findByText(/withheld/)).toBeTruthy();
  });

  it('keeps manual work usable when AI is unconfigured', async () => {
    serve({ availability: 'unconfigured' });
    page(<AiPage ws={WS} />);
    expect(await screen.findByText('AI is not available')).toBeTruthy();
    expect(screen.getByText(/continue manually/)).toBeTruthy();
    expect(screen.getByText(/Every task, project, and plan/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Estimate cost' })).toBeNull();
  });
});

describe('AI settings page (7A)', () => {
  it('shows privacy status, finite limits, keys off, and unknown costs to reconcile', async () => {
    serve();
    page(<AiSettingsPage ws={WS} />);
    expect(await screen.findByRole('heading', { name: 'Provider and privacy' })).toBeTruthy();
    expect(screen.getByText(/Training on workspace content stays excluded/)).toBeTruthy();
    expect(screen.getByText(/OD-46/)).toBeTruthy();
    expect((screen.getByLabelText('Hard monthly limit (USD)') as HTMLInputElement).value).toBe(
      '1.00',
    );
    expect(screen.getByText(/Using the deployment default \(finite\)/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('list', { name: 'Unknown outcomes' })).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: 'Charge the reserved amount' })).toBeTruthy();
    expect(screen.getByText(/nobody's prompts or outputs appear here/)).toBeTruthy();
  });
});

describe('AI corrective review 01 states (7A)', () => {
  const refused = {
    status: 'Refused by policy',
    terminal_reason: 'policy_rejected',
    can_retry: true,
    refusal: {
      code: 'configuration_changed',
      message:
        'The price or configuration changed after this run was confirmed. Nothing was sent. Retry to review and confirm the current estimate.',
    },
    content: { state: 'present', note: null, prompt: 'Hi', redactions: 0, output: null },
  };

  it('says why a run was refused at dispatch and asks for a new confirmation before retrying', async () => {
    const calls = serve({ history: refused });
    page(<AiPage ws={WS} />);
    await screen.findByRole('list', { name: 'AI runs' });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /View/ })));
    expect(
      await screen.findByText(/changed after this run was confirmed. Nothing was sent/),
    ).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Retry/ })));
    expect(await screen.findByText('Confirm the retry')).toBeTruthy();
    expect(screen.getByText(/could cost up to \$0.000010/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Confirm retry' })));
    const retries = calls.filter((c) => c.path.endsWith(`/ai/runs/${RUN}:retry`));
    expect(
      retries.map((c) => (c.body as { confirm_cost?: boolean } | null)?.confirm_cost ?? false),
    ).toEqual([false, true]);
    expect(await screen.findByText('Retry queued as a new run.')).toBeTruthy();
  });

  it('shows a paused workspace with its resume action and each spending gate of a real model separately', async () => {
    const real = {
      ...model,
      key: 'anthropic/claude-haiku-5-5@2026-10-06',
      label: 'Claude Haiku 5.5',
      provider: 'anthropic',
      synthetic: false,
      approved_for_workspace_data: false,
      price: { ...model.price, version: 'anthropic-first-party-2026-10-17', synthetic: false },
      gates: {
        price: {
          state: 'verified',
          source: 'https://platform.claude.com/docs/en/about-claude/pricing',
          checked_on: '2026-10-17',
          note: 'n',
        },
        input_bound: {
          state: 'unverified',
          source: 'https://platform.claude.com/docs/en/build-with-claude/token-counting',
          checked_on: '2026-10-17',
          reason: 'No published strict upper bound',
        },
        error_responses_chargeable: 'unknown',
        monetary_dispatch: 'bound_unverified',
      },
      price_restrictions: [],
    };
    serve({
      settings: {
        model_key: real.key,
        models: [real],
        suspended: {
          reason: 'bound_breach',
          at: '2026-10-17T10:00:00Z',
          note: 'A provider reported usage beyond a reserved bound, so AI is paused for this workspace.',
        },
      },
    });
    page(<AiSettingsPage ws={WS} />);
    expect(await screen.findByText('AI is paused for review')).toBeTruthy();
    expect(screen.getByText(/usage beyond a reserved bound/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume AI after review' })).toBeTruthy();
    const gates = screen.getByRole('list', { name: 'Gates for real spending' });
    expect(gates.textContent).toContain('Price: verified (checked 2026-10-17)');
    expect(gates.textContent).toContain('Upper bound on what a request can cost: unverified');
    expect(gates.textContent).toContain('Error responses may be charged: unknown');
  });
});
