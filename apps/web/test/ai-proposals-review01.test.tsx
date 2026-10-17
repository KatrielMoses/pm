import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProposalPage } from '../src/ai/proposals-page.tsx';
import { AuthProvider, useAuth } from '../src/auth.tsx';
import { Router } from '../src/router.tsx';
import { clearPersonalClientState } from '../src/shell/drafts.ts';

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
const MARKER = 'PRIVATE-MARKER-7D-R1';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const me = (id: string) => ({
  data: {
    id,
    email: `${id}@example.test`,
    display_name: id,
    email_verified: true,
    session: { id: 'ses', assurance: 'single_factor', auth_methods: ['password'] },
    mfa: { totp: false, recovery_codes_remaining: 0 },
  },
});
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
  fingerprint: 'f'.repeat(64),
  trust_note: 'This proposal is AI-generated.',
  changes: [
    change('c1'),
    change('c3', {
      op: 'task.update',
      target: { type: 'task', id: TSK, title: 'Launch checklist', version: 4, out_of_date: false },
      fields: [{ field: 'priority', before: 'none', after: 'urgent' }],
    }),
  ],
  order: ['c1', 'c3'],
  selection_issues: [],
  approval: null,
  history: [],
  can: { edit: true, approve: true, apply: false, reject: true, rebase: false },
  ...over,
});
const withheld = (state: 'withheld' | 'erased') =>
  proposal({
    content: { state, note: 'No content.' },
    title: null,
    fingerprint: null,
    changes: [],
    history: [],
    can: { edit: false, approve: false, apply: false, reject: false, rebase: false },
  });

type Route = (body: any, key: string | null) => Response | Promise<Response>;
function serve(routes: Record<string, Route>) {
  const calls: Array<{ method: string; path: string; body: any; key: string | null }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const key = new Headers(init?.headers).get('idempotency-key');
      calls.push({ method, path, body, key });
      for (const [k, fn] of Object.entries(routes)) {
        const [m, suffix] = k.split(' ') as [string, string];
        if (m === method && path.endsWith(suffix)) return fn(body, key);
      }
      return json(404, { error: { code: 'not_found', status: 404, message: 'Not found' } });
    }),
  );
  return calls;
}
const stored = () =>
  [...Array(localStorage.length).keys()]
    .map((i) => localStorage.key(i)!)
    .concat([...Array(sessionStorage.length).keys()].map((i) => sessionStorage.key(i)!))
    .filter((k) => (localStorage.getItem(k) ?? sessionStorage.getItem(k) ?? '').includes(MARKER));
const page = (auth = true) =>
  render(
    <Router>
      {auth ? (
        <AuthProvider>
          <ProposalPage ws={WS} id={PRP} />
        </AuthProvider>
      ) : (
        <ProposalPage ws={WS} id={PRP} />
      )}
    </Router>,
  );
const editTitle = async () => {
  fireEvent.change(await screen.findByLabelText('Title (proposed)'), {
    target: { value: MARKER },
  });
};

