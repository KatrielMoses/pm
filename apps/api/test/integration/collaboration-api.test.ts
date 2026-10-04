import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { newPublicId, newUuidV7 } from '@pm/contracts';
import {
  Browser,
  idemKey,
  identityEnv,
  mailTo,
  PASSWORD,
  registerAndVerify,
  signIn,
  tokenFrom,
  type IdentityEnv,
} from './identity-helpers.ts';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('collaboration API (1D): invitations, people, access changes, guests, transfer', () => {
  let env: IdentityEnv;
  let owner: Browser;
  let ws: string;
  let brand: string;
  const bodies: string[] = [];
  const keep = (r: LightMyRequestResponse) => {
    bodies.push(r.body);
    return r;
  };
  const key = () => ({ 'idempotency-key': idemKey() });

  async function person(email: string, ip: string): Promise<Browser> {
    const b = new Browser(env.app);
    b.ip = ip;
    await registerAndVerify(env, b, email);
    await signIn(b, email);
    return b;
  }

  async function inviteAndAccept(
    email: string,
    body: Record<string, unknown>,
    ip: string,
  ): Promise<Browser> {
    const inv = keep(
      await owner.post(`/v1/workspaces/${ws}/invitations`, { email, ...body }, { headers: key() }),
    );
    expect(inv.statusCode, inv.body).toBe(201);
    await env.deliverMail();
    const token = tokenFrom(mailTo(env, email, 'invited').at(-1));
    const who = await person(email, ip);
    const accepted = keep(await who.post('/v1/invitations:accept', { token }, { headers: key() }));
    expect(accepted.statusCode, accepted.body).toBe(200);
    return who;
  }

  /** Preview → apply, completing a real password step-up when the server asks for it. */
  async function change(as: Browser, c: Record<string, unknown>): Promise<LightMyRequestResponse> {
    const preview = keep(await as.post(`/v1/workspaces/${ws}/access:preview`, { change: c }));
    expect(preview.statusCode, preview.body).toBe(200);
    const body = { change: c, preview_token: preview.json().data.preview_token };
    const headers = key();
    const first = await as.post(`/v1/workspaces/${ws}/access:apply`, body, { headers });
    if (first.statusCode !== 403 || first.json().error.code !== 'step_up_required')
      return keep(first);
    const ch = first.json().error.step_up;
    const v = await as.post(`/v1/auth/step-up/${ch.id}:verify`, {
      method: 'password',
      proof: PASSWORD,
    });
    expect(v.statusCode, v.body).toBe(200);
    return keep(
      await as.post(`/v1/workspaces/${ws}/access:apply`, body, {
        headers: { ...headers, 'step-up': v.json().data.token },
      }),
    );
  }

  beforeAll(async () => {
    env = await identityEnv();
    owner = await person('collab-owner@example.test', '203.0.113.30');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Team Space',
        timezone: 'UTC',
        locale: 'en',
        currency: 'USD',
        week_start: 1,
        first_brand: { name: 'Main' },
      },
      { headers: key() },
    );
    ws = created.json().data.id;
    brand = created.json().data.first_brand.id;
  });
  afterAll(async () => {
    await env.close();
  });

  it('invitation journey: mail carries only an opaque link; recipient inspects and accepts once', async () => {
    const r = await owner.post(
      `/v1/workspaces/${ws}/invitations`,
      { email: 'collab-member@example.test', kind: 'member', role: 'member' },
      { headers: key() },
    );
    expect(r.statusCode).toBe(201);
    expect(r.json().data).toMatchObject({ type: 'invitation', state: 'pending', role: 'member' });
    await env.deliverMail();
    const mail = mailTo(env, 'collab-member@example.test', 'invited').at(-1)!;
    expect(mail.text).not.toContain('Team Space');
    expect(mail.text).toMatch(/\/invitations\/accept#token=/);
    const token = tokenFrom(mail);
    const member = await person('collab-member@example.test', '203.0.113.31');
    const inspect = keep(await member.post('/v1/invitations:inspect', { token }));
    expect(inspect.json().data).toMatchObject({
      type: 'invitation_preview',
      status: 'ready',
      workspace_name: 'Team Space',
    });
    const ok = keep(await member.post('/v1/invitations:accept', { token }, { headers: key() }));
    expect(ok.json().data).toMatchObject({
      type: 'invitation_acceptance',
      status: 'accepted',
      workspace: { id: ws },
    });
    const again = await member.post('/v1/invitations:accept', { token }, { headers: key() });
    expect(again.json().data.status).toBe('already_accepted');
    const people = keep(await member.get(`/v1/workspaces/${ws}/people`));
    expect(people.json().data.map((p: { display_name: string }) => p.display_name)).toHaveLength(2);
    expect(people.json().data.every((p: { email: unknown }) => p.email === null)).toBe(true);
    // A stranger presenting the token learns nothing.
    const stranger = await person('collab-stranger@example.test', '203.0.113.32');
    expect(
      (await stranger.post('/v1/invitations:accept', { token }, { headers: key() })).statusCode,
    ).toBe(404);
    for (const path of [
      `/v1/workspaces/${ws}/people`,
      `/v1/workspaces/${ws}/teams`,
      `/v1/workspaces/${ws}/invitations`,
      `/v1/workspaces/${ws}/policy`,
    ]) {
      const res = await stranger.get(path);
      expect(res.statusCode, path).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    }
  });

  it('role changes and brand access go through preview, fingerprint, and real step-up', async () => {
    const people = (await owner.get(`/v1/workspaces/${ws}/people`)).json().data as Array<{
      id: string;
      role: string;
    }>;
    const member = people.find((p) => p.role === 'member')!;
    const forged = await owner.post(
      `/v1/workspaces/${ws}/access:apply`,
      { change: { kind: 'role', member: member.id, role: 'read_only' }, preview_token: 'zz.zz' },
      { headers: key() },
    );
    expect(forged.statusCode).toBe(409);
    const roleChange = await change(owner, { kind: 'role', member: member.id, role: 'read_only' });
    expect(roleChange.statusCode, roleChange.body).toBe(200);
    expect(roleChange.json().data).toMatchObject({ type: 'permission_change', applied: 'role' });
    const grant = await change(owner, {
      kind: 'brand_grant',
      brand,
      principal: member.id,
      level: 'edit',
    });
    expect(grant.statusCode, grant.body).toBe(200);
    const access = keep(await owner.get(`/v1/workspaces/${ws}/people/${member.id}/access`));
    expect(access.json().data.explanation.brands[0]).toMatchObject({
      brand: { id: brand },
      level: 'view',
    });
    const brandAccess = keep(await owner.get(`/v1/workspaces/${ws}/brands/${brand}/access`));
    expect(brandAccess.json().data.grants.map((g: { level: string }) => g.level)).toContain('edit');
  });

  it('guests: exact shared records only; no directory or brands', async () => {
    const wsId = (await env.db.admin(`SELECT id FROM tenancy.workspace WHERE public_id = $1`, [ws]))
      .rows[0].id;
    const brandId = (await env.db.admin(`SELECT id FROM core.record WHERE public_id = $1`, [brand]))
      .rows[0].id;
    await env.db.admin(
      `INSERT INTO core.record_type (record_type, public_id_prefix, owner_module, test_only) VALUES ('foundation_fixture', 'fxt', 'fixture', true) ON CONFLICT DO NOTHING`,
    );
    const rec = newPublicId('fxt' as never);
    await env.db.admin(
      `INSERT INTO core.record (id, public_id, record_type, workspace_id, brand_id, source_kind, created_by_actor_type)
       VALUES ($1, $2, 'foundation_fixture', $3, $4, 'system', 'system')`,
      [newUuidV7(), rec, wsId, brandId],
    );
    const guest = await inviteAndAccept(
      'collab-guest@example.test',
      { kind: 'guest', records: [{ record: rec, level: 'read' }] },
      '203.0.113.33',
    );
    const shared = keep(await guest.get(`/v1/workspaces/${ws}/shared`));
    expect(shared.json().data).toEqual([
      {
        id: rec,
        type: 'foundation_fixture',
        lifecycle_state: 'active',
        brand: { name: 'Main', icon: 'circle', color: '#336699' },
      },
    ]);
    expect((await guest.get(`/v1/workspaces/${ws}/people`)).statusCode).toBe(404);
    expect((await guest.get(`/v1/workspaces/${ws}/brands`)).json().data).toEqual([]);
  });

  it('ownership transfer requires step-up from the owner and acceptance by the recipient', async () => {
    const admin = await inviteAndAccept(
      'collab-admin@example.test',
      { kind: 'member', role: 'administrator' },
      '203.0.113.34',
    );
    const adminId = (await owner.get(`/v1/workspaces/${ws}/people`))
      .json()
      .data.find((p: { role: string }) => p.role === 'administrator').id;
    const headers = key();
    const first = await owner.post(
      `/v1/workspaces/${ws}/ownership-transfer`,
      { to: adminId, demote_previous: false },
      { headers },
    );
    expect(first.json().error.code).toBe('step_up_required');
    const v = await owner.post(`/v1/auth/step-up/${first.json().error.step_up.id}:verify`, {
      method: 'password',
      proof: PASSWORD,
    });
    const requested = keep(
      await owner.post(
        `/v1/workspaces/${ws}/ownership-transfer`,
        { to: adminId, demote_previous: false },
        { headers: { ...headers, 'step-up': v.json().data.token } },
      ),
    );
    expect(requested.statusCode, requested.body).toBe(201);
    const otr = requested.json().data.id;
    const view = keep(await admin.get(`/v1/workspaces/${ws}/ownership-transfer`));
    expect(view.json().data.transfer).toMatchObject({ id: otr, capabilities: { accept: true } });
    const h2 = key();
    const a1 = await admin.post(
      `/v1/workspaces/${ws}/ownership-transfer/${otr}:accept`,
      {},
      { headers: h2 },
    );
    expect(a1.json().error.code).toBe('step_up_required');
    const v2 = await admin.post(`/v1/auth/step-up/${a1.json().error.step_up.id}:verify`, {
      method: 'password',
      proof: PASSWORD,
    });
    const accepted = keep(
      await admin.post(
        `/v1/workspaces/${ws}/ownership-transfer/${otr}:accept`,
        {},
        { headers: { ...h2, 'step-up': v2.json().data.token } },
      ),
    );
    expect(accepted.statusCode, accepted.body).toBe(200);
    const roles = (await owner.get(`/v1/workspaces/${ws}/people`))
      .json()
      .data.filter((p: { role: string }) => p.role === 'owner');
    expect(roles).toHaveLength(2);
  });

  it('responses never contain internal UUIDs or grant internals', () => {
    for (const b of bodies) {
      expect(b).not.toMatch(UUID);
      expect(b).not.toMatch(/role_assignment|grant_source":"bootstrap|scope_manage|principal_id/);
    }
  });
});
