import type { AgentConnectorFixture } from '@pm/test-support';
import type { EffectBarriers } from '@pm/platform';
import type { TestDatabase } from '@pm/test-support/vitest';
import type { Caller } from '@pm/tenancy';
import {
  agentConnectorTestHandler,
  agentRunHandler,
  AgentRunOutcomeConsumer,
  aiDispatchHandler,
} from '@pm/work';
import { syntheticCaller } from '../../src/integrations/public-api-service.ts';
import { mutation, type WorkEnv } from './fixture.ts';
import { automationWorker, settle } from './automation-support.ts';
import { config, type AgentWorld } from './agents-support.ts';

export const SECRET = 'agent-credential-0123456789abcdef';
export const PRODUCT = 'http://127.0.0.1:9';

/** The worker as the worker process registers it for agents: connector tests, runs, settlement. */
export async function runWorker(
  env: WorkEnv,
  options: { ai?: boolean; effectBarriers?: EffectBarriers } = {},
) {
  const h = env.h;
  const svc = env.workerSvc();
  return automationWorker(env, {
    handlers: [
      agentConnectorTestHandler({ service: svc }),
      agentRunHandler({ service: svc }),
      ...(options.ai
        ? [
            aiDispatchHandler({
              tenant: h.worker,
              discovery: h.discovery,
              service: svc,
              metrics: h.telemetry.metrics,
              logger: h.logger,
              maxAttempts: 3,
              timeoutMs: 20_000,
            }),
          ]
        : []),
    ],
    consumers: [new AgentRunOutcomeConsumer(svc)],
    ...(options.effectBarriers ? { effectBarriers: options.effectBarriers } : {}),
  });
}

/** An external profile connected to a fixture peer, verified, active, and scoped as given. */
export async function externalAgent(
  env: WorkEnv,
  db: TestDatabase,
  fx: AgentConnectorFixture,
  worker: Awaited<ReturnType<typeof runWorker>>,
  w: AgentWorld,
  name: string,
  scope: Record<string, string[]>,
  opts: {
    kind?: 'api' | 'webhook' | 'mcp';
    run?: 'ack' | 'complete' | 'fail' | 'mutate' | 'reject' | 'error';
    tools?: string[];
    as?: Caller;
  } = {},
) {
  const as = opts.as ?? w.owner;
  const kind = opts.kind ?? 'api';
  const tools = (opts.tools ?? ['pm.tasks.get', 'pm.tasks.update']).map((t) => ({
    name: t,
    version: '1',
  }));
  const a = (
    await env.svc.createAgentProfile(
      as,
      w.ws,
      {
        name,
        kind: 'external',
        draft: config({ kind: 'external', model_key: null, scope, tools }),
      },
      mutation(),
    )
  ).data as Record<string, any>;
  const peer = `peer-${a.id.slice(4, 14).toLowerCase()}`;
  fx.peer(peer, { kind, secret: SECRET, run: opts.run ?? 'ack', tools });
  const configured = (
    await env.svc.configureAgentConnector(
      as,
      w.ws,
      a.id,
      { kind, endpoint_url: fx.endpoint(peer), ...(kind === 'webhook' ? {} : { secret: SECRET }) },
      mutation(),
    )
  ).data as Record<string, any>;
  if (kind === 'webhook')
    fx.peer(peer, { kind, secret: configured.signing_secret, run: opts.run ?? 'ack', tools });
  await env.svc.activateAgentProfile(as, w.ws, a.id, mutation());
  await env.svc.testAgentConnector(as, w.ws, a.id, { confirm: true }, mutation());
  await settle(db, worker);
  return { id: a.id as string, peer };
}

/** The caller an external agent becomes with the credential it was sent (as the API resolves it). */
export async function credentialCaller(env: WorkEnv, token: string) {
  const r = await env.svc.authenticateAgentRunCredential(token);
  if (!r) return null;
  return syntheticCaller(r.accountId, r.delegation, { correlationId: 'a'.repeat(32) });
}

export async function runRow(db: TestDatabase, runPublic: string) {
  const r = await db.admin(
    `SELECT r.*, c.execution_state, c.waiting_reason, c.terminal_reason, c.outcome_detail
       FROM agents.agent_run r
       JOIN exec.operation o ON o.id = r.operation_id
       JOIN exec.operation c ON c.id = r.current_operation_id
      WHERE o.public_id = $1`,
    [runPublic],
  );
  return r.rows[0] as Record<string, any>;
}
