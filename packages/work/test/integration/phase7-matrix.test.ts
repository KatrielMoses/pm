import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { startAiProviderFixture, syntheticWav, type AiProviderFixture } from '@pm/test-support';
import { Migrator } from '@pm/db';
import type { WorkerRuntime } from '@pm/platform';
import type { Caller } from '@pm/tenancy';
import {
  addDays,
  aiBriefingSweepHandler,
  aiRetentionHandler,
  emailProviderFrom,
  runNotifyWorkspace,
  inboxItemAdapter,
  isoWeekday,
  localDay,
  productPersonalDataRegistry,
  voiceCleanupHandler,
  type LocalObjectStorage,
} from '@pm/work';
import { syntheticCaller } from '../../src/integrations/public-api-service.ts';
import { aiWorker, drain, enableAi, fixtureAi, ledger, stepped, stepUp } from './ai-support.ts';
import {
  apply,
  join,
  membershipOf,
  mutation,
  outboxEvents,
  seedAccount,
  workEnv,
  workspaceIdOf,
  WORKSPACE_INPUT,
  type WorkEnv,
} from './fixture.ts';

type Who =
  | 'owner'
  | 'administrator'
  | 'member'
  | 'limited_member'
  | 'read_only'
  | 'share_only'
  | 'guest'
  | 'leaver';
type TaskKey = 'open' | 'restricted' | 'vault' | 'shared';
const ULID = '01J8M5Y7A3B2C4D6E8F0G1H2J3';
const UNKNOWN = {
  run: `op_${ULID}`,
  prp: `prp_${ULID}`,
  brf: `brf_${ULID}`,
  bco: `bco_${ULID}`,
  bsc: `bsc_${ULID}`,
  vcp: `vcp_${ULID}`,
  tsk: `tsk_${ULID}`,
};
/** Distinctive private markers: they may live only inside the protected AI/capture boundary. */
const MARK = {
  instruction: 'QX7-instruction-marker',
  brief: 'QX7-brief-marker',
  capture: 'QX7-capture-marker',
  voice: 'QX7-voice-marker',
  note: 'QX7-note-marker',
};
/** Stores that must hold references only, never protected content. */
const GENERIC = /^(exec|metering|audit|ops|notify|integrations|insights|metrics|search)\./;
const WEEKDAYS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** The whole refusal a caller observes: code, message, and issues (nothing else may differ). */
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string; issues?: unknown };
    return { code: err.code, message: err.message, issues: err.issues ?? null };
  }
  throw new Error('expected a refusal');
};
const outcome = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? 'error';
  }
};
const issueCodes = (r: { issues: unknown }) =>
  ((r.issues as Array<{ code: string }> | null) ?? []).map((i) => i.code);

/**
 * Phase 7 integration matrix (P7-IR1 §2–§4): one permission and content boundary across 7A–7F.
 * Three workspaces; owner, administrator, member, limited and read-only members, a share-only
 * member, a guest, a departing member, and a delegated API token; a sensitive brand and a
 * restricted project. Retrieval, assist, proposals, plans, capture, voice, and briefings agree
 * with the canonical read decision; revocation between every step reauthorizes before anything is
 * rendered; departure, account erasure, retention, and purge converge through the registered
 * hooks and workers; protected content stays inside its boundary. Only the provider and the
 * transcription service are the labelled deterministic fixture; nothing else is stubbed.
 */
