import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import {
  Browser,
  idemKey,
  identityEnv,
  mailTo,
  registerAndVerify,
  signIn,
  tokenFrom,
  type IdentityEnv,
} from './identity-helpers.ts';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const para = (id: string, text: string) => ({ id, type: 'paragraph', runs: [{ text }] });

/**
 * 4C HTTP surface (ADR-0025; 0D PL-35): documents, content saves with the version loaded, versions
 * and restores, placement, links and backlinks, suggestions, AI-source approvals, lifecycle verbs,
 * export, ETags and idempotent replays, and the same 404 for strangers. No internal identifier
 * anywhere in a response.
 */
describe('documents API (4C)', () => {
  let env: IdentityEnv;
  let owner: Browser;
  let member: Browser;
  let reader: Browser;
  let stranger: Browser;
  let ws: string;
  let brand: string;
  const bodies: string[] = [];
  const keep = (r: LightMyRequestResponse) => {
    bodies.push(r.body);
    return r;
  };
  const key = (extra: Record<string, string> = {}) => ({ 'idempotency-key': idemKey(), ...extra });
  const base = () => `/v1/workspaces/${ws}`;

  async function person(email: string, ip: string): Promise<Browser> {
    const b = new Browser(env.app);
    b.ip = ip;
    await registerAndVerify(env, b, email);
    await signIn(b, email);
    return b;
  }
  async function invite(
    email: string,
    body: Record<string, unknown>,
    ip: string,
  ): Promise<Browser> {
    const inv = keep(
      await owner.post(`${base()}/invitations`, { email, ...body }, { headers: key() }),
    );
    expect(inv.statusCode, inv.body).toBe(201);
    await env.deliverMail();
    const token = tokenFrom(mailTo(env, email, 'invited').at(-1));
    const who = await person(email, ip);
    const accepted = keep(await who.post('/v1/invitations:accept', { token }, { headers: key() }));
    expect(accepted.statusCode, accepted.body).toBe(200);
    return who;
  }

  beforeAll(async () => {
    env = await identityEnv();
    owner = await person('doc-owner@example.test', '203.0.113.170');
    stranger = await person('doc-stranger@example.test', '203.0.113.171');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Docs',
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
    member = await invite(
      'doc-member@example.test',
      { kind: 'member', role: 'administrator' },
      '203.0.113.172',
    );
    reader = await invite(
      'doc-reader@example.test',
      { kind: 'member', role: 'read_only' },
      '203.0.113.173',
    );
  });
  afterAll(async () => {
    expect(bodies.some((b) => UUID.test(b))).toBe(false);
    await env.close();
  });

  it('creates, reads, edits metadata with If-Match, and replays idempotently', async () => {
    const k = key();
    const made = keep(
      await owner.post(
        `${base()}/documents`,
        { title: 'Handbook', brand, type: 'sop' },
        { headers: k },
      ),
    );
    expect(made.statusCode, made.body).toBe(201);
    const d = made.json().data;
    expect(d).toMatchObject({
      type: 'document',
      title: 'Handbook',
      doc_type: 'sop',
      state: 'draft',
      content_version: 1,
    });
    expect(d.id).toMatch(/^doc_/);
    expect(made.headers.etag).toBe(`"${d.version}"`);
    expect(d.content.blocks.length).toBeGreaterThan(2);
    const replay = keep(
      await owner.post(
        `${base()}/documents`,
        { title: 'Handbook', brand, type: 'sop' },
        { headers: k },
      ),
    );
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json().data.id).toBe(d.id);
    const got = keep(await owner.get(`${base()}/documents/${d.id}`));
    expect(got.statusCode).toBe(200);
    // Metadata: state and review date need the row version.
    expect(
      (await owner.patch(`${base()}/documents/${d.id}`, { state: 'current' }, { headers: key() }))
        .statusCode,
    ).toBe(428);
    const patched = keep(
      await owner.patch(
        `${base()}/documents/${d.id}`,
        { state: 'current' },
        { headers: key({ 'if-match': `"${d.version}"` }) },
      ),
    );
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().data).toMatchObject({ state: 'current', effective_state: 'current' });
    const stale = keep(
      await owner.patch(
        `${base()}/documents/${d.id}`,
        { state: 'draft' },
        { headers: key({ 'if-match': `"${d.version}"` }) },
      ),
    );
    expect(stale.statusCode).toBe(409);
    const bad = keep(
      await owner.patch(
        `${base()}/documents/${d.id}`,
        { review_due_on: 'soon' },
        { headers: key({ 'if-match': patched.headers.etag as string }) },
      ),
    );
    expect(bad.statusCode).toBe(422);
    const list = keep(await owner.get(`${base()}/documents?scope=${brand}&state=current`));
    expect(list.json().data.map((x: { id: string }) => x.id)).toContain(d.id);
    expect(list.json().data[0]).not.toHaveProperty('content');
  });

  it('saves content against the version loaded, conflicts on a stale one, lists versions, and restores', async () => {
    const d = keep(
      await owner.post(
        `${base()}/documents`,
        { title: 'Versions', brand, starter: false },
        { headers: key() },
      ),
    ).json().data;
    const put = (v: number, text: string) =>
      owner.put(
        `${base()}/documents/${d.id}/content`,
        { base_version: v, content: { v: 2, blocks: [para('blk_a', text)] } },
        { headers: key() },
      );
    const v2 = keep(await put(1, 'First'));
    expect(v2.statusCode, v2.body).toBe(200);
    expect(v2.json().data.content_version).toBe(2);
    const conflict = keep(await put(1, 'Second from a stale page'));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.conflict).toMatchObject({ current_version: 2 });
    const invalid = keep(
      await owner.put(
        `${base()}/documents/${d.id}/content`,
        { base_version: 2, content: { v: 2, blocks: [{ type: 'script' }] } },
        { headers: key() },
      ),
    );
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.issues[0]).toMatchObject({ code: 'unsupported_block' });
    await put(2, 'Third');
    const versions = keep(await owner.get(`${base()}/documents/${d.id}/versions`));
    expect(versions.json().data.map((x: { number: number }) => x.number)).toEqual([3, 2, 1]);
    const one = keep(await owner.get(`${base()}/documents/${d.id}/versions/2`));
    expect(one.json().data).toMatchObject({ type: 'document_version', number: 2, current: false });
    expect(one.json().data.id).toMatch(/^dcv_/);
    expect(one.json().data.content.blocks[0].runs[0].text).toBe('First');
    expect(keep(await owner.get(`${base()}/documents/${d.id}/versions/99`)).statusCode).toBe(404);
    expect(keep(await owner.get(`${base()}/documents/${d.id}/versions/zero`)).statusCode).toBe(404);
    const restored = keep(
      await owner.post(
        `${base()}/documents/${d.id}/restore-version`,
        { version: 2, base_version: 3 },
        { headers: key() },
      ),
    );
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().data.content_version).toBe(4);
    expect(restored.json().data.content.blocks[0].runs[0].text).toBe('First');
    // Move, links, and backlinks.
    const child = keep(
      await owner.post(`${base()}/documents`, { title: 'Child', parent: d.id }, { headers: key() }),
    ).json().data;
    expect(child).toMatchObject({ depth: 1, parent: { id: d.id } });
    const moved = keep(
      await owner.put(
        `${base()}/documents/${child.id}/location`,
        { parent: null },
        { headers: key() },
      ),
    );
    expect(moved.json().data.depth).toBe(0);
    const fresh = keep(await owner.get(`${base()}/documents/${d.id}`));
    const links = keep(
      await owner.put(
        `${base()}/documents/${d.id}/links`,
        { records: [child.id] },
        { headers: key({ 'if-match': fresh.headers.etag as string }) },
      ),
    );
    expect(links.statusCode, links.body).toBe(200);
    const back = keep(await owner.get(`${base()}/records/${child.id}/documents`));
    expect(back.json().data.map((x: { id: string }) => x.id)).toEqual([d.id]);
  });

  it('suggests, decides, and approves an AI source, and exports', async () => {
    const d = keep(
      await owner.post(
        `${base()}/documents`,
        { title: 'Suggested', starter: false },
        { headers: key() },
      ),
    ).json().data;
    await owner.put(
      `${base()}/documents/${d.id}/content`,
      { base_version: 1, content: { v: 2, blocks: [para('blk_a', 'Alpha')] } },
      { headers: key() },
    );
    const s = keep(
      await member.post(
        `${base()}/documents/${d.id}/suggestions`,
        {
          block: 'blk_a',
          base_version: 2,
          proposed: { type: 'paragraph', runs: [{ text: 'Alpha+' }] },
        },
        { headers: key() },
      ),
    );
    expect(s.statusCode, s.body).toBe(201);
    const sid = s.json().data.id as string;
    expect(sid).toMatch(/^dsg_/);
    expect(
      keep(
        await reader.post(
          `${base()}/suggestions/${sid}:decide`,
          { outcome: 'accept' },
          { headers: key() },
        ),
      ).statusCode,
    ).toBe(403);
    const accepted = keep(
      await owner.post(
        `${base()}/suggestions/${sid}:decide`,
        { outcome: 'accept' },
        { headers: key() },
      ),
    );
    expect(accepted.json().data).toMatchObject({ state: 'accepted', applied_version: 3 });
    expect(keep(await owner.get(`${base()}/suggestions/${sid}`)).json().data.state).toBe(
      'accepted',
    );
    expect(keep(await stranger.get(`${base()}/suggestions/${sid}`)).statusCode).toBe(404);
    const withdrawn = keep(
      await member.post(
        `${base()}/documents/${d.id}/suggestions`,
        {
          block: 'blk_a',
          base_version: 3,
          proposed: { type: 'paragraph', runs: [{ text: 'again' }] },
        },
        { headers: key() },
      ),
    );
    const w = keep(
      await member.post(`${base()}/suggestions/${withdrawn.json().data.id}:withdraw`, undefined, {
        headers: key(),
      }),
    );
    expect(w.json().data.state).toBe('withdrawn');
    expect(
      keep(await owner.post(`${base()}/suggestions/${sid}:explode`, {}, { headers: key() }))
        .statusCode,
    ).toBe(404);
    // AI source: the owner approves the version; a reader cannot.
    const approved = keep(
      await owner.post(
        `${base()}/documents/${d.id}:approve_source`,
        { version: 3 },
        { headers: key() },
      ),
    );
    expect(approved.json().data.ai_source).toMatchObject({ approved: true, version: 3 });
    expect(
      keep(
        await reader.post(
          `${base()}/documents/${d.id}:approve_source`,
          { version: 3 },
          { headers: key() },
        ),
      ).statusCode,
    ).toBe(403);
    expect(
      keep(
        await owner.post(
          `${base()}/documents/${d.id}:revoke_source`,
          { version: 3 },
          { headers: key() },
        ),
      ).json().data.ai_source.approved,
    ).toBe(false);
    // Export: Markdown and HTML as documents of their own, never PDF.
    const md = keep(
      await owner.post(
        `${base()}/documents/${d.id}:export`,
        { format: 'markdown' },
        { headers: key() },
      ),
    );
    expect(md.statusCode, md.body).toBe(200);
    expect(md.json().data).toMatchObject({
      type: 'document_export',
      format: 'markdown',
      filename: 'suggested.md',
    });
    expect(md.json().data.content).toContain('Alpha+');
    expect(
      keep(
        await owner.post(
          `${base()}/documents/${d.id}:export`,
          { format: 'pdf' },
          { headers: key() },
        ),
      ).statusCode,
    ).toBe(422);
    expect(
      keep(
        await reader.post(
          `${base()}/documents/${d.id}:export`,
          { format: 'markdown' },
          { headers: key() },
        ),
      ).statusCode,
    ).toBe(403);
  });

  it('archives, trashes, and restores through verbs, and hides everything from strangers', async () => {
    const d = keep(
      await owner.post(
        `${base()}/documents`,
        { title: 'Lifecycle', starter: false },
        { headers: key() },
      ),
    ).json().data;
    expect(
      keep(
        await owner.post(`${base()}/documents/${d.id}:archive`, undefined, { headers: key() }),
      ).json().data.lifecycle_state,
    ).toBe('archived');
    const edit = keep(
      await owner.put(
        `${base()}/documents/${d.id}/content`,
        { base_version: 1, content: { v: 2, blocks: [] } },
        { headers: key() },
      ),
    );
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error.issues[0]).toMatchObject({ code: 'document_archived' });
    await owner.post(`${base()}/documents/${d.id}:unarchive`, undefined, { headers: key() });
    await owner.post(`${base()}/documents/${d.id}:trash`, undefined, { headers: key() });
    expect(keep(await owner.get(`${base()}/documents/${d.id}`)).statusCode).toBe(404);
    expect(
      keep(await owner.post(`${base()}/documents/${d.id}:restore`, undefined, { headers: key() }))
        .statusCode,
    ).toBe(200);
    expect(
      keep(await owner.post(`${base()}/documents/${d.id}:vanish`, undefined, { headers: key() }))
        .statusCode,
    ).toBe(404);
    for (const path of [
      `/documents/${d.id}`,
      `/documents/${d.id}/versions`,
      `/documents/${d.id}/suggestions`,
      `/records/${d.id}/documents`,
    ])
      expect(keep(await stranger.get(`${base()}${path}`)).statusCode, path).toBe(404);
    expect(keep(await stranger.get(`${base()}/documents`)).statusCode).toBe(404);
    expect(
      keep(await stranger.post(`${base()}/documents`, { title: 'x', brand }, { headers: key() }))
        .statusCode,
    ).toBe(404);
    // Comments, following, and reviews reach a document through the collaboration routes.
    const c = keep(
      await reader.post(
        `${base()}/records/${d.id}/comments`,
        { text: 'A note on the document' },
        { headers: key() },
      ),
    );
    expect(c.statusCode, c.body).toBe(403);
    const ok = keep(
      await owner.post(
        `${base()}/records/${d.id}/comments`,
        { text: 'A note on the document' },
        { headers: key() },
      ),
    );
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().data.host).toMatchObject({ id: d.id, type: 'document' });
  });
});
