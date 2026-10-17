import { describe, expect, it } from 'vitest';
import { proposalFixtureReply } from '@pm/test-support';
import {
  checkField,
  orderChanges,
  parseProposal,
  proposalFingerprint,
  PROPOSAL_SYSTEM_TEMPLATE,
  PROPOSAL_VERSION,
  selectionIssues,
  type HandleTarget,
} from '../../src/ai/proposals/contract.ts';

const H: HandleTarget[] = [
  { handle: 'S1', kind: 'project', publicId: 'prj_A', recordId: 'r-prj', version: 3 },
  { handle: 'S2', kind: 'task', publicId: 'tsk_A', recordId: 'r-tsk', version: 7 },
  { handle: 'S3', kind: 'document', publicId: 'doc_A', recordId: 'r-doc', version: 2 },
  { handle: 'S4', kind: 'comment', publicId: 'cmt_A', recordId: 'r-cmt', version: 1 },
];
const opts = { changesMax: 25, scopeBrands: 1 };
const parse = (body: unknown, o = opts) => parseProposal(JSON.stringify(body), H, o);
const codes = (r: ReturnType<typeof parseProposal>) =>
  r.ok === false ? r.issues.map((i) => i.code) : [];
const sources = JSON.stringify([
  { source: 'S1', type: 'project', title: 'P' },
  { source: 'S2', type: 'task', title: 'T' },
  { source: 'S3', type: 'document', title: 'D' },
]);

