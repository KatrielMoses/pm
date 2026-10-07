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
 * 3D HTTP surface (ADR-0019): entries (resources with ETags and If-Match), timer actions as
 * `{id}:{verb}` segments, the live timer and period views as non-resource envelopes, timesheet
 * submission, decision, and step-up-gated unlock, reports and summaries, the export download
 * headers, and non-disclosure to strangers. No response carries an internal UUID.
 */
describe('time API (3D)', () => {
  let env: IdentityEnv;
  let owner: Browser;
  let stranger: Browser;
  let ws: string;
  let brand: string;
  let task: string;
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

  beforeAll(async () => {
    env = await identityEnv();
    owner = await person('time-owner@example.test', '203.0.113.120');
    stranger = await person('time-stranger@example.test', '203.0.113.121');
    const created = await owner.post(
      '/v1/workspaces',
      {
        name: 'Hours',
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
    task = (
      await owner.post(
        `${base()}/tasks`,
        { brand, title: 'Billable work', estimate_minutes: 90 },
        { headers: key() },
      )
    ).json().data.id;
  });
  afterAll(async () => {
    await env.close();
  });

  it('creates, reads, edits with If-Match, lists, and deletes entries', async () => {
    const c = keep(
      await owner.post(
        `${base()}/time-entries`,
        { target: task, work_date: '2026-09-07', duration_minutes: 60, billable: true },
        { headers: key() },
      ),
    );
    expect(c.statusCode, c.body).toBe(201);
    const e = c.json().data;
    expect(e).toMatchObject({ type: 'time_entry', duration_seconds: 3600, hours: 1, version: 0 });
    expect(e.id).toMatch(/^te_/);
    expect(c.headers.etag).toBe('"0"');
    const noMatch = keep(
      await owner.patch(`${base()}/time-entries/${e.id}`, { note: 'x' }, { headers: key() }),
    );
    expect(noMatch.statusCode).toBe(428);
    const u = keep(
      await owner.patch(
        `${base()}/time-entries/${e.id}`,
        { note: 'Kick-off' },
        { headers: key({ 'if-match': '"0"' }) },
      ),
    );
    expect(u.statusCode, u.body).toBe(200);
    expect(u.headers.etag).toBe('"1"');
    const list = keep(await owner.get(`${base()}/time-entries?from=2026-09-01&to=2026-09-30`));
    expect(list.json().data.map((x: { id: string }) => x.id)).toEqual([e.id]);
    expect(list.json().page).toMatchObject({ has_more: false });
    const d = keep(
      await owner.delete(`${base()}/time-entries/${e.id}`, { headers: key({ 'if-match': '"1"' }) }),
    );
    expect(d.statusCode, d.body).toBe(200);
    expect(keep(await owner.get(`${base()}/time-entries/${e.id}`)).statusCode).toBe(404);
  });

  it('runs a timer through action segments and recovers it from the timer view', async () => {
    const s = keep(await owner.post(`${base()}/timer`, { target: task }, { headers: key() }));
    expect(s.statusCode, s.body).toBe(201);
    const id = s.json().data.id;
    const live = keep(await owner.get(`${base()}/timer`));
    expect(live.json().data).toMatchObject({
      type: 'timer_status',
      timer: { id, state: 'running' },
    });
    for (const verb of ['pause', 'pause', 'resume', 'stop', 'stop']) {
      const r = keep(
        await owner.post(`${base()}/time-entries/${id}:${verb}`, {}, { headers: key() }),
      );
      expect(r.statusCode, `${verb} ${r.body}`).toBe(200);
    }
    expect(keep(await owner.get(`${base()}/timer`)).json().data.timer).toBeNull();
    const bad = keep(
      await owner.post(`${base()}/time-entries/${id}:explode`, {}, { headers: key() }),
    );
    expect(bad.statusCode).toBe(404);
  });

  it('submits, self-approves (one-person workspace), and unlocks only with step-up', async () => {
    await owner.post(
      `${base()}/time-entries`,
      { target: task, work_date: '2026-09-14', duration_minutes: 30 },
      { headers: key() },
    );
    const pv = keep(await owner.get(`${base()}/timesheet-period?date=2026-09-16`));
    expect(pv.json().data).toMatchObject({
      type: 'timesheet_period',
      period: { start: '2026-09-14', end: '2026-09-20' },
      can_submit: true,
    });
    const sub = keep(
      await owner.post(`${base()}/timesheets`, { period_start: '2026-09-14' }, { headers: key() }),
    );
    expect(sub.statusCode, sub.body).toBe(200);
    const sheet = sub.json().data;
    expect(sheet.id).toMatch(/^tsh_/);
    expect(sub.headers.etag).toBe(`"${sheet.version}"`);
    const queue = keep(await owner.get(`${base()}/timesheets`));
    expect(queue.json().data.map((x: { id: string }) => x.id)).toEqual([sheet.id]);
    const dec = keep(
      await owner.post(
        `${base()}/timesheets/${sheet.id}:decide`,
        { brand, decision: 'approve' },
        { headers: key({ 'if-match': `"${sheet.version}"` }) },
      ),
    );
    expect(dec.statusCode, dec.body).toBe(200);
    expect(dec.json().data.lines[0].decisions[0]).toMatchObject({ self_approval: true });
    const v = dec.json().data.version;
    const un = keep(
      await owner.post(
        `${base()}/timesheets/${sheet.id}:unlock`,
        { brand, reason: 'Correction' },
        { headers: key({ 'if-match': `"${v}"` }) },
      ),
    );
    expect(un.json().error?.code, un.body).toBe('step_up_required');
    expect(un.json().error.step_up).toBeDefined();
  });

  it('serves reports, summaries, and a no-store CSV download', async () => {
    const r = keep(
      await owner.get(`${base()}/time-report?from=2026-09-01&to=2026-09-30&group=task`),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().data).toMatchObject({
      type: 'time_report',
      group: 'task',
      planned_measure: 'task_estimate',
    });
    const sum = keep(await owner.get(`${base()}/time-summary/${task}`));
    expect(sum.json().data).toMatchObject({
      type: 'time_summary',
      planned: { estimate_minutes: 90 },
      remaining: { method: 'remaining_estimate_else_estimate_minus_actual' },
    });
    const x = keep(
      await owner.post(`${base()}/time-export`, { from: '2026-09-01', to: '2026-09-30' }),
    );
    expect(x.statusCode, x.body).toBe(200);
    expect(x.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(x.headers['content-disposition']).toBe(
      'attachment; filename="time-2026-09-01-to-2026-09-30.csv"',
    );
    expect(x.headers['cache-control']).toBe('private, no-store');
    expect(x.body.split('\r\n')[0]).toMatch(/^Entry ID,Date,Time zone/);
  });

  it('gives strangers the same not_found everywhere and never returns internal UUIDs', async () => {
    const entry = keep(
      await owner.post(
        `${base()}/time-entries`,
        { target: task, work_date: '2026-09-21', duration_minutes: 5 },
        { headers: key() },
      ),
    ).json().data.id;
    for (const [method, path, body] of [
      ['get', `${base()}/time-entries/${entry}`, undefined],
      ['get', `${base()}/time-entries`, undefined],
      ['get', `${base()}/timer`, undefined],
      ['post', `${base()}/timer`, { target: task }],
      [
        'post',
        `${base()}/time-entries`,
        { target: task, work_date: '2026-09-21', duration_minutes: 5 },
      ],
      ['get', `${base()}/time-report`, undefined],
      ['post', `${base()}/time-export`, {}],
      ['get', `${base()}/time-summary/${task}`, undefined],
    ] as const) {
      const r = keep(
        method === 'get'
          ? await stranger.get(path)
          : await stranger.post(path, body, { headers: key() }),
      );
      expect(r.statusCode, path).toBe(404);
    }
    for (const b of bodies) expect(b).not.toMatch(UUID);
  });
});
