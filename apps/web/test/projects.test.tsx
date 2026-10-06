import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_SECTIONS } from '@pm/contracts/shell';
import { ProjectTree, SectionNav } from '../src/pages/project-pages.tsx';
import { projects, type ProjectSummary } from '../src/projects/client.ts';
import { Router } from '../src/router.tsx';
import { matchRoute } from '../src/shell/registry.ts';
import { targetHref } from '../src/shell/targets.ts';
import { StepUpProvider } from '../src/stepup.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const brand = { kind: 'brand', id: 'br_A', name: 'Harbor' } as unknown as ProjectSummary['brand'];
const status = { key: 'planned', name: 'Planned', category: 'planned' } as ProjectSummary['status'];
const row = (id: string, name: string, parent: string | null, children = 0): ProjectSummary => ({
  id,
  type: 'project',
  name,
  status,
  priority: 'none',
  health: null,
  target_date: null,
  depth: parent ? 1 : 0,
  parent,
  children,
  lifecycle_state: 'active',
  brand,
});

/** The focused tree item's own label (its text without nested groups or the status badge). */
const focusedName = () =>
  document.activeElement
    ?.querySelector(':scope > .tree-label')
    ?.firstChild?.nextSibling?.textContent?.trim();

const wrap = (ui: React.ReactNode) =>
  render(
    <Router>
      <StepUpProvider>{ui}</StepUpProvider>
    </Router>,
  );

describe('project sections (0E Phase 2A note, UXD-14)', () => {
  it('the fixed order; Tests and Releases are conditional and absent from the navigation', () => {
    expect(PROJECT_SECTIONS.map((s) => s.label)).toEqual([
      'Overview',
      'Tasks',
      'Timeline',
      'Calendar',
      'Documents',
      'Files',
      'Activity',
      'Time',
      'Costs',
      'Reports',
      'Settings',
      'Tests',
      'Releases',
    ]);
    expect(PROJECT_SECTIONS.filter((s) => s.conditional).map((s) => s.key)).toEqual([
      'tests',
      'releases',
    ]);
    // Overview, Timeline, Settings (2A), Tasks (2B), and Time (3D) are functional; the rest name
    // their phase.
    expect(PROJECT_SECTIONS.filter((s) => s.phase === null).map((s) => s.key)).toEqual([
      'overview',
      'tasks',
      'timeline',
      'time',
      'settings',
    ]);
    wrap(<SectionNav ws="ws_A" prj="prj_B" current="timeline" />);
    const nav = screen.getByRole('navigation', { name: 'Project sections' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(
      PROJECT_SECTIONS.filter((s) => !s.conditional).map((s) => s.label),
    );
    expect(links.find((l) => l.getAttribute('aria-current') === 'page')?.textContent).toBe(
      'Timeline',
    );
    expect(links[0]!.getAttribute('href')).toBe('/workspaces/ws_A/projects/prj_B');
    expect(links[2]!.getAttribute('href')).toBe('/workspaces/ws_A/projects/prj_B/timeline');
  });

  it('project routes and navigation targets resolve through the one registry', () => {
    expect(matchRoute('/workspaces/ws_A/projects/prj_B')).toMatchObject({
      def: { id: 'project' },
      params: { ws: 'ws_A', prj: 'prj_B' },
    });
    expect(matchRoute('/workspaces/ws_A/projects/prj_B/tests')).toMatchObject({
      def: { id: 'project_section' },
      params: { section: 'tests' },
    });
    expect(matchRoute('/workspaces/ws_A/projects')).toMatchObject({ def: { id: 'projects' } });
    expect(targetHref('ws_A', { id: 'prj_B', type: 'project' })).toBe(
      '/workspaces/ws_A/projects/prj_B',
    );
  });
});

describe('project tree (A11Y-PA-08, A11Y-KB-05)', () => {
  const items = [
    row('prj_A', 'Alpha', null, 2),
    row('prj_A1', 'Apple', 'prj_A'),
    row('prj_A2', 'Avocado', 'prj_A'),
    row('prj_B', 'Bravo', null),
  ];

  it('one tab stop; arrows, Home/End, expand/collapse, and type-ahead move focus', () => {
    wrap(<ProjectTree ws="ws_A" items={items} onMoved={() => undefined} />);
    const tree = screen.getByRole('tree', { name: 'Project hierarchy' });
    const tabbable = within(tree)
      .getAllByRole('treeitem')
      .filter((n) => n.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    const alpha = tabbable[0]!;
    expect(alpha?.getAttribute('aria-level')).toBe('1');
    expect(alpha?.getAttribute('aria-expanded')).toBe('true');
    alpha.focus();
    const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
    press('ArrowDown');
    expect(focusedName()).toBe('Apple');
    expect(document.activeElement?.getAttribute('aria-level')).toBe('2');
    press('End');
    expect(focusedName()).toBe('Bravo');
    press('Home');
    expect(focusedName()).toBe('Alpha');
    press('ArrowLeft');
    expect(alpha?.getAttribute('aria-expanded')).toBe('false');
    press('ArrowDown');
    expect(focusedName()).toBe('Bravo');
    press('Home');
    press('ArrowRight');
    expect(alpha?.getAttribute('aria-expanded')).toBe('true');
    press('ArrowRight');
    expect(focusedName()).toBe('Apple');
    // Type-ahead: "av" finds Avocado; "b" finds Bravo.
    press('a');
    press('v');
    expect(focusedName()).toBe('Avocado');
  });

  it('Move up/down, Indent, and Outdent are visible buttons that send one move command', async () => {
    const verb = vi.spyOn(projects, 'verb').mockResolvedValue({} as never);
    const moved = vi.fn();
    wrap(<ProjectTree ws="ws_A" items={items} onMoved={moved} />);
    const alpha = screen.getAllByRole('treeitem')[0]!;
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(focusedName()).toBe('Avocado');
    const actions = screen.getByRole('group', { name: 'Actions for Avocado' });
    expect(
      (within(actions).getByRole('button', { name: 'Move down' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      fireEvent.click(within(actions).getByRole('button', { name: 'Indent' }));
    });
    expect(verb).toHaveBeenLastCalledWith(
      'ws_A',
      'prj_A2',
      'move',
      { parent: 'prj_A1', after: null },
      expect.anything(),
    );
    await act(async () => {
      fireEvent.click(within(actions).getByRole('button', { name: 'Outdent' }));
    });
    expect(verb).toHaveBeenLastCalledWith(
      'ws_A',
      'prj_A2',
      'move',
      { parent: null, after: 'prj_A' },
      expect.anything(),
    );
    await act(async () => {
      fireEvent.click(within(actions).getByRole('button', { name: 'Move up' }));
    });
    expect(verb).toHaveBeenLastCalledWith(
      'ws_A',
      'prj_A2',
      'move',
      { parent: 'prj_A', after: null },
      expect.anything(),
    );
    expect(moved).toHaveBeenCalledTimes(3);
  });
});
