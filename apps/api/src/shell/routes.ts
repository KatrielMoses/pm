import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  errorEnvelope,
  SHELL_COMMAND_IDS,
  SHELL_COMMAND_TRIGGERS,
  type ErrorCode,
} from '@pm/contracts';
import type { Metrics } from '@pm/observability';

const DECODE_SOURCES = ['url', 'local'] as const;
const DECODE_REASONS = ['malformed', 'version', 'too_large', 'field', 'unknown_view'] as const;
const MAX_EVENTS = 20;

/**
 * Shell usage counters from the browser (1E, PL-21). Only allow-listed values are counted:
 * command identifiers from the fixed registry, their trigger, and client-side view-state decode
 * failures. Nothing else in the body is read, stored, or logged (no routes, titles, or queries).
 */
export function registerShell(app: FastifyInstance, deps: { metrics: Metrics }): void {
  const fail = (request: FastifyRequest, reply: FastifyReply, code: ErrorCode) => {
    const body = errorEnvelope(code, {
      requestId: request.pm.requestId,
      correlationId: request.pm.correlationId,
    });
    return reply.code(body.error.status).header('cache-control', 'private, no-store').send(body);
  };
  const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;

  app.post('/v1/shell/events', async (request, reply) => {
    if (!request.auth) return fail(request, reply, 'unauthenticated');
    const b = request.body;
    if (typeof b !== 'object' || b === null || Array.isArray(b))
      return fail(request, reply, 'validation_failed');
    const { commands, decode_failures: decodes } = b as Record<string, unknown>;
    const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, MAX_EVENTS) : []);
    for (const e of list(commands)) {
      const x = (e ?? {}) as Record<string, unknown>;
      const command = pick(x.command, SHELL_COMMAND_IDS);
      const trigger = pick(x.trigger, SHELL_COMMAND_TRIGGERS);
      if (command && trigger) deps.metrics.count('shell.commands', 1, { command, trigger });
    }
    for (const e of list(decodes)) {
      const x = (e ?? {}) as Record<string, unknown>;
      const source = pick(x.source, DECODE_SOURCES);
      const reason = pick(x.reason, DECODE_REASONS);
      if (source && reason)
        deps.metrics.count('views.state_decode_failures', 1, { source, reason });
    }
    return reply.code(204).send();
  });
}
