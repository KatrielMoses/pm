import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nonResourceEnvelope } from '@pm/contracts';
import type { FieldService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

type Params = {
  ws?: string;
  wf?: string;
  sts?: string;
  trn?: string;
  fld?: string;
  fop?: string;
  fst?: string;
  wap?: string;
  rec?: string;
};

/**
 * Configurable workflows and custom fields (2C, ADR-0015). Configuration lives under
 * `/workflows`, `/fields`, and `/field-sets` with an explicit `scope` (workspace, `brand:br_…`,
 * `project:prj_…`); record surfaces live under `/records/{prj_…|tsk_…}`; approvals under
 * `/approvals`. Public IDs only; `{id}:{verb}` command segments (0D).
 */
export function registerWorkflows(app: FastifyInstance, work: FieldService): void {
  const { m, fail, caller, mutation, wrap, resource, split } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const q = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;
  const ws = '/v1/workspaces/:ws';
  const done = <T extends { id: string; type: string }>(
    request: FastifyRequest,
    reply: Parameters<typeof resource>[1],
    r: { data: T; status: number; replayed: boolean },
  ) => resource(request, reply, r.data, r);

  // --- Workflows ------------------------------------------------------------------------------
  app.get(
    `${ws}/workflows`,
    wrap(async (request) => {
      const r = await work.listWorkflows(caller(request), p(request).ws, q(request));
      return { data: r.data, scope: r.scope, applies: r.applies, meta: m(request) };
    }),
  );
  app.post(
    `${ws}/workflows`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createWorkflow(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );
  app.get(
    `${ws}/workflows/:wf`,
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await work.getWorkflow(caller(request), p(request).ws, p(request).wf),
      ),
    ),
  );
  app.patch(
    `${ws}/workflows/:wf`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateWorkflow(
          caller(request),
          p(request).ws,
          p(request).wf,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.delete(
    `${ws}/workflows/:wf`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.deleteWorkflow(caller(request), p(request).ws, p(request).wf, mutation(request)),
      ),
    ),
  );
  app.post(
    `${ws}/workflows/:wf`,
    wrap(async (request, reply) => {
      const t = split(p(request).wf);
      if (!t) return fail(request, reply, 'not_found');
      const [c, w, req, b] = [caller(request), p(request).ws, mutation(request), request.body];
      switch (t.verb) {
        case 'archive':
        case 'unarchive':
          return done(
            request,
            reply,
            await work.setWorkflowState(
              c,
              w,
              t.id,
              b,
              req,
              t.verb === 'archive' ? 'archived' : 'active',
            ),
          );
        default:
          return fail(request, reply, 'not_found');
      }
    }),
  );
  app.post(
    `${ws}/workflows/:wf/statuses`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.addStatus(
          caller(request),
          p(request).ws,
          p(request).wf,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.patch(
    `${ws}/workflows/:wf/statuses/:sts`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateStatus(
          caller(request),
          p(request).ws,
          p(request).wf,
          p(request).sts,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.delete(
    `${ws}/workflows/:wf/statuses/:sts`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.deleteStatus(
          caller(request),
          p(request).ws,
          p(request).wf,
          p(request).sts,
          request.body ?? {},
          mutation(request),
        ),
      ),
    ),
  );
  app.post(
    `${ws}/workflows/:wf/statuses/:sts`,
    wrap(async (request, reply) => {
      const t = split(p(request).sts);
      if (!t) return fail(request, reply, 'not_found');
      const [c, w, wf, req, b] = [
        caller(request),
        p(request).ws,
        p(request).wf,
        mutation(request),
        request.body,
      ];
      switch (t.verb) {
        case 'move':
          return done(request, reply, await work.moveStatus(c, w, wf, t.id, b, req));
        case 'archive':
        case 'unarchive':
          return done(
            request,
            reply,
            await work.setStatusState(
              c,
              w,
              wf,
              t.id,
              b,
              req,
              t.verb === 'archive' ? 'archived' : 'active',
            ),
          );
        case 'migrate':
          return done(request, reply, await work.migrateStatus(c, w, wf, t.id, b, req));
        default:
          return fail(request, reply, 'not_found');
      }
    }),
  );
  app.post(
    `${ws}/workflows/:wf/transitions`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.addTransition(
          caller(request),
          p(request).ws,
          p(request).wf,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.patch(
    `${ws}/workflows/:wf/transitions/:trn`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateTransition(
          caller(request),
          p(request).ws,
          p(request).wf,
          p(request).trn,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.delete(
    `${ws}/workflows/:wf/transitions/:trn`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.deleteTransition(
          caller(request),
          p(request).ws,
          p(request).wf,
          p(request).trn,
          request.body ?? {},
          mutation(request),
        ),
      ),
    ),
  );
  app.post(
    `${ws}/workflows/:wf/transitions/:trn`,
    wrap(async (request, reply) => {
      const t = split(p(request).trn);
      if (!t) return fail(request, reply, 'not_found');
      const [c, w, wf, req, b] = [
        caller(request),
        p(request).ws,
        p(request).wf,
        mutation(request),
        request.body,
      ];
      switch (t.verb) {
        case 'move':
          return done(request, reply, await work.moveTransition(c, w, wf, t.id, b, req));
        case 'archive':
        case 'unarchive':
          return done(
            request,
            reply,
            await work.setTransitionState(
              c,
              w,
              wf,
              t.id,
              b,
              req,
              t.verb === 'archive' ? 'archived' : 'active',
            ),
          );
        default:
          return fail(request, reply, 'not_found');
      }
    }),
  );

  // --- Custom field definitions ---------------------------------------------------------------
  app.get(
    `${ws}/fields`,
    wrap(async (request) => {
      const r = await work.listFieldDefinitions(caller(request), p(request).ws, q(request));
      return { data: r.data, scope: r.scope, inherited: r.inherited, meta: m(request) };
    }),
  );
  app.post(
    `${ws}/fields`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createFieldDefinition(
          caller(request),
          p(request).ws,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  // Computed field views: formula preview, canonical export, and the in-memory round-trip check.
  app.post(
    `${ws}/fields::preview_formula`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'formula_preview',
        { ...(await work.previewFormula(caller(request), p(request).ws, request.body)) },
        m(request),
      ),
    ),
  );
  app.get(
    `${ws}/fields::export`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'field_document',
        { document: await work.exportFields(caller(request), p(request).ws, q(request)) },
        m(request),
      ),
    ),
  );
  app.post(
    `${ws}/fields::validate_document`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'field_document_check',
        { ...(await work.validateFieldDocument(caller(request), p(request).ws, request.body)) },
        m(request),
      ),
    ),
  );
  app.get(
    `${ws}/fields/:fld`,
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await work.getFieldDefinition(caller(request), p(request).ws, p(request).fld),
      ),
    ),
  );
  app.patch(
    `${ws}/fields/:fld`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateFieldDefinition(
          caller(request),
          p(request).ws,
          p(request).fld,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.delete(
    `${ws}/fields/:fld`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.deleteFieldDefinition(
          caller(request),
          p(request).ws,
          p(request).fld,
          mutation(request),
        ),
      ),
    ),
  );
  app.post(
    `${ws}/fields/:fld`,
    wrap(async (request, reply) => {
      const t = split(p(request).fld);
      if (!t) return fail(request, reply, 'not_found');
      const [c, w, req, b] = [caller(request), p(request).ws, mutation(request), request.body];
      switch (t.verb) {
        case 'archive':
        case 'unarchive':
          return done(
            request,
            reply,
            await work.setFieldDefinitionState(
              c,
              w,
              t.id,
              b,
              req,
              t.verb === 'archive' ? 'archived' : 'active',
            ),
          );
        case 'move':
          return done(request, reply, await work.moveFieldDefinition(c, w, t.id, b, req));
        default:
          return fail(request, reply, 'not_found');
      }
    }),
  );
  app.post(
    `${ws}/fields/:fld/options`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.addOption(
          caller(request),
          p(request).ws,
          p(request).fld,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.patch(
    `${ws}/fields/:fld/options/:fop`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateOption(
          caller(request),
          p(request).ws,
          p(request).fld,
          p(request).fop,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.delete(
    `${ws}/fields/:fld/options/:fop`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.removeOption(
          caller(request),
          p(request).ws,
          p(request).fld,
          p(request).fop,
          request.body ?? {},
          mutation(request),
        ),
      ),
    ),
  );

  // --- Field sets -----------------------------------------------------------------------------
  app.get(
    `${ws}/field-sets`,
    wrap(async (request) => {
      const r = await work.listFieldSets(caller(request), p(request).ws, q(request));
      return { data: r.data, scope: r.scope, meta: m(request) };
    }),
  );
  app.post(
    `${ws}/field-sets`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createFieldSet(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );
  app.patch(
    `${ws}/field-sets/:fst`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateFieldSet(
          caller(request),
          p(request).ws,
          p(request).fst,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );

  // --- Records: transitions, fields, sets -----------------------------------------------------
  app.get(
    `${ws}/records/:rec/transitions`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'transition_options',
        { ...(await work.recordTransitions(caller(request), p(request).ws, p(request).rec)) },
        m(request),
      ),
    ),
  );
  app.get(
    `${ws}/records/:rec/fields`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'record_fields',
        { ...(await work.recordFields(caller(request), p(request).ws, p(request).rec)) },
        m(request),
      ),
    ),
  );
  app.patch(
    `${ws}/records/:rec/fields`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.updateRecordFields(
          caller(request),
          p(request).ws,
          p(request).rec,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.get(
    `${ws}/records/:rec/fields/:fld/explain`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'formula_explanation',
        {
          ...(await work.explainFormula(
            caller(request),
            p(request).ws,
            p(request).rec,
            p(request).fld,
          )),
        },
        m(request),
      ),
    ),
  );
  app.post(
    `${ws}/records/:rec`,
    wrap(async (request, reply) => {
      const t = split(p(request).rec);
      if (!t) return fail(request, reply, 'not_found');
      const [c, w, req, b] = [caller(request), p(request).ws, mutation(request), request.body];
      switch (t.verb) {
        case 'preview_transition':
          return nonResourceEnvelope(
            'transition_preview',
            { ...(await work.previewTransition(c, w, t.id, b)) },
            m(request),
          );
        case 'transition': {
          // A project or a task, by the record's prefix.
          const r = (await work.applyTransition(c, w, t.id, b, req)) as {
            data: { id: string; type: string; version?: number };
            status: number;
            replayed: boolean;
          };
          return done(request, reply, r);
        }
        case 'request_approval':
          return done(request, reply, await work.requestApproval(c, w, t.id, b, req));
        case 'preview_field_set':
          return nonResourceEnvelope(
            'field_set_preview',
            { ...(await work.previewFieldSet(c, w, t.id, b)) },
            m(request),
          );
        case 'apply_field_set':
          return done(request, reply, await work.applyFieldSet(c, w, t.id, b, req));
        default:
          return fail(request, reply, 'not_found');
      }
    }),
  );

  // --- Approvals ------------------------------------------------------------------------------
  app.get(
    `${ws}/approvals`,
    wrap(async (request) => {
      const r = await work.listApprovals(caller(request), p(request).ws, q(request));
      return { data: r.data, meta: m(request) };
    }),
  );
  app.get(
    `${ws}/approvals/:wap`,
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await work.getApproval(caller(request), p(request).ws, p(request).wap),
      ),
    ),
  );
  app.post(
    `${ws}/approvals/:wap`,
    wrap(async (request, reply) => {
      const t = split(p(request).wap);
      if (!t) return fail(request, reply, 'not_found');
      const [c, w, req, b] = [caller(request), p(request).ws, mutation(request), request.body];
      switch (t.verb) {
        case 'approve':
        case 'reject':
          return done(
            request,
            reply,
            await work.decideApproval(c, w, t.id, { ...(b as object), decision: t.verb }, req),
          );
        case 'withdraw':
          return done(request, reply, await work.withdrawApproval(c, w, t.id, req));
        default:
          return fail(request, reply, 'not_found');
      }
    }),
  );
}
