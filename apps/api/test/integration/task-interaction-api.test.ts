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
const soon = (h = 1) => new Date(Date.now() + h * 3_600_000).toISOString();

/**
 * 2D HTTP surface (ADR-0016): signals and duplicates (non-resource envelopes), reminders, snooze,
 * ordering verbs, bulk preview and execute, undo, task templates (apply returns a
 * template_application), recurring tasks, and non-disclosure for strangers and guessed IDs.
 */
describe('task interaction API (2D)', () => {
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
  const task = async (title: string, extra: Record<string, unknown> = {}) =>
    keep(await owner.post(`${base()}/tasks`, { brand, title, ...extra }, { headers: key() })).json()
      .data;

  beforeAll(async () => {
    env = await identityEnv();
    owner = await person('ti-owner@example.test', '203.0.113.90');
    stranger = await person('ti-stranger@example.test', '203.0.113.91');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Interaction',
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

  it('signals, batch signals, and duplicates are non-resource envelopes', async () => {
    const t = await task('Renew certificate');
    const s = keep(await owner.get(`${base()}/tasks/${t.id}/signals`));
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json().data).toMatchObject({
      type: 'task_signals',
      task: { id: t.id },
      signals: { stale: false, missing_date: true },
      source: { kind: 'manual' },
      reminders: [],
      snooze: null,
    });
    const b = keep(await owner.get(`${base()}/task-signals?tasks=${t.id}`));
    expect(b.json().data).toMatchObject({ type: 'task_signals', items: [{ task: t.id }] });
    const d = keep(
      await owner.get(
        `${base()}/task-duplicates?brand=${brand}&title=${encodeURIComponent('renew  CERTIFICATE')}`,
      ),
    );
    expect(d.json().data).toMatchObject({
      type: 'duplicate_candidates',
      advisory: true,
      candidates: [{ id: t.id }],
    });
  });

  it('reminders, snooze, ordering, mark-updated, and undo through verbs and resources', async () => {
    const t = await task('Personal');
    const r = keep(
      await owner.post(
        `${base()}/tasks/${t.id}/reminders`,
        { remind_at: soon() },
        { headers: key() },
      ),
    );
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().data).toMatchObject({ type: 'task_reminder', state: 'scheduled' });
    expect(r.json().data.id).toMatch(/^rem_/);
    const list = keep(await owner.get(`${base()}/reminders`));
    expect(list.json().data).toEqual([expect.objectContaining({ id: r.json().data.id })]);
    const dis = keep(
      await owner.patch(
        `${base()}/reminders/${r.json().data.id}`,
        { state: 'cancelled' },
        { headers: key() },
      ),
    );
    expect(dis.json().data.state).toBe('cancelled');
    const sn = keep(
      await owner.post(`${base()}/tasks/${t.id}:snooze`, { until: soon(2) }, { headers: key() }),
    );
    expect(sn.statusCode, sn.body).toBe(200);
    expect(sn.json().data.snoozed_until).toBeTruthy();
    expect(
      keep(await owner.post(`${base()}/tasks/${t.id}:unsnooze`, {}, { headers: key() })).json().data
        .snoozed_until,
    ).toBeNull();
    const t2 = await task('Second');
    const o = keep(
      await owner.post(
        `${base()}/tasks/${t2.id}:reorder`,
        { position: 'top' },
        { headers: { ...key(), 'if-match': `"${t2.version}"` } },
      ),
    );
    expect(o.statusCode, o.body).toBe(200);
    expect(o.json().data).toMatchObject({
      position: 1,
      announcement: expect.stringMatching(/position 1/),
    });
    expect(
      keep(await owner.post(`${base()}/tasks/${t.id}:mark_updated`, {}, { headers: key() }))
        .statusCode,
    ).toBe(200);
    const e = keep(
      await owner.patch(
        `${base()}/tasks/${t.id}`,
        { version: t.version, changes: { title: { base: 'Personal', value: 'Edited' } } },
        { headers: key() },
      ),
    );
    const undoId = e.json().data.undo.id;
    expect(undoId).toMatch(/^und_/);
    const u = keep(await owner.post(`${base()}/undo/${undoId}:apply`, {}, { headers: key() }));
    expect(u.statusCode, u.body).toBe(200);
    expect(u.json().data).toMatchObject({ type: 'undo_entry', state: 'applied', tasks: [t.id] });
    const again = keep(await owner.post(`${base()}/undo/${undoId}:apply`, {}, { headers: key() }));
    expect(again.statusCode).toBe(409);
  });

  it('bulk: preview resource, execute verb, per-item report', async () => {
    const a = await task('Bulk A');
    const b = await task('Bulk B');
    const p = keep(
      await owner.post(
        `${base()}/task-bulk`,
        {
          operation: 'set_priority',
          params: { value: 'urgent' },
          tasks: [a.id, b.id, 'tsk_00000000000000000000000000'],
        },
        { headers: key() },
      ),
    );
    expect(p.statusCode, p.body).toBe(201);
    expect(p.json().data).toMatchObject({
      type: 'bulk_operation',
      state: 'previewed',
      mode: 'partial',
    });
    const id = p.json().data.id;
    expect(id).toMatch(/^bop_/);
    expect(keep(await owner.get(`${base()}/task-bulk/${id}`)).json().data.state).toBe('previewed');
    const x = keep(await owner.post(`${base()}/task-bulk/${id}:execute`, {}, { headers: key() }));
    expect(x.statusCode, x.body).toBe(200);
    expect(x.json().data.items.map((i: { outcome: string }) => i.outcome)).toEqual([
      'applied',
      'applied',
    ]);
    const tooMany = keep(
      await owner.post(
        `${base()}/task-bulk`,
        { operation: 'archive', tasks: [] },
        { headers: key() },
      ),
    );
    expect(tooMany.statusCode).toBe(422);
  });

  it('templates and recurrence: save as template, apply (template_application), define and generate', async () => {
    const t = await task('Template me', { priority: 'high' });
    const tpl = keep(
      await owner.post(
        `${base()}/tasks/${t.id}:save_as_template`,
        { name: 'Mine' },
        { headers: key() },
      ),
    );
    expect(tpl.statusCode, tpl.body).toBe(201);
    expect(tpl.json().data).toMatchObject({ type: 'template', target: 'task', version: 1 });
    const listed = keep(await owner.get(`${base()}/task-templates`));
    expect(listed.json().data.map((x: { id: string }) => x.id)).toContain(tpl.json().data.id);
    const ap = keep(
      await owner.post(
        `${base()}/task-templates/${tpl.json().data.id}:apply`,
        { brand, title: 'Applied' },
        { headers: key() },
      ),
    );
    expect(ap.statusCode, ap.body).toBe(201);
    expect(ap.json().data).toMatchObject({
      type: 'template_application',
      task: { title: 'Applied', priority: 'high' },
      omitted: expect.arrayContaining(['assignees']),
    });
    const s = keep(
      await owner.post(
        `${base()}/tasks/${t.id}/recurrences`,
        { frequency: 'weekly', anchor_tz: 'UTC', start: '2026-05-04T09:00' },
        { headers: key() },
      ),
    );
    expect(s.statusCode, s.body).toBe(201);
    const g = keep(
      await owner.post(
        `${base()}/tasks/${t.id}/recurrences/${s.json().data.id}:generate`,
        {},
        { headers: key() },
      ),
    );
    expect(g.statusCode, g.body).toBe(201);
    expect(g.json().data.occurrence).toMatchObject({ occurrence_key: '2026-05-04T09:00' });
    const pause = keep(
      await owner.post(
        `${base()}/tasks/${t.id}/recurrences/${s.json().data.id}:pause`,
        {},
        { headers: key() },
      ),
    );
    expect(pause.json().data.state).toBe('paused');
  });

  it('strangers and guessed identifiers get the same not_found; no response carries internal UUIDs', async () => {
    const t = await task('Hidden from strangers');
    const r = keep(
      await owner.post(
        `${base()}/tasks/${t.id}/reminders`,
        { remind_at: soon() },
        { headers: key() },
      ),
    ).json().data;
    for (const [method, path, body] of [
      ['get', `${base()}/tasks/${t.id}/signals`, undefined],
      ['get', `${base()}/tasks/tsk_01J0000000000000000000000Z/signals`, undefined],
      ['post', `${base()}/tasks/${t.id}/reminders`, { remind_at: soon() }],
      ['patch', `${base()}/reminders/${r.id}`, { state: 'cancelled' }],
      ['post', `${base()}/tasks/${t.id}:snooze`, { until: soon() }],
      ['post', `${base()}/undo/und_01J0000000000000000000000Z:apply`, {}],
      ['post', `${base()}/task-bulk/bop_01J0000000000000000000000Z:execute`, {}],
    ] as const) {
      const res = keep(
        method === 'get'
          ? await stranger.get(path)
          : method === 'patch'
            ? await stranger.patch(path, body, { headers: key() })
            : await stranger.post(path, body, { headers: key() }),
      );
      expect(res.statusCode, path).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    }
    for (const b of bodies) expect(b).not.toMatch(UUID);
  });
});
