import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { startGoogleCalendarFixture, type GoogleCalendarFixture } from '@pm/test-support';
import type { Caller } from '@pm/tenancy';
import {
  addDays,
  connectionAdapter,
  GoogleCalendarProvider,
  isoWeekday,
  localDay,
  webhookSubscriptionAdapter,
} from '@pm/work';
import { signPayload, signatureHeader } from '../../src/integrations/semantics.ts';
import {
  syntheticCaller,
  type WebhookTransport,
} from '../../src/integrations/public-api-service.ts';
import { oauthSyntheticCaller } from '../../src/integrations/mcp-access-service.ts';
import { parseCsv } from '../../src/portability/csv.ts';
import {
  apply,
  internalIdOf,
  join,
  membershipOf,
  outboxEvents,
  mutation,
  seedAccount,
  workEnv,
  workspaceIdOf,
  workspaceWith,
  WORKSPACE_INPUT,
  type WorkEnv,
} from './fixture.ts';

type Who =
  | 'owner'
  | 'administrator'
  | 'member'
  | 'manager'
  | 'limited_member'
  | 'read_only'
  | 'share_only'
  | 'guest'
  | 'leaver'
  | 'planner';
const ULID = '01J8M5Y7A3B2C4D6E8F0G1H2J3';
const UNKNOWN = {
  conn: `conn_${ULID}`,
  sub: `whk_${ULID}`,
  delivery: `whd_${ULID}`,
  token: `tok_${ULID}`,
  client: `oac_${ULID}`,
  task: `tsk_${ULID}`,
  brand: `br_${ULID}`,
};
const LOOPBACK_KEY = 'loopback-matrix-key';
const reason = (code: string) => expect.objectContaining({ code });
const ifMatch = (v: number) => mutation({ ifMatch: `"${v}"` });
const loop = (extra: Record<string, unknown> = {}) => ({
  provider: 'loopback',
  auth_kind: 'api_key',
  display_name: 'Loopback',
  scopes: ['read', 'write'],
  api_key: LOOPBACK_KEY,
  ...extra,
});
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

/**
 * Phase 6 integration matrix (exit gate): three workspaces; owner, administrator, member, a brand
 * manager, limited and read-only members, a share-only member, a guest, a departing member, and a
 * calendar user; a sensitive brand and a restricted project. Connections, provider scopes, API
 * tokens, MCP consent, webhooks, calendars, CSV portability, audit export, lifecycle, and logs all
 * agree with the one canonical read decision; hidden, foreign, and unknown identifiers fail the
 * same way; departure and revocation stop delegated execution at once; nothing leaks a secret.
 */
