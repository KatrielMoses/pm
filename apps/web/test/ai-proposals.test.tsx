import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProposalPage, ProposalsPage } from '../src/ai/proposals-page.tsx';
import { Router } from '../src/router.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

const WS = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PRP = 'prp_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TSK = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const NEW = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const FP = 'f'.repeat(64);

const change = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  op: 'task.create',
  selected: true,
  decision: 'pending',
  depends_on: [],
  temp_ref: null,
  target: null,
  project: null,
  parent: null,
  brand: null,
  relation: null,
  fields: [{ field: 'title', before: null, after: `Title ${key}` }],
  sources: ['S1'],
  applied_state: 'not_applied',
  result: null,
  failure: null,
  ...over,
});

const proposal = (over: Record<string, unknown> = {}) => ({
  id: PRP,
  type: 'change_proposal',
  state: 'open',
  revision: 1,
  version: 1,
  created_at: '2026-10-17T10:00:00Z',
  updated_at: '2026-10-17T10:00:00Z',
  run: 'op_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  synthetic: true,
  application: null,
  content: { state: 'present', note: null },
  title: 'Plan the follow-up',
  fingerprint: FP,
  trust_note: 'This proposal is AI-generated. Nothing changes until you apply it.',
  changes: [
    change('c1', { temp_ref: 'draft' }),
    change('c2', { depends_on: ['c1'], parent: { new: 'draft', change: 'c1' } }),
    change('c3', {
      op: 'task.update',
      target: { type: 'task', id: TSK, title: 'Launch checklist', version: 4, out_of_date: false },
      fields: [{ field: 'priority', before: 'none', after: 'urgent' }],
    }),
  ],
  order: ['c1', 'c2', 'c3'],
  selection_issues: [],
  approval: null,
  history: [
    { kind: 'generated', revision: 1, changes: ['c1', 'c2', 'c3'], at: '2026-10-17T10:00:00Z' },
  ],
  can: { edit: true, approve: true, apply: false, reject: true },
  ...over,
});

function serve(
  routes: Record<string, (body: any, init?: RequestInit) => Response | Promise<Response>>,
) {
  const calls: Array<{ method: string; path: string; body: any; key: string | null }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const headers = new Headers(init?.headers);
      calls.push({ method, path, body, key: headers.get('idempotency-key') });
      for (const [k, fn] of Object.entries(routes)) {
        const [m, suffix] = k.split(' ') as [string, string];
        if (m === method && path.endsWith(suffix)) return fn(body, init);
      }
      return json(404, { error: { code: 'not_found', status: 404, message: 'Not found' } });
    }),
  );
  return calls;
}
const page = () =>
  render(
    <Router>
      <ProposalPage ws={WS} id={PRP} />
    </Router>,
  );