describe('Phase 7 cross-surface matrix', () => {
  let db: TestDatabase;
  let fx: AiProviderFixture;
  let env: WorkEnv;
  let worker: WorkerRuntime;
  let ws: string;
  let wsId: string;
  let harbor: string;
  let vault: string;
  let day: string;
  const P = {} as Record<Who, Caller>;
  const M = {} as Record<Who, string>;
  const T = {} as Record<TaskKey, string>;
  /** Workspace B (another owner) and C (the member owns it): real ids that must stay foreign. */
  const B = {} as { owner: Caller; ws: string; wsId: string; brand: string; run: string };
  const C = {} as { ws: string; wsId: string; brand: string };
  const extra: WorkerRuntime[] = [];

  const sql = async (text: string, params: unknown[] = []) => (await db.admin(text, params)).rows;
  const mem = async (c: Caller, space = wsId) =>
    (await membershipOf(db, space, c.auth.account.id))!.public_id;
  const memId = async (c: Caller, space = wsId) =>
    (await membershipOf(db, space, c.auth.account.id))!.id;
  const grant = (who: Who, brand: string, level: string) =>
    apply(env, P.owner, ws, { kind: 'brand_grant', brand, principal: M[who], level });
  const revoke = (who: Who, brand: string) =>
    apply(env, P.owner, ws, { kind: 'brand_revoke', brand, principal: M[who] });
  const storage = () => env.files.storage as LocalObjectStorage;

  /** Every base table (outside the catalogs) whose rows contain the marker. */
  const holders = async (marker: string) => {
    const tables = (
      await sql(
        `SELECT table_schema || '.' || table_name AS t FROM information_schema.tables
          WHERE table_type = 'BASE TABLE'
            AND table_schema NOT IN ('pg_catalog', 'information_schema', 'public')
          ORDER BY 1`,
      )
    ).map((r) => r.t as string);
    const found: string[] = [];
    for (const t of tables) {
      const [schema, name] = t.split('.');
      const r = await sql(
        `SELECT EXISTS (SELECT 1 FROM "${schema}"."${name}" x WHERE strpos(row_to_json(x)::text, $1) > 0) AS hit`,
        [marker],
      );
      if (r[0]!.hit) found.push(t);
    }
    return found;
  };

  /** An assist run through the 7C surface: preview, estimate, confirm, dispatch. */
  const assist = async (
    who: Caller,
    body: Record<string, unknown>,
    space = ws,
    settle = true,
  ): Promise<string> => {
    const retrieval = {
      scope: (body.scope as object | undefined) ?? {},
      include: (body.include as unknown[] | undefined) ?? [],
      ...(body.offer_choices ? { offer_choices: true } : {}),
    };
    const m = await env.svc.previewAiContext(who, space, retrieval);
    const req = { ...body, ...retrieval, manifest_digest: m.digest, confirm_cost: true };
    const est = await env.svc.estimateAiAssist(who, space, req);
    const started = await env.svc.startAiAssist(
      who,
      space,
      { ...req, input_digest: est.input_digest },
      mutation(),
    );
    if (settle) await drain(db, worker, started.data.id);
    return started.data.id;
  };
  const draftProject = (who: Caller, brief: string, brand = harbor, space = ws) =>
    assist(
      who,
      {
        action: 'draft_project.v1',
        scope: { brands: [brand] },
        offer_choices: true,
        instruction: '#fixture:ok',
        brief,
      },
      space,
    );
  const proposalOf = async (who: Caller, run: string, space = ws) =>
    (await env.svc.getAiRun(who, space, run)).content!.proposal!.id!;
  type PView = {
    id: string;
    revision: number;
    fingerprint: string;
    state: string;
    changes: Array<{ key: string; op: string; result: { id?: string } | null }>;
    content?: { state: string };
  };
  const proposal = async (who: Caller, prp: string, space = ws) =>
    (await env.svc.getAiProposal(who, space, prp)) as unknown as PView;
  const bind = (v: PView) => ({ revision: v.revision, fingerprint: v.fingerprint });

  /** A synthetic recording: create, upload the exact bytes, optionally transcribe. */
  const record = async (who: Caller, transcript: string, space = ws) => {
    const bytes = syntheticWav(2, { transcript });
    const created = (
      await env.svc.createVoiceCapture(
        who,
        space,
        { format: 'audio/wav', byte_size: bytes.byteLength, sha256: sha(bytes), duration_ms: 2000 },
        mutation(),
      )
    ).data;
    const key = await keyOf(created.id);
    await storage().writeObject(key!, bytes, { contentType: 'audio/wav' });
    return { id: created.id as string, key: key! };
  };
  const keyOf = async (vcp: string) =>
    (await sql(`SELECT storage_key FROM capture.voice_capture WHERE public_id = $1`, [vcp]))[0]!
      .storage_key as string | null;
  const transcribe = async (who: Caller, vcp: string, space = ws) => {
    const v = (await env.svc.transcribeVoiceCapture(who, space, vcp, mutation())).data;
    if (v.run) await drain(db, worker, v.run);
    return env.svc.getVoiceCapture(who, space, vcp);
  };

  /** A delegated API-token caller (bearer) for the member. */
  const delegated = async (who: Caller, scopes: string[]) => {
    const made = await stepped(env, () =>
      env.svc.createToken(
        who,
        ws,
        { name: 'Matrix', kind: 'personal', scopes },
        mutation({ stepUpToken: 't' }),
      ),
    );
    const auth = await env.svc.authenticateApiToken(made.data.secret!);
    return syntheticCaller(auth!.accountId, auth!.delegation, { correlationId: 'b'.repeat(32) });
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    fx = await startAiProviderFixture();
    env = workEnv(db, { ai: fixtureAi(fx) });
    worker = await aiWorker(env);
    // Workspace A: Harbor (normal), Vault (sensitive; owner self-granted manage), a restricted project.
    P.owner = await seedAccount(db);
    const created = await env.svc.createWorkspace(
      P.owner,
      { ...WORKSPACE_INPUT, name: 'Matrix seven', first_brand: { name: 'Harbor' } },
      mutation(),
    );
    ws = created.data.workspace.id;
    wsId = await workspaceIdOf(db, ws);
    harbor = created.data.first_brand!.id;
    vault = (await env.svc.createBrand(P.owner, ws, { name: 'Vault' }, mutation())).data.id;
    await stepped(env, () =>
      env.svc.setSensitivity(
        P.owner,
        ws,
        vault,
        { is_sensitive: true },
        mutation({ ifMatch: '"0"', stepUpToken: 't' }),
      ),
    );
    P.administrator = await join(env, db, P.owner, ws, { kind: 'member', role: 'administrator' });
    for (const who of ['member', 'share_only', 'leaver'] as const)
      P[who] = await join(env, db, P.owner, ws, { kind: 'member', role: 'member' });
    P.limited_member = await join(env, db, P.owner, ws, { kind: 'member', role: 'limited_member' });
    P.read_only = await join(env, db, P.owner, ws, { kind: 'member', role: 'read_only' });
    for (const who of Object.keys(P) as Who[]) M[who] = await mem(P[who]);
    await grant('owner', vault, 'manage');
    await grant('member', harbor, 'edit');
    await grant('leaver', harbor, 'edit');
    await grant('limited_member', harbor, 'view');
    await grant('read_only', harbor, 'view');
    const project = async (name: string) =>
      (await env.svc.createProject(P.owner, ws, { brand: harbor, name }, mutation())).data.id;
    const open = await project('Kestrel open');
    const restricted = await project('Kestrel restricted');
    await env.svc.setAccess(
      P.owner,
      ws,
      restricted,
      { access_mode: 'restricted', allow_record_shares: false },
      mutation(),
    );
    const yesterday = addDays(localDay(new Date(), 'UTC'), -1);
    const task = async (body: Record<string, unknown>) =>
      (
        await env.svc.createTask(
          P.owner,
          ws,
          { due_date: yesterday, estimate_minutes: 30, ...body },
          mutation(),
        )
      ).data.id;
    T.open = await task({ project: open, title: 'Kestrel open brief' });
    T.restricted = await task({ project: restricted, title: 'Kestrel restricted sigma' });
    T.vault = await task({ brand: vault, title: 'Kestrel vault omega' });
    T.shared = await task({ brand: harbor, title: 'Kestrel shared brief' });
    await apply(env, P.owner, ws, {
      kind: 'record_share',
      record: T.shared,
      grantee: M.share_only,
      level: 'edit',
    });
    P.guest = await join(env, db, P.owner, ws, {
      kind: 'guest',
      records: [{ record: T.shared, level: 'comment' }],
    });
    M.guest = await mem(P.guest);
    await enableAi(env, P.owner, ws);
    // Workspace B: another owner with real AI runs, briefings, and recordings (foreign ids).
    B.owner = await seedAccount(db);
    const b = await env.svc.createWorkspace(
      B.owner,
      { ...WORKSPACE_INPUT, name: 'Matrix bravo', first_brand: { name: 'Bravo' } },
      mutation(),
    );
    B.ws = b.data.workspace.id;
    B.wsId = await workspaceIdOf(db, B.ws);
    B.brand = b.data.first_brand!.id;
    await enableAi(env, B.owner, B.ws);
    // Workspace C: owned by A's member, so the same person holds ids in two workspaces.
    const c = await env.svc.createWorkspace(
      P.member,
      { ...WORKSPACE_INPUT, name: 'Matrix charlie', first_brand: { name: 'Charlie' } },
      mutation(),
    );
    C.ws = c.data.workspace.id;
    C.wsId = await workspaceIdOf(db, C.ws);
    C.brand = c.data.first_brand!.id;
    await enableAi(env, P.member, C.ws);
    const today = localDay(new Date(), 'UTC');
    day = addDays(today, 7 + ((8 - isoWeekday(today)) % 7));
  });
  afterAll(async () => {
    for (const w of extra) await w.stop();
    await worker.stop();
    await env.h.close();
    await fx.close();
    await db.drop();
  });

  it('AT-524 every principal sees exactly the records the canonical read decision allows, on every Phase 7 surface', async () => {
    const universe = Object.entries(T) as Array<[TaskKey, string]>;
    const principals: Who[] = [
      'owner',
      'administrator',
      'member',
      'limited_member',
      'read_only',
      'share_only',
      'guest',
    ];
    const seen: Record<string, Record<string, string>> = {};
    for (const who of principals) {
      const row: Record<string, string> = {};
      const unknownPreview = await refusal(
        env.svc.previewAiContext(P[who], ws, { include: [{ type: 'task', id: UNKNOWN.tsk }] }),
      );
      // A role without AI retrieval is refused the same way for every record, readable or not.
      const gate = await outcome(env.svc.previewAiContext(P[who], ws, {}));
      for (const [key, id] of universe) {
        const canonical = await outcome(env.svc.getTask(P[who], ws, id));
        if (gate !== 'ok') {
          expect(
            await refusal(
              env.svc.previewAiContext(P[who], ws, { include: [{ type: 'task', id }] }),
            ),
            `${who} ${key}`,
          ).toEqual(unknownPreview);
          row[key] = canonical === 'ok' ? 'readable (no AI)' : 'hidden';
          continue;
        }
        // 7B: a named source is resolved through the canonical loader; a hidden one refuses
        // exactly like an unknown one (no title, type, or count difference).
        const preview = env.svc.previewAiContext(P[who], ws, { include: [{ type: 'task', id }] });
        if (canonical === 'ok') {
          const m = await preview;
          expect(m.sources.map((s: { id: string }) => s.id)).toContain(id);
          row[key] = 'readable';
        } else {
          expect(await refusal(preview), `${who} ${key}`).toEqual(unknownPreview);
          row[key] = 'hidden';
        }
      }
      seen[who] = row;
    }
    // The canonical decision (not this test) is the oracle; these rows pin it so drift is visible.
    // Limited, read-only, and guest roles have no AI retrieval at all; their refusals are the
    // same for readable and hidden records.
    expect(seen).toEqual({
      owner: { open: 'readable', restricted: 'readable', vault: 'readable', shared: 'readable' },
      administrator: {
        open: 'readable',
        restricted: 'hidden',
        vault: 'hidden',
        shared: 'readable',
      },
      member: { open: 'readable', restricted: 'hidden', vault: 'hidden', shared: 'readable' },
      limited_member: {
        open: 'readable (no AI)',
        restricted: 'hidden',
        vault: 'hidden',
        shared: 'readable (no AI)',
      },
      read_only: {
        open: 'readable (no AI)',
        restricted: 'hidden',
        vault: 'hidden',
        shared: 'readable (no AI)',
      },
      share_only: { open: 'hidden', restricted: 'hidden', vault: 'hidden', shared: 'readable' },
      guest: { open: 'hidden', restricted: 'hidden', vault: 'hidden', shared: 'readable (no AI)' },
    });

    // 7E: a recipient's briefing names only records that recipient reads, whatever the scope.
    for (const who of principals) {
      const brf = await outcome(
        env.svc.generateBriefing(P[who], ws, { kind: 'owner_daily' }, mutation()),
      );
      if (brf !== 'ok') {
        expect(['guest', 'share_only']).toContain(who);
        continue;
      }
      const list = await env.svc.listBriefings(P[who], ws, {});
      const view = await env.svc.getBriefing(P[who], ws, list.items[0]!.id);
      const named = new Set(
        view.statements.flatMap((s: { refs: Array<{ id: string }> }) => s.refs.map((r) => r.id)),
      );
      for (const [key, id] of universe)
        if (seen[who]![key] === 'hidden')
          expect(named.has(id), `${who} briefing ${key}`).toBe(false);
      const text = JSON.stringify(view);
      for (const [key, id] of universe)
        if (seen[who]![key] === 'hidden') {
          const title = (await env.svc.getTask(P.owner, ws, id)).title as string;
          expect(text.includes(title), `${who} briefing title ${key}`).toBe(false);
        }
    }

    // A delegated (bearer) caller never reaches person-only Phase 7 surfaces, in the service as
    // well as at the HTTP gate (integration fix: 7D and 7E relied on the HTTP path rule alone).
    const bearer = await delegated(P.member, ['records:read', 'ai:execute']);
    for (const call of [
      () => env.svc.previewDayPlan(bearer, ws, { day }),
      () =>
        env.svc.createVoiceCapture(
          bearer,
          ws,
          { format: 'audio/wav', byte_size: 100, sha256: 'a'.repeat(64), duration_ms: 1000 },
          mutation(),
        ),
      () => env.svc.listAiProposals(bearer, ws),
      () => env.svc.getAiProposal(bearer, ws, UNKNOWN.prp),
      () => env.svc.listBriefings(bearer, ws, {}),
      () => env.svc.getBriefing(bearer, ws, UNKNOWN.brf),
      () => env.svc.generateBriefing(bearer, ws, { kind: 'owner_daily' }, mutation()),
      () => env.svc.listBriefingSchedules(bearer, ws),
      () => env.svc.listBriefingCorrections(bearer, ws, {}),
      () => env.svc.previewBriefing(bearer, ws, { kind: 'owner_daily' }),
      () => env.svc.getVoiceCapture(bearer, ws, UNKNOWN.vcp),
      () => env.svc.voiceSettings(bearer, ws),
      () =>
        env.svc.previewCaptureInterpretation(bearer, ws, {
          text: 'x',
          interpretation: UNKNOWN.run,
        }),
    ])
      expect(await refusal(call())).toMatchObject({ code: 'forbidden' });
    // Runs and the action catalog are the token's `ai:execute` grant (7A), still personal.
    expect(await outcome(env.svc.listAiActions(bearer, ws))).toBe('ok');
    expect(await outcome(env.svc.getAiRun(bearer, ws, UNKNOWN.run))).toBe('not_found');
  });

  /** One of each personal Phase 7 artifact (run, proposal, briefing, schedule, note, recording). */
  const kit = async (who: Caller, space: string, brand: string) => {
    const task = (await env.svc.createTask(who, space, { brand, title: 'Kit task' }, mutation()))
      .data.id as string;
    const run = await assist(
      who,
      {
        action: 'summarize.v1',
        include: [{ type: 'task', id: task }],
        instruction: '#fixture:ok',
      },
      space,
    );
    const prp = await proposalOf(who, await draftProject(who, 'Kit plan', brand, space), space);
    const brf = (await env.svc.generateBriefing(who, space, { kind: 'owner_daily' }, mutation()))
      .data.id as string;
    const view = await env.svc.getBriefing(who, space, brf);
    const bco = (
      await env.svc.proposeBriefingCorrection(
        who,
        space,
        brf,
        { statement: view.statements[0]!.key, text: 'Kit note' },
        mutation(),
      )
    ).data.id as string;
    const bsc = (
      await env.svc.createBriefingSchedule(
        who,
        space,
        {
          kind: 'owner_daily',
          scope: {},
          weekdays: [1, 2, 3, 4, 5],
          timezone: 'UTC',
          local_time: '07:00',
        },
        mutation(),
      )
    ).data.id as string;
    const vcp = (await record(who, 'Kit recording', space)).id;
    return { run, prp, brf, bco, bsc, vcp };
  };

  it('AT-525 another workspace’s, another person’s, and unknown identifiers fail identically on every Phase 7 surface', async () => {
    const foreign = await kit(B.owner, B.ws, B.brand);
    const others = await kit(P.member, ws, harbor);
    const charlie = await kit(P.member, C.ws, C.brand);
    type Kit = typeof foreign;
    const probes = (who: Caller, space: string, k: Kit) => [
      () => env.svc.getAiRun(who, space, k.run),
      () => env.svc.getAiProposal(who, space, k.prp),
      () =>
        env.svc.applyAiProposal(
          who,
          space,
          k.prp,
          { revision: 1, fingerprint: '0'.repeat(64) },
          mutation(),
        ),
      () => env.svc.getBriefing(who, space, k.brf),
      () => env.svc.regenerateBriefing(who, space, k.brf, mutation()),
      () => env.svc.updateBriefingCorrection(who, space, k.bco, { text: 'x' }, mutation()),
      () => env.svc.decideBriefingCorrection(who, space, k.bco, 'approve', mutation()),
      () => env.svc.updateBriefingSchedule(who, space, k.bsc, { enabled: false }, mutation()),
      () => env.svc.getVoiceCapture(who, space, k.vcp),
      () => env.svc.transcribeVoiceCapture(who, space, k.vcp, mutation()),
      () =>
        env.svc.previewCaptureInterpretation(who, space, {
          text: 'Book it',
          interpretation: k.run,
        }),
    ];
    const unknown: Kit = {
      run: UNKNOWN.run,
      prp: UNKNOWN.prp,
      brf: UNKNOWN.brf,
      bco: UNKNOWN.bco,
      bsc: UNKNOWN.bsc,
      vcp: UNKNOWN.vcp,
    };
    // The owner of A, holding B's ids and the member's own A ids; the member holding their own C
    // ids inside A. Each must look exactly like an id that never existed.
    for (const [who, k, label] of [
      [P.owner, foreign, 'B ids in A'],
      [P.owner, others, "another person's ids"],
      [P.administrator, others, "another person's ids (administrator)"],
      [P.member, charlie, 'own C ids in A'],
    ] as Array<[Caller, Kit, string]>) {
      const got = probes(who, ws, k);
      const none = probes(who, ws, unknown);
      for (let i = 0; i < got.length; i++) {
        const expected = await refusal(none[i]!());
        expect(expected.code, `${label} #${i}`).toBe('not_found');
        expect(await refusal(got[i]!()), `${label} #${i}`).toEqual(expected);
      }
    }
    // Lists name nothing foreign or another person's.
    const lists = JSON.stringify([
      await env.svc.listAiProposals(P.owner, ws),
      await env.svc.listBriefings(P.owner, ws, {}),
      await env.svc.listBriefingCorrections(P.owner, ws, {}),
      await env.svc.listBriefingSchedules(P.owner, ws),
    ]);
    for (const k of [foreign, others, charlie])
      for (const id of Object.values(k)) expect(lists).not.toContain(id);
  });

  it('AT-526 revocation between preview, confirmation, dispatch, approval, Apply, completed-key replay, and display is reauthorized every time; nothing hidden survives through another surface', async () => {
    const SOURCE = 'Kestrel open brief';
    const PLAN = 'Plan: Revocation plan';
    const retrieval = {
      scope: { brands: [harbor] },
      include: [{ type: 'task', id: T.open }],
      offer_choices: true,
    };
    const base = {
      action: 'draft_project.v1',
      ...retrieval,
      instruction: '#fixture:ok',
      brief: 'Revocation plan',
      confirm_cost: true,
    };
    const cut = () => revoke('member', harbor);
    const restore = () => grant('member', harbor, 'edit');
    const absent = (x: unknown, ...titles: string[]) => {
      const text = JSON.stringify(x);
      for (const t of titles) expect(text).not.toContain(t);
    };
    const steps: Record<string, unknown> = {};

    // Preview → (revoked) → estimate.
    const m = await env.svc.previewAiContext(P.member, ws, retrieval);
    await cut();
    const atEstimate = await refusal(
      env.svc.estimateAiAssist(P.member, ws, { ...base, manifest_digest: m.digest }),
    );
    absent(atEstimate, SOURCE);
    steps.estimate = atEstimate.code;
    await restore();
    // Estimate → (revoked) → start.
    const m2 = await env.svc.previewAiContext(P.member, ws, retrieval);
    const est = await env.svc.estimateAiAssist(P.member, ws, {
      ...base,
      manifest_digest: m2.digest,
    });
    await cut();
    const atStart = await refusal(
      env.svc.startAiAssist(
        P.member,
        ws,
        { ...base, manifest_digest: m2.digest, input_digest: est.input_digest },
        mutation(),
      ),
    );
    absent(atStart, SOURCE);
    steps.start = atStart.code;
    await restore();
    // Start → (revoked) → dispatch: nothing reaches the provider.
    const m3 = await env.svc.previewAiContext(P.member, ws, retrieval);
    const est3 = await env.svc.estimateAiAssist(P.member, ws, {
      ...base,
      manifest_digest: m3.digest,
    });
    const queued = await env.svc.startAiAssist(
      P.member,
      ws,
      { ...base, manifest_digest: m3.digest, input_digest: est3.input_digest },
      mutation(),
    );
    await cut();
    const sentBefore = fx.control.received().length;
    steps.dispatch = (await drain(db, worker, queued.data.id)).execution_state;
    expect(fx.control.received().length).toBe(sentBefore);
    absent(await env.svc.getAiRun(P.member, ws, queued.data.id), SOURCE, 'Revocation plan');
    await restore();

    // A completed run and its proposal.
    const run = await draftProject(P.member, 'Revocation plan');
    const prp = await proposalOf(P.member, run);
    let v = await proposal(P.member, prp);
    // Generated → (revoked) → approval, display, lists.
    await cut();
    const shown = await proposal(P.member, prp);
    expect(shown.content?.state).toBe('withheld');
    absent(shown, SOURCE, PLAN);
    absent(await env.svc.listAiProposals(P.member, ws), SOURCE, PLAN);
    absent(await env.svc.getAiRun(P.member, ws, run), SOURCE, PLAN);
    absent(await env.svc.listAiRuns(P.member, ws, {}), SOURCE, PLAN);
    const atApprove = await refusal(
      env.svc.approveAiProposal(P.member, ws, prp, bind(v), mutation()),
    );
    steps.approve = issueCodes(atApprove);
    await restore();
    v = (await env.svc.approveAiProposal(P.member, ws, prp, bind(v), mutation())).data as PView;
    // Approved → (revoked) → Apply: nothing is created.
    await cut();
    const atApply = await refusal(env.svc.applyAiProposal(P.member, ws, prp, bind(v), mutation()));
    steps.apply = issueCodes(atApply);
    expect(await sql(`SELECT 1 FROM work.project WHERE name = $1`, [PLAN])).toHaveLength(0);
    await restore();
    // A permission change after approval makes the approval stale; a fresh approval is explicit.
    const again = await refusal(env.svc.applyAiProposal(P.member, ws, prp, bind(v), mutation()));
    steps.after_restore = issueCodes(again);
    if (again.code === 'conflict') {
      v = (await env.svc.approveAiProposal(P.member, ws, prp, bind(v), mutation())).data as PView;
    }
    const key = mutation();
    const applied = (await env.svc.applyAiProposal(P.member, ws, prp, bind(v), key)).data as PView;
    expect(applied.state).toBe('applied');
    expect(await sql(`SELECT 1 FROM work.project WHERE name = $1`, [PLAN])).toHaveLength(1);
    // Applied → (revoked) → completed-key replay: a completed key is not a stored access grant.
    await cut();
    const replay = await env.svc.applyAiProposal(P.member, ws, prp, bind(v), key);
    // The replay is rendered through current authority: the outcome, never the content.
    expect(replay).toMatchObject({
      replayed: true,
      data: { state: 'applied', title: null, changes: [], content: { state: 'withheld' } },
    });
    absent(
      await env.svc.applyAiProposal(P.member, ws, prp, bind(v), key).catch((e: unknown) => e),
      SOURCE,
      PLAN,
    );
    expect(await sql(`SELECT 1 FROM work.project WHERE name = $1`, [PLAN])).toHaveLength(1);
    await restore();

    // A data-use policy change (Harbor becomes sensitive) between confirmation and start, and
    // before display: the confirmed manifest no longer holds, and history shows no source text.
    const sensitive = async (on: boolean) => {
      const b = await env.svc.getBrand(P.owner, ws, harbor);
      await stepped(env, () =>
        env.svc.setSensitivity(
          P.owner,
          ws,
          harbor,
          { is_sensitive: on },
          mutation({ ifMatch: `"${(b as { version: number }).version}"`, stepUpToken: 't' }),
        ),
      );
    };
    const m4 = await env.svc.previewAiContext(P.member, ws, retrieval);
    const est4 = await env.svc.estimateAiAssist(P.member, ws, {
      ...base,
      manifest_digest: m4.digest,
    });
    await sensitive(true);
    const atPolicy = await refusal(
      env.svc.startAiAssist(
        P.member,
        ws,
        { ...base, manifest_digest: m4.digest, input_digest: est4.input_digest },
        mutation(),
      ),
    );
    steps.policy = atPolicy.code;
    absent(atPolicy, SOURCE);
    const history = await env.svc.getAiRun(P.member, ws, run);
    expect(history.content).toMatchObject({ state: 'withheld' });
    absent(history, SOURCE, PLAN);
    await sensitive(false);

    // Briefing and a personal note follow the same evidence on every surface.
    const brf = (await env.svc.generateBriefing(P.member, ws, { kind: 'owner_daily' }, mutation()))
      .data.id as string;
    const bv = await env.svc.getBriefing(P.member, ws, brf);
    const st = bv.statements.find((x: { refs: Array<{ id: string }> }) =>
      x.refs.some((r) => r.id === T.open),
    )!;
    expect(st).toBeTruthy();
    const note = (
      await env.svc.proposeBriefingCorrection(
        P.member,
        ws,
        brf,
        { statement: st.key, text: 'Harbor note about the open brief' },
        mutation(),
      )
    ).data.id as string;
    await cut();
    const hidden = await env.svc.getBriefing(P.member, ws, brf);
    expect(hidden).toMatchObject({ availability: 'withheld', statements: [], coverage: null });
    absent(hidden, SOURCE);
    absent(await env.svc.listBriefings(P.member, ws, {}), SOURCE);
    const notes = await env.svc.listBriefingCorrections(P.member, ws, {});
    expect(JSON.stringify(notes)).not.toContain(note);
    absent(notes, 'Harbor note about the open brief', SOURCE);
    steps.note = (
      await refusal(env.svc.updateBriefingCorrection(P.member, ws, note, { text: 'x' }, mutation()))
    ).code;
    await restore();
    expect(steps).toEqual({
      estimate: 'forbidden',
      start: 'forbidden',
      dispatch: 'failed',
      approve: ['proposal_sources_unavailable'],
      apply: ['proposal_sources_unavailable'],
      after_restore: ['approval_stale'],
      policy: 'forbidden',
      note: 'not_found',
    });
  });

  const remove = async (who: Who) => {
    const preview = await env.svc.previewChange(P.owner, ws, { kind: 'remove', member: M[who] });
    await stepped(env, () =>
      env.svc.removeMember(
        P.owner,
        ws,
        M[who],
        { preview_token: preview.preview_token, reassign_to: M.owner },
        mutation({ stepUpToken: 't' }),
      ),
    );
  };
  const handlerDeps = () => ({
    tenant: env.h.worker,
    discovery: env.h.discovery,
    metrics: env.h.telemetry.metrics,
    logger: env.h.logger,
    maxAttempts: 3,
    timeoutMs: 20_000,
  });

  it('AT-527 departure, the registered workers, restart, purge, and retention converge across AI, briefing, plan, voice, and mixed workspaces', async () => {
    const LEAVER = 'Leaver private marker LVR7';
    const leaverId = await memId(P.leaver);
    // The leaver's mixed history: a run, a planner proposal, a briefing with a note and a
    // schedule, an open recording (audio held), a saved recording, and a call in flight.
    const done = await assist(P.leaver, {
      action: 'summarize.v1',
      include: [{ type: 'task', id: T.open }],
      instruction: `${LEAVER} #fixture:ok`,
    });
    const prof = await env.svc.myCapacityProfile(P.leaver, ws);
    await env.svc.setMyCapacityProfile(
      P.leaver,
      ws,
      { windows: WEEKDAYS },
      mutation({ ifMatch: `"${prof.version}"` }),
    );
    const mine = (
      await env.svc.createTask(
        P.owner,
        ws,
        { brand: harbor, title: 'Leaver planned work', estimate_minutes: 60 },
        mutation(),
      )
    ).data;
    await env.svc.setAssignees(
      P.owner,
      ws,
      mine.id,
      { assignees: [M.leaver], version: mine.version },
      mutation(),
    );
    const plan = (await env.svc.createDayPlanProposal(P.leaver, ws, { day }, mutation())).data;
    const brf = (await env.svc.generateBriefing(P.leaver, ws, { kind: 'owner_daily' }, mutation()))
      .data.id as string;
    const bv = await env.svc.getBriefing(P.leaver, ws, brf);
    await env.svc.proposeBriefingCorrection(
      P.leaver,
      ws,
      brf,
      { statement: bv.statements[0]!.key, text: LEAVER },
      mutation(),
    );
    await env.svc.createBriefingSchedule(
      P.leaver,
      ws,
      {
        kind: 'owner_daily',
        scope: {},
        weekdays: [1, 2, 3, 4, 5],
        timezone: 'UTC',
        local_time: '07:00',
      },
      mutation(),
    );
    const open = await record(P.leaver, `${LEAVER} open recording`);
    const said = await record(P.leaver, `${LEAVER} saved recording`);
    const heard = await transcribe(P.leaver, said.id);
    expect(heard).toMatchObject({ state: 'transcribed', audio: 'discarded' });
    const saved = (
      await env.svc.capture(
        P.leaver,
        ws,
        { text: heard.transcript!.text!, brand: harbor, voice: said.id },
        mutation(),
      )
    ).data.id as string;
    const hung = await env.svc.startAiAssist(
      P.leaver,
      ws,
      await (async () => {
        const retrieval = { scope: {}, include: [{ type: 'task', id: T.open }] };
        const m = await env.svc.previewAiContext(P.leaver, ws, retrieval);
        const req = {
          action: 'summarize.v1',
          ...retrieval,
          instruction: `${LEAVER} hang #fixture:hang`,
          manifest_digest: m.digest,
          confirm_cost: true,
        };
        const est = await env.svc.estimateAiAssist(P.leaver, ws, req);
        return { ...req, input_digest: est.input_digest };
      })(),
      mutation(),
    );
    const w1 = await aiWorker(env);
    extra.push(w1);
    const inflight = w1.runCycle({ wait: true });
    for (let i = 0; i < 100 && !fx.control.received().some((r) => r.user.includes('hang')); i++)
      await new Promise((r) => setTimeout(r, 30));
    expect(await keyOf(open.id)).not.toBeNull();

    // Departure through the real removal flow (registered ownership hooks), then a late reply.
    await remove('leaver');
    fx.control.releaseHung();
    await inflight;
    const facts = async () =>
      (
        await sql(
          `SELECT
             (SELECT count(*)::int FROM ai.ai_action WHERE initiating_membership_id = $1 AND content_state = 'present') AS runs,
             (SELECT count(*)::int FROM ai.ai_output o JOIN ai.ai_action a ON a.operation_id = o.operation_id
                WHERE a.initiating_membership_id = $1 AND o.content IS NOT NULL) AS outputs,
             (SELECT count(*)::int FROM ai.change_proposal WHERE initiating_membership_id = $1 AND content_state = 'present') AS proposals,
             (SELECT count(*)::int FROM ai.briefing WHERE recipient_membership_id = $1 AND content_state = 'present') AS briefings,
             (SELECT count(*)::int FROM ai.briefing_correction WHERE recipient_membership_id = $1 AND state <> 'erased') AS notes,
             (SELECT count(*)::int FROM ai.briefing_schedule WHERE membership_id = $1 AND enabled) AS schedules,
             (SELECT count(*)::int FROM capture.voice_capture WHERE membership_id = $1 AND state IN ('uploaded', 'transcribing')) AS open_voice`,
          [leaverId],
        )
      )[0];
    expect(await facts()).toEqual({
      runs: 0,
      outputs: 0,
      proposals: 0,
      briefings: 0,
      notes: 0,
      schedules: 0,
      open_voice: 0,
    });
    expect(plan.id).toMatch(/^prp_/);
    expect(done).toMatch(/^op_/);
    expect(hung.data.id).toMatch(/^op_/);
    // The registered cleanup sweep deletes the audio that departure ended (no direct call).
    await voiceCleanupHandler({ ...handlerDeps(), service: env.svc }).handle({} as never);
    expect(await keyOf(open.id)).toBeNull();
    expect(await storage().head(open.key)).toBeNull();
    expect(await storage().head(said.key)).toBeNull();
    // A restart and a repeated sweep recreate nothing; already-erased content stays erased.
    const w2 = await aiWorker(env);
    extra.push(w2);
    await w2.runCycle({ wait: true });
    await voiceCleanupHandler({ ...handlerDeps(), service: env.svc }).handle({} as never);
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, (tx) =>
      productPersonalDataRegistry().eraseMembership(tx, leaverId),
    );
    expect(await facts()).toMatchObject({ runs: 0, outputs: 0, briefings: 0, notes: 0 });
    const leftovers = (await holders('LVR7')).filter((t) => !t.startsWith('capture.'));
    expect(leftovers).toEqual([]);
    // The saved capture is an ordinary Inbox record the leaver created: purging it (as the purge
    // executor does) must not be blocked by the recording that produced it.
    const inboxId = (await sql(`SELECT id FROM core.record WHERE public_id = $1`, [saved]))[0]!
      .id as string;
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, (tx) =>
      inboxItemAdapter.purge!.deleteContent(tx, [inboxId]),
    );
    expect(await sql(`SELECT 1 FROM capture.inbox_item WHERE id = $1`, [inboxId])).toHaveLength(0);
    expect(
      await sql(
        `SELECT state, inbox_item_id, storage_key FROM capture.voice_capture WHERE public_id = $1`,
        [said.id],
      ),
    ).toEqual([{ state: 'saved', inbox_item_id: null, storage_key: null }]);
    expect((await holders('LVR7')).filter((t) => t !== 'capture.inbox_item')).toEqual([]);
    // Usage facts are kept; the ledger still balances.
    expect(
      (
        await sql(`SELECT count(*)::int AS n FROM metering.usage_event WHERE workspace_id = $1`, [
          wsId,
        ])
      )[0]!.n,
    ).toBeGreaterThan(0);
    await ledger(db, wsId);

    // Retention through the registered handler across an AI-only workspace (B) and a
    // briefing-only workspace (C): bounded, repeatable, already-erased content untouched.
    const bRun = await assist(
      B.owner,
      {
        action: 'summarize.v1',
        include: [
          {
            type: 'task',
            id: (
              await env.svc.createTask(
                B.owner,
                B.ws,
                { brand: B.brand, title: 'Bravo old' },
                mutation(),
              )
            ).data.id,
          },
        ],
        instruction: 'Bravo retention #fixture:ok',
      },
      B.ws,
    );
    const cBrf = (
      await env.svc.generateBriefing(P.member, C.ws, { kind: 'owner_daily' }, mutation())
    ).data.id as string;
    await sql(
      `UPDATE ai.ai_action SET created_at = now() - interval '30 days' WHERE operation_id = (SELECT id FROM exec.operation WHERE public_id = $1)`,
      [bRun],
    );
    await sql(
      `UPDATE ai.briefing SET created_at = now() - interval '30 days' WHERE public_id = $1`,
      [cBrf],
    );
    const fresh = (await env.svc.generateBriefing(P.owner, ws, { kind: 'owner_daily' }, mutation()))
      .data.id as string;
    const retention = aiRetentionHandler({
      ...handlerDeps(),
      service: {
        runAiDispatch: env.svc.runAiDispatch.bind(env.svc),
        eraseAiContent: env.svc.eraseAiContent.bind(env.svc),
        runBriefingSweep: env.svc.runBriefingSweep.bind(env.svc),
        aiHistoryRetentionDays: () => 7,
      },
    } as never);
    await retention.handle({} as never);
    await retention.handle({} as never);
    expect(
      await sql(
        `SELECT content_state FROM ai.ai_action WHERE operation_id = (SELECT id FROM exec.operation WHERE public_id = $1)`,
        [bRun],
      ),
    ).toEqual([{ content_state: 'erased' }]);
    expect(await sql(`SELECT content_state FROM ai.briefing WHERE public_id = $1`, [cBrf])).toEqual(
      [{ content_state: 'erased' }],
    );
    expect((await env.svc.getBriefing(P.member, C.ws, cBrf)).availability).toBe('erased');
    // Current content is untouched by the cut-off.
    expect(
      await sql(`SELECT content_state FROM ai.briefing WHERE public_id = $1`, [fresh]),
    ).toEqual([{ content_state: 'present' }]);
  });

  it('AT-528 protected content stays in its boundary: no generic store or log holds it, a failed audio delete is retried, and purging a capture erases its AI copies', async () => {
    env.h.sink.clear();
    // Typed capture interpreted by AI (the text is the run's protected prompt), then saved.
    const text = `Book the ${MARK.capture} venue tomorrow #fixture:ok`;
    const interp = await assist(P.member, {
      action: 'interpret_capture.v1',
      instruction: text,
    });
    await env.svc.previewCaptureInterpretation(P.member, ws, { text, interpretation: interp });
    const typed = (
      await env.svc.capture(
        P.member,
        ws,
        { text, brand: harbor, interpretation: interp },
        mutation(),
      )
    ).data.id as string;
    // A recording whose audio deletion fails first: the transcript is kept in the protected
    // output, the audio is held (never lost track of), and the registered sweep retries.
    const rec = await record(P.member, `Call the ${MARK.voice} caterer`);
    const realDelete = storage().delete.bind(storage());
    let failures = 0;
    (storage() as { delete: (key: string) => Promise<void> }).delete = async () => {
      failures++;
      throw new Error('object storage unavailable');
    };
    let heard;
    try {
      heard = await transcribe(P.member, rec.id);
    } finally {
      (storage() as { delete: (key: string) => Promise<void> }).delete = realDelete;
    }
    expect(failures).toBeGreaterThan(0);
    expect(heard).toMatchObject({ state: 'transcribed', audio: 'held' });
    expect(await keyOf(rec.id)).toBe(rec.key);
    expect(await storage().head(rec.key)).not.toBeNull();
    await voiceCleanupHandler({ ...handlerDeps(), service: env.svc }).handle({} as never);
    expect(await keyOf(rec.id)).toBeNull();
    expect(await storage().head(rec.key)).toBeNull();
    expect((await env.svc.getVoiceCapture(P.member, ws, rec.id)).audio).toBe('discarded');
    const spoken = (
      await env.svc.capture(
        P.member,
        ws,
        { text: heard.transcript!.text!, brand: harbor, voice: rec.id },
        mutation(),
      )
    ).data.id as string;
    // Assist and proposal content, and a personal briefing note.
    await assist(P.member, {
      action: 'summarize.v1',
      include: [{ type: 'task', id: T.open }],
      instruction: `${MARK.instruction} #fixture:ok`,
    });
    await draftProject(P.member, MARK.brief);
    const brf = (await env.svc.generateBriefing(P.member, ws, { kind: 'owner_daily' }, mutation()))
      .data.id as string;
    await env.svc.proposeBriefingCorrection(
      P.member,
      ws,
      brf,
      {
        statement: (await env.svc.getBriefing(P.member, ws, brf)).statements[0]!.key,
        text: MARK.note,
      },
      mutation(),
    );
    // No checkpoint, job argument or result, effect-ledger field, outbox, audit, metric, delivery,
    // or search row holds a marker, and no log line does.
    for (const [name, marker] of Object.entries(MARK)) {
      const held = await holders(marker);
      expect(
        held.filter((t) => GENERIC.test(t)),
        name,
      ).toEqual([]);
      expect(held.length, `${name} is stored somewhere`).toBeGreaterThan(0);
      expect(env.h.sink.lines.join('\n'), name).not.toContain(marker);
    }
    // Purging the two captures (as the purge executor does) erases the AI copies made from them:
    // the interpretation's prompt and output and the transcript.
    for (const inb of [typed, spoken]) {
      const id = (await sql(`SELECT id FROM core.record WHERE public_id = $1`, [inb]))[0]!.id;
      await env.h.worker.withWorkspace(wsId, { module: 'test' }, (tx) =>
        inboxItemAdapter.purge!.deleteContent(tx, [id as string]),
      );
    }
    expect(await holders(MARK.capture)).toEqual([]);
    expect(await holders(MARK.voice)).toEqual([]);
    expect((await env.svc.getAiRun(P.member, ws, interp)).content).toMatchObject({
      state: 'erased',
    });
    expect((await env.svc.getVoiceCapture(P.member, ws, rec.id)).transcript).toMatchObject({
      state: 'erased',
      text: null,
    });
    await ledger(db, wsId);
  });

  it('AT-529 duplicate Apply, timeout-after-commit, role and grant changes, and a plan racing a task edit change business state exactly once, with matching operation, audit, and outbox facts', async () => {
    const projects = (name: string) =>
      sql(
        `SELECT r.public_id FROM work.project p JOIN core.record r ON r.id = p.id WHERE p.name = $1`,
        [name],
      );
    const applied = async (prp: string) => {
      const id = (await sql(`SELECT id FROM ai.change_proposal WHERE public_id = $1`, [prp]))[0]!
        .id as string;
      return {
        events: (await outboxEvents(db, wsId, 'ai.proposal.applied', id)).length,
        applications: (
          await sql(
            `SELECT count(*)::int AS n FROM ai.proposal_application WHERE proposal_id = $1`,
            [id],
          )
        )[0]!.n,
      };
    };
    // Two concurrent Applies with different keys: one applies, the other is refused, nothing twice.
    const race = await proposalOf(P.member, await draftProject(P.member, 'Race plan'));
    let v = await proposal(P.member, race);
    v = (await env.svc.approveAiProposal(P.member, ws, race, bind(v), mutation())).data as PView;
    const k1 = mutation();
    const both = await Promise.allSettled([
      env.svc.applyAiProposal(P.member, ws, race, bind(v), k1),
      env.svc.applyAiProposal(P.member, ws, race, bind(v), mutation()),
    ]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = both.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(issueCodes(lost.reason as { issues: unknown })).toEqual(['proposal_already_applied']);
    expect(await projects('Plan: Race plan')).toHaveLength(1);
    expect(await applied(race)).toEqual({ events: 1, applications: 1 });
    // Timeout after commit: the client retries with the same key and gets the same outcome.
    const winnerKey = both[0]!.status === 'fulfilled' ? k1 : null;
    if (winnerKey) {
      const again = await env.svc.applyAiProposal(P.member, ws, race, bind(v), winnerKey);
      expect(again).toMatchObject({ replayed: true, data: { state: 'applied' } });
    }
    expect(await projects('Plan: Race plan')).toHaveLength(1);
    expect(await applied(race)).toEqual({ events: 1, applications: 1 });
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM audit.audit_event WHERE workspace_id = $1 AND action = 'project.created'
             AND target_public_id = $2`,
          [wsId, (await projects('Plan: Race plan'))[0]!.public_id],
        )
      )[0]!.n,
    ).toBe(1);

    // A role change between approval and Apply: the applier no longer may, nothing is created.
    const demoted = await proposalOf(P.member, await draftProject(P.member, 'Demoted plan'));
    let d = await proposal(P.member, demoted);
    d = (await env.svc.approveAiProposal(P.member, ws, demoted, bind(d), mutation())).data as PView;
    await apply(env, P.owner, ws, { kind: 'role', member: M.member, role: 'read_only' });
    expect(
      (await refusal(env.svc.applyAiProposal(P.member, ws, demoted, bind(d), mutation()))).code,
    ).toBe('forbidden');
    expect(await projects('Plan: Demoted plan')).toHaveLength(0);
    await apply(env, P.owner, ws, { kind: 'role', member: M.member, role: 'member' });
    // Restored authority does not revive the old approval: a fresh approval is explicit.
    expect(
      issueCodes(
        await refusal(env.svc.applyAiProposal(P.member, ws, demoted, bind(d), mutation())),
      ),
    ).toEqual(['approval_stale']);
    d = (await env.svc.approveAiProposal(P.member, ws, demoted, bind(d), mutation())).data as PView;
    await env.svc.applyAiProposal(P.member, ws, demoted, bind(d), mutation());
    expect(await projects('Plan: Demoted plan')).toHaveLength(1);
    expect(await applied(demoted)).toEqual({ events: 1, applications: 1 });

    // A day plan approved, then a real task edit (estimate) before Apply: Apply refuses the stale
    // plan atomically, an explicit rebase and fresh approval apply it exactly once.
    const prof = await env.svc.myCapacityProfile(P.member, ws);
    await env.svc.setMyCapacityProfile(
      P.member,
      ws,
      { windows: WEEKDAYS },
      mutation({ ifMatch: `"${prof.version}"` }),
    );
    const work = (
      await env.svc.createTask(
        P.owner,
        ws,
        { brand: harbor, title: 'Member planned work', estimate_minutes: 90, priority: 'high' },
        mutation(),
      )
    ).data;
    await env.svc.setAssignees(
      P.owner,
      ws,
      work.id,
      { assignees: [M.member], version: work.version },
      mutation(),
    );
    type Plan = PView & { plan: { current: { state: string; snapshot: string } } };
    let plan = (await env.svc.createDayPlanProposal(P.member, ws, { day }, mutation()))
      .data as Plan;
    plan = (await env.svc.approveAiProposal(P.member, ws, plan.id, bind(plan), mutation()))
      .data as Plan;
    const t = await env.svc.getTask(P.owner, ws, work.id);
    await env.svc.updateTask(
      P.owner,
      ws,
      work.id,
      { version: t.version, changes: { estimate_minutes: { base: 90, value: 150 } } },
      mutation({ ifMatch: `"${t.version}"` }),
    );
    const blocks = () =>
      sql(
        `SELECT count(*)::int AS n FROM planning.work_block w JOIN core.record r ON r.id = w.task_id
          WHERE r.public_id = $1 AND w.source = 'plan'`,
        [work.id],
      );
    expect(
      issueCodes(
        await refusal(env.svc.applyAiProposal(P.member, ws, plan.id, bind(plan), mutation())),
      ),
    ).toEqual(['plan_changed']);
    expect((await blocks())[0]!.n).toBe(0);
    const now = (await env.svc.getAiProposal(P.member, ws, plan.id)) as unknown as Plan;
    expect(now.plan.current.state).toBe('changed');
    plan = (
      await env.svc.rebaseAiProposal(
        P.member,
        ws,
        plan.id,
        { revision: now.revision, reviewed: {}, snapshot: now.plan.current.snapshot },
        mutation(),
      )
    ).data as Plan;
    plan = (await env.svc.approveAiProposal(P.member, ws, plan.id, bind(plan), mutation()))
      .data as Plan;
    const key = mutation();
    await env.svc.applyAiProposal(P.member, ws, plan.id, bind(plan), key);
    await env.svc.applyAiProposal(P.member, ws, plan.id, bind(plan), key);
    expect((await blocks())[0]!.n).toBeGreaterThan(0);
    const n = (await blocks())[0]!.n;
    expect(
      issueCodes(
        await refusal(env.svc.applyAiProposal(P.member, ws, plan.id, bind(plan), mutation())),
      ),
    ).toEqual(['proposal_already_applied']);
    expect((await blocks())[0]!.n).toBe(n);
    expect(await applied(plan.id)).toEqual({ events: 1, applications: 1 });
  });

  it('AT-530 assist, interpretation, and transcription share one authoritative budget: exactly-at-limit fits once, held and unknown liability blocks the next feature, nothing is clamped or resent', async () => {
    const setCost = (hard: string) =>
      stepped(env, () =>
        env.svc.updateAiLimits(
          B.owner,
          B.ws,
          { limits: [{ meter: 'ai.cost', monthly_allowance: hard, hard_limit: hard }] },
          stepUp(),
        ),
      );
    const source = (
      await env.svc.createTask(
        B.owner,
        B.ws,
        { brand: B.brand, title: 'Budget source' },
        mutation(),
      )
    ).data.id as string;
    const retrieval = { scope: {}, include: [{ type: 'task', id: source }] };
    const m = await env.svc.previewAiContext(B.owner, B.ws, retrieval);
    const req = {
      action: 'summarize.v1',
      ...retrieval,
      instruction: 'Budget probe #fixture:hang',
      manifest_digest: m.digest,
      confirm_cost: true,
    };
    const est = await env.svc.estimateAiAssist(B.owner, B.ws, req);
    const one = Number(est.max_cost.micros);
    const before = await ledger(db, B.wsId);
    // The hard limit is exactly what is already used plus one bound: the bound fits exactly once.
    await setCost((before.consumed + before.reserved + one).toFixed(6));
    const exact = await env.svc.estimateAiAssist(B.owner, B.ws, req);
    expect(exact.within_limits).toBe(true);
    const held = await env.svc.startAiAssist(
      B.owner,
      B.ws,
      { ...req, input_digest: exact.input_digest },
      mutation(),
    );
    // The reservation is taken at dispatch; the call is held open so the liability stays.
    const w = await aiWorker(env);
    extra.push(w);
    const inflight = w.runCycle({ wait: true });
    for (
      let i = 0;
      i < 100 && !fx.control.received().some((r) => r.user.includes('Budget probe'));
      i++
    )
      await new Promise((r) => setTimeout(r, 30));
    expect((await ledger(db, B.wsId)).reserved).toBeCloseTo(before.reserved + one, 6);
    // The reservation is liability for every other feature on the same meter.
    const again = await env.svc.estimateAiAssist(B.owner, B.ws, req);
    expect(again.within_limits).toBe(false);
    const interp = {
      action: 'interpret_capture.v1',
      scope: {},
      include: [],
      instruction: 'Call Sam',
    };
    const im = await env.svc.previewAiContext(B.owner, B.ws, { scope: {}, include: [] });
    expect(
      (await env.svc.estimateAiAssist(B.owner, B.ws, { ...interp, manifest_digest: im.digest }))
        .within_limits,
    ).toBe(false);
    const rec = await record(B.owner, 'Budget recording', B.ws);
    const refused = await refusal(
      env.svc.transcribeVoiceCapture(B.owner, B.ws, rec.id, mutation()),
    );
    expect(refused.code).toBe('usage_limit_reached');
    // Settling the held run releases only the unused part; the actual cost stays consumed.
    // The held call ends without a usable reply: the outcome is unknown, so the bound stays
    // reserved (possibly charged) and is never resent, clamped, or dropped.
    fx.control.releaseHung();
    await inflight;
    expect(await drain(db, worker, held.data.id)).toMatchObject({
      execution_state: 'waiting',
      waiting_reason: 'reconciliation_required',
    });
    expect((await ledger(db, B.wsId)).reserved).toBeCloseTo(before.reserved + one, 6);
    expect(
      (await refusal(env.svc.transcribeVoiceCapture(B.owner, B.ws, rec.id, mutation()))).code,
    ).toBe('usage_limit_reached');
    expect(fx.control.received().filter((r) => r.user.includes('Budget probe'))).toHaveLength(1);
    // An explicit reconciliation settles the conservative bound as consumed, once.
    await stepped(env, () =>
      env.svc.reconcileAiDispatch(
        B.owner,
        B.ws,
        held.data.id,
        '1',
        { basis: 'reserved_bound' },
        stepUp(),
      ),
    );
    const settled = await ledger(db, B.wsId);
    expect(settled.reserved).toBeCloseTo(before.reserved, 6);
    expect(settled.consumed).toBeCloseTo(before.consumed + one, 6);
    // With room again, the waiting recording transcribes once; the ledger still conserves.
    await setCost('1000000');
    const heard = await transcribe(B.owner, rec.id, B.ws);
    expect(heard.state).toBe('transcribed');
    await ledger(db, B.wsId);
  });

  it('AT-531 with AI, speech, storage, or email unavailable every surface says so truthfully and the manual core (capture, triage, task edits, Today plans, briefings) still works', async () => {
    // The same database with no AI configured at all (the production default), with no object
    // storage, and with email unconfigured.
    const off = workEnv(db, { emailState: 'unconfigured' });
    const noStore = workEnv(db, { ai: fixtureAi(fx), files: { storage: null } });
    try {
      const overview = await off.svc.aiOverview(P.owner, ws);
      expect(overview).toMatchObject({
        availability: 'unconfigured',
        reason: expect.stringContaining('continue manually'),
      });
      const m = await off.svc.previewAiContext(P.owner, ws, {
        include: [{ type: 'task', id: T.open }],
      });
      expect(m.ai.can_answer).toBe(false);
      const est = await refusal(
        off.svc.startAiAssist(
          P.owner,
          ws,
          {
            action: 'summarize.v1',
            include: [{ type: 'task', id: T.open }],
            instruction: 'Nothing configured',
            manifest_digest: m.digest,
            input_digest: 'a'.repeat(64),
            confirm_cost: true,
          },
          mutation(),
        ),
      );
      expect(est).toMatchObject({ code: 'dependency_unavailable' });
      expect(issueCodes(est)).toEqual(['ai_unconfigured']);
      expect(await off.svc.voiceSettings(P.member, ws)).toMatchObject({
        transcription: expect.stringMatching(/^(not_configured|ai_unavailable)$/),
        synthetic: false,
      });
      expect(await noStore.svc.voiceSettings(P.member, ws)).toMatchObject({
        transcription: 'storage_unavailable',
      });
      const bytes = syntheticWav(1, { transcript: 'No storage' });
      expect(
        issueCodes(
          await refusal(
            noStore.svc.createVoiceCapture(
              P.member,
              ws,
              {
                format: 'audio/wav',
                byte_size: bytes.byteLength,
                sha256: sha(bytes),
                duration_ms: 1000,
              },
              mutation(),
            ),
          ),
        ),
      ).toContain('storage_unavailable');
      // Manual capture and triage, then an ordinary task edit.
      const item = (
        await off.svc.capture(
          P.member,
          ws,
          { text: 'Manual capture without AI', brand: harbor },
          mutation(),
        )
      ).data.id as string;
      expect((await off.svc.getInboxItem(P.member, ws, item)).interpretation).toBeNull();
      const triaged = (
        await off.svc.triage(P.member, ws, { items: [item], to: 'task' }, mutation())
      ).data.items[0] as { outcome: string; record: string };
      expect(triaged.outcome).toBe('applied');
      const task = await off.svc.getTask(P.member, ws, triaged.record);
      await off.svc.updateTask(
        P.member,
        ws,
        task.id,
        { version: task.version, changes: { estimate_minutes: { base: null, value: 45 } } },
        mutation({ ifMatch: `"${task.version}"` }),
      );
      // The rule-based Today plan needs no provider.
      const pv = await off.svc.previewDayPlan(P.member, ws, { day });
      expect(pv).toMatchObject({ mode: 'rule_based', generated: false });
      // Fact-only briefings need no provider; email is truthfully not configured.
      const brf = (
        await off.svc.generateBriefing(P.member, ws, { kind: 'owner_daily' }, mutation())
      ).data;
      expect(brf).toMatchObject({ state: 'published', mode: 'fact_only' });
      const sched = (
        await off.svc.createBriefingSchedule(
          P.member,
          ws,
          {
            kind: 'owner_daily',
            scope: {},
            weekdays: [1, 2, 3, 4, 5],
            timezone: 'UTC',
            local_time: '06:00',
            channels: ['in_app', 'email'],
          },
          mutation(),
        )
      ).data;
      expect(sched.email).toBe('not_configured');
      expect((await off.svc.listBriefingSchedules(P.member, ws)).email).toBe('not_configured');
    } finally {
      await off.h.close();
      await noStore.h.close();
    }
  });

  it('AT-532 the registered briefing sweep across workspaces publishes each due occurrence once, as its recipient, through overlap, restart, edits, departure, and a failing email channel; a regeneration never advances the baseline', async () => {
    const schedule = async (who: Caller, space: string, extra: Record<string, unknown> = {}) =>
      (
        await env.svc.createBriefingSchedule(
          who,
          space,
          {
            kind: 'owner_daily',
            scope: {},
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            timezone: 'UTC',
            local_time: '00:00',
            ...extra,
          },
          mutation(),
        )
      ).data as { id: string; email: string };
    const due = (bsc: string) =>
      sql(
        `UPDATE ai.briefing_schedule SET next_run_at = date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          WHERE public_id = $1`,
        [bsc],
      );
    const briefingsOf = (bsc: string) =>
      sql(
        `SELECT b.public_id, b.state, b.trigger, b.recipient_membership_id AS recipient
           FROM ai.briefing b JOIN ai.briefing_schedule s ON s.id = b.schedule_id
          WHERE s.public_id = $1 ORDER BY b.created_at`,
        [bsc],
      );
    const sweep = aiBriefingSweepHandler({ ...handlerDeps(), service: env.svc } as never);
    // Schedules in three workspaces, one disabled, and one for a member who leaves before it runs.
    // The owner's schedule is its own series (earlier tests published manual owner_daily ones).
    const ownerA = await schedule(P.owner, ws, {
      kind: 'brand_daily',
      scope: { brand: harbor },
      channels: ['in_app', 'email'],
    });
    const memberA = await schedule(P.member, ws);
    const off = await schedule(P.administrator, ws, { enabled: false });
    const ownerB = await schedule(B.owner, B.ws, { channels: ['in_app', 'email'] });
    const memberC = await schedule(P.member, C.ws);
    // B's owner made a briefing by hand after today's occurrence was due: the occurrence reads
    // its own window and must not claim that later briefing as its baseline.
    const handMade = (
      await env.svc.generateBriefing(B.owner, B.ws, { kind: 'owner_daily' }, mutation())
    ).data.id as string;
    const goner = await join(env, db, B.owner, B.ws, { kind: 'member', role: 'member' });
    const gonerSchedule = await schedule(goner, B.ws);
    expect(ownerA.email).toBe('requested');
    for (const x of [ownerA, memberA, off, ownerB, memberC, gonerSchedule]) await due(x.id);
    const gonerM = (await membershipOf(db, B.wsId, goner.auth.account.id))!;
    const bOwnerM = (await membershipOf(db, B.wsId, B.owner.auth.account.id))!;
    const preview = await env.svc.previewChange(B.owner, B.ws, {
      kind: 'remove',
      member: gonerM.public_id,
    });
    await stepped(env, () =>
      env.svc.removeMember(
        B.owner,
        B.ws,
        gonerM.public_id,
        { preview_token: preview.preview_token, reassign_to: bOwnerM.public_id },
        mutation({ stepUpToken: 't' }),
      ),
    );
    // The member's A schedule is edited after its occurrence was queued but before composition.
    await env.svc.runBriefingSweep(env.h.worker, wsId, new Date(), { compose: false });
    const queued = await briefingsOf(memberA.id);
    expect(queued.map((b) => b.state)).toEqual(['queued']);
    await env.svc.updateBriefingSchedule(
      P.member,
      ws,
      memberA.id,
      { local_time: '00:01' },
      mutation(),
    );
    // Two overlapping runs of the registered handler, then a restart.
    await Promise.all([sweep.handle({} as never), sweep.handle({} as never)]);
    await sweep.handle({} as never);
    const one = async (bsc: string, recipient: string) => {
      const rows = await briefingsOf(bsc);
      expect(
        rows.map((r) => [r.state, r.trigger]),
        bsc,
      ).toEqual([['published', 'schedule']]);
      expect(rows[0]!.recipient).toBe(recipient);
      return rows[0]!.public_id as string;
    };
    const aOwnerBrf = await one(ownerA.id, await memId(P.owner));
    const bScheduled = await one(ownerB.id, bOwnerM.id);
    const bView = await env.svc.getBriefing(B.owner, B.ws, bScheduled);
    expect(bView.baseline).not.toBe(handMade);
    expect(bView).toMatchObject({ baseline: null, first: true });
    expect(Date.parse(bView.window.start)).toBeLessThan(Date.parse(bView.window.end));
    await one(memberC.id, await memId(P.member, C.wsId));
    expect((await briefingsOf(memberA.id)).map((b) => b.state)).toEqual(['superseded']);
    expect(await briefingsOf(off.id)).toEqual([]);
    expect(await briefingsOf(gonerSchedule.id)).toEqual([]);
    expect(
      await sql(`SELECT enabled FROM ai.briefing_schedule WHERE public_id = $1`, [
        gonerSchedule.id,
      ]),
    ).toEqual([{ enabled: false }]);
    // One in-app notice per published briefing, to its recipient only.
    const notices = await sql(
      `SELECT n.recipient_membership_id AS recipient, count(*)::int AS n FROM notify.notification n
        WHERE n.type = 'briefing_ready' AND n.facts->>'briefing' = $1 GROUP BY 1`,
      [aOwnerBrf],
    );
    expect(notices).toEqual([{ recipient: await memId(P.owner), n: 1 }]);
    // A failing email channel: in-app stays delivered, the briefing stays published, and the
    // failure is recorded on the email delivery alone (no content in the message either way).
    const failing = {
      name: 'failing',
      send: () => Promise.reject(new Error('mail relay unavailable')),
    };
    await runNotifyWorkspace(
      {
        tenant: env.h.worker,
        discovery: env.h.discovery,
        email: emailProviderFrom(failing as never, 'PM <no-reply@localhost>'),
        origin: 'https://pm.example.test',
        metrics: env.h.telemetry.metrics,
        logger: env.h.logger,
        arrayMax: 10_000,
      },
      wsId,
      new Date(),
    );
    const deliveries = await sql(
      `SELECT d.channel, d.state FROM notify.delivery d JOIN notify.notification n ON n.id = d.notification_id
        WHERE n.type = 'briefing_ready' AND n.facts->>'briefing' = $1 ORDER BY d.channel`,
      [aOwnerBrf],
    );
    expect(deliveries.find((d) => d.channel === 'email')?.state).not.toBe('sent');
    expect(deliveries.find((d) => d.channel === 'in_app')?.state).not.toBe('failed');
    expect((await env.svc.getBriefing(P.owner, ws, aOwnerBrf)).state).toBe('published');
    // Regenerating the scheduled briefing keeps its window and baseline and is not a new baseline:
    // the next scheduled occurrence continues from the scheduled briefing.
    const regen = (await env.svc.regenerateBriefing(P.owner, ws, aOwnerBrf, mutation())).data;
    const first = await env.svc.getBriefing(P.owner, ws, aOwnerBrf);
    expect(regen).toMatchObject({ trigger: 'regenerate', regenerates: aOwnerBrf });
    expect(regen.window).toEqual(first.window);
    expect(regen.baseline).toEqual(first.baseline);
    // Re-arming the same occurrence publishes nothing (one briefing per occurrence key).
    await due(ownerA.id);
    await sweep.handle({} as never);
    expect((await briefingsOf(ownerA.id)).filter((r) => r.trigger === 'schedule')).toHaveLength(1);
    // A later occurrence (the schedule moved to a minute already past) continues from it.
    const at = new Date(Date.now() - 2 * 60_000);
    at.setUTCSeconds(0, 0);
    const hhmm = at.toISOString().slice(11, 16);
    await env.svc.updateBriefingSchedule(P.owner, ws, ownerA.id, { local_time: hhmm }, mutation());
    await sql(`UPDATE ai.briefing_schedule SET next_run_at = $2 WHERE public_id = $1`, [
      ownerA.id,
      at,
    ]);
    await sweep.handle({} as never);
    const rows = await briefingsOf(ownerA.id);
    const next = rows.filter((r) => r.trigger === 'schedule' && r.public_id !== aOwnerBrf);
    expect(next).toHaveLength(1);
    const nv = await env.svc.getBriefing(P.owner, ws, next[0]!.public_id as string);
    expect(nv.baseline).toBe(aOwnerBrf);
    expect(nv.window.start).toEqual(first.window.end);
  });

  // Last: it rolls the shared database back one step and forward again.
  it('AT-533 migration 0060: a saved recording outlives its purged item under forced RLS; the rollback relabels it and restores the exact 0059 check; re-apply is clean', async () => {
    const check = async () =>
      (
        await sql(
          `SELECT pg_get_constraintdef(c.oid) AS def, t.relforcerowsecurity AS forced
             FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
            WHERE c.conname = 'voice_capture_saved'`,
        )
      )[0];
    const orphaned = async () =>
      (
        await sql(
          `SELECT count(*)::int AS n FROM capture.voice_capture WHERE state = 'saved' AND inbox_item_id IS NULL`,
        )
      )[0]!.n as number;
    expect(await check()).toEqual({
      def: "CHECK (((inbox_item_id IS NULL) OR (state = 'saved'::text)))",
      forced: true,
    });
    // AT-527 and AT-528 purged items saved from recordings.
    const kept = await orphaned();
    expect(kept).toBeGreaterThan(0);
    // An unsaved recording still cannot name an item (the tenant role, through RLS).
    const unsaved = await record(P.member, 'Never saved');
    const anyItem = (
      await sql(`SELECT id FROM capture.inbox_item WHERE workspace_id = $1 LIMIT 1`, [wsId])
    )[0]!.id as string;
    await expect(
      env.h.app.withWorkspace(wsId, { module: 'test' }, (tx) =>
        tx.db
          .updateTable('capture.voice_capture')
          .set({ inbox_item_id: anyItem })
          .where('public_id', '=', unsaved.id)
          .execute(),
      ),
    ).rejects.toThrow(/voice_capture_saved/);
    const migrator = new Migrator({ connectionString: db.migrator, environment: 'test' });
    await migrator.down(59);
    expect(await check()).toEqual({
      def: "CHECK (((state = 'saved'::text) = (inbox_item_id IS NOT NULL)))",
      forced: true,
    });
    expect(await orphaned()).toBe(0);
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM capture.voice_capture WHERE state = 'expired' AND inbox_item_id IS NULL AND storage_key IS NULL`,
        )
      )[0]!.n,
    ).toBeGreaterThanOrEqual(kept);
    await migrator.up();
    expect((await sql(`SELECT max(version)::int AS v FROM ops.schema_migration`))[0]!.v).toBe(60);
    expect((await check())!.def).toBe(
      "CHECK (((inbox_item_id IS NULL) OR (state = 'saved'::text)))",
    );
  });
});
