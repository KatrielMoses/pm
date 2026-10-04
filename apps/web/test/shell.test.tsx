import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHELL_COMMAND_IDS, SHELL_DESTINATIONS } from '@pm/contracts/shell';
import { ROUTE_COMPONENTS } from '../src/app-routes.tsx';
import { AuthProvider } from '../src/auth.tsx';
import { Router } from '../src/router.tsx';
import { applyAppearance, followSystemTheme } from '../src/shell/appearance.ts';
import { BrandMarker, contrastRatio, glyphColor } from '../src/shell/brand-marker.tsx';
import { Breadcrumbs } from '../src/shell/breadcrumbs.tsx';
import type { ShellCapabilities } from '../src/shell/client.ts';
import {
  CommandProvider,
  useCommands,
  useRegisterCommands,
  type Command,
} from '../src/shell/commands.tsx';
import { deviceKey } from '../src/shell/device.ts';
import { clearPersonalClientState, loadDraft, saveDraft } from '../src/shell/drafts.ts';
import { CommandPalette } from '../src/shell/palette.tsx';
import { PreferencesProvider } from '../src/shell/preferences.tsx';
import {
  canSee,
  COMPACT_SLOTS,
  documentTitle,
  matchRoute,
  navEntries,
  ROUTES,
  routeHref,
  type Access,
} from '../src/shell/registry.ts';
import {
  eventChord,
  isEditable,
  shortcutLabel,
  validateShortcuts,
  type ShortcutBinding,
} from '../src/shell/shortcuts.ts';
import { pruneSelection } from '../src/shell/view-state.ts';
import { widthClass } from '../src/shell/width.ts';
import { Dialog } from '../src/ui/dialog.tsx';

const ALL: ShellCapabilities = {
  configure: true,
  create_brand: true,
  manage_people: true,
  invite_members: true,
  invite_guests: true,
  manage_teams: true,
  preview_access: true,
  configure_sharing: true,
  transfer_ownership: true,
  view_directory: true,
};
const NONE: ShellCapabilities = Object.fromEntries(
  Object.keys(ALL).map((k) => [k, false]),
) as unknown as ShellCapabilities;
const owner: Access = { principal: 'member', capabilities: ALL, hidden: [] };
const plainMember: Access = {
  principal: 'member',
  capabilities: { ...NONE, view_directory: true },
  hidden: [],
};
const guest: Access = { principal: 'guest', capabilities: NONE, hidden: [] };

