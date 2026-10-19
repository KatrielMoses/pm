import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import {
  Browser,
  idemKey,
  identityEnv,
  PASSWORD,
  registerAndVerify,
  signIn,
  type IdentityEnv,
} from './identity-helpers.ts';

/**
 * External effect reconciliation over HTTP (P8-W0, ADR-0045): session-only (bearer callers are
 * refused at the edge whatever their scopes), owners and administrators, step-up and the reviewed
 * version, non-resource envelopes with no-store caching, and an idempotent replay marked as such.
 */
describe('External effect reconciliation API', () => {
  let env: IdentityEnv;
  let owner: Browser;
  let ws: string;
  let opPublic: string;
  const key = () => ({ 'idempotency-key': idemKey() });
  const base = () => `/v1/workspaces/${ws}`;

  beforeAll(async () => {
    env = await identityEnv({});
    owner = new Browser(env.app);
    owner.ip = '203.0.113.191';
    await registerAndVerify(env, owner, 'effects-owner@example.test');
    await signIn(owner, 'effects-owner@example.test');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Effects HTTP',
        timezone: 'UTC',
        locale: 'en',
        currency: 'USD',
        week_start: 1,
        first_brand: { name: 'Main' },
      },
      { headers: key() },
    );
    ws = created.json().data.id;
    // An operation waiting with one unsafe effect whose outcome is unknown (as recovery leaves it).
    const wsId = (await env.db.admin(`SELECT id FROM tenancy.workspace WHERE public_id = $1`, [ws]))
      .rows[0].id as string;
    const opId = newUuidV7();
    opPublic = newPublicId('op');
    await env.db.admin(
      `INSERT INTO exec.operation (id, workspace_id, public_id, kind, initiated_by_actor_type, execution_state, waiting_reason,
          authenticated_principal_type, authenticated_principal_id, effective_principal_type, effective_principal_id,
          delegation_chain, workspace_epoch_at_enqueue, principal_epoch_at_enqueue, data_class_limit, correlation_id)
       VALUES ($1, $2, $3, 'report_run', 'system', 'waiting', 'reconciliation_required',
          'member', $4, 'member', $4, '[{"type":"member","id":"00000000-0000-7000-8000-000000000000"}]'::jsonb, 0, 0, 'C2', $5)`,
      [opId, wsId, opPublic, newUuidV7(), newUuidV7()],
    );
    await env.db.admin(
      `INSERT INTO exec.external_effect (id, workspace_id, operation_id, effect_key, destination_class, state,
          attempt_count, uncertainty_reason)
       VALUES ($1, $2, $3, 'send:http', 'unsafe', 'unknown', 1, 'abandoned_claim')`,
      [newUuidV7(), wsId, opId],
    );
  });
  afterAll(async () => {
    await env?.close();
  });

  it('AT-549 lists and reconciles an unknown effect over HTTP with step-up and an idempotent replay; bearer tokens never reach it', async () => {
    const listed = await owner.get(`${base()}/operations/effects`);
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toBe('private, no-store');
    expect(listed.json().data.type).toBe('external_effects');
    const item = listed
      .json()
      .data.items.find((i: { effect_key: string }) => i.effect_key === 'send:http');
    expect(item).toMatchObject({
      operation: opPublic,
      state: 'unknown',
      destination_class: 'unsafe',
      attempts: 1,
      uncertainty_reason: 'abandoned_claim',
    });
    const url = `${base()}/operations/${opPublic}/effects/send:http:reconcile`;
    const body = { decision: 'sent', version: item.version };
    // Without step-up nothing changes.
    const headers = key();
    const challenged = await owner.request('POST', url, { body, headers });
    expect(challenged.statusCode, JSON.stringify(challenged.json())).toBe(403);
    expect(challenged.json().error.code).toBe('step_up_required');
    const v = await owner.post(`/v1/auth/step-up/${challenged.json().error.step_up.id}:verify`, {
      method: 'password',
      proof: PASSWORD,
    });
    const done = await owner.request('POST', url, {
      body,
      headers: { ...headers, 'step-up': v.json().data.token },
    });
    expect(done.statusCode, JSON.stringify(done.json())).toBe(200);
    expect(done.json().data).toMatchObject({
      type: 'external_effect_reconciliation',
      state: 'confirmed',
      reconciliation: { decision: 'sent' },
    });
    expect(done.json().data.id).toBeUndefined();
    const replay = await owner.request('POST', url, {
      body,
      headers: { ...headers, 'step-up': v.json().data.token },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    // An unknown verb is not a route.
    expect(
      (
        await owner.request('POST', `${base()}/operations/${opPublic}/effects/send:http:resend`, {
          body,
          headers: key(),
        })
      ).statusCode,
    ).toBe(404);
    // Bearer tokens are refused whatever their scopes.
    const tokenHeaders = key();
    let tok = await owner.request('POST', `${base()}/api-tokens`, {
      body: { name: 'Effects', kind: 'personal', scopes: ['records:read', 'records:write'] },
      headers: tokenHeaders,
    });
    if (tok.statusCode === 403 && tok.json().error.code === 'step_up_required') {
      const sv = await owner.post(`/v1/auth/step-up/${tok.json().error.step_up.id}:verify`, {
        method: 'password',
        proof: PASSWORD,
      });
      tok = await owner.request('POST', `${base()}/api-tokens`, {
        body: { name: 'Effects', kind: 'personal', scopes: ['records:read', 'records:write'] },
        headers: { ...tokenHeaders, 'step-up': sv.json().data.token },
      });
    }
    const secret = tok.json().data.secret as string;
    for (const [method, target] of [
      ['GET', `${base()}/operations/effects`],
      ['POST', url],
    ] as const) {
      const res = await env.app.inject({
        method,
        url: target,
        headers: { authorization: `Bearer ${secret}`, ...(method === 'POST' ? key() : {}) },
        ...(method === 'POST' ? { payload: body } : {}),
      });
      expect(res.statusCode, target).toBe(403);
    }
  });
});
