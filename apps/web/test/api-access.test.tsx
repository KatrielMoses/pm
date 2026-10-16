import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiAccessPage } from '../src/pages/api-pages.tsx';
import { Router } from '../src/router.tsx';
import { StepUpProvider } from '../src/stepup.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const WS = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const token = (state: string) => ({
  id: 'tok_1',
  type: 'api_token',
  version: 0,
  kind: 'personal',
  name: 'CI',
  token_prefix: 'pm_abcdefgh',
  scopes: ['records:read'],
  expires_at: null,
  last_used_at: null,
  state,
});

/** Routes the page's requests; the envelopes match the API (list and resource both under data). */
function serve() {
  let revoked = false;
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path.endsWith('/api-tokens') && method === 'GET')
        return json(200, {
          data: { type: 'api_tokens', tokens: [token(revoked ? 'revoked' : 'active')] },
        });
      if (path.endsWith('/api-tokens') && method === 'POST')
        return json(201, { data: { ...token('active'), secret: 'pm_abcdefgh_secret' } });
      if (path.endsWith('/api-tokens/tok_1:revoke')) {
        revoked = true;
        return json(200, { data: token('revoked') });
      }
      if (path.endsWith('/webhook-subscriptions') && method === 'GET')
        return json(200, {
          data: {
            type: 'webhook_subscriptions',
            subscriptions: [
              {
                id: 'whk_1',
                type: 'webhook_subscription',
                version: 0,
                destination_url: 'https://hooks.example.com/pm',
                event_types: ['task.created'],
                state: 'active',
                api_version: 'v1',
                consecutive_failures: 0,
              },
            ],
          },
        });
      if (path.endsWith('/webhook-subscriptions') && method === 'POST')
        return json(201, { data: { id: 'whk_2', secret: 'whsec_once' } });
      if (path.endsWith('/webhook-subscriptions/whk_1/deliveries'))
        return json(200, {
          data: {
            type: 'webhook_deliveries',
            deliveries: [
              {
                id: 'whd_1',
                type: 'webhook_delivery',
                event_id: 'evt_1',
                event_type: 'task.created',
                state: 'failed',
                attempt: 5,
                response_status: 503,
                duration_ms: 20,
                next_attempt_at: null,
                created_at: '2026-10-10T08:00:00.000Z',
                detail: 'status',
              },
            ],
          },
        });
      if (path.endsWith('/webhook-deliveries/whd_1:replay'))
        return json(202, { data: { id: 'whd_1', state: 'pending' } });
      return json(404, { error: { code: 'not_found', message: 'Not found.' } });
    }),
  );
  return calls;
}

const page = () =>
  render(
    <Router>
      <StepUpProvider>
        <ApiAccessPage ws={WS} />
      </StepUpProvider>
    </Router>,
  );

describe('API tokens and webhooks', () => {
  it('lists tokens from the envelope, shows a new secret once, and revokes', async () => {
    const calls = serve();
    page();
    const list = await screen.findByRole('list', { name: 'API tokens' });
    await waitFor(() => expect(list.querySelector('[data-token="tok_1"]')).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'CI' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create token' })));
    expect(screen.getByTestId('new-token').textContent).toBe('pm_abcdefgh_secret');
    await act(async () =>
      fireEvent.click(within(list).getByRole('button', { name: /^Revoke\s*CI$/ })),
    );
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/tok_1:revoke'))).toBe(true);
    await waitFor(() => expect(within(list).queryByRole('button', { name: /^Revoke/ })).toBeNull());
    expect(screen.getByText('CI revoked. It no longer works.')).toBeTruthy();
  });

  it('adds an endpoint, shows its signing secret once, and replays a failed delivery', async () => {
    const calls = serve();
    page();
    const hooks = await screen.findByRole('region', { name: 'Webhooks' });
    await waitFor(() => expect(hooks.getAttribute('aria-busy')).toBe('false'));
    fireEvent.change(within(hooks).getByLabelText('HTTPS endpoint URL'), {
      target: { value: 'https://hooks.example.com/new' },
    });
    fireEvent.click(within(hooks).getByRole('checkbox', { name: 'task.completed' }));
    await act(async () =>
      fireEvent.click(within(hooks).getByRole('button', { name: 'Add endpoint' })),
    );
    expect(
      calls.find((c) => c.method === 'POST' && c.path.endsWith('/webhook-subscriptions'))!.body,
    ).toEqual({
      destination_url: 'https://hooks.example.com/new',
      event_types: ['task.completed'],
    });
    expect(screen.getByTestId('webhook-secret').textContent).toBe('whsec_once');
    await act(async () =>
      fireEvent.click(within(hooks).getByRole('button', { name: /^Show deliveries/ })),
    );
    const table = within(hooks).getByRole('table');
    expect(within(table).getByText('Failed')).toBeTruthy();
    expect(within(table).getByText('5xx')).toBeTruthy();
    await act(async () => fireEvent.click(within(table).getByRole('button', { name: /^Replay/ })));
    expect(calls.some((c) => c.path.endsWith('/webhook-deliveries/whd_1:replay'))).toBe(true);
    expect(hooks.getAttribute('aria-busy')).toBe('false');
    expect(within(hooks).getByText('Delivery queued again.')).toBeTruthy();
  });
});
