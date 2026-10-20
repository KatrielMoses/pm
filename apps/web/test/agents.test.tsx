import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AgentPage, AgentsPage, TaskAgentSection } from '../src/agents/pages.tsx';
import { Router } from '../src/router.tsx';
import { StepUpProvider } from '../src/stepup.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

const WS = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const AGT = 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TSK = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OP = 'op_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const BR = 'br_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MEM = 'mem_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const EXECUTION = { available: false, owner: '8C', note: 'Nothing has been sent to an agent.' };

const profile = (over: Record<string, unknown> = {}) => ({
  id: AGT,
  type: 'agent_profile',
  name: 'Docs agent',
  purpose: 'Drafts documentation.',
  kind: 'external',
  state: 'draft',
  suspended_reason: null,
  owner: { id: MEM, name: 'Ada', active: true },
  template: 'documentation',
  readiness: {
    state: 'not_ready',
    reasons: ['not_activated', 'connector_missing'],
    synthetic: false,
  },
  execution: EXECUTION,
  capabilities: { configure: true, assign: false },
  created_at: '2026-10-20T00:00:00Z',
  updated_at: '2026-10-20T00:00:00Z',
  version: 2,
  draft: {
    schema_version: 1,
    kind: 'external',
    instructions: 'Write drafts only.',
    model_key: null,
    limits: { max_runtime_minutes: 30, max_tool_calls: 50, max_artifacts: 5 },
    tools: [
      { name: 'pm.tasks.get', version: '1' },
      { name: 'pm.documents.draft', version: '1' },
    ],
    scope: { brands: [], projects: [], records: [], integrations: [] },
    approval_policy: { draft_content: 'review_required' },
  },
  draft_status: {
    valid: true,
    issues: [],
    unavailable: [],
    missing: ['scope', 'connector'],
    matches_active: false,
  },
  active_revision: null,
  connector: null,
  ...over,
});
const TOOLS = {
  data: {
    type: 'agent_tools',
    data: [
      {
        name: 'pm.tasks.get',
        version: '1',
        tool_class: 'read_records',
        status: 'available',
        owner: null,
        description: 'Read a task',
        risk: 'R0',
        minimum_approval: 'none',
      },
      {
        name: 'pm.documents.draft',
        version: '1',
        tool_class: 'draft_content',
        status: 'available',
        owner: null,
        description: 'Draft a document',
        risk: 'R0',
        minimum_approval: 'low_impact_policy',
      },
      {
        name: 'pm.tasks.update',
        version: '1',
        tool_class: 'update_records',
        status: 'available',
        owner: null,
        description: 'Update a task',
        risk: 'R1',
        minimum_approval: 'review_required',
      },
      {
        name: 'pm.tests.run',
        version: '1',
        tool_class: 'run_tests',
        status: 'unavailable',
        owner: '9B',
        description: 'Run tests',
        risk: 'R1',
        minimum_approval: 'low_impact_policy',
      },
    ],
    models: [
      {
        key: 'fixture/synthetic-messages@2026-10-17',
        label: 'Synthetic test model',
        synthetic: true,
      },
    ],
  },
};

function serve(routes: Record<string, (body: any) => Response | Promise<Response>>) {
  const calls: Array<{
    method: string;
    path: string;
    body: any;
    key: string | null;
    ifMatch: string | null;
  }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const headers = new Headers(init?.headers);
      calls.push({
        method,
        path,
        body,
        key: headers.get('idempotency-key'),
        ifMatch: headers.get('if-match'),
      });
      for (const [k, fn] of Object.entries(routes)) {
        const [m, suffix] = k.split(' ') as [string, string];
        if (m === method && path.split('?')[0]!.endsWith(suffix)) return fn(body);
      }
      if (method === 'GET') return json(200, { data: [] });
      return json(404, { error: { code: 'not_found', status: 404, message: 'Not found' } });
    }),
  );
  return calls;
}
const shell = (ui: ReactNode) =>
  render(
    <Router>
      <StepUpProvider>{ui}</StepUpProvider>
    </Router>,
  );

