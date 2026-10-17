import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { richTextFromPlain } from '@pm/contracts';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import {
  FIXTURE_MODEL_KEY,
  startAiProviderFixture,
  type AiProviderFixture,
} from '@pm/test-support';
import type { Caller } from '@pm/tenancy';
import type { WorkerRuntime } from '@pm/platform';
import { Migrator } from '@pm/db';
import {
  eraseAiContentRows,
  indexWorkspace,
  MODELS,
  type ModelEntry,
  type SearchJobDeps,
} from '@pm/work';
import { aiWorker, drain, enableAi, fixtureAi, stepped, stepUp } from './ai-support.ts';
import {
  apply,
  join,
  membershipOf,
  mutation,
  workEnv,
  workspaceIdOf,
  workspaceWith,
  type WorkEnv,
} from './fixture.ts';

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; issues?: Array<{ code: string; pointer?: string }> };
    return { code: err.code, issues: err.issues ?? [] };
  }
  throw new Error('expected a refusal');
};
const codes = (r: { issues: Array<{ code: string }> }) => r.issues.map((i) => i.code);
const para = (id: string, text: string) => ({ id, type: 'paragraph', runs: [{ text }] });

const FIXTURE = MODELS.find((m) => m.key === FIXTURE_MODEL_KEY)!;
const VERIFIED = {
  state: 'verified' as const,
  source: 'https://example.invalid/test-only',
  checkedOn: '2026-10-17',
  note: 'Test-only evidence for the non-synthetic refusal path.',
};
/** A non-synthetic variant of the fixture model (test-only; the registry is unchanged). */
const PAID: ModelEntry = {
  ...FIXTURE,
  synthetic: false,
  price: { ...FIXTURE.price, synthetic: false, verification: VERIFIED },
  inputBound: { ...FIXTURE.inputBound, verification: VERIFIED },
};

type AnyView = Awaited<ReturnType<WorkEnv['svc']['getAiProposal']>>;
/** The reviewable (content present) shape of a proposal view. */
type View = Extract<AnyView, { trust_note: string }>;

/**
 * Phase 7D change proposals (ADR-0040; AI-023, AI-024, AI-025, AI-029; AT-407–AT-420). Three
 * workspaces; owner, editing members, a read-only member, a guest with an explicit share; a
 * sensitive brand. Proposals come only from the deterministic provider fixture through the real
 * run APIs (no endpoint accepts client JSON as model output); application runs the ordinary
 * domain commands in one transaction.
 */
