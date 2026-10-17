import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistPage } from '../src/ai/assist-page.tsx';
import { Router } from '../src/router.tsx';
import { clearPersonalClientState } from '../src/shell/drafts.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.pushState({}, '', '/');
});

const WS = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TSK = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const RUN = 'op_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PRP = 'prp_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const money = { micros: '5.000000', display: '$0.000005', currency: 'USD' };
const action = (
  id: string,
  kind: 'analysis' | 'proposal',
  label: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  label,
  kind,
  requirements: [],
  input: { label: 'What to focus on (optional)', required: false, max: 2000 },
  needs: null,
  source_kinds: ['task'],
  item_kinds: kind === 'analysis' ? ['summary'] : [],
  draft: false,
  rules: null,
  operations: kind === 'proposal' ? ['project.create'] : [],
  choices: false,
  max_output_tokens: 1024,
  limitations: ['Generated text is a suggestion.'],
  ...extra,
});
const manifest = {
  type: 'ai_context_manifest',
  digest: 'a'.repeat(64),
  scope: { kind: 'workspace', brands: [], project: null, task: null },
  query: null,
  sources: [
    {
      handle: 'S1',
      type: 'task',
      id: TSK,
      title: 'Launch checklist',
      link: { type: 'task', id: TSK, anchor: null },
      version: 'v1',
      selection: 'scope',
      included: true,
      exclusion_reason: null,
      flags: [],
      fields: ['title'],
    },
  ],
  counts: { listed: 1, included: 1, excluded: 0, omitted: 0 },
  limits: { sources_max: 8, source_chars: 1500, listed_max: 20 },
  index: null,
  notice: null,
  warnings: [],
  semantic_search: false,
  ai: { availability: 'ready', reason: 'AI is available.', can_answer: true },
};
const src = {
  handle: 'S1',
  type: 'task',
  id: TSK,
  title: 'Launch checklist',
  link: { type: 'task', id: TSK, anchor: null },
  changed: false,
};
const runWith = (content: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: RUN,
  type: 'ai_run',
  version: 2,
  purpose: 'analysis',
  action: 'summarize.v1',
  state: 'succeeded',
  status: 'Completed',
  terminal_reason: null,
  waiting_reason: null,
  refusal: null,
  synthetic: true,
  can_cancel: false,
  content: { state: 'present', note: null, prompt: 'x', redactions: 0, output: null, ...content },
  ...extra,
});
const analysis = (over: Record<string, unknown> = {}) => ({
  completeness: 'complete',
  action: 'summarize.v1',
  status: 'checked',
  reason: null,
  note: null,
  items: [
    {
      kind: 'stale',
      basis: 'rule',
      text: 'S1 was due 2026-10-07 and is not done.',
      reasoning: null,
      rule: 'overdue',
      sources: [src],
      excerpt: null,
      issues: [],
    },
    {
      kind: 'summary',
      basis: 'generated',
      text: 'See <b>javascript:alert(1)</b>',
      reasoning: 'Because.',
      rule: null,
      sources: [src],
      excerpt: 'We decided to ship.',
      issues: ['untrusted_link'],
    },
  ],
  draft: null,
  questions: [],
  assumptions: [],
  facts: [],
  calculations: [],
  dropped_citations: 0,
  dropped_items: 0,
  limitations: ['Generated text is a suggestion.'],
  trust_note:
    'Rule findings, facts, and calculations come from the records. Every generated item is a suggestion.',
  ...over,
});

function serve(run: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, path, body });
      if (path.endsWith('/ai/actions'))
        return json(200, {
          data: {
            type: 'ai_actions',
            items: [
              action('summarize.v1', 'analysis', 'Summarize'),
              action('draft_project.v1', 'proposal', 'Draft a project plan', {
                needs: 'brief_or_goal',
                input: { label: 'Extra guidance (optional)', required: false, max: 2000 },
              }),
            ],
          },
        });
      if (path.endsWith('/ai/context-previews')) return json(200, { data: manifest });
      if (path.endsWith('/ai/assist-estimates'))
        return json(200, {
          data: {
            type: 'ai_estimate',
            synthetic: true,
            max_cost: money,
            confirm_required: true,
            within_limits: true,
            input_digest: 'd'.repeat(64),
            manifest,
          },
        });
      if (path.endsWith('/ai/assist-runs')) return json(202, { data: run });
      if (path.endsWith(`/ai/runs/${RUN}`)) return json(200, { data: run });
      return json(404, { error: { code: 'not_found', status: 404, message: 'Not found' } });
    }),
  );
  return calls;
}
const page = () =>
  render(
    <Router>
      <AssistPage ws={WS} />
    </Router>,
  );
const runIt = async () => {
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Preview context' })));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Estimate cost' })));
  const run = screen.getByRole('button', { name: /^Run / }) as HTMLButtonElement;
  expect(run.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/I confirm this/));
  await act(async () => fireEvent.click(run));
};