describe('7D corrective review 01: proposal drafts follow identity and content lifecycle (R1)', () => {
  it('scopes the draft to the account, workspace, and proposal; restores it after a refresh and after an offline load, never before an authoritative answer', async () => {
    let online = true;
    serve({
      'GET /v1/auth/me': () => json(200, me('acct_a')),
      [`GET /ai/proposals/${PRP}`]: () => {
        if (!online) throw new TypeError('Failed to fetch');
        return json(200, { data: proposal() });
      },
    });
    const first = page();
    await editTitle();
    expect(stored()).toEqual([
      `pm.draft.acct_a.ai-proposal.${WS.toLowerCase()}.${PRP.toLowerCase()}`,
    ]);
    first.unmount();
    page();
    expect(((await screen.findByLabelText('Title (proposed)')) as HTMLInputElement).value).toBe(
      MARKER,
    );
    cleanup();
    // Offline: the stored draft is kept but not shown until the server answers.
    online = false;
    page();
    expect(await screen.findByText('Something went wrong')).toBeTruthy();
    expect(document.body.textContent).not.toContain(MARKER);
    expect(stored()).toHaveLength(1);
    cleanup();
    online = true;
    page();
    expect(((await screen.findByLabelText('Title (proposed)')) as HTMLInputElement).value).toBe(
      MARKER,
    );
  });

  it('sign-out removes the draft, and another account in the same tab never sees it', async () => {
    serve({
      'GET /v1/auth/me': () => json(200, me('acct_a')),
      [`GET /ai/proposals/${PRP}`]: () => json(200, { data: proposal() }),
    });
    page();
    await editTitle();
    expect(stored()).toHaveLength(1);
    cleanup();
    // What explicit sign-out runs.
    clearPersonalClientState();
    expect(stored()).toEqual([]);
    // A legacy unscoped draft from before the correction is purged too.
    sessionStorage.setItem(`pm.ai.proposal.draft.${PRP}`, JSON.stringify({ title: MARKER }));
    clearPersonalClientState();
    expect(stored()).toEqual([]);
  });

  it('an observed session invalidation or account change removes proposal drafts and keeps unrelated drafts', async () => {
    let who: string | null = 'acct_a';
    serve({
      'GET /v1/auth/me': () =>
        who
          ? json(200, me(who))
          : json(401, { error: { code: 'unauthenticated', status: 401, message: 'Sign in.' } }),
      [`GET /ai/proposals/${PRP}`]: () => json(200, { data: proposal() }),
    });
    localStorage.setItem(
      'pm.draft.acct_a.comment.tsk_x',
      JSON.stringify({ savedAt: new Date().toISOString(), value: 'unrelated comment' }),
    );
    let refresh: (() => Promise<unknown>) | null = null;
    function Probe() {
      refresh = useAuth().refresh;
      return null;
    }
    render(
      <Router>
        <AuthProvider>
          <Probe />
          <ProposalPage ws={WS} id={PRP} />
        </AuthProvider>
      </Router>,
    );
    await editTitle();
    expect(stored()).toHaveLength(1);
    // The same tab now belongs to another account.
    who = 'acct_b';
    await act(async () => void (await refresh!()));
    expect(stored()).toEqual([]);
    expect(localStorage.getItem('pm.draft.acct_a.comment.tsk_x')).not.toBeNull();
    // A stale draft written again, then the session is invalidated.
    await editTitle();
    expect(stored()).toHaveLength(1);
    who = null;
    await act(async () => void (await refresh!()));
    expect(stored()).toEqual([]);
  });

  it.each([
    ['withheld (source access revoked)', () => json(200, { data: withheld('withheld') })],
    ['erased', () => json(200, { data: withheld('erased') })],
    [
      'not found',
      () => json(404, { error: { code: 'not_found', status: 404, message: 'Not found' } }),
    ],
  ])(
    'an authoritative %s answer discards the stored draft and never shows it',
    async (_label, answer) => {
      let first = true;
      serve({
        'GET /v1/auth/me': () => json(200, me('acct_a')),
        [`GET /ai/proposals/${PRP}`]: () => {
          if (first) {
            first = false;
            return json(200, { data: proposal() });
          }
          return answer();
        },
      });
      page();
      await editTitle();
      expect(stored()).toHaveLength(1);
      cleanup();
      page();
      expect(
        await screen.findByText(/Content withheld|Content erased|Proposal not found/),
      ).toBeTruthy();
      expect(document.body.textContent).not.toContain(MARKER);
      expect(stored()).toEqual([]);
    },
  );
});