/** jsdom has no matchMedia: emulate a viewport width (min-width queries only) and pointer. */
function mockViewport(width: number, fine = true) {
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const matches = min
      ? width >= Number(min[1])
      : query.includes('pointer: fine')
        ? fine
        : query.includes('prefers-color-scheme: dark')
          ? false
          : false;
    return {
      matches,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

beforeEach(() => {
  mockViewport(1280);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ error: { code: 'unauthenticated' } }), { status: 401 }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('route registry (NAV-001, NAV-012)', () => {
  it('every registry route has exactly one page component (no dead destinations)', () => {
    for (const r of ROUTES) expect(ROUTE_COMPONENTS[r.id], r.id).toBeTypeOf('function');
    expect(Object.keys(ROUTE_COMPONENTS).sort()).toEqual(ROUTES.map((r) => r.id).sort());
    for (const d of SHELL_DESTINATIONS) expect(ROUTES.some((r) => r.destination === d)).toBe(true);
  });

  it('every go-to command in the registry is a registered telemetry command', () => {
    for (const r of ROUTES)
      if (r.command) expect(SHELL_COMMAND_IDS as readonly string[], r.id).toContain(r.command);
  });

  it('matches literal segments before parameters and builds canonical hrefs', () => {
    expect(matchRoute('/workspaces/ws_1/people/invite')?.def.id).toBe('invite');
    expect(matchRoute('/workspaces/ws_1/people/mem_X')?.def.id).toBe('person');
    expect(matchRoute('/workspaces/ws_1/my-work')?.def.id).toBe('my_work');
    expect(matchRoute('/workspaces/ws_1/brands/new')?.def.id).toBe('brand_new');
    expect(matchRoute('/workspaces/ws 1/home')).toBeNull();
    expect(routeHref('today', { ws: 'ws_1' }, { scope: 'all' })).toBe(
      '/workspaces/ws_1/today?scope=all',
    );
  });

  it('one permission predicate drives every surface: absent, not disabled (IA-02, IA-05)', () => {
    const ids = (a: Access | null, p: Parameters<typeof navEntries>[0]) =>
      navEntries(p, a).map((r) => r.id);
    expect(ids(owner, 'primary')).toEqual([...SHELL_DESTINATIONS]);
    expect(ids(owner, 'admin')).toEqual(['workspace_settings', 'access_settings']);
    expect(ids(plainMember, 'admin')).toEqual(['access_settings']);
    expect(ids(guest, 'primary')).toEqual(['shared']);
    expect(ids(guest, 'workspace')).toEqual([]);
    expect(ids(guest, 'admin')).toEqual([]);
    expect(
      canSee(
        ROUTES.find((r) => r.id === 'people')!,
        guest,
      ),
    ).toBe(false);
    expect(
      canSee(
        ROUTES.find((r) => r.id === 'brand_new')!,
        plainMember,
      ),
    ).toBe(false);
    // Hidden destinations disappear everywhere; Home never hides (UXD-20).
    const hiding: Access = { ...owner, hidden: ['goals', 'reports'] };
    expect(ids(hiding, 'primary')).not.toContain('goals');
    expect(ids({ ...owner, hidden: ['home'] as never }, 'primary')).toContain('home');
    expect(COMPACT_SLOTS).toEqual(['home', 'today', 'inbox', 'my_work']);
  });

  it('page titles follow {record} · {section} · {product} and never include brand names (IA-14)', () => {
    expect(documentTitle('PM', 'Teams', { title: 'Studio' })).toBe('Studio · Teams · PM');
    expect(documentTitle('PM', 'Brand settings', { title: 'Optestra', isBrand: true })).toBe(
      'Brand settings · PM',
    );
    expect(documentTitle('PM', 'People', { title: 'People' })).toBe('People · PM');
    expect(documentTitle('PM', 'Home', null)).toBe('Home · PM');
  });
});

describe('width classes (RS-01, DS-08)', () => {
  it('switches exactly at 600, 1024, and 1440 (lower bound inclusive)', () => {
    expect([599, 600, 1023, 1024, 1439, 1440, 320].map(widthClass)).toEqual([
      'compact',
      'medium',
      'medium',
      'expanded',
      'expanded',
      'wide',
      'compact',
    ]);
  });
  // The stylesheet's breakpoints are checked in scripts/test/web-design-tokens.test.mjs.
});

describe('shortcuts (RS-12, A11Y-KB-06/07)', () => {
  const shellMap: ShortcutBinding[] = [
    { id: 'palette.open', keys: 'Mod+K', layer: 'global' },
    { id: 'scope.switch', keys: 'Mod+Shift+B', layer: 'global' },
    { id: 'shortcuts.reference', keys: '?', layer: 'global' },
    ...ROUTES.filter((r) => r.shortcut).map((r) => ({
      id: r.command ?? r.id,
      keys: r.shortcut!,
      layer: 'global' as const,
    })),
    { id: 'list.next', keys: 'J', layer: 'view' },
    { id: 'list.previous', keys: 'K', layer: 'view' },
  ];

  it('the shipped key map passes the conflict rules', () => {
    expect(validateShortcuts(shellMap)).toEqual([]);
  });

  it('rejects browser, OS, and screen-reader combinations, duplicates, and sequence prefixes', () => {
    const bad = validateShortcuts([
      { id: 'a', keys: 'Mod+L', layer: 'global' },
      { id: 'b', keys: 'F6', layer: 'global' },
      { id: 'c', keys: 'Alt+ArrowLeft', layer: 'global' },
      { id: 'd', keys: 'Mod+Alt+K', layer: 'global' },
      { id: 'e', keys: 'Mod+Shift+T', layer: 'global' },
      { id: 'f', keys: 'G', layer: 'global' },
      { id: 'g', keys: 'G H', layer: 'global' },
      { id: 'h', keys: 'J', layer: 'view' },
      { id: 'i', keys: 'J', layer: 'record' },
    ]);
    const reasons = bad.map((c) => `${c.ids.join('+')}:${c.reason}`);
    expect(reasons).toEqual(
      expect.arrayContaining([
        'a:browser or operating-system shortcut',
        'b:function keys belong to the browser',
        'c:browser history or window control',
        'd:Ctrl+Option belongs to VoiceOver',
        'e:browser or operating-system shortcut',
        'f+g:single key is a sequence prefix',
        'h+i:same keys bound twice',
      ]),
    );
  });

  it('labels follow the platform: ⌘ on Apple, Ctrl elsewhere; sequences read "then"', () => {
    expect(shortcutLabel('Mod+K', true)).toBe('⌘K');
    expect(shortcutLabel('Mod+K', false)).toBe('Ctrl+K');
    expect(shortcutLabel('Mod+Shift+B', false)).toBe('Ctrl+Shift+B');
    expect(shortcutLabel('G H', false)).toBe('G then H');
    expect(shortcutLabel('?', true)).toBe('?');
  });

  it('normalizes events and recognizes editable targets', () => {
    const e = new KeyboardEvent('keydown', { key: '?', shiftKey: true });
    expect(eventChord(e, false)).toEqual({ mod: false, shift: false, alt: false, key: '?' });
    expect(eventChord(new KeyboardEvent('keydown', { key: 'k', metaKey: true }), true).mod).toBe(
      true,
    );
    expect(eventChord(new KeyboardEvent('keydown', { key: 'k', metaKey: true }), false).mod).toBe(
      false,
    );
    const text = document.createElement('input');
    const box = Object.assign(document.createElement('input'), { type: 'checkbox' });
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    document.body.append(text, box, editor);
    expect(isEditable(text)).toBe(true);
    expect(isEditable(box)).toBe(false);
    expect(isEditable(document.createElement('textarea'))).toBe(true);
    expect(isEditable(editor)).toBe(true);
    text.remove();
    box.remove();
    editor.remove();
  });
});

function Harness({ commands, children }: { commands: Command[]; children?: React.ReactNode }) {
  useRegisterCommands(commands);
  const { paletteOpen } = useCommands();
  return (
    <>
      <input aria-label="Notes" />
      <p data-testid="palette">{paletteOpen ? 'open' : 'closed'}</p>
      {children}
      {paletteOpen ? <CommandPalette /> : null}
    </>
  );
}

function renderShell(commands: Command[], children?: React.ReactNode, shortcuts = 'on') {
  localStorage.setItem('pm.appearance', JSON.stringify({ theme: 'light' }));
  return (
    render(
      <Router>
        <AuthProvider>
          <PreferencesProvider>
            <CommandProvider>
              <Harness commands={commands}>{children}</Harness>
            </CommandProvider>
          </PreferencesProvider>
        </AuthProvider>
      </Router>,
      {},
    ) && shortcuts
  );
}

const key = (init: KeyboardEventInit, target: EventTarget = document.body) =>
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });

