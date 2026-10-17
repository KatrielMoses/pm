import { describe, expect, it } from 'vitest';
import { AiProviderError, MessagesProvider } from '../../src/ai/provider.ts';

/**
 * Corrective review 01 §3: the Messages stream parser against deterministic in-memory responses.
 * Each response is built from exact chunks, so framing, bounds, and cleanup are observable.
 */
const ev = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const start = (input: unknown = 5, output: unknown = 1) =>
  ev('message_start', {
    message: { id: 'msg_1', usage: { input_tokens: input, output_tokens: output } },
  });
const delta = (text: string) =>
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
const stop = (reason: unknown, output?: unknown) =>
  ev('message_delta', {
    delta: { stop_reason: reason },
    ...(output === undefined ? {} : { usage: { output_tokens: output } }),
  }) + ev('message_stop', {});

interface Served {
  provider: MessagesProvider;
  cancelled: () => boolean;
}

/** A provider whose fetch returns the given chunks (strings) as a streaming 200 response. */
function served(
  chunks: Array<string | Uint8Array>,
  opts: {
    maxTextChars?: number;
    maxEventBytes?: number;
    maxWireBytes?: number;
    hang?: boolean;
    timeoutMs?: number;
  } = {},
): Served {
  let cancelled = false;
  const fetchImpl = (async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const c of chunks) controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
        if (!opts.hang) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, { status: 200, headers: { 'request-id': 'req_mem_1' } });
  }) as unknown as typeof fetch;
  return {
    provider: new MessagesProvider(
      {
        baseUrl: 'http://in-memory',
        timeoutMs: opts.timeoutMs ?? 2000,
        maxTextChars: opts.maxTextChars ?? 1000,
        maxEventBytes: opts.maxEventBytes ?? 4096,
        maxWireBytes: opts.maxWireBytes ?? 65_536,
      },
      fetchImpl,
    ),
    cancelled: () => cancelled,
  };
}
const request = (signal = new AbortController().signal) => ({
  model: 'm',
  system: 's',
  user: 'u',
  maxOutputTokens: 100,
  apiKey: () => 'k',
  signal,
});
const failOf = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(AiProviderError);
  return e as AiProviderError;
};

