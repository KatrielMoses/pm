import type { FastifyInstance, FastifyRequest } from 'fastify';
import { LOCAL_STORAGE_ROUTE_PREFIX, LocalObjectStorage, verifyLocalSignature } from '@pm/work';

export interface LocalStorageRouteDeps {
  storage: LocalObjectStorage;
  /** The HMAC key the storage signs its URLs with. */
  secret: string;
  /** Largest object accepted (`FILE_UPLOAD_MAX_BYTES`). */
  maxBytes: number;
}

/**
 * The dev/test object store's signed URLs (4E, ADR-0025 F1). Registered only when
 * `OBJECT_STORAGE=local`, which is refused in deployed environments. The signature in the URL is
 * the whole authorization — exactly as for a provider's presigned URL: it binds the key, the
 * operation, the expiry, and (for PUT) the exact length and checksum; (for GET) the type and the
 * disposition. No session or cookie is read, and the response never reveals why a URL failed.
 */
export function registerLocalStorage(app: FastifyInstance, deps: LocalStorageRouteDeps): void {
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: deps.maxBytes },
      (_req, body, done) => done(null, body),
    );
    const key = (request: FastifyRequest) => (request.params as { key: string }).key;
    const deny = { error: { code: 'not_found', status: 404, message: 'Not found.' } };
    scope.put(`${LOCAL_STORAGE_ROUTE_PREFIX}:key`, async (request, reply) => {
      const v = verifyLocalSignature(
        deps.secret,
        request.query as Record<string, string>,
        key(request),
        new Date(),
      );
      if (!v.ok || v.grant.op !== 'put') return reply.code(403).send(deny);
      const body = request.body;
      if (!Buffer.isBuffer(body)) return reply.code(400).send(deny);
      try {
        await deps.storage.writeSignedPut(key(request), v.grant, body);
      } catch (err) {
        if (err instanceof RangeError) return reply.code(400).send(deny);
        throw err;
      }
      return reply.code(200).send();
    });
    scope.get(`${LOCAL_STORAGE_ROUTE_PREFIX}:key`, async (request, reply) => {
      const v = verifyLocalSignature(
        deps.secret,
        request.query as Record<string, string>,
        key(request),
        new Date(),
      );
      if (!v.ok || v.grant.op !== 'get') return reply.code(403).send(deny);
      const obj = await deps.storage.readObject(key(request));
      if (!obj) return reply.code(404).send(deny);
      for (const [h, value] of Object.entries(LocalObjectStorage.responseHeaders(v.grant)))
        reply.header(h, value);
      return reply.code(200).send(Buffer.from(obj.bytes));
    });
  });
}
