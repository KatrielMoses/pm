import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import {
  startAiProviderFixture,
  syntheticOgg,
  syntheticWav,
  syntheticWebm,
  type AiProviderFixture,
} from '@pm/test-support';
import type { Caller } from '@pm/tenancy';
import type { WorkerRuntime } from '@pm/platform';
import type { LocalObjectStorage } from '@pm/work';
import { aiWorker, drain, enableAi, fixtureAi } from './ai-support.ts';
import {
  apply,
  join,
  membershipOf,
  mutation,
  workEnv,
  workspaceIdOf,
  workspaceWith,
  type WorkEnv,
} from './fixture.ts';

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; issues?: Array<{ code: string; pointer?: string }> };
    return { code: err.code, issues: err.issues ?? [] };
  }
  throw new Error('expected a refusal');
};
const codes = (r: { issues: Array<{ code: string }> }) => r.issues.map((i) => i.code);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/**
 * Phase 7F voice capture (ADR-0043 D3; CAP-005; AT-501–AT-510) through the real upload and
 * transcription path: a bound upload to object storage, validation from the stored bytes, one
 * gateway transcription run against the deterministic fixture (synthetic transcripts embedded in
 * synthetic audio; never speech recognition), the transcript in the protected output boundary,
 * the audio discarded, and an explicit save to the Inbox with `voice` provenance.
 */
