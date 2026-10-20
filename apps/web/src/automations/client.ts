import { api, ApiError, protectedRequest, type StepUpResolver } from '../api.ts';

/** Phase 8A automations: definitions, revisions, preview, runs, usage, and health. */

export interface DraftIssue {
  pointer: string;
  code: string;
  message: string;
}

export interface Automation {
  id: string;
  type: 'automation';
  name: string;
  description: string | null;
  scope: { kind: 'brand'; brand: { id: string; name: string } } | { kind: 'workspace' };
  owner: { id: string; name: string; active: boolean } | null;
  state: 'active' | 'disabled' | 'suspended' | 'archived';
  enabled: boolean;
  suspended_reason: string | null;
  trigger_kind: string | null;
  active_revision: number | null;
  latest_revision: number | null;
  template: string | null;
  draft: { definition: Record<string, unknown>; scope: { brands: string[]; projects: string[] } };
  draft_status: {
    valid: boolean;
    issues: DraftIssue[];
    unavailable: Array<{ pointer: string; code: string; owner: string }>;
    actions: string[];
    outbound: Array<{ node: string; webhook: string; fields: string[] }>;
    matches_active: boolean;
  };
  last_run: { id: string; status: string; reason: string | null; created_at: string } | null;
  failures_in_a_row: number;
  capabilities: { configure: boolean; run: boolean; activate: boolean };
  created_at: string;
  updated_at: string;
  version: number;
}

export interface AutomationTemplate {
  key: string;
  name: string;
  description: string;
  needs: Array<'project' | 'member' | 'label' | 'timezone'>;
  trigger_kind: string;
}

export interface PreviewStep {
  node: string;
  kind: 'action' | 'branch' | 'delay';
  action?: string;
  outcome: 'would_run' | 'would_refuse' | 'would_wait' | 'then' | 'else' | 'unavailable';
  code?: string;
  failure_class?: string;
  targets?: Array<{ id: string; type: string }>;
  discloses?: { webhook: string; fields: string[] };
  note?: string;
  minutes?: number;
  fallback?: string | null;
}

export interface AutomationPreview {
  valid: boolean;
  issues: DraftIssue[];
  unavailable: Array<{ pointer: string; code: string; owner: string }>;
  conditions: {
    result: boolean | null;
    refused?: string;
    comparisons?: Array<{ pointer: string; result: boolean }>;
  } | null;
  steps: PreviewStep[];
  bounds: {
    steps_max: number;
    fanout_max: number;
    delay_max_minutes: number;
    chain_depth_max: number;
    note: string;
  };
}

export interface RunStep {
  node: string;
  attempt: number;
  kind: string;
  action: string | null;
  state: string;
  failure_class: string | null;
  code: string | null;
  decision: Record<string, unknown> | null;
  targets: Array<{ id: string; type: string }>;
  created?: Array<{ id: string; type: string }>;
  changed?: Array<{ id: string; type: string }>;
  ai_run?: string;
  review_required?: boolean;
  webhook?: { id: string; fields: string[] };
  notifications?: number;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
}

export interface AutomationRun {
  id: string;
  type: 'automation_run';
  automation: { id: string; name: string };
  revision: number;
  status: string;
  reason: string | null;
  operation_state: string;
  trigger: { kind: string; record: { id: string; type: string } | null };
  chain_depth: number;
  steps_executed: number;
  retries: number;
  wake_at: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  explanation: string;
  reconciliation_required: boolean;
  effects: Array<{
    key: string;
    state: string;
    version: number;
    reason: string | null;
    destination: string;
  }>;
  steps: RunStep[];
  capabilities: { retry: boolean; cancel: boolean; reconcile: boolean };
}

export interface AutomationUsage {
  period_start: string;
  measured: { runs: number; runs_finished: number; steps: number };
  technical_limits: Record<string, number>;
  plan_entitlement: { status: 'unavailable'; owner_phase: string; note: string };
}

const w = (ws: string) => `/v1/workspaces/${encodeURIComponent(ws)}`;
const headers = (key: string, version?: number) => ({
  'idempotency-key': key,
  ...(version !== undefined ? { 'if-match': `"${version}"` } : {}),
});

