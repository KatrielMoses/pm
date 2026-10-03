import {
  isUuidV7,
  traceIdToUuid,
  type ActorType,
  type ExecutionContext,
  type PrincipalType,
} from '@pm/contracts';
import type { SourceKind } from '@pm/db';
import { validateExecutionContext } from '@pm/platform';

/**
 * Trusted command context for domain mutations (0B §7.1, §7.5). It is derived only from a
 * validated server-side ExecutionContext: actor authority, workspace, delegation chain, and
 * provenance never come from browser input. The private constructor keeps callers from assembling
 * one from request data.
 */

const ACTOR_FOR_PRINCIPAL: Readonly<Record<PrincipalType, ActorType>> = {
  account: 'human',
  member: 'human',
  guest: 'human',
  team: 'human',
  support_operator: 'human',
  api_token_personal: 'human',
  oauth_client: 'integration',
  service_principal: 'integration',
  integration_connection: 'integration',
  inbound_webhook: 'integration',
  automation: 'automation',
  ai_action: 'ai',
  agent_profile: 'agent',
  agent_run: 'agent',
  tool_invocation: 'agent',
  system_job: 'system',
  anonymous_public: 'system',
};

export function actorTypeFor(principal: PrincipalType): ActorType {
  return ACTOR_FOR_PRINCIPAL[principal];
}

export interface CommandSource {
  readonly kind: SourceKind;
  /** Channel reference (token prefix, webhook endpoint, import job ID); never content. */
  readonly ref?: string;
}

export class CommandContextError extends Error {
  constructor(reason: string) {
    super(`invalid command context: ${reason}`);
    this.name = 'CommandContextError';
  }
}

const SOURCE_REF = /^[A-Za-z0-9_.:\-/]{1,200}$/;

export class CommandContext {
  readonly workspaceId: string;
  /** Brand scope resolved server-side (1C); null for workspace-scoped commands. */
  readonly brandId: string | null;
  readonly actor: {
    readonly type: ActorType;
    readonly id: string | null;
    readonly onBehalfOfMembershipId: string | null;
  };
  readonly delegationChain: ReadonlyArray<{ readonly type: string; readonly id: string }>;
  readonly operationId: string | null;
  readonly attemptId: string | null;
  /** Correlation as a uuid (the trace id). */
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly source: CommandSource;

  private constructor(init: Omit<CommandContext, 'withOperation'>) {
    this.workspaceId = init.workspaceId;
    this.brandId = init.brandId;
    this.actor = Object.freeze({ ...init.actor });
    this.delegationChain = Object.freeze(init.delegationChain.map((d) => Object.freeze({ ...d })));
    this.operationId = init.operationId;
    this.attemptId = init.attemptId;
    this.correlationId = init.correlationId;
    this.causationId = init.causationId;
    this.source = Object.freeze({ ...init.source });
    Object.freeze(this);
  }

  /**
   * The only constructor. `brandId` must already be resolved and validated by the server (the
   * brand of the target record, never a client claim).
   */
  static fromExecution(
    ctx: ExecutionContext,
    source: CommandSource,
    options: { brandId?: string | null } = {},
  ): CommandContext {
    validateExecutionContext(ctx);
    if (ctx.workspaceId === null) throw new CommandContextError('tenant commands need a workspace');
    if (source.ref !== undefined && !SOURCE_REF.test(source.ref))
      throw new CommandContextError('source ref');
    const brandId = options.brandId ?? null;
    if (brandId !== null && !isUuidV7(brandId)) throw new CommandContextError('brand');
    const effective = ctx.effectivePrincipal;
    const actorType = actorTypeFor(effective.type);
    return new CommandContext({
      workspaceId: ctx.workspaceId,
      brandId,
      actor: {
        type: actorType,
        id: effective.id,
        // The person on whose behalf delegated actors act (AI, automations, agents).
        onBehalfOfMembershipId: actorType === 'human' ? null : (ctx.initiatingMembershipId ?? null),
      },
      delegationChain: ctx.delegationChain.map((d) => ({ type: d.type, id: d.id })),
      operationId: ctx.operationId ?? null,
      attemptId: ctx.attemptId ?? null,
      correlationId: traceIdToUuid(ctx.correlationId),
      causationId: ctx.causationId ?? null,
      source,
    });
  }

  /** The same command inside a durable operation (purge, bulk): adds operation/attempt links. */
  withOperation(operationId: string, attemptId: string | null): CommandContext {
    return new CommandContext({ ...this, operationId, attemptId });
  }
}