describe('Phase 6 cross-boundary matrix', () => {
  let db: TestDatabase;
  let fx: GoogleCalendarFixture;
  let env: WorkEnv;
  let ws: string;
  let wsId: string;
  let harbor: string;
  let vault: string;
  let week: string;
  const P = {} as Record<Who, Caller>;
  const M = {} as Record<Who, string>;
  const T = {} as Record<'open' | 'restricted' | 'vault' | 'shared', string>;
  const C = {} as Record<'harbor' | 'vault', string>;
  const A = {} as { client: string; clientSecret: string; revokedClient: string; job: string };
  const B = {} as {
    owner: Caller;
    ws: string;
    brand: string;
    conn: string;
    sub: string;
    delivery: string;
    token: string;
    client: string;
    job: string;
  };
  /** Every secret minted during the run (checked against logs and audit at the end). */
  const secrets: string[] = [LOOPBACK_KEY];
  const sent: Array<{ id: string; body: string }> = [];
  let status = 200;

  const mem = async (c: Caller) => (await membershipOf(db, wsId, c.auth.account.id))!.public_id;
  const grant = (who: Who, brand: string, level: string) =>
    apply(env, P.owner, ws, { kind: 'brand_grant', brand, principal: M[who], level });
  const revoke = (who: Who, brand: string) =>
    apply(env, P.owner, ws, { kind: 'brand_revoke', brand, principal: M[who] });
  const stepped = async <T>(fn: () => Promise<T>) => {
    env.stepUp.allow = true;
    try {
      return await fn();
    } finally {
      env.stepUp.allow = false;
    }
  };
  const remove = async (who: Who) =>
    stepped(async () =>
      env.svc.removeMember(
        P.owner,
        ws,
        M[who],
        {
          preview_token: (
            await env.svc.previewChange(P.owner, ws, { kind: 'remove', member: M[who] })
          ).preview_token,
          reassign_to: M.owner,
        },
        mutation({ stepUpToken: 't' }),
      ),
    );
  const apiToken = async (who: Caller, scopes: string[], space = ws) => {
    const made = await stepped(() =>
      env.svc.createToken(
        who,
        space,
        { name: 'Matrix', kind: 'personal', scopes },
        mutation({ stepUpToken: 't' }),
      ),
    );
    secrets.push(made.data.secret!);
    return made.data;
  };
  const asToken = async (secret: string) => {
    const auth = await env.svc.authenticateApiToken(secret);
    return (
      auth && syntheticCaller(auth.accountId, auth.delegation, { correlationId: 'a'.repeat(32) })
    );
  };
  const mcpAs = async (who: Caller, scopes: string[]) => {
    await env.svc.grantOAuthConsent(who, ws, A.client, { scopes }, mutation());
    const issued = await env.svc.issueOAuthAccessToken(
      who,
      ws,
      { client_id: A.client, client_secret: A.clientSecret },
      mutation(),
    );
    secrets.push(issued.data.access_token!);
    const auth = await env.svc.authenticateOAuthAccessToken(issued.data.access_token!);
    return {
      secret: issued.data.access_token!,
      caller: oauthSyntheticCaller(auth!.accountId, auth!.delegation, {
        correlationId: 'd'.repeat(32),
      }),
    };
  };
  const rpc = (c: Caller, method: string, params?: unknown, req = mutation(), space = ws) =>
    env.svc.handleMcpRpc(c, space, { jsonrpc: '2.0', id: 7, method, params }, req);
  const call = (c: Caller, name: string, args: Record<string, unknown>, meta?: object) =>
    rpc(c, 'tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  const loopConn = async (who: Caller, brand: string, name: string, space = ws) =>
    (await env.svc.createConnection(who, space, loop({ brand, display_name: name }), mutation()))
      .data.id;
  const subscribe = async (
    who: Caller,
    path: string,
    event: string,
    brand?: string,
    space = ws,
  ) => {
    const made = await env.svc.createSubscription(
      who,
      space,
      { destination_url: `https://127.0.0.1/hooks/${path}`, event_types: [event], brand },
      mutation(),
    );
    secrets.push(made.data.secret!);
    return made.data;
  };
  const oneCalendar = () => {
    fx.control.reset();
    fx.control.setCalendars([
      { id: 'me@example.test', summary: 'Me', timeZone: 'UTC', accessRole: 'owner', primary: true },
    ]);
  };
  const n = async (text: string, params: unknown[] = []) =>
    (await db.admin(`SELECT count(*)::int AS n FROM ${text}`, params)).rows[0].n as number;
  const queueSync = (conn: string, key: string) =>
    db.admin(
      `INSERT INTO integrations.sync_delivery (id, workspace_id, connection_id, dedupe_key)
       SELECT gen_random_uuid(), c.workspace_id, c.id, $2 FROM integrations.connection c
         JOIN core.record r ON r.id = c.id WHERE r.public_id = $1`,
      [conn, key],
    );
  const syncDelivery = async (key: string) =>
    (
      await db.admin(
        `SELECT state, error_code FROM integrations.sync_delivery WHERE dedupe_key = $1`,
        [key],
      )
    ).rows[0];
  const connRow = async (conn: string) =>
    (
      await db.admin(
        `SELECT c.health, c.suspended_reason, c.credential_secret_ref AS ref, r.lifecycle_state
           FROM integrations.connection c JOIN core.record r ON r.id = c.id WHERE r.public_id = $1`,
        [conn],
      )
    ).rows[0] as { health: string; suspended_reason: string | null; ref: string | null };
  const sweepSync = () => env.svc.runSyncSweep(env.h.app, wsId, new Date(Date.now() + 60_000));
  const importTasks = async (who: Caller, space: string, csv: string) => {
    const preview = await env.svc.previewPortabilityImportFor(who, space, { csv, entity: 'task' });
    return env.svc.applyPortabilityImport(
      who,
      space,
      { csv, entity: 'task', preview_id: preview.preview_id, mode: 'partial' },
      mutation(),
    );
  };
  /** The browser-shaped Google OAuth round trip through the fixture. */
  const connectCalendar = async (who: Caller, brand: string, name: string) => {
    const made = await env.svc.createConnection(
      who,
      ws,
      {
        provider: 'google_calendar',
        auth_kind: 'oauth',
        display_name: name,
        scopes: ['calendar.read', 'calendar.write'],
        brand,
      },
      mutation(),
    );
    const url = (made.data as { authorization_url?: string }).authorization_url!;
    const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')!);
    await env.svc.completeOauth(
      who,
      ws,
      made.data.id,
      { code: back.searchParams.get('code'), state: back.searchParams.get('state') },
      mutation(),
    );
    return made.data.id;
  };
  const at = (day: string, hhmm: string) => `${day}T${hhmm}:00.000Z`;

  beforeAll(async () => {
    db = await createTestDatabase();
    fx = await startGoogleCalendarFixture();
    const transport: WebhookTransport = async (req) => {
      sent.push({ id: req.headers['webhook-id']!, body: req.body });
      return { kind: 'status', status };
    };
    env = workEnv(db, {
      deliver: transport,
      calendarProvider: new GoogleCalendarProvider({
        clientId: fx.clientId,
        clientSecret: () => fx.clientSecret,
        redirectUri: 'http://127.0.0.1:9/v1/integrations/oauth/google_calendar/callback',
        authorizeUrl: `${fx.baseUrl}/o/oauth2/v2/auth`,
        tokenUrl: `${fx.baseUrl}/token`,
        revokeUrl: `${fx.baseUrl}/revoke`,
        apiBase: `${fx.baseUrl}/calendar/v3`,
        timeoutMs: 5000,
      }),
      work: {
        mcpEnabled: true,
        webhookMaxAttempts: 3,
        syncMaxAttempts: 1,
        syncBackoffSeconds: 1,
        calendarSyncHorizonDays: 120,
      },
    });
    const today = localDay(new Date(), 'UTC');
    week = addDays(today, 7 + ((8 - isoWeekday(today)) % 7));

    // Workspace A: Harbor (normal), Vault (sensitive, owner self-granted manage), a restricted project.
    P.owner = await seedAccount(db);
    const created = await env.svc.createWorkspace(
      P.owner,
      { ...WORKSPACE_INPUT, name: 'Matrix six', first_brand: { name: 'Harbor' } },
      mutation(),
    );
    ws = created.data.workspace.id;
    wsId = await workspaceIdOf(db, ws);
    harbor = created.data.first_brand!.id;
    vault = (await env.svc.createBrand(P.owner, ws, { name: 'Vault' }, mutation())).data.id;
    await stepped(() =>
      env.svc.setSensitivity(
        P.owner,
        ws,
        vault,
        { is_sensitive: true },
        mutation({ ifMatch: '"0"', stepUpToken: 't' }),
      ),
    );
    P.administrator = await join(env, db, P.owner, ws, { kind: 'member', role: 'administrator' });
    for (const who of ['member', 'manager', 'share_only', 'leaver', 'planner'] as const)
      P[who] = await join(env, db, P.owner, ws, { kind: 'member', role: 'member' });
    P.limited_member = await join(env, db, P.owner, ws, { kind: 'member', role: 'limited_member' });
    P.read_only = await join(env, db, P.owner, ws, { kind: 'member', role: 'read_only' });
    for (const who of Object.keys(P) as Who[]) M[who] = await mem(P[who]);
    await grant('owner', vault, 'manage');
    await grant('member', harbor, 'edit');
    await grant('manager', harbor, 'manage');
    await grant('leaver', harbor, 'manage');
    await grant('planner', harbor, 'manage');
    await grant('limited_member', harbor, 'view');
    await grant('read_only', harbor, 'view');
    const open = (
      await env.svc.createProject(P.owner, ws, { brand: harbor, name: 'Open harbor' }, mutation())
    ).data.id;
    const restricted = (
      await env.svc.createProject(P.owner, ws, { brand: harbor, name: 'Restricted A' }, mutation())
    ).data.id;
    await env.svc.setAccess(
      P.owner,
      ws,
      restricted,
      { access_mode: 'restricted', allow_record_shares: false },
      mutation(),
    );
    const task = async (body: Record<string, unknown>) =>
      (await env.svc.createTask(P.owner, ws, body, mutation())).data.id;
    T.open = await task({ project: open, title: 'Open harbor brief' });
    T.restricted = await task({ project: restricted, title: 'Restricted sigma' });
    T.vault = await task({ brand: vault, title: 'Vault omega plan' });
    T.shared = await task({ brand: harbor, title: 'Shared brief' });
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
    C.harbor = await loopConn(P.manager, harbor, 'Harbor sync');
    C.vault = await loopConn(P.owner, vault, 'Vault omega link');
    const client = await env.svc.createOAuthClient(
      P.owner,
      ws,
      {
        name: 'Matrix agent',
        redirect_uris: ['https://agent.example/callback'],
        scopes: ['records:read', 'records:write'],
      },
      mutation(),
    );
    A.client = client.data.id;
    A.clientSecret = client.data.client_secret;
    secrets.push(A.clientSecret);
    const retired = await env.svc.createOAuthClient(
      P.owner,
      ws,
      { name: 'Retired', redirect_uris: ['https://old.example/cb'], scopes: ['records:read'] },
      mutation(),
    );
    secrets.push(retired.data.client_secret);
    A.revokedClient = retired.data.id;
    await env.svc.revokeOAuthClient(P.owner, ws, A.revokedClient, mutation());
    A.job = (
      await importTasks(P.owner, ws, `schema_version,title,brand_id\n1,Owner import,${harbor}`)
    ).import_job_id!;

    // Workspace B: another owner's connection, webhook, delivery, token, client, and import job.
    const b = await workspaceWith(env, db, ['Bravo']);
    B.owner = b.owner;
    B.ws = b.ws;
    B.brand = b.brands.Bravo!;
    B.conn = await loopConn(B.owner, B.brand, 'Bravo link', B.ws);
    B.sub = (await subscribe(B.owner, 'bravo', 'task.updated', undefined, B.ws)).id;
    B.delivery = (await env.svc.testSubscription(B.owner, B.ws, B.sub, mutation())).data.id;
    B.token = (await apiToken(B.owner, ['records:read'], B.ws)).id;
    const clientB = await env.svc.createOAuthClient(
      B.owner,
      B.ws,
      { name: 'Bravo agent', redirect_uris: ['https://b.example/cb'], scopes: ['records:read'] },
      mutation(),
    );
    secrets.push(clientB.data.client_secret);
    B.client = clientB.data.id;
    B.job = (
      await importTasks(B.owner, B.ws, `schema_version,title,brand_id\n1,Bravo row,${B.brand}`)
    ).import_job_id!;
  }, 240_000);

  afterAll(async () => {
    await fx?.close();
    await env?.h.close();
    await db?.drop();
  });

  it('AT-330 connection ownership and provider scopes never widen record permissions', async () => {
    const surfaces = [
      (c: Caller, id: string) => env.svc.getConnection(c, ws, id),
      (c: Caller, id: string) => env.svc.listRuns(c, ws, id),
      (c: Caller, id: string) => env.svc.listConflicts(c, ws, id),
      (c: Caller, id: string) => env.svc.testConnection(c, ws, id, mutation()),
      (c: Caller, id: string) => env.svc.syncNow(c, ws, id, mutation()),
      (c: Caller, id: string) => env.svc.disconnect(c, ws, id, { retention: 'retain' }, mutation()),
    ];
    // The Vault connection is unknown to everyone without Vault; Harbor's is unknown to people
    // without Harbor. Every refusal is exactly the refusal for an identifier that never existed.
    const cases: Array<[Who, string]> = [
      ...(
        ['administrator', 'member', 'limited_member', 'read_only', 'share_only', 'guest'] as const
      ).map((w): [Who, string] => [w, C.vault]),
      ['share_only', C.harbor],
      ['guest', C.harbor],
    ];
    for (const [who, id] of cases)
      for (const s of surfaces) {
        const hidden = await refusal(s(P[who], id));
        expect(hidden, `${who}`).toEqual(await refusal(s(P[who], UNKNOWN.conn)));
        expect(['not_found', 'forbidden']).toContain(hidden.code);
        expect(JSON.stringify(hidden)).not.toMatch(/Vault omega|Harbor sync|conn_/);
      }
    // Harbor readers see the connection but can neither run nor change it.
    for (const who of ['member', 'limited_member', 'read_only'] as const) {
      expect((await env.svc.getConnection(P[who], ws, C.harbor)).display_name).toBe('Harbor sync');
      for (const s of surfaces.slice(3))
        expect(await refusal(s(P[who], C.harbor))).toMatchObject({ code: 'forbidden' });
      await expect(
        env.svc.createConnection(P[who], ws, loop({ brand: harbor }), mutation()),
      ).rejects.toEqual(reason('forbidden'));
    }
    // Listing never names what the caller cannot read.
    for (const who of [
      'administrator',
      'member',
      'limited_member',
      'read_only',
      'share_only',
    ] as const)
      expect(JSON.stringify(await env.svc.listConnections(P[who], ws))).not.toContain(
        'Vault omega',
      );
    await expect(env.svc.listConnections(P.guest, ws)).rejects.toEqual(reason('forbidden'));
    // A brand manager cannot place a connection on a brand they cannot read.
    expect(
      await refusal(env.svc.createConnection(P.manager, ws, loop({ brand: vault }), mutation())),
    ).toEqual(
      await refusal(
        env.svc.createConnection(P.manager, ws, loop({ brand: UNKNOWN.brand }), mutation()),
      ),
    );
    // Nothing above changed either connection; the provider write scope reads no Vault work.
    expect((await env.svc.getConnection(P.owner, ws, C.harbor)).health).toBe('connected');
    expect((await env.svc.getConnection(P.owner, ws, C.vault)).health).toBe('connected');
    await expect(env.svc.getTask(P.manager, ws, T.vault)).rejects.toEqual(reason('not_found'));
  });

  it('AT-331 hidden, foreign, and unknown identifiers fail identically on every Phase 6 surface', async () => {
    // A real open conflict on the Vault connection.
    await env.svc.syncNow(P.owner, ws, C.vault, mutation());
    const ident = (
      await db.admin(
        `SELECT e.public_id FROM integrations.external_identity e
           JOIN core.record r ON r.id = e.connection_id WHERE r.public_id = $1`,
        [C.vault],
      )
    ).rows[0].public_id;
    await env.svc.editLocal(P.owner, ws, C.vault, ident, { version: 'local-2' }, mutation());
    await env.svc.reauthorize(
      P.owner,
      ws,
      C.vault,
      loop({ display_name: 'Vault omega link', remote_version: '2' }),
      mutation(),
    );
    await env.svc.syncNow(P.owner, ws, C.vault, mutation());
    const conflict = (await env.svc.listConflicts(P.owner, ws, C.vault)).conflicts[0]!.id;
    const subVault = await subscribe(P.owner, 'vault', 'record.archived', vault);
    const vaultDelivery = (await env.svc.testSubscription(P.owner, ws, subVault.id, mutation()))
      .data.id;
    const memberToken = (await apiToken(P.member, ['records:read'])).id;
    const plannerCal = await connectCalendar(P.planner, harbor, 'Planner calendar');
    const admin = P.administrator;
    const resolve = (c: Caller, conn: string) =>
      env.svc.resolveConflict(c, ws, conn, conflict, { resolution: 'kept_local' }, mutation());
    const consent = (id: string) =>
      env.svc.grantOAuthConsent(P.member, ws, id, { scopes: ['records:read'] }, mutation());
    // [surface, call, hidden, foreign (workspace B), unknown]
    const triples: Array<[string, (id: string) => Promise<unknown>, string, string, string]> = [
      ['connection', (id) => env.svc.getConnection(admin, ws, id), C.vault, B.conn, UNKNOWN.conn],
      ['calendars', (id) => env.svc.listCalendars(admin, ws, id), plannerCal, B.conn, UNKNOWN.conn],
      ['conflict', (id) => resolve(P.member, id), C.vault, B.conn, UNKNOWN.conn],
      [
        'deliveries',
        (id) => env.svc.listDeliveries(admin, ws, id),
        subVault.id,
        B.sub,
        UNKNOWN.sub,
      ],
      [
        'replay',
        (id) => env.svc.replayDelivery(admin, ws, id, mutation()),
        vaultDelivery,
        B.delivery,
        UNKNOWN.delivery,
      ],
      [
        'token',
        (id) => env.svc.revokeToken(admin, ws, id, mutation()),
        memberToken,
        B.token,
        UNKNOWN.token,
      ],
      ['client', consent, A.revokedClient, B.client, UNKNOWN.client],
      ['errors', (id) => env.svc.exportImportErrors(admin, ws, id), A.job, B.job, randomUUID()],
      [
        'rollback',
        (id) => env.svc.rollbackPortabilityImport(admin, ws, id, mutation()),
        A.job,
        B.job,
        randomUUID(),
      ],
    ];
    for (const [name, run, hidden, foreign, unknown] of triples) {
      const u = await refusal(run(unknown));
      expect(await refusal(run(hidden)), name).toEqual(u);
      expect(await refusal(run(foreign)), name).toEqual(u);
      expect(u.code, name).toBe('not_found');
    }
    // The member (no Vault) cannot see the conflict either, in the list that would name it.
    expect(await refusal(env.svc.listConflicts(P.member, ws, C.vault))).toEqual(
      await refusal(env.svc.listConflicts(P.member, ws, UNKNOWN.conn)),
    );
    // A malformed job identifier is refused the same way (never an internal error).
    expect(
      await refusal(env.svc.rollbackPortabilityImport(admin, ws, 'not-a-job', mutation())),
    ).toEqual(
      await refusal(env.svc.rollbackPortabilityImport(admin, ws, randomUUID(), mutation())),
    );
    // Lists answer with nothing hidden or foreign, and never with another workspace's id.
    const listed = JSON.stringify([
      await env.svc.listSubscriptions(admin, ws),
      await env.svc.listTokens(admin, ws),
      await env.svc.listOAuthClients(P.member, ws),
      await env.svc.listConnections(admin, ws),
    ]);
    expect(listed).not.toContain(subVault.id);
    expect(listed).not.toContain(memberToken);
    expect(listed).not.toContain(B.ws);
    expect(listed).not.toMatch(/Vault omega|Bravo|whk_.*vault/);
    for (const s of secrets) expect(listed).not.toContain(s);
    // The owner still resolves the conflict once.
    expect((await resolve(P.owner, C.vault)).data).toMatchObject({ state: 'kept_local' });
  });

  it('AT-332 API-token scopes never widen permissions and are re-checked on every request', async () => {
    const write = await apiToken(P.member, ['records:write']);
    const read = await apiToken(P.member, ['records:read']);
    const tw = (await asToken(write.secret!))!;
    const tr = (await asToken(read.secret!))!;
    // Records the member cannot read are unknown to the token, on read and on write.
    for (const id of [T.vault, T.restricted])
      expect(await refusal(env.svc.getTask(tw, ws, id))).toEqual(
        await refusal(env.svc.getTask(tw, ws, UNKNOWN.task)),
      );
    expect(
      await refusal(env.svc.createTask(tw, ws, { brand: vault, title: 'Into vault' }, mutation())),
    ).toEqual(
      await refusal(
        env.svc.createTask(tw, ws, { brand: UNKNOWN.brand, title: 'Nowhere' }, mutation()),
      ),
    );
    expect(JSON.stringify((await env.svc.listTasks(tw, ws, { limit: 200 })).data)).not.toMatch(
      /Vault omega|Restricted sigma/,
    );
    // A read token cannot write, even where its member could.
    expect((await env.svc.getTask(tr, ws, T.open)).title).toBe('Open harbor brief');
    await expect(
      env.svc.createTask(tr, ws, { brand: harbor, title: 'Read-only write' }, mutation()),
    ).rejects.toEqual(reason('forbidden'));
    // Write scope does not give the token webhooks, tokens, connections, or audit export.
    await expect(env.svc.listSubscriptions(tw, ws)).rejects.toEqual(reason('forbidden'));
    await expect(env.svc.listTokens(tw, ws)).rejects.toEqual(reason('forbidden'));
    await expect(env.svc.exportPortabilityAudit(tw, ws, mutation())).rejects.toEqual(
      reason('forbidden'),
    );
    const made = await env.svc.createTask(
      tw,
      ws,
      { brand: harbor, title: 'Token task' },
      mutation(),
    );
    // Revoking the brand grant refuses the very same token on its next request.
    await revoke('member', harbor);
    expect(await refusal(env.svc.getTask(tw, ws, made.data.id))).toEqual(
      await refusal(env.svc.getTask(tw, ws, UNKNOWN.task)),
    );
    await expect(
      env.svc.createTask(tw, ws, { brand: harbor, title: 'After revoke' }, mutation()),
    ).rejects.toEqual(reason('not_found'));
    await grant('member', harbor, 'edit');
    expect((await env.svc.getTask(tw, ws, made.data.id)).id).toBe(made.data.id);
    // A revoked token authenticates as nothing at all.
    await env.svc.revokeToken(P.member, ws, write.id, mutation());
    expect(await env.svc.authenticateApiToken(write.secret!)).toBeNull();
  });

  it('AT-333 MCP consent never widens permissions and revocation stops the next call', async () => {
    const { caller: agent } = await mcpAs(P.member, ['records:write']);
    const notFound = { jsonrpc: '2.0', id: 7, error: { code: -32001, message: 'Not found.' } };
    for (const id of [T.vault, T.restricted, UNKNOWN.task])
      expect(await call(agent, 'pm.tasks.get', { task_id: id })).toEqual(notFound);
    expect(await call(agent, 'pm.tasks.create', { title: 'Agent vault', brand: vault })).toEqual(
      await call(agent, 'pm.tasks.create', { title: 'Agent nowhere', brand: UNKNOWN.brand }),
    );
    const listed = await call(agent, 'pm.tasks.list', { limit: 100 });
    expect(JSON.stringify(listed)).toContain('Open harbor brief');
    expect(JSON.stringify(listed)).not.toMatch(/Vault omega|Restricted sigma/);
    // A read-only person consenting to read sees no write tools and cannot call one.
    const { caller: reader } = await mcpAs(P.read_only, ['records:read']);
    expect(JSON.stringify(await rpc(reader, 'tools/list'))).not.toContain('pm.tasks.create');
    expect(await call(reader, 'pm.tasks.create', { title: 'Nope', brand: harbor })).toMatchObject({
      error: { code: -32002 },
    });
    // Losing the brand refuses the same token at once; regaining it restores exactly that.
    await revoke('member', harbor);
    expect(await call(agent, 'pm.tasks.get', { task_id: T.open })).toEqual(notFound);
    await grant('member', harbor, 'edit');
    expect(await call(agent, 'pm.tasks.get', { task_id: T.open })).toMatchObject({
      result: { isError: false },
    });
    await env.svc.revokeOAuthConsent(P.member, ws, A.client, mutation());
    expect(await call(agent, 'pm.tasks.get', { task_id: T.open })).toEqual(notFound);
    // Another workspace is never reachable with it.
    await expect(rpc(agent, 'tools/list', undefined, mutation(), B.ws)).rejects.toEqual(
      reason('not_found'),
    );
  });

  it('AT-334 API and MCP run the same domain command with provenance, one idempotent effect, and confirmation', async () => {
    const tok = (await asToken((await apiToken(P.manager, ['records:write'])).secret!))!;
    const req = mutation({ body: { title: 'Via API' } });
    const first = await env.svc.createTask(tok, ws, { brand: harbor, title: 'Via API' }, req);
    const again = await env.svc.createTask(tok, ws, { brand: harbor, title: 'Via API' }, req);
    expect(again.replayed).toBe(true);
    expect(again.data.id).toBe(first.data.id);
    const { caller: agent } = await mcpAs(P.manager, ['records:write']);
    const mreq = mutation({ body: { title: 'Via MCP' } });
    const params = {
      name: 'pm.tasks.create',
      arguments: { title: 'Via MCP', brand: harbor },
      _meta: { idempotencyKey: 'matrix-mcp-idempotency-0001' },
    };
    const viaMcp = async () =>
      (await rpc(agent, 'tools/call', params, mreq)) as {
        result: { content: Array<{ text: string }>; _meta: Record<string, string> };
      };
    const m1 = await viaMcp();
    const m2 = await viaMcp();
    const mcpTask = JSON.parse(m1.result.content[0]!.text).task.id as string;
    expect(JSON.parse(m2.result.content[0]!.text).task.id).toBe(mcpTask);
    expect(m1.result._meta).toEqual({ actor_type: 'oauth_client', source: 'mcp' });
    const rows = await db.admin(
      `SELECT r.public_id, r.record_type, r.source_kind, r.created_by_actor_type, t.title
         FROM core.record r JOIN work.task t ON t.id = r.id
        WHERE t.title IN ('Via API', 'Via MCP') ORDER BY t.title`,
    );
    expect(rows.rows).toMatchObject([
      { public_id: first.data.id, record_type: 'task', source_kind: 'api' },
      { public_id: mcpTask, record_type: 'task', source_kind: 'mcp' },
    ]);
    // Both read back through the same canonical record.
    for (const id of [first.data.id, mcpTask])
      expect((await env.svc.getTask(P.manager, ws, id)).type).toBe('task');
    const audit = await db.admin(
      `SELECT DISTINCT target_public_id, actor_type FROM audit.audit_event
        WHERE action = 'task.created' AND target_public_id = ANY($1)`,
      [[first.data.id, mcpTask]],
    );
    expect(audit.rows).toHaveLength(2);
    // A mutating tool needs a key; a destructive one needs explicit confirmation.
    expect(await call(agent, 'pm.tasks.create', { title: 'No key', brand: harbor })).toMatchObject({
      error: { code: -32602 },
    });
    const complete = (confirm: boolean) =>
      call(
        agent,
        'pm.tasks.complete',
        { task_id: mcpTask, confirm },
        { idempotencyKey: `matrix-complete-${String(confirm)}-0001` },
      );
    expect(await complete(false)).toMatchObject({ error: { code: -32602 } });
    expect((await env.svc.getTask(P.manager, ws, mcpTask)).completed_at ?? null).toBeNull();
    expect(await complete(true)).toMatchObject({ result: { isError: false } });
    expect((await env.svc.getTask(P.manager, ws, mcpTask)).completed_at).toBeTruthy();
  });

  it('AT-335 departure and revocation stop every token, consent, webhook, connection, and queued sync', async () => {
    // Brand revocation: the manager's queued Harbor sync dies on owner authority and stays dead.
    await queueSync(C.harbor, 'matrix-queued-revoked');
    await revoke('manager', harbor);
    await sweepSync();
    expect(await syncDelivery('matrix-queued-revoked')).toMatchObject({
      state: 'dead',
      error_code: 'owner_authority',
    });
    expect(await connRow(C.harbor)).toMatchObject({
      health: 'needs_reauthorization',
      suspended_reason: 'owner_authority',
      ref: null,
    });
    await grant('manager', harbor, 'manage');
    expect((await env.svc.getConnection(P.manager, ws, C.harbor)).credential_configured).toBe(
      false,
    );

    // Departure: everything the leaver holds stops on the next request.
    const tok = await apiToken(P.leaver, ['records:write']);
    const { caller: agent } = await mcpAs(P.leaver, ['records:write']);
    const sub = await subscribe(P.leaver, 'leaver', 'task.completed', harbor);
    const conn = await loopConn(P.leaver, harbor, 'Leaver link');
    await queueSync(conn, 'matrix-queued-departed');
    expect(await asToken(tok.secret!)).not.toBeNull();
    await remove('leaver');
    expect(await env.svc.authenticateApiToken(tok.secret!)).toBeNull();
    await expect(rpc(agent, 'tools/list')).rejects.toEqual(reason('not_found'));
    const subRow = await db.admin(
      `SELECT s.state, s.suspended_reason FROM integrations.webhook_subscription s
         JOIN core.record r ON r.id = s.id WHERE r.public_id = $1`,
      [sub.id],
    );
    expect(subRow.rows[0]).toEqual({ state: 'suspended', suspended_reason: 'owner_departed' });
    expect(await connRow(conn)).toMatchObject({
      health: 'needs_reauthorization',
      suspended_reason: 'owner_departed',
      ref: null,
    });
    await sweepSync();
    expect(await syncDelivery('matrix-queued-departed')).toMatchObject({ state: 'dead' });
    // Suspension refuses a suspended member's token just the same.
    const sleeper = await join(env, db, P.owner, ws, { kind: 'member', role: 'member' });
    const sleepTok = await apiToken(sleeper, ['records:read']);
    await apply(env, P.owner, ws, { kind: 'suspend', member: await mem(sleeper) });
    expect(await env.svc.authenticateApiToken(sleepTok.secret!)).toBeNull();
  });

  it('AT-336 webhooks deliver duplicate and out-of-order events once each under overlapping workers, retry, dead-letter, and replay', async () => {
    const sub = await subscribe(P.owner, 'matrix', 'task.updated', harbor);
    // Real Harbor tasks and the task.updated events their edits wrote to the outbox: an ordinary
    // event must name a record the accountable owner can read when it is sent.
    const updated = async (title: string) => {
      const t = (await env.svc.createTask(P.owner, ws, { brand: harbor, title }, mutation())).data;
      await env.svc.updateTask(
        P.owner,
        ws,
        t.id,
        { version: t.version, changes: { title: { base: title, value: `${title} (edited)` } } },
        mutation({ ifMatch: `"${t.version}"` }),
      );
      const [e] = await outboxEvents(db, wsId, 'work.task.updated', await internalIdOf(db, t.id));
      return e!;
    };
    const earlier = await updated('Matrix earlier');
    const later = await updated('Matrix later');
    // Out of order, and the later event delivered twice by the outbox.
    for (const e of [later, earlier, later]) await env.svc.projectForWorkspace(wsId, e);
    const rows = async () =>
      (
        await db.admin(
          `SELECT d.public_id, d.event_public_id, d.state, d.attempt, d.next_attempt_at, d.updated_at
             FROM integrations.webhook_delivery d JOIN core.record r ON r.id = d.subscription_id
            WHERE r.public_id = $1 ORDER BY d.created_at`,
          [sub.id],
        )
      ).rows as Array<{
        public_id: string;
        event_public_id: string;
        state: string;
        attempt: number;
        next_attempt_at: Date | null;
        updated_at: Date;
      }>;
    expect(await rows()).toHaveLength(2);
    status = 200;
    sent.length = 0;
    await Promise.all([env.svc.sweepWorkspace(wsId), env.svc.sweepWorkspace(wsId)]);
    const delivered = await rows();
    expect(delivered.map((r) => r.state)).toEqual(['delivered', 'delivered']);
    for (const r of delivered)
      expect(sent.filter((s) => s.id === r.event_public_id)).toHaveLength(1);
    // A server error retries with bounded backoff, then dead-letters at the attempt limit.
    status = 503;
    await env.svc.projectForWorkspace(wsId, await updated('Matrix dead letter'));
    const target = (await rows())[2]!;
    await env.svc.sweepWorkspace(wsId);
    let row = (await rows())[2]!;
    expect(row).toMatchObject({ state: 'retry_scheduled', attempt: 1 });
    expect(
      new Date(row.next_attempt_at!).getTime() - new Date(row.updated_at).getTime(),
    ).toBeLessThanOrEqual(60_000);
    await env.svc.sweepWorkspace(wsId, new Date(Date.now() + 120_000));
    await env.svc.sweepWorkspace(wsId, new Date(Date.now() + 240_000));
    row = (await rows())[2]!;
    expect(row).toMatchObject({ state: 'failed', attempt: 3, next_attempt_at: null });
    const attempts = sent.filter((s) => s.id === target.event_public_id).length;
    expect(attempts).toBe(3);
    await env.svc.sweepWorkspace(wsId, new Date(Date.now() + 3_600_000));
    expect(sent.filter((s) => s.id === target.event_public_id)).toHaveLength(attempts);
    // Replay is an administrator's decision; it re-sends the same event id once.
    await expect(
      env.svc.replayDelivery(P.member, ws, target.public_id, mutation()),
    ).rejects.toEqual(reason('forbidden'));
    status = 200;
    await env.svc.replayDelivery(P.administrator, ws, target.public_id, mutation());
    await env.svc.sweepWorkspace(wsId);
    expect((await rows())[2]).toMatchObject({ state: 'delivered' });
    expect(sent.filter((s) => s.id === target.event_public_id)).toHaveLength(attempts + 1);
    // The stored delivery holds status and timing only: no request or response body.
    const columns = await db.admin(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'integrations' AND table_name = 'webhook_delivery'`,
    );
    expect(
      columns.rows
        .map((c) => c.column_name)
        .filter((c) => /body|payload|response_(text|json)/.test(c)),
    ).toEqual([]);
    const listed = JSON.stringify(await env.svc.listDeliveries(P.owner, ws, sub.id));
    expect(listed).not.toContain(sub.secret!);
    expect(listed).not.toContain('"data"');
  });

  it('AT-337 inbound webhooks refuse bad signatures, stale timestamps, and replayed event ids', async () => {
    const endpoint = await env.svc.createInbound(P.owner, ws, { brand: harbor }, mutation());
    const path = endpoint.data.path_token!;
    secrets.push(path, endpoint.data.secret!);
    const now = Math.floor(Date.now() / 1000);
    const send = (body: string, ts: number, key = endpoint.data.secret!, token = path) =>
      env.svc.receiveInbound(
        token,
        {
          signature: signatureHeader([signPayload(key, token, String(ts), body)]),
          timestamp: String(ts),
          contentType: 'application/json',
        },
        body,
        { correlationId: 'c'.repeat(32) },
      );
    const body = (text: string) =>
      JSON.stringify({
        event_id: 'evt-matrix-1',
        type: 'task.capture',
        occurred_at: new Date().toISOString(),
        data: { text, brand: harbor },
      });
    const count = (text: string) => n(`capture.inbox_item WHERE raw_text = $1`, [text]);
    expect(await send(body('Inbound matrix one'), now, 'wrong-secret-value-xyz')).toBe(
      'unauthenticated',
    );
    expect(await send(body('Inbound matrix one'), now - 3_600)).toBe('unauthenticated');
    expect(await send(body('Inbound matrix one'), now + 3_600)).toBe('unauthenticated');
    expect(
      await send(body('Inbound matrix one'), now, endpoint.data.secret!, `hk_${'x'.repeat(30)}`),
    ).toBe('unauthenticated');
    expect(await count('Inbound matrix one')).toBe(0);
    expect(await send(body('Inbound matrix one'), now)).toBe('accepted');
    expect(await send(body('Inbound matrix one'), now)).toBe('accepted');
    expect(await send(body('Inbound matrix two'), now)).toBe('accepted');
    expect(await count('Inbound matrix one')).toBe(1);
    expect(await count('Inbound matrix two')).toBe(0);
    expect(await n(`integrations.inbound_message WHERE provider_event_id = 'evt-matrix-1'`)).toBe(
      1,
    );
  });

  it('AT-338 exports never reveal Vault or restricted work and neutralize spreadsheet formulas', async () => {
    const titles = ['=HYPERLINK("https://x.test","go")', '+SUM(1,1)', '-2+3', '@risky'];
    for (const title of titles)
      await env.svc.createTask(P.owner, ws, { brand: harbor, title }, mutation());
    const mine = await env.svc.exportPortabilityCsv(P.member, ws, 'task');
    const all = await env.svc.exportPortabilityCsv(P.owner, ws, 'task');
    expect(all.csv).toContain('Vault omega plan');
    expect(mine.csv).not.toMatch(/Vault omega|Restricted sigma/);
    expect(mine.csv).not.toContain(vault);
    expect(mine.csv).not.toContain(T.vault);
    expect(mine.rows).toBeLessThan(all.rows);
    expect(mine.filename).toBe(all.filename);
    expect(mine.filename).not.toMatch(/vault/i);
    const [head, ...body] = parseCsv(mine.csv);
    const col = head!.indexOf('title');
    const cells = body.map((r) => r[col]!).filter((t) => titles.some((x) => t.endsWith(x)));
    expect(cells).toHaveLength(titles.length);
    for (const cell of cells) expect(cell.startsWith("'")).toBe(true);
    // History exports are re-authorized the same way.
    await expect(
      env.svc.exportPortabilityHistory(P.member, ws, 'comments', { record: T.vault }),
    ).rejects.toEqual(reason('not_found'));
    await expect(env.svc.exportPortabilityCsv(P.read_only, ws, 'task')).rejects.toEqual(
      reason('forbidden'),
    );
  });

  it('AT-339 imports bind to a preview, refuse stale rollback and cross-workspace references, and keep errors private', async () => {
    const csv = [
      'schema_version,title,brand_id',
      `1,Imported harbor row,${harbor}`,
      `1,Imported foreign row,${B.brand}`,
      `1,Imported unknown row,${UNKNOWN.brand}`,
      `1,Imported vault row,${vault}`,
    ].join('\n');
    const preview = await env.svc.previewPortabilityImportFor(P.member, ws, {
      csv,
      entity: 'task',
    });
    const body = { csv, entity: 'task', preview_id: preview.preview_id, mode: 'partial' };
    await expect(
      env.svc.applyPortabilityImport(
        P.member,
        ws,
        { ...body, csv: `${csv}\n1,Smuggled,${harbor}` },
        mutation(),
      ),
    ).rejects.toEqual(reason('conflict'));
    const result = await env.svc.applyPortabilityImport(P.member, ws, body, mutation());
    expect(result.applied).toBe(1);
    expect(result.rows).toEqual([
      { row: 2, id: expect.any(String) },
      { row: 3, error: 'not_found' },
      { row: 4, error: 'not_found' },
      { row: 5, error: 'not_found' },
    ]);
    expect(
      await n(`work.task WHERE title LIKE 'Imported % row' AND title <> 'Imported harbor row'`),
    ).toBe(0);
    // The error report is the importer's alone, and names no foreign brand or title.
    const errors = await env.svc.exportImportErrors(P.member, ws, result.import_job_id);
    expect(errors.csv).toContain('not_found');
    expect(errors.csv).not.toMatch(/foreign|Vault|Bravo/);
    expect(errors.csv).not.toContain(B.brand);
    for (const who of ['owner', 'administrator', 'manager'] as const)
      expect(await refusal(env.svc.exportImportErrors(P[who], ws, result.import_job_id))).toEqual(
        await refusal(env.svc.exportImportErrors(P[who], ws, randomUUID())),
      );
    // A record changed after import cannot be rolled back over the change.
    const id = result.rows![0]!.id!;
    const cur = await env.svc.getTask(P.member, ws, id);
    await env.svc.updateTask(
      P.member,
      ws,
      id,
      {
        version: cur.version,
        changes: { title: { base: cur.title, value: 'Edited after import' } },
      },
      ifMatch(cur.version),
    );
    await expect(
      env.svc.rollbackPortabilityImport(P.member, ws, result.import_job_id, mutation()),
    ).rejects.toEqual(reason('conflict'));
    expect((await env.svc.getTask(P.member, ws, id)).title).toBe('Edited after import');
  });

  it('AT-340 audit export needs entitlement, fresh verification, and never rides a record export', async () => {
    const disabled = workEnv(db, { auditExportAllowed: false });
    disabled.stepUp.allow = true;
    await expect(
      disabled.svc.exportPortabilityAudit(P.owner, ws, mutation({ stepUpToken: 't' })),
    ).rejects.toEqual(reason('forbidden'));
    await disabled.h.close();
    await expect(env.svc.exportPortabilityAudit(P.owner, ws, mutation())).rejects.toEqual(
      reason('step_up_required'),
    );
    const tok = await asToken((await apiToken(P.owner, ['records:read'])).secret!);
    await stepped(async () => {
      await expect(
        env.svc.exportPortabilityAudit(P.member, ws, mutation({ stepUpToken: 't' })),
      ).rejects.toEqual(reason('forbidden'));
      await expect(
        env.svc.exportPortabilityAudit(tok!, ws, mutation({ stepUpToken: 't' })),
      ).rejects.toEqual(reason('forbidden'));
      const owner = (
        await env.svc.exportPortabilityAudit(P.owner, ws, mutation({ stepUpToken: 't' }))
      ).data;
      const admin = (
        await env.svc.exportPortabilityAudit(P.administrator, ws, mutation({ stepUpToken: 't' }))
      ).data;
      expect(owner.csv).toContain(T.vault);
      expect(admin.csv).not.toContain(T.vault);
      expect(admin.csv).not.toContain(C.vault);
      for (const s of secrets) expect(owner.csv).not.toContain(s);
    });
    // Audit is not a portable record entity, and record exports carry no audit columns or rows.
    await expect(env.svc.exportPortabilityCsv(P.owner, ws, 'audit')).rejects.toEqual(
      reason('not_found'),
    );
    const tasks = await env.svc.exportPortabilityCsv(P.owner, ws, 'task');
    expect(parseCsv(tasks.csv)[0]).not.toContain('action');
    expect(tasks.csv).not.toMatch(/task\.created|connection\.created|portability\.exported/);
  });

  it('AT-341 a member’s calendar never shows to an administrator, and departure ends its authority', async () => {
    oneCalendar();
    const conn = await connectCalendar(P.planner, harbor, 'Planner private');
    fx.control.putEvent('me@example.test', {
      id: 'offsite',
      summary: 'Confidential offsite',
      start: { dateTime: at(week, '10:00') },
      end: { dateTime: at(week, '12:00') },
    });
    await env.svc.syncNow(P.planner, ws, conn, mutation());
    const range = { from: at(week, '00:00'), to: at(addDays(week, 1), '00:00') };
    expect(
      (await env.svc.listCalendarEvents(P.planner, ws, range)).events.map((e) => e.title),
    ).toContain('Confidential offsite');
    const admin = P.administrator;
    expect(await env.svc.listCalendarEvents(admin, ws, range)).toMatchObject({
      events: [],
      connected: false,
    });
    expect(await env.svc.listCalendarConflicts(admin, ws)).toEqual({ conflicts: [] });
    const cap = await env.svc.personCapacity(admin, ws, {
      member: M.planner,
      from: week,
      to: week,
    });
    expect(cap.days[0]).toMatchObject({ unavailable_minutes: 0 });
    expect(JSON.stringify(cap)).not.toMatch(/Confidential|calendar_overlap|cev_/);
    expect((await env.svc.todayView(admin, ws, week)).meetings).toEqual({
      available: false,
      reason: 'not_connected',
    });
    expect(await refusal(env.svc.listCalendars(admin, ws, conn))).toEqual(
      await refusal(env.svc.listCalendars(admin, ws, UNKNOWN.conn)),
    );
    // Departure: queued sync dies, the connection needs reauthorization, the events stay private.
    await queueSync(conn, 'matrix-queued-calendar');
    await remove('planner');
    await sweepSync();
    expect(await syncDelivery('matrix-queued-calendar')).toMatchObject({ state: 'dead' });
    expect(await connRow(conn)).toMatchObject({ suspended_reason: 'owner_departed', ref: null });
    for (const who of [P.owner, admin])
      expect(JSON.stringify(await env.svc.listCalendarEvents(who, ws, range))).not.toContain(
        'Confidential',
      );
  });

  it('AT-342 lifecycle: archive and restore never resurrect revoked authority; purge removes calendar rows and secrets', async () => {
    const dock = await env.svc.createBrand(P.owner, ws, { name: 'Dock' }, mutation());
    oneCalendar();
    fx.control.putEvent('me@example.test', {
      id: 'standup',
      summary: 'Dock standup',
      start: { dateTime: at(week, '09:00') },
      end: { dateTime: at(week, '09:15') },
      recurrence: ['RRULE:FREQ=DAILY;COUNT=5'],
    });
    const cal = await connectCalendar(P.owner, dock.data.id, 'Dock calendar');
    await env.svc.syncNow(P.owner, ws, cal, mutation());
    const revoked = await loopConn(P.owner, dock.data.id, 'Dock link');
    await env.svc.disconnect(P.owner, ws, revoked, { retention: 'retain' }, mutation());
    const sub = await subscribe(P.owner, 'dock', 'project.created', dock.data.id);
    const state = async (id: string) =>
      (await db.admin(`SELECT lifecycle_state FROM core.record WHERE public_id = $1`, [id])).rows[0]
        ?.lifecycle_state;
    await env.svc.archiveBrand(P.owner, ws, dock.data.id, ifMatch(dock.data.version));
    expect([await state(cal), await state(revoked), await state(sub.id)]).toEqual([
      'archived',
      'archived',
      'archived',
    ]);
    const archived = await env.svc.getBrand(P.owner, ws, dock.data.id);
    await env.svc.restoreBrand(P.owner, ws, dock.data.id, ifMatch(archived.version));
    expect(await state(sub.id)).toBe('active');
    // The revoked connection stays revoked: queued work still dies and no secret returns.
    expect(await connRow(revoked)).toMatchObject({ health: 'disconnected', ref: null });
    await queueSync(revoked, 'matrix-queued-restored');
    await sweepSync();
    expect(await syncDelivery('matrix-queued-restored')).toMatchObject({
      state: 'dead',
      error_code: 'disconnected',
    });
    // Purge through the registered adapters removes every mirrored row and the vault secret.
    const ids = await db.admin(
      `SELECT r.id, r.public_id, c.credential_secret_ref AS ref FROM core.record r
         LEFT JOIN integrations.connection c ON c.id = r.id WHERE r.public_id = ANY($1)`,
      [[cal, sub.id]],
    );
    const idOf = (p: string) => ids.rows.find((r) => r.public_id === p)!.id as string;
    const ref = ids.rows.find((r) => r.public_id === cal)!.ref as string;
    expect(ref).toBeTruthy();
    const counts = async () =>
      (
        await db.admin(
          `SELECT (SELECT count(*) FROM integrations.calendar_event WHERE connection_id = $1)::int AS events,
                  (SELECT count(*) FROM integrations.calendar_source WHERE connection_id = $1)::int AS sources,
                  (SELECT count(*) FROM integrations.calendar_series WHERE connection_id = $1)::int AS series,
                  (SELECT count(*) FROM integrations.sync_run WHERE connection_id = $1)::int AS runs,
                  (SELECT count(*) FROM integrations.connection WHERE id = $1)::int AS connections,
                  (SELECT count(*) FROM ops.dev_secret_vault WHERE ref = $2)::int AS secrets`,
          [idOf(cal), ref],
        )
      ).rows[0];
    const before = await counts();
    expect(before.events).toBeGreaterThan(0);
    expect(before.sources).toBeGreaterThan(0);
    expect(before.series).toBeGreaterThan(0);
    await env.h.worker.withWorkspace(wsId, { module: 'test' }, async (tx) => {
      await connectionAdapter.purge!.deleteContent(tx, [idOf(cal)]);
      await webhookSubscriptionAdapter.purge!.deleteContent(tx, [idOf(sub.id)]);
    });
    expect(await counts()).toEqual({
      events: 0,
      sources: 0,
      series: 0,
      runs: 0,
      connections: 0,
      secrets: 0,
    });
    expect(JSON.stringify(await env.svc.listConnections(P.owner, ws))).not.toContain(cal);
    expect(JSON.stringify(await env.svc.listSubscriptions(P.owner, ws))).not.toContain(sub.id);
  });

  it('AT-343 one person in two workspaces keeps each workspace’s delegation apart', async () => {
    const ownerC = await seedAccount(db);
    const made = await env.svc.createWorkspace(
      ownerC,
      { ...WORKSPACE_INPUT, name: 'Matrix C', first_brand: { name: 'Cove' } },
      mutation(),
    );
    const wsC = made.data.workspace.id;
    const cove = made.data.first_brand!.id;
    await env.svc.invite(
      ownerC,
      wsC,
      { email: P.member.auth.account.email, kind: 'member', role: 'administrator' },
      mutation(),
    );
    await env.svc.acceptInvitation(
      P.member,
      { token: await env.tokenFor(P.member.auth.account.email) },
      mutation(),
    );
    const coveTask = (
      await env.svc.createTask(ownerC, wsC, { brand: cove, title: 'Cove task' }, mutation())
    ).data.id;
    // A's token, used against C, is refused like a workspace that does not exist.
    const inA = (await asToken((await apiToken(P.member, ['records:write'])).secret!))!;
    const unknownWs = await refusal(env.svc.getTask(inA, `ws_${ULID}`, coveTask));
    expect(await refusal(env.svc.getTask(inA, wsC, coveTask))).toEqual(unknownWs);
    expect(
      await refusal(env.svc.createTask(inA, wsC, { brand: cove, title: 'Cross' }, mutation())),
    ).toEqual(
      await refusal(
        env.svc.createTask(inA, `ws_${ULID}`, { brand: cove, title: 'Cross' }, mutation()),
      ),
    );
    // C's token (an administrator there) still reads nothing of A.
    const tokC = await stepped(() =>
      env.svc.createToken(
        P.member,
        wsC,
        { name: 'C', kind: 'personal', scopes: ['records:read'] },
        mutation({ stepUpToken: 't' }),
      ),
    );
    secrets.push(tokC.data.secret!);
    const inC = (await asToken(tokC.data.secret!))!;
    expect((await env.svc.getTask(inC, wsC, coveTask)).title).toBe('Cove task');
    expect(await refusal(env.svc.getTask(inC, ws, T.open))).toEqual(
      await refusal(env.svc.getTask(inC, `ws_${ULID}`, T.open)),
    );
    // As C's administrator, the person sees none of A's connections or calendars.
    expect(JSON.stringify(await env.svc.listConnections(P.member, wsC))).not.toMatch(
      /Harbor sync|Vault omega/,
    );
    expect(await refusal(env.svc.getConnection(P.member, wsC, C.harbor))).toEqual(
      await refusal(env.svc.getConnection(P.member, wsC, UNKNOWN.conn)),
    );
    expect((await env.svc.listTokens(P.member, wsC)).tokens.map((t) => t.id)).toEqual([
      tokC.data.id,
    ]);
  });

  it('AT-344 operational logs and audit never carry a token, client, webhook, or provider secret', async () => {
    // One more OAuth completion and sync so the log covers them at the end of the run.
    oneCalendar();
    const conn = await connectCalendar(P.owner, harbor, 'Log check');
    await env.svc.syncNow(P.owner, ws, conn, mutation());
    await env.svc.sweepWorkspace(wsId, new Date(Date.now() + 7_200_000));
    // Structured logs and trace spans (names, attributes, events) together.
    const spans = env.h.telemetry.spans!.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    const logs = [
      ...env.h.sink.lines,
      ...spans.map((s) => JSON.stringify({ n: s.name, a: s.attributes, e: s.events })),
    ].join('\n');
    expect(secrets.length).toBeGreaterThan(15);
    for (const s of secrets) expect(logs).not.toContain(s);
    expect(logs).not.toMatch(/ya29\.[\w-]{8}|1\/\/[\w-]{8}/);
    expect(logs).not.toContain(fx.clientSecret);
    const stored = JSON.stringify(
      (
        await db.admin(
          `SELECT changes, action FROM audit.audit_event WHERE workspace_id = $1
           UNION ALL SELECT to_jsonb(detail), tool_name FROM integrations.mcp_invocation`,
          [wsId],
        )
      ).rows,
    );
    for (const s of secrets) expect(stored).not.toContain(s);
    expect(stored).not.toMatch(/ya29\.|1\/\//);
  });
});
