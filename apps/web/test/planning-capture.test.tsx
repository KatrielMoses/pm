import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureAssist } from '../src/capture/capture-assist.tsx';
import { DayPlanPage } from '../src/pages/plan-pages.tsx';
import { ProposalPage } from '../src/ai/proposals-page.tsx';
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
const RUN = 'op_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PRP = 'prp_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TSK = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TSK2 = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function serve(routes: Record<string, (body: any) => Response>) {
  const calls: Array<{ method: string; path: string; body: any; key: string | null }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, path, body, key: new Headers(init?.headers).get('idempotency-key') });
      for (const [k, fn] of Object.entries(routes)) {
        const [m, suffix] = k.split(' ') as [string, string];
        if (m === method && path.split('?')[0]!.endsWith(suffix)) return fn(body);
      }
      return json(404, { error: { code: 'not_found', status: 404, message: 'Not found' } });
    }),
  );
  return calls;
}

const overview = (ready: boolean) => ({
  data: {
    type: 'ai_overview',
    availability: ready ? 'ready' : 'disabled',
    reason: ready ? 'AI is on.' : 'AI is turned off for this workspace.',
    can_execute: ready,
    model: null,
    synthetic: true,
    funding: 'synthetic',
    max_output_tokens: 512,
    confirm_above: { micros: '0', display: '$0.00' },
    usage: null,
    manual_fallback: 'Continue manually.',
  },
});
const voiceSettings = (transcription: string) => ({
  data: {
    type: 'voice_settings',
    transcription,
    synthetic: transcription === 'available',
    max_seconds: 120,
    max_bytes: 10485760,
    formats: ['audio/wav', 'audio/webm', 'audio/ogg'],
    note:
      transcription === 'available'
        ? 'Transcription here uses a synthetic test fixture: it is not real speech recognition.'
        : 'Voice transcription is not available. You can type or paste your note.',
  },
});

describe('Capture assistance (7F)', () => {
  const renderAssist = (text: string, extra: Partial<Parameters<typeof CaptureAssist>[0]> = {}) => {
    const onInterpretation = vi.fn();
    const onText = vi.fn();
    const onVoice = vi.fn();
    render(
      <CaptureAssist
        ws={WS}
        account="device"
        text={text}
        brand={null}
        interpretation={null}
        onText={onText}
        onInterpretation={onInterpretation}
        onVoice={onVoice}
        {...extra}
      />,
    );
    return { onInterpretation, onText, onVoice };
  };

  it('says honestly when AI and transcription are unavailable, and offers no recording', async () => {
    serve({
      'GET /ai': () => json(200, overview(false)),
      'GET /capture/voice-settings': () => json(200, voiceSettings('not_configured')),
    });
    renderAssist('Buy milk');
    expect(await screen.findByText(/AI is turned off for this workspace/)).toBeTruthy();
    expect(await screen.findByText(/Voice transcription is not available/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Record a note' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Interpret with AI' })).toBeNull();
  });

  it('estimates, confirms, interprets, and shows checked values with their evidence spans', async () => {
    const calls = serve({
      'GET /ai': () => json(200, overview(true)),
      'GET /capture/voice-settings': () => json(200, voiceSettings('not_configured')),
      'POST /ai/context-previews': () => json(200, { data: { digest: 'd'.repeat(64) } }),
      'POST /ai/assist-estimates': () =>
        json(200, {
          data: {
            synthetic: true,
            max_cost: { micros: '10', display: '$0.01' },
            input_digest: 'e'.repeat(64),
          },
        }),
      'POST /ai/assist-runs': () =>
        json(202, {
          data: {
            id: RUN,
            state: 'succeeded',
            content: {
              interpretation: {
                status: 'checked',
                reason: null,
                fields: [{ field: 'due_date', span: 'tomorrow', start: 9, end: 17 }],
                dropped: 0,
                questions: [],
              },
            },
          },
        }),
      'POST /capture/interpretations': () =>
        json(200, {
          data: {
            ai: true,
            action: 'interpret_capture.v1',
            status: 'checked',
            dropped: 0,
            questions: [],
            assumptions: [],
            limitations: [],
            timezone: 'UTC',
            today: '2026-10-19',
            trust_note: 'AI marked which words name which field.',
            candidate: {
              text: 'Buy milk tomorrow',
              title: 'Buy milk',
              needs_confirmation: false,
              truncated: false,
              interpretation: { run: RUN, action: 'interpret_capture.v1' },
              detected: [
                {
                  field: 'due_date',
                  text: 'tomorrow',
                  start: 9,
                  end: 17,
                  rule: 'ai:tomorrow',
                  status: 'resolved',
                  value: '2026-10-20',
                  label: 'Tue 2026-10-20 (UTC)',
                },
              ],
            },
          },
        }),
    });
    const { onInterpretation } = renderAssist('Buy milk tomorrow');
    fireEvent.click(await screen.findByRole('button', { name: 'Interpret with AI' }));
    expect(await screen.findByText(/could cost up to/)).toBeTruthy();
    expect(screen.getByText(/synthetic test model/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and interpret' }));
    const region = await screen.findByRole('region', { name: 'Interpretation' });
    expect(region.querySelector('mark')!.textContent).toBe('tomorrow');
    expect(screen.getByText(/Tue 2026-10-20 \(UTC\)/)).toBeTruthy();
    expect(calls.find((c) => c.path.endsWith('/ai/assist-runs'))!.key).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Save with this interpretation' }));
    expect(onInterpretation).toHaveBeenLastCalledWith(RUN);
  });

  it('a denied microphone is explained; upload and typing stay available', async () => {
    serve({
      'GET /ai': () => json(200, overview(false)),
      'GET /capture/voice-settings': () => json(200, voiceSettings('available')),
    });
    vi.stubGlobal('MediaRecorder', class {});
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () =>
          Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })),
      },
    });
    renderAssist('');
    expect(await screen.findByText(/synthetic test fixture/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Record a note' }));
    expect(await screen.findByText(/Microphone access was denied/)).toBeTruthy();
    expect(screen.getByText('Upload audio')).toBeTruthy();
  });
});

