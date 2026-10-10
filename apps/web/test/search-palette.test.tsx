import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/auth.tsx';
import { Router } from '../src/router.tsx';
import { searchApi, type RecentSearch, type SearchResult } from '../src/search/client.ts';
import { shell, type NavTarget } from '../src/shell/client.ts';
import { CommandProvider, useRegisterCommands } from '../src/shell/commands.tsx';
import { CommandPalette } from '../src/shell/palette.tsx';
import { PreferencesProvider } from '../src/shell/preferences.tsx';

const WS = 'wsp_A';
const TASK = 'tsk_00000000000000000000000001';

// The palette reads the workspace shell for the workspace id and the person's recents.
vi.mock('../src/shell/workspace.tsx', () => ({
  useWorkspaceShell: () => ({
    ws: 'wsp_A',
    context: { workspace: { id: 'wsp_A', name: 'Co', capabilities: {} }, brands: [] },
    recent: [],
  }),
}));

const brand = { kind: 'workspace' as const };
const hit = (extra: Partial<SearchResult> = {}): SearchResult => ({
  type: 'comment',
  id: 'cmt_1',
  title: 'Invoice question',
  title_parts: [{ text: 'Invoice question' }],
  snippet: null,
  brand,
  host: { type: 'task', id: TASK, title: 'Close the books' },
  project: null,
  owner: null,
  lifecycle_state: 'active',
  updated_at: '2026-10-05T10:00:00.000Z',
  index: 'current',
  ...extra,
});
const target = (id: string, label: string): NavTarget => ({
  id,
  type: 'task',
  label,
  brand: { kind: 'workspace' },
  lifecycle_state: 'active',
});

function Harness() {
  useRegisterCommands([
    { id: 'theme.dark', label: 'Use dark theme', group: 'Actions', run: () => undefined },
  ]);
  return <CommandPalette />;
}
const renderPalette = () =>
  render(
    <Router>
      <AuthProvider>
        <PreferencesProvider>
          <CommandProvider>
            <Harness />
          </CommandProvider>
        </PreferencesProvider>
      </AuthProvider>
    </Router>,
  );

beforeEach(() => {
  window.history.replaceState({}, '', `/workspaces/${WS}/today`);
  window.matchMedia = ((query: string) =>
    ({
      matches: /min-width/.test(query),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
  vi.spyOn(shell, 'targets').mockResolvedValue([]);
  vi.spyOn(searchApi, 'recent').mockResolvedValue([]);
  vi.spyOn(searchApi, 'remember').mockResolvedValue({ status: 202, body: {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('command palette and search (5A)', () => {
  it('offers recent searches before anything is typed, and looks nothing up', async () => {
    const recent: RecentSearch[] = [
      {
        handle: 'h1',
        q: 'budget',
        filters: { kind: ['document'] },
        count: 1,
        searched_at: '2026-10-05T10:00:00.000Z',
      },
    ];
    vi.spyOn(searchApi, 'recent').mockResolvedValue(recent);
    const query = vi.spyOn(searchApi, 'query');
    renderPalette();
    const option = await screen.findByRole('option', { name: /budget/ });
    expect(option.getAttribute('href')).toBe(`/workspaces/${WS}/search?q=budget&kind=document`);
    expect(within(option).getByText('Recent search')).toBeTruthy();
    expect(query).not.toHaveBeenCalled();
    expect(searchApi.remember).not.toHaveBeenCalled();
  });

  it('adds permission-aware results after the typed term, with a way into the full search', async () => {
    const query = vi.spyOn(searchApi, 'query').mockResolvedValue({
      results: [hit(), hit({ type: 'task', id: TASK, title: 'Invoice review', host: null })],
    } as never);
    vi.spyOn(shell, 'targets').mockResolvedValue([target(TASK, 'Invoice review')]);
    renderPalette();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'invoice' } });
    await screen.findByRole('option', { name: /Search everywhere for “invoice”/ });
    await waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    expect(query).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ q: 'invoice', kind: [] }),
      expect.anything(),
      6,
    );
    const options = await screen.findAllByRole('option');
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThanOrEqual(3));
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    // The record the navigation lookup already shows is not repeated; the comment opens its task.
    expect(names.filter((n) => n?.includes('Invoice review'))).toHaveLength(1);
    const comment = screen.getByRole('option', { name: /Invoice question/ });
    expect(comment.getAttribute('href')).toBe(`/workspaces/${WS}/tasks/${TASK}`);
    expect(within(comment).getByText('Comment')).toBeTruthy();
    expect(options.length).toBeGreaterThan(0);
    // Typing and looking up remember nothing.
    expect(searchApi.remember).not.toHaveBeenCalled();
  });

  it('choosing the full search by keyboard submits it: opens the page and remembers it once', async () => {
    vi.spyOn(searchApi, 'query').mockResolvedValue({ results: [] } as never);
    renderPalette();
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: '  budget plan ' } });
    await screen.findByRole('option', { name: /Search everywhere for “budget plan”/ });
    // The input is the active descendant for assistive technology; arrows move through options.
    expect(box.getAttribute('aria-activedescendant')).toBeTruthy();
    const options = () => screen.getAllByRole('option');
    const everywhere = options().findIndex((o) => /Search everywhere/.test(o.textContent ?? ''));
    for (let i = 0; i < everywhere; i++) fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(window.location.pathname).toBe(`/workspaces/${WS}/search`));
    expect(window.location.search).toBe('?q=budget+plan');
    expect(searchApi.remember).toHaveBeenCalledTimes(1);
    expect(searchApi.remember).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ q: 'budget plan' }),
    );
  });

  it('an actions-only entry searches nothing, and a failed lookup leaves the palette usable', async () => {
    const query = vi.spyOn(searchApi, 'query').mockRejectedValue(new Error('down'));
    renderPalette();
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: '>dark' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Use dark theme']);
    await new Promise((r) => setTimeout(r, 300));
    expect(query).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: 'invoice' } });
    await waitFor(() => expect(query).toHaveBeenCalled());
    expect(await screen.findByRole('option', { name: /Search everywhere/ })).toBeTruthy();
  });
});
