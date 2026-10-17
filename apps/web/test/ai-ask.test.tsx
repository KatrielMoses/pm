import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskPage } from '../src/ai/ask-page.tsx';
import { Router } from '../src/router.tsx';
import { StepUpProvider } from '../src/stepup.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const WS = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const RUN = 'op_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TSK = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const DOC = 'doc_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const money = (micros: string, display: string) => ({ micros, display, currency: 'USD' });

const manifest = (overrides: Record<string, unknown> = {}) => ({
  type: 'ai_context_manifest',
  digest: 'a'.repeat(64),
  scope: { kind: 'workspace', brands: [], project: null, task: null },
  query: 'launch',
  sources: [
    {
      handle: 'S1',
      type: 'task',
      id: TSK,
      title: 'Launch checklist',
      link: { type: 'task', id: TSK, anchor: null },
      version: 'v3',
      selection: 'search',
      included: true,
      exclusion_reason: null,
      flags: [],
      fields: ['title', 'description', 'status'],
    },
    {
      handle: null,
      type: 'document',
      id: DOC,
      title: 'Old process',
      link: { type: 'document', id: DOC, anchor: null },
      version: 'dcv_x',
      selection: 'search',
      included: false,
      exclusion_reason: 'needs_explicit_choice',
      flags: ['unapproved', 'stale'],
      fields: ['title', 'text'],
    },
  ],
  counts: { listed: 2, included: 1, excluded: 1, omitted: 0 },
  limits: { sources_max: 8, source_chars: 1500, listed_max: 20 },
  index: { state: 'complete', pending: 0, failed: 0 },
  notice: null,
  warnings: [],
  semantic_search: false,
  ai: { availability: 'ready', reason: 'AI is available.', can_answer: true },
  ...overrides,
});

const answerRun = {
  id: RUN,
  type: 'ai_run',
  version: 2,
  purpose: 'grounded_answer',
  state: 'succeeded',
  status: 'Completed',
  terminal_reason: null,
  waiting_reason: null,
  refusal: null,
  cancelling: false,
  synthetic: true,
  initiator: 'mem_1',
  brand: null,
  model: {
    key: 'fixture/synthetic-messages@2026-10-17',
    label: 'Synthetic',
    provider: 'fixture',
    model_id: 'synthetic-messages',
  },
  created_at: '2026-10-17T10:00:00Z',
  ended_at: '2026-10-17T10:00:01Z',
  estimate: { max_cost: money('5.000000', '$0.000005'), output_token_bound: 64 },
  cost: {
    settled: money('1.000000', '$0.000001'),
    unknown_reserved: money('0.000000', '$0.00'),
    note: null,
  },
  attempts: [],
  can_cancel: false,
  can_retry: true,
  cancellation_note: 'A request already sent cannot be recalled.',
  content: {
    state: 'present',
    note: null,
    prompt: 'What is planned?',
    redactions: 0,
    output: null,
    answer: {
      completeness: 'complete',
      status: 'downgraded',
      reason: null,
      note: 'Some citations did not match the sources and were removed. Generated statements are unverified.',
      facts: [
        {
          handle: 'S1',
          label: 'Status',
          value: 'In progress',
          source: {
            handle: 'S1',
            type: 'task',
            id: TSK,
            title: 'Launch checklist',
            link: { type: 'task', id: TSK, anchor: null },
            changed: false,
            flags: [],
          },
        },
      ],
      calculations: [
        {
          key: 'tasks_done',
          label: 'Tasks done',
          value: '0 of 1',
          basis: 'Counted by the server from 1 task in this context.',
        },
      ],
      statements: [
        {
          kind: 'excerpt',
          claimed: 'fact',
          text: 'Ship by Friday.',
          issues: [],
          citations: [
            {
              handle: 'S1',
              quote: 'Ship by Friday.',
              excerpt: 'Ship by Friday.',
              source: {
                handle: 'S1',
                type: 'task',
                id: TSK,
                title: 'Launch checklist',
                link: { type: 'task', id: TSK, anchor: null },
                changed: true,
                flags: [],
              },
            },
          ],
        },
        {
          // The reproduced review case: a real quotation attached to an unrelated claim.
          kind: 'unverified',
          claimed: 'fact',
          text: 'The launch generated twelve million dollars in profit.',
          issues: [],
          citations: [
            {
              handle: 'S1',
              quote: 'Ship by Friday.',
              excerpt: 'Ship by Friday.',
              source: {
                handle: 'S1',
                type: 'task',
                id: TSK,
                title: 'Launch checklist',
                link: { type: 'task', id: TSK, anchor: null },
                changed: true,
                flags: [],
              },
            },
          ],
        },
        {
          kind: 'unverified',
          claimed: 'fact',
          text: 'See <b>https://evil.example</b>',
          issues: ['no_valid_citation', 'untrusted_link'],
          citations: [],
        },
        {
          kind: 'suggestion',
          claimed: 'suggestion',
          text: 'Confirm with the owner.',
          issues: [],
          citations: [],
        },
        {
          kind: 'unknown',
          claimed: 'unknown',
          text: 'The sources do not name a budget.',
          issues: [],
          citations: [],
        },
      ],
      dropped_citations: 1,
      sources: [],
      trust_note:
        'Only facts and calculations from the records are established. Exact excerpts are copied from a source; every other generated statement is unverified, even when it cites a source.',
      provenance_note:
        'Citations show where a statement came from; they do not guarantee it is true.',
    },
  },
  context: [],
};