describe('command registry and keyboard handling', () => {
  it('Ctrl/⌘+K opens the palette even in editable fields; single keys never fire while typing', async () => {
    const run = vi.fn();
    renderShell([
      { id: 'palette.open', label: 'Open command palette', group: 'Actions', shortcut: 'Mod+K' },
      { id: 'go.home', label: 'Home', group: 'Go to', shortcut: 'G H', run },
    ]);
    const input = screen.getByLabelText('Notes');
    input.focus();
    await key({ key: 'g' }, input);
    await key({ key: 'h' }, input);
    expect(run).not.toHaveBeenCalled();
    await key({ key: 'k', ctrlKey: true, metaKey: true }, input);
    expect(screen.getByTestId('palette').textContent).toBe('open');
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy();
  });

  it('sequences run the command; repeats, composition, and modal dialogs are ignored', async () => {
    const run = vi.fn();
    renderShell(
      [{ id: 'go.home', label: 'Home', group: 'Go to', shortcut: 'G H', run }],
      <Dialog title="Modal" onClose={() => undefined}>
        <p>Blocking</p>
      </Dialog>,
    );
    await key({ key: 'g' });
    await key({ key: 'h' });
    expect(run).not.toHaveBeenCalled();
    cleanup();
    renderShell([{ id: 'go.home', label: 'Home', group: 'Go to', shortcut: 'G H', run }]);
    await key({ key: 'g', repeat: true });
    await key({ key: 'h' });
    await key({ key: 'g', isComposing: true });
    await key({ key: 'h' });
    expect(run).not.toHaveBeenCalled();
    await key({ key: 'g' });
    await key({ key: 'h' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('single-key shortcuts follow the personal setting (off: never fire)', async () => {
    mockViewport(1280, false); // coarse pointer: `auto` means off (UXD-04)
    const run = vi.fn();
    renderShell([{ id: 'go.home', label: 'Home', group: 'Go to', shortcut: 'G H', run }]);
    await key({ key: 'g' });
    await key({ key: 'h' });
    expect(run).not.toHaveBeenCalled();
  });

  it('palette groups Actions before Go to, filters by text, and ">" restricts to actions', async () => {
    const run = vi.fn();
    renderShell([
      { id: 'palette.open', label: 'Open command palette', group: 'Actions', shortcut: 'Mod+K' },
      { id: 'theme.dark', label: 'Use dark theme', group: 'Actions', run },
      {
        id: 'go.today',
        label: 'Today',
        group: 'Go to',
        href: '/workspaces/ws_1/today',
        shortcut: 'G T',
      },
    ]);
    await key({ key: 'k', ctrlKey: true, metaKey: true });
    const groups = screen.getAllByRole('group').map((g) => g.getAttribute('aria-labelledby'));
    expect(groups.length).toBe(2);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Use dark theme',
      expect.stringMatching(/^Today/),
    ]);
    const box = screen.getByRole('combobox');
    fireEvent.change(box, { target: { value: '>' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Use dark theme']);
    fireEvent.change(box, { target: { value: 'today' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    const link = screen.getByRole('option') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/workspaces/ws_1/today');
    fireEvent.change(box, { target: { value: 'dark' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('breadcrumbs collapse by width (RS-40)', () => {
  const trail = [
    {
      label: 'Optestra',
      marker: {
        kind: 'brand' as const,
        id: 'br_1',
        name: 'Optestra',
        short_name: null,
        color: '#336699',
        icon: 'circle',
        archived: false,
      },
    },
    { label: 'Project', to: '/p' },
    { label: 'Parent task', to: '/t' },
    { label: 'Task' },
  ];
  const renderCrumbs = () =>
    render(
      <Router>
        <Breadcrumbs trail={trail} />
      </Router>,
    );

  it('Expanded shows the full trail with the current page marked', () => {
    mockViewport(1280);
    renderCrumbs();
    expect(screen.getByRole('link', { name: 'Project' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Parent task' })).toBeTruthy();
    expect(screen.getByText('Task').closest('[aria-current]')?.getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('Medium folds middle crumbs into an overflow; Compact shows ‹ Parent', () => {
    mockViewport(800);
    renderCrumbs();
    expect(screen.queryByRole('link', { name: 'Project' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show full path' }));
    expect(screen.getByRole('link', { name: 'Project' })).toBeTruthy();
    cleanup();
    mockViewport(375);
    renderCrumbs();
    // The chevron is decorative; the link's name is the parent's.
    expect(screen.getByRole('link', { name: 'Parent task' }).textContent).toContain('‹');
  });
});

describe('brand marker (DS-40/41, WSB-015)', () => {
  it('the glyph is black or white, whichever contrasts more, and always ≥ 4.5:1', () => {
    for (let r = 0; r < 256; r += 17)
      for (let g = 0; g < 256; g += 17)
        for (let b = 0; b < 256; b += 17) {
          const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
          expect(contrastRatio(hex, glyphColor(hex)), hex).toBeGreaterThanOrEqual(4.5);
        }
  });

  it('renders brand, workspace, and no-brand markers with text names (never colour alone)', () => {
    render(
      <>
        <BrandMarker
          marker={{
            kind: 'brand',
            id: 'br_1',
            name: '<b>Acme</b>',
            short_name: null,
            color: '#ffffff',
            icon: 'star',
            archived: true,
          }}
        />
        <BrandMarker marker={{ kind: 'workspace' }} />
        <BrandMarker marker={{ kind: 'unbranded' }} />
      </>,
    );
    expect(screen.getByText('<b>Acme</b>')).toBeTruthy();
    expect(screen.getByText('Archived')).toBeTruthy();
    expect(screen.getByText('Workspace')).toBeTruthy();
    expect(screen.getByText('No brand yet')).toBeTruthy();
    expect(document.querySelector('.marker-tile-outline')).not.toBeNull();
  });
});

describe('appearance, drafts, device key, selection pruning', () => {
  it('applies theme, density, and motion to the document and caches them for pre-paint', () => {
    applyAppearance({ theme: 'dark', density: 'compact', motion: 'reduce' });
    const root = document.documentElement;
    expect(root.dataset).toMatchObject({
      theme: 'dark',
      colorScheme: 'dark',
      density: 'compact',
      motion: 'reduce',
    });
    expect(JSON.parse(localStorage.getItem('pm.appearance')!)).toEqual({
      theme: 'dark',
      density: 'compact',
      motion: 'reduce',
    });
    applyAppearance({ theme: 'system', density: 'comfortable', motion: 'system' });
    expect(root.dataset.colorScheme).toBe('light');
    expect(root.dataset.density).toBeUndefined();
  });

  it('follows the operating system only while the theme is "system"', () => {
    let listener: (() => void) | undefined;
    let dark = false;
    window.matchMedia = ((q: string) => ({
      get matches() {
        return q.includes('dark') ? dark : false;
      },
      addEventListener: (_: string, fn: () => void) => (listener = fn),
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    let theme: 'system' | 'light' = 'light';
    const stop = followSystemTheme(() => theme);
    document.documentElement.dataset.colorScheme = 'light';
    dark = true;
    listener?.();
    expect(document.documentElement.dataset.colorScheme).toBe('light');
    theme = 'system';
    listener?.();
    expect(document.documentElement.dataset.colorScheme).toBe('dark');
    stop();
  });

  it('drafts and per-tab view state clear on sign-out; appearance and device key stay', () => {
    const k = deviceKey();
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deviceKey()).toBe(k);
    expect(saveDraft('acct', 'comment.new', 'unsent text')).toBe(true);
    expect(saveDraft('acct', 'Bad Id!', 'x')).toBe(false);
    expect(loadDraft('acct', 'comment.new')?.value).toBe('unsent text');
    sessionStorage.setItem('pm.vs.ws_1.recent.list', '{}');
    localStorage.setItem('pm.appearance', '{"theme":"dark"}');
    clearPersonalClientState();
    expect(loadDraft('acct', 'comment.new')).toBeNull();
    expect(sessionStorage.getItem('pm.vs.ws_1.recent.list')).toBeNull();
    expect(localStorage.getItem('pm.appearance')).not.toBeNull();
    expect(deviceKey()).toBe(k);
  });

  it('prunes selections to visible items before bulk actions', () => {
    expect(pruneSelection(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual({
      kept: ['b', 'c'],
      removed: 1,
    });
  });
});
