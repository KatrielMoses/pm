import { api, ApiError } from '../api.ts';

/** Phase 8B agents: profiles, starter templates, the tool registry, connectors, and assignments. */

export interface Issue {
  pointer: string;
  code: string;
  message: string;
}

export interface Readiness {
  state: 'ready' | 'not_ready';
  reasons: string[];
  synthetic: boolean;
}

export interface Execution {
  available: false;
  owner: '8C';
  note: string;
}

export interface ScopeView {
  items: Array<{ kind: 'brand' | 'project' | 'record' | 'integration'; id: string; name: string }>;
  not_shown: number;
}

export interface Connector {
  kind: 'api' | 'webhook' | 'mcp';
  endpoint_url: string;
  state: 'configured' | 'verified' | 'stale' | 'revoked' | 'unavailable';
  config_version: number;
  secret_set: boolean;
  verified: boolean;
  synthetic: boolean;
  verified_at: string | null;
  capabilities: {
    protocol?: string;
    version?: string;
    agent?: { name: string; version: string };
    advertised?: Array<{ name: string; version: string }>;
    unregistered?: Array<{ name: string; version: string }>;
    effective?: Array<{ name: string; version: string }>;
  } | null;
  last_code: string | null;
  last_tested_at: string | null;
  transport: 'synthetic_fixture' | 'unavailable';
  production_note: string;
}

export interface AgentProfile {
  id: string;
  type: 'agent_profile';
  name: string;
  purpose: string | null;
  kind: 'internal' | 'external';
  state: 'draft' | 'active' | 'disabled' | 'suspended' | 'archived' | 'trashed';
  suspended_reason: string | null;
  owner: { id: string; name: string; active: boolean } | null;
  template: string | null;
  readiness: Readiness;
  execution: Execution;
  capabilities: { configure: boolean; assign: boolean };
  created_at: string;
  updated_at: string;
  version: number;
  /** Configurers only. */
  draft?: Record<string, unknown>;
  draft_status?: {
    valid: boolean;
    issues: Issue[];
    unavailable: Array<{ pointer: string; tool: string; owner: string }>;
    missing: string[];
    matches_active: boolean;
  };
  active_revision?: {
    revision: number;
    model_key: string | null;
    limits: Record<string, number>;
    tools: Array<{ tool: string; version: string; tool_class: string; approval_class: string }>;
    scope: ScopeView;
    activated_at: string | null;
  } | null;
  connector?: Connector | null;
  signing_secret?: string;
}

export interface AgentTemplate {
  key: string;
  name: string;
  purpose: string;
  kind: 'internal' | 'external';
  needs: string[];
}

export interface AgentTool {
  name: string;
  version: string;
  tool_class: string;
  status: 'available' | 'unavailable';
  owner: string | null;
  description: string;
  risk: string;
  minimum_approval: string;
}

export interface AgentModel {
  key: string;
  label: string;
  synthetic: boolean;
}

export interface ConnectorTest {
  id: string;
  type: 'agent_connector_test';
  state: 'queued' | 'running' | 'passed' | 'failed' | 'stale' | 'refused';
  code: string | null;
  synthetic: boolean;
  config_version: number;
  current: boolean;
  duration_ms: number | null;
  created_at: string;
  ended_at: string | null;
  note: string;
}

export interface Assignment {
  id: string;
  type: 'agent_assignment';
  profile: { id: string; name: string; kind: 'internal' | 'external' };
  state: 'assigned' | 'blocked' | 'withdrawn';
  blocked_reasons: string[];
  revision: number;
  goal: string;
  constraints: string | null;
  deliverable: string | null;
  criteria: string[];
  context: Array<{ id: string; name: string }>;
  scope: ScopeView;
  assigned_by: { id: string; name: string } | null;
  assigned_at: string;
  withdrawn_at: string | null;
  execution: Execution;
  version: number;
}

export interface AssignmentPreview {
  profile: { id: string; name: string; kind: string };
  goal: string;
  constraints: string | null;
  deliverable: string | null;
  criteria: string[];
  context: Array<{ id: string; name: string }>;
  scope: ScopeView;
  refusals: Issue[];
  can_save: boolean;
  readiness: Readiness;
  execution: Execution;
}

const w = (ws: string) => `/v1/workspaces/${encodeURIComponent(ws)}`;
const enc = encodeURIComponent;
const headers = (key: string, version?: number) => ({
  'idempotency-key': key,
  ...(version !== undefined ? { 'if-match': `"${version}"` } : {}),
});

