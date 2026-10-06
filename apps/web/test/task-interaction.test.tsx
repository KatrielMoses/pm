import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { TaskTree } from '../src/pages/task-pages.tsx';
import { Router } from '../src/router.tsx';
import { StepUpProvider } from '../src/stepup.tsx';
import { tasks, type BulkOp, type Task, type TaskSummary } from '../src/tasks/client.ts';
import {
  BulkBar,
  DuplicateHint,
  InlineEditor,
  SaveStatus,
  SignalBadges,
  UndoToast,
} from '../src/tasks/interaction.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const wrap = (ui: React.ReactNode) =>
  render(
    <Router>
      <StepUpProvider>{ui}</StepUpProvider>
    </Router>,
  );
const brand = { kind: 'brand', id: 'br_A', name: 'Harbor' } as unknown as TaskSummary['brand'];
const status = { key: 'todo', name: 'To do', category: 'planned' } as TaskSummary['status'];
const row = (id: string, title: string): TaskSummary => ({
  id,
  type: 'task',
  title,
  status,
  priority: 'none',
  version: 3,
  start_date: null,
  due_date: null,
  deadline: null,
  estimate_minutes: null,
  remaining_estimate_minutes: null,
  depth: 0,
  children: 0,
  assignees: [],
  lifecycle_state: 'active',
  brand,
});