describe('Change proposal review (7D)', () => {
  it('shows the trust note, the diff, dependency feedback, and keeps unsaved edits across a reload', async () => {
    serve({ [`GET /ai/proposals/${PRP}`]: () => json(200, { data: proposal() }) });
    const first = page();
    expect(
      await screen.findByText(/AI-generated. Nothing changes until you apply it/),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Changes \(3 of 3 selected\)/ })).toBeTruthy();
    const row = screen.getByRole('row', { name: /Priority/ });
    expect(row.textContent).toContain('none');
    // Deselecting a dependency shows which change needs it and blocks approval.
    await act(async () => fireEvent.click(screen.getByLabelText(/c1 · Create task/)));
    expect(screen.getByText(/Change c2 needs change c1/)).toBeTruthy();
    // An edit of a proposed value is a pending edit; approval waits for a saved revision.
    fireEvent.change(screen.getByLabelText('Priority (proposed)'), { target: { value: 'high' } });
    expect(screen.getByRole('button', { name: 'Save edits' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    // A refresh does not silently discard the edits.
    first.unmount();
    page();
    expect(await screen.findByRole('button', { name: 'Save edits' })).toBeTruthy();
    expect((screen.getByLabelText('Priority (proposed)') as HTMLSelectElement).value).toBe('high');
  });

  it('saves edits as a new revision, approves exactly what was reviewed, and applies once with an explicit action', async () => {
    let state = proposal();
    const calls = serve({
      [`GET /ai/proposals/${PRP}`]: () => json(200, { data: state }),
      [`PATCH /ai/proposals/${PRP}`]: () => {
        state = proposal({ revision: 2, fingerprint: 'e'.repeat(64) });
        return json(200, { data: state });
      },
      [`POST /ai/proposals/${PRP}:approve`]: () => {
        state = proposal({
          revision: 2,
          fingerprint: 'e'.repeat(64),
          state: 'approved',
          approval: {
            revision: 2,
            selected: ['c1', 'c2', 'c3'],
            expires_at: '2026-10-18T10:00:00Z',
            valid: true,
          },
          can: { edit: true, approve: true, apply: true, reject: true },
        });
        return json(200, { data: state });
      },
      [`POST /ai/proposals/${PRP}:apply`]: async () => {
        state = proposal({
          revision: 2,
          state: 'applied',
          application: {
            outcome: 'applied',
            applied_count: 3,
            failed_count: 0,
            revision: 2,
            operation: 'op_x',
            at: '2026-10-17T10:05:00Z',
          },
          changes: proposal().changes.map((c) => ({
            ...c,
            applied_state: 'applied',
            result: c.key === 'c1' ? { type: 'task', id: NEW, title: 'Title c1' } : null,
          })),
          can: { edit: false, approve: false, apply: false, reject: false },
        });
        return json(200, { data: state });
      },
    });
    page();
    fireEvent.change(await screen.findByLabelText('Priority (proposed)'), {
      target: { value: 'high' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save edits' })));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual({ revision: 1, changes: { c3: { fields: { priority: 'high' } } } });
    expect(patch.key).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Approve 3 change(s)' })),
    );
    expect(calls.find((c) => c.path.endsWith(':approve'))!.body).toEqual({
      revision: 2,
      fingerprint: 'e'.repeat(64),
    });
    const apply = screen.getByRole('button', { name: 'Apply 3 of 3 changes' });
    // Repeated clicks send one request.
    await act(async () => {
      fireEvent.click(apply);
      fireEvent.click(apply);
    });
    expect(calls.filter((c) => c.path.endsWith(':apply'))).toHaveLength(1);
    expect(await screen.findByText('Applied 3 change(s)')).toBeTruthy();
    expect(screen.getByText(/Applied by you · proposed by AI/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Title c1' }).getAttribute('href')).toBe(
      `/workspaces/${WS}/tasks/${NEW}`,
    );
  });

  it('reports a failed Apply truthfully: the failed change, rolled-back and not-attempted changes, nothing kept', async () => {
    serve({
      [`GET /ai/proposals/${PRP}`]: () =>
        json(200, {
          data: proposal({
            state: 'failed',
            application: {
              outcome: 'failed',
              applied_count: 0,
              failed_count: 1,
              revision: 1,
              operation: 'op_x',
              at: '2026-10-17T10:05:00Z',
            },
            changes: [
              change('c1', { applied_state: 'rolled_back' }),
              change('c2', {
                applied_state: 'blocked',
                failure: {
                  code: 'not_attempted',
                  message: 'Not attempted because an earlier change failed.',
                },
              }),
              change('c3', {
                op: 'task.update',
                applied_state: 'failed',
                target: {
                  type: 'task',
                  id: TSK,
                  title: 'Launch checklist',
                  version: 5,
                  out_of_date: true,
                },
                fields: [{ field: 'priority', before: 'none', after: 'urgent' }],
                failure: {
                  code: 'target_changed',
                  message: 'The record changed since the proposal was made.',
                },
              }),
            ],
          }),
        }),
    });
    page();
    expect(await screen.findByText('Nothing was applied')).toBeTruthy();
    expect(screen.getByText(/Rolled back \(not kept\)/)).toBeTruthy();
    expect(screen.getAllByText(/Not attempted/).length).toBeGreaterThan(0);
    expect(screen.getByText(/The record changed since the proposal was made/)).toBeTruthy();
    expect(
      screen.getByText(/changed since the proposal was made; review the current value/),
    ).toBeTruthy();
  });

  it('a stale revision keeps the edits and offers reload or discard; offline Apply is safe to retry with the same key', async () => {
    let fails = 1;
    const calls = serve({
      [`GET /ai/proposals/${PRP}`]: () =>
        json(200, {
          data: proposal({
            state: 'approved',
            approval: {
              revision: 1,
              selected: ['c1', 'c2', 'c3'],
              expires_at: '2026-10-18T10:00:00Z',
              valid: true,
            },
            can: { edit: true, approve: true, apply: true, reject: true },
          }),
        }),
      [`PATCH /ai/proposals/${PRP}`]: () =>
        json(409, {
          error: {
            code: 'conflict',
            status: 409,
            message: 'Conflict',
            issues: [
              {
                pointer: '/revision',
                code: 'revision_changed',
                message: 'The proposal changed since you opened it.',
              },
            ],
          },
        }),
      [`POST /ai/proposals/${PRP}:apply`]: () => {
        if (fails-- > 0) throw new TypeError('Failed to fetch');
        return json(200, {
          data: proposal({
            state: 'applied',
            can: { edit: false, approve: false, apply: false, reject: false },
          }),
        });
      },
    });
    page();
    const apply = await screen.findByRole('button', { name: 'Apply 3 of 3 changes' });
    await act(async () => fireEvent.click(apply));
    expect(await screen.findByText(/safe and never applies twice/)).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Apply 3 of 3 changes' })),
    );
    const applies = calls.filter((c) => c.path.endsWith(':apply'));
    expect(applies).toHaveLength(2);
    expect(applies[0]!.key).toBe(applies[1]!.key);
    cleanup();
    page();
    fireEvent.change(
      await screen.findByLabelText('Title (proposed)', { selector: '#prp-c1-title' }),
      {
        target: { value: 'Mine' },
      },
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save edits' })));
    expect(await screen.findByText('The proposal changed since you started editing')).toBeTruthy();
    expect((screen.getByDisplayValue('Mine') as HTMLInputElement).value).toBe('Mine');
    expect(screen.getByRole('button', { name: 'Discard my edits' })).toBeTruthy();
  });

  it('withheld and erased proposals show no content; the list labels them and has an empty state', async () => {
    serve({
      [`GET /ai/proposals/${PRP}`]: () =>
        json(200, {
          data: proposal({
            content: {
              state: 'withheld',
              note: 'A source used by this proposal is no longer available to you.',
            },
            title: null,
            changes: [],
            history: [],
          }),
        }),
      'GET /ai/proposals': () =>
        json(200, {
          data: {
            type: 'ai_proposals',
            items: [
              {
                id: PRP,
                state: 'applied',
                revision: 1,
                created_at: '2026-10-17T10:00:00Z',
                run: 'op',
                synthetic: true,
                content: { state: 'erased', note: null },
                title: null,
                application: null,
              },
            ],
          },
        }),
    });
    page();
    expect(await screen.findByText('Content withheld')).toBeTruthy();
    expect(screen.queryByText('Plan the follow-up')).toBeNull();
    cleanup();
    render(
      <Router>
        <ProposalsPage ws={WS} />
      </Router>,
    );
    expect(await screen.findByRole('link', { name: 'Erased proposal' })).toBeTruthy();
  });

  it('names every operation a plan can hold, with the label and the people an assignment names (Phase 7 integration)', async () => {
    const forTask = { new: 'draft', change: 'c1' };
    serve({
      [`GET /ai/proposals/${PRP}`]: () =>
        json(200, {
          data: proposal({
            changes: [
              change('c1', { temp_ref: 'draft' }),
              change('c2', {
                op: 'criterion.add',
                depends_on: ['c1'],
                task: forTask,
                fields: [
                  { field: 'text', before: null, after: 'Beta invite sent' },
                  { field: 'kind', before: null, after: 'checklist' },
                ],
              }),
              change('c3', {
                op: 'task.assign',
                depends_on: ['c1'],
                task: forTask,
                assignees: [{ id: 'mem_1', name: 'Riley Member' }, { available: false }],
                fields: [],
              }),
              change('c4', {
                op: 'label.add',
                depends_on: ['c1'],
                task: forTask,
                label: { id: 'lbl_1', name: 'Launch' },
                fields: [],
              }),
            ],
            order: ['c1', 'c2', 'c3', 'c4'],
          }),
        }),
    });
    page();
    expect(await screen.findByLabelText(/c2 · Add acceptance criterion/)).toBeTruthy();
    expect(screen.getByLabelText(/c3 · Assign task/)).toBeTruthy();
    expect(screen.getByLabelText(/c4 · Add label/)).toBeTruthy();
    expect(screen.getByText(/Assign to: Riley Member, a person who left\./)).toBeTruthy();
    expect(screen.getByText(/Label: Launch\./)).toBeTruthy();
  });
});