describe('7D corrective review 01: conflict and expired-approval recovery (R2)', () => {
  it('in one mounted page: an expired approval is replaced by a deliberate new approval with a fresh key; an ambiguous retry reuses that key; Apply runs once', async () => {
    let state: any = proposal();
    let dropNextApprove = false;
    let applied = 0;
    const approvalKeys = new Set<string>();
    const calls = serve({
      [`GET /ai/proposals/${PRP}`]: () => json(200, { data: state }),
      [`POST /ai/proposals/${PRP}:approve`]: (_b, key) => {
        approvalKeys.add(key!);
        if (dropNextApprove) {
          dropNextApprove = false;
          // The server recorded the approval, but the response never arrives.
          state = proposal({
            state: 'approved',
            approval: { revision: 1, selected: ['c1', 'c3'], expires_at: 'x', valid: true },
            can: { edit: true, approve: true, apply: true, reject: true, rebase: false },
          });
          throw new TypeError('Failed to fetch');
        }
        state = proposal({
          state: 'approved',
          approval: { revision: 1, selected: ['c1', 'c3'], expires_at: 'x', valid: true },
          can: { edit: true, approve: true, apply: true, reject: true, rebase: false },
        });
        return json(200, { data: state });
      },
      [`POST /ai/proposals/${PRP}:apply`]: () => {
        if (state.approval?.expired) {
          state = proposal({
            state: 'approved',
            approval: { revision: 1, selected: ['c1', 'c3'], expires_at: 'x', valid: false },
            can: { edit: true, approve: true, apply: false, reject: true, rebase: false },
          });
          return json(409, {
            error: {
              code: 'conflict',
              status: 409,
              message: 'Conflict',
              issues: [
                { pointer: '/', code: 'approval_expired', message: 'The approval expired.' },
              ],
            },
          });
        }
        applied++;
        state = proposal({
          state: 'applied',
          application: {
            outcome: 'applied',
            applied_count: 2,
            failed_count: 0,
            revision: 1,
            operation: 'op_x',
            at: 'x',
          },
          can: { edit: false, approve: false, apply: false, reject: false, rebase: false },
        });
        return json(200, { data: state });
      },
    });
    page(false);
    {
      const button = await screen.findByRole('button', { name: 'Approve 2 change(s)' });
      await act(async () => fireEvent.click(button));
    }
    // The controlled clock passes the approval's expiry.
    state = { ...state, approval: { ...state.approval, expired: true } };
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Apply 2 of 2 changes' })),
    );
    expect(await screen.findByText(/The approval expired/)).toBeTruthy();
    // A deliberate new approval: its response is lost, then the same attempt is retried.
    dropNextApprove = true;
    {
      const button = await screen.findByRole('button', { name: 'Approve 2 change(s)' });
      await act(async () => fireEvent.click(button));
    }
    expect(await screen.findByText(/connection dropped/)).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Approve 2 change(s)' })),
    );
    const approves = calls.filter((c) => c.path.endsWith(':approve'));
    expect(approves).toHaveLength(3);
    expect(approves[1]!.key).not.toBe(approves[0]!.key);
    expect(approves[2]!.key).toBe(approves[1]!.key);
    expect(approvalKeys.size).toBe(2);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Apply 2 of 2 changes' })),
    );
    expect(await screen.findByText('Applied 2 change(s)')).toBeTruthy();
    expect(applied).toBe(1);
  });

  it('a changed target offers an explicit review of the current versions; the rebase sends exactly the reviewed versions and keeps unsaved edits', async () => {
    let state: any = proposal({
      state: 'failed',
      changes: [
        change('c1'),
        change('c3', {
          op: 'task.update',
          target: {
            type: 'task',
            id: TSK,
            title: 'Launch checklist',
            version: 6,
            out_of_date: true,
          },
          fields: [{ field: 'priority', before: 'low', after: 'urgent' }],
        }),
      ],
      can: { edit: true, approve: true, apply: false, reject: true, rebase: true },
    });
    const calls = serve({
      [`GET /ai/proposals/${PRP}`]: () => json(200, { data: state }),
      [`POST /ai/proposals/${PRP}:rebase`]: () => {
        state = proposal({ revision: 2 });
        return json(200, { data: state });
      },
    });
    page(false);
    const region = await screen.findByRole('region', {
      name: 'Some records changed since this proposal was made',
    });
    expect(region.textContent).toContain('c3');
    expect(screen.getByRole('row', { name: /Priority/ }).textContent).toContain('low');
    fireEvent.change(screen.getByLabelText('Title (proposed)', { selector: '#prp-c1-title' }), {
      target: { value: 'Kept edit' },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Use the current versions' })),
    );
    expect(calls.find((c) => c.path.endsWith(':rebase'))!.body).toEqual({
      revision: 1,
      reviewed: { c3: 6 },
    });
    expect(await screen.findByText(/Using the current versions as revision 2/)).toBeTruthy();
    expect((screen.getByDisplayValue('Kept edit') as HTMLInputElement).value).toBe('Kept edit');
    expect(screen.queryByText('The proposal changed since you started editing')).toBeNull();
  });
});
