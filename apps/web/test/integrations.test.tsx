import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionList, type ConnectionView } from '../src/integrations/panel.tsx';

afterEach(() => cleanup());

const row: ConnectionView = {
  id: 'conn_1',
  display_name: 'Loopback',
  provider: 'loopback',
  auth_kind: 'api_key',
  health: 'connected',
  scopes: ['read', 'write'],
  owner: { id: 'mem_1', name: 'Ada Owner' },
  last_success_at: '2026-10-10T08:00:00.000Z',
  credential_configured: true,
  provider_configured: true,
  last_error: null,
  retention_choice: null,
  version: 1,
};

describe('connection list', () => {
  it('names the owner, scopes, and last success without showing a secret', () => {
    const { container } = render(<ConnectionList connections={[row]} />);
    expect(screen.getByText(/Ada Owner/)).toBeTruthy();
    expect(screen.getByText(/Scopes: read, write/)).toBeTruthy();
    expect(screen.getByText(/Last successful synchronization:/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/api_key|secret|token/i);
  });
});
