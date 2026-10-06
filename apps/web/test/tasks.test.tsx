import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskTree } from '../src/pages/task-pages.tsx';
import { Router } from '../src/router.tsx';
import { matchRoute } from '../src/shell/registry.ts';
import { TARGET_TYPE_LABEL, targetHref } from '../src/shell/targets.ts';
import { StepUpProvider } from '../src/stepup.tsx';
import { tasks, type TaskSummary } from '../src/tasks/client.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const brand = { kind: 'brand', id: 'br_A', name: 'Harbor' } as unknown as TaskSummary['brand'];
const status = { key: 'todo', name: 'To do', category: 'planned' } as TaskSummary['status'];
const row = (id: string, title: string, children = 0): TaskSummary => ({
  id,
  type: 'task',
  title,
  status,
  priority: 'none',
  version: 0,
  start_date: null,
  due_date: null,
  deadline: null,
  estimate_minutes: null,
  remaining_estimate_minutes: null,
  depth: 0,
  children,
  assignees: [],
  lifecycle_state: 'active',
  brand,
});

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

describe('task routes and targets (0E Phase 2B note)', () => {
  it('the task page and the projectless list are canonical routes', () => {
    expect(matchRoute('/workspaces/ws_A/tasks/tsk_B')).toMatchObject({
      def: { id: 'task' },
      params: { ws: 'ws_A', tsk: 'tsk_B' },
    });
    expect(matchRoute('/workspaces/ws_A/tasks')).toMatchObject({ def: { id: 'tasks' } });
    expect(targetHref('ws_A', { id: 'tsk_B', type: 'task' })).toBe('/workspaces/ws_A/tasks/tsk_B');
    expect(TARGET_TYPE_LABEL.task).toBe('Task');
  });
});

describe('task hierarchy (A11Y-PA-08, no drag)', () => {
  const roots = [row('tsk_1', 'Alpha', 1), row('tsk_2', 'Bravo'), row('tsk_3', 'Charlie')];

  it('has one tab stop, loads children on expand, and moves focus with arrows', async () => {
    vi.spyOn(tasks, 'list').mockResolvedValue({
      data: [row('tsk_9', 'Apple')],
      page: { has_more: false },
    });
    wrap(<TaskTree ws="ws_A" roots={roots} onChanged={() => undefined} />);
    const tree = screen.getByRole('tree', { name: 'Task hierarchy' });
    const tabbable = within(tree)
      .getAllByRole('treeitem')
      .filter((n) => n.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    const alpha = tabbable[0]!;
    expect(alpha.getAttribute('aria-expanded')).toBe('false');
    alpha.focus();
    const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
    await act(async () => press('ArrowRight'));
    expect(tasks.list).toHaveBeenCalledWith('ws_A', { parent: 'tsk_1', limit: '200' });
    expect(alpha.getAttribute('aria-expanded')).toBe('true');
    press('ArrowDown');
    expect(focusedName()).toBe('Apple');
    expect(document.activeElement?.getAttribute('aria-level')).toBe('2');
    press('End');
    expect(focusedName()).toBe('Charlie');
    press('Home');
    expect(focusedName()).toBe('Alpha');
    press('c');
    expect(focusedName()).toBe('Charlie');
  });

  it('Move up, Move down, Indent, and Outdent send explicit placements', async () => {
    const verb = vi.spyOn(tasks, 'verb').mockResolvedValue({} as never);
    wrap(<TaskTree ws="ws_A" roots={roots} onChanged={() => undefined} />);
    const tree = screen.getByRole('tree');
    act(() => within(tree).getAllByRole('treeitem')[2]!.focus()); // Charlie
    const actions = screen.getByRole('group', { name: 'Actions for Charlie' });
    await act(async () =>
      fireEvent.click(within(actions).getByRole('button', { name: 'Move up' })),
    );
    expect(verb).toHaveBeenLastCalledWith(
      'ws_A',
      'tsk_3',
      'move',
      { parent: null, after: 'tsk_1' },
      expect.anything(),
    );
    await act(async () => fireEvent.click(within(actions).getByRole('button', { name: 'Indent' })));
    expect(verb).toHaveBeenLastCalledWith(
      'ws_A',
      'tsk_3',
      'move',
      { parent: 'tsk_2' },
      expect.anything(),
    );
    expect(
      (within(actions).getByRole('button', { name: 'Move down' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(actions).getByRole('button', { name: 'Outdent' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    act(() => within(tree).getAllByRole('treeitem')[0]!.focus()); // Alpha
    const first = screen.getByRole('group', { name: 'Actions for Alpha' });
    expect(
      (within(first).getByRole('button', { name: 'Move up' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () =>
      fireEvent.click(within(first).getByRole('button', { name: 'Move down' })),
    );
    expect(verb).toHaveBeenLastCalledWith(
      'ws_A',
      'tsk_1',
      'move',
      { parent: null, after: 'tsk_2' },
      expect.anything(),
    );
  });
});
