import { useEffect, useRef, useState } from 'react';
import { newIdempotencyKey } from '../api.ts';
import { aiClient, aiProblem, TERMINAL, type AiEstimate, type AiOverview } from '../ai/client.ts';
import { putBytes } from '../files/client.ts';
import { discardDraft, loadDraft, saveDraft } from '../shell/drafts.ts';
import { Banner } from '../ui/feedback.tsx';
import {
  capture,
  type CaptureInterpretation,
  type VoiceCapture,
  type VoiceSettings,
} from './client.ts';

/**
 * Phase 7F capture assistance (ADR-0043 D2, D3; CAP-005). Two optional helpers inside the Capture
 * dialog, both explicit: interpretation (the registered `interpret_capture.v1` action, estimated
 * and confirmed like every AI run; the server derives every value from checked spans), and voice
 * (record with a deliberate gesture or upload a file → transcription preview → edit → use as the
 * capture text). Nothing is saved here; the dialog's Save does that. Every unavailable state says
 * so and leaves typing and pasting working.
 */
const POLL_MS = 500;
const DRAFT_TTL_MS = 24 * 3_600_000;
const draftId = (ws: string) => `ai-capture.${ws.toLowerCase()}`;
const FORMAT: Record<string, string> = {
  'audio/wav': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/webm': 'audio/webm',
  'audio/ogg': 'audio/ogg',
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The audio length the browser can read (the server verifies it from the container). */
function audioDuration(blob: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const a = document.createElement('audio');
      const url = URL.createObjectURL(blob);
      const done = (v: number | null) => {
        URL.revokeObjectURL(url);
        resolve(v);
      };
      a.preload = 'metadata';
      a.onloadedmetadata = () =>
        done(Number.isFinite(a.duration) && a.duration > 0 ? Math.round(a.duration * 1000) : null);
      a.onerror = () => done(null);
      a.src = url;
      setTimeout(() => done(null), 3000);
    } catch {
      resolve(null);
    }
  });
}

/** Marks the spans the interpretation used inside the person's own text (evidence). */
function Evidence({ text, spans }: { text: string; spans: Array<{ start: number; end: number }> }) {
  const parts: Array<{ t: string; mark: boolean }> = [];
  let at = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.start < at || s.end > text.length) continue;
    if (s.start > at) parts.push({ t: text.slice(at, s.start), mark: false });
    parts.push({ t: text.slice(s.start, s.end), mark: true });
    at = s.end;
  }
  if (at < text.length) parts.push({ t: text.slice(at), mark: false });
  return (
    <p className="capture-evidence">
      {parts.map((p, i) => (p.mark ? <mark key={i}>{p.t}</mark> : <span key={i}>{p.t}</span>))}
    </p>
  );
}