function serve(m = manifest(), run: Record<string, unknown> = answerRun) {
  const calls: Array<{ path: string; body: any }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path, body });
      if (path.endsWith('/ai/context-previews')) return json(200, { data: m });
      if (path.endsWith('/ai/answer-estimates'))
        return json(200, {
          data: {
            type: 'ai_estimate',
            synthetic: true,
            max_cost: money('5.000000', '$0.000005'),
            confirm_required: true,
            within_limits: true,
            manifest: m,
          },
        });
      if (path.endsWith('/ai/answers')) return json(202, { data: run });
      if (path.endsWith(`/ai/runs/${RUN}`)) return json(200, { data: run });
      return json(404, { error: { code: 'not_found', status: 404, message: 'Not found' } });
    }),
  );
  return calls;
}

const page = () =>
  render(
    <Router>
      <StepUpProvider>
        <AskPage ws={WS} />
      </StepUpProvider>
    </Router>,
  );

describe('Ask with sources (7B)', () => {
  it('previews the context first, lets the person include a flagged source, and sends only after confirmation', async () => {
    const calls = serve();
    page();
    fireEvent.change(screen.getByLabelText(/Find sources by words/), {
      target: { value: 'launch' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Preview context' })));
    const list = await screen.findByRole('list', { name: 'Context sources' });
    expect(list.textContent).toContain('S1 · Task: Launch checklist');
    expect(list.textContent).toContain('Not approved as an AI source, Review overdue (stale)');
    expect(list.textContent).toContain('Not used unless you include it');
    expect(screen.getByText(/Semantic \(meaning-based\) search is not available/)).toBeTruthy();
    // Including the flagged document is an explicit choice that re-previews the context.
    await act(async () => fireEvent.click(screen.getByLabelText(/Document: Old process/)));
    expect(
      calls.filter((c) => c.path.endsWith('/ai/context-previews')).at(-1)!.body.include,
    ).toEqual([{ type: 'document', id: DOC }]);
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'What is planned?' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Estimate cost' })));
    const ask = screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I confirm this answer may cost up to/));
    await act(async () => fireEvent.click(ask));
    const sent = calls.find((c) => c.path.endsWith('/ai/answers'))!;
    // A second question on the same page needs a fresh confirmation.
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'And then?' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Estimate cost' })));
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);
    expect(sent.body).toMatchObject({
      question: 'What is planned?',
      manifest_digest: 'a'.repeat(64),
      confirm_cost: true,
    });
  });

  it('shows facts, calculations, statements by kind, working citations, and never renders generated markup or links', async () => {
    serve();
    page();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Preview context' })));
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Q' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Estimate cost' })));
    fireEvent.click(screen.getByLabelText(/I confirm/));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Ask' })));
    expect(await screen.findByRole('region', { name: 'Facts from the records' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Calculations' }).textContent).toContain(
      'Tasks done: 0 of 1',
    );
    const excerpts = screen.getByRole('region', { name: 'Exact excerpts from the sources' });
    expect(excerpts.textContent).toContain('“Ship by Friday.”');
    expect(screen.getAllByText(/changed since this answer/).length).toBeGreaterThan(0);
    // The unrelated claim with a real quotation is unverified; the quote is shown as provenance.
    const unverified = screen.getByRole('region', { name: 'Unverified statements (generated)' });
    expect(unverified.textContent).toContain('twelve million dollars');
    expect(unverified.textContent).toContain('quoting the source: “Ship by Friday.”');
    expect(excerpts.textContent).not.toContain('twelve million');
    const markup = [...unverified.querySelectorAll('li')].find((li) =>
      li.textContent!.includes('evil.example'),
    )!;
    expect(markup.textContent).toContain('See <b>https://evil.example</b>');
    expect(markup.querySelector('b')).toBeNull();
    expect(markup.querySelector('a')).toBeNull();
    expect(markup.textContent).toContain('shown as text and never opened');
    expect(
      screen.getByText(/Only facts and calculations from the records are established/),
    ).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Suggestions (generated)' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Unknown' })).toBeTruthy();
    const link = screen.getAllByRole('link', { name: /S1: Launch checklist/ })[0]!;
    expect(link.getAttribute('href')).toBe(`/workspaces/${WS}/tasks/${TSK}`);
    expect(
      screen.getByText(/1 citation\(s\) that did not match the context were removed/),
    ).toBeTruthy();
    expect(screen.getByText(/do not guarantee it is true/)).toBeTruthy();
  });

  it('keeps previewing when AI is off, and says the index may be incomplete', async () => {
    serve(
      manifest({
        ai: {
          availability: 'unconfigured',
          reason: 'AI is not configured for this deployment.',
          can_answer: false,
        },
        index: { state: 'catching_up', pending: 3, failed: 0 },
        notice:
          'The search index is catching up, so the list may be incomplete. It does not mean no other relevant records exist.',
      }),
    );
    page();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Preview context' })));
    expect(await screen.findByText('AI is not available')).toBeTruthy();
    expect(screen.getByText(/work without AI/)).toBeTruthy();
    expect(screen.getByText(/may be incomplete/)).toBeTruthy();
    expect(screen.queryByLabelText('Question')).toBeNull();
  });

  it('an incomplete answer is labelled incomplete, shows no statements, and keeps record facts', async () => {
    const truncated = {
      ...answerRun,
      state: 'partial',
      status: 'Partial: the answer is incomplete',
      content: {
        ...answerRun.content,
        answer: {
          ...answerRun.content.answer,
          completeness: 'truncated',
          status: 'rejected',
          reason: 'truncated_response',
          note: 'The answer stopped before it was complete, so it is not shown as an answer. Facts and calculations below come from the records and are unaffected.',
          statements: [],
          dropped_citations: 0,
        },
      },
    };
    serve(manifest(), truncated);
    page();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Preview context' })));
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Q' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Estimate cost' })));
    fireEvent.click(screen.getByLabelText(/I confirm/));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Ask' })));
    expect(await screen.findByText('The answer is incomplete')).toBeTruthy();
    expect(screen.getByText(/stopped before it was complete/)).toBeTruthy();
    expect(screen.getByText('Partial: the answer is incomplete')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Exact excerpts from the sources' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Unverified statements (generated)' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Facts from the records' })).toBeTruthy();
  });
});
