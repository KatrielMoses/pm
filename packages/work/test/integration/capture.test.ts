import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import { productLifecycleRegistry } from '@pm/work';
import {
  join,
  membershipOf,
  mutation,
  workEnv,
  workspaceIdOf,
  workspaceWith,
  type WorkEnv,
} from './fixture.ts';

const reason = (code: string) => expect.objectContaining({ code });
const issueOf = (code: string) =>
  expect.objectContaining({ issues: expect.arrayContaining([expect.objectContaining({ code })]) });
const TODAY = '2026-10-06';

/**
 * Phase 2E capture on real PostgreSQL (ADR-0017): one capture command, incomplete items saved
 * without configuration, original text and source preserved, paste candidates with per-item
 * results, deterministic detection with confirmation of ambiguous values, triage into tasks, notes,
 * and projects (lineage and audit), merge without destroying sources, note conversion, link
 * attachments with file storage refused, and intake forms (members-only, rate-limited).
 */
describe('Inbox and universal capture (2E)', () => {
  let db: TestDatabase;
  let env: WorkEnv;
  let owner: Caller;
  let ws: string;
  let brands: Record<string, string>;
  const cap = (body: Record<string, unknown>, as: Caller = owner) =>
    env.svc.capture(as, ws, { today: TODAY, ...body }, mutation()).then((r) => r.data);
  const item = (id: string, as: Caller = owner) => env.svc.getInboxItem(as, ws, id);

  beforeAll(async () => {
    db = await createTestDatabase();
    env = workEnv(db);
    ({ owner, ws, brands } = await workspaceWith(env, db, ['Harbor', 'Summit']));
  });
  afterAll(async () => {
    await env.h.close();
    await db.drop();
  });

  it('captures an incomplete task with no configuration and keeps the original text, source, and correlation', async () => {
    const r = await cap({ text: 'call the plumber' });
    expect(r.items).toEqual([
      expect.objectContaining({ outcome: 'saved', text: 'call the plumber' }),
    ]);
    const i = await item(r.id);
    expect(i).toMatchObject({
      raw_text: 'call the plumber',
      source: { kind: 'typed' },
      brand: null,
      intent: 'task',
      triage_state: 'untriaged',
      parser_version: 1,
      title: 'call the plumber',
    });
    // The original capture is immutable in the database.
    await expect(
      db.admin(
        `UPDATE capture.inbox_item SET raw_text = 'x' WHERE id = (SELECT id FROM core.record WHERE public_id = $1)`,
        [r.id],
      ),
    ).rejects.toThrow(/immutable/);
    const row = await db.admin(
      `SELECT i.correlation_id, i.source_kind FROM capture.inbox_item i JOIN core.record r ON r.id = i.id WHERE r.public_id = $1`,
      [r.id],
    );
    expect(row.rows[0].correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    const audit = await db.admin(
      `SELECT action, changes FROM audit.audit_event WHERE target_public_id = $1`,
      [r.id],
    );
    expect(audit.rows.map((a) => a.action)).toEqual(['capture.captured']);
    expect(JSON.stringify(audit.rows[0].changes)).not.toContain('plumber');
    const listed = await env.svc.listInbox(owner, ws, {});
    expect(listed.data.map((x) => x.id)).toContain(r.id);
  });

  it('detects values deterministically, resolves only readable names, and requires a choice for ambiguous ones', async () => {
    await env.svc.createProject(owner, ws, { brand: brands.Harbor, name: 'Launch' }, mutation());
    await env.svc.createLabel(owner, ws, brands.Harbor, { name: 'ops' }, mutation());
    const pv = await env.svc.previewCapture(owner, ws, {
      text: 'Renew cert due 3/4 !high 30m #ops +Launch brand:Harbor every month',
      today: TODAY,
    });
    expect(pv).toMatchObject({ parser_version: 1, ai: false });
    const c = pv.candidates[0]!;
    expect(c.title).toBe('Renew cert');
    const by = Object.fromEntries(c.detected.map((d) => [d.field, d]));
    expect(by.due_date).toMatchObject({
      status: 'ambiguous',
      options: [expect.anything(), expect.anything()],
    });
    expect(by.priority).toMatchObject({ status: 'resolved', value: 'high' });
    expect(by.estimate_minutes).toMatchObject({ status: 'resolved', value: 30 });
    expect(by.brand).toMatchObject({ status: 'resolved', value: brands.Harbor });
    expect(by.project).toMatchObject({ status: 'resolved', label: 'Launch' });
    expect(by.label).toMatchObject({ status: 'resolved', label: 'ops' });
    expect(c.needs_confirmation).toBe(true);
    // Nothing was saved by the preview.
    expect(
      (await env.svc.listInbox(owner, ws, {})).data.some((x) =>
        x.raw_text.startsWith('Renew cert'),
      ),
    ).toBe(false);
    // Saving keeps the ambiguity; triage refuses until the person chooses.
    const saved = await cap({
      text: 'Renew cert due 3/4 !high 30m #ops +Launch brand:Harbor every month',
    });
    const pre = await env.svc.previewTriage(owner, ws, { items: [saved.id], to: 'task' });
    expect(pre.items[0]).toMatchObject({
      outcome: 'invalid',
      code: 'needs_confirmation',
      pending: ['due_date'],
    });
    const chosen = by.due_date!.options![1]!.value;
    const applied = (
      await env.svc.triage(
        owner,
        ws,
        { items: [saved.id], to: 'task', choices: { due_date: chosen } },
        mutation(),
      )
    ).data.items[0]!;
    expect(applied).toMatchObject({ outcome: 'applied', to: 'task' });
    const t = await env.svc.getTask(owner, ws, applied.record as string);
    expect(t).toMatchObject({
      title: 'Renew cert',
      due_date: chosen,
      priority: 'high',
      estimate_minutes: 30,
      project: expect.objectContaining({ name: 'Launch' }),
      labels: [expect.objectContaining({ name: 'ops' })],
      source: { kind: 'intake', inbox: saved.id },
    });
    const sig = await env.svc.taskSignals(owner, ws, t.id);
    expect(sig.recurrence).toHaveLength(1);
    expect(await item(saved.id)).toMatchObject({
      triage_state: 'converted',
      converted: { kind: 'task', id: t.id },
    });
    const lineage = await db.admin(
      `SELECT target_kind FROM capture.capture_conversion c JOIN core.record r ON r.id = c.source_record_id WHERE r.public_id = $1`,
      [saved.id],
    );
    expect(lineage.rows).toEqual([{ target_kind: 'task' }]);
  });

  it('paste: one candidate per line, edited and removed before save, every result reported', async () => {
    const pv = await env.svc.previewCapture(owner, ws, {
      mode: 'paste',
      text: '- Buy milk\n* Call Ana tomorrow\n\n1. Draft brief',
      today: TODAY,
    });
    expect(pv.candidates.map((c) => c.title)).toEqual(['Buy milk', 'Call Ana', 'Draft brief']);
    const r = await cap({ items: [{ text: 'Buy oat milk' }, { text: 'Call Ana tomorrow' }] });
    expect(r.items.map((i) => i.outcome)).toEqual(['saved', 'saved']);
    expect(r.batch).toMatch(/^batch:/);
    expect((await item(r.items[1]!.id!)).source).toMatchObject({ kind: 'paste', ref: r.batch });
    const small = workEnv(db, { work: { capturePasteLinesMax: 2 } });
    try {
      await expect(
        small.svc.capture(owner, ws, { mode: 'paste', text: 'a\nb\nc' }, mutation()),
      ).rejects.toEqual(issueOf('too_many'));
    } finally {
      await small.h.close();
    }
    await expect(cap({ items: [{ text: 'ok' }, { text: '   ' }] })).rejects.toEqual(
      issueOf('required'),
    );
  });

  it('notes: captured at once, edited, converted to a task or project after confirmation; the note stays', async () => {
    const r = await cap({ intent: 'note', text: 'Pricing ideas\nTry a yearly plan by friday' });
    const noteId = r.items[0]!.note!;
    const n = await env.svc.getNote(owner, ws, noteId);
    expect(n).toMatchObject({
      title: 'Pricing ideas',
      body: 'Try a yearly plan by friday',
      source_inbox_item: r.id,
    });
    expect((await item(r.id)).converted).toEqual({ kind: 'note', id: noteId });
    await expect(
      env.svc.convertNote(owner, ws, noteId, { to: 'task', brand: brands.Harbor }, mutation()),
    ).rejects.toEqual(issueOf('required'));
    const conv = (
      await env.svc.convertNote(
        owner,
        ws,
        noteId,
        { to: 'task', brand: brands.Harbor, confirm: true, today: TODAY },
        mutation(),
      )
    ).data;
    const t = await env.svc.getTask(owner, ws, conv.created!);
    expect(t).toMatchObject({ title: 'Pricing ideas', source: { kind: 'intake', note: noteId } });
    const proj = (
      await env.svc.convertNote(
        owner,
        ws,
        noteId,
        { to: 'project', brand: brands.Harbor, confirm: true },
        mutation(),
      )
    ).data;
    expect((await env.svc.getProject(owner, ws, proj.created!)).name).toBe('Pricing ideas');
    const after = await env.svc.getNote(owner, ws, noteId);
    expect(after.conversions.map((c) => c.kind)).toEqual(['task', 'project']);
    const u = (
      await env.svc.updateNote(
        owner,
        ws,
        noteId,
        { body: 'edited', version: after.version },
        mutation(),
      )
    ).data;
    expect(u.body).toBe('edited');
  });

  it('triage to project (PRJ-017), to note, and discard; restore; brand required for operational work', async () => {
    const a = await cap({ text: 'Website refresh' });
    await expect(
      env.svc.previewTriage(owner, ws, { items: [a.id], to: 'project' }).then((p) => p.items[0]),
    ).resolves.toMatchObject({ outcome: 'invalid', code: 'brand_required' });
    const p = (
      await env.svc.triage(
        owner,
        ws,
        { items: [a.id], to: 'project', brand: brands.Summit },
        mutation(),
      )
    ).data.items[0]!;
    expect(p).toMatchObject({ outcome: 'applied', to: 'project' });
    const prj = await db.admin(
      `SELECT w.intake_source_id = i.id AS linked FROM work.project w JOIN core.record r ON r.id = w.id JOIN core.record ri ON ri.public_id = $2 JOIN capture.inbox_item i ON i.id = ri.id WHERE r.public_id = $1`,
      [p.record, a.id],
    );
    expect(prj.rows[0].linked).toBe(true);
    const b = await cap({ text: 'Thoughts on hiring' });
    const n = (await env.svc.triage(owner, ws, { items: [b.id], to: 'note' }, mutation())).data
      .items[0]!;
    expect(n).toMatchObject({ outcome: 'applied', to: 'note' });
    const c = await cap({ text: 'junk' });
    await env.svc.triage(owner, ws, { items: [c.id], to: 'discard' }, mutation());
    expect((await item(c.id)).triage_state).toBe('discarded');
    expect((await item(c.id)).raw_text).toBe('junk');
    await env.svc.restoreInboxItem(owner, ws, c.id, mutation());
    expect((await item(c.id)).triage_state).toBe('untriaged');
    // Already triaged items are refused per item, never silently skipped.
    const again = (
      await env.svc.triage(owner, ws, { items: [a.id, c.id], to: 'discard' }, mutation())
    ).data.items;
    expect(again.map((x) => x.outcome)).toEqual(['invalid', 'applied']);
  });

  it('merge: preview names the kept item; merged items keep their text and history and can be restored', async () => {
    const x = await cap({ text: 'Renew domain' });
    const y = await cap({ text: 'renew the domain!' });
    const pv = await env.svc.previewMerge(owner, ws, { items: [x.id, y.id], keep: x.id });
    expect(pv.items.map((i) => [i.id, i.role])).toEqual([
      [x.id, 'kept'],
      [y.id, 'merged'],
    ]);
    const kept = (await env.svc.merge(owner, ws, { items: [x.id, y.id], keep: x.id }, mutation()))
      .data;
    expect(kept.merged_from).toEqual([
      expect.objectContaining({ id: y.id, raw_text: 'renew the domain!' }),
    ]);
    expect(await item(y.id)).toMatchObject({
      triage_state: 'merged',
      merged_into: x.id,
      raw_text: 'renew the domain!',
    });
    expect((await env.svc.listInbox(owner, ws, {})).data.map((i) => i.id)).not.toContain(y.id);
    await expect(env.svc.merge(owner, ws, { items: [x.id, y.id] }, mutation())).rejects.toEqual(
      reason('conflict'),
    );
    await env.svc.restoreInboxItem(owner, ws, y.id, mutation());
    expect((await item(y.id)).triage_state).toBe('untriaged');
  });

  it('attachments: links attach and travel to the task; files are refused clearly without losing the capture', async () => {
    const r = await cap({
      text: 'Read the spec',
      links: [{ url: 'https://example.com/spec', title: 'Spec' }],
      files: [{ name: 'brief.pdf', size: 1000, type: 'application/pdf' }],
    });
    expect(r.attachments).toEqual([
      { name: 'brief.pdf', outcome: 'refused', code: 'storage_unavailable' },
    ]);
    expect((await item(r.id)).links).toEqual([
      expect.objectContaining({ url: 'https://example.com/spec' }),
    ]);
    await expect(
      cap({ text: 'bad link', links: [{ url: 'javascript:alert(1)' }] }),
    ).rejects.toEqual(issueOf('invalid_url'));
    const t = (
      await env.svc.triage(
        owner,
        ws,
        { items: [r.id], to: 'task', brand: brands.Harbor },
        mutation(),
      )
    ).data.items[0]!;
    const d = await env.svc.taskDetail(owner, ws, t.record as string);
    expect(d.links).toEqual([expect.objectContaining({ url: 'https://example.com/spec' })]);
  });

  it('intake forms: members of the brand submit into the queue owner’s Inbox; guests and non-readers cannot; rate-limited', async () => {
    const form = (
      await env.svc.createForm(
        owner,
        ws,
        { brand: brands.Harbor, name: 'Design requests', target_kind: 'project' },
        mutation(),
      )
    ).data;
    const member = await join(env, db, owner, ws, { kind: 'member', role: 'member' });
    const wsId = await workspaceIdOf(db, ws);
    const mm = (await membershipOf(db, wsId, member.auth.account.id))!;
    const { apply } = await import('./fixture.ts');
    await apply(env, owner, ws, {
      kind: 'brand_grant',
      brand: brands.Harbor,
      principal: mm.public_id,
      level: 'view',
    });
    expect((await env.svc.listForms(member, ws, {})).map((f) => f.id)).toEqual([form.id]);
    const got = await env.svc.getForm(member, ws, form.id);
    expect(got).not.toHaveProperty('queue_owner');
    const s = (
      await env.svc.submitForm(
        member,
        ws,
        form.id,
        { title: 'New landing page', details: 'For the spring launch' },
        mutation(),
      )
    ).data;
    expect(s).toEqual({ id: form.id, type: 'intake_form', received: true });
    // The submission is in the queue owner's Inbox with the form's brand and source; not the submitter's.
    const inbox = (await env.svc.listInbox(owner, ws, {})).data;
    const sub = inbox.find((x) => x.raw_text === 'New landing page\nFor the spring launch')!;
    expect(sub).toMatchObject({ source: { kind: 'form' }, brand: brands.Harbor });
    expect((await env.svc.listInbox(member, ws, {})).data).toEqual([]);
    const triaged = (
      await env.svc.triage(owner, ws, { items: [sub.id], to: 'project' }, mutation())
    ).data.items[0]!;
    expect(triaged).toMatchObject({ outcome: 'applied', to: 'project' });
    // A member who cannot read Summit cannot see or submit its forms.
    const other = (
      await env.svc.createForm(owner, ws, { brand: brands.Summit, name: 'Summit asks' }, mutation())
    ).data;
    await expect(
      env.svc.submitForm(member, ws, other.id, { title: 'x' }, mutation()),
    ).rejects.toEqual(reason('not_found'));
    const shared = (
      await env.svc.createTask(
        owner,
        ws,
        { brand: brands.Harbor, title: 'Shared with guest' },
        mutation(),
      )
    ).data;
    const guest = await join(env, db, owner, ws, {
      kind: 'guest',
      records: [{ record: shared.id, level: 'comment' }],
    });
    await expect(
      env.svc.submitForm(guest, ws, form.id, { title: 'x' }, mutation()),
    ).rejects.toEqual(reason('not_found'));
    expect(await env.svc.listForms(guest, ws, {})).toEqual([]);
    // Rate limit per person and form.
    const slow = workEnv(db, { intakeRate: 1 });
    try {
      await slow.svc.submitForm(member, ws, form.id, { title: 'one' }, mutation());
      await expect(
        slow.svc.submitForm(member, ws, form.id, { title: 'two' }, mutation()),
      ).rejects.toEqual(reason('rate_limited'));
    } finally {
      await slow.h.close();
    }
    // Managers configure; members cannot.
    await expect(
      env.svc.createForm(member, ws, { brand: brands.Harbor, name: 'Nope' }, mutation()),
    ).rejects.toEqual(
      expect.objectContaining({ code: expect.stringMatching(/forbidden|not_found/) }),
    );
    const archived = (
      await env.svc.updateForm(
        owner,
        ws,
        form.id,
        { state: 'archived', version: form.version },
        mutation(),
      )
    ).data;
    expect(archived.state).toBe('archived');
    await expect(
      env.svc.submitForm(member, ws, form.id, { title: 'late' }, mutation()),
    ).rejects.toEqual(reason('not_found'));
  });

  it('capture is rate-limited per person; the lifecycle registry knows every capture record type', async () => {
    const slow = workEnv(db, { captureRate: 1 });
    try {
      await slow.svc.capture(owner, ws, { text: 'first' }, mutation());
      await expect(slow.svc.capture(owner, ws, { text: 'second' }, mutation())).rejects.toEqual(
        reason('rate_limited'),
      );
    } finally {
      await slow.h.close();
    }
    const reg = productLifecycleRegistry();
    for (const t of ['inbox_item', 'note', 'intake_form'])
      expect(reg.get(t)?.purge, t).toBeDefined();
  });
});
