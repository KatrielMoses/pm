import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { fetchStatus, type ConnectionState } from '../src/status.ts';

afterEach(cleanup);

const build = { version: '0.1.0', build: 'abc1234' };
const response = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );

describe('fetchStatus', () => {
  it('maps the public status envelope', async () => {
    const ok = vi.fn(() =>
      response(200, { data: { type: 'platform_status', status: 'available', build }, meta: {} }),
    );
    expect(await fetchStatus(ok as unknown as typeof fetch)).toEqual({ kind: 'available', build });
    const degraded = vi.fn(() =>
      response(200, { data: { type: 'platform_status', status: 'degraded', build }, meta: {} }),
    );
    expect(await fetchStatus(degraded as unknown as typeof fetch)).toEqual({
      kind: 'degraded',
      build,
    });
    expect(ok).toHaveBeenCalledWith('/v1/status', expect.anything());
  });

  it('treats errors, unknown shapes, and unsafe build strings as unavailable', async () => {
    const cases = [
      () => response(503, { error: { code: 'service_unavailable' } }),
      () =>
        response(200, {
          data: { status: 'available', build: { version: '/Users/x', build: 'y' } },
        }),
      () => Promise.reject(new TypeError('network')),
      () => Promise.resolve(new Response('<html>', { status: 200 })),
    ];
    for (const c of cases)
      expect(await fetchStatus(vi.fn(c) as unknown as typeof fetch)).toEqual({
        kind: 'unavailable',
      });
  });
});

describe('App', () => {
  const renderWith = async (state: ConnectionState) => {
    const load = vi.fn(() => Promise.resolve(state));
    await act(async () => {
      render(<App load={load} />);
    });
    return load;
  };

  it('renders the healthy state with build information', async () => {
    await renderWith({ kind: 'available', build });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('PM');
    expect(screen.getByTestId('status').textContent).toContain('Connected');
    expect(screen.getByTestId('build').textContent).toBe('Version 0.1.0 · build abc1234');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders the degraded state with a retry action', async () => {
    const load = await renderWith({ kind: 'degraded', build });
    expect(screen.getByTestId('status').textContent).toContain('Limited service');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('renders the unavailable state without server details', async () => {
    await renderWith({ kind: 'unavailable' });
    const status = screen.getByTestId('status');
    expect(status.textContent).toContain('Service unavailable');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(screen.queryByTestId('build')).toBeNull();
  });
});