describe('Agents (8B)', () => {
  it('lists agents with state and readiness, offers the five starter templates, and creates from one', async () => {
    const calls = serve({
      'GET /agents': () =>
        json(200, { data: [profile({ state: 'active' })], capabilities: { create: true } }),
      'GET /agent-templates': () =>
        json(200, {
          data: {
            type: 'agent_templates',
            data: ['development', 'research', 'growth', 'documentation', 'testing'].map((k) => ({
              key: k,
              name: `${k[0]!.toUpperCase()}${k.slice(1)} agent`,
              purpose: `A ${k} agent.`,
              kind: k === 'research' ? 'internal' : 'external',
              needs: ['scope', 'connector'],
            })),
          },
        }),
      'POST /agents': () => json(201, { data: profile() }),
    });
    shell(<AgentsPage ws={WS} />);
    const list = await screen.findByRole('list', { name: 'Agents' });
    expect(within(list).getByRole('link', { name: 'Docs agent' })).toBeTruthy();
    expect(within(list).getByText('On')).toBeTruthy();
    expect(within(list).getByText(/not ready/)).toBeTruthy();
    await screen.findByRole('option', { name: 'Testing agent' });
    const start = screen.getByLabelText('Start from') as HTMLSelectElement;
    expect([...start.options].map((o) => o.value)).toEqual([
      '',
      'development',
      'research',
      'growth',
      'documentation',
      'testing',
    ]);
    fireEvent.change(screen.getByLabelText('Start from'), { target: { value: 'documentation' } });
    expect(screen.getByText(/Starts turned off with no scope/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create agent' })));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ template: 'documentation' });
    expect(post.key).toMatch(/^web-/);
  });

  it('offers only registered tools and approvals no weaker than the floor, says an empty scope means nothing, and names what is missing', async () => {
    serve({
      [`GET /agents/${AGT}`]: () => json(200, { data: profile() }),
      'GET /agent-tools': () => json(200, TOOLS),
    });
    shell(<AgentPage ws={WS} id={AGT} />);
    await screen.findByLabelText('Instructions');
    const unavailable = (await screen.findByLabelText(/pm.tests.run/)) as HTMLInputElement;
    expect(unavailable.disabled).toBe(true);
    expect(screen.getByText(/not available yet: phase 9B/)).toBeTruthy();
    // Draft content has a low-impact floor: "No approval" cannot be chosen.
    const approval = screen.getByLabelText('Draft content') as HTMLSelectElement;
    expect(
      (within(approval).getByRole('option', { name: 'No approval' }) as HTMLOptionElement).disabled,
    ).toBe(true);
    expect(approval.value).toBe('review_required');
    expect(screen.getByText(/Nothing chosen means nothing/)).toBeTruthy();
    const missing = screen.getByRole('list', { name: 'Missing configuration' });
    expect(within(missing).getByText(/Choose at least one brand/)).toBeTruthy();
    expect(within(missing).getByText(/Configure and test a connection/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Turn on' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/Nothing runs yet/)).toBeTruthy();
    expect(screen.getByText(/Live agent connectors need an approved secret store/)).toBeTruthy();
  });

  it('saves with If-Match, keeps edits on this device through an offline save and a conflict', async () => {
    let fail: 'offline' | 'conflict' | null = 'conflict';
    const calls = serve({
      [`GET /agents/${AGT}`]: () => json(200, { data: profile() }),
      'GET /agent-tools': () => json(200, TOOLS),
      [`PATCH /agents/${AGT}`]: (body) =>
        fail === 'conflict'
          ? json(412, {
              error: {
                code: 'conflict',
                status: 412,
                message: 'Changed.',
                issues: [{ pointer: '/', code: 'version_mismatch', message: 'Changed.' }],
              },
            })
          : json(200, { data: profile({ draft: body.draft, version: 3 }) }),
    });
    const first = shell(<AgentPage ws={WS} id={AGT} />);
    fireEvent.change(await screen.findByLabelText('Instructions'), {
      target: { value: 'Draft release notes.' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.ifMatch).toBe('"2"');
    expect(patch.body.draft.instructions).toBe('Draft release notes.');
    expect(await screen.findByText(/This agent changed since you loaded it/)).toBeTruthy();
    expect((screen.getByLabelText('Instructions') as HTMLTextAreaElement).value).toBe(
      'Draft release notes.',
    );
    first.unmount();
    shell(<AgentPage ws={WS} id={AGT} />);
    expect(((await screen.findByLabelText('Instructions')) as HTMLTextAreaElement).value).toBe(
      'Draft release notes.',
    );
    expect(screen.getByText('Unsaved edits restored')).toBeTruthy();
    fail = 'offline';
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(
      await screen.findAllByText(/You are offline. Your edits are kept on this device/),
    ).not.toHaveLength(0);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('a person who cannot configure sees status and readiness only, never the configuration', async () => {
    const {
      draft: _d,
      draft_status: _s,
      connector: _c,
      ...summary
    } = profile({
      capabilities: { configure: false, assign: true },
      state: 'active',
    });
    serve({
      [`GET /agents/${AGT}`]: () => json(200, { data: summary }),
      'GET /agent-tools': () => json(200, TOOLS),
    });
    shell(<AgentPage ws={WS} id={AGT} />);
    await screen.findByRole('heading', { name: 'Status' });
    expect(screen.queryByLabelText('Instructions')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Connection' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull();
  });

  it('shows a webhook signing secret once, tests only after confirmation, and labels the result synthetic', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const connector = {
      kind: 'webhook',
      endpoint_url: 'http://127.0.0.1:4100/peer/ok',
      state: 'configured',
      config_version: 1,
      secret_set: true,
      verified: false,
      synthetic: false,
      verified_at: null,
      capabilities: null,
      last_code: null,
      last_tested_at: null,
      transport: 'synthetic_fixture',
      production_note:
        'Live agent connectors need an approved secret store and credentials (DQ-28).',
    };
    const test = (state: string) => ({
      data: {
        type: 'agent_connector_test',
        test: {
          id: OP,
          type: 'agent_connector_test',
          state,
          code: null,
          synthetic: state === 'passed',
          config_version: 1,
          current: true,
          duration_ms: state === 'passed' ? 12 : null,
          created_at: '2026-10-20T00:00:00Z',
          ended_at: null,
          note: 'A passed test proves protocol compatibility only.',
        },
      },
    });
    let configured = false;
    const calls = serve({
      [`GET /agents/${AGT}`]: () => json(200, { data: profile(configured ? { connector } : {}) }),
      'GET /agent-tools': () => json(200, TOOLS),
      [`POST /agents/${AGT}/connector`]: () => {
        configured = true;
        return json(200, { data: profile({ connector, signing_secret: 'whs_synthetic_secret' }) });
      },
      [`POST /agents/${AGT}/connector:test`]: () => json(202, test('queued')),
      [`GET /agents/${AGT}/connector-tests/${OP}`]: () => json(200, test('passed')),
    });
    shell(<AgentPage ws={WS} id={AGT} />);
    fireEvent.change(await screen.findByLabelText('Connection type'), {
      target: { value: 'webhook' },
    });
    expect(screen.queryByLabelText(/Shared secret/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Endpoint URL'), {
      target: { value: 'http://127.0.0.1:4100/peer/ok' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save connection' })));
    expect(await screen.findByText('whs_synthetic_secret')).toBeTruthy();
    expect(calls.find((c) => c.path.endsWith('/connector'))!.body).toEqual({
      kind: 'webhook',
      endpoint_url: 'http://127.0.0.1:4100/peer/ok',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(calls.some((c) => c.path.endsWith(':test'))).toBe(false);
    const dialog = await screen.findByRole('dialog', { name: 'Test this connection?' });
    expect(within(dialog).getByText(/No task, record, or credential is sent/)).toBeTruthy();
    await act(async () =>
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send test' })),
    );
    expect(calls.find((c) => c.path.endsWith(':test'))!.body).toEqual({ confirm: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    const status = await screen.findByRole('status', { name: 'Connection test' });
    expect(within(status).getByText(/passed · synthetic \(local test agent\)/)).toBeTruthy();
  });
});

describe('Task Agent section (8B)', () => {
  const assignment = {
    id: `${TSK}:${AGT}`,
    type: 'agent_assignment',
    profile: { id: AGT, name: 'Docs agent', kind: 'external' },
    state: 'blocked',
    blocked_reasons: ['connector_not_verified'],
    revision: 1,
    goal: 'Write the launch notes.',
    constraints: null,
    deliverable: 'A draft document',
    criteria: ['Mentions the date'],
    context: [],
    scope: { items: [{ kind: 'brand', id: BR, name: 'Harbor' }], not_shown: 1 },
    assigned_by: { id: MEM, name: 'Ada' },
    assigned_at: '2026-10-20T00:00:00Z',
    withdrawn_at: null,
    execution: EXECUTION,
    version: 0,
  };
  const list = (items: unknown[], assign: boolean) =>
    json(200, {
      data: {
        type: 'agent_assignments',
        task: TSK,
        items,
        capabilities: { assign },
        execution: EXECUTION,
      },
    });

  it('a reader sees agents separately from people, with blocked reasons and only the scope they can open; no form', async () => {
    serve({ [`GET /tasks/${TSK}/agents`]: () => list([assignment], false) });
    shell(<TaskAgentSection ws={WS} task={TSK} />);
    const items = await screen.findByRole('list', { name: 'Assigned agents' });
    expect(within(items).getByText('Blocked')).toBeTruthy();
    expect(within(items).getByText(/has not passed a test for the current settings/)).toBeTruthy();
    expect(within(items).getByText('Harbor')).toBeTruthy();
    expect(within(items).getByText(/1 more item you cannot open/)).toBeTruthy();
    expect(screen.getByText(/separate from the people assigned/)).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Assign an agent' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });

  it('assigns only after a structured preview that names refusals, then withdraws after confirmation', async () => {
    let refused = true;
    let assigned = false;
    const calls = serve({
      [`GET /tasks/${TSK}/agents`]: () =>
        list(assigned ? [{ ...assignment, state: 'assigned', blocked_reasons: [] }] : [], true),
      'GET /agents': () =>
        json(200, {
          data: [profile({ state: 'active', capabilities: { configure: false, assign: true } })],
          capabilities: { create: false },
        }),
      [`POST /tasks/${TSK}/agent-preview`]: (body) =>
        json(200, {
          data: {
            type: 'agent_assignment_preview',
            profile: { id: AGT, name: 'Docs agent', kind: 'external' },
            goal: body.goal,
            constraints: null,
            deliverable: null,
            criteria: body.criteria,
            context: [],
            scope: {
              items: [{ kind: 'record', id: TSK, name: 'Write launch notes' }],
              not_shown: 0,
            },
            refusals: refused
              ? [
                  {
                    pointer: '/scope/brands/0',
                    code: 'outside_profile_scope',
                    message: 'This brand is outside the agent’s scope.',
                  },
                ]
              : [],
            can_save: !refused,
            readiness: { state: 'ready', reasons: [], synthetic: true },
            execution: EXECUTION,
          },
        }),
      [`POST /tasks/${TSK}/agents`]: () => {
        assigned = true;
        return json(201, { data: { type: 'agent_assignment', assignment } });
      },
      [`POST /tasks/${TSK}/agents/${AGT}:withdraw`]: () =>
        json(200, {
          data: { type: 'agent_assignment', assignment: { ...assignment, state: 'withdrawn' } },
        }),
    });
    shell(<TaskAgentSection ws={WS} task={TSK} />);
    await screen.findByRole('option', { name: 'Docs agent' });
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: AGT } });
    fireEvent.change(screen.getByLabelText('Goal'), {
      target: { value: 'Write the launch notes.' },
    });
    fireEvent.change(screen.getByLabelText(/Acceptance criteria/), {
      target: { value: 'Mentions the date\n\n' },
    });
    const assign = screen.getByRole('button', { name: 'Assign' }) as HTMLButtonElement;
    expect(assign.disabled).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Preview' })));
    const preview = await screen.findByRole('region', { name: 'Assignment preview' });
    expect(within(preview).getByText(/outside the agent’s scope/)).toBeTruthy();
    expect(within(preview).getByText(/Verified against a local test agent only/)).toBeTruthy();
    expect(assign.disabled).toBe(true);
    refused = false;
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Preview' })));
    await screen.findByText('Write launch notes');
    expect(assign.disabled).toBe(false);
    await act(async () => fireEvent.click(assign));
    const post = calls.find((c) => c.method === 'POST' && c.path.endsWith(`/tasks/${TSK}/agents`))!;
    expect(post.body).toEqual({
      profile: AGT,
      goal: 'Write the launch notes.',
      criteria: ['Mentions the date'],
    });
    expect(post.key).toMatch(/^web-/);
    const items = await screen.findByRole('list', { name: 'Assigned agents' });
    expect(within(items).getByText('Assigned')).toBeTruthy();
    expect(screen.getByText(/Nothing runs yet/)).toBeTruthy();
    fireEvent.click(within(items).getByRole('button', { name: 'Withdraw' }));
    expect(calls.some((c) => c.path.endsWith(':withdraw'))).toBe(false);
    const dialog = await screen.findByRole('alertdialog', { name: 'Withdraw Docs agent?' });
    await act(async () =>
      fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' })),
    );
    expect(calls.find((c) => c.path.endsWith(':withdraw'))!.key).toMatch(/^web-/);
    expect(calls.filter((c) => c.path.endsWith(':run'))).toHaveLength(0);
  });
});
