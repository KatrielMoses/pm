import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import { oauthSyntheticCaller } from '../../src/integrations/mcp-access-service.ts';
import { mutation, workEnv, workspaceWith, type WorkEnv } from './fixture.ts';

describe('MCP-compatible access foundation (6E)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let ws: string;
  let otherWorkspace: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db, { work: { mcpEnabled: true } });
    ({ owner, ws } = await workspaceWith(env, db, ['Harbor']));
    ({ ws: otherWorkspace } = await workspaceWith(env, db, ['Other workspace']));
  }, 120_000);
  afterAll(async () => db?.drop());

  it('issues a one-time OAuth token, exposes only consented tools, and revocation blocks execution', async () => {
    const registered = await env.svc.createOAuthClient(
      owner,
      ws,
      {
        name: 'Conformance client',
        redirect_uris: ['https://client.example/callback'],
        scopes: ['records:read', 'records:write'],
      },
      mutation(),
    );
    expect(registered.data.client_secret).toMatch(/^oac_/);

    const consent = await env.svc.grantOAuthConsent(
      owner,
      ws,
      registered.data.id,
      { scopes: ['records:read'] },
      mutation(),
    );
    expect(consent.data.state).toBe('active');

    const issue = mutation({ body: { client_id: registered.data.id } });
    const [first, concurrent] = await Promise.all([
      env.svc.issueOAuthAccessToken(
        owner,
        ws,
        { client_id: registered.data.id, client_secret: registered.data.client_secret },
        issue,
      ),
      env.svc.issueOAuthAccessToken(
        owner,
        ws,
        { client_id: registered.data.id, client_secret: registered.data.client_secret },
        issue,
      ),
    ]);
    const token = first.data.access_token ? first : concurrent;
    const replay = token === first ? concurrent : first;
    expect(token.data.access_token).toMatch(/^pma_/);
    expect(replay.replayed).toBe(true);
    expect(replay.data.access_token).toBeNull();

    const authenticated = await env.svc.authenticateOAuthAccessToken(token.data.access_token!);
    expect(authenticated).toMatchObject({ workspacePublicId: ws });
    const delegated = oauthSyntheticCaller(authenticated!.accountId, authenticated!.delegation, {
      correlationId: 'm'.repeat(32),
    });
    await expect(
      env.svc.handleMcpRpc(
        delegated,
        otherWorkspace,
        { jsonrpc: '2.0', id: 0, method: 'tools/list' },
        mutation(),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    const listed = await env.svc.handleMcpRpc(
      delegated,
      ws,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      mutation(),
    );
    const tools = (listed as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools.map((tool) => tool.name)).toContain('pm.tasks.list');
    expect(tools.map((tool) => tool.name)).not.toContain('pm.tasks.create');

    await env.svc.revokeOAuthConsent(owner, ws, registered.data.id, mutation());
    const denied = await env.svc.handleMcpRpc(
      delegated,
      ws,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      mutation(),
    );
    expect(denied).toMatchObject({ error: { code: -32001, message: 'Not found.' } });

    const audit = await db.admin(
      `SELECT detail FROM integrations.mcp_invocation ORDER BY created_at DESC LIMIT 10`,
    );
    expect(JSON.stringify(audit.rows)).not.toContain(token.data.access_token);
    expect(JSON.stringify(audit.rows)).not.toContain(registered.data.client_secret);
  });

  it('negotiates registered MCP protocol versions and rejects unregistered versions', async () => {
    const response = await env.svc.handleMcpRpc(
      owner,
      ws,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      mutation(),
    );
    expect(response).toMatchObject({ result: { protocolVersion: '2025-03-26' } });
    const unsupported = await env.svc.handleMcpRpc(
      owner,
      ws,
      { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1900-01-01' } },
      mutation(),
    );
    expect(unsupported).toMatchObject({ error: { code: -32602 } });
  });
});
