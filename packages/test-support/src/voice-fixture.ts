/**
 * Phase 7F synthetic audio for the voice capture path (test-only). Each builder makes a real,
 * minimal container (PCM WAV, Ogg Opus, WebM) and embeds a marker with the transcript the
 * transcription fixture will return. The audio itself is silence: this proves upload, validation,
 * transcription, and discard, never speech recognition.
 */
export interface SyntheticSpeech {
  /** The transcript the fixture returns. */
  transcript: string;
  /** The duration the fixture reports (default: the container's duration). */
  reportedMs?: number;
  confidence?: number;
  /** A fixture scenario (`hang`, …). */
  scenario?: string;
}

const marker = (s: SyntheticSpeech | null, durationMs: number) =>
  s
    ? Buffer.concat([
        Buffer.from('PMFX'),
        Buffer.from(
          JSON.stringify({
            t: s.transcript,
            d: s.reportedMs ?? durationMs,
            ...(s.confidence !== undefined ? { c: s.confidence } : {}),
            ...(s.scenario ? { s: s.scenario } : {}),
          }),
        ),
        Buffer.from([0]),
      ])
    : Buffer.alloc(0);

/** A mono 16-bit PCM WAV of `seconds` of silence (8 kHz) with an optional marker chunk. */
export function syntheticWav(seconds: number, speech: SyntheticSpeech | null): Uint8Array {
  const rate = 8000;
  const data = Buffer.alloc(Math.round(seconds * rate) * 2);
  const m = marker(speech, Math.round(seconds * 1000));
  const pad = m.length % 2;
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(1, 10); // mono
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * 2, 16); // byte rate
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const extra = m.length
    ? Buffer.concat([
        Buffer.from('pmfx', 'ascii'),
        (() => {
          const n = Buffer.alloc(4);
          n.writeUInt32LE(m.length, 0);
          return n;
        })(),
        m,
        Buffer.alloc(pad),
      ])
    : Buffer.alloc(0);
  const dataHead = Buffer.alloc(8);
  dataHead.write('data', 0, 'ascii');
  dataHead.writeUInt32LE(data.length, 4);
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmt, extra, dataHead, data]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return new Uint8Array(Buffer.concat([riff, body]));
}

/** An Ogg Opus stream: an `OpusHead` page and a final page whose granule gives the duration. */
export function syntheticOgg(seconds: number, speech: SyntheticSpeech | null): Uint8Array {
  const page = (granule: bigint, payload: Buffer) => {
    const h = Buffer.alloc(27);
    h.write('OggS', 0, 'ascii');
    h.writeBigUInt64LE(granule, 6);
    h[26] = 1;
    return Buffer.concat([h, Buffer.from([payload.length & 0xff]), payload]);
  };
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'ascii');
  head[8] = 1;
  head[9] = 1;
  head.writeUInt32LE(48_000, 12);
  return new Uint8Array(
    Buffer.concat([
      page(0n, head),
      page(0n, marker(speech, Math.round(seconds * 1000)).subarray(0, 255)),
      page(BigInt(Math.round(seconds * 48_000)), Buffer.alloc(8)),
    ]),
  );
}

/** A WebM header (EBML, `webm` doctype) with an optional segment duration and a marker. */
export function syntheticWebm(durationMs: number | null, speech: SyntheticSpeech | null): Uint8Array {
  const ebml = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81,
    0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, 0x42, 0x87, 0x81, 0x04,
    0x42, 0x85, 0x81, 0x02,
  ]);
  const dur = Buffer.alloc(durationMs === null ? 0 : 11);
  if (durationMs !== null) {
    dur[0] = 0x44;
    dur[1] = 0x89;
    dur[2] = 0x88;
    dur.writeDoubleBE(durationMs, 3);
  }
  return new Uint8Array(
    Buffer.concat([ebml, dur, marker(speech, durationMs ?? 1000), Buffer.alloc(64)]),
  );
}
