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
