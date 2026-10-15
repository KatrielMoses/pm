import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionList, type ConnectionView } from '../src/integrations/panel.tsx';
import { PortabilityPanel } from '../src/pages/integration-pages.tsx';
import { StepUpProvider } from '../src/stepup.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

describe('CSV portability panel', () => {
  it('provides labelled import controls that are keyboard discoverable', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { mappings: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    render(
      <StepUpProvider>
        <PortabilityPanel ws="wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV" />
      </StepUpProvider>,
    );
    expect(screen.getByLabelText('Record type')).toBeTruthy();
    expect(screen.getByLabelText(/CSV file/)).toBeTruthy();
    expect(screen.getByLabelText('Import behavior')).toBeTruthy();
    expect(screen.getByLabelText(/Column mapping/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy();
  });
});
