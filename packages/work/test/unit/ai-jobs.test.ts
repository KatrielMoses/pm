import { describe, expect, it } from 'vitest';
import { aiDispatchHandler, aiTranscriptionHandler, type VoiceJobDeps } from '../../src/ai/jobs.ts';

const deps = (extra: Partial<VoiceJobDeps> = {}) =>
  ({
    tenant: null,
    discovery: null,
    service: {},
    metrics: null,
    logger: null,
    maxAttempts: 3,
    timeoutMs: 90_000,
    ...extra,
  }) as unknown as VoiceJobDeps;

describe('Phase 7 integration: AI job bounds', () => {
  it('a transcription attempt is bounded by the transcription transport, not the AI provider timeout', () => {
    // TRANSCRIPTION_TIMEOUT_MS may be up to 120 s while the AI provider allows 60 s; a job lease
    // shorter than the call would end a possibly charged attempt mid-call.
    const h = aiTranscriptionHandler(deps({ transcriptionTimeoutMs: 150_000 }));
    expect(h.timeoutMs).toBe(150_000);
    expect(h.maxAttempts).toBe(3);
    // Without its own bound it keeps the shared one, as before.
    expect(aiTranscriptionHandler(deps()).timeoutMs).toBe(90_000);
    expect(aiDispatchHandler(deps({ transcriptionTimeoutMs: 150_000 }) as never).timeoutMs).toBe(
      90_000,
    );
  });
});
