/**
 * Runtime probe for the Phase 8C validator (phase8c.py): runs the real run state table, the
 * callback parsers, the credential minter, and the dispatch transport (with an injected fetch),
 * not a text search. Prints one JSON document; no database, no network.
 *
 *   node --conditions=@pm/source docs/engineering/tools/phase8c-probe.ts
 */
import { createHash } from 'node:crypto';
import { dispatchRun, isOwnCredential } from '../../../packages/work/src/agents/connectors.ts';
import {
  parseArtifact,
  parseEvent,
  parseResult,
  parseToolCall,
  RUN_PROTOCOL_VERSION,
} from '../../../packages/work/src/agents/run-protocol.ts';
import { RUN_CONTROLS, RUN_STATES, runStateOf } from '../../../packages/work/src/agents/run-states.ts';
import { AGENT_RUN_DISPATCH_DESTINATION, newRunCredential } from '../../../packages/work/src/agents/runs.ts';

const OPS = ['queued', 'running', 'waiting', 'paused', 'succeeded', 'partial', 'failed', 'cancelled', 'skipped'] as const;
const REASONS = [null, 'external_confirmation', 'authorization_changed', 'approval', 'reconciliation_required',
  'rate_limit', 'dependency_unavailable', 'delay', 'input'] as const;
const table: Record<string, { state: string; waiting: string | null }> = {};
for (const op of OPS)
  for (const r of op === 'waiting' ? REASONS.slice(1) : [null])
    table[`${op}${r ? `:${r}` : ''}`] = runStateOf(op as never, r as never);

const codes = (p: { ok: boolean; issues?: Array<{ code: string }> }) => (p.ok ? [] : p.issues!.map((i) => i.code));
const content = '# Draft';
const sha = createHash('sha256').update(content).digest('hex');
const parsers = {
  progress: parseEvent({ key: 'p1', kind: 'progress', text: 'Working.', percent: 10 }, 2000).ok,
  completion_kind: codes(parseEvent({ key: 'p2', kind: 'completed', text: 'Done.' }, 2000)),
  too_long: codes(parseEvent({ key: 'p3', kind: 'commentary', text: 'x'.repeat(2001) }, 2000)),
  tool: parseToolCall({ key: 't1', tool: 'pm.tasks.get', version: '1', arguments: { task: 'tsk_x' } }).ok,
  artifact: parseArtifact({ key: 'a', title: 'A', media_type: 'text/markdown', content, sha256: sha }, 1024).ok,
  artifact_binary: codes(parseArtifact({ key: 'a', title: 'A', media_type: 'application/octet-stream', content, sha256: sha }, 1024)),
  artifact_hash: codes(parseArtifact({ key: 'a', title: 'A', media_type: 'text/plain', content, sha256: '0'.repeat(64) }, 1024)),
  artifact_large: codes(parseArtifact({ key: 'a', title: 'A', media_type: 'text/plain', content: 'x'.repeat(2048), sha256: createHash('sha256').update('x'.repeat(2048)).digest('hex') }, 1024)),
  result_accepted: codes(parseResult({ key: 'r', attempt: 1, status: 'accepted', summary: 'Accept it.' })),
  result_ok: parseResult({ key: 'r', attempt: 1, status: 'completed', summary: 'Done.', artifacts: ['a'] }).ok,
};

const creds = Array.from({ length: 50 }, () => newRunCredential());
const credential = {
  format: creds.every((c) => /^par_[A-Za-z0-9]{40}$/.test(c.token)),
  prefix: creds.every((c) => c.prefix === c.token.slice(0, 12)),
  hash: creds.every((c) => c.hash.equals(createHash('sha256').update(c.token).digest())),
  unique: new Set(creds.map((c) => c.token)).size === creds.length,
  own_refused: isOwnCredential(creds[0]!.token),
};

const target = { kind: 'api' as const, endpoint: 'https://93.184.215.14/agent', secret: 'peer-secret' };
const dispatch = { id: 'op_X.1.0', body: { type: 'agent.run.dispatch', dispatch_id: 'op_X.1.0' } };
let calls = 0;
const opts = (respond: () => Promise<Response>) => ({
  timeoutMs: 1000,
  maxBytes: 65536,
  allowLoopback: false,
  productOrigin: 'https://pm.example.test',
  fetchImpl: async () => {
    calls += 1;
    return respond();
  },
});
const ack = (b: unknown) => (b as { dispatch_id?: string }).dispatch_id === 'op_X.1.0';
const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
calls = 0;
const privateEndpoint = await dispatchRun({ ...target, endpoint: 'https://10.1.2.3/' }, dispatch, opts(() => json(200, {})), ack);
const privateCalls = calls;
const dispatchResults = {
  private: { ...privateEndpoint, calls: privateCalls },
  acked: await dispatchRun(target, dispatch, opts(() => json(202, { type: 'agent.run.ack', dispatch_id: 'op_X.1.0', accepted: true })), ack),
  bad_ack: await dispatchRun(target, dispatch, opts(() => json(200, { dispatch_id: 'other' })), ack),
  server_error: await dispatchRun(target, dispatch, opts(() => json(500, {})), ack),
  reset: await dispatchRun(target, dispatch, opts(() => Promise.reject(Object.assign(new Error('reset'), { name: 'TypeError' }))), ack),
};

console.log(
  JSON.stringify({
    protocol_version: RUN_PROTOCOL_VERSION,
    states: RUN_STATES,
    table,
    controls: RUN_CONTROLS,
    destination: { name: AGENT_RUN_DISPATCH_DESTINATION.id, class: AGENT_RUN_DISPATCH_DESTINATION.class },
    parsers,
    credential,
    dispatch: dispatchResults,
  }),
);