export function CaptureAssist({
  ws,
  account,
  text,
  brand,
  interpretation,
  onText,
  onInterpretation,
  onVoice,
}: {
  ws: string;
  account: string | null;
  text: string;
  brand: string | null;
  interpretation: string | null;
  onText: (t: string) => void;
  onInterpretation: (run: string | null) => void;
  onVoice: (voice: string | null) => void;
}) {
  const [ai, setAi] = useState<AiOverview | null>(null);
  const [voiceCfg, setVoiceCfg] = useState<VoiceSettings | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [error, setError] = useState('');
  // Interpretation.
  const [estimate, setEstimate] = useState<
    (AiEstimate & { input_digest: string; body: Record<string, unknown> }) | null
  >(null);
  const [interpreting, setInterpreting] = useState<string | null>(null);
  const [result, setResult] = useState<CaptureInterpretation | null>(null);
  const [resultText, setResultText] = useState('');
  // Voice.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [voice, setVoice] = useState<VoiceCapture | null>(null);
  const [voiceStage, setVoiceStage] = useState<'idle' | 'uploading' | 'transcribing'>('idle');
  const [transcript, setTranscript] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const discardRecording = useRef(false);
  const stream = useRef<MediaStream | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    aiClient.overview(ws).then(setAi, () => setAi(null));
    capture.voiceSettings(ws).then(
      (v) => {
        setVoiceCfg(v);
        // Restored only after the server answered for this workspace, and only while fresh.
        const d = account ? loadDraft(account, draftId(ws)) : null;
        if (d && Date.now() - Date.parse(d.savedAt) <= DRAFT_TTL_MS) {
          try {
            const o = JSON.parse(d.value) as { voice?: string; transcript?: string };
            if (typeof o.voice === 'string' && /^vcp_[0-9A-Z]{26}$/.test(o.voice))
              void capture.voice(ws, o.voice).then(
                (vc) => {
                  if (!alive.current || vc.state !== 'transcribed') return;
                  setVoice(vc);
                  setTranscript(
                    typeof o.transcript === 'string' ? o.transcript : (vc.transcript?.text ?? ''),
                  );
                },
                () => account && discardDraft(account, draftId(ws)),
              );
          } catch {
            if (account) discardDraft(account, draftId(ws));
          }
        } else if (d && account) discardDraft(account, draftId(ws));
      },
      () => setVoiceCfg(null),
    );
    return () => {
      alive.current = false;
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      // Never leave the microphone on.
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, [ws, account]);

  // The edited transcript survives a refresh (personal draft; removed on use or sign-out).
  useEffect(() => {
    if (!account || !voice || voice.state !== 'transcribed') return;
    saveDraft(account, draftId(ws), JSON.stringify({ voice: voice.id, transcript }));
  }, [account, ws, voice, transcript]);

  // An interpretation belongs to the exact text it read: once the text changes it is not shown
  // (the dialog also releases it from the save).
  const shown = result && text === resultText ? result : null;

  const aiReady = ai?.availability === 'ready' && ai.can_execute;

  // ----- Interpretation -----
  const askEstimate = async () => {
    setError('');
    setResult(null);
    onInterpretation(null);
    try {
      const m = await aiClient.preview(ws, { scope: {}, include: [] });
      const body = {
        action: 'interpret_capture.v1',
        scope: {},
        include: [],
        instruction: text.trim(),
        manifest_digest: m.digest,
        confirm_cost: true,
      };
      const est = await aiClient.estimateAssist(ws, body);
      setEstimate({ ...est, body });
    } catch (err) {
      setError(aiProblem(err, 'The interpretation could not be estimated.'));
    }
  };
  const interpret = async () => {
    if (!estimate) return;
    const asked = text.trim();
    setError('');
    try {
      const run = await aiClient.startAssist(
        ws,
        { ...estimate.body, input_digest: estimate.input_digest },
        newIdempotencyKey(),
      );
      setEstimate(null);
      setInterpreting(run.id);
      let r = run;
      while (alive.current && !TERMINAL.has(r.state)) {
        await sleep(POLL_MS);
        r = await aiClient.run(ws, run.id);
      }
      if (!alive.current) return;
      setInterpreting(null);
      const i = r.content?.interpretation;
      if (!i || (i.status !== 'checked' && i.status !== 'downgraded')) {
        setError(
          i?.status === 'needs_input'
            ? `More detail is needed: ${i.questions.map((q) => q.text).join(' ')} Add it to the text and interpret again, or save as typed.`
            : (r.refusal?.message ??
                'The interpretation could not be used. You can still save the text as typed.'),
        );
        return;
      }
      const v = await capture.interpret(ws, {
        text: asked,
        interpretation: run.id,
        ...(brand ? { brand } : {}),
      });
      if (!alive.current) return;
      setResult(v);
      setResultText(text);
    } catch (err) {
      setInterpreting(null);
      setError(
        aiProblem(err, 'The interpretation did not complete. You can save the text as typed.'),
      );
    }
  };

  // ----- Voice -----
  const transcribe = async (blob: Blob, format: string, durationMs: number) => {
    setError('');
    setVoice(null);
    setTranscript('');
    onVoice(null);
    setVoiceStage('uploading');
    try {
      const created = await capture.createVoice(ws, {
        format,
        byte_size: blob.size,
        sha256: await sha256(blob),
        duration_ms: Math.max(1, durationMs),
      });
      setVoice(created);
      await putBytes(created.upload!, blob, () => undefined);
      setVoiceStage('transcribing');
      let v = await capture.voiceAction(ws, created.id, 'transcribe', newIdempotencyKey());
      while (alive.current && (v.state === 'transcribing' || v.state === 'uploaded')) {
        setVoice(v);
        await sleep(POLL_MS);
        v = await capture.voice(ws, created.id);
      }
      if (!alive.current) return;
      setVoice(v);
      setVoiceStage('idle');
      if (v.state === 'transcribed') setTranscript(v.transcript?.text ?? '');
    } catch (err) {
      setVoiceStage('idle');
      setError(aiProblem(err, 'The recording could not be sent. Type or paste your note instead.'));
    }
  };
  const cancelVoice = async () => {
    if (!voice) return;
    try {
      setVoice(await capture.voiceAction(ws, voice.id, 'cancel', newIdempotencyKey()));
    } catch (err) {
      setError(aiProblem(err, 'The recording could not be cancelled.'));
    } finally {
      setVoiceStage('idle');
    }
  };
  const startRecording = async () => {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Recording is not supported in this browser. Upload an audio file or type instead.');
      return;
    }
    let s: MediaStream;
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = (err as { name?: string }).name;
      setError(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Microphone access was denied. Allow it in your browser settings, upload a file, or type instead.'
          : name === 'NotFoundError'
            ? 'No microphone was found. Upload a file or type instead.'
            : 'The microphone could not be started. Upload a file or type instead.',
      );
      return;
    }
    stream.current = s;
    const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    const rec = new MediaRecorder(s, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    const startedAt = Date.now();
    discardRecording.current = false;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      s.getTracks().forEach((t) => t.stop());
      stream.current = null;
      setStartedAt(null);
      if (discardRecording.current || !chunks.length) return;
      const format = FORMAT[(rec.mimeType || 'audio/webm').split(';')[0]!] ?? 'audio/webm';
      void transcribe(new Blob(chunks, { type: format }), format, Date.now() - startedAt);
    };
    recorder.current = rec;
    rec.start(1000);
    setElapsed(0);
    setStartedAt(startedAt);
  };
  const stopRecording = (discard: boolean) => {
    discardRecording.current = discard;
    if (recorder.current?.state === 'recording') recorder.current.stop();
  };
  // Visible elapsed time; recording stops itself at the configured bound.
  const maxMs = (voiceCfg?.max_seconds ?? 0) * 1000;
  useEffect(() => {
    if (startedAt === null) return;
    const t = setInterval(() => {
      const ms = Date.now() - startedAt;
      setElapsed(ms);
      if (maxMs && ms >= maxMs) stopRecording(false);
    }, 250);
    return () => clearInterval(t);
  }, [startedAt, maxMs]);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    const format = FORMAT[file.type] ?? null;
    if (!format || !voiceCfg?.formats.includes(format)) {
      setError(
        `This file type is not supported. Use ${voiceCfg?.formats.join(', ') ?? 'WAV, WebM, or Ogg'} audio.`,
      );
      return;
    }
    if (file.size > (voiceCfg?.max_bytes ?? 0)) {
      setError(
        `This file is too large (at most ${Math.floor((voiceCfg?.max_bytes ?? 0) / 1048576)} MiB).`,
      );
      return;
    }
    const ms = (await audioDuration(file)) ?? 1000;
    await transcribe(file, format, ms);
  };
  const useTranscript = () => {
    if (!voice) return;
    onText(transcript);
    onVoice(voice.id);
    if (account) discardDraft(account, draftId(ws));
  };

  const voiceAvailable = voiceCfg?.transcription === 'available';
  const recording = startedAt !== null;
  const busyVoice = voiceStage !== 'idle' || recording;
  return (
    <section aria-label="Capture assistance" className="capture-assist">
      {!online ? (
        <Banner tone="warning" title="You're offline">
          Interpretation and recording need a connection. You can keep typing; save when you're back
          online.
        </Banner>
      ) : null}
      {error ? (
        <Banner tone="danger" title="Not completed">
          {error}
        </Banner>
      ) : null}
      <fieldset>
        <legend>Interpret with AI (optional)</legend>
        {!aiReady ? (
          <p className="hint">
            {ai?.reason ?? 'AI interpretation is not available.'} Detected values above still come
            from simple rules.
          </p>
        ) : estimate ? (
          <div role="group" aria-label="Confirm the interpretation">
            <p>
              Interpreting this text could cost up to <strong>{estimate.max_cost.display}</strong>
              {estimate.synthetic ? ' (synthetic test model: no money is spent)' : ''}. Only the
              text above is sent.
            </p>
            <button
              type="button"
              className="button button-primary"
              onClick={() => void interpret()}
            >
              Confirm and interpret
            </button>{' '}
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setEstimate(null)}
            >
              Cancel
            </button>
          </div>
        ) : interpreting ? (
          <p role="status" aria-live="polite">
            Interpreting…{' '}
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void aiClient.cancel(ws, interpreting).catch(() => undefined)}
            >
              Cancel interpretation
            </button>
          </p>
        ) : (
          <button
            type="button"
            className="button button-secondary"
            disabled={!online || !text.trim()}
            onClick={() => void askEstimate()}
          >
            Interpret with AI
          </button>
        )}
        {shown ? (
          <div aria-label="Interpretation" role="region" className="capture-interpretation">
            <p className="hint">{shown.trust_note}</p>
            <Evidence text={resultText} spans={shown.candidate.detected} />
            <p>
              Title: <strong>{shown.candidate.title}</strong>
            </p>
            <ul aria-label="Interpreted values">
              {shown.candidate.detected.map((d, i) => (
                <li key={i}>
                  {d.field.replace(/_/g, ' ')} from “{d.text}”:{' '}
                  {d.status === 'resolved'
                    ? (d.label ?? String(d.value))
                    : d.status === 'ambiguous'
                      ? `you'll choose: ${(d.options ?? []).map((o) => o.label).join(' or ')}`
                      : 'not recognised (it stays unset)'}
                  {d.rule.startsWith('ai:') ? <span className="ai-tag"> AI span</span> : null}
                </li>
              ))}
            </ul>
            {shown.dropped ? (
              <p className="hint">
                {shown.dropped} suggested value(s) did not match your words and were dropped.
              </p>
            ) : null}
            <p className="hint">
              Dates use {shown.timezone}; today is {shown.today}.
            </p>
            <label className="ai-confirm">
              <input
                type="checkbox"
                checked={interpretation === shown.candidate.interpretation?.run}
                onChange={(e) =>
                  onInterpretation(
                    e.target.checked ? (shown.candidate.interpretation?.run ?? null) : null,
                  )
                }
              />{' '}
              Save with this interpretation
            </label>
          </div>
        ) : null}
      </fieldset>
      <fieldset>
        <legend>Speak instead (optional)</legend>
        {!voiceCfg || !voiceAvailable ? (
          <p className="hint">
            {voiceCfg?.note ??
              'Voice transcription is not available. You can type or paste your note.'}
          </p>
        ) : (
          <>
            <p className="hint">
              {voiceCfg.note} Up to {voiceCfg.max_seconds} seconds. The audio is deleted after
              transcription.
            </p>
            {recording ? (
              <div role="group" aria-label="Recording">
                <p role="status" aria-live="polite" className="recording-indicator">
                  <span aria-hidden="true">● </span>Recording {clock(elapsed)} of{' '}
                  {clock(voiceCfg.max_seconds * 1000)}
                </p>
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => stopRecording(false)}
                >
                  Stop and transcribe
                </button>{' '}
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => stopRecording(true)}
                >
                  Cancel recording
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={!online || busyVoice}
                  onClick={() => void startRecording()}
                >
                  Record a note
                </button>{' '}
                <label className="button button-secondary file-choice">
                  Upload audio
                  <input
                    type="file"
                    className="visually-hidden"
                    accept={voiceCfg.formats.join(',')}
                    disabled={!online || busyVoice}
                    onChange={(e) => {
                      void upload(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </label>
              </>
            )}
            {voiceStage !== 'idle' ? (
              <p role="status" aria-live="polite">
                {voiceStage === 'uploading' ? 'Uploading the recording…' : 'Transcribing…'}{' '}
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => void cancelVoice()}
                >
                  Cancel
                </button>
              </p>
            ) : null}
            {voice?.state === 'failed' || voice?.state === 'expired' ? (
              <p className="field-error" role="alert">
                {voice.failure?.message ?? 'This recording could not be transcribed.'}
              </p>
            ) : null}
            {voice?.state === 'cancelled' ? (
              <p className="hint">Recording cancelled and deleted.</p>
            ) : null}
            {voice?.state === 'transcribed' ? (
              <div role="region" aria-label="Transcript">
                {voice.transcript?.note ? <p className="hint">{voice.transcript.note}</p> : null}
                {voice.transcript?.low_confidence ? (
                  <p className="hint">The transcription is uncertain: check it carefully.</p>
                ) : null}
                <label htmlFor="capture-transcript">Transcript (edit before using)</label>
                <textarea
                  id="capture-transcript"
                  rows={3}
                  maxLength={4000}
                  value={transcript}
                  onChange={(e) => setTranscript(e.target.value)}
                />
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={!transcript.trim()}
                  onClick={useTranscript}
                >
                  Use as capture text
                </button>
              </div>
            ) : null}
          </>
        )}
      </fieldset>
    </section>
  );
}