const preview = (assumed = false) => ({
  data: {
    type: 'day_plan_preview',
    day: '2026-10-26',
    timezone: 'UTC',
    scope: { brands: [], projects: [] },
    mode: 'rule_based',
    generated: false,
    considered: 2,
    considered_max: 60,
    coverage: null,
    totals: {
      capacity_minutes: 480,
      free_minutes: 480,
      existing_block_minutes: 0,
      candidate_minutes: 60,
      scheduled_minutes: assumed ? 90 : 60,
      unscheduled_minutes: 0,
      unknown_estimates: assumed ? 0 : 1,
    },
    feasible: assumed,
    scheduled: [
      {
        task: { id: TSK, title: 'Write brief', brand: null },
        rank: 1,
        minutes: 60,
        slots: [
          {
            starts_at: '2026-10-26T09:00:00Z',
            ends_at: '2026-10-26T10:00:00Z',
            local: '09:00–10:00',
          },
        ],
        reasons: [{ code: 'due_today', detail: 'Due today.' }],
        warnings: [],
      },
    ],
    unscheduled: assumed
      ? []
      : [
          {
            task: { id: TSK2, title: 'Unestimated', brand: null },
            rank: 2,
            code: 'missing_estimate',
            minutes: null,
            detail: 'No estimate: enter one to plan it.',
          },
        ],
    postpone: [],
    conflicts: [],
    blocks: [],
    snapshot: 'f'.repeat(64),
  },
});

describe('Plan my day (7F)', () => {
  it('previews a rule-based plan, asks for missing estimates, and creates a proposal with a key', async () => {
    window.history.pushState({}, '', `/workspaces/${WS}/today/plan?day=2026-10-26`);
    const calls = serve({
      'POST /planning/day-plan-previews': (b) => json(200, preview(!!b?.assumptions)),
      'POST /planning/day-plans': () => json(201, { data: { id: PRP, type: 'change_proposal' } }),
    });
    render(
      <Router>
        <DayPlanPage ws={WS} />
      </Router>,
    );
    expect(await screen.findByText(/Write brief/)).toBeTruthy();
    expect(screen.getByText(/09:00–10:00/)).toBeTruthy();
    expect(screen.getByText(/Why here: due today/)).toBeTruthy();
    const input = screen.getByLabelText('Unestimated (minutes)');
    fireEvent.change(input, { target: { value: '30' } });
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.path.endsWith('/day-plan-previews') && c.body?.assumptions?.[TSK2] === 30,
        ),
      ).toBe(true),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Create plan proposal' }));
    await waitFor(() =>
      expect(calls.some((c) => c.path.endsWith('/planning/day-plans'))).toBe(true),
    );
    const created = calls.find((c) => c.path.endsWith('/planning/day-plans'))!;
    expect(created.key).toBeTruthy();
    expect(created.body).toMatchObject({ day: '2026-10-26' });
    await waitFor(() =>
      expect(window.location.pathname).toBe(`/workspaces/${WS}/ai/proposals/${PRP}`),
    );
  });
});

