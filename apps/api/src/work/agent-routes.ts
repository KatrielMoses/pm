import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nonResourceEnvelope, type NonResourceType } from '@pm/contracts';
import type { AgentRunService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

type Params = { ws?: string; agt?: string; sub?: string; tsk?: string; op?: string };

/**
 * Agent profiles, connectors, and task assignments (8B, ADR-0047; 0D PL-54). Profiles are
 * addressed by `agt_` identifiers; a task's assignment by its task and profile. Configuration is
 * session-only (the service refuses delegated callers before any idempotency work, and the
 * bearer gate refuses tokens on `/agents`); assignment accepts a token with `agents:execute`.
 * Commands use `{id}:{verb}` action segments; unsafe requests carry `Idempotency-Key`; edits carry
 * `If-Match`. There is no execution here: the run endpoint refuses until 8C.
 */
export function registerAgents(app: FastifyInstance, work: AgentRunService): void {
  const { m, fail, caller, mutation, wrap, resource, split } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const ws = '/v1/workspaces/:ws';
  const flat = (
    request: FastifyRequest,
    reply: FastifyReply,
    type: NonResourceType,
    data: Record<string, unknown>,
    status = 200,
    replayed = false,
  ) => {
    if (replayed) reply.header('idempotent-replayed', 'true');
    return reply
      .code(status)
      .header('cache-control', 'private, no-store')
      .send(nonResourceEnvelope(type, data, m(request)));
  };
  const done = <T extends { id: string; type: string; version?: number }>(
    request: FastifyRequest,
    reply: FastifyReply,
    r: { data: T; status: number; replayed: boolean },
  ) => resource(request, reply, r.data, r);

  app.get(
    `${ws}/agents`,
    wrap(async (request) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const r = await work.listAgentProfiles(caller(request), p(request).ws, q);
      return { data: r.data, page: r.page, capabilities: r.capabilities, meta: m(request) };
    }),
  );
  app.post(
    `${ws}/agents`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createAgentProfile(
          caller(request),
          p(request).ws,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.get(
    `${ws}/agent-templates`,
    wrap(async (request, reply) => {
      // Templates are static; the workspace path still requires a member (decided by the list).
      await work.listAgentProfiles(caller(request), p(request).ws, {});
      return flat(request, reply, 'agent_templates', work.listAgentTemplates());
    }),
  );
  app.get(
    `${ws}/agent-tools`,
    wrap(async (request, reply) => {
      await work.listAgentProfiles(caller(request), p(request).ws, {});
      return flat(request, reply, 'agent_tools', work.listAgentTools());
    }),
  );
  app.get(
    `${ws}/agents/:agt`,
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await work.getAgentProfile(caller(request), p(request).ws, p(request).agt),
      ),
    ),
  );
  app.patch(
    `${ws}/agents/:agt`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateAgentProfile(
          caller(request),
          p(request).ws,
          p(request).agt,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.get(
    `${ws}/agents/:agt/revisions`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'agent_profile_revisions',
        await work.listAgentProfileRevisions(caller(request), p(request).ws, p(request).agt),
      ),
    ),
  );
  app.get(
    `${ws}/agents/:agt/connector-tests/:op`,
    wrap(async (request, reply) =>
      flat(request, reply, 'agent_connector_test', {
        test: await work.getAgentConnectorTest(
          caller(request),
          p(request).ws,
          p(request).agt,
          p(request).op,
        ),
      }),
    ),
  );
  app.post(
    `${ws}/agents/:agt`,
    wrap(async (request, reply) => {
      const t = split(p(request).agt);
      if (!t) return fail(request, reply, 'not_found');
      const c = caller(request);
      const w = p(request).ws;
      const req = mutation(request);
      switch (t.verb) {
        case 'activate':
          return done(request, reply, await work.activateAgentProfile(c, w, t.id, req));
        case 'disable':
          return done(request, reply, await work.disableAgentProfile(c, w, t.id, req));
        case 'duplicate':
          return done(request, reply, await work.duplicateAgentProfile(c, w, t.id, req));
        case 'reassign':
          return done(
            request,
            reply,
            await work.reassignAgentProfile(c, w, t.id, request.body, req),
          );
        case 'archive':
        case 'unarchive':
        case 'trash':
        case 'restore':
          return done(request, reply, await work.agentProfileLifecycle(c, w, t.id, t.verb, req));
        default:
          return fail(request, reply, 'not_found');
      }
    }),
  );
  app.post(
    `${ws}/agents/:agt/:sub`,
    wrap(async (request, reply) => {
      const c = caller(request);
      const w = p(request).ws;
      const req = mutation(request);
      const agt = p(request).agt;
      switch (p(request).sub) {
        case 'connector':
          return done(
            request,
            reply,
            await work.configureAgentConnector(c, w, agt, request.body, req),
          );
        case 'connector:disconnect':
          return done(request, reply, await work.disconnectAgentConnector(c, w, agt, req));
        case 'connector:test': {
          const r = await work.testAgentConnector(c, w, agt, request.body, req);
          return flat(
            request,
            reply,
            'agent_connector_test',
            { test: r.data },
            r.status,
            r.replayed,
          );
        }
        default:
          return fail(request, reply, 'not_found');
      }
    }),
  );

  // Task assignments ------------------------------------------------------------------------
  app.get(
    `${ws}/tasks/:tsk/agents`,
    wrap(async (request, reply) => {
      const r = await work.listTaskAgentAssignments(caller(request), p(request).ws, p(request).tsk);
      return flat(request, reply, 'agent_assignments', {
        task: r.task,
        items: r.data,
        capabilities: r.capabilities,
        execution: r.execution,
      });
    }),
  );
  app.post(
    `${ws}/tasks/:tsk/agent-preview`,
    wrap(async (request, reply) => {
      const { type: _type, ...rest } = await work.previewAgentAssignment(
        caller(request),
        p(request).ws,
        p(request).tsk,
        request.body,
      );
      return flat(request, reply, 'agent_assignment_preview', rest);
    }),
  );
  app.post(
    `${ws}/tasks/:tsk/agents`,
    wrap(async (request, reply) => {
      const r = await work.assignAgent(
        caller(request),
        p(request).ws,
        p(request).tsk,
        request.body,
        mutation(request),
      );
      return flat(request, reply, 'agent_assignment', { assignment: r.data }, r.status, r.replayed);
    }),
  );
  app.patch(
    `${ws}/tasks/:tsk/agents/:agt`,
    wrap(async (request, reply) => {
      const r = await work.updateAgentAssignment(
        caller(request),
        p(request).ws,
        p(request).tsk,
        p(request).agt,
        request.body,
        mutation(request),
      );
      return flat(request, reply, 'agent_assignment', { assignment: r.data }, r.status, r.replayed);
    }),
  );
  app.post(
    `${ws}/tasks/:tsk/agents/:agt`,
    wrap(async (request, reply) => {
      const t = split(p(request).agt);
      if (!t) return fail(request, reply, 'not_found');
      if (t.verb === 'withdraw') {
        const r = await work.withdrawAgentAssignment(
          caller(request),
          p(request).ws,
          p(request).tsk,
          t.id,
          mutation(request),
        );
        return flat(
          request,
          reply,
          'agent_assignment',
          { assignment: r.data },
          r.status,
          r.replayed,
        );
      }
      if (t.verb === 'run') {
        const r = await work.startAgentRun(
          caller(request),
          p(request).ws,
          p(request).tsk,
          t.id,
          request.body,
          mutation(request),
        );
        const { id: _id, type: _type, ...view } = r.data;
        return flat(
          request,
          reply,
          'agent_run',
          { run: { id: _id, ...view } },
          r.status,
          r.replayed,
        );
      }
      return fail(request, reply, 'not_found');
    }),
  );

  // Runs (8C) --------------------------------------------------------------------------------
  const runEnvelope = (view: { id: string; type: string } & Record<string, unknown>) => {
    const { type: _type, ...rest } = view;
    return { run: rest };
  };
  app.get(
    `${ws}/tasks/:tsk/agent-runs`,
    wrap(async (request, reply) => {
      const r = await work.listTaskAgentRuns(caller(request), p(request).ws, p(request).tsk);
      return flat(request, reply, 'agent_runs', {
        task: r.task,
        items: r.data.map((x) => runEnvelope(x).run),
      });
    }),
  );
  app.get(
    `${ws}/tasks/:tsk/agent-run-preview`,
    wrap(async (request, reply) => {
      const q = (request.query ?? {}) as Record<string, unknown>;
      const { type: _type, ...rest } = await work.previewAgentRun(
        caller(request),
        p(request).ws,
        p(request).tsk,
        q.profile,
      );
      return flat(request, reply, 'agent_run_preview', rest);
    }),
  );
  app.get(
    `${ws}/agent-runs/:run`,
    wrap(async (request, reply) =>
      flat(
        request,
        reply,
        'agent_run',
        runEnvelope(
          await work.getAgentRun(
            caller(request),
            p(request).ws,
            (request.params as { run: string }).run,
          ),
        ),
      ),
    ),
  );
  app.get(
    `${ws}/agent-runs/:run/events`,
    wrap(async (request, reply) => {
      const { type: _type, ...rest } = await work.agentRunEvents(
        caller(request),
        p(request).ws,
        (request.params as { run: string }).run,
        (request.query ?? {}) as Record<string, unknown>,
      );
      return flat(request, reply, 'agent_run_events', rest);
    }),
  );
  app.get(
    `${ws}/agent-runs/:run/artifacts/:key`,
    wrap(async (request, reply) => {
      const prm = request.params as { run: string; key: string };
      const { type: _type, ...rest } = await work.getAgentArtifact(
        caller(request),
        p(request).ws,
        prm.run,
        prm.key,
      );
      return flat(request, reply, 'agent_artifact', rest);
    }),
  );
  app.post(
    `${ws}/agent-runs/:run`,
    wrap(async (request, reply) => {
      const t = split((request.params as { run: string }).run);
      if (!t || !['pause', 'resume', 'cancel', 'retry'].includes(t.verb))
        return fail(request, reply, 'not_found');
      const r = await work.controlAgentRun(
        caller(request),
        p(request).ws,
        t.id,
        t.verb as 'pause' | 'resume' | 'cancel' | 'retry',
        mutation(request),
      );
      return flat(
        request,
        reply,
        'agent_run',
        runEnvelope(r.data as { id: string; type: string }),
        r.status,
        r.replayed,
      );
    }),
  );
  // Callbacks from an external agent: the run-bound credential only (the bearer gate and the
  // service both refuse anything else).
  app.get(
    `${ws}/agent-runs/:run/context`,
    wrap(async (request, reply) => {
      const { type: _type, ...rest } = await work.agentRunContext(
        caller(request),
        p(request).ws,
        (request.params as { run: string }).run,
      );
      return flat(request, reply, 'agent_run_context', rest);
    }),
  );
  const callback = (
    path: string,
    type:
      | 'agent_run_event_receipt'
      | 'agent_tool_result'
      | 'agent_artifact_receipt'
      | 'agent_run_result_receipt',
    fn: (
      cl: ReturnType<typeof caller>,
      w: unknown,
      run: string,
      body: unknown,
    ) => Promise<{ type: string } & Record<string, unknown>>,
  ) =>
    app.post(
      `${ws}/agent-runs/:run/${path}`,
      wrap(async (request, reply) => {
        const { type: _type, ...rest } = await fn(
          caller(request),
          p(request).ws,
          (request.params as { run: string }).run,
          request.body,
        );
        return flat(request, reply, type, rest);
      }),
    );
  callback('events', 'agent_run_event_receipt', (cl, w, run, body) =>
    work.agentRunPostEvent(cl, w, run, body),
  );
  callback('tools', 'agent_tool_result', (cl, w, run, body) =>
    work.agentRunCallTool(cl, w, run, body),
  );
  callback('artifacts', 'agent_artifact_receipt', (cl, w, run, body) =>
    work.agentRunPostArtifact(cl, w, run, body),
  );
  callback('result', 'agent_run_result_receipt', (cl, w, run, body) =>
    work.agentRunPostResult(cl, w, run, body),
  );

  // Emergency stop and health (owner/administrator; session only) ----------------------------
  app.post(
    `${ws}/agent-emergency-stop`,
    wrap(async (request, reply) => {
      const r = await work.triggerAgentEmergencyStop(
        caller(request),
        p(request).ws,
        request.body,
        mutation(request),
      );
      const {
        id: _id,
        type: _type,
        ...rest
      } = r.data as { id: string; type: string } & Record<string, unknown>;
      return flat(request, reply, 'agent_emergency_stop', rest, r.status, r.replayed);
    }),
  );
  app.post(
    `${ws}/agent-emergency-stop/restart`,
    wrap(async (request, reply) => {
      const r = await work.restartAgentExecution(
        caller(request),
        p(request).ws,
        request.body,
        mutation(request),
      );
      const {
        id: _id,
        type: _type,
        ...rest
      } = r.data as { id: string; type: string } & Record<string, unknown>;
      return flat(request, reply, 'agent_emergency_stop', rest, r.status, r.replayed);
    }),
  );
  app.get(
    `${ws}/agent-health`,
    wrap(async (request, reply) => {
      const { type: _type, ...rest } = await work.agentHealth(caller(request), p(request).ws);
      return flat(request, reply, 'agent_health', rest);
    }),
  );
}