describe('AI assist (7C)', () => {
  it('preselects the scope from the entry point, binds the run to the estimated input, and labels rule findings and generated suggestions as text only', async () => {
    window.history.pushState({}, '', `/workspaces/${WS}/ai/assist?task=${TSK}`);
    const calls = serve(runWith({ analysis: analysis() }));
    page();
    expect(((await screen.findByLabelText('Task (optional)')) as HTMLInputElement).value).toBe(TSK);
    await runIt();
    const started = calls.find((c) => c.path.endsWith('/ai/assist-runs'))!;
    expect(started.body).toMatchObject({
      action: 'summarize.v1',
      scope: { task: TSK },
      manifest_digest: 'a'.repeat(64),
      input_digest: 'd'.repeat(64),
      confirm_cost: true,
    });
    const rules = await screen.findByRole('region', { name: 'Rule findings from the records' });
    expect(rules.textContent).toContain('Rule: past its due date and not done');
    const gen = screen.getByRole('region', { name: 'Generated suggestions' });
    expect(gen.textContent).toContain('See <b>javascript:alert(1)</b>');
    expect(gen.querySelector('b')).toBeNull();
    expect(gen.textContent).toContain('shown as text and never opened');
    expect(gen.textContent).toContain('Why: Because.');
    expect(
      screen.getAllByRole('link', { name: 'S1: Launch checklist' })[0]!.getAttribute('href'),
    ).toBe(`/workspaces/${WS}/tasks/${TSK}`);
  });

  it('questions become answers that form a new input; a changed input needs a fresh estimate', async () => {
    const calls = serve(
      runWith({
        analysis: analysis({
          status: 'needs_input',
          note: 'More information is needed.',
          items: [],
          questions: [{ id: 'q1', text: 'Which period?' }],
        }),
      }),
    );
    page();
    await screen.findByLabelText('Action');
    await runIt();
    fireEvent.change(await screen.findByLabelText('Which period?'), {
      target: { value: 'This week' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add answers' })));
    expect(screen.getByText('Which period?: This week')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Estimate' })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Preview context' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Estimate cost' })));
    expect(
      calls.filter((c) => c.path.endsWith('/ai/assist-estimates')).at(-1)!.body.answers,
    ).toEqual([{ question: 'Which period?', answer: 'This week' }]);
  });

  it('a drafting action shows a brief field and links to the proposal it made', async () => {
    serve(
      runWith(
        {
          analysis: null,
          proposal: {
            status: 'proposed',
            reason: null,
            id: PRP,
            issues: [],
            questions: [],
            assumptions: [],
          },
        },
        { purpose: 'change_proposal', action: 'draft_project.v1' },
      ),
    );
    page();
    fireEvent.change(await screen.findByLabelText('Action'), {
      target: { value: 'draft_project.v1' },
    });
    fireEvent.change(screen.getByLabelText('Project brief'), {
      target: { value: 'Launch the beta.' },
    });
    await runIt();
    expect(
      (await screen.findByRole('link', { name: 'Review the proposed changes' })).getAttribute(
        'href',
      ),
    ).toBe(`/workspaces/${WS}/ai/proposals/${PRP}`);
  });

  it('unsaved input is kept per workspace, restored only after the catalog loads, and removed on sign-out', async () => {
    serve(runWith({ analysis: analysis() }));
    const first = page();
    fireEvent.change(await screen.findByLabelText('What to focus on (optional)'), {
      target: { value: 'PRIVATE-ASSIST-MARKER' },
    });
    const keys = () =>
      Object.keys(localStorage).filter((k) =>
        (localStorage.getItem(k) ?? '').includes('PRIVATE-ASSIST-MARKER'),
      );
    expect(keys()).toEqual([`pm.draft.device.ai-assist.${WS.toLowerCase()}`]);
    first.unmount();
    page();
    expect(
      ((await screen.findByLabelText('What to focus on (optional)')) as HTMLTextAreaElement).value,
    ).toBe('PRIVATE-ASSIST-MARKER');
    cleanup();
    clearPersonalClientState();
    expect(keys()).toEqual([]);
  });
  it('a drafting action previews the labels and members it will offer, and the person can omit one before anything is sent (review 01 R1)', async () => {
    const MEM = 'mem_01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const calls = serve(runWith({ analysis: null }));
    const withChoice = {
      ...manifest,
      sources: [
        ...manifest.sources,
        {
          handle: 'M1',
          type: 'member',
          id: MEM,
          title: 'Ana',
          link: { type: 'member', id: MEM, anchor: null },
          version: 'v1',
          selection: 'scope',
          included: true,
          exclusion_reason: null,
          flags: [],
          fields: ['display_name'],
        },
      ],
    };
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method: init?.method ?? 'GET', path, body });
      if (path.endsWith('/ai/actions'))
        return json(200, {
          data: {
            type: 'ai_actions',
            items: [
              action('draft_project.v1', 'proposal', 'Draft a project plan', {
                needs: 'brief_or_goal',
                choices: true,
                input: { label: 'Extra guidance (optional)', required: false, max: 2000 },
              }),
            ],
          },
        });
      if (path.endsWith('/ai/context-previews'))
        return json(200, {
          data: body?.exclude?.length
            ? {
                ...withChoice,
                sources: withChoice.sources.map((s) =>
                  s.id === MEM
                    ? { ...s, handle: null, included: false, exclusion_reason: 'user_excluded' }
                    : s,
                ),
              }
            : withChoice,
        });
      return json(404, { error: { code: 'not_found', status: 404, message: 'Not found' } });
    });
    window.history.pushState({}, '', `/workspaces/${WS}/ai/assist?action=draft_project.v1`);
    page();
    fireEvent.change(await screen.findByLabelText('Project brief'), {
      target: { value: 'Launch.' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Preview context' })));
    const offer = await screen.findByLabelText(/Offer member: Ana \(M1\)/);
    expect((offer as HTMLInputElement).checked).toBe(true);
    expect(calls.filter((c) => c.path.endsWith('/ai/context-previews')).at(-1)!.body).toMatchObject(
      { offer_choices: true, exclude: [] },
    );
    await act(async () => fireEvent.click(offer));
    expect(calls.filter((c) => c.path.endsWith('/ai/context-previews')).at(-1)!.body).toMatchObject(
      {
        offer_choices: true,
        exclude: [{ type: 'member', id: MEM }],
      },
    );
    expect(((await screen.findByLabelText(/Offer member: Ana/)) as HTMLInputElement).checked).toBe(
      false,
    );
  });
});
