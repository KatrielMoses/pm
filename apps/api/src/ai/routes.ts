import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nonResourceEnvelope } from '@pm/contracts';
import type { AiGatewayService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

/**
 * Phase 7A AI gateway routes (ADR-0038). Settings, keys, limits, and reconciliation are session
 * only (bearer callers are refused at the edge); running, estimating, and reading one's own history
 * accept `ai:execute` delegations, and the usage view accepts `usage:read`. Every handler goes
 * through the same gateway service and authorization as the browser.
 */
export function registerAi(app: FastifyInstance, work: AiGatewayService): void {
  const { m, wrap, caller, mutation, fail, resource, split } = routeKit();
  const ws = (request: FastifyRequest) => (request.params as { ws?: string }).ws;
  const param = (request: FastifyRequest, key: string) =>
    (request.params as Record<string, string | undefined>)[key];
  const base = '/v1/workspaces/:ws';
  // AI settings are a workspace singleton without a public ID: a non-resource envelope whose
  // version travels in the ETag (If-Match on change).
  const settings = (
    request: FastifyRequest,
    reply: import('fastify').FastifyReply,
    data: { id: string; type: string; version: number } & Record<string, unknown>,
    result?: { status: number; replayed: boolean },
  ) => {
    const { id: _id, type: _type, ...rest } = data;
    if (result?.replayed) reply.header('idempotent-replayed', 'true');
    return reply
      .code(result?.status ?? 200)
      .header('etag', `"${data.version}"`)
      .header('cache-control', 'private, no-store')
      .send(nonResourceEnvelope('ai_settings', rest, m(request)));
  };

  app.get(
    `${base}/ai`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'ai_overview',
        await work.aiOverview(caller(request), ws(request)),
        m(request),
      ),
    ),
  );
  app.get(
    `${base}/ai/settings`,
    wrap(async (request, reply) =>
      settings(request, reply, await work.getAiSettings(caller(request), ws(request))),
    ),
  );
  app.patch(
    `${base}/ai/settings`,
    wrap(async (request, reply) => {
      const result = await work.updateAiSettings(
        caller(request),
        ws(request),
        request.body,
        mutation(request),
      );
      return settings(request, reply, result.data, result);
    }),
  );
  app.put(
    `${base}/ai/settings/workspace-key`,
    wrap(async (request, reply) => {
      const result = await work.setAiWorkspaceKey(
        caller(request),
        ws(request),
        request.body,
        mutation(request),
      );
      return settings(request, reply, result.data, result);
    }),
  );
  app.delete(
    `${base}/ai/settings/workspace-key`,
    wrap(async (request, reply) => {
      const result = await work.removeAiWorkspaceKey(
        caller(request),
        ws(request),
        mutation(request),
      );
      return settings(request, reply, result.data, result);
    }),
  );
  app.put(
    `${base}/ai/limits`,
    wrap(async (request, reply) => {
      const result = await work.updateAiLimits(
        caller(request),
        ws(request),
        request.body,
        mutation(request),
      );
      return settings(request, reply, result.data, result);
    }),
  );
  app.get(
    `${base}/brands/:brand/ai-profile`,
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await work.getBrandAiProfile(caller(request), ws(request), param(request, 'brand')),
      ),
    ),
  );
  app.patch(
    `${base}/brands/:brand/ai-profile`,
    wrap(async (request, reply) => {
      const result = await work.updateBrandAiProfile(
        caller(request),
        ws(request),
        param(request, 'brand'),
        request.body,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  app.post(
    `${base}/ai/estimates`,
    wrap(async (request, reply) =>
      reply
        .header('cache-control', 'private, no-store')
        .send(
          nonResourceEnvelope(
            'ai_estimate',
            await work.estimateAiRun(caller(request), ws(request), request.body),
            m(request),
          ),
        ),
    ),
  );
  app.post(
    `${base}/ai/test-runs`,
    wrap(async (request, reply) => {
      const result = await work.startAiTestRun(
        caller(request),
        ws(request),
        request.body,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  // 7B: the context preview (no AI needed), a grounded answer's estimate, and starting it.
  app.post(
    `${base}/ai/context-previews`,
    wrap(async (request, reply) =>
      reply
        .header('cache-control', 'private, no-store')
        .send(
          nonResourceEnvelope(
            'ai_context_manifest',
            await work.previewAiContext(caller(request), ws(request), request.body),
            m(request),
          ),
        ),
    ),
  );
  app.post(
    `${base}/ai/answer-estimates`,
    wrap(async (request, reply) =>
      reply
        .header('cache-control', 'private, no-store')
        .send(
          nonResourceEnvelope(
            'ai_estimate',
            await work.estimateAiAnswer(caller(request), ws(request), request.body),
            m(request),
          ),
        ),
    ),
  );
  app.post(
    `${base}/ai/answers`,
    wrap(async (request, reply) => {
      const result = await work.startAiAnswer(
        caller(request),
        ws(request),
        request.body,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  // 7C typed actions (drafting and analysis) through the same gateway. Bearer callers with
  // `ai:execute` may run analysis actions; drafting actions need a person (refused in the service).
  app.get(
    `${base}/ai/actions`,
    wrap(async (request, reply) =>
      reply
        .header('cache-control', 'private, no-store')
        .send(
          nonResourceEnvelope(
            'ai_actions',
            await work.listAiActions(caller(request), ws(request)),
            m(request),
          ),
        ),
    ),
  );
  app.post(
    `${base}/ai/assist-estimates`,
    wrap(async (request, reply) =>
      reply
        .header('cache-control', 'private, no-store')
        .send(
          nonResourceEnvelope(
            'ai_estimate',
            await work.estimateAiAssist(caller(request), ws(request), request.body),
            m(request),
          ),
        ),
    ),
  );
  app.post(
    `${base}/ai/assist-runs`,
    wrap(async (request, reply) => {
      const result = await work.startAiAssist(
        caller(request),
        ws(request),
        request.body,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  // 7D change proposals: session only (bearer callers are refused at the edge). Generation goes
  // through the same gateway; review, edit, approval, and Apply are explicit human steps.
  app.post(
    `${base}/ai/proposal-runs`,
    wrap(async (request, reply) => {
      const result = await work.startAiProposalRun(
        caller(request),
        ws(request),
        request.body,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  app.get(
    `${base}/ai/proposals`,
    wrap(async (request, reply) =>
      reply
        .header('cache-control', 'private, no-store')
        .send(
          nonResourceEnvelope(
            'ai_proposals',
            await work.listAiProposals(caller(request), ws(request)),
            m(request),
          ),
        ),
    ),
  );
  app.get(
    `${base}/ai/proposals/:prp`,
    wrap(async (request, reply) => {
      const prp = param(request, 'prp') ?? '';
      if (prp.includes(':')) return fail(request, reply, 'not_found');
      reply.header('cache-control', 'private, no-store');
      return resource(request, reply, await work.getAiProposal(caller(request), ws(request), prp));
    }),
  );
  app.patch(
    `${base}/ai/proposals/:prp`,
    wrap(async (request, reply) => {
      const prp = param(request, 'prp') ?? '';
      if (prp.includes(':')) return fail(request, reply, 'not_found');
      reply.header('cache-control', 'private, no-store');
      const result = await work.updateAiProposal(
        caller(request),
        ws(request),
        prp,
        request.body,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  app.post(
    `${base}/ai/proposals/:prp`,
    wrap(async (request, reply) => {
      const t = split(param(request, 'prp'));
      if (!t) return fail(request, reply, 'not_found');
      reply.header('cache-control', 'private, no-store');
      if (t.verb === 'validate')
        return reply.send(
          nonResourceEnvelope(
            'ai_proposal_validation',
            await work.validateAiProposal(caller(request), ws(request), t.id, mutation(request)),
            m(request),
          ),
        );
      const run =
        t.verb === 'approve'
          ? work.approveAiProposal.bind(work)
          : t.verb === 'apply'
            ? work.applyAiProposal.bind(work)
            : t.verb === 'reject'
              ? work.rejectAiProposal.bind(work)
              : t.verb === 'rebase'
                ? work.rebaseAiProposal.bind(work)
                : null;
      if (!run) return fail(request, reply, 'not_found');
      const result = await run(caller(request), ws(request), t.id, request.body, mutation(request));
      return resource(request, reply, result.data, result);
    }),
  );
  app.get(
    `${base}/ai/runs`,
    wrap(async (request, reply) =>
      reply
        .header('cache-control', 'private, no-store')
        .send(
          nonResourceEnvelope(
            'ai_runs',
            await work.listAiRuns(
              caller(request),
              ws(request),
              request.query as Record<string, unknown>,
            ),
            m(request),
          ),
        ),
    ),
  );
  app.get(
    `${base}/ai/runs/:run`,
    wrap(async (request, reply) => {
      const run = param(request, 'run') ?? '';
      if (run.includes(':')) return fail(request, reply, 'not_found');
      reply.header('cache-control', 'private, no-store');
      return resource(request, reply, await work.getAiRun(caller(request), ws(request), run));
    }),
  );
  app.post(
    `${base}/ai/runs/:run`,
    wrap(async (request, reply) => {
      const t = split(param(request, 'run'));
      if (!t) return fail(request, reply, 'not_found');
      if (t.verb === 'cancel') {
        const result = await work.cancelAiRun(
          caller(request),
          ws(request),
          t.id,
          mutation(request),
        );
        return resource(request, reply, result.data, result);
      }
      if (t.verb === 'retry') {
        const result = await work.retryAiRun(
          caller(request),
          ws(request),
          t.id,
          request.body,
          mutation(request),
        );
        return resource(request, reply, result.data, result);
      }
      return fail(request, reply, 'not_found');
    }),
  );
  app.post(
    `${base}/ai/runs/:run/attempts/:attempt`,
    wrap(async (request, reply) => {
      const t = split(param(request, 'attempt'));
      if (!t || t.verb !== 'reconcile' || !/^\d{1,2}$/.test(t.id))
        return fail(request, reply, 'not_found');
      const result = await work.reconcileAiDispatch(
        caller(request),
        ws(request),
        param(request, 'run'),
        t.id,
        request.body,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  // 7F daily plans (ADR-0043): session only (bearer callers are refused at the edge). A preview
  // writes nothing; a plan becomes a change proposal reviewed and applied through the 7D routes.
  app.post(
    `${base}/planning/day-plan-previews`,
    wrap(async (request, reply) =>
      reply
        .header('cache-control', 'private, no-store')
        .send(
          nonResourceEnvelope(
            'day_plan_preview',
            await work.previewDayPlan(caller(request), ws(request), request.body),
            m(request),
          ),
        ),
    ),
  );
  // 7F capture interpretation: the reviewed candidate of an interpreted capture (nothing saved).
  app.post(
    `${base}/capture/interpretations`,
    wrap(async (request, reply) =>
      reply
        .header('cache-control', 'private, no-store')
        .send(
          nonResourceEnvelope(
            'capture_interpretation',
            await work.previewCaptureInterpretation(caller(request), ws(request), request.body),
            m(request),
          ),
        ),
    ),
  );
  // 7F voice capture: session only. Audio goes to object storage through a bound upload URL, is
  // checked from its bytes, transcribed through the gateway, and discarded.
  app.get(
    `${base}/capture/voice-settings`,
    wrap(async (request, reply) =>
      reply
        .header('cache-control', 'private, no-store')
        .send(
          nonResourceEnvelope(
            'voice_settings',
            await work.voiceSettings(caller(request), ws(request)),
            m(request),
          ),
        ),
    ),
  );
  app.post(
    `${base}/capture/voice`,
    wrap(async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const result = await work.createVoiceCapture(
        caller(request),
        ws(request),
        request.body,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  app.get(
    `${base}/capture/voice/:vcp`,
    wrap(async (request, reply) => {
      const vcp = param(request, 'vcp') ?? '';
      if (vcp.includes(':')) return fail(request, reply, 'not_found');
      reply.header('cache-control', 'private, no-store');
      return resource(
        request,
        reply,
        await work.getVoiceCapture(caller(request), ws(request), vcp),
      );
    }),
  );
  app.post(
    `${base}/capture/voice/:vcp`,
    wrap(async (request, reply) => {
      const t = split(param(request, 'vcp'));
      if (!t) return fail(request, reply, 'not_found');
      reply.header('cache-control', 'private, no-store');
      const run =
        t.verb === 'transcribe'
          ? work.transcribeVoiceCapture.bind(work)
          : t.verb === 'cancel'
            ? work.cancelVoiceCapture.bind(work)
            : null;
      if (!run) return fail(request, reply, 'not_found');
      const result = await run(caller(request), ws(request), t.id, mutation(request));
      return resource(request, reply, result.data, result);
    }),
  );
  app.post(
    `${base}/planning/day-plans`,
    wrap(async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const result = await work.createDayPlanProposal(
        caller(request),
        ws(request),
        request.body,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  // 7E briefings and reviews (ADR-0042): session only (bearer callers are refused at the edge).
  // Briefings, schedules, and notes are their person's alone; every read re-checks the evidence.
  const listOf = (type: 'ai_briefings' | 'ai_briefing_schedules' | 'ai_briefing_corrections') =>
    async function send(
      request: FastifyRequest,
      reply: import('fastify').FastifyReply,
      data: Record<string, unknown>,
    ) {
      return reply
        .header('cache-control', 'private, no-store')
        .send(nonResourceEnvelope(type, data, m(request)));
    };
  app.get(
    `${base}/ai/briefings`,
    wrap(async (request, reply) =>
      listOf('ai_briefings')(
        request,
        reply,
        await work.listBriefings(
          caller(request),
          ws(request),
          request.query as Record<string, unknown>,
        ),
      ),
    ),
  );
  app.post(
    `${base}/ai/briefings`,
    wrap(async (request, reply) => {
      reply.header('cache-control', 'private, no-store');
      const result = await work.generateBriefing(
        caller(request),
        ws(request),
        request.body,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  app.post(
    `${base}/ai/briefing-previews`,
    wrap(async (request, reply) =>
      reply
        .header('cache-control', 'private, no-store')
        .send(
          nonResourceEnvelope(
            'ai_briefing_preview',
            await work.previewBriefing(caller(request), ws(request), request.body),
            m(request),
          ),
        ),
    ),
  );
  app.get(
    `${base}/ai/briefings/:brf`,
    wrap(async (request, reply) => {
      const brf = param(request, 'brf') ?? '';
      if (brf.includes(':')) return fail(request, reply, 'not_found');
      reply.header('cache-control', 'private, no-store');
      return resource(request, reply, await work.getBriefing(caller(request), ws(request), brf));
    }),
  );
  app.post(
    `${base}/ai/briefings/:brf`,
    wrap(async (request, reply) => {
      const t = split(param(request, 'brf'));
      if (!t || t.verb !== 'regenerate') return fail(request, reply, 'not_found');
      reply.header('cache-control', 'private, no-store');
      const result = await work.regenerateBriefing(
        caller(request),
        ws(request),
        t.id,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  app.post(
    `${base}/ai/briefings/:brf/corrections`,
    wrap(async (request, reply) => {
      const brf = param(request, 'brf') ?? '';
      if (brf.includes(':')) return fail(request, reply, 'not_found');
      reply.header('cache-control', 'private, no-store');
      const result = await work.proposeBriefingCorrection(
        caller(request),
        ws(request),
        brf,
        request.body,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  app.get(
    `${base}/ai/briefing-corrections`,
    wrap(async (request, reply) =>
      listOf('ai_briefing_corrections')(
        request,
        reply,
        await work.listBriefingCorrections(
          caller(request),
          ws(request),
          request.query as Record<string, unknown>,
        ),
      ),
    ),
  );
  app.patch(
    `${base}/ai/briefing-corrections/:bco`,
    wrap(async (request, reply) => {
      const bco = param(request, 'bco') ?? '';
      if (bco.includes(':')) return fail(request, reply, 'not_found');
      reply.header('cache-control', 'private, no-store');
      const result = await work.updateBriefingCorrection(
        caller(request),
        ws(request),
        bco,
        request.body,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  app.post(
    `${base}/ai/briefing-corrections/:bco`,
    wrap(async (request, reply) => {
      const t = split(param(request, 'bco'));
      if (!t || (t.verb !== 'approve' && t.verb !== 'reject'))
        return fail(request, reply, 'not_found');
      reply.header('cache-control', 'private, no-store');
      const result = await work.decideBriefingCorrection(
        caller(request),
        ws(request),
        t.id,
        t.verb,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  app.get(
    `${base}/ai/briefing-schedules`,
    wrap(async (request, reply) =>
      listOf('ai_briefing_schedules')(
        request,
        reply,
        await work.listBriefingSchedules(caller(request), ws(request)),
      ),
    ),
  );
  app.post(
    `${base}/ai/briefing-schedules`,
    wrap(async (request, reply) => {
      const result = await work.createBriefingSchedule(
        caller(request),
        ws(request),
        request.body,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  app.patch(
    `${base}/ai/briefing-schedules/:bsc`,
    wrap(async (request, reply) => {
      const bsc = param(request, 'bsc') ?? '';
      if (bsc.includes(':')) return fail(request, reply, 'not_found');
      const result = await work.updateBriefingSchedule(
        caller(request),
        ws(request),
        bsc,
        request.body,
        mutation(request),
      );
      return resource(request, reply, result.data, result);
    }),
  );
  app.get(
    `${base}/ai/usage`,
    wrap(async (request, reply) =>
      reply
        .header('cache-control', 'private, no-store')
        .send(
          nonResourceEnvelope(
            'ai_usage',
            await work.aiUsage(caller(request), ws(request)),
            m(request),
          ),
        ),
    ),
  );
}