describe('Phase 7D change proposals', () => {
  let db: TestDatabase;
  let fx: AiProviderFixture;
  let env: WorkEnv;
  let worker: WorkerRuntime;
  let ws: string;
  let wsId: string;
  const P = {} as Record<'owner' | 'member' | 'other' | 'read_only' | 'guest' | 'leaver', Caller>;
  const B = {} as Record<'Harbor' | 'Vault', string>;
  const R = {} as Record<'project' | 'task' | 'doc' | 'vault' | 'shared', string>;
  const X = {} as { ws: string; owner: Caller; task: string; wsC: string; ownerC: Caller };
  const sql = async (text: string, params: unknown[] = []) => (await db.admin(text, params)).rows;
  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const sources = () => [
    { type: 'project', id: R.project },
    { type: 'task', id: R.task },
    { type: 'document', id: R.doc },
  ];

  /** Generates a proposal through preview → proposal run → worker → settlement. */
  const propose = async (
    who: Caller,
    scenario = 'ok',
    include: Array<{ type: string; id: string }> = sources(),
    space = ws,
  ) => {
    const m = await env.svc.previewAiContext(who, space, {
      scope: { brands: [B.Harbor] },
      include,
    });
    const run = await env.svc.startAiProposalRun(
      who,
      space,
      {
        scope: { brands: [B.Harbor] },
        include,
        question: `Plan the follow-up #fixture:${scenario}`,
        confirm_cost: true,
        manifest_digest: m.digest,
      },
      mutation(),
    );
    await drain(db, worker, run.data.id);
    const view = await env.svc.getAiRun(who, space, run.data.id);
    return { run: run.data.id, outcome: view.content.proposal! };
  };
  const proposal = async (
    who: Caller,
    scenario = 'ok',
    include?: Array<{ type: string; id: string }>,
  ) => {
    const { outcome } = await propose(who, scenario, include);
    expect(outcome).toMatchObject({ status: 'proposed' });
    return (await env.svc.getAiProposal(who, ws, outcome.id)) as View;
  };
  const approve = (who: Caller, v: View, req = mutation()) =>
    env.svc.approveAiProposal(
      who,
      ws,
      v.id,
      { revision: v.revision, fingerprint: v.fingerprint },
      req,
    );
  const applyIt = (who: Caller, v: View, req = mutation()) =>
    env.svc.applyAiProposal(
      who,
      ws,
      v.id,
      { revision: v.revision, fingerprint: v.fingerprint },
      req,
    );
  const taskCount = async () =>
    Number(
      (
        await sql(
          `SELECT count(*)::int AS n FROM work.task t JOIN core.record r ON r.id = t.id WHERE r.workspace_id = $1`,
          [wsId],
        )
      )[0]!.n,
    );

  beforeAll(async () => {
    db = await createTestDatabase();
    fx = await startAiProviderFixture();
    env = workEnv(db, { ai: fixtureAi(fx) });
    worker = await aiWorker(env);
    const w = await workspaceWith(env, db, ['Harbor', 'Vault']);
    P.owner = w.owner;
    ws = w.ws;
    Object.assign(B, w.brands);
    wsId = await workspaceIdOf(db, ws);
    await stepped(env, () =>
      env.svc.setSensitivity(P.owner, ws, B.Vault, { is_sensitive: true }, stepUp(0)),
    );
    P.member = await join(env, db, P.owner, ws, { kind: 'member', role: 'member' });
    P.other = await join(env, db, P.owner, ws, { kind: 'member', role: 'member' });
    P.leaver = await join(env, db, P.owner, ws, { kind: 'member', role: 'member' });
    P.read_only = await join(env, db, P.owner, ws, { kind: 'member', role: 'read_only' });
    for (const who of [P.member, P.other, P.leaver] as const)
      await apply(env, P.owner, ws, {
        kind: 'brand_grant',
        brand: B.Harbor,
        principal: await mem(who),
        level: 'edit',
      });
    await apply(env, P.owner, ws, {
      kind: 'brand_grant',
      brand: B.Harbor,
      principal: await mem(P.read_only),
      level: 'view',
    });
    await enableAi(env, P.owner, ws);
    R.project = (
      await env.svc.createProject(
        P.owner,
        ws,
        { brand: B.Harbor, name: 'Falcon launch' },
        mutation(),
      )
    ).data.id;
    R.task = (
      await env.svc.createTask(
        P.owner,
        ws,
        {
          brand: B.Harbor,
          project: R.project,
          title: 'Falcon launch checklist',
          description: richTextFromPlain('Finish the falcon checklist.'),
        },
        mutation(),
      )
    ).data.id;
    R.shared = (
      await env.svc.createTask(
        P.owner,
        ws,
        { brand: B.Harbor, title: 'Falcon partner brief' },
        mutation(),
      )
    ).data.id;
    R.vault = (
      await env.svc.createTask(
        P.owner,
        ws,
        { brand: B.Vault, title: 'Omega secret plan' },
        mutation(),
      )
    ).data.id;
    const d = (
      await env.svc.createDocument(
        P.owner,
        ws,
        { title: 'Falcon notes', brand: B.Harbor },
        mutation(),
      )
    ).data;
    await env.svc.saveContent(
      P.owner,
      ws,
      d.id,
      {
        base_version: d.content_version,
        content: { v: 2, blocks: [para('par_1', 'Original falcon notes.')] },
      },
      mutation(),
    );
    R.doc = d.id;
    P.guest = await join(env, db, P.owner, ws, {
      kind: 'guest',
      records: [{ record: R.shared, level: 'comment' }],
    });
    const b = await workspaceWith(env, db, ['Bravo']);
    X.ws = b.ws;
    X.owner = b.owner;
    X.task = (
      await env.svc.createTask(
        b.owner,
        b.ws,
        { brand: b.brands.Bravo, title: 'Bravo private' },
        mutation(),
      )
    ).data.id;
    const c = await workspaceWith(env, db, ['Charlie']);
    X.wsC = c.ws;
    X.ownerC = c.owner;
    await indexWorkspace(
      {
        tenant: env.h.worker,
        discovery: undefined as never,
        metrics: env.h.telemetry.metrics,
        logger: env.h.logger,
      } satisfies SearchJobDeps,
      wsId,
    );
  }, 300_000);

  afterAll(async () => {
    await worker?.stop?.();
    await fx?.close();
    await env?.h.close();
    await db?.drop();
  });

  it('AT-407 a proposal run produces a typed, ordered, reviewable proposal; nothing is applied', async () => {
    const before = await taskCount();
    const v = await proposal(P.member);
    expect(await taskCount()).toBe(before);
    expect(v).toMatchObject({
      type: 'change_proposal',
      state: 'open',
      revision: 1,
      synthetic: true,
      content: { state: 'present' },
      title: 'Plan the follow-up',
      can: { edit: true, approve: true, apply: false, reject: true },
    });
    expect(v.trust_note).toMatch(/AI-generated/);
    expect(v.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(v.changes.map((c) => [c.key, c.op])).toEqual([
      ['c1', 'task.create'],
      ['c2', 'task.create'],
      ['c3', 'task.update'],
      ['c4', 'relation.add'],
      ['c5', 'milestone.create'],
      ['c6', 'document.replace'],
    ]);
    // Temporary references resolve inside the proposal only, with explicit dependencies.
    const c2 = v.changes.find((c) => c.key === 'c2')!;
    expect(c2.parent).toEqual({ new: 'draft', change: 'c1' });
    expect(c2.depends_on).toEqual(['c1']);
    expect(v.order.indexOf('c1')).toBeLessThan(v.order.indexOf('c2'));
    // The diff shows current authorized values before and the proposed values after.
    const c3 = v.changes.find((c) => c.key === 'c3')!;
    expect(c3.target).toMatchObject({ type: 'task', id: R.task, out_of_date: false });
    expect(c3.fields).toEqual(
      expect.arrayContaining([{ field: 'priority', before: 'none', after: 'urgent' }]),
    );
    expect(v.changes.find((c) => c.key === 'c6')!.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'text', before: 'Original falcon notes.' }),
      ]),
    );
    expect(v.history.map((h) => h.kind)).toEqual(['generated']);
    // References only in the history; content only in the proposal tables.
    const events = await sql(`SELECT * FROM ai.proposal_event WHERE workspace_id = $1`, [wsId]);
    expect(JSON.stringify(events)).not.toContain('follow-up');
    const list = await env.svc.listAiProposals(P.member, ws);
    expect(list.items[0]).toMatchObject({ id: v.id, state: 'open' });
    // Proposals are personal to the person who started the run.
    expect((await refusal(env.svc.getAiProposal(P.other, ws, v.id))).code).toBe('not_found');
    expect((await env.svc.listAiProposals(P.other, ws)).items).toEqual([]);
  });

  it('AT-408 invalid, cyclic, and out-of-manifest proposals are refused whole with reasons; no proposal is stored', async () => {
    const before = Number((await sql(`SELECT count(*)::int AS n FROM ai.change_proposal`))[0]!.n);
    const bad = await propose(P.member, 'proposal_invalid');
    expect(bad.outcome).toMatchObject({ status: 'rejected', reason: 'invalid_proposal', id: null });
    expect(bad.outcome.issues.map((i) => (i as { code: string }).code)).toEqual(
      expect.arrayContaining(['unsupported_operation', 'unknown_target']),
    );
    const cyc = await propose(P.member, 'proposal_cycle');
    expect(cyc.outcome).toMatchObject({ status: 'rejected', reason: 'invalid_proposal' });
    const truncated = await propose(P.member, 'truncate_valid');
    expect(truncated.outcome).toMatchObject({ status: 'rejected', reason: 'truncated_response' });
    expect(Number((await sql(`SELECT count(*)::int AS n FROM ai.change_proposal`))[0]!.n)).toBe(
      before,
    );
  });

  it('AT-409 edits make a new revision, invalidate approval, and keep the selection dependency-complete', async () => {
    let v = await proposal(P.member);
    const approved = await approve(P.member, v);
    expect(approved.data).toMatchObject({
      state: 'approved',
      approval: { valid: true, revision: 1 },
    });
    // An edit of a value: new revision and fingerprint; the approval is superseded.
    const edited = await env.svc.updateAiProposal(
      P.member,
      ws,
      v.id,
      { revision: 1, changes: { c1: { fields: { title: 'Draft the revised plan' } } } },
      mutation(),
    );
    expect(edited.data).toMatchObject({ state: 'open', revision: 2, approval: null });
    expect(edited.data.fingerprint).not.toBe(v.fingerprint);
    expect(edited.data.changes.find((c) => c.key === 'c1')).toMatchObject({ decision: 'edited' });
    expect(edited.data.history.map((h) => h.kind)).toEqual([
      'generated',
      'approved',
      'approval_superseded',
      'edited',
    ]);
    // The old approval cannot apply the new revision.
    expect(codes(await refusal(applyIt(P.member, { ...v, revision: 2 } as View)))).toEqual([
      'approval_required',
    ]);
    // A stale revision is refused (the client keeps its edits locally).
    expect(
      codes(
        await refusal(
          env.svc.updateAiProposal(
            P.member,
            ws,
            v.id,
            { revision: 1, selected: ['c3'] },
            mutation(),
          ),
        ),
      ),
    ).toEqual(['revision_changed']);
    // Values go through the same field rules; unknown fields and changes are refused.
    expect(
      codes(
        await refusal(
          env.svc.updateAiProposal(
            P.member,
            ws,
            v.id,
            { revision: 2, changes: { c3: { fields: { due_date: 'soon', owner: 'x' } } } },
            mutation(),
          ),
        ),
      ),
    ).toEqual(expect.arrayContaining(['invalid_date', 'field_not_allowed']));
    // Deselecting a dependency while keeping its dependant cannot be approved.
    v = (
      await env.svc.updateAiProposal(
        P.member,
        ws,
        v.id,
        { revision: 2, selected: ['c2', 'c3', 'c5', 'c6'] },
        mutation(),
      )
    ).data as View;
    expect(v.selection_issues).toEqual([
      expect.objectContaining({ change: 'c2', code: 'dependency_not_selected' }),
    ]);
    expect(codes(await refusal(approve(P.member, v)))).toEqual(['dependency_not_selected']);
    // Rejecting a change removes it from the selection and it cannot be reselected.
    v = (
      await env.svc.updateAiProposal(
        P.member,
        ws,
        v.id,
        { revision: 3, changes: { c5: { decision: 'rejected' } }, selected: ['c3', 'c6'] },
        mutation(),
      )
    ).data as View;
    expect(v.changes.find((c) => c.key === 'c5')).toMatchObject({
      decision: 'rejected',
      selected: false,
    });
    expect(
      codes(
        await refusal(
          env.svc.updateAiProposal(
            P.member,
            ws,
            v.id,
            { revision: 4, selected: ['c3', 'c5'] },
            mutation(),
          ),
        ),
      ),
    ).toEqual(['change_rejected']);
  });

  it('AT-410 approval binds the approver, revision, selection, and fingerprint, and expires', async () => {
    const v = await proposal(P.member);
    // Apply needs an approval.
    expect(codes(await refusal(applyIt(P.member, v)))).toEqual(['approval_required']);
    // A forged fingerprint is refused at approval and at apply.
    expect(
      codes(
        await refusal(
          env.svc.approveAiProposal(
            P.member,
            ws,
            v.id,
            { revision: 1, fingerprint: 'a'.repeat(64) },
            mutation(),
          ),
        ),
      ),
    ).toEqual(['fingerprint_mismatch']);
    await approve(P.member, v);
    expect(
      codes(
        await refusal(
          env.svc.applyAiProposal(
            P.member,
            ws,
            v.id,
            { revision: 1, fingerprint: 'b'.repeat(64) },
            mutation(),
          ),
        ),
      ),
    ).toEqual(['approval_mismatch']);
    // A forged approval row (changed fingerprint) does not match what would be applied.
    await sql(
      `UPDATE ai.proposal_approval SET fingerprint = $2 WHERE proposal_id = (SELECT id FROM ai.change_proposal WHERE public_id = $1) AND state = 'active'`,
      [v.id, 'c'.repeat(64)],
    );
    expect(codes(await refusal(applyIt(P.member, v)))).toEqual(['approval_mismatch']);
    await sql(
      `UPDATE ai.proposal_approval SET fingerprint = $2 WHERE proposal_id = (SELECT id FROM ai.change_proposal WHERE public_id = $1) AND state = 'active'`,
      [v.id, v.fingerprint],
    );
    // Expiry.
    await sql(
      `UPDATE ai.proposal_approval SET created_at = now() - interval '2 days', expires_at = now() - interval '1 minute' WHERE proposal_id = (SELECT id FROM ai.change_proposal WHERE public_id = $1) AND state = 'active'`,
      [v.id],
    );
    expect(codes(await refusal(applyIt(P.member, v)))).toEqual(['approval_expired']);
    const shown = await env.svc.getAiProposal(P.member, ws, v.id);
    expect(shown.can.apply).toBe(false);
    // Another person never sees or applies it; a foreign workspace or unknown id is not found.
    expect((await refusal(applyIt(P.other, v))).code).toBe('not_found');
    expect((await refusal(env.svc.getAiProposal(X.owner, X.ws, v.id))).code).toBe('not_found');
    expect(
      (await refusal(env.svc.getAiProposal(P.member, ws, 'prp_00000000000000000000000000'))).code,
    ).toBe('not_found');
    expect((await refusal(env.svc.getAiProposal(P.member, ws, 'tsk_x'))).code).toBe('not_found');
  });

  it('AT-411 Apply runs every selected change through the domain commands atomically, with honest provenance, once', async () => {
    const v = await proposal(P.member);
    await approve(P.member, v);
    const before = await taskCount();
    const req = mutation();
    const done = await applyIt(P.member, v, req);
    expect(done.data).toMatchObject({
      state: 'applied',
      application: { outcome: 'applied', applied_count: 6, failed_count: 0 },
    });
    expect(done.data.changes.every((c) => c.applied_state === 'applied')).toBe(true);
    expect(await taskCount()).toBe(before + 2);
    const draft = done.data.changes.find((c) => c.key === 'c1')!.result as { id: string };
    const sub = done.data.changes.find((c) => c.key === 'c2')!.result as { id: string };
    // Tasks are AI drafts the person created; the parent link used the new task's id.
    const rows = await sql(
      `SELECT r.public_id, r.source_kind, t.origin_kind, p.public_id AS parent
         FROM work.task t JOIN core.record r ON r.id = t.id
         LEFT JOIN core.record p ON p.id = t.parent_task_id
        WHERE r.public_id = ANY($1)`,
      [[draft.id, sub.id]],
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          public_id: draft.id,
          source_kind: 'ai_proposal',
          origin_kind: 'ai_draft',
        }),
        expect.objectContaining({
          public_id: sub.id,
          source_kind: 'ai_proposal',
          parent: draft.id,
        }),
      ]),
    );
    const task = await env.svc.getTask(P.owner, ws, R.task);
    expect(task).toMatchObject({ priority: 'urgent', due_date: '2031-03-15' });
    // Audit: the person is the actor, the source is the proposal, the cause is the AI action.
    const audit = await sql(
      `SELECT a.actor_type, a.source_kind, a.operation_id, a.causation_id, o.kind
         FROM audit.audit_event a JOIN exec.operation o ON o.id = a.operation_id
        WHERE a.workspace_id = $1 AND o.kind = 'proposal_apply'`,
      [wsId],
    );
    expect(audit.length).toBeGreaterThanOrEqual(6);
    expect(new Set(audit.map((a) => a.actor_type))).toEqual(new Set(['human']));
    expect(audit.filter((a) => a.source_kind === 'ai_proposal').length).toBeGreaterThanOrEqual(6);
    expect(audit.every((a) => a.causation_id !== null)).toBe(true);
    const events = await sql(
      `SELECT event_type FROM exec.outbox_event WHERE workspace_id = $1 AND event_type = 'ai.proposal.applied'`,
      [wsId],
    );
    expect(events).toHaveLength(1);
    // The same key replays the result through current authority; nothing runs twice.
    const replay = await applyIt(P.member, v, req);
    expect(replay.replayed).toBe(true);
    expect(await taskCount()).toBe(before + 2);
    expect(
      await sql(
        `SELECT count(*)::int AS n FROM exec.outbox_event WHERE workspace_id = $1 AND event_type = 'ai.proposal.applied'`,
        [wsId],
      ),
    ).toEqual([{ n: 1 }]);
    // A new key cannot apply it again; an applied proposal cannot be edited.
    expect(codes(await refusal(applyIt(P.member, v)))).toEqual(['proposal_already_applied']);
    expect(
      codes(
        await refusal(
          env.svc.updateAiProposal(
            P.member,
            ws,
            v.id,
            { revision: 1, selected: ['c3'] },
            mutation(),
          ),
        ),
      ),
    ).toEqual(['proposal_closed']);
  });

  it('AT-412 one failing change rolls back every change; the attempt is reported truthfully with no success event', async () => {
    const v = await proposal(P.member);
    await approve(P.member, v);
    const before = await taskCount();
    const eventsBefore = (
      await sql(`SELECT count(*)::int AS n FROM exec.outbox_event WHERE workspace_id = $1`, [wsId])
    )[0]!.n;
    // The task changes after approval (stale conflict).
    const cur = await env.svc.getTask(P.owner, ws, R.task);
    await env.svc.updateTask(
      P.owner,
      ws,
      R.task,
      {
        version: cur.version,
        changes: { title: { base: cur.title, value: 'Falcon launch checklist (renamed)' } },
      },
      mutation(),
    );
    const out = await applyIt(P.member, v);
    expect(out.data).toMatchObject({
      state: 'failed',
      application: { outcome: 'failed', applied_count: 0, failed_count: 1 },
    });
    const states = Object.fromEntries(out.data.changes.map((c) => [c.key, c.applied_state]));
    expect(states).toEqual({
      c1: 'rolled_back',
      c2: 'rolled_back',
      c3: 'failed',
      c4: 'blocked',
      c5: 'blocked',
      c6: 'blocked',
    });
    expect(out.data.changes.find((c) => c.key === 'c3')!.failure).toMatchObject({
      code: 'target_changed',
    });
    expect(await taskCount()).toBe(before);
    const op = await sql(
      `SELECT id, execution_state FROM exec.operation WHERE workspace_id = $1 AND kind = 'proposal_apply' ORDER BY created_at DESC LIMIT 1`,
      [wsId],
    );
    expect(op).toEqual([expect.objectContaining({ execution_state: 'failed' })]);
    // No domain event of a rolled-back change and no success event: only the operation's own
    // state changes are recorded under it.
    const under = await sql(`SELECT event_type FROM exec.outbox_event WHERE operation_id = $1`, [
      op[0]!.id,
    ]);
    expect(new Set(under.map((e) => e.event_type))).toEqual(
      new Set(['execution.operation.state_changed']),
    );
    expect(
      await sql(
        `SELECT count(*)::int AS n FROM exec.outbox_event WHERE workspace_id = $1 AND event_type = 'ai.proposal.applied'`,
        [wsId],
      ),
    ).toEqual([{ n: 1 }]);
    expect(
      Number(
        (
          await sql(`SELECT count(*)::int AS n FROM exec.outbox_event WHERE workspace_id = $1`, [
            wsId,
          ])
        )[0]!.n,
      ),
    ).toBeGreaterThan(Number(eventsBefore));
    // The approval was used; the person reviews the new value and approves again.
    expect(out.data.can.apply).toBe(false);
    expect(out.data.changes.find((c) => c.key === 'c3')!.target).toMatchObject({
      out_of_date: true,
    });
  });

  it('AT-413 only the selected changes are applied; the others are reported as not selected', async () => {
    let v = await proposal(P.member);
    v = (
      await env.svc.updateAiProposal(
        P.member,
        ws,
        v.id,
        { revision: 1, selected: ['c3', 'c6'] },
        mutation(),
      )
    ).data as View;
    await approve(P.member, v);
    const before = await taskCount();
    const out = await applyIt(P.member, v);
    expect(out.data.application).toMatchObject({ outcome: 'applied', applied_count: 2 });
    expect(
      Object.fromEntries(out.data.changes.map((c) => [c.key, [c.selected, c.applied_state]])),
    ).toEqual({
      c1: [false, 'not_applied'],
      c2: [false, 'not_applied'],
      c3: [true, 'applied'],
      c4: [false, 'not_applied'],
      c5: [false, 'not_applied'],
      c6: [true, 'applied'],
    });
    expect(await taskCount()).toBe(before);
    const doc = await env.svc.getDocument(P.member, ws, R.doc);
    expect(doc.content_version).toBeGreaterThan(1);
  });

  it('AT-414 workflow and field rules refuse at validation; the approval is not granted', async () => {
    const v = await proposal(P.member, 'proposal_unappliable');
    const madeBefore = await sql(
      `SELECT count(*)::int AS n FROM core.record WHERE workspace_id = $1 AND source_kind = 'ai_proposal'`,
      [wsId],
    );
    const check = await env.svc.validateAiProposal(P.member, ws, v.id, mutation());
    expect(check.valid).toBe(false);
    expect(check.changes.find((c) => c.key === 'c3')).toMatchObject({ state: 'invalid' });
    // Validation writes nothing.
    expect(
      await sql(
        `SELECT count(*)::int AS n FROM core.record WHERE workspace_id = $1 AND source_kind = 'ai_proposal'`,
        [wsId],
      ),
    ).toEqual(madeBefore);
    const r = await refusal(approve(P.member, v));
    expect(codes(r)[0]).toBe('proposal_invalid');
    expect(r.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ pointer: '/changes/c3' })]),
    );
    const shown = await env.svc.getAiProposal(P.member, ws, v.id);
    expect(shown).toMatchObject({ state: 'open', approval: null });
  });

  it('AT-415 revocation between stages withholds the proposal and invalidates its approval', async () => {
    const v = await proposal(P.leaver);
    await approve(P.leaver, v);
    await apply(env, P.owner, ws, {
      kind: 'brand_revoke',
      brand: B.Harbor,
      principal: await mem(P.leaver),
    });
    const shown = await env.svc.getAiProposal(P.leaver, ws, v.id);
    expect(shown).toMatchObject({
      content: { state: 'withheld' },
      title: null,
      changes: [],
      history: [],
    });
    expect(JSON.stringify(shown)).not.toContain('Falcon');
    expect((await refusal(applyIt(P.leaver, v))).code).toBeDefined();
    expect(await taskCount()).toBeGreaterThan(0);
    const listed = (await env.svc.listAiProposals(P.leaver, ws)).items.find((i) => i.id === v.id);
    expect(listed).toMatchObject({ title: null, content: { state: 'withheld' } });
    await apply(env, P.owner, ws, {
      kind: 'brand_grant',
      brand: B.Harbor,
      principal: await mem(P.leaver),
      level: 'edit',
    });
  });

  it('AT-416 read-only members, guests, and delegated callers cannot start, edit, approve, or apply', async () => {
    const m = await env.svc
      .previewAiContext(P.read_only, ws, { include: [{ type: 'task', id: R.task }] })
      .catch((e) => e);
    if (m && 'digest' in m)
      expect(
        (
          await refusal(
            env.svc.startAiProposalRun(
              P.read_only,
              ws,
              {
                include: [{ type: 'task', id: R.task }],
                question: 'x',
                confirm_cost: true,
                manifest_digest: m.digest,
              },
              mutation(),
            ),
          )
        ).code,
      ).toBe('forbidden');
    const v = await proposal(P.member);
    const delegated = {
      ...P.member,
      delegation: {
        principalType: 'personal_access_token',
        tokenId: 'x',
        tokenPublicId: 'pat_x',
        sourceKind: 'api',
        scopes: ['ai:execute'],
      },
    } as unknown as Caller;
    for (const call of [
      () =>
        env.svc.updateAiProposal(delegated, ws, v.id, { revision: 1, selected: [] }, mutation()),
      () => approve(delegated, v),
      () => applyIt(delegated, v),
      () => env.svc.rejectAiProposal(delegated, ws, v.id, {}, mutation()),
    ])
      // Refused before anything is read (the edge refuses bearer callers first; see the API test).
      expect(['forbidden', 'not_found']).toContain((await refusal(call())).code);
    expect((await refusal(env.svc.getAiProposal(P.guest, ws, v.id))).code).toBe('not_found');
    expect((await refusal(applyIt(P.read_only, v))).code).toBe('forbidden');
    // Rejecting closes it with the decision kept in history.
    const rejected = await env.svc.rejectAiProposal(
      P.member,
      ws,
      v.id,
      { reason: 'Not now' },
      mutation(),
    );
    expect(rejected.data).toMatchObject({ state: 'rejected', can: { apply: false, edit: false } });
    expect(rejected.data.history.at(-1)).toMatchObject({ kind: 'rejected' });
  });

  it('AT-417 concurrent Apply requests apply once; a different key finds the approval used', async () => {
    const v = await proposal(P.member);
    await approve(P.member, v);
    const before = await taskCount();
    const [a, b] = await Promise.allSettled([applyIt(P.member, v), applyIt(P.member, v)]);
    const ok = [a, b].filter((r) => r.status === 'fulfilled');
    const refused = [a, b].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0]!.reason as { issues: Array<{ code: string }> }).issues[0]!.code).toMatch(
      /proposal_already_applied|approval_required/,
    );
    expect(await taskCount()).toBe(before + 2);
    // Same key, concurrent: one applies, the other replays or is told it is in progress.
    const w = await proposal(P.member);
    await approve(P.member, w);
    const req = mutation();
    const both = await Promise.allSettled([applyIt(P.member, w, req), applyIt(P.member, w, req)]);
    expect(both.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(await taskCount()).toBe(before + 4);
    expect(
      await sql(
        `SELECT count(*)::int AS n FROM ai.proposal_application a JOIN ai.change_proposal p ON p.id = a.proposal_id WHERE p.public_id = $1`,
        [w.id],
      ),
    ).toEqual([{ n: 1 }]);
    // Timeout after commit, then a process restart: a fresh service instance replays the same key
    // from the durable idempotency record and never runs a change again.
    const restarted = workEnv(db, { ai: fixtureAi(fx) });
    try {
      const again = await restarted.svc.applyAiProposal(
        P.member,
        ws,
        w.id,
        { revision: w.revision, fingerprint: w.fingerprint },
        req,
      );
      expect(again.replayed).toBe(true);
      expect((again.data as View).application).toMatchObject({ outcome: 'applied' });
    } finally {
      await restarted.h.close();
    }
    expect(await taskCount()).toBe(before + 4);
    expect(
      await sql(
        `SELECT count(*)::int AS n FROM exec.outbox_event e JOIN ai.change_proposal p ON p.id = e.aggregate_id WHERE p.public_id = $1 AND e.event_type = 'ai.proposal.applied'`,
        [w.id],
      ),
    ).toEqual([{ n: 1 }]);
  });

  it('AT-418 erasure removes proposal content before or after Apply; applied records remain', async () => {
    const pending = await proposal(P.other);
    await approve(P.other, pending);
    const applied = await proposal(P.other);
    await approve(P.other, applied);
    const done = await applyIt(P.other, applied);
    const draft = (done.data.changes.find((c) => c.key === 'c1')!.result as { id: string }).id;
    // A retention pass first erases an unrelated member's nothing; then the member departs.
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, (tx) =>
      eraseAiContentRows(tx, { membershipId: '00000000-0000-7000-8000-000000000000' }),
    );
    const leaving = (await membershipOf(db, wsId, P.other.auth.account.id))!;
    const ownerM = (await membershipOf(db, wsId, P.owner.auth.account.id))!;
    const pv = await env.svc.previewChange(P.owner, ws, {
      kind: 'remove',
      member: leaving.public_id,
    });
    await stepped(env, () =>
      env.svc.removeMember(
        P.owner,
        ws,
        leaving.public_id,
        { preview_token: pv.preview_token, reassign_to: ownerM.public_id },
        mutation({ stepUpToken: 't' }),
      ),
    );
    const states = await sql(
      `SELECT public_id, content_state, title FROM ai.change_proposal WHERE public_id = ANY($1) ORDER BY public_id`,
      [[pending.id, applied.id]],
    );
    expect(states.every((s) => s.content_state === 'erased' && s.title === null)).toBe(true);
    expect(
      await sql(
        `SELECT e.kind FROM ai.proposal_event e JOIN ai.change_proposal p ON p.id = e.proposal_id WHERE p.public_id = $1 ORDER BY e.created_at DESC LIMIT 1`,
        [applied.id],
      ),
    ).toEqual([{ kind: 'erased' }]);
    // The applied attempt's outcome (references and codes only) stays as accountability.
    expect(
      await sql(
        `SELECT a.outcome, a.applied_count FROM ai.proposal_application a JOIN ai.change_proposal p ON p.id = a.proposal_id WHERE p.public_id = $1`,
        [applied.id],
      ),
    ).toEqual([{ outcome: 'applied', applied_count: 6 }]);
    const rows = await sql(
      `SELECT c.payload FROM ai.proposed_change c JOIN ai.change_proposal p ON p.id = c.proposal_id WHERE p.public_id = ANY($1)`,
      [[pending.id, applied.id]],
    );
    expect(rows.every((r) => r.payload === null)).toBe(true);
    expect(
      await sql(
        `SELECT a.state FROM ai.proposal_approval a JOIN ai.change_proposal p ON p.id = a.proposal_id WHERE p.public_id = $1`,
        [pending.id],
      ),
    ).toEqual([{ state: 'revoked' }]);
    // The departed member can no longer reach the workspace at all.
    expect((await refusal(applyIt(P.other, pending))).code).toBeDefined();
    // The applied task is an ordinary record and stays.
    expect(await env.svc.getTask(P.owner, ws, draft)).toMatchObject({ id: draft });
  });

  it('AT-419 tenant isolation: proposal tables are row-level secured and invisible across workspaces', async () => {
    for (const t of [
      'change_proposal',
      'proposed_change',
      'proposal_event',
      'proposal_approval',
      'proposal_application',
    ]) {
      const r = await sql(
        `SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ai' AND c.relname = $1`,
        [t],
      );
      expect(r).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    }
    const otherWs = await workspaceIdOf(db, X.ws);
    const seen = await env.h.worker.withWorkspace(otherWs, { module: 'test' }, (tx) =>
      tx.db.selectFrom('ai.change_proposal').selectAll().execute(),
    );
    expect(seen).toEqual([]);
    expect((await env.svc.listAiProposals(X.ownerC, X.wsC)).items).toEqual([]);
  });
  it('AT-420 export, retention, logs, metrics, and checkpoints keep proposal content inside the AI content boundary', async () => {
    env.h.sink.clear();
    const v = await proposal(P.member);
    await env.svc.updateAiProposal(
      P.member,
      ws,
      v.id,
      { revision: 1, changes: { c1: { fields: { title: 'MARKER-7D-QUILL plan' } } } },
      mutation(),
    );
    const exported = JSON.stringify(
      await env.svc.exportPortabilityHistory(P.member, ws, 'ai_history', {}),
    );
    expect(exported).toContain(v.id);
    expect(exported).toContain('MARKER-7D-QUILL');
    // Never in logs, job checkpoints, or the reference-only history.
    expect(env.h.sink.lines.join('\n')).not.toContain('MARKER-7D-QUILL');
    expect(env.h.sink.lines.join('\n')).not.toContain('Draft the follow-up plan');
    const checkpoints = await sql(`SELECT checkpoint FROM exec.job WHERE workspace_id = $1`, [
      wsId,
    ]);
    expect(JSON.stringify(checkpoints)).not.toContain('follow-up');
    const history = await sql(`SELECT * FROM ai.proposal_event WHERE workspace_id = $1`, [wsId]);
    expect(JSON.stringify(history)).not.toContain('MARKER-7D-QUILL');
    expect(env.h.telemetry.metrics.rejectedSamples).toBe(0);
    // Retention erases the content; the export then carries no content.
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, (tx) =>
      env.svc.eraseAiContent(tx, { before: new Date(Date.now() + 60_000) }),
    );
    const after = JSON.stringify(
      await env.svc.exportPortabilityHistory(P.member, ws, 'ai_history', {}),
    );
    expect(after).not.toContain('MARKER-7D-QUILL');
    expect((await env.svc.getAiProposal(P.member, ws, v.id)).content.state).toBe('erased');
  });

  it('AT-421 only the synthetic fixture may generate proposals in 7D; a paid model is refused before anything is sent', async () => {
    const paid = workEnv(db, {
      ai: fixtureAi(fx, { approvedModels: [FIXTURE_MODEL_KEY] }, [PAID]),
    });
    try {
      const m = await paid.svc.previewAiContext(P.owner, ws, {
        include: [{ type: 'task', id: R.task }],
      });
      const before = fx.control.received().length;
      const r = await refusal(
        paid.svc.startAiProposalRun(
          P.owner,
          ws,
          {
            include: [{ type: 'task', id: R.task }],
            question: 'Plan',
            confirm_cost: true,
            manifest_digest: m.digest,
          },
          mutation(),
        ),
      );
      expect(codes(r)).toEqual(['ai_proposal_generation_unavailable']);
      expect(fx.control.received().length).toBe(before);
    } finally {
      await paid.h.close();
    }
  });
  it('AT-424 live editing and a stale document refuse at validation and roll the whole Apply back', async () => {
    const v = await proposal(P.member);
    const live = (await env.svc.liveJoin(P.owner, ws, R.doc, {})) as { session: string };
    const check = await env.svc.validateAiProposal(P.member, ws, v.id, mutation());
    expect(check.changes.find((c) => c.key === 'c6')).toMatchObject({
      state: 'invalid',
      code: 'live_edit_in_progress',
    });
    expect(codes(await refusal(approve(P.member, v)))[0]).toBe('proposal_invalid');
    await env.svc.liveLeave(P.owner, ws, R.doc, { session: live.session });
    await approve(P.member, v);
    // The document gets a new version after approval: Apply refuses the whole selection.
    const d = await env.svc.getDocument(P.owner, ws, R.doc);
    await env.svc.saveContent(
      P.owner,
      ws,
      R.doc,
      {
        base_version: d.content_version,
        content: { v: 2, blocks: [para('par_1', 'Owner rewrote the notes.')] },
      },
      mutation(),
    );
    const before = await taskCount();
    const out = await applyIt(P.member, v);
    expect(out.data).toMatchObject({
      state: 'failed',
      application: { outcome: 'failed', applied_count: 0 },
    });
    expect(out.data.changes.find((c) => c.key === 'c6')).toMatchObject({
      applied_state: 'failed',
      failure: { code: 'target_changed' },
    });
    expect(
      out.data.changes.filter((c) => c.applied_state === 'rolled_back').map((c) => c.key),
    ).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(await taskCount()).toBe(before);
    const after = await env.svc.getDocument(P.owner, ws, R.doc);
    expect(after.content_version).toBe(d.content_version + 1);
  });

  it('AT-425 a narrower AI data-use policy withholds the proposal and refuses Apply; restoring it makes it reviewable again', async () => {
    const setClass = async (c: 'C0' | 'C1' | 'C2') => {
      const s = await env.svc.getAiSettings(P.owner, ws);
      await stepped(env, () =>
        env.svc.updateAiSettings(P.owner, ws, { max_data_class: c }, stepUp(s.version)),
      );
    };
    const v = await proposal(P.member);
    await approve(P.member, v);
    await setClass('C0');
    const shown = await env.svc.getAiProposal(P.member, ws, v.id);
    expect(shown).toMatchObject({ content: { state: 'withheld' }, changes: [] });
    expect(codes(await refusal(applyIt(P.member, v)))).toEqual(['proposal_sources_unavailable']);
    expect(
      JSON.stringify(await env.svc.exportPortabilityHistory(P.member, ws, 'ai_history', {})),
    ).not.toContain('Draft the follow-up plan');
    await setClass('C2');
    const back = (await env.svc.getAiProposal(P.member, ws, v.id)) as View;
    expect(back.content.state).toBe('present');
    // The policy change bumped no permission epoch, so the approval stays bound and usable.
    expect((await applyIt(P.member, back)).data).toMatchObject({ state: 'applied' });
  });

  it('the 0056 rollback refuses while proposals exist, leaving the catalog, proposals, and applied records unchanged (ADR-47)', async () => {
    const before = await sql(`SELECT count(*)::int AS n FROM ai.change_proposal`);
    expect(before[0]!.n).toBeGreaterThan(0);
    const migrator = new Migrator({ connectionString: db.migrator, environment: 'test' });
    await expect(migrator.down(55)).rejects.toThrow(/change proposals exist/);
    expect((await sql(`SELECT max(version)::int AS v FROM ops.schema_migration`))[0]!.v).toBe(56);
    expect(await sql(`SELECT count(*)::int AS n FROM ai.change_proposal`)).toEqual(before);
    expect(
      await sql(
        `SELECT relforcerowsecurity FROM pg_class WHERE oid IN ('ai.change_proposal'::regclass, 'ai.ai_action'::regclass)`,
      ),
    ).toEqual([{ relforcerowsecurity: true }, { relforcerowsecurity: true }]);
  });
});
