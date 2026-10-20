import type { JobHandler } from '@pm/platform';
import { AGENT_CONNECTOR_TEST_JOB, AGENT_QUEUE, type AgentService } from './service.ts';

export interface AgentJobDeps {
  service: Pick<AgentService, 'runAgentConnectorTest'>;
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