describe('7A Messages stream parser (corrective review 01)', () => {
  it('reproduced defect 1: locally clipped text with a normal stop is truncated, never complete, and keeps full usage', async () => {
    const { provider } = served([start(5), delta('abcdef'), stop('end_turn', 6)], {
      maxTextChars: 2,
    });
    const r = await provider.complete(request(), 'unknown');
    expect(r).toMatchObject({
      outcome: 'truncated',
      text: 'ab',
      clipped: true,
      stopReason: 'end_turn',
    });
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 6 });
  });

  it('reproduced defect 2: negative usage is a protocol failure, never a complete answer', async () => {
    const { provider } = served([start(-1), delta('hi'), stop('end_turn', -2)]);
    const e = await failOf(provider.complete(request(), 'unknown'));
    expect(e).toMatchObject({ kind: 'protocol', charged: 'unknown', usageInvalid: true });
    expect(e.knownUsage).toEqual({ inputTokens: null, outputTokens: null });
  });

  it('rejects fractional, unsafe, and negative final usage, keeping only the valid known part', async () => {
    for (const bad of [2.5, Number.MAX_SAFE_INTEGER + 2, -3, '7']) {
      const { provider } = served([start(5), delta('hi'), stop('end_turn', bad)]);
      const e = await failOf(provider.complete(request(), 'unknown'));
      expect(e).toMatchObject({ kind: 'protocol', usageInvalid: true });
      // The input figure was valid; the final output is unknown, and so is the stop.
      expect(e.knownUsage).toEqual({ inputTokens: 5, outputTokens: null });
      expect(e.stopReason).toBeNull();
    }
  });

  it('missing final usage is unknown liability, not the preliminary start figure', async () => {
    const { provider } = served([start(5, 1), delta('hi'), stop('end_turn')]);
    const e = await failOf(provider.complete(request(), 'unknown'));
    expect(e.kind).toBe('protocol');
    expect(e.knownUsage).toEqual({ inputTokens: 5, outputTokens: null });
  });

  it('an unsupported stop reason with valid final usage keeps the known liability and is not an answer', async () => {
    const { provider } = served([start(5), delta('hi'), stop('tool_use', 9)]);
    const e = await failOf(provider.complete(request(), 'unknown'));
    expect(e).toMatchObject({ kind: 'protocol', stopReason: 'tool_use' });
    expect(e.knownUsage).toEqual({ inputTokens: 5, outputTokens: 9 });
  });

  it('rejects out-of-order and contradictory events', async () => {
    for (const chunks of [
      [delta('early'), start(5), stop('end_turn', 1)],
      [start(5), start(5), stop('end_turn', 1)],
      [
        start(5),
        ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
        ev('message_delta', { delta: {}, usage: { output_tokens: 2 } }),
        ev('message_stop', {}),
      ],
      [start(5), stop('end_turn', 1), delta('after the end')],
      [start(5), 'data: {not json}\n\n'],
    ]) {
      const { provider } = served(chunks);
      expect((await failOf(provider.complete(request(), 'unknown'))).kind).toBe('protocol');
    }
  });

  it('frames events split across chunks and CRLF separators', async () => {
    const text = (start(5) + delta('héllo') + stop('end_turn', 3)).replace(/\n/g, '\r\n');
    const bytes = new TextEncoder().encode(text);
    // One byte at a time, splitting multi-byte characters across chunks.
    const chunks = Array.from(bytes, (b) => new Uint8Array([b]));
    const { provider } = served(chunks);
    const r = await provider.complete(request(), 'unknown');
    expect(r).toMatchObject({
      outcome: 'complete',
      text: 'héllo',
      usage: { inputTokens: 5, outputTokens: 3 },
    });
  });

  it('bounds an oversized or unterminated event and the whole response, and closes the reader', async () => {
    // The sources stay open: only an active cancel by the parser ends them.
    const huge = served([start(5), `event: content_block_delta\ndata: ${'x'.repeat(10_000)}`], {
      maxEventBytes: 4096,
      hang: true,
    });
    expect((await failOf(huge.provider.complete(request(), 'unknown'))).kind).toBe(
      'stream_overflow',
    );
    expect(huge.cancelled()).toBe(true);
    const big = served([start(5), delta('y'.repeat(3000)), delta('y'.repeat(3000))], {
      maxEventBytes: 4096,
      maxWireBytes: 5000,
      hang: true,
    });
    expect((await failOf(big.provider.complete(request(), 'unknown'))).kind).toBe(
      'stream_overflow',
    );
    expect(big.cancelled()).toBe(true);
    const terminatedOversize = served([start(5), delta('z'.repeat(6000))], { maxEventBytes: 4096 });
    expect((await failOf(terminatedOversize.provider.complete(request(), 'unknown'))).kind).toBe(
      'stream_overflow',
    );
  });

  it('a trailing event without its separator and an early end are not answers', async () => {
    const trailing = served([start(5), delta('hi'), stop('end_turn', 2).trimEnd()]);
    expect((await failOf(trailing.provider.complete(request(), 'unknown'))).kind).toBe('protocol');
    const early = served([start(5), delta('hi')]);
    const e = await failOf(early.provider.complete(request(), 'unknown'));
    expect(e).toMatchObject({ kind: 'stream_interrupted', partialText: 'hi' });
  });

  it('cancellation and timeout close the reader and say the request may have been charged', async () => {
    const ac = new AbortController();
    const hung = served([start(5), delta('partial')], { hang: true });
    const pending = hung.provider.complete(request(ac.signal), 'unknown');
    setTimeout(() => ac.abort(), 50);
    expect(await failOf(pending)).toMatchObject({ kind: 'cancelled', charged: 'unknown' });
    expect(hung.cancelled()).toBe(true);
    const slow = served([start(5)], { hang: true, timeoutMs: 100 });
    const t = await failOf(slow.provider.complete(request(), 'unknown'));
    expect(t).toMatchObject({ kind: 'stream_interrupted', charged: 'unknown' });
    expect(slow.cancelled()).toBe(true);
  });

  it('a successful stream is read to its end and releases the reader', async () => {
    const ok = served([start(5), delta('done'), stop('end_turn', 1)]);
    const r = await ok.provider.complete(request(), 'unknown');
    expect(r).toMatchObject({
      outcome: 'complete',
      clipped: false,
      text: 'done',
      requestId: 'req_mem_1',
    });
    expect(ok.cancelled()).toBe(false);
  });
});