const plannerProposal = (state: 'current' | 'changed') => ({
  data: {
    id: PRP,
    type: 'change_proposal',
    state: 'open',
    revision: 1,
    version: 1,
    created_at: '2026-10-19T08:00:00Z',
    updated_at: '2026-10-19T08:00:00Z',
    run: 'op_01ARZ3NDEKTSV4RRFFQ69G5FAX',
    synthetic: false,
    origin: 'planner',
    application: null,
    content: { state: 'present', note: null },
    title: 'Plan for 2026-10-26',
    fingerprint: 'a'.repeat(64),
    trust_note: 'This plan was made by the rule-based planner, not AI.',
    plan: {
      day: '2026-10-26',
      timezone: 'UTC',
      scope: { brands: [], projects: [] },
      mode: 'rule_based',
      generated: false,
      considered: 2,
      coverage: null,
      totals: {
        capacity_minutes: 480,
        scheduled_minutes: 60,
        unscheduled_minutes: 0,
        unknown_estimates: 0,
      },
      feasible: true,
      assumptions: {},
      reasons: {},
      unscheduled: [],
      postpone: [
        {
          task: { id: TSK2, title: 'Later task' },
          minutes: 30,
          reason: 'x',
          tradeoff: 'Lowest priority; dates do not change.',
        },
      ],
      conflicts: [],
      current: {
        state,
        snapshot: 'b'.repeat(64),
        issues: [{ block: 'c2', code: 'overlaps_meeting', severity: 'error' }],
      },
    },
    changes: [
      {
        key: 'c1',
        op: 'commitment.add',
        selected: true,
        decision: 'pending',
        depends_on: [],
        temp_ref: null,
        target: null,
        project: null,
        parent: null,
        brand: null,
        task: { type: 'task', id: TSK, title: 'Write brief' },
        relation: null,
        fields: [{ field: 'day', before: null, after: '2026-10-26' }],
        sources: [],
        applied_state: 'not_applied',
        result: null,
        failure: null,
      },
      {
        key: 'c2',
        op: 'block.create',
        selected: true,
        decision: 'pending',
        depends_on: [],
        temp_ref: null,
        target: null,
        project: null,
        parent: null,
        brand: null,
        task: { type: 'task', id: TSK, title: 'Write brief' },
        relation: null,
        fields: [
          { field: 'starts_at', before: null, after: '2026-10-26T09:00:00.000Z' },
          { field: 'ends_at', before: null, after: '2026-10-26T10:00:00.000Z' },
        ],
        sources: [],
        applied_state: 'not_applied',
        result: null,
        failure: null,
      },
    ],
    order: ['c1', 'c2'],
    selection_issues: [],
    approval: null,
    history: [],
    can: { edit: true, approve: true, apply: false, reject: true, rebase: state === 'changed' },
  },
});

describe('Planner proposals (7F)', () => {
  it('shows the plan, rule-based provenance, editable block times, conflicts, and snapshot rebase', async () => {
    const calls = serve({
      [`GET /ai/proposals/${PRP}`]: () => json(200, plannerProposal('changed')),
      [`POST /ai/proposals/${PRP}:rebase`]: () => json(200, plannerProposal('current')),
    });
    render(
      <Router>
        <ProposalPage ws={WS} id={PRP} />
      </Router>,
    );
    expect(await screen.findByText(/rule-based planner, not AI/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Plan for 2026-10-26 \(UTC\)/ })).toBeTruthy();
    expect(screen.getByText('c1 · Add to Today')).toBeTruthy();
    expect(screen.getByText('c2 · Schedule a work block')).toBeTruthy();
    expect(
      screen
        .getAllByLabelText(/Starts \(proposed\), in your browser's time zone/)[0]!
        .getAttribute('type'),
    ).toBe('datetime-local');
    expect(
      screen.getByText(/This time overlaps a meeting: change it or deselect this block/),
    ).toBeTruthy();
    expect(screen.getByText(/Lowest priority; dates do not change/)).toBeTruthy();
    expect(screen.getByText('Your day changed since this plan was made')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use my current day' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith(':rebase'))).toBe(true));
    expect(calls.find((c) => c.path.endsWith(':rebase'))!.body).toMatchObject({
      revision: 1,
      reviewed: {},
      snapshot: 'b'.repeat(64),
    });
  });
});
