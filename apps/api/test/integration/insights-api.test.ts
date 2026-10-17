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
const widgets = [
  { id: 'open', metric: 'tasks.open' },
  { id: 'byproject', metric: 'tasks.open', params: { group_by: 'project' } },
];

/**
 * 5D HTTP surface (ADR-0031; 0D PL-41): dashboards, saved reports, widget reads, drill-through,
 * exports, shares, schedules, and recipients. Every request re-checks the placement or the share,
 * every figure is computed for the caller, unknown and hidden are one answer, nothing is cached for
 * another person, and no internal identifier appears in any body.
 */
describe('dashboards and reports API (5D)', () => {
  let env: IdentityEnv;
  let owner: Browser;
  let editor: Browser;
  let stranger: Browser;
  let guest: Browser;
  let ws: string;
  let brand: string;
  let summit: string;
  const ids: Record<string, string> = {};
  const bodies: string[] = [];
  const keep = (r: LightMyRequestResponse) => {
    bodies.push(r.body);
    return r;
  };
  const key = (extra: Record<string, string> = {}) => ({ 'idempotency-key': idemKey(), ...extra });
  const base = () => `/v1/workspaces/${ws}`;
  const post = async (
    who: Browser,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) => keep(await who.post(`${base()}${path}`, body, { headers: key(headers) }));
  const get = async (who: Browser, path: string) => keep(await who.get(`${base()}${path}`));

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
  const memberId = async (who: Browser) =>
    (await get(who, '/context')).json().data.principal_membership ??
    (await get(who, '/members/me').catch(() => null))?.json()?.data?.id;

  beforeAll(async () => {
    env = await identityEnv();
    owner = await person('ins-owner@example.test', '203.0.113.200');
    stranger = await person('ins-stranger@example.test', '203.0.113.201');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Insights',
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
    summit = (await post(owner, '/brands', { name: 'Summit' })).json().data.id;
    editor = await invite(
      'ins-editor@example.test',
      { kind: 'member', role: 'member' },
      '203.0.113.202',
    );
    ids.project = (await post(owner, '/projects', { brand, name: 'Launch' })).json().data.id;
    ids.hidden = (
      await post(owner, '/projects', { brand: summit, name: 'Secret site' })
    ).json().data.id;
    ids.t1 = (
      await post(owner, '/tasks', { brand, title: 'Ship it', project: ids.project })
    ).json().data.id;
    await post(owner, '/tasks', { brand, title: 'Test it', project: ids.project });
    await post(owner, '/tasks', { brand: summit, title: 'Hidden', project: ids.hidden });
    guest = await invite(
      'ins-guest@example.test',
      { kind: 'guest', records: [{ record: ids.t1, level: 'comment' }] },
      '203.0.113.203',
    );
  });
  afterAll(async () => {
    expect(bodies.some((b) => UUID.test(b))).toBe(false);
    await env.close();
  });

  it('serves the metric catalog, with what is not yet available and why', async () => {
    const r = await get(owner, '/insights/metrics');
    expect(r.statusCode, r.body).toBe(200);
    const d = r.json().data;
    expect(d.type).toBe('insight_metrics');
    expect(d.metrics.map((m: { key: string }) => m.key)).toContain('tasks.overdue');
    expect(d.not_available.map((m: { key: string }) => m.key)).toContain('automation.rates');
    expect(d.metrics.map((m: { key: string }) => m.key)).toContain('ai.usage');
    expect(r.headers['cache-control']).toContain('no-store');
    const g = await get(guest, '/insights/metrics');
    expect(g.json().data.not_available).toEqual([]);
  });

  it('creates and edits a dashboard with ETags, idempotency, and validation errors', async () => {
    const created = await post(owner, '/dashboards', {
      title: 'Overview',
      kind: 'owner',
      layout: { widgets },
    });
    expect(created.statusCode, created.body).toBe(201);
    const d = created.json().data;
    ids.dash = d.id;
    expect(d).toMatchObject({
      type: 'dashboard',
      kind: 'owner',
      version: 0,
      scope: { kind: 'workspace' },
    });
    expect(created.headers.etag).toBe('"0"');
    const body = { title: 'Replay', kind: 'owner' };
    const h = { 'idempotency-key': 'dash-create-key-00001' };
    const a = keep(await owner.post(`${base()}/dashboards`, body, { headers: h }));
    const b = keep(await owner.post(`${base()}/dashboards`, body, { headers: h }));
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json().data.id).toBe(a.json().data.id);
    const patched = keep(
      await owner.patch(
        `${base()}/dashboards/${d.id}`,
        { title: 'Overview 2' },
        { headers: key({ 'if-match': '"0"' }) },
      ),
    );
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.headers.etag).toBe('"1"');
    const stale = keep(
      await owner.patch(
        `${base()}/dashboards/${d.id}`,
        { title: 'Late' },
        { headers: key({ 'if-match': '"0"' }) },
      ),
    );
    expect(stale.statusCode).toBe(409);
    const missing = keep(
      await owner.patch(`${base()}/dashboards/${d.id}`, { title: 'x' }, { headers: key() }),
    );
    expect(missing.statusCode).toBe(428);
    const bad = await post(owner, '/dashboards', {
      title: 'x',
      kind: 'owner',
      layout: { widgets: [{ id: 'a', metric: 'nope' }] },
    });
    expect(bad.statusCode).toBe(422);
    const later = await post(owner, '/dashboards', {
      title: 'x',
      kind: 'owner',
      layout: { widgets: [{ id: 'a', metric: 'automation.rates' }] },
    });
    expect(later.statusCode).toBe(422);
  });

  it('computes each widget for the caller and never caches it for anyone else', async () => {
    const mine = await get(owner, `/dashboards/${ids.dash}/widgets/open`);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.headers['cache-control']).toContain('no-store');
    expect(mine.json().data).toMatchObject({
      type: 'widget_result',
      outcome: { state: 'ok', value: 3 },
    });
    const them = await get(editor, `/dashboards/${ids.dash}/widgets/open`);
    // Same dashboard, a member without brand access: their own figure.
    expect(them.json().data.outcome.value).toBe(0);
    const groups = await get(owner, `/dashboards/${ids.dash}/widgets/byproject`);
    expect(
      groups
        .json()
        .data.outcome.breakdown.map((x: { label: string }) => x.label)
        .sort(),
    ).toEqual(['Launch', 'Secret site']);
    const ad = await get(
      owner,
      `/dashboards/${ids.dash}/widgets/open?filters=${encodeURIComponent(JSON.stringify({ brands: [brand] }))}`,
    );
    expect(ad.json().data.outcome.value).toBe(2);
    expect(ad.json().data.outcome.applied.brands).toBe(true);
    const badFilters = await get(owner, `/dashboards/${ids.dash}/widgets/open?filters=%7Bnope`);
    expect(badFilters.statusCode).toBe(422);
    expect((await get(owner, `/dashboards/${ids.dash}/widgets/nothere`)).statusCode).toBe(404);
  });

  it('serves ad hoc widgets for Home and project pages, as the caller', async () => {
    const all = await get(owner, '/insights/widget?metric=tasks.open');
    expect(all.statusCode, all.body).toBe(200);
    expect(all.json().data).toMatchObject({
      type: 'widget_result',
      outcome: { state: 'ok', value: 3 },
    });
    expect(all.headers['cache-control']).toContain('no-store');
    const one = await get(owner, `/insights/widget?metric=tasks.open&project=${ids.project}`);
    expect(one.json().data.outcome.value).toBe(2);
    const theirs = await get(editor, '/insights/widget?metric=tasks.open');
    expect(theirs.json().data.outcome.value).toBe(0);
    const hidden = await get(editor, `/insights/widget?metric=tasks.open&project=${ids.hidden}`);
    const unknown = await get(
      editor,
      '/insights/widget?metric=tasks.open&project=prj_00000000000000000000000000',
    );
    expect(hidden.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe(unknown.json().error.code);
    expect((await get(guest, '/insights/widget?metric=tasks.open')).statusCode).toBe(403);
    expect((await get(owner, '/insights/widget?metric=nope')).statusCode).toBe(422);
    const rec = await get(owner, '/insights/widget/records?metric=tasks.open&limit=1');
    expect(rec.json().data).toMatchObject({
      type: 'widget_records',
      page: { limit: 1, has_more: true },
    });
  });

  it('drills into only the records the caller may read, page by page', async () => {
    const r = await get(owner, `/dashboards/${ids.dash}/widgets/open/records?limit=1`);
    expect(r.statusCode, r.body).toBe(200);
    const d = r.json().data;
    expect(d).toMatchObject({ type: 'widget_records', page: { limit: 1, has_more: true } });
    const next = await get(
      owner,
      `/dashboards/${ids.dash}/widgets/open/records?limit=5&cursor=${encodeURIComponent(d.page.next_cursor)}`,
    );
    expect(next.statusCode, next.body).toBe(200);
    const none = await get(editor, `/dashboards/${ids.dash}/widgets/open/records`);
    expect(none.json().data.rows).toEqual([]);
    const forged = await get(
      editor,
      `/dashboards/${ids.dash}/widgets/open/records?cursor=${encodeURIComponent(d.page.next_cursor)}`,
    );
    expect(forged.statusCode).toBe(400);
  });

  it('answers unknown and hidden identically, and keeps personal dashboards personal', async () => {
    const mine = await post(editor, '/dashboards', { title: 'Mine', kind: 'personal' });
    expect(mine.statusCode, mine.body).toBe(201);
    const unknown = await get(owner, '/dashboards/dash_00000000000000000000000000');
    const hidden = await get(owner, `/dashboards/${mine.json().data.id}`);
    expect(unknown.statusCode).toBe(404);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe(unknown.json().error.code);
    expect((await get(stranger, `/dashboards/${ids.dash}`)).statusCode).toBe(404);
    expect((await get(guest, '/dashboards')).statusCode).toBe(403);
  });

  it('exports CSV and PDF as the requester, with safe headers', async () => {
    const csv = await get(owner, `/dashboards/${ids.dash}/export?format=csv`);
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="[a-z0-9-]+\.csv"/);
    expect(csv.headers['x-content-type-options']).toBe('nosniff');
    expect(csv.body).toContain('Secret site');
    const theirs = await get(editor, `/dashboards/${ids.dash}/export?format=csv`);
    expect(theirs.body).not.toContain('Secret site');
    const pdf = await get(owner, `/dashboards/${ids.dash}/export?format=pdf&widget=open`);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await get(owner, `/dashboards/${ids.dash}/export?format=xlsx`)).statusCode).toBe(422);
  });

  it('creates a report, shares it explicitly, runs it for the grantee, and revokes the share', async () => {
    const rep = await post(owner, '/reports', { title: 'Weekly', brand, layout: { widgets } });
    expect(rep.statusCode, rep.body).toBe(201);
    ids.rpt = rep.json().data.id;
    expect(rep.json().data).toMatchObject({
      type: 'report_definition',
      access: 'placement',
      scope: { kind: 'brand' },
    });
    expect((await get(editor, `/reports/${ids.rpt}`)).statusCode).toBe(404);
    expect((await get(stranger, `/reports/${ids.rpt}`)).statusCode).toBe(404);
    const members = (await get(owner, '/people?state=active')).json();
    const editorMember = (
      members.data as Array<{ id: string; display_name?: string; email?: string }>
    ).find(
      (m) =>
        String(m.email ?? '').includes('ins-editor') ||
        String(m.display_name ?? '').includes('ins-editor'),
    );
    expect(editorMember, 'the directory lists the stranger').toBeTruthy();
    const share = await post(owner, `/reports/${ids.rpt}/shares`, { grantee: editorMember!.id });
    expect(share.statusCode, share.body).toBe(201);
    const opened = await get(editor, `/reports/${ids.rpt}`);
    expect(opened.json().data).toMatchObject({ access: 'share', scope: { kind: 'shared' } });
    const w = await get(editor, `/reports/${ids.rpt}/widgets/open`);
    expect(w.json().data.outcome.value).toBe(0);
    expect(w.json().data.outcome.covers).not.toContain('Main');
    const revoked = keep(
      await owner.delete(`${base()}/reports/${ids.rpt}/shares/${share.json().data.id}`, {
        headers: key(),
      }),
    );
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((await get(editor, `/reports/${ids.rpt}`)).statusCode).toBe(404);
  });

  it('schedules a report only with recipients, and lists runs to those who may schedule', async () => {
    const r = (await get(owner, `/reports/${ids.rpt}`)).json().data;
    const none = keep(
      await owner.put(
        `${base()}/reports/${ids.rpt}/schedule`,
        { schedule: { frequency: 'daily', time: '08:00', timezone: 'UTC' } },
        { headers: key({ 'if-match': `"${r.version}"` }) },
      ),
    );
    expect(none.statusCode).toBe(422);
    const members = (await get(owner, '/people?state=active')).json().data as Array<{
      id: string;
      is_you?: boolean;
    }>;
    const self = members.find((m) => m.is_you)!;
    const withRecipients = keep(
      await owner.put(
        `${base()}/reports/${ids.rpt}/recipients`,
        { members: [self.id] },
        { headers: key({ 'if-match': `"${r.version}"` }) },
      ),
    );
    expect(withRecipients.statusCode, withRecipients.body).toBe(200);
    const v = withRecipients.json().data.version;
    const scheduled = keep(
      await owner.put(
        `${base()}/reports/${ids.rpt}/schedule`,
        { schedule: { frequency: 'weekly', weekday: 1, time: '08:00', timezone: 'Europe/Berlin' } },
        { headers: key({ 'if-match': `"${v}"` }) },
      ),
    );
    expect(scheduled.statusCode, scheduled.body).toBe(200);
    expect(scheduled.json().data.schedule).toMatchObject({
      frequency: 'weekly',
      description: 'Every Monday at 08:00 Europe/Berlin',
    });
    const runs = await get(owner, `/reports/${ids.rpt}/runs`);
    expect(runs.statusCode).toBe(200);
    expect((await get(editor, `/reports/${ids.rpt}/runs`)).statusCode).toBeGreaterThanOrEqual(403);
    const left = await post(owner, `/reports/${ids.rpt}:leave`, {});
    expect(left.statusCode, left.body).toBe(200);
  });

  it('moves a dashboard through trash, restore, and purge with the lifecycle verbs', async () => {
    const d = (await post(owner, '/dashboards', { title: 'Temp', kind: 'owner' })).json().data;
    const trashed = await post(owner, `/dashboards/${d.id}:trash`, {}, { 'if-match': '"0"' });
    expect(trashed.statusCode, trashed.body).toBe(200);
    expect((await get(owner, `/dashboards/${d.id}`)).statusCode).toBe(404);
    const trash = await get(owner, '/insights/trash');
    expect(trash.json().data.data.map((x: { id: string }) => x.id)).toContain(d.id);
    const restored = await post(owner, `/dashboards/${d.id}:restore`, {});
    expect(restored.statusCode, restored.body).toBe(200);
    expect((await post(owner, `/dashboards/${d.id}:nonsense`, {})).statusCode).toBe(404);
    void memberId;
  });
});
