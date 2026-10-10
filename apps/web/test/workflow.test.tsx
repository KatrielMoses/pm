import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { Router } from '../src/router.tsx';
import { matchRoute } from '../src/shell/registry.ts';
import { StepUpProvider } from '../src/stepup.tsx';
import { fields as fieldsApi, transitions, type RecordFields } from '../src/workflow/client.ts';
import { RecordFieldsSection, TransitionControl } from '../src/workflow/record-workflow.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const wrap = (ui: React.ReactNode) =>
  render(
    <Router>
      <StepUpProvider>{ui}</StepUpProvider>
    </Router>,
  );
const field = (
  id: string,
  name: string,
  presentation: 'primary' | 'advanced',
  extra: Record<string, unknown> = {},
) => ({
  id,
  name,
  description: null,
  field_type: 'text' as const,
  result_type: null,
  presentation,
  required: false,
  config: {},
  options: [],
  value: null,
  error: null,
  read_only: false,
  archived: false,
  ...extra,
});
const RF: RecordFields = {
  record: { id: 'tsk_X', type: 'task' },
  version: 3,
  fields: [
    field('fld_A', 'Summary', 'primary'),
    field('fld_B', 'Root cause', 'advanced'),
    field('fld_C', 'Regression since', 'advanced'),
    field('fld_D', 'Cost estimate', 'primary', {
      field_type: 'formula',
      result_type: 'number',
      read_only: true,
      value: null,
      error: 'missing',
    }),
  ] as RecordFields['fields'],
  field_sets: [],
};

describe('workflow routes (0E Phase 2C note)', () => {
  it('administration and approvals are canonical routes', () => {
    expect(matchRoute('/workspaces/ws_A/settings/workflows')).toMatchObject({
      def: { id: 'workflows' },
    });
    expect(matchRoute('/workspaces/ws_A/settings/fields')).toMatchObject({ def: { id: 'fields' } });
    expect(matchRoute('/workspaces/ws_A/settings/field-sets')).toMatchObject({
      def: { id: 'field_sets' },
    });
    expect(matchRoute('/workspaces/ws_A/approvals')).toMatchObject({ def: { id: 'approvals' } });
  });
});

describe('custom fields on a record (WFL-013)', () => {
  it('advanced fields sit under "More fields", are searchable, and formulas are read-only with a typed state', async () => {
    vi.spyOn(fieldsApi, 'record').mockResolvedValue(RF);
    wrap(<RecordFieldsSection ws="ws_A" rec="tsk_X" />);
    await screen.findByRole('heading', { name: 'Custom fields' });
    expect(screen.getByLabelText('Summary')).toBeTruthy();
    expect(screen.queryByLabelText('Root cause')).toBeNull();
    expect(screen.getByText('Waiting for inputs')).toBeTruthy();
    const more = screen.getByRole('button', { name: 'More fields (2)' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Root cause')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Find a field'), { target: { value: 'regress' } });
    expect(screen.queryByLabelText('Root cause')).toBeNull();
    expect(screen.getByLabelText('Regression since')).toBeTruthy();
  });

  it('an error in an advanced field expands "More fields" and focuses it; only changed fields are sent with their base', async () => {
    vi.spyOn(fieldsApi, 'record').mockResolvedValue(RF);
    const save = vi.spyOn(fieldsApi, 'setValues').mockRejectedValue(
      new ApiError({
        status: 422,
        code: 'validation_failed',
        message: 'invalid',
        issues: [
          { pointer: '/changes/fld_B', code: 'too_long', message: 'Enter at most 5 characters.' },
        ],
      }),
    );
    wrap(<RecordFieldsSection ws="ws_A" rec="tsk_X" />);
    await screen.findByRole('heading', { name: 'Custom fields' });
    fireEvent.click(screen.getByRole('button', { name: 'More fields (2)' }));
    fireEvent.change(screen.getByLabelText('Root cause'), { target: { value: 'Too long text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fewer fields' }));
    expect(screen.queryByLabelText('Root cause')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save fields' }));
    });
    expect(save).toHaveBeenCalledWith(
      'ws_A',
      'tsk_X',
      3,
      { fld_B: { base: null, value: 'Too long text' } },
      expect.anything(),
    );
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    const input = screen.getByLabelText('Root cause');
    expect(document.activeElement).toBe(input);
    expect(screen.getByText('Enter at most 5 characters.')).toBeTruthy();
  });
});

describe('status changes (WFL-005–007)', () => {
  it('lists every offered status with what it needs, and requests approval when the change is gated', async () => {
    const st = (key: string, name: string, category: string) => ({ key, name, category }) as never;
    vi.spyOn(transitions, 'options').mockResolvedValue({
      workflow: { id: 'wf_A', name: 'Release' },
      current: st('sts_A', 'Open', 'planned'),
      options: [
        {
          status: st('sts_B', 'Shipped', 'done'),
          allowed: true,
          after_category: 'done',
          confirmation: 'none',
          approval: { policy: 'one_manager', required: true },
        } as never,
      ],
    });
    vi.spyOn(transitions, 'preview').mockResolvedValue({
      allowed: true,
      from: st('sts_A', 'Open', 'planned'),
      to: st('sts_B', 'Shipped', 'done'),
      before_category: 'planned',
      after_category: 'done',
      required_fields: [
        { pointer: '/changes/due_date', label: 'Due date', satisfied: true, overridable: false },
      ],
      confirmation: 'none',
      approval: { policy: 'one_manager', required: true },
      issues: [],
      preview_token: 't',
      record_version: 4,
      warnings: [],
      approval_requests: [],
    });
    const request = vi.spyOn(transitions, 'requestApproval').mockResolvedValue({} as never);
    wrap(<TransitionControl ws="ws_A" rec="tsk_X" version={4} onChanged={() => undefined} />);
    await screen.findByText('Release workflow', { exact: false });
    fireEvent.change(screen.getByLabelText('Change status to'), { target: { value: 'sts_B' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review change…' }));
    });
    expect(screen.getByRole('dialog', { name: 'Open → Shipped' })).toBeTruthy();
    expect(screen.getByText(/needs approval \(one manager\)/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Request approval' }));
    });
    expect(request).toHaveBeenCalledWith(
      'ws_A',
      'tsk_X',
      { to: 'sts_B', version: 4 },
      expect.anything(),
    );
  });
});
