import type { JobHandler, OutboxConsumer } from '@pm/platform';
import type { WorkspaceTransaction } from '@pm/db';
import type { InternalEvent } from '@pm/platform';
import { AGENT_CONNECTOR_TEST_JOB, AGENT_QUEUE, type AgentService } from './service.ts';
import { AGENT_RUN_JOB, AGENT_RUN_QUEUE, type AgentRunService } from './runs.ts';

export interface AgentJobDeps {
  service: Pick<AgentService, 'runAgentConnectorTest'> &
    Partial<Pick<AgentRunService, 'runAgentJob' | 'consumeAgentOperationState'>>;
}

/**
 * One connector test (8B): re-decided immediately before the handshake, one bounded request
 * outside any transaction, the result bound to the tested configuration version. Retries are
 * safe (a handshake has no effect at the peer) and never test a newer configuration.
 */
export function agentConnectorTestHandler(d: AgentJobDeps): JobHandler {
  return {
    kind: AGENT_CONNECTOR_TEST_JOB,
    queue: AGENT_QUEUE,
    maxAttempts: 3,
    timeoutMs: 60_000,
    handle: (ctx) => d.service.runAgentConnectorTest(ctx),
  };
}

/**
 * One agent run step loop (8C, ADR-0048 D3): fenced steps with reference-only checkpoints, the
 * live guard before every step, the dispatch through the P8-W0 effect ledger, and waits that hold
 * no worker (the operation waits; a continuation runs at the deadline or when woken).
 */
export function agentRunHandler(d: { service: Pick<AgentRunService, 'runAgentJob'> }): JobHandler {
  return {
    kind: AGENT_RUN_JOB,
    queue: AGENT_RUN_QUEUE,
    maxAttempts: 3,
    timeoutMs: 120_000,
    handle: (ctx) => d.service.runAgentJob(ctx),
  };
}

/** Settles agent runs once when their operation ends; wakes runs whose model turn finished. */
export class AgentRunOutcomeConsumer implements OutboxConsumer {
  readonly name = 'agents.runs';
  readonly eventTypes = ['execution.operation.state_changed'] as const;
  readonly #service: Pick<AgentRunService, 'consumeAgentOperationState'>;
  constructor(service: Pick<AgentRunService, 'consumeAgentOperationState'>) {
    this.#service = service;
  }
  handle(tx: WorkspaceTransaction, event: InternalEvent): Promise<void> {
    return this.#service.consumeAgentOperationState(tx, event);
  }
}
