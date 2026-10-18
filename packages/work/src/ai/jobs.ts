import type { PlatformDiscovery, TenantDatabase } from '@pm/db';
import type { JobHandler, RecurringJob } from '@pm/platform';
import type { Logger, Metrics } from '@pm/observability';
import { errorFields } from '@pm/observability';
import { AI_DISPATCH_JOB, AI_TRANSCRIPTION_JOB, type AiGatewayService } from './ai-gateway-service.ts';

export const AI_JOB_KINDS = {
  dispatch: AI_DISPATCH_JOB,
  retention: 'ai.history.retention',
  briefings: 'ai.briefing.sweep',
  transcription: AI_TRANSCRIPTION_JOB,
  voiceCleanup: 'capture.voice.cleanup',
} as const;

/**
 * Hourly: AI content and (7E) briefing content past the technical retention setting. The sweep does nothing while
 * AI_HISTORY_RETENTION_DAYS is unset (OD-36 undecided: content is kept).
 */
export const AI_SCHEDULES: readonly RecurringJob[] = [
  {
    kind: AI_JOB_KINDS.retention,
    queue: 'default',
    intervalMs: 60 * 60_000,
    maxAttempts: 3,
    timeoutSeconds: 300,
  },
  // 7E: every minute, due briefing occurrences and queued briefings (fact-only; no AI is queued).
  {
    kind: AI_JOB_KINDS.briefings,
    queue: 'default',
    intervalMs: 60_000,
    maxAttempts: 3,
    timeoutSeconds: 240,
  },
  // 7F: every five minutes, audio past its upload window or of an ended capture is deleted.
  {
    kind: AI_JOB_KINDS.voiceCleanup,
    queue: 'default',
    intervalMs: 5 * 60_000,
    maxAttempts: 3,
    timeoutSeconds: 120,
  },
];

export interface AiJobDeps {
  tenant: TenantDatabase;
  discovery: PlatformDiscovery;
  service: Pick<
    AiGatewayService,
    'runAiDispatch' | 'eraseAiContent' | 'aiHistoryRetentionDays' | 'runBriefingSweep'
  >;
  metrics: Metrics;
  logger: Logger;
  /** Job attempt cap for a dispatch (AI_MAX_ATTEMPTS). */
  maxAttempts: number;
  timeoutMs: number;
}

/** One provider attempt of an `ai_action` operation (bounded attempts, never an unsafe resend). */
export function aiDispatchHandler(d: AiJobDeps): JobHandler {
  return {
    kind: AI_JOB_KINDS.dispatch,
    queue: 'default',
    maxAttempts: d.maxAttempts,
    timeoutMs: d.timeoutMs,
    handle: (ctx) => d.service.runAiDispatch(ctx),
  };
}

export function aiRetentionHandler(d: AiJobDeps): JobHandler {
  return {
    kind: AI_JOB_KINDS.retention,
    queue: 'default',
    maxAttempts: 3,
    timeoutMs: 300_000,
    async handle() {
      const days = d.service.aiHistoryRetentionDays();
      if (days === null) return;
      const before = new Date(Date.now() - days * 86_400_000);
      // Corrective review 01 (R3): AI content and briefing content are discovered independently
      // (a workspace with briefings and no, or only erased, AI runs is still found), and the two
      // lists are interleaved so neither family starves the other within a sweep.
      const ai = await d.discovery.discoverAiRetentionWork(before, 100);
      const briefings = await d.discovery.discoverBriefingRetentionWork(before, 100);
      // 7F: planner proposals have no AI action either; they are found on their own.
      const plans = await d.discovery.discoverPlanRetentionWork(before, 100);
      const workspaces: string[] = [];
      for (let i = 0; i < Math.max(ai.length, briefings.length, plans.length); i++)
        for (const w of [ai[i], briefings[i], plans[i]]) if (w && !workspaces.includes(w)) workspaces.push(w);
      for (const ws of workspaces) {
        try {
          const erased = await d.tenant.withWorkspace(ws, { module: 'work' }, (tx) =>
            d.service.eraseAiContent(tx, { before }),
          );
          d.metrics.count('ai.history.erased', erased, { reason: 'retention' });
        } catch (err) {
          d.logger.warn('ai.retention_failed', errorFields(err));
        }
      }
    },
  };
}

/**
 * The briefing sweep (ADR-0042 D6). Discovery returns workspace identifiers only; each workspace
 * is swept in its own transactions, a failing workspace never holds up the others, and a repeated
 * or overlapping sweep changes nothing (one briefing per schedule occurrence is a unique key).
 */
export function aiBriefingSweepHandler(d: AiJobDeps): JobHandler {
  return {
    kind: AI_JOB_KINDS.briefings,
    queue: 'default',
    maxAttempts: 3,
    timeoutMs: 240_000,
    async handle() {
      const now = new Date();
      const workspaces = await d.discovery.discoverBriefingWork(now, 100);
      for (const ws of workspaces) {
        try {
          const r = await d.service.runBriefingSweep(d.tenant, ws, now);
          d.metrics.count('ai.briefings', r.published, { outcome: 'swept' });
        } catch (err) {
          d.logger.warn('ai.briefing_sweep_failed', errorFields(err));
        }
      }
    },
  };
}

/** 7F: what the voice jobs need (the transcription attempt and the audio cleanup sweep). */
export type VoiceJobDeps = Omit<AiJobDeps, 'service'> & {
  service: Pick<AiGatewayService, 'runTranscription' | 'runVoiceCleanup'>;
};

/** 7F: one transcription attempt of a voice capture (never resent after a possible charge). */
export function aiTranscriptionHandler(d: VoiceJobDeps): JobHandler {
  return {
    kind: AI_JOB_KINDS.transcription,
    queue: 'default',
    maxAttempts: d.maxAttempts,
    timeoutMs: d.timeoutMs,
    handle: (ctx) => d.service.runTranscription(ctx),
  };
}

/**
 * 7F: the voice cleanup sweep. Discovery returns workspace identifiers only; each workspace deletes
 * a bounded batch of expired or ended audio, and a failing workspace never holds up the others.
 */
export function voiceCleanupHandler(d: VoiceJobDeps): JobHandler {
  return {
    kind: AI_JOB_KINDS.voiceCleanup,
    queue: 'default',
    maxAttempts: 3,
    timeoutMs: 120_000,
    async handle() {
      const now = new Date();
      for (const ws of await d.discovery.discoverVoiceCleanupWork(now, 100)) {
        try {
          await d.service.runVoiceCleanup(d.tenant, ws, now);
        } catch (err) {
          d.logger.warn('capture.voice_cleanup_failed', errorFields(err));
        }
      }
    },
  };
}
