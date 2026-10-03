import { newUuidV7, traceIdToUuid, type ActorType } from '@pm/contracts';
import type { ScopedTransaction } from '@pm/db';

/** 0D security-event categories used by identity. */
export type SecurityCategory = 'authentication' | 'session' | 'step_up' | 'token' | 'secret';

export interface SecurityEvent {
  category: SecurityCategory;
  /** `<resource>.<verb>` e.g. `sign_in.attempt`, `session.revoked`. */
  action: string;
  outcome: 'success' | 'failure' | 'denied';
  actor: { type: ActorType; id?: string | undefined };
  subject?: { type: 'account' | 'session'; id: string } | undefined;
  /** Already minimized (prefix / family). */
  network?: { prefix?: string | undefined; userAgentFamily?: string | undefined } | undefined;
  correlationId: string;
}

/**
 * Typed port for security events (0D §12.3). Since 1F the sink is the immutable
 * `audit.security_event` writer (`AuditSecurityEventSink` from @pm/audit); identity flows do not
 * know which sink is active. Events are written in the caller's transaction, so a failed write
 * fails the action (0D §12.2). Never pass passwords, tokens, codes, cookies, emails, full
 * IP addresses, or raw user agents: the type admits none of them.
 */
export interface SecurityEventPort {
  record(tx: ScopedTransaction, event: SecurityEvent): Promise<void>;
}

/**
 * The 1B sink (`identity.security_event_buffer`). Retained only for the cutover window: processes
 * still running 1B code write here until they are replaced, and the ADR-0008 drain copies those
 * rows into the final sink. New code never selects this sink.
 */
export class BufferedSecurityEvents implements SecurityEventPort {
  async record(tx: ScopedTransaction, e: SecurityEvent): Promise<void> {
    await tx.db
      .insertInto('identity.security_event_buffer')
      .values({
        id: newUuidV7(),
        category: e.category,
        action: e.action,
        outcome: e.outcome,
        actor_type: e.actor.type,
        actor_id: e.actor.id ?? null,
        subject_type: e.subject?.type ?? null,
        subject_id: e.subject?.id ?? null,
        workspace_id: null,
        network_prefix: e.network?.prefix ?? null,
        user_agent_family: e.network?.userAgentFamily ?? null,
        correlation_id: traceIdToUuid(e.correlationId),
      })
      .execute();
  }
}
