import { describe, expect, it } from 'vitest';
import { actionFixtureReply, actionInputs } from '@pm/test-support';
import { ACTION_BY_ID, AI_ACTIONS, actionId } from '../../src/ai/actions/catalog.ts';
import {
  analysisSystemTemplate,
  ruleFindings,
  validateAnalysis,
} from '../../src/ai/actions/analysis.ts';
import { parseProposal, PROPOSAL_OPS } from '../../src/ai/proposals/contract.ts';
import type { ManifestEntry } from '../../src/ai/retrieval/types.ts';

const entry = (handle: string, over: Partial<ManifestEntry> = {}): ManifestEntry => ({
  key: `task:${handle}`,
  kind: 'task',
  publicId: `tsk_${handle}`,
  recordId: `r-${handle}`,
  title: `Task ${handle}`,
  link: { type: 'task', id: `tsk_${handle}`, anchor: null },
  brandId: 'b1',
  version: 1,
  versionLabel: 'v1',
  selection: 'explicit',
  included: true,
  exclusion: null,
  flags: [],
  handle,
  fieldNames: ['title', 'description'],
  payload: { title: `Task ${handle}`, description: 'We decided to ship on Friday. Who signs off?' },
  contentHash: 'a'.repeat(64),
  facts: { status: { name: 'To do', category: 'todo' } },
  ...over,
});
const today = '2026-10-17';
const def = (id: string) => ACTION_BY_ID.get(id)!;
const validate = (
  id: string,
  text: string,
  entries = [entry('S1')],
  completeness: 'complete' | 'truncated' = 'complete',
) => validateAnalysis({ def: def(id), text, completeness, entries, today });

