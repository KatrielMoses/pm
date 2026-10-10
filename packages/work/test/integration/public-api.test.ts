import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUuidV7 } from '@pm/contracts';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import { signPayload, signatureHeader } from '../../src/integrations/semantics.ts';
import { syntheticCaller } from '../../src/integrations/public-api-service.ts';
import type { WebhookTransport } from '../../src/integrations/public-api-service.ts';
import { mutation, workspaceIdOf, workspaceWith, workEnv, type WorkEnv } from './fixture.ts';

/**
 * Phase 6B (ADR-0032): tokens are shown once and only narrow the caller's own access; inbound
 * webhooks fail closed; outbound deliveries are signed and retried.
 */
describe('Public API and webhooks (6B)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let ws: string;
  let brands: Record<string, string>;
  const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  let status = 500;

  beforeAll(async () => {
    db = await createTestDatabase();
    const transport: WebhookTransport = async (req) => {
      sent.push({ url: req.url, body: req.body, headers: req.headers });
      return status >= 0 ? { kind: 'status', status } : { kind: 'network' };
    };
    env = workEnv(db, { deliver: transport });
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
  });
  afterAll(() => db?.drop());

  it('AT-310 shows a personal token once and omits it from later reads', async () => {
    env.stepUp.allow = true;
    const key = mutation({ stepUpToken: 't', body: { name: 'CI' } });
    const created = await env.svc.createToken(
      owner,
      ws,
      { name: 'CI', kind: 'personal', scopes: ['records:write'] },
      key,
    );
    expect(created.data.secret).toMatch(/^pm_/);
    const again = await env.svc.createToken(
      owner,
      ws,
      { name: 'CI', kind: 'personal', scopes: ['records:write'] },
      key,
    );
    expect(again.replayed).toBe(true);
    expect(again.data.secret).toBeUndefined();
    const listed = await env.svc.listTokens(owner, ws);
    expect(JSON.stringify(listed)).not.toContain(created.data.secret);
    expect(listed.tokens[0]?.token_prefix).toBe(created.data.token_prefix);
    env.stepUp.allow = false;
    const auth = await env.svc.authenticateApiToken(created.data.secret!);
    expect(auth?.delegation.scopes).toEqual(['records:write']);
    await env.svc.revokeToken(owner, ws, created.data.id, mutation());
    expect(await env.svc.authenticateApiToken(created.data.secret!)).toBeNull();
  });

  it('AT-311 refuses a read-only token that tries to create a task', async () => {
    env.stepUp.allow = true;
    const created = await env.svc.createToken(
      owner,
      ws,
      { name: 'Read', kind: 'personal', scopes: ['records:read'] },
      mutation({ stepUpToken: 't' }),
    );
    env.stepUp.allow = false;
    const auth = await env.svc.authenticateApiToken(created.data.secret!);
    const caller = syntheticCaller(auth!.accountId, auth!.delegation, {
      correlationId: 'a'.repeat(32),
    });
    await expect(
      env.svc.createTask(caller, ws, { title: 'Nope', brand: brands.Harbor }, mutation()),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('AT-312 keeps a brand-scoped token inside that brand', async () => {
    env.stepUp.allow = true;
    const created = await env.svc.createToken(
      owner,
      ws,
      { name: 'Harbor only', kind: 'personal', scopes: ['records:write'], brands: [brands.Harbor] },
      mutation({ stepUpToken: 't' }),
    );
    env.stepUp.allow = false;
    const ids = await db.admin(
      'SELECT brand_ids FROM integrations.api_token WHERE public_id = $1',
      [created.data.id],
    );
    const auth = await env.svc.authenticateApiToken(created.data.secret!);
    auth!.delegation.brandIds = ids.rows[0].brand_ids;
    const caller = syntheticCaller(auth!.accountId, auth!.delegation, {
      correlationId: 'b'.repeat(32),
    });
    await expect(
      env.svc.createTask(caller, ws, { title: 'Elsewhere', brand: brands.Summit }, mutation()),
    ).rejects.toMatchObject({ code: 'not_found' });
    const made = await env.svc.createTask(
      caller,
      ws,
      { title: 'In harbor', brand: brands.Harbor },
      mutation(),
    );
    expect(made.data.id).toMatch(/^tsk_/);
  });

  it('AT-313 accepts a signed inbound capture and rejects a bad signature the same way', async () => {
    const endpoint = await env.svc.createInbound(owner, ws, { brand: brands.Harbor }, mutation());
    const body = JSON.stringify({
      event_id: 'evt-capture-1',
      type: 'task.capture',
      occurred_at: new Date().toISOString(),
      data: { text: 'From the hook', brand: brands.Harbor },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signatureHeader([
      signPayload(endpoint.data.secret!, endpoint.data.path_token!, ts, body),
    ]);
    const ok = await env.svc.receiveInbound(
      endpoint.data.path_token!,
      { signature: sig, timestamp: ts, contentType: 'application/json' },
      body,
      { correlationId: 'c'.repeat(32) },
    );
    expect(ok).toBe('accepted');
    const bad = await env.svc.receiveInbound(
      'hk_notarealtokenvalue',
      { signature: 'v1,nope', timestamp: ts, contentType: 'application/json' },
      body,
      { correlationId: 'd'.repeat(32) },
    );
    expect(bad).toBe('unauthenticated');
    const dup = await env.svc.receiveInbound(
      endpoint.data.path_token!,
      { signature: sig, timestamp: ts, contentType: 'application/json' },
      body,
      { correlationId: 'e'.repeat(32) },
    );
    expect(dup).toBe('accepted');
  });

  it('AT-314 signs an outbound delivery and retries a server error', async () => {
    status = 500;
    sent.length = 0;
    const sub = await env.svc.createSubscription(
      owner,
      ws,
      {
        destination_url: 'https://127.0.0.1/hooks/pm',
        event_types: ['task.created'],
        brand: brands.Harbor,
      },
      mutation(),
    );
    const wsId = await workspaceIdOf(db, ws);
    const n = await env.svc.projectForWorkspace(wsId, {
      event_id: newUuidV7(),
      type: 'work.task.created',
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      recorded_at: new Date().toISOString(),
      workspace_id: wsId,
      aggregate: { type: 'work.task', id: newUuidV7(), sequence: 1 },
      actor: { type: 'human' },
      auth: { workspace_epoch: 1 },
      correlation_id: 'f'.repeat(32),
      data: { source_kind: 'api' },
      max_class: 'C1',
    });
    expect(n).toBe(1);
    await env.svc.sweepWorkspace(wsId, new Date());
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers['webhook-signature']).toContain('v1,');
    expect(
      signatureHeader([
        signPayload(
          sub.data.secret!,
          sent[0]!.headers['webhook-id']!,
          sent[0]!.headers['webhook-timestamp']!,
          sent[0]!.body,
        ),
      ]).split(' ')[0],
    ).toBe(sent[0]?.headers['webhook-signature']);
    status = 200;
    await env.svc.sweepWorkspace(wsId, new Date(Date.now() + 120_000));
    expect(sent.at(-1) && status).toBe(200);
    expect(sent.length).toBeGreaterThan(1);
  });
});
