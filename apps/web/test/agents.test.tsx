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
const TSK2 = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAW';
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
      // A member without health access: the health card stays out of the way.
      'GET /agent-health': () =>
        json(404, { error: { code: 'not_found', status: 404, message: 'Not found' } }),
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
    expect(screen.getByText(/Runs start from a task this agent is assigned to/)).toBeTruthy();
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
    blocked_reasons: ['agent_not_ready', 'assigner_authority'],
    revision: 1,
    goal: 'Write the launch notes.',
    constraints: null,
    deliverable: 'A draft document',
    criteria: ['Mentions the date'],
    context: [{ id: TSK2, name: 'Old context', usable: false }],
    scope: { items: [{ kind: 'brand', id: BR, name: 'Harbor' }] },
    effective_scope: { items: [] },
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

  it('a reader sees agents separately from people, with blocked reasons and only the scope they can open; no form (review 01: no hidden count; stored versus usable scope)', async () => {
    serve({ [`GET /tasks/${TSK}/agents`]: () => list([assignment], false) });
    shell(<TaskAgentSection ws={WS} task={TSK} />);
    const items = await screen.findByRole('list', { name: 'Assigned agents' });
    expect(within(items).getByText('Blocked')).toBeTruthy();
    expect(within(items).getByText('The agent is not ready.')).toBeTruthy();
    expect(within(items).getByText(/can no longer assign agents on this task/)).toBeTruthy();
    expect(within(items).getByText('Harbor')).toBeTruthy();
    expect(within(items).getByText(/Old context \(history only: no longer usable\)/)).toBeTruthy();
    expect(within(items).getByLabelText('Usable scope for Docs agent').textContent).toBe(
      'No items you can open.',
    );
    expect(items.textContent).not.toMatch(/more items?|cannot open\b|hidden/i);
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
      [`GET /tasks/${TSK}/agent-runs`]: () =>
        json(200, { data: { type: 'agent_runs', task: TSK, items: [] } }),
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
    // 8C: runs appear beside the assignment; this list says execution is unavailable, so none start.
    expect(await screen.findByRole('region', { name: 'Runs' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run Docs agent' })).toBeNull();
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

describe('Agent runs (8C)', () => {
  const RUN = 'op_01ARZ3NDEKTSV4RRFFQ69G5RUN';
  const LIVE = { available: true, owner: '8C', note: 'Start a run from the task.' };
  const assigned = {
    id: `${TSK}:${AGT}`,
    type: 'agent_assignment',
    profile: { id: AGT, name: 'Docs agent', kind: 'internal' },
    state: 'assigned',
    blocked_reasons: [],
    revision: 1,
    goal: 'Write the launch notes.',
    constraints: null,
    deliverable: null,
    criteria: [],
    context: [],
    scope: { items: [{ kind: 'brand', id: BR, name: 'Harbor' }] },
    effective_scope: { items: [{ kind: 'brand', id: BR, name: 'Harbor' }] },
    assigned_by: { id: MEM, name: 'Ada' },
    assigned_at: '2026-10-20T00:00:00Z',
    withdrawn_at: null,
    execution: LIVE,
    version: 0,
  };
  const assignments = () =>
    json(200, {
      data: {
        type: 'agent_assignments',
        task: TSK,
        items: [assigned],
        capabilities: { assign: true },
        execution: LIVE,
      },
    });
  const run = (over: Record<string, unknown> = {}) => ({
    id: RUN,
    task: { id: TSK },
    profile: { id: AGT, name: 'Docs agent', kind: 'external' },
    state: 'running',
    waiting: null,
    paused_by: null,
    review: null,
    attempt: 1,
    failure: null,
    waiting_reasons: [],
    result: null,
    limits: { max_tool_calls: 50 },
    usage: { tool_calls: 2, artifacts: 0, output_bytes: 0, deadline_at: '2026-10-21T01:00:00Z' },
    costs: { measured: null, reported: null },
    artifacts: [],
    tool_calls: [
      {
        sequence: 2,
        tool: 'pm.tasks.update',
        version: '1',
        tool_class: 'update_records',
        decision: 'approval_required',
        code: 'approval_required',
        duration_ms: 1,
        at: '2026-10-21T00:00:02Z',
      },
      {
        sequence: 1,
        tool: 'pm.tasks.get',
        version: '1',
        tool_class: 'read_records',
        decision: 'executed',
        code: null,
        duration_ms: 3,
        at: '2026-10-21T00:00:01Z',
      },
    ],
    scope: { items: [] },
    capabilities: { pause: true, resume: false, cancel: true, retry: false, accept: false },
    created_at: '2026-10-21T00:00:00Z',
    ended_at: null,
    version: 1,
    ...over,
  });
  const runs = (items: unknown[]) => json(200, { data: { type: 'agent_runs', task: TSK, items } });
  const never = () => new Promise<Response>(() => undefined);

  it('starts a run only from its preview: scope, tools that need approval, limits, and the measured AI cost confirmed for an internal agent', async () => {
    let started = false;
    const calls = serve({
      [`GET /tasks/${TSK}/agents`]: assignments,
      'GET /agents': () => json(200, { data: [], capabilities: { create: false } }),
      [`GET /tasks/${TSK}/agent-runs`]: () => runs(started ? [run({ state: 'queued' })] : []),
      [`GET /tasks/${TSK}/agent-run-preview`]: () =>
        json(200, {
          data: {
            type: 'agent_run_preview',
            profile: { id: AGT, name: 'Docs agent', kind: 'internal' },
            scope: { items: [{ kind: 'brand', id: BR, name: 'Harbor' }] },
            tools: [
              {
                name: 'pm.tasks.get',
                version: '1',
                tool_class: 'read_records',
                approval_class: 'none',
                mode: 'runs',
              },
              {
                name: 'pm.tasks.update',
                version: '1',
                tool_class: 'update_records',
                approval_class: 'review_required',
                mode: 'approval_required',
              },
            ],
            limits: { max_runtime_minutes: 30, max_tool_calls: 50, max_artifacts: 5 },
            costs: {
              measured: 'Model usage is measured by the AI gateway within its budget.',
              reported: null,
            },
            refusals: [],
            can_start: true,
          },
        }),
      [`POST /tasks/${TSK}/agents/${AGT}:run`]: () => {
        started = true;
        return json(201, { data: { type: 'agent_run', run: run({ state: 'queued' }) } });
      },
      [`GET /agent-runs/${RUN}/events`]: () => never(),
    });
    shell(<TaskAgentSection ws={WS} task={TSK} />);
    expect(await screen.findByText('No runs yet.')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Run Docs agent' }));
    const dialog = await screen.findByRole('dialog', { name: 'Run Docs agent?' });
    const preview = await within(dialog).findByRole('region', { name: 'Run preview' });
    expect(within(preview).getByText('Harbor')).toBeTruthy();
    expect(within(preview).getByText(/runs \(read only\)/)).toBeTruthy();
    expect(
      within(preview).getByText(/will ask for approval, which is not available yet/),
    ).toBeTruthy();
    expect(within(preview).getByText(/measured by the AI gateway/)).toBeTruthy();
    expect(within(preview).getByText('Longest run (minutes)')).toBeTruthy();
    const go = within(dialog).getByRole('button', { name: 'Start run' }) as HTMLButtonElement;
    // An internal agent's AI usage is confirmed before anything starts.
    expect(go.disabled).toBe(true);
    fireEvent.click(within(dialog).getByLabelText(/may use this workspace’s AI/));
    expect(go.disabled).toBe(false);
    await act(async () => fireEvent.click(go));
    const post = calls.find((c) => c.path.endsWith(':run'))!;
    expect(post.body).toEqual({ confirm: true });
    expect(post.key).toMatch(/^web-/);
    const list = await screen.findByRole('list', { name: 'Agent runs' });
    expect(within(list).getByText('Queued')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Docs agent is running' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('a refused preview names why and cannot start', async () => {
    serve({
      [`GET /tasks/${TSK}/agents`]: assignments,
      'GET /agents': () => json(200, { data: [], capabilities: { create: false } }),
      [`GET /tasks/${TSK}/agent-runs`]: () => runs([]),
      [`GET /tasks/${TSK}/agent-run-preview`]: () =>
        json(200, {
          data: {
            type: 'agent_run_preview',
            profile: { id: AGT, name: 'Docs agent', kind: 'external' },
            scope: { items: [] },
            tools: [],
            limits: {},
            costs: {
              measured: null,
              reported:
                'Any cost is reported by Docs agent and shown as reported, never as measured.',
            },
            refusals: [
              {
                pointer: '/',
                code: 'emergency_stop',
                message: 'Agent work is stopped for this workspace.',
              },
            ],
            can_start: false,
          },
        }),
    });
    shell(<TaskAgentSection ws={WS} task={TSK} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run Docs agent' }));
    const dialog = await screen.findByRole('dialog', { name: 'Run Docs agent?' });
    expect(
      await within(dialog).findByText('Agent work is stopped for this workspace.'),
    ).toBeTruthy();
    expect(within(dialog).getByText(/reported by Docs agent/)).toBeTruthy();
    expect(
      (within(dialog).getByRole('button', { name: 'Start run' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('a ready run is a draft for review: a neutral state, agent notes labelled as notes, reported cost labelled, a draft artifact, and no accept control', async () => {
    let polls = 0;
    serve({
      [`GET /tasks/${TSK}/agents`]: assignments,
      'GET /agents': () => json(200, { data: [], capabilities: { create: false } }),
      [`GET /tasks/${TSK}/agent-runs`]: () =>
        runs([
          run({
            state: 'ready_for_review',
            review: { required: true, owner: '8D' },
            result: { status: 'completed', summary: 'Notes drafted. Everything is done!' },
            costs: {
              measured: null,
              reported: { micros: 1500, currency: 'USD', label: 'reported by Docs agent' },
            },
            artifacts: [
              {
                key: 'notes',
                version: 1,
                title: 'Launch notes',
                media_type: 'text/markdown',
                byte_size: 20,
                sha256: 'a'.repeat(64),
                producer: 'external',
                created_at: '2026-10-21T00:00:03Z',
              },
            ],
            capabilities: {
              pause: false,
              resume: false,
              cancel: false,
              retry: false,
              accept: false,
            },
            ended_at: '2026-10-21T00:00:04Z',
          }),
        ]),
      [`GET /agent-runs/${RUN}/events`]: () => {
        polls += 1;
        return json(200, {
          data: {
            type: 'agent_run_events',
            events:
              polls === 1
                ? [
                    {
                      seq: 1,
                      kind: 'state',
                      source: 'system',
                      verified: true,
                      text: 'Queued.',
                      data: {},
                      at: '2026-10-21T00:00:00Z',
                    },
                    {
                      seq: 2,
                      kind: 'commentary',
                      source: 'agent',
                      verified: false,
                      text: 'Done! Everything is complete.',
                      data: {},
                      at: '2026-10-21T00:00:01Z',
                    },
                  ]
                : [],
            state: 'ready_for_review',
            waiting: null,
            cursor: 2,
            ended: true,
          },
        });
      },
      [`GET /agent-runs/${RUN}/artifacts/notes`]: () =>
        json(200, {
          data: {
            type: 'agent_artifact',
            run: RUN,
            key: 'notes',
            draft: true,
            versions: [
              {
                version: 1,
                title: 'Launch notes',
                media_type: 'text/markdown',
                content: '# Launch notes',
                byte_size: 14,
                sha256: 'a'.repeat(64),
                producer: 'external',
                created_at: '2026-10-21T00:00:03Z',
              },
            ],
          },
        }),
    });
    shell(<TaskAgentSection ws={WS} task={TSK} />);
    const list = await screen.findByRole('list', { name: 'Agent runs' });
    const chip = within(list).getByText('Ready for review');
    expect(chip.className).toContain('au-chip-review');
    expect(chip.className).not.toMatch(/succeeded|active/);
    fireEvent.click(within(list).getByRole('button', { name: 'Details' }));
    const detail = await screen.findByRole('region', { name: 'Run of Docs agent' });
    expect(within(detail).getByText(/A person reviews it before it counts/)).toBeTruthy();
    expect(within(detail).getByText('Agent’s summary (not verified)')).toBeTruthy();
    expect(within(detail).getByText(/reported by Docs agent, not measured/)).toBeTruthy();
    const progress = await within(detail).findByRole('list', { name: 'Run progress' });
    expect(within(progress).getByText(/agent’s note/).parentElement!.textContent).toContain(
      'Done! Everything is complete.',
    );
    expect(within(detail).queryByRole('button', { name: /accept|approve|mark done/i })).toBeNull();
    expect(
      within(detail).queryByRole('button', { name: /Pause|Resume|Retry|Cancel run/ }),
    ).toBeNull();
    fireEvent.click(within(detail).getByRole('button', { name: 'Launch notes' }));
    const draft = await screen.findByRole('dialog', { name: 'Launch notes' });
    expect(within(draft).getByText(/has not been accepted/)).toBeTruthy();
    expect(within(draft).getByLabelText('Draft content').textContent).toBe('# Launch notes');
    // The tool timeline names a write that waited for approval, never ran.
    expect(within(detail).getByText(/pm.tasks.update needs approval \(not run\)/)).toBeTruthy();
  });

  it('a run paused by the emergency stop says so and resumes on its own; cancel asks first; progress reconnects after a dropped poll', async () => {
    let polls = 0;
    const calls = serve({
      [`GET /tasks/${TSK}/agents`]: assignments,
      'GET /agents': () => json(200, { data: [], capabilities: { create: false } }),
      [`GET /tasks/${TSK}/agent-runs`]: () =>
        runs([
          run({
            state: 'waiting',
            waiting: 'paused',
            paused_by: 'emergency_stop',
            capabilities: { pause: false, resume: true, cancel: true, retry: false, accept: false },
          }),
        ]),
      [`GET /agent-runs/${RUN}/events`]: () => {
        polls += 1;
        if (polls === 1)
          return json(503, {
            error: { code: 'dependency_unavailable', status: 503, message: 'Unavailable' },
          });
        if (polls === 2)
          return json(200, {
            data: {
              type: 'agent_run_events',
              events: [
                {
                  seq: 1,
                  kind: 'stop',
                  source: 'system',
                  verified: true,
                  text: 'Paused by the emergency stop.',
                  data: {},
                  at: '2026-10-21T00:00:00Z',
                },
              ],
              state: 'waiting',
              waiting: 'paused',
              cursor: 1,
              ended: false,
            },
          });
        return never();
      },
      [`POST /agent-runs/${RUN}:resume`]: () =>
        json(200, { data: { type: 'agent_run', run: run() } }),
      [`POST /agent-runs/${RUN}:cancel`]: () =>
        json(200, {
          data: {
            type: 'agent_run',
            run: run({
              state: 'cancelled',
              failure: { terminal_reason: 'cancelled', code: null, liability: null },
              capabilities: {
                pause: false,
                resume: false,
                cancel: false,
                retry: false,
                accept: false,
              },
              ended_at: '2026-10-21T00:01:00Z',
            }),
          },
        }),
    });
    shell(<TaskAgentSection ws={WS} task={TSK} />);
    const list = await screen.findByRole('list', { name: 'Agent runs' });
    fireEvent.click(within(list).getByRole('button', { name: 'Details' }));
    const detail = await screen.findByRole('region', { name: 'Run of Docs agent' });
    expect(within(detail).getByText(/Paused by the workspace emergency stop/)).toBeTruthy();
    expect(await within(detail).findByText('Reconnecting to progress…')).toBeTruthy();
    expect(
      await within(detail).findByText('Paused by the emergency stop.', {}, { timeout: 4000 }),
    ).toBeTruthy();
    expect(within(detail).queryByText('Reconnecting to progress…')).toBeNull();
    await act(async () => fireEvent.click(within(detail).getByRole('button', { name: 'Resume' })));
    expect(calls.find((c) => c.path.endsWith(':resume'))!.key).toMatch(/^web-/);
    expect(await within(list).findByText('Running')).toBeTruthy();
    fireEvent.click(within(detail).getByRole('button', { name: 'Cancel run' }));
    expect(calls.some((c) => c.path.endsWith(':cancel'))).toBe(false);
    const confirm = await screen.findByRole('alertdialog', { name: 'Cancel this run?' });
    await act(async () =>
      fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel run' })),
    );
    expect(calls.filter((c) => c.path.endsWith(':cancel'))).toHaveLength(1);
    expect(await within(list).findByText('Cancelled')).toBeTruthy();
  }, 10_000);

  it('health shows run counts; an owner stops all agent work only after confirming, then may allow agents again', async () => {
    let stopped = false;
    const calls = serve({
      'GET /agents': () => json(200, { data: [], capabilities: { create: false } }),
      'GET /agent-templates': () => json(200, { data: { type: 'agent_templates', data: [] } }),
      'GET /agent-health': () =>
        json(200, {
          data: {
            type: 'agent_health',
            window_days: 30,
            runs: {
              queued: 0,
              running: 2,
              waiting: 1,
              failed: 0,
              cancelled: 0,
              ready_for_review: 3,
            },
            emergency_stop: {
              stopped,
              since: stopped ? '2026-10-21T00:00:00Z' : null,
              epoch: stopped ? 1 : 0,
              can_trigger: true,
            },
          },
        }),
      'POST /agent-emergency-stop': () => {
        stopped = true;
        return json(200, {
          data: {
            type: 'agent_emergency_stop',
            stopped: true,
            since: '2026-10-21T00:00:00Z',
            epoch: 1,
            report: { paused: 3, finishing: 0, already: 0, not_stoppable: 0 },
          },
        });
      },
      'POST /agent-emergency-stop/restart': () => {
        stopped = false;
        return json(200, {
          data: { type: 'agent_emergency_stop', stopped: false, since: null, epoch: 2 },
        });
      },
    });
    shell(<AgentsPage ws={WS} />);
    const card = await screen.findByRole('region', { name: 'Agent runs and emergency stop' });
    expect(await within(card).findByText('Agents may run in this workspace.')).toBeTruthy();
    expect(within(card).getByText('Ready for review').nextSibling!.textContent).toBe('3');
    fireEvent.click(within(card).getByRole('button', { name: 'Stop all agent work' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    const dialog = await screen.findByRole('alertdialog', { name: 'Stop all agent work?' });
    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), {
      target: { value: 'Runaway agent' },
    });
    await act(async () =>
      fireEvent.click(within(dialog).getByRole('button', { name: 'Stop all agent work' })),
    );
    const post = calls.find((c) => c.path.endsWith('/agent-emergency-stop'))!;
    expect(post.body).toEqual({ reason: 'Runaway agent' });
    expect(post.key).toMatch(/^web-/);
    expect(await within(card).findByText('Agent work is stopped')).toBeTruthy();
    expect(screen.getByText(/3 run\(s\) paused; 0 already paused/)).toBeTruthy();
    await act(async () =>
      fireEvent.click(within(card).getByRole('button', { name: 'Allow agents to run again' })),
    );
    expect(await screen.findByText(/Paused runs stay paused until each is resumed/)).toBeTruthy();
  });
});
