import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@pm/test-support/vitest';
import { startAiProviderFixture, syntheticWav, type AiProviderFixture } from '@pm/test-support';
import type { Caller } from '@pm/tenancy';
import type { WorkerRuntime } from '@pm/platform';
import type { LocalObjectStorage } from '@pm/work';
import { aiWorker, drain, enableAi, fixtureAi } from './ai-support.ts';
import { mutation, workEnv, workspaceIdOf, workspaceWith, type WorkEnv } from './fixture.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const codes = (e: unknown) =>
  ((e as { issues?: Array<{ code: string }> }).issues ?? []).map((i) => i.code);

/**
 * Phase 7F corrective review 01 R2 (AT-521–AT-523) through the real upload and transcription path
 * against the deterministic fixture: an over-long transcript is refused (never clipped and called
 * complete) with its measured liability settled; an oversized or malformed answer keeps the
 * charge unknown for review. In every case nothing is stored as a transcript, the recording
 * cannot be saved or interpreted, and the audio is deleted.
 */
describe('Phase 7F review 01: honest transcription completeness', () => {
  let db: TestDatabase;
  let fx: AiProviderFixture;
  let env: WorkEnv;
  let worker: WorkerRuntime;
  let ws: string;
  let wsId: string;
  let owner: Caller;
  let brand: string;
  const sql = async (text: string, params: unknown[] = []) => (await db.admin(text, params)).rows;
  const storage = () => env.files.storage as LocalObjectStorage;

  const transcribe = async (bytes: Uint8Array) => {
    const created = (
      await env.svc.createVoiceCapture(
        owner,
        ws,
        { format: 'audio/wav', byte_size: bytes.byteLength, sha256: sha(bytes), duration_ms: 2000 },
        mutation(),
      )
    ).data;
    const key = (
      await sql(`SELECT storage_key FROM capture.voice_capture WHERE public_id = $1`, [created.id])
    )[0]!.storage_key as string;
    await storage().writeObject(key, bytes, { contentType: 'audio/wav' });
    const queued = (await env.svc.transcribeVoiceCapture(owner, ws, created.id, mutation())).data;
    await drain(db, worker, queued.run!);
    return { v: await env.svc.getVoiceCapture(owner, ws, created.id), key, run: queued.run! };
  };
  const dispatch = async (run: string) =>
    (
      await sql(
        `SELECT d.state, d.settled_micros, d.usage_basis, d.input_tokens FROM ai.ai_dispatch d
           JOIN exec.operation o ON o.id = d.operation_id WHERE o.public_id = $1`,
        [run],
      )
    )[0]!;
  const outputs = async (run: string) =>
    (
      await sql(
        `SELECT count(*)::int AS n FROM ai.ai_output a JOIN exec.operation o ON o.id = a.operation_id WHERE o.public_id = $1`,
        [run],
      )
    )[0]!.n as number;
  const cannotSave = async (vcp: string) =>
    codes(
      await env.svc.capture(owner, ws, { text: 'anything', brand, voice: vcp }, mutation()).then(
        () => null,
        (e: unknown) => e,
      ),
    );

  beforeAll(async () => {
    db = await createTestDatabase();
    fx = await startAiProviderFixture();
    env = workEnv(db, { ai: fixtureAi(fx) });
    worker = await aiWorker(env);
    const w = await workspaceWith(env, db, ['Harbor']);
    owner = w.owner;
    ws = w.ws;
    brand = w.brands.Harbor!;
    wsId = await workspaceIdOf(db, ws);
    await enableAi(env, owner, ws);
  });
  afterAll(async () => {
    await worker.stop();
    await env.h.close();
    await fx.close();
    await db.drop();
  });

  it('AT-521 an over-long transcript is refused, not clipped: nothing stored, measured charge settled, audio deleted', async () => {
    const long = 'eightwords '.repeat(400) + 'and then a final instruction';
    const { v, key, run } = await transcribe(syntheticWav(2, { transcript: long }));
    expect(v).toMatchObject({
      state: 'failed',
      transcript: null,
      audio: 'discarded',
      failure: { code: 'transcript_too_long' },
    });
    expect(v.failure!.message).toMatch(/longer than allowed, so it was not kept/);
    expect(await outputs(run)).toBe(0);
    expect(await dispatch(run)).toMatchObject({
      state: 'failed',
      usage_basis: 'measured',
      input_tokens: 2,
    });
    expect(Number((await dispatch(run)).settled_micros)).toBeGreaterThan(0);
    expect(await storage().head(key)).toBeNull();
    expect(await cannotSave(v.id)).toContain('voice_not_transcribed');
    // No clipped text reached job state either.
    const jobs = await sql(
      `SELECT coalesce(checkpoint::text, '') || coalesce(payload_ref, '') AS t FROM exec.job WHERE kind = 'ai.transcription' AND workspace_id = $1`,
      [wsId],
    );
    for (const j of jobs) expect(j.t).not.toMatch(/eightwords/);
  });

  it('AT-522 an oversized streamed answer is cut off, kept unknown for review, and leaves nothing behind', async () => {
    const { v, key, run } = await transcribe(
      syntheticWav(2, { transcript: 'ignored', scenario: 'oversize' }),
    );
    expect(v).toMatchObject({
      state: 'failed',
      transcript: null,
      audio: 'discarded',
      failure: { code: 'response_too_large' },
    });
    expect(await outputs(run)).toBe(0);
    // Possibly charged: the reservation is held as unknown, never settled at zero.
    expect(await dispatch(run)).toMatchObject({
      state: 'unknown',
      settled_micros: null,
      usage_basis: null,
    });
    expect(
      await sql(
        `SELECT r.state FROM metering.usage_reservation r JOIN exec.operation o ON o.id = r.operation_id WHERE o.public_id = $1 AND r.meter = 'ai.cost'`,
        [run],
      ),
    ).toEqual([{ state: 'unknown' }]);
    expect(await storage().head(key)).toBeNull();
    expect(await cannotSave(v.id)).toContain('voice_not_transcribed');
  });

  it('AT-523 an unsafe duration is malformed: no arithmetic on it, charge kept unknown, nothing stored', async () => {
    const { v, run } = await transcribe(
      syntheticWav(2, { transcript: 'fine words', scenario: 'bad_duration' }),
    );
    expect(v).toMatchObject({
      state: 'failed',
      transcript: null,
      failure: { code: 'malformed_response' },
    });
    expect(await outputs(run)).toBe(0);
    expect(await dispatch(run)).toMatchObject({
      state: 'unknown',
      settled_micros: null,
      input_tokens: null,
    });
  });
});