describe('ordering commands (ADR-0016 D9): keys, buttons, and drag run the same command', () => {
  const roots = [row('tsk_1', 'Alpha'), row('tsk_2', 'Bravo'), row('tsk_3', 'Charlie')];
  const reorderOk = () =>
    vi.spyOn(tasks, 'reorder').mockResolvedValue({
      id: 'x',
      position: 1,
      total: 3,
      announcement: 'Moved to position 1 of 3.',
      undo: { id: 'und_1', expires_at: new Date(Date.now() + 30_000).toISOString() },
    });

  it('Alt+Arrow, Alt+Home, and Alt+End reorder the focused task and announce the result', async () => {
    const reorder = reorderOk();
    const changed = vi.fn();
    const onUndo = vi.fn();
    wrap(<TaskTree ws="ws_A" roots={roots} onChanged={changed} onUndo={onUndo} />);
    const items = within(screen.getByRole('tree')).getAllByRole('treeitem');
    act(() => items[2]!.focus());
    await act(async () => fireEvent.keyDown(items[2]!, { key: 'ArrowUp', altKey: true }));
    expect(reorder).toHaveBeenLastCalledWith(
      'ws_A',
      'tsk_3',
      { position: 'up' },
      3,
      expect.anything(),
    );
    expect(changed).toHaveBeenLastCalledWith('Charlie: Moved to position 1 of 3.', 'tsk_3');
    expect(onUndo).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'und_1' }),
      'Charlie moved',
    );
    await act(async () => fireEvent.keyDown(items[2]!, { key: 'Home', altKey: true }));
    expect(reorder).toHaveBeenLastCalledWith(
      'ws_A',
      'tsk_3',
      { position: 'top' },
      3,
      expect.anything(),
    );
    await act(async () => fireEvent.keyDown(items[2]!, { key: 'End', altKey: true }));
    expect(reorder).toHaveBeenLastCalledWith(
      'ws_A',
      'tsk_3',
      { position: 'bottom' },
      3,
      expect.anything(),
    );
  });

  it('buttons offer top, bottom, and move to a position; drag drops call move-to-position', async () => {
    const reorder = reorderOk();
    wrap(<TaskTree ws="ws_A" roots={roots} onChanged={() => undefined} />);
    const items = within(screen.getByRole('tree')).getAllByRole('treeitem');
    act(() => items[0]!.focus());
    const actions = screen.getByRole('group', { name: 'Actions for Alpha' });
    expect(
      (within(actions).getByRole('button', { name: 'Move to top' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () =>
      fireEvent.click(within(actions).getByRole('button', { name: 'Move to bottom' })),
    );
    expect(reorder).toHaveBeenLastCalledWith(
      'ws_A',
      'tsk_1',
      { position: 'bottom' },
      3,
      expect.anything(),
    );
    fireEvent.change(within(actions).getByLabelText('Position (1–3)'), { target: { value: '2' } });
    await act(async () =>
      fireEvent.click(within(actions).getByRole('button', { name: 'Move to position' })),
    );
    expect(reorder).toHaveBeenLastCalledWith(
      'ws_A',
      'tsk_1',
      { position: 'to', index: 2 },
      3,
      expect.anything(),
    );
    // Drag Charlie onto Alpha: the same command, position 1.
    fireEvent.dragStart(items[2]!);
    fireEvent.dragOver(items[0]!);
    await act(async () => fireEvent.drop(items[0]!));
    expect(reorder).toHaveBeenLastCalledWith(
      'ws_A',
      'tsk_3',
      { position: 'to', index: 1 },
      3,
      expect.anything(),
    );
  });
});

describe('save states and inline edits (D10, D13)', () => {
  it('announces each save state with its field', () => {
    const { rerender } = render(<SaveStatus state="saving" label="Title" />);
    expect(screen.getByRole('status').textContent).toBe('Title: Saving…');
    rerender(<SaveStatus state="offline" label="Title" />);
    expect(screen.getByRole('status').textContent).toMatch(/offline/);
    rerender(<SaveStatus state="conflict" label="Title" />);
    expect(screen.getByRole('status').textContent).toMatch(/someone else/);
  });

  it('a conflict offers Keep mine, Use latest, and Cancel; Keep mine resends over the latest', async () => {
    const conflict = new ApiError({
      code: 'conflict',
      status: 409,
      message: 'Conflict',
      conflict: {
        current_version: 5,
        fields: [{ field: 'title', yours: 'Mine', theirs: 'Theirs', theirs_readable: true }],
      },
    });
    const saved = { id: 'tsk_1', title: 'Mine', version: 6, undo: null } as unknown as Task;
    const update = vi
      .spyOn(tasks, 'update')
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(saved);
    const onSaved = vi.fn();
    wrap(
      <InlineEditor
        ws="ws_A"
        taskId="tsk_1"
        version={4}
        field="title"
        value="Old"
        label="Title"
        onSaved={onSaved}
      />,
    );
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Mine' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save title' })));
    expect(update).toHaveBeenLastCalledWith(
      'ws_A',
      'tsk_1',
      4,
      { title: { base: 'Old', value: 'Mine' } },
      expect.anything(),
    );
    expect(screen.getByText(/Theirs: Theirs/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use latest' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Keep mine' })));
    expect(update).toHaveBeenLastCalledWith(
      'ws_A',
      'tsk_1',
      5,
      { title: { base: 'Theirs', value: 'Mine' } },
      expect.anything(),
    );
    expect(onSaved).toHaveBeenCalledWith(saved, 'Title saved.');
  });

  it('a failed save reverts visibly to the last saved value', async () => {
    vi.spyOn(tasks, 'update').mockRejectedValue(
      new ApiError({ code: 'network', status: 0, message: 'Network error.' }),
    );
    wrap(
      <InlineEditor
        ws="ws_A"
        taskId="tsk_1"
        version={1}
        field="title"
        value="Old"
        label="Title"
        onSaved={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save title' })));
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Old');
    expect(screen.getByRole('status').textContent).toMatch(/offline — not saved/);
  });
});

