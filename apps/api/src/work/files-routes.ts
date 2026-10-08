import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nonResourceEnvelope } from '@pm/contracts';
import type { FileService } from '@pm/work';
import { routeKit } from '../route-kit.ts';

type Params = {
  ws?: string;
  upl?: string;
  file?: string;
  dlv?: string;
  tsk?: string;
  prj?: string;
};

/**
 * Files and deliverables (4E, ADR-0025; 0D PL-35). Bytes never pass through these routes: an
 * upload is a session whose signed PUT goes straight to object storage, and a download is a 303
 * to a short-lived signed GET (`:download`), or the same URL as data for an inline preview
 * (`:preview`). Signed URLs are never stored or logged. Hidden files, sessions, and deliverables
 * are the same `not_found` as unknown ones; unsafe requests carry `Idempotency-Key`.
 */
export function registerFiles(app: FastifyInstance, work: FileService): void {
  const { m, fail, caller, mutation, wrap, resource, split } = routeKit();
  const p = (request: FastifyRequest) => request.params as Params;
  const q = (request: FastifyRequest) => (request.query ?? {}) as Record<string, unknown>;
  const ws = '/v1/workspaces/:ws';
  const done = <T extends { id: string; type: string }>(
    request: FastifyRequest,
    reply: FastifyReply,
    r: { data: T; status: number; replayed: boolean },
  ) => resource(request, reply, r.data, r);

  // ---- Storage status and usage (FILE-010) ------------------------------------------------------
  app.get(
    `${ws}/storage`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'storage_status',
        await work.storageStatus(caller(request), p(request).ws),
        m(request),
      ),
    ),
  );

  // ---- Uploads (0D §15.1) -----------------------------------------------------------------------
  app.post(
    `${ws}/uploads`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.initiateUpload(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );
  app.get(
    `${ws}/uploads/:upl`,
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await work.getUpload(caller(request), p(request).ws, p(request).upl),
      ),
    ),
  );
  app.post(
    `${ws}/uploads/:upl`,
    wrap(async (request, reply) => {
      const t = split(p(request).upl);
      if (!t || t.verb !== 'complete') return fail(request, reply, 'not_found');
      return done(
        request,
        reply,
        await work.completeUpload(caller(request), p(request).ws, t.id, mutation(request)),
      );
    }),
  );

  // ---- Files ------------------------------------------------------------------------------------
  app.get(
    `${ws}/files`,
    wrap(async (request) => {
      const r = await work.listFiles(caller(request), p(request).ws, q(request).host);
      return {
        data: r.data,
        host: r.host,
        can_upload: r.can_upload,
        page: { limit: r.data.length, has_more: false },
        meta: m(request),
      };
    }),
  );
  app.post(
    `${ws}/file-links`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.addFileLink(caller(request), p(request).ws, request.body, mutation(request)),
      ),
    ),
  );
  app.get(
    `${ws}/files/:file`,
    wrap(async (request, reply) => {
      const t = split(p(request).file);
      const query = q(request);
      if (!t)
        return resource(
          request,
          reply,
          await work.getFile(caller(request), p(request).ws, p(request).file),
        );
      if (t.verb === 'download') {
        const r = await work.fileUrl(caller(request), p(request).ws, t.id, {
          version: query.version,
          disposition: 'attachment',
        });
        // A 303 to the signed GET (or the external link); never cached, never followed by us.
        return reply.code(303).header('location', r.url).header('cache-control', 'no-store').send();
      }
      if (t.verb === 'preview')
        return nonResourceEnvelope(
          'file_url',
          await work.fileUrl(caller(request), p(request).ws, t.id, {
            version: query.version,
            disposition: 'inline',
          }),
          m(request),
        );
      if (t.verb === 'compare')
        return nonResourceEnvelope(
          'file_comparison',
          await work.compareVersions(caller(request), p(request).ws, t.id, {
            from: query.from,
            to: query.to,
          }),
          m(request),
        );
      return fail(request, reply, 'not_found');
    }),
  );
  app.patch(
    `${ws}/files/:file`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.renameFile(
          caller(request),
          p(request).ws,
          p(request).file,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.post(
    `${ws}/files/:file`,
    wrap(async (request, reply) => {
      const t = split(p(request).file);
      if (!t || t.verb !== 'trash') return fail(request, reply, 'not_found');
      const r = await work.trashFile(caller(request), p(request).ws, t.id, mutation(request));
      return reply
        .code(r.status)
        .send(nonResourceEnvelope('file_trashed', { id: t.id }, m(request)));
    }),
  );

  // ---- Deliverables (FILE-006–009, PRJ-023) -----------------------------------------------------
  app.get(
    `${ws}/tasks/:tsk/deliverables`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'deliverable_list',
        await work.listDeliverables(caller(request), p(request).ws, p(request).tsk),
        m(request),
      ),
    ),
  );
  app.get(
    `${ws}/projects/:prj/deliverables`,
    wrap(async (request) =>
      nonResourceEnvelope(
        'deliverable_list',
        await work.listDeliverables(caller(request), p(request).ws, p(request).prj),
        m(request),
      ),
    ),
  );
  app.post(
    `${ws}/tasks/:tsk/deliverables`,
    wrap(async (request, reply) =>
      done(
        request,
        reply,
        await work.createDeliverable(
          caller(request),
          p(request).ws,
          p(request).tsk,
          request.body,
          mutation(request),
        ),
      ),
    ),
  );
  app.get(
    `${ws}/deliverables/:dlv`,
    wrap(async (request, reply) =>
      resource(
        request,
        reply,
        await work.getDeliverable(caller(request), p(request).ws, p(request).dlv),
      ),
    ),
  );
  app.post(
    `${ws}/deliverables/:dlv`,
    wrap(async (request, reply) => {
      const t = split(p(request).dlv);
      if (!t || t.verb !== 'submit') return fail(request, reply, 'not_found');
      return done(
        request,
        reply,
        await work.submitDeliverable(
          caller(request),
          p(request).ws,
          t.id,
          request.body,
          mutation(request),
        ),
      );
    }),
  );
}
