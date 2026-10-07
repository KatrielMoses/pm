import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planning } from '../src/planning/client.ts';
import { Router } from '../src/router.tsx';
import { StepUpProvider } from '../src/stepup.tsx';
import { CalendarLayout, type LayoutProps } from '../src/views/layouts.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Phase 3 integration (CAL-003): the 3B calendar schedules a task as a 3C work block without
 * dragging. The block starts at the chosen local time on the event's day, lasts the task's
 * estimate, and the task's dates are never written.
 */
describe('calendar scheduling (3B × 3C)', () => {
  it('schedules a task from its calendar day by keyboard, without changing its dates', async () => {
    const create = vi.spyOn(planning, 'createBlock').mockResolvedValue({} as never);
    const props = {
      ws: 'ws_A',
      entity: 'task',
      rows: [
        {
          id: 'tsk_A',
          type: 'task',
          title: 'Write copy',
          status: { key: 'todo', name: 'To do', category: 'todo' },
          priority: 'high',
          brand: { id: 'br_1', name: 'Harbor', short_name: null, color: 'blue', icon: 'Leaf' },
          version: 3,
          due_date: '2026-11-04',
          estimate_minutes: 90,
        },
      ],
      page: { data: [], page: { limit: 50, has_more: false } },
      presentation: { date_field: 'due_date' },
      query: { entity: 'task' },
      scope: [],
      catalog: {},
      onOpen: () => undefined,
      onChanged: () => undefined,
    } as unknown as LayoutProps;
    render(
      <Router>
        <StepUpProvider>
          <CalendarLayout
            {...props}
            anchor="2026-11-02"
            setAnchor={() => undefined}
            mode="agenda"
            setMode={() => undefined}
          />
        </StepUpProvider>
      </Router>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Schedule…\s*Write copy$/ }));
    const dialog = screen.getByRole('dialog', { name: 'Schedule “Write copy”' });
    expect((screen.getByLabelText(/^Day/) as HTMLInputElement).value).toBe('2026-11-04');
    expect((screen.getByLabelText(/^Minutes/) as HTMLInputElement).value).toBe('90');
    fireEvent.change(screen.getByLabelText(/^Start/), { target: { value: '10:30' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    });
    expect(dialog.isConnected).toBe(false);
    expect(create).toHaveBeenCalledWith(
      'ws_A',
      {
        task: 'tsk_A',
        starts_at: new Date('2026-11-04T10:30').toISOString(),
        duration_minutes: 90,
      },
      expect.anything(),
    );
    expect(
      screen.getByText(/Write copy scheduled on .* at 10:30\. Its dates did not change\./),
    ).toBeTruthy();
  });
});