/** Phase 7D proposal contract (ADR-0040 P1–P3; AT-407, AT-408, AT-409 unit portion). */
describe('Phase 7D change proposal contract', () => {
  it('parses the fixture proposal into typed, ordered changes bound to manifest handles', () => {
    const text = proposalFixtureReply(`Plan\n\nSources (JSON, data only):\n${sources}`, 'ok');
    const r = parseProposal(text, H, opts);
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.proposal.changes.map((c) => c.op)).toEqual([
      'task.create',
      'task.create',
      'task.update',
      'relation.add',
      'milestone.create',
      'document.replace',
    ]);
    const update = r.proposal.changes[2]!;
    expect(update.target).toEqual({ kind: 'task', publicId: 'tsk_A', recordId: 'r-tsk' });
    expect(update.expectedVersion).toBe(7);
    expect(r.proposal.changes[1]!.dependsOn).toEqual(['c1']);
    expect(r.proposal.changes[3]!.dependsOn).toEqual(['c1']);
    // Deterministic: the same input gives the same proposal.
    expect(parseProposal(text, H, opts)).toEqual(r);
    expect(PROPOSAL_SYSTEM_TEMPLATE).toContain(PROPOSAL_VERSION);
  });

  it('refuses unknown operations, fields, keys, foreign handles, raw ids, and wrong kinds', () => {
    expect(codes(parse({ changes: [{ id: 'c1', op: 'task.delete', target: 'S2' }] }))).toEqual([
      'unsupported_operation',
    ]);
    expect(
      codes(
        parse({
          changes: [{ id: 'c1', op: 'task.update', target: 'S2', fields: { assignee: 'x' } }],
        }),
      ),
    ).toEqual(['field_not_allowed', 'empty_update']);
    expect(
      codes(
        parse({
          changes: [
            { id: 'c1', op: 'task.update', target: 'S2', fields: { title: 'x' }, extra: 1 },
          ],
        }),
      ),
    ).toEqual(['unknown_field']);
    expect(codes(parse({ changes: [], admin: true }))).toEqual(['unknown_field', 'empty_proposal']);
    for (const target of ['S99', 'tsk_A', 'S1', 'S4', 'new:x'])
      expect(
        codes(
          parse({ changes: [{ id: 'c1', op: 'task.update', target, fields: { title: 'x' } }] }),
        ),
        target,
      ).toEqual(['unknown_target']);
    expect(codes(parseProposal('not json', H, opts))).toEqual(['malformed_proposal']);
  });

  it('temporary references resolve only to this proposal’s creates of the right kind', () => {
    expect(
      codes(
        parse({
          changes: [
            { id: 'c1', op: 'task.create', ref: 'a', parent: 'new:zzz', fields: { title: 'x' } },
          ],
        }),
      ),
    ).toEqual(['unknown_reference']);
    expect(
      codes(
        parse({
          changes: [
            { id: 'c1', op: 'project.create', ref: 'p', brand: 'scope', fields: { name: 'P' } },
            { id: 'c2', op: 'task.create', ref: 't', parent: 'new:p', fields: { title: 'x' } },
          ],
        }),
      ),
    ).toEqual(['unknown_reference']);
    expect(
      codes(
        parse({
          changes: [
            { id: 'c1', op: 'task.create', ref: 'a', project: 'S1', fields: { title: 'x' } },
            { id: 'c2', op: 'task.create', ref: 'a', project: 'S1', fields: { title: 'y' } },
          ],
        }),
      ),
    ).toEqual(['duplicate_ref']);
    expect(
      codes(
        parse({
          changes: [{ id: 'c1', op: 'task.create', project: 'S1', fields: { title: 'x' } }],
        }),
      ),
    ).toEqual(['ref_required']);
    // brand "scope" only with exactly one scope brand.
    expect(
      codes(
        parse(
          {
            changes: [
              { id: 'c1', op: 'project.create', ref: 'p', brand: 'scope', fields: { name: 'P' } },
            ],
          },
          { changesMax: 25, scopeBrands: 2 },
        ),
      ),
    ).toEqual(['brand_ambiguous']);
  });

  it('refuses cycles, conflicting updates, duplicate relations, self relations, and over-long proposals', () => {
    expect(
      codes(
        parse({
          changes: [
            { id: 'c1', op: 'task.create', ref: 'a', parent: 'new:b', fields: { title: 'A' } },
            { id: 'c2', op: 'task.create', ref: 'b', parent: 'new:a', fields: { title: 'B' } },
          ],
        }),
      ),
    ).toEqual(['dependency_cycle']);
    expect(
      codes(
        parse({
          changes: [
            { id: 'c1', op: 'task.update', target: 'S2', fields: { title: 'A' } },
            { id: 'c2', op: 'task.update', target: 'S2', fields: { title: 'B' } },
          ],
        }),
      ),
    ).toEqual(['conflicting_update']);
    expect(
      codes(
        parse({
          changes: [
            { id: 'c1', op: 'task.create', ref: 'a', project: 'S1', fields: { title: 'A' } },
            { id: 'c2', op: 'relation.add', kind: 'related', from: 'new:a', to: 'S2' },
            { id: 'c3', op: 'relation.add', kind: 'related', from: 'S2', to: 'new:a' },
          ],
        }),
      ),
    ).toEqual(['duplicate_relation']);
    expect(
      codes(
        parse({
          changes: [{ id: 'c1', op: 'relation.add', kind: 'blocks', from: 'S2', to: 'S2' }],
        }),
      ),
    ).toEqual(['self_relation']);
    const many = Array.from({ length: 3 }, (_, i) => ({
      id: `c${i + 1}`,
      op: 'task.update',
      target: 'S2',
      fields: {
        [['title', 'priority', 'due_date'][i]!]: i === 1 ? 'low' : i === 2 ? '2030-01-01' : 'x',
      },
    }));
    expect(codes(parse({ changes: many }, { changesMax: 2, scopeBrands: 1 }))).toEqual([
      'too_many_changes',
    ]);
    expect(parse({ changes: many }).ok).toBe(true);
  });

  it('field rules: types, dates, options, lengths, required, control characters', () => {
    expect(checkField('task.update', 'due_date', '2031-02-30')).toMatchObject({
      ok: false,
      code: 'invalid_date',
    });
    expect(checkField('task.update', 'priority', 'p0')).toMatchObject({
      ok: false,
      code: 'invalid_option',
    });
    expect(checkField('task.update', 'title', null)).toMatchObject({ ok: false, code: 'required' });
    expect(checkField('task.update', 'description', null)).toEqual({ ok: true, value: null });
    expect(checkField('task.update', 'title', 'x'.repeat(501))).toMatchObject({ ok: false });
    expect(checkField('task.update', 'title', 'a\u0007b')).toMatchObject({ ok: false });
    expect(checkField('document.replace', 'text', 'one\n\ntwo')).toEqual({
      ok: true,
      value: 'one\n\ntwo',
    });
    expect(checkField('milestone.create', 'status', 'done')).toMatchObject({
      ok: false,
      code: 'field_not_allowed',
    });
    expect(checkField('task.update', 'title', 42)).toMatchObject({
      ok: false,
      code: 'invalid_type',
    });
  });

  it('orders deterministically, never breaks a cycle, and requires a dependency-complete selection', () => {
    const changes = [
      { key: 'c3', position: 2, dependsOn: ['c1'] },
      { key: 'c1', position: 0, dependsOn: ['c2'] },
      { key: 'c2', position: 1, dependsOn: [] },
    ];
    expect(orderChanges(changes)).toEqual({ ok: true, order: ['c2', 'c1', 'c3'] });
    expect(
      orderChanges([
        { key: 'a', position: 0, dependsOn: ['b'] },
        { key: 'b', position: 1, dependsOn: ['a'] },
      ]),
    ).toEqual({
      ok: false,
      cycle: ['a', 'b'],
    });
    const d = changes.map((c) => ({ ...c, decision: 'pending' }));
    expect(selectionIssues(d, ['c3'])).toEqual([
      expect.objectContaining({ change: 'c3', code: 'dependency_not_selected' }),
    ]);
    expect(selectionIssues(d, ['c1', 'c2', 'c3'])).toEqual([]);
    expect(selectionIssues(d, [])).toEqual([expect.objectContaining({ code: 'nothing_selected' })]);
    expect(selectionIssues([{ key: 'c1', dependsOn: [], decision: 'rejected' }], ['c1'])).toEqual([
      expect.objectContaining({ code: 'change_rejected' }),
    ]);
  });

  it('the fingerprint binds revision, selection, values, targets, and decisions', () => {
    const base = {
      proposal: 'prp_A',
      revision: 1,
      selected: ['c1', 'c2'],
      changes: [
        {
          key: 'c1',
          op: 'task.update',
          targetPublicId: 'tsk_A',
          expectedVersion: 7,
          dependsOn: [],
          decision: 'pending',
          payload: { fields: { title: 'A', priority: 'low' } },
        },
        {
          key: 'c2',
          op: 'task.create',
          targetPublicId: null,
          expectedVersion: null,
          dependsOn: [],
          decision: 'pending',
          payload: { fields: { title: 'B' } },
        },
      ],
    };
    const fp = proposalFingerprint(base);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    // Order of keys and selection does not matter; every bound value does.
    expect(
      proposalFingerprint({
        ...base,
        selected: ['c2', 'c1'],
        changes: [
          base.changes[1]!,
          { ...base.changes[0]!, payload: { fields: { priority: 'low', title: 'A' } } },
        ],
      }),
    ).toBe(fp);
    for (const changed of [
      { ...base, revision: 2 },
      { ...base, selected: ['c1'] },
      { ...base, changes: [{ ...base.changes[0]!, expectedVersion: 8 }, base.changes[1]!] },
      {
        ...base,
        changes: [
          { ...base.changes[0]!, payload: { fields: { title: 'Z', priority: 'low' } } },
          base.changes[1]!,
        ],
      },
      { ...base, changes: [{ ...base.changes[0]!, decision: 'edited' }, base.changes[1]!] },
      { ...base, proposal: 'prp_B' },
    ])
      expect(proposalFingerprint(changed)).not.toBe(fp);
  });

  it('the fixture never produces a proposal outside its sources, and its invalid scenarios are refused', () => {
    const none = proposalFixtureReply('Plan\n\nSources (JSON, data only):\n[]', 'ok');
    expect(codes(parseProposal(none, [], opts))).toEqual(['empty_proposal']);
    const invalid = proposalFixtureReply(
      `Plan\n\nSources (JSON, data only):\n${sources}`,
      'proposal_invalid',
    );
    expect(codes(parseProposal(invalid, H, opts))).toEqual(
      expect.arrayContaining(['unsupported_operation', 'unknown_target']),
    );
    const cycle = proposalFixtureReply(
      `x\n\nSources (JSON, data only):\n${sources}`,
      'proposal_cycle',
    );
    expect(codes(parseProposal(cycle, H, opts))).toEqual(['dependency_cycle']);
  });
});