export const agentsClient = {
  list: async (ws: string, archived = false) =>
    (
      await api<{ data: AgentProfile[]; capabilities: { create: boolean } }>(
        'GET',
        `${w(ws)}/agents${archived ? '?archived=true' : ''}`,
      )
    ).body,
  get: async (ws: string, id: string) =>
    (await api<{ data: AgentProfile }>('GET', `${w(ws)}/agents/${enc(id)}`)).body.data,
  templates: async (ws: string) =>
    (await api<{ data: { data: AgentTemplate[] } }>('GET', `${w(ws)}/agent-templates`)).body.data
      .data,
  tools: async (ws: string) =>
    (
      await api<{ data: { data: AgentTool[]; models: AgentModel[] } }>(
        'GET',
        `${w(ws)}/agent-tools`,
      )
    ).body.data,
  create: async (ws: string, body: Record<string, unknown>, key: string) =>
    (await api<{ data: AgentProfile }>('POST', `${w(ws)}/agents`, { body, headers: headers(key) }))
      .body.data,
  /** Draft edits carry the version the person saw (a conflict never overwrites someone else). */
  save: async (
    ws: string,
    id: string,
    body: Record<string, unknown>,
    version: number,
    key: string,
  ) =>
    (
      await api<{ data: AgentProfile }>('PATCH', `${w(ws)}/agents/${enc(id)}`, {
        body,
        headers: headers(key, version),
      })
    ).body.data,
  command: async (
    ws: string,
    id: string,
    verb: string,
    body: Record<string, unknown>,
    key: string,
    version?: number,
  ) =>
    (
      await api<{ data: AgentProfile }>('POST', `${w(ws)}/agents/${enc(id)}:${verb}`, {
        body,
        headers: headers(key, version),
      })
    ).body.data,
  configureConnector: async (ws: string, id: string, body: Record<string, unknown>, key: string) =>
    (
      await api<{ data: AgentProfile }>('POST', `${w(ws)}/agents/${enc(id)}/connector`, {
        body,
        headers: headers(key),
      })
    ).body.data,
  disconnect: async (ws: string, id: string, key: string) =>
    (
      await api<{ data: AgentProfile }>('POST', `${w(ws)}/agents/${enc(id)}/connector:disconnect`, {
        body: {},
        headers: headers(key),
      })
    ).body.data,
  test: async (ws: string, id: string, key: string) =>
    (
      await api<{ data: { test: ConnectorTest } }>(
        'POST',
        `${w(ws)}/agents/${enc(id)}/connector:test`,
        {
          body: { confirm: true },
          headers: headers(key),
        },
      )
    ).body.data.test,
  testResult: async (ws: string, id: string, op: string) =>
    (
      await api<{ data: { test: ConnectorTest } }>(
        'GET',
        `${w(ws)}/agents/${enc(id)}/connector-tests/${enc(op)}`,
      )
    ).body.data.test,
  assignments: async (ws: string, task: string) =>
    (
      await api<{
        data: { items: Assignment[]; capabilities: { assign: boolean }; execution: Execution };
      }>('GET', `${w(ws)}/tasks/${enc(task)}/agents`)
    ).body.data,
  preview: async (ws: string, task: string, body: Record<string, unknown>) =>
    (
      await api<{ data: AssignmentPreview }>('POST', `${w(ws)}/tasks/${enc(task)}/agent-preview`, {
        body,
        headers: headers(`web-preview-${crypto.randomUUID()}`),
      })
    ).body.data,
  assign: async (ws: string, task: string, body: Record<string, unknown>, key: string) =>
    (
      await api<{ data: { assignment: Assignment } }>(
        'POST',
        `${w(ws)}/tasks/${enc(task)}/agents`,
        {
          body,
          headers: headers(key),
        },
      )
    ).body.data.assignment,
  revise: async (
    ws: string,
    task: string,
    agent: string,
    body: Record<string, unknown>,
    version: number,
    key: string,
  ) =>
    (
      await api<{ data: { assignment: Assignment } }>(
        'PATCH',
        `${w(ws)}/tasks/${enc(task)}/agents/${enc(agent)}`,
        {
          body,
          headers: headers(key, version),
        },
      )
    ).body.data.assignment,
  withdraw: async (ws: string, task: string, agent: string, key: string) =>
    (
      await api<{ data: { assignment: Assignment } }>(
        'POST',
        `${w(ws)}/tasks/${enc(task)}/agents/${enc(agent)}:withdraw`,
        {
          body: {},
          headers: headers(key),
        },
      )
    ).body.data.assignment,
};

/** A sentence for the person (offline, conflicts, and validation get their own wording). */
export function agentProblem(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.offline)
      return 'You are offline. Your edits are kept on this device; try again when you are back online.';
    if (
      err.code === 'conflict' &&
      err.issues.some((i) => i.code === 'version_mismatch' || i.code === 'stale')
    )
      return 'This agent changed since you loaded it. Reload to see the latest version; your edits are kept.';
    if (err.issues.length) return err.issues.map((i) => i.message).join(' ');
    if (err.code === 'conflict') return 'This changed since you loaded it. Reload and try again.';
    if (err.code === 'forbidden') return 'You do not have permission to do that here.';
    if (err.code === 'not_found') return 'This is not available.';
    if (err.code === 'rate_limited')
      return 'Too many connection tests in the last hour. Try again later.';
  }
  return fallback;
}

/** An outcome that may be safely retried with the same idempotency key (ambiguous network). */
export function ambiguous(err: unknown): boolean {
  return (
    !(err instanceof ApiError) ||
    err.offline ||
    err.code === 'network' ||
    err.status === 0 ||
    err.status >= 500
  );
}

export const READINESS_TEXT: Record<string, string> = {
  archived: 'It is archived.',
  not_activated: 'It has not been turned on yet.',
  disabled: 'It is turned off.',
  owner_departed: 'Its owner left the workspace. Assign a new owner.',
  owner_authority: 'Its owner no longer has authority over its scope.',
  owner_unavailable: 'Its owner is not an active member.',
  connector_missing: 'It has no connection yet.',
  connector_not_verified: 'Its connection has not passed a test for the current settings.',
  connector_unavailable: 'Its connection cannot be used here.',
  model_unconfigured: 'AI is not configured for this workspace.',
  model_disabled: 'AI is turned off for this workspace.',
  model_model_unavailable: 'Its model is not available.',
  model_not_approved: 'Its model is not approved for workspace data.',
  model_not_entitled: 'AI is not included for this workspace.',
  model_key_unavailable: 'No provider key can be used.',
  model_suspended: 'AI is suspended for this workspace.',
  assigner_unavailable: 'The person who assigned it is no longer an active member.',
  scope_lost: 'Nothing in its scope is available now.',
  scope_narrowed: 'Part of its scope is no longer available.',
};

export const reasonText = (r: string) => READINESS_TEXT[r] ?? r.replace(/_/g, ' ');