export const automationsClient = {
  list: async (ws: string) =>
    (
      await api<{
        data: Automation[];
        capabilities: { create: boolean; workspace_scope: boolean };
      }>('GET', `${w(ws)}/automations`)
    ).body,
  get: async (ws: string, id: string) =>
    (await api<{ data: Automation }>('GET', `${w(ws)}/automations/${encodeURIComponent(id)}`)).body
      .data,
  templates: async (ws: string) =>
    (await api<{ data: { data: AutomationTemplate[] } }>('GET', `${w(ws)}/automation-templates`))
      .body.data.data,
  usage: async (ws: string) =>
    (await api<{ data: AutomationUsage }>('GET', `${w(ws)}/automation-usage`)).body.data,
  create: async (ws: string, body: Record<string, unknown>, key: string) =>
    (
      await api<{ data: Automation }>('POST', `${w(ws)}/automations`, {
        body,
        headers: headers(key),
      })
    ).body.data,
  /** Draft edits carry the version the person saw (a conflict never overwrites someone else). */
  save: async (
    ws: string,
    id: string,
    body: Record<string, unknown>,
    version: number,
    key: string,
  ) =>
    (
      await api<{ data: Automation }>('PATCH', `${w(ws)}/automations/${encodeURIComponent(id)}`, {
        body,
        headers: headers(key, version),
      })
    ).body.data,
  /** Activation may need a step-up (a standing outbound approval); the same key is reused. */
  activate: async (
    ws: string,
    id: string,
    body: Record<string, unknown>,
    version: number,
    stepUp: StepUpResolver,
    key: string,
  ) =>
    (
      await protectedRequest<{ data: Automation }>(
        'POST',
        `${w(ws)}/automations/${encodeURIComponent(id)}:activate`,
        body,
        stepUp,
        { ifMatch: version, idempotencyKey: key },
      )
    ).body.data,
  command: async (
    ws: string,
    id: string,
    verb: string,
    body: Record<string, unknown>,
    key: string,
  ) =>
    (
      await api<{ data: Automation }>(
        'POST',
        `${w(ws)}/automations/${encodeURIComponent(id)}:${verb}`,
        {
          body,
          headers: headers(key),
        },
      )
    ).body.data,
  preview: async (ws: string, id: string, body: Record<string, unknown>) =>
    (
      await api<{ data: AutomationPreview }>(
        'POST',
        `${w(ws)}/automations/${encodeURIComponent(id)}:preview`,
        {
          body,
          headers: headers(`web-preview-${crypto.randomUUID()}`),
        },
      )
    ).body.data,
  run: async (ws: string, id: string, body: Record<string, unknown>, key: string) =>
    (
      await api<{ data: { run: AutomationRun } }>(
        'POST',
        `${w(ws)}/automations/${encodeURIComponent(id)}:run`,
        {
          body,
          headers: headers(key),
        },
      )
    ).body.data.run,
  runs: async (ws: string, id: string) =>
    (
      await api<{ data: AutomationRun[] }>(
        'GET',
        `${w(ws)}/automations/${encodeURIComponent(id)}/runs`,
      )
    ).body.data,
  runDetail: async (ws: string, run: string) =>
    (
      await api<{ data: { run: AutomationRun } }>(
        'GET',
        `${w(ws)}/automation-runs/${encodeURIComponent(run)}`,
      )
    ).body.data.run,
  runCommand: async (ws: string, run: string, verb: 'retry' | 'cancel', key: string) =>
    (
      await api<{ data: { run: AutomationRun } }>(
        'POST',
        `${w(ws)}/automation-runs/${encodeURIComponent(run)}:${verb}`,
        {
          body: {},
          headers: headers(key),
        },
      )
    ).body.data.run,
  /** P8-W0: an owner or administrator records what happened to a possibly-sent webhook. */
  reconcile: async (
    ws: string,
    run: string,
    effectKey: string,
    body: { decision: 'sent' | 'retry' | 'abandon'; version: number },
    stepUp: StepUpResolver,
    key: string,
  ) =>
    protectedRequest(
      'POST',
      `${w(ws)}/operations/${encodeURIComponent(run)}/effects/${encodeURIComponent(effectKey)}:reconcile`,
      body,
      stepUp,
      { idempotencyKey: key },
    ),
};

/** A sentence for the person (offline, conflicts, and validation get their own wording). */
export function automationProblem(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.offline)
      return 'You are offline. Your edits are kept on this device; try again when you are back online.';
    if (
      err.code === 'conflict' &&
      err.issues.some((i) => i.code === 'version_mismatch' || i.code === 'stale')
    )
      return 'This automation changed since you loaded it. Reload to see the latest version; your edits are kept.';
    if (err.issues.length) return err.issues.map((i) => i.message).join(' ');
    if (err.code === 'conflict') return 'This changed since you loaded it. Reload and try again.';
    if (err.code === 'forbidden') return 'You do not have permission to do that here.';
    if (err.code === 'not_found') return 'This automation is not available.';
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
