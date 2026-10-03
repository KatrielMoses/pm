import { newUuidV7, traceIdToUuid, type ActorType } from '@pm/contracts';
import type { ScopedTransaction } from '@pm/db';
import type { Metrics } from '@pm/observability';

/**
 * Final security-event sink (0D §12.3): `audit.security_event`, append-only under database
 * enforcement. Account events are written in a platform transaction (workspace NULL); tenant
 * events in that workspace's transaction. The two contexts are mutually exclusive by RLS.
 * Written in the caller's transaction, so a failed write fails the action (0D §12.2).
 */

export type SecurityEventCategory =
  | 'authentication'
  | 'session'
  | 'step_up'
  | 'token'
  | 'permission'
  | 'sharing'
  | 'export'
  | 'support_access'
  | 'elevation'
  | 'denial'
  | 'secret'
  | 'rls_assertion';

export interface SecurityEventRecord {
  category: SecurityEventCategory;
  /** `<resource>.<verb>`. */
  action: string;
  outcome: 'success' | 'failure' | 'denied';
  actor: { type: ActorType; id?: string | undefined };
  subject?: { type: string; id: string } | undefined;
  /** Already minimized: IPv4 /24 or IPv6 /48 prefix and a user-agent family label. */
  network?: { prefix?: string | undefined; userAgentFamily?: string | undefined } | undefined;
  /** W3C trace id (32 hex). */
  correlationId: string;
}

const ACTION = /^[a-z_]+\.[a-z_]+$/;
const PREFIX = /^[0-9a-f.:]{2,45}\/(24|48)$/;

export class SecurityEventWriteError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`security event write failed: ${reason}`, options);
    this.name = 'SecurityEventWriteError';
  }
}

export class AuditSecurityEventSink {
  readonly #metrics: Metrics | undefined;

  constructor(metrics?: Metrics) {
    this.#metrics = metrics;
  }

  async record(tx: ScopedTransaction, e: SecurityEventRecord): Promise<void> {
    const scope = tx.workspaceId === null ? 'account' : 'workspace';
    try {
      if (!ACTION.test(e.action)) throw new SecurityEventWriteError('action');
      if (e.network?.prefix !== undefined && !PREFIX.test(e.network.prefix))
        throw new SecurityEventWriteError('network prefix must be minimized');
      await tx.db
        .insertInto('audit.security_event')
        .values({
          id: newUuidV7(),
          category: e.category,
          action: e.action,
          outcome: e.outcome,
          actor_type: e.actor.type,
          actor_id: e.actor.id ?? null,
          subject_type: e.subject?.type ?? null,
          subject_id: e.subject?.id ?? null,
          workspace_id: tx.workspaceId,
          network_prefix: e.network?.prefix ?? null,
          user_agent_family: e.network?.userAgentFamily ?? null,
          correlation_id: traceIdToUuid(e.correlationId),
        })
        .execute();
      this.#metrics?.count('security_events.written', 1, { category: e.category, scope });
    } catch (err) {
      this.#metrics?.count('security_events.write_failures', 1, { scope });
      throw err instanceof SecurityEventWriteError
        ? err
        : new SecurityEventWriteError('insert', { cause: err });
    }
  }
}