describe('undo toast (D11)', () => {
  it('counts down, undoes once, and explains an expired or conflicting undo', async () => {
    const undo = vi
      .spyOn(tasks, 'undo')
      .mockResolvedValueOnce({ id: 'und_1', state: 'applied', tasks: ['tsk_1'] });
    const done = vi.fn();
    const handle = { id: 'und_1', expires_at: new Date(Date.now() + 30_000).toISOString() };
    const { unmount } = wrap(
      <UndoToast ws="ws_A" handle={handle} what="Title changed" onDone={done} />,
    );
    const region = screen.getByRole('region', { name: 'Undo' });
    expect(region.textContent).toMatch(/Title changed\. Undo 30 s/);
    await act(async () => fireEvent.click(within(region).getByRole('button', { name: 'Undo' })));
    expect(undo).toHaveBeenCalledWith('ws_A', 'und_1', expect.anything());
    expect(done).toHaveBeenCalledWith('Undone: Title changed.');
    unmount();
    vi.spyOn(tasks, 'undo').mockRejectedValueOnce(
      new ApiError({
        code: 'conflict',
        status: 409,
        message: 'x',
        issues: [{ pointer: '/', code: 'stale', message: 'x' }],
      }),
    );
    wrap(<UndoToast ws="ws_A" handle={{ ...handle, id: 'und_2' }} what="Moved" onDone={done} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Undo' })));
    expect(screen.getByRole('alert').textContent).toMatch(/can no longer be undone/);
  });

  it('shows nothing once the window has passed', () => {
    wrap(
      <UndoToast
        ws="ws_A"
        handle={{ id: 'und_3', expires_at: new Date(Date.now() - 1000).toISOString() }}
        what="Old"
        onDone={() => undefined}
      />,
    );
    expect(screen.queryByRole('region', { name: 'Undo' })).toBeNull();
  });
});

describe('signals and duplicates (D6, D7)', () => {
  it('renders only the signals that are on (null means not applicable)', () => {
    render(
      <SignalBadges
        signals={{
          stale: true,
          blocked: null,
          repeatedly_rescheduled: false,
          missing_owner: null,
          missing_date: true,
          missing_criteria: false,
          missing_dependency: null,
        }}
      />,
    );
    const list = screen.getByRole('list', { name: 'Signals' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((n) => n.textContent),
    ).toEqual(['Stale', 'No date']);
  });

  it('suggests possible duplicates after typing, aborting superseded requests', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.spyOn(tasks, 'duplicates').mockImplementation(async (_ws, _q, signal) => {
      signals.push(signal!);
      return [{ id: 'tsk_9', title: 'Renew certificate', status, created_at: '' }];
    });
    const { rerender } = wrap(<DuplicateHint ws="ws_A" brand="br_A" title="Ren" />);
    await act(async () => vi.advanceTimersByTime(400));
    rerender(
      <Router>
        <StepUpProvider>
          <DuplicateHint ws="ws_A" brand="br_A" title="Renew cert" />
        </StepUpProvider>
      </Router>,
    );
    await act(async () => vi.advanceTimersByTime(400));
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(screen.getByRole('link', { name: 'Renew certificate' })).toBeTruthy();
    expect(screen.getByText(/you can still add this task/)).toBeTruthy();
  });
});

describe('bulk bar (D8)', () => {
  const op = (over: Partial<BulkOp>): BulkOp => ({
    id: 'bop_1',
    type: 'bulk_operation',
    operation: 'archive',
    mode: 'atomic',
    destructive: true,
    state: 'previewed',
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    executed_at: null,
    items: [
      { task: 'tsk_1', outcome: 'ready' },
      { task: 'tsk_2', outcome: 'forbidden' },
    ],
    counts: { ready: 1, forbidden: 1 },
    version: 0,
    ...over,
  });

  it('previews every item, applies once, reports per item; destructive actions default to all-or-nothing', async () => {
    const preview = vi.spyOn(tasks, 'previewBulk').mockResolvedValue(op({}));
    vi.spyOn(tasks, 'executeBulk').mockResolvedValue(
      op({
        state: 'executed',
        items: [
          { task: 'tsk_1', outcome: 'applied' },
          { task: 'tsk_2', outcome: 'forbidden' },
        ],
        counts: { applied: 1, forbidden: 1 },
      }),
    );
    const applied = vi.fn();
    wrap(
      <BulkBar
        ws="ws_A"
        choices={[
          { id: 'tsk_1', title: 'Alpha' },
          { id: 'tsk_2', title: 'Bravo' },
        ]}
        labels={[]}
        onApplied={applied}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select all shown' }));
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'archive' } });
    expect(screen.getByLabelText(/Change only the tasks that can be changed/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Preview change' })));
    expect(preview).toHaveBeenCalledWith(
      'ws_A',
      { operation: 'archive', tasks: ['tsk_1', 'tsk_2'], mode: 'atomic' },
      expect.anything(),
    );
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('All of these change, or none do.')).toBeTruthy();
    expect(
      within(dialog)
        .getAllByRole('row')
        .map((r) => r.textContent),
    ).toEqual(['TaskResult', 'AlphaWill change', "BravoYou can't change this one"]);
    await act(async () =>
      fireEvent.click(within(dialog).getByRole('button', { name: 'Apply to 1 task' })),
    );
    expect(applied).toHaveBeenCalledWith('Archive: 1 of 2 changed.', null);
    expect(screen.getByText("Bravo: You can't change this one")).toBeTruthy();
  });
});