describe('Phase 7F voice capture', () => {
  let db: TestDatabase;
  let fx: AiProviderFixture;
  let env: WorkEnv;
  let off: WorkEnv;
  let worker: WorkerRuntime;
  let ws: string;
  let wsId: string;
  const P = {} as Record<'owner' | 'member' | 'leaver', Caller>;
  let harbor: string;
  const sql = async (text: string, params: unknown[] = []) => (await db.admin(text, params)).rows;
  const storage = () => env.files.storage as LocalObjectStorage;
  const keyOf = async (vcp: string) =>
    (await sql(`SELECT storage_key FROM capture.voice_capture WHERE public_id = $1`, [vcp]))[0]!
      .storage_key as string | null;

  /** Create → upload the bytes → (optionally) transcribe, as the capture dialog does. */
  const record = async (
    who: Caller,
    bytes: Uint8Array,
    format = 'audio/wav',
    durationMs = 3000,
    space = ws,
  ) => {
    const created = (
      await env.svc.createVoiceCapture(
        who,
        space,
        { format, byte_size: bytes.byteLength, sha256: sha(bytes), duration_ms: durationMs },
        mutation(),
      )
    ).data;
    await storage().writeObject((await keyOf(created.id))!, bytes, format);
    return created;
  };
  const transcribe = async (who: Caller, vcp: string) => {
    const v = (await env.svc.transcribeVoiceCapture(who, ws, vcp, mutation())).data;
    if (v.run) await drain(db, worker, v.run);
    return env.svc.getVoiceCapture(who, ws, vcp);
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    fx = await startAiProviderFixture();
    env = workEnv(db, { ai: fixtureAi(fx) });
    worker = await aiWorker(env);
    const w = await workspaceWith(env, db, ['Harbor']);
    P.owner = w.owner;
    ws = w.ws;
    harbor = w.brands.Harbor!;
    wsId = await workspaceIdOf(db, ws);
    P.member = await join(env, db, P.owner, ws, { kind: 'member', role: 'member' });
    P.leaver = await join(env, db, P.owner, ws, { kind: 'member', role: 'member' });
    for (const who of [P.member, P.leaver])
      await apply(env, P.owner, ws, {
        kind: 'brand_grant',
        brand: harbor,
        principal: (await membershipOf(db, wsId, who.auth.account.id))!.public_id,
        level: 'edit',
      });
    await enableAi(env, P.owner, ws);
    // The same database without a transcription transport (unconfigured, as in production).
    off = workEnv(db, { ai: fixtureAi(fx, { transcription: { provider: 'none' } }) });
  });
  afterAll(async () => {
    await worker.stop();
    await env.h.close();
    await off.h.close();
    await fx.close();
    await db.drop();
  });

  it('AT-501 unconfigured transcription is truthful and refuses before anything is stored', async () => {
    expect(await off.svc.voiceSettings(P.member, ws)).toMatchObject({
      transcription: 'not_configured',
      synthetic: false,
    });
    const bytes = syntheticWav(2, { transcript: 'Hello' });
    expect(
      codes(
        await refusal(
          off.svc.createVoiceCapture(
            P.member,
            ws,
            { format: 'audio/wav', byte_size: bytes.byteLength, sha256: sha(bytes), duration_ms: 2000 },
            mutation(),
          ),
        ),
      ),
    ).toContain('transcription_unavailable');
    expect(await sql(`SELECT count(*)::int AS n FROM capture.voice_capture`)).toEqual([{ n: 0 }]);
    expect(await env.svc.voiceSettings(P.member, ws)).toMatchObject({
      transcription: 'available',
      synthetic: true,
      max_seconds: 120,
      max_bytes: 10 * 1024 * 1024,
    });
  });

  it('AT-502 record → transcribe → editable transcript → explicit save with voice provenance; the audio is discarded', async () => {
    const bytes = syntheticWav(4, { transcript: 'Call the venue about Friday', confidence: 0.91 });
    const created = await record(P.member, bytes);
    expect(created).toMatchObject({ state: 'uploaded', audio: 'held', transcript: null });
    expect(created.upload).toMatchObject({ method: 'PUT' });
    const key = (await keyOf(created.id))!;
    const v = await transcribe(P.member, created.id);
    expect(v).toMatchObject({
      state: 'transcribed',
      audio: 'discarded',
      duration_ms: 4000,
      transcript: {
        state: 'present',
        text: 'Call the venue about Friday',
        confidence: 0.91,
        low_confidence: false,
        synthetic: true,
      },
    });
    expect(v.transcript!.note).toMatch(/Synthetic transcript/);
    // The object is gone; the row keeps no key; job state never held audio or transcript.
    expect(await storage().head(key)).toBeNull();
    expect(await keyOf(created.id)).toBeNull();
    const jobs = await sql(
      `SELECT coalesce(checkpoint::text, '') || coalesce(payload_ref, '') AS t FROM exec.job WHERE kind = 'ai.transcription'`,
    );
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) expect(j.t).not.toMatch(/venue|PMFX|RIFF/);
    // Usage is settled by the measured seconds, never more than reserved.
    const d = await sql(
      `SELECT d.state, d.input_tokens, d.settled_micros, d.reserved_micros FROM ai.ai_dispatch d
         JOIN exec.operation o ON o.id = d.operation_id WHERE o.public_id = $1`,
      [v.run],
    );
    expect(d[0]).toMatchObject({ state: 'succeeded', input_tokens: 4 });
    expect(Number(d[0]!.settled_micros)).toBeLessThan(Number(d[0]!.reserved_micros));
    // Nothing is saved until the person saves; they may edit the transcript first.
    expect(await sql(`SELECT count(*)::int AS n FROM capture.inbox_item`)).toEqual([{ n: 0 }]);
    const saved = (
      await env.svc.capture(
        P.member,
        ws,
        { text: 'Call the venue about Friday lunch', brand: harbor, voice: created.id },
        mutation(),
      )
    ).data;
    const item = await env.svc.getInboxItem(P.member, ws, saved.id);
    expect(item).toMatchObject({
      raw_text: 'Call the venue about Friday lunch',
      source: { kind: 'voice', ref: created.id },
    });
    expect((await env.svc.getVoiceCapture(P.member, ws, created.id))).toMatchObject({
      state: 'saved',
      saved_to: saved.id,
    });
    expect(
      codes(
        await refusal(
          env.svc.capture(P.member, ws, { text: 'again', voice: created.id }, mutation()),
        ),
      ),
    ).toContain('voice_already_saved');
    const t = (await env.svc.triage(P.member, ws, { items: [saved.id], to: 'task' }, mutation()))
      .data.items[0]!;
    expect(
      await sql(`SELECT source_kind FROM core.record WHERE public_id = $1`, [t.record]),
    ).toEqual([{ source_kind: 'voice' }]);
  });

  it('AT-503 bounds and containers are checked from the bytes, never a name or claim', async () => {
    const c = (body: Record<string, unknown>) =>
      refusal(env.svc.createVoiceCapture(P.member, ws, body, mutation()));
    const good = { format: 'audio/wav', byte_size: 1000, sha256: 'a'.repeat(64), duration_ms: 1000 };
    expect(codes(await c({ ...good, format: 'audio/mpeg' }))).toContain('unsupported_format');
    expect(codes(await c({ ...good, byte_size: 11 * 1024 * 1024 }))).toContain('too_large');
    expect(codes(await c({ ...good, duration_ms: 121_000 }))).toContain('too_long');
    expect(codes(await c({ ...good, url: 'https://example.invalid/a.wav' }))).toContain('unknown_field');
    // Not audio, though declared as WAV.
    const fake = new TextEncoder().encode('RIFF....not really a wave file at all, sorry.....');
    let v = await transcribe(P.member, (await record(P.member, fake)).id);
    expect(v).toMatchObject({ state: 'failed', failure: { code: 'unsupported_format' }, audio: 'discarded' });
    // Longer than allowed, measured from the container.
    v = await transcribe(P.member, (await record(P.member, syntheticWav(125, { transcript: 'x' }))).id);
    expect(v).toMatchObject({ state: 'failed', failure: { code: 'too_long' } });
    // Bytes that do not match the declared checksum.
    const bytes = syntheticWav(1, { transcript: 'x' });
    const created = (
      await env.svc.createVoiceCapture(
        P.member,
        ws,
        { format: 'audio/wav', byte_size: bytes.byteLength, sha256: 'b'.repeat(64), duration_ms: 1000 },
        mutation(),
      )
    ).data;
    await storage().writeObject((await keyOf(created.id))!, bytes, 'audio/wav');
    v = await transcribe(P.member, created.id);
    expect(v).toMatchObject({ state: 'failed', failure: { code: 'upload_mismatch' } });
    // Ogg Opus and WebM (with or without a container duration) are accepted.
    for (const [bytes, format] of [
      [syntheticOgg(2, { transcript: 'Ogg note' }), 'audio/ogg'],
      [syntheticWebm(1500, { transcript: 'WebM note' }), 'audio/webm'],
      [syntheticWebm(null, { transcript: 'Recorder note' }), 'audio/webm'],
    ] as const) {
      const r = await transcribe(P.member, (await record(P.member, bytes, format, 2000)).id);
      expect(r.state, format).toBe('transcribed');
    }
  });

  it('AT-504 silence and low confidence are truthful; a transcript never fetches its links', async () => {
    let v = await transcribe(P.member, (await record(P.member, syntheticWav(2, null))).id);
    expect(v).toMatchObject({ state: 'failed', failure: { code: 'empty_transcript' } });
    v = await transcribe(
      P.member,
      (await record(P.member, syntheticWav(2, { transcript: 'maybe groceries', confidence: 0.3 }))).id,
    );
    expect(v.transcript).toMatchObject({ low_confidence: true });
    const before = fx.control.received().length;
    v = await transcribe(
      P.member,
      (await record(P.member, syntheticWav(2, { transcript: 'Read https://example.invalid/x now' }))).id,
    );
    expect(v.transcript).toMatchObject({ text: 'Read https://example.invalid/x now' });
    // Exactly one provider request (the transcription); nothing else was contacted.
    expect(fx.control.received().length).toBe(before + 1);
  });

  it('AT-505 cancel discards the audio; a cancelled transcription publishes nothing', async () => {
    const a = await record(P.member, syntheticWav(1, { transcript: 'cancel me' }));
    const key = (await keyOf(a.id))!;
    const c = (await env.svc.cancelVoiceCapture(P.member, ws, a.id, mutation())).data;
    expect(c).toMatchObject({ state: 'cancelled', audio: 'discarded' });
    expect(await storage().head(key)).toBeNull();
    const b = await record(P.member, syntheticWav(1, { transcript: 'too late' }));
    const queued = (await env.svc.transcribeVoiceCapture(P.member, ws, b.id, mutation())).data;
    await env.svc.cancelVoiceCapture(P.member, ws, b.id, mutation());
    await drain(db, worker, queued.run!);
    const after = await env.svc.getVoiceCapture(P.member, ws, b.id);
    expect(after).toMatchObject({ state: 'cancelled', transcript: null, audio: 'discarded' });
    expect(
      codes(await refusal(env.svc.cancelVoiceCapture(P.member, ws, b.id, mutation()))),
    ).toContain('voice_closed');
  });

  it('AT-506 open recordings per person are bounded', async () => {
    await sql(`UPDATE capture.voice_capture SET state = 'cancelled', storage_key = NULL WHERE state IN ('uploaded', 'transcribing')`);
    for (let i = 0; i < 3; i++) await record(P.owner, syntheticWav(1, { transcript: `n${i}` }));
    expect(codes(await refusal(record(P.owner, syntheticWav(1, { transcript: 'n4' }))))).toContain(
      'too_many',
    );
  });

  it('AT-507 recordings are personal: another person and another workspace see nothing', async () => {
    const mine = await record(P.member, syntheticWav(1, { transcript: 'private' }));
    expect(await refusal(env.svc.getVoiceCapture(P.owner, ws, mine.id))).toMatchObject({
      code: 'not_found',
    });
    expect(
      await refusal(env.svc.transcribeVoiceCapture(P.owner, ws, mine.id, mutation())),
    ).toMatchObject({ code: 'not_found' });
    const other = await workspaceWith(env, db, ['Elsewhere']);
    expect(await refusal(env.svc.getVoiceCapture(other.owner, other.ws, mine.id))).toMatchObject({
      code: 'not_found',
    });
  });

  it('AT-508 departure ends open recordings and erases transcripts; the sweep deletes leftover audio', async () => {
    const done = await transcribe(
      P.leaver,
      (await record(P.leaver, syntheticWav(1, { transcript: 'leaver note' }))).id,
    );
    const open = await record(P.leaver, syntheticWav(1, { transcript: 'unsent' }));
    const key = (await keyOf(open.id))!;
    const leaverId = (await membershipOf(db, wsId, P.leaver.auth.account.id))!.id;
    await env.h.app.withWorkspace(wsId, { module: 'test' }, (tx) =>
      env.svc.eraseAiContent(tx, { membershipId: leaverId }),
    );
    expect(
      await sql(`SELECT state FROM capture.voice_capture WHERE public_id = $1`, [open.id]),
    ).toEqual([{ state: 'cancelled' }]);
    const found = await env.h.discovery.discoverVoiceCleanupWork(new Date(), 10);
    expect(found).toContain(wsId);
    await env.svc.runVoiceCleanup(env.h.worker, wsId, new Date());
    expect(await storage().head(key)).toBeNull();
    expect(await keyOf(open.id)).toBeNull();
    const out = await sql(
      `SELECT o.content FROM ai.ai_output o JOIN exec.operation e ON e.id = o.operation_id WHERE e.public_id = $1`,
      [done.run],
    );
    expect(out.every((r) => r.content === null)).toBe(true);
  });

  it('AT-509 an abandoned upload expires and its audio is swept', async () => {
    await sql(`UPDATE capture.voice_capture SET state = 'cancelled', storage_key = NULL WHERE state IN ('uploaded', 'transcribing')`);
    const v = await record(P.owner, syntheticWav(1, { transcript: 'abandoned' }));
    const key = (await keyOf(v.id))!;
    await sql(`UPDATE capture.voice_capture SET expires_at = now() - interval '1 minute' WHERE public_id = $1`, [v.id]);
    await env.svc.runVoiceCleanup(env.h.worker, wsId, new Date());
    expect(await sql(`SELECT state, storage_key FROM capture.voice_capture WHERE public_id = $1`, [v.id])).toEqual([
      { state: 'expired', storage_key: null },
    ]);
    expect(await storage().head(key)).toBeNull();
  });
});