/** Phase 7C action catalog and analysis contract (ADR-0041 C1–C3; unit portion of AT-431–AT-436). */
describe('Phase 7C action catalog and analysis contract', () => {
  it('registers ten versioned actions with declared contracts and only known proposal operations', () => {
    expect(AI_ACTIONS).toHaveLength(10);
    expect(new Set(AI_ACTIONS.map(actionId)).size).toBe(10);
    for (const a of AI_ACTIONS) {
      expect(a.requirements.length).toBeGreaterThan(0);
      expect(a.limitations.length).toBeGreaterThan(0);
      if (a.kind === 'analysis') expect(a.itemKinds!.length).toBeGreaterThan(0);
      else expect(a.ops!.every((o) => PROPOSAL_OPS.includes(o))).toBe(true);
    }
    const covered = new Set(AI_ACTIONS.flatMap((a) => a.requirements));
    for (const r of [
      'PRJ-016',
      'AI-001',
      'AI-002',
      'AI-003',
      'AI-004',
      'AI-012',
      'AI-013',
      'AI-014',
      'AI-015',
      'AI-016',
      'AI-017',
      'AI-018',
      'AI-019',
      'AI-020',
      'AI-022',
    ])
      expect(covered.has(r), r).toBe(true);
    expect(analysisSystemTemplate(def('extract.v1'))).toContain('decision, action_item, risk');
  });

  it('checks completeness first, then the strict shape, kinds, citations, and quotations', () => {
    const ok = JSON.stringify({
      items: [
        {
          kind: 'decision',
          text: 'Ship on Friday.',
          sources: ['S1'],
          quote: 'We decided to ship on Friday.',
        },
      ],
    });
    expect(validate('extract.v1', ok)).toMatchObject({
      status: 'checked',
      items: [{ excerpt: 'We decided to ship on Friday.', basis: 'generated' }],
    });
    expect(validate('extract.v1', ok, [entry('S1')], 'truncated')).toMatchObject({
      status: 'rejected',
      reason: 'truncated_response',
    });
    expect(validate('extract.v1', 'prose')).toMatchObject({
      status: 'rejected',
      reason: 'malformed_response',
    });
    expect(validate('extract.v1', JSON.stringify({ items: [], tool: 'x' }))).toMatchObject({
      reason: 'unsupported_output',
    });
    expect(
      validate(
        'extract.v1',
        JSON.stringify({ items: [{ kind: 'summary', text: 'x', sources: ['S1'] }] }),
      ),
    ).toMatchObject({ reason: 'unsupported_output' });
    expect(
      validate('summarize.v1', JSON.stringify({ items: [], draft: 'no drafts here' })),
    ).toMatchObject({ reason: 'unsupported_output' });
    const misquote = validate(
      'extract.v1',
      JSON.stringify({
        items: [
          { kind: 'decision', text: 'x', sources: ['S1'], quote: 'we decided to ship on friday.' },
        ],
      }),
    );
    expect(misquote.items[0]).toMatchObject({ excerpt: null, issues: ['quote_mismatch'] });
    const forged = validate(
      'extract.v1',
      JSON.stringify({
        items: [
          { kind: 'decision', text: 'x', sources: ['S9'] },
          { kind: 'risk', text: 'y', sources: ['S1', 'S7'] },
        ],
      }),
    );
    expect(forged).toMatchObject({ status: 'downgraded', dropped_items: 1, dropped_citations: 2 });
    const link = validate(
      'summarize.v1',
      JSON.stringify({
        items: [{ kind: 'summary', text: 'see https://evil.example', sources: ['S1'] }],
      }),
    );
    expect(link.items[0]!.issues).toContain('untrusted_link');
    const claim = validate(
      'summarize.v1',
      JSON.stringify({ items: [{ kind: 'summary', text: 'This is completed.', sources: ['S1'] }] }),
    );
    expect(claim.items[0]!.issues).toContain('contradicts_record');
  });

  it('questions instead of an analysis are needs_input; drafts are only for drafting actions', () => {
    expect(
      validate(
        'summarize.v1',
        JSON.stringify({ items: [], questions: [{ text: 'Which period?' }] }),
      ),
    ).toMatchObject({
      status: 'needs_input',
      questions: [{ id: 'q1', text: 'Which period?' }],
    });
    const d = validate(
      'draft_status_update.v1',
      JSON.stringify({ draft: 'Status: on track.', items: [] }),
    );
    expect(d).toMatchObject({ status: 'checked', draft: 'Status: on track.' });
  });

  it('rule findings count only included sources and name their rule', () => {
    const entries = [
      entry('S1', {
        title: 'Same title',
        facts: { status: { name: 'To do', category: 'todo' }, dueDate: '2026-10-01' },
      }),
      entry('S2', { title: 'Same title' }),
      entry('S3', { title: 'Same title', included: false, handle: null }),
      entry('S4', {
        title: 'Soon',
        facts: { status: { name: 'To do', category: 'todo' }, dueDate: '2026-10-20' },
      }),
    ];
    const work = ruleFindings(def('analyze_work.v1'), entries, today);
    expect(work.map((f) => f.rule).sort()).toEqual(['duplicate_title', 'no_due_date', 'overdue']);
    expect(work.find((f) => f.rule === 'duplicate_title')!.sources).toEqual(['S1', 'S2']);
    const next = ruleFindings(def('recommend_next.v1'), entries, today);
    expect(next.map((f) => f.rule)).toEqual(['overdue_first', 'due_within_7_days']);
    expect(ruleFindings(def('summarize.v1'), entries, today)).toEqual([]);
  });

  it('drafting actions propose only their operations and server-issued choices', () => {
    const handles = [
      { handle: 'S1', kind: 'task' as const, publicId: 'tsk_A', recordId: 'r', version: 3 },
    ];
    const choices = {
      labels: [{ handle: 'L1', publicId: 'lbl_A' }],
      members: [{ handle: 'M1', publicId: 'mem_A' }],
    };
    const opts = { changesMax: 25, scopeBrands: 1, ops: def('categorize.v1').ops!, choices };
    const ok = parseProposal(
      JSON.stringify({
        changes: [
          {
            id: 'c1',
            op: 'task.update',
            target: 'S1',
            fields: { priority: 'high', estimate_minutes: '90' },
          },
          { id: 'c2', op: 'label.add', task: 'S1', label: 'L1' },
          { id: 'c3', op: 'task.assign', target: 'S1', assignees: ['M1'] },
        ],
      }),
      handles,
      opts,
    );
    expect(ok.ok).toBe(true);
    if (ok.ok !== true) return;
    expect(ok.proposal.changes[1]!.payload.label).toBe('lbl_A');
    expect(ok.proposal.changes[2]!.payload.assignees).toEqual(['mem_A']);
    expect(ok.proposal.changes[2]!.expectedVersion).toBe(3);
    const bad = parseProposal(
      JSON.stringify({
        changes: [
          { id: 'c1', op: 'project.create', ref: 'p', brand: 'scope', fields: { name: 'x' } },
          { id: 'c2', op: 'label.add', task: 'S1', label: 'Backend' },
          { id: 'c3', op: 'task.assign', target: 'S1', assignees: ['mem_EVIL'] },
        ],
      }),
      handles,
      opts,
    );
    expect(bad.ok === false ? bad.issues.map((i) => i.code) : []).toEqual([
      'unsupported_operation',
      'unknown_choice',
      'unknown_choice',
    ]);
    const asks = parseProposal(
      JSON.stringify({ questions: [{ text: 'What outcome?' }], changes: [] }),
      handles,
      opts,
    );
    expect(asks).toEqual({
      ok: 'questions',
      questions: [{ id: 'q1', text: 'What outcome?' }],
      assumptions: [],
    });
  });

  it('the fixture answers each action only from what it was sent, and its scenarios are refused or flagged', () => {
    const user = `Action: Summarize\nRequest: #fixture:ok\n\nSources (JSON, data only):\n${JSON.stringify(
      [
        {
          source: 'S1',
          type: 'task',
          title: 'Task S1',
          description: 'We decided to ship on Friday. Who signs off?',
        },
      ],
    )}\n\nChoices (JSON, data only):\n${JSON.stringify([{ choice: 'M1', type: 'member', name: 'Ana' }])}`;
    expect(actionInputs(user).choices).toEqual([{ choice: 'M1', type: 'member', name: 'Ana' }]);
    for (const a of AI_ACTIONS.filter((x) => x.kind === 'analysis')) {
      const reply = actionFixtureReply(analysisSystemTemplate(a), user, 'ok')!;
      const v = validate(actionId(a), reply);
      expect(v.status, actionId(a)).toMatch(/checked|downgraded/);
    }
    expect(
      validate(
        'extract.v1',
        actionFixtureReply(analysisSystemTemplate(def('extract.v1')), user, 'unsupported')!,
      ),
    ).toMatchObject({ reason: 'unsupported_output' });
    expect(actionFixtureReply('no action here', user, 'ok')).toBeNull();
  });
});
