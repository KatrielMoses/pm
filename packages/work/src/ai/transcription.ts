import type { VoiceConfig } from '@pm/config';

/**
 * Phase 7F provider-neutral transcription (ADR-0043 D3). One port behind the AI gateway: the
 * gateway decides policy, privacy, budget, and lifecycle; a transport only turns bounded audio into
 * text. The only transport is a JSON-over-HTTP protocol implemented by the deterministic test
 * fixture (synthetic, refused when deployed). No live speech provider is configured, and browser
 * speech services are never used.
 */
export type VoiceFormat = 'audio/wav' | 'audio/webm' | 'audio/ogg';
export const VOICE_FORMATS: readonly VoiceFormat[] = ['audio/wav', 'audio/webm', 'audio/ogg'];

export const VOICE_DEFAULTS: VoiceConfig = {
  maxSeconds: 120,
  maxBytes: 10 * 1024 * 1024,
  formats: VOICE_FORMATS,
  queueMax: 3,
  uploadTtlSeconds: 900,
  transcriptMaxChars: 4000,
};

export interface TranscriptionResult {
  text: string;
  /** The audio duration the provider measured (what is billed). */
  durationMs: number;
  /** 0–1 when the provider reports it; null otherwise. */
  confidence: number | null;
  requestId: string | null;
}

export type TranscriptionErrorKind =
  'config' | 'auth' | 'rate' | 'transient' | 'invalid' | 'not_sent' | 'cancelled';

export class TranscriptionError extends Error {
  readonly kind: TranscriptionErrorKind;
  /** Whether the attempt can have been charged ('no' only when it certainly was not). */
  readonly charged: 'no' | 'unknown';
  constructor(kind: TranscriptionErrorKind, charged: 'no' | 'unknown', message: string = kind) {
    super(message);
    this.name = 'TranscriptionError';
    this.kind = kind;
    this.charged = charged;
  }
}

export interface TranscriptionProvider {
  transcribe(req: {
    model: string;
    audio: Uint8Array;
    format: VoiceFormat;
    apiKey: string;
    maxChars: number;
    signal: AbortSignal;
  }): Promise<TranscriptionResult>;
}

/**
 * The synthetic transcription model: a synthetic price per audio second (budget enforcement is
 * exercised; no money is spent). Input units are audio seconds; there are no output units.
 */
export const TRANSCRIPTION_MODEL = {
  key: 'fixture/synthetic-transcription@2026-10-18',
  provider: 'fixture',
  modelId: 'synthetic-transcription',
  label: 'Synthetic transcription (test fixture)',
  synthetic: true,
  price: {
    version: 'synthetic-2026-10-18',
    currency: 'USD',
    /** Per audio second. */
    picoPerSecond: 100_000_000n,
    verification: 'synthetic',
  },
  privacy: { trainingExclusion: 'synthetic', retention: 'none', zeroRetention: true },
} as const;

/** The price snapshot of a transcription (the same keys as a model's, per audio second). */
export function transcriptionPriceSnapshot(): Record<string, unknown> {
  return {
    model_key: TRANSCRIPTION_MODEL.key,
    version: TRANSCRIPTION_MODEL.price.version,
    currency: TRANSCRIPTION_MODEL.price.currency,
    unit: 'audio_second',
    input_pico_per_token: TRANSCRIPTION_MODEL.price.picoPerSecond.toString(),
    output_pico_per_token: '0',
    max_input_tokens_at_price: 3600,
    synthetic: true,
    verification: TRANSCRIPTION_MODEL.price.verification,
  };
}

/** Connection failures where the request certainly never left (the same set as the AI transport). */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH']);

/** Whole billed seconds for a duration (rounded up; at least one). */
export const billedSeconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/**
 * The JSON-over-HTTP transcription transport: `POST {baseUrl}/v1/audio/transcriptions` with the raw
 * bytes, `x-api-key`, and `x-model`; a bounded JSON response `{text, duration_ms, confidence}`.
 */
export class HttpTranscriptionProvider implements TranscriptionProvider {
  readonly #o: { baseUrl: string; timeoutMs: number };
  constructor(o: { baseUrl: string; timeoutMs: number }) {
    this.#o = o;
  }