describe('bulk status (review 01): the selection’s statuses, custom ones included', () => {
  it('lists each workflow’s statuses with how many tasks offer them and shows the proposed target per task', async () => {
    const opts = vi.spyOn(tasks, 'bulkStatusOptions').mockResolvedValue({
      tasks: 2,
      editable: 2,
      mixed_workflows: true,
      options: [
        {
          status: { key: 'todo', name: 'To do', category: 'planned' },
          available_for: 2,
          all: true,
        },
        {
          status: { key: 'sts_X', name: 'Polishing', category: 'active', custom: true } as never,
          available_for: 1,
          all: false,
        },
      ],
    });
    const preview = vi.spyOn(tasks, 'previewBulk').mockResolvedValue({
      id: 'bop_2',
      type: 'bulk_operation',
      operation: 'set_status',
      mode: 'partial',
      destructive: false,
      state: 'previewed',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      executed_at: null,
      items: [
        {
          task: 'tsk_1',
          outcome: 'ready',
          target: { key: 'sts_X', name: 'Polishing', category: 'active' } as never,
        },
        { task: 'tsk_2', outcome: 'invalid', code: 'status_unavailable' },
      ],
      counts: { ready: 1, invalid: 1 },
      version: 0,
    });
    wrap(
      <BulkBar
        ws="ws_A"
        choices={[
          { id: 'tsk_1', title: 'Alpha' },
          { id: 'tsk_2', title: 'Bravo' },
        ]}
        labels={[]}
        onApplied={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select all shown' }));
    await act(async () =>
      fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'set_status' } }),
    );
    expect(opts).toHaveBeenCalledWith('ws_A', ['tsk_1', 'tsk_2'], expect.anything());
    const select = screen.getByLabelText('Status') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'To do',
      'Polishing (custom) — only 1 of 2 tasks',
    ]);
    expect(screen.getByText(/use different workflows/)).toBeTruthy();
    fireEvent.change(select, { target: { value: 'sts_X' } });
    expect(screen.getByText(/Only 1 of 2 selected tasks offer/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Preview change' })));
    expect(preview).toHaveBeenCalledWith(
      'ws_A',
      { operation: 'set_status', params: { value: 'sts_X' }, tasks: ['tsk_1', 'tsk_2'] },
      expect.anything(),
    );
    const rows = within(screen.getByRole('dialog'))
      .getAllByRole('row')
      .map((r) => r.textContent);
    expect(rows).toEqual([
      'TaskProposed statusResult',
      'AlphaPolishingWill change',
      "Bravo—Can't be changed this way: Its workflow doesn’t offer this status",
    ]);
  });
});

describe('background refresh keeps the page (REL-001)', () => {
  it('a failed reload keeps the loaded data; a first load still fails visibly', async () => {
    const { useResource } = await import('../src/tenancy/resource.tsx');
    let fail = false;
    const load = vi.fn(async () => {
      if (fail) throw new ApiError({ code: 'offline', status: 0, message: "You're offline." });
      return 'loaded';
    });
    let api: ReturnType<typeof useResource<string>> | null = null;
    function Probe() {
      api = useResource(load, 'k');
      return <p>{api.state.status}</p>;
    }
    render(<Probe />);
    await act(async () => undefined);
    expect(screen.getByText('ready')).toBeTruthy();
    fail = true;
    await act(async () => api!.reload());
    expect(screen.getByText('ready')).toBeTruthy();
    await act(async () => api!.retry());
    expect(screen.getByText('failed')).toBeTruthy();
  });
});
