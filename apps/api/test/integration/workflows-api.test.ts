import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  Browser,
  idemKey,
  identityEnv,
  registerAndVerify,
  signIn,
  type IdentityEnv,
} from './identity-helpers.ts';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * 2C HTTP surface: workflow, status, and transition configuration; record transitions (preview,
 * apply with a fingerprint); custom fields and values with ETags; the collection verbs
 * (`fields:preview_formula`, `fields:export`, `fields:validate_document`); approvals; and
 * non-disclosure (strangers get the same not_found, no response carries internal UUIDs).
 */
describe('workflows and fields API (2C)', () => {
  let env: IdentityEnv;
  let owner: Browser;
  let stranger: Browser;
  let ws: string;
  let brand: string;
  const bodies: string[] = [];
  const keep = (r: LightMyRequestResponse) => {
    bodies.push(r.body);
    return r;
  };
  const key = () => ({ 'idempotency-key': idemKey() });
  const base = () => `/v1/workspaces/${ws}`;

  async function person(email: string, ip: string): Promise<Browser> {
    const b = new Browser(env.app);
    b.ip = ip;
    await registerAndVerify(env, b, email);
    await signIn(b, email);
    return b;
  }

  beforeAll(async () => {
    env = await identityEnv();
    owner = await person('wf-owner@example.test', '203.0.113.90');
    stranger = await person('wf-stranger@example.test', '203.0.113.91');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Flows',
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

  it('configures a workflow and moves a task through preview and apply', async () => {
    const wf = keep(
      await owner.post(
        `${base()}/workflows`,
        {
          scope: `brand:${brand}`,
          record_kind: 'task',
          name: 'Flow',
          statuses: [
            { name: 'Open', category: 'planned' },
            { name: 'Review', category: 'active' },
            { name: 'Shipped', category: 'done' },
          ],
        },
        { headers: key() },
      ),
    );
    expect(wf.statusCode, wf.body).toBe(201);
    const w = wf.json().data;
    expect(wf.headers.etag).toBe(`"${w.version}"`);
    const [open, review, shipped] = w.statuses.map((s: { id: string }) => s.id);
    const tr = keep(
      await owner.post(
        `${base()}/workflows/${w.id}/transitions`,
        { transition: { from: open, to: review, confirmation: 'confirm' } },
        { headers: { ...key(), 'if-match': `"${w.version}"` } },
      ),
    );
    expect(tr.statusCode, tr.body).toBe(200);
    keep(
      await owner.post(
        `${base()}/workflows/${w.id}/transitions`,
        { transition: { from: review, to: shipped } },
        { headers: { ...key(), 'if-match': `"${tr.json().data.version}"` } },
      ),
    );
    const listed = keep(await owner.get(`${base()}/workflows?scope=brand:${brand}`));
    expect(listed.json()).toMatchObject({
      data: [expect.objectContaining({ id: w.id })],
      applies: { task: { id: w.id } },
    });
    const t = keep(
      await owner.post(`${base()}/tasks`, { brand, title: 'Flowing' }, { headers: key() }),
    ).json().data;
    expect(t.status).toMatchObject({ key: open, custom: true });
    const opts = keep(await owner.get(`${base()}/records/${t.id}/transitions`));
    expect(opts.json().data).toMatchObject({ type: 'transition_options', workflow: { id: w.id } });
    // A confirmed transition needs review: a plain edit is refused, the apply command needs a fingerprint.
    const plain = keep(
      await owner.patch(
        `${base()}/tasks/${t.id}`,
        { version: t.version, changes: { status: { base: open, value: review } } },
        { headers: key() },
      ),
    );
    expect(plain.statusCode).toBe(422);
    expect(plain.json().error.issues[0].code).toBe('transition_requires_review');
    const pv = keep(
      await owner.post(
        `${base()}/records/${t.id}:preview_transition`,
        { to: review },
        { headers: key() },
      ),
    );
    expect(pv.json().data).toMatchObject({
      type: 'transition_preview',
      allowed: true,
      confirmation: 'confirm',
      before_category: 'planned',
      after_category: 'active',
    });
    const bad = keep(
      await owner.post(
        `${base()}/records/${t.id}:transition`,
        { to: review, version: t.version, preview_token: 'nope' },
        { headers: key() },
      ),
    );
    expect(bad.statusCode).toBe(409);
    const ok = keep(
      await owner.post(
        `${base()}/records/${t.id}:transition`,
        { to: review, version: t.version, preview_token: pv.json().data.preview_token },
        { headers: key() },
      ),
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data.status.key).toBe(review);
    const done = keep(await owner.post(`${base()}/tasks/${t.id}:complete`, {}, { headers: key() }));
    expect(done.json().data.status).toMatchObject({ key: shipped, category: 'done' });
  });

  it('custom fields: definitions, values with ETags, collection verbs, and the lossless document', async () => {
    const f = keep(
      await owner.post(
        `${base()}/fields`,
        { scope: `brand:${brand}`, name: 'Points', field_type: 'number', applies_to: ['task'] },
        { headers: key() },
      ),
    );
    expect(f.statusCode, f.body).toBe(201);
    const fld = f.json().data;
    const pf = keep(
      await owner.post(
        `${base()}/fields:preview_formula`,
        { scope: `brand:${brand}`, source: `{${fld.id}} * 2`, sample: { [fld.id]: '4' } },
        { headers: key() },
      ),
    );
    expect(pf.statusCode, pf.body).toBe(200);
    expect(pf.json().data).toMatchObject({
      type: 'formula_preview',
      result_type: 'number',
      sample_result: '8',
    });
    const t = keep(
      await owner.post(`${base()}/tasks`, { brand, title: 'Fielded' }, { headers: key() }),
    ).json().data;
    const rf = keep(await owner.get(`${base()}/records/${t.id}/fields`));
    expect(rf.json().data).toMatchObject({
      type: 'record_fields',
      fields: [expect.objectContaining({ id: fld.id, value: null })],
    });
    const put = keep(
      await owner.patch(
        `${base()}/records/${t.id}/fields`,
        { changes: { [fld.id]: { base: null, value: '5' } } },
        { headers: { ...key(), 'if-match': `"${rf.json().data.version}"` } },
      ),
    );
    expect(put.statusCode, put.body).toBe(200);
    expect(put.headers.etag).toBe(`"${rf.json().data.version + 1}"`);
    const stale = keep(
      await owner.patch(
        `${base()}/records/${t.id}/fields`,
        { changes: { [fld.id]: { value: '6' } } },
        { headers: { ...key(), 'if-match': `"${rf.json().data.version}"` } },
      ),
    );
    expect(stale.statusCode).toBe(409);
    const exp = keep(
      await owner.get(`${base()}/fields:export?scope=brand:${brand}&record=${t.id}`),
    );
    expect(exp.statusCode, exp.body).toBe(200);
    const doc = exp.json().data.document;
    expect(doc).toMatchObject({
      schema: 'pm.custom-fields',
      version: 1,
      values: [expect.objectContaining({ field: fld.id, value: '5' })],
    });
    const chk = keep(
      await owner.post(`${base()}/fields:validate_document`, doc, { headers: key() }),
    );
    expect(chk.json().data).toMatchObject({
      type: 'field_document_check',
      valid: true,
      lossless: true,
    });
  });

  it('strangers and guessed identifiers get the same not_found; no response carries internal UUIDs', async () => {
    const w = keep(await owner.get(`${base()}/workflows?scope=brand:${brand}`)).json().data[0];
    for (const path of [
      `${base()}/workflows/${w.id}`,
      `${base()}/fields?scope=workspace`,
      `${base()}/approvals`,
    ])
      expect(keep(await stranger.get(path)).statusCode, path).toBe(404);
    expect(
      keep(await owner.get(`${base()}/workflows/wf_00000000000000000000000000`)).statusCode,
    ).toBe(404);
    expect(
      keep(
        await owner.post(
          `${base()}/records/tsk_00000000000000000000000000:preview_transition`,
          { to: 'x' },
          { headers: key() },
        ),
      ).statusCode,
    ).toBe(404);
    expect(
      keep(await owner.post(`${base()}/workflows/${w.id}:explode`, {}, { headers: key() }))
        .statusCode,
    ).toBe(404);
    for (const b of bodies) expect(b).not.toMatch(UUID);
  });
});