  async transcribe(req: Parameters<TranscriptionProvider['transcribe']>[0]) {
    const timeout = AbortSignal.timeout(this.#o.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.#o.baseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: {
          'content-type': req.format,
          'x-api-key': req.apiKey,
          'x-model': req.model,
        },
        body: req.audio,
        signal: AbortSignal.any([req.signal, timeout]),
        redirect: 'error',
      });
    } catch (err) {
      if (req.signal.aborted) throw new TranscriptionError('cancelled', 'unknown');
      // A connection that never opened was not charged; a timeout after sending may have been.
      const code = (err as { cause?: { code?: unknown } }).cause?.code;
      const refused = typeof code === 'string' && NOT_SENT_CODES.has(code);
      throw new TranscriptionError(refused ? 'not_sent' : 'transient', refused ? 'no' : 'unknown');
    }
    if (res.status === 401 || res.status === 403) throw new TranscriptionError('auth', 'no');
    if (res.status === 429) throw new TranscriptionError('rate', 'no');
    if (res.status === 400 || res.status === 413 || res.status === 415)
      throw new TranscriptionError('invalid', 'no');
    if (!res.ok) throw new TranscriptionError('transient', 'unknown');
    const raw = await res.text();
    if (raw.length > req.maxChars * 4 + 1024) throw new TranscriptionError('invalid', 'unknown');
    let body: { text?: unknown; duration_ms?: unknown; confidence?: unknown; id?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      throw new TranscriptionError('invalid', 'unknown');
    }
    if (
      typeof body.text !== 'string' ||
      typeof body.duration_ms !== 'number' ||
      !Number.isInteger(body.duration_ms) ||
      body.duration_ms < 0
    )
      throw new TranscriptionError('invalid', 'unknown');
    const confidence =
      typeof body.confidence === 'number' && body.confidence >= 0 && body.confidence <= 1
        ? body.confidence
        : null;
    return {
      text: body.text.slice(0, req.maxChars),
      durationMs: body.duration_ms,
      confidence,
      requestId:
        typeof body.id === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(body.id) ? body.id : null,
    };
  }
}

export type AudioCheck =
  | { ok: true; durationMs: number | null }
  | { ok: false; code: 'unsupported_format' | 'malformed_audio' | 'too_long' | 'empty_audio' };

/**
 * Validates an audio container against its declared format, from its bytes (never a filename or
 * client claim): WAV (RIFF/WAVE PCM; the duration comes from the data size and byte rate), Ogg
 * (Opus or Vorbis; the duration from the last page's granule position), and WebM (EBML with the
 * `webm` doctype; the duration from the segment info when present). Bytes beyond the bound are
 * never read.
 */
export function checkAudio(bytes: Uint8Array, format: VoiceFormat, maxSeconds: number): AudioCheck {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tooLong = (ms: number | null): AudioCheck =>
    ms !== null && ms > maxSeconds * 1000
      ? { ok: false, code: 'too_long' }
      : ms === 0
        ? { ok: false, code: 'empty_audio' }
        : { ok: true, durationMs: ms };
  if (format === 'audio/wav') {
    if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE')
      return { ok: false, code: 'unsupported_format' };
    let off = 12;
    let byteRate = 0;
    let pcm = false;
    while (off + 8 <= b.length) {
      const id = b.toString('ascii', off, off + 4);
      const size = b.readUInt32LE(off + 4);
      const body = off + 8;
      if (id === 'fmt ') {
        if (size < 16 || body + 16 > b.length) return { ok: false, code: 'malformed_audio' };
        pcm = b.readUInt16LE(body) === 1;
        byteRate = b.readUInt32LE(body + 8);
      } else if (id === 'data') {
        if (!pcm || byteRate <= 0) return { ok: false, code: 'malformed_audio' };
        const len = Math.min(size, b.length - body);
        return tooLong(Math.round((len / byteRate) * 1000));
      }
      off = body + size + (size % 2);
    }
    return { ok: false, code: 'malformed_audio' };
  }
  if (format === 'audio/ogg') {
    if (b.length < 28 || b.toString('ascii', 0, 4) !== 'OggS')
      return { ok: false, code: 'unsupported_format' };
    const head = b.subarray(28, 64).toString('latin1');
    const opus = head.startsWith('OpusHead');
    const vorbis = head.startsWith('\x01vorbis');
    if (!opus && !vorbis) return { ok: false, code: 'unsupported_format' };
    const rate = opus ? 48_000 : b.readUInt32LE(28 + 12);
    // The last page carries the final granule position (samples at the codec's rate).
    const last = b.lastIndexOf('OggS');
    if (last < 0 || last + 14 > b.length || rate <= 0) return { ok: false, code: 'malformed_audio' };
    const granule = Number(b.readBigUInt64LE(last + 6));
    if (!Number.isFinite(granule) || granule < 0) return { ok: false, code: 'malformed_audio' };
    return tooLong(Math.round((granule / rate) * 1000));
  }
  // WebM: EBML header, `webm` doctype; Duration (0x4489, float, in TimecodeScale units) if present.
  if (b.length < 32 || b.readUInt32BE(0) !== 0x1a45dfa3) return { ok: false, code: 'unsupported_format' };
  if (!b.subarray(0, 64).toString('latin1').includes('webm'))
    return { ok: false, code: 'unsupported_format' };
  const d = b.indexOf(Buffer.from([0x44, 0x89]));
  if (d > 0 && d + 3 < b.length) {
    const size = b[d + 2]! & 0x7f;
    if ((size === 4 || size === 8) && d + 3 + size <= b.length) {
      const scale = 1_000_000; // nanoseconds per tick (the WebM default)
      const ticks = size === 4 ? b.readFloatBE(d + 3) : b.readDoubleBE(d + 3);
      if (Number.isFinite(ticks) && ticks >= 0) return tooLong(Math.round((ticks * scale) / 1e6));
    }
  }
  // Recorders often omit the duration: the size bound applies now and the measured duration later.
  return { ok: true, durationMs: null };
}
