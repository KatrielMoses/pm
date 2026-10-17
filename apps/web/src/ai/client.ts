import { api, ApiError, newIdempotencyKey, protectedRequest, type StepUpResolver } from '../api.ts';

/** Exact money as the API reports it: decimal micro-dollars and a display string. */
export interface Money {
  micros: string;
  display: string;
  currency: 'USD';
}

export interface AiModelView {
  key: string;
  label: string;
  provider: string;
  model_id: string;
  synthetic: boolean;
  approved_for_workspace_data: boolean;
  privacy: {
    training_exclusion: string;
    retention: string;
    zero_retention: boolean;
    statement: string;
  };
  price: {
    version: string;
    synthetic: boolean;
    input_per_million_tokens: string;
    output_per_million_tokens: string;
  };
  gates?: {
    price: { state: string; source?: string; checked_on?: string };
    input_bound: { state: string; reason?: string };
    error_responses_chargeable: false | 'unknown';
    monetary_dispatch: string;
  };
}

export interface AiUsage {
  period: { start: string; end: string };
  consumed: Money;
  reserved: Money;
  monthly_allowance: Money;
  remaining_allowance: Money;
  hard_limit: Money;
  available_before_hard_limit: Money;
  limits_configured: boolean;
  tokens: {
    input: { consumed: number; reserved: number; hard_limit: number };
    output: { consumed: number; reserved: number; hard_limit: number };
  };
}

export type AiAvailability =
  | 'unconfigured'
  | 'disabled'
  | 'model_unavailable'
  | 'not_approved'
  | 'key_unavailable'
  | 'not_entitled'
  | 'ready';

export interface AiOverview {
  availability: AiAvailability;
  reason: string;
  can_execute: boolean;
  model: AiModelView | null;
  synthetic: boolean;
  funding: string | null;
  max_output_tokens: number;
  confirm_above: Money;
  usage: AiUsage | null;
  manual_fallback: string;
}

export interface AiEstimate {
  synthetic: boolean;
  model: AiModelView;
  input_token_bound: number;
  output_token_bound: number;
  max_cost: Money;
  basis: string;
  redactions: number;
  context: Array<{
    id: string;
    type: string;
    fields: string[];
    included: boolean;
    exclusion_reason: string | null;
  }>;
  usage: AiUsage;
  confirm_required: boolean;
  within_limits: boolean;
  blocked_meter: string | null;
  blocked_reason: string | null;
}

export interface AiAttempt {
  number: number;
  state: string;
  error_kind: string | null;
  stop_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reserved: Money;
  settled: Money | null;
  usage_basis: string | null;
  provider_request_id: string | null;
  cancel_observed: boolean;
  bound_breach?: boolean;
  clipped_locally?: boolean;
  failure_detail?: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface AiRun {
  id: string;
  type: 'ai_run';
  version: number;
  purpose?: 'test_run' | 'grounded_answer' | 'change_proposal';
  state: string;
  status: string;
  terminal_reason: string | null;
  waiting_reason: string | null;
  refusal: { code: string; message: string } | null;
  cancelling: boolean;
  synthetic: boolean;
  initiator: string | null;
  brand: { id: string; name: string } | null;
  model: { key: string; label: string; provider: string; model_id: string };
  created_at: string;
  ended_at: string | null;
  estimate: { max_cost: Money; output_token_bound: number };
  cost: { settled: Money; unknown_reserved: Money; note: string | null };
  attempts: AiAttempt[];
  can_cancel: boolean;
  can_retry: boolean;
  cancellation_note: string;
  content?: {
    state: 'present' | 'withheld' | 'erased';
    note: string | null;
    prompt: string | null;
    redactions: number;
    output: { text: string; completeness: 'complete' | 'truncated' | 'partial' } | null;
    answer?: AiAnswer | null;
    /** 7D: the outcome of a change-proposal run (the proposal is reviewed on its own page). */
    proposal?: {
      status: 'proposed' | 'rejected' | 'withheld';
      reason: string | null;
      id: string | null;
      issues: Array<{ change: string | null; code: string; message: string }>;
    } | null;
  };
  context?: Array<{
    id: string | null;
    type: string;
    included: boolean;
    exclusion_reason: string | null;
    available: boolean;
  }>;
}

/** 7D: a reference in a proposed change (an existing record, or a record this proposal creates). */
export interface AiProposalRef {
  new?: string;
  change?: string | null;
  type?: string;
  id?: string;
  title?: string;
  available?: false;
}

export interface AiProposalChange {
  key: string;
  op:
    | 'task.create'
    | 'task.update'
    | 'project.create'
    | 'project.update'
    | 'milestone.create'
    | 'relation.add'
    | 'document.replace';
  selected: boolean;
  decision: 'pending' | 'accepted' | 'edited' | 'rejected';
  depends_on: string[];
  temp_ref: string | null;
  target: {
    type?: string;
    id?: string;
    title?: string;
    version?: number;
    out_of_date?: boolean;
    available?: false;
  } | null;
  project: AiProposalRef | null;
  parent: AiProposalRef | null;
  brand: 'scope' | null;
  relation: {
    kind: 'blocks' | 'related';
    from: AiProposalRef | null;
    to: AiProposalRef | null;
  } | null;
  fields: Array<{ field: string; before: string | null; after: string | null }>;
  sources: string[];
  applied_state: 'not_applied' | 'applied' | 'failed' | 'rolled_back' | 'blocked';
  result: { type?: string; id?: string; title?: string; available?: false } | null;
  failure: { code: string; message: string } | null;
}

export interface AiProposalIssue {
  change: string | null;
  code: string;
  message: string;
}

export interface AiProposal {
  id: string;
  type: 'change_proposal';
  state: 'open' | 'approved' | 'applied' | 'failed' | 'rejected';
  revision: number;
  version: number;
  created_at: string;
  updated_at: string;
  run: string;
  synthetic: boolean;
  application: {
    outcome: 'applied' | 'failed';
    applied_count: number;
    failed_count: number;
    revision: number;
    operation: string;
    at: string;
  } | null;
  content: { state: 'present' | 'withheld' | 'erased'; note: string | null };
  title: string | null;
  fingerprint: string | null;
  trust_note?: string;
  changes: AiProposalChange[];
  order: string[];
  selection_issues?: AiProposalIssue[];
  approval: { revision: number; selected: string[]; expires_at: string; valid: boolean } | null;
  history: Array<{ kind: string; revision: number; changes: string[]; at: string }>;
  can: { edit: boolean; approve: boolean; apply: boolean; reject: boolean; rebase?: boolean };
}

export interface AiProposalValidation {
  revision: number;
  fingerprint: string;
  selection_issues: AiProposalIssue[];
  valid: boolean;
  changes: Array<{ key: string; state: string; code: string | null; message: string | null }>;
}

export interface AiSettings {
  version: number;
  availability: AiAvailability;
  reason: string;
  transport: 'none' | 'fixture' | 'anthropic';
  enabled: boolean;
  model_key: string | null;
  key_source: 'deployment' | 'workspace';
  workspace_key: { set: boolean; available: boolean; note: string };
  max_data_class: 'C0' | 'C1' | 'C2';
  suspended?: { reason: string; note: string } | null;
  confirm_above: Money;
  models: AiModelView[];
  limits: Array<{
    meter: string;
    unit: string;
    monthly_allowance: string;
    hard_limit: string;
    configured: boolean;
  }>;
  warning_thresholds_bp: number[];
  can_manage_providers: boolean;
  can_configure_limits: boolean;
}

export interface AiUsageAdmin {
  usage: AiUsage;
  runs: AiRun[];
  awaiting_reconciliation: Array<{
    run: string;
    attempt: number;
    reserved: Money;
    provider_request_id: string | null;
  }>;
  can_reconcile: boolean;
}

export interface BrandAiProfile {
  id: string;
  version: number;
  brand: { id: string; name: string };
  instructions: string;
  terminology: string;
  audience: string;
  voice: string;
  approved_sources: 'readable' | 'brand_only';
  can_configure: boolean;
}

/** 7B: one source in a context manifest (always resolved by the server through current access). */
export interface AiManifestSource {
  handle: string | null;
  type: 'task' | 'project' | 'document' | 'comment' | 'activity';
  id: string;
  title: string;
  link: { type: 'task' | 'project' | 'document'; id: string; anchor: string | null };
  version: string;
  selection: 'explicit' | 'scope' | 'search';
  included: boolean;
  exclusion_reason: string | null;
  flags: string[];
  fields: string[];
}

export interface AiManifest {
  /** Set by the response envelope (absent when nested in an estimate). */
  type?: 'ai_context_manifest';
  digest: string;
  scope: {
    kind: 'workspace' | 'brands' | 'project' | 'task';
    brands: Array<{ id: string; name: string }>;
    project: { id: string; title: string } | null;
    task: { id: string; title: string } | null;
  };
  query: string | null;
  sources: AiManifestSource[];
  counts: { listed: number; included: number; excluded: number; omitted: number };
  limits: { sources_max: number; source_chars: number; listed_max: number };
  index: { state: 'complete' | 'catching_up' | 'degraded'; pending: number; failed: number } | null;
  notice: string | null;
  warnings: Array<{ handle: string | null; flags: string[] }>;
  semantic_search: false;
  ai?: { availability: string; reason: string; can_answer: boolean };
}

export interface AiCitedSource {
  handle: string;
  type: string;
  id: string;
  title: string;
  link: { type: 'task' | 'project' | 'document'; id: string; anchor: string | null };
  changed: boolean;
  flags: string[];
}

export interface AiAnswer {
  completeness: string;
  /** checked: format and citations were checked; generated statements stay unverified claims. */
  status: 'checked' | 'downgraded' | 'rejected' | 'withheld';
  reason: string | null;
  note: string | null;
  /** Established: canonical record fields and server calculations. */
  facts: Array<{ handle: string; label: string; value: string; source: AiCitedSource | null }>;
  calculations: Array<{ key: string; label: string; value: string; basis: string }>;
  statements: Array<{
    /** excerpt: the statement is verbatim source text; every other generated claim is unverified. */
    kind: 'excerpt' | 'unverified' | 'suggestion' | 'unknown';
    claimed: string;
    text: string;
    issues: string[];
    /** Provenance; `excerpt` is the source's own matched text, never the model's wording. */
    citations: Array<{
      handle: string;
      quote: string | null;
      excerpt: string | null;
      source: AiCitedSource | null;
    }>;
  }>;
  dropped_citations: number;
  sources: AiCitedSource[];
  trust_note: string;
  provenance_note: string;
}

const w = (ws: string) => `/v1/workspaces/${encodeURIComponent(ws)}`;

export const aiClient = {
  overview: async (ws: string) => (await api<{ data: AiOverview }>('GET', `${w(ws)}/ai`)).body.data,
  estimate: async (ws: string, body: Record<string, unknown>) =>
    (await api<{ data: AiEstimate }>('POST', `${w(ws)}/ai/estimates`, { body })).body.data,
  /** One key per attempt, reused when the person retries after a dropped connection. */
  start: async (ws: string, body: Record<string, unknown>, key: string) =>
    (
      await api<{ data: AiRun }>('POST', `${w(ws)}/ai/test-runs`, {
        body,
        headers: { 'idempotency-key': key },
      })
    ).body.data,
  run: async (ws: string, id: string) =>
    (await api<{ data: AiRun }>('GET', `${w(ws)}/ai/runs/${id}`)).body.data,
  runs: async (ws: string) =>
    (
      await api<{ data: { items: AiRun[]; next_cursor: string | null } }>(
        'GET',
        `${w(ws)}/ai/runs?limit=20`,
      )
    ).body.data.items,
  cancel: async (ws: string, id: string) =>
    (
      await api<{ data: AiRun }>('POST', `${w(ws)}/ai/runs/${id}:cancel`, {
        body: {},
        headers: { 'idempotency-key': newIdempotencyKey() },
      })
    ).body.data,
  /** A retry is a new run: above the confirm threshold it needs `confirm` from the person. */
  retry: async (ws: string, id: string, confirm: boolean) =>
    (
      await api<{ data: AiRun }>('POST', `${w(ws)}/ai/runs/${id}:retry`, {
        body: confirm ? { confirm_cost: true } : {},
        headers: { 'idempotency-key': newIdempotencyKey() },
      })
    ).body.data,
  settings: async (ws: string) =>
    (await api<{ data: AiSettings }>('GET', `${w(ws)}/ai/settings`)).body.data,
  saveSettings: async (
    ws: string,
    body: Record<string, unknown>,
    version: number,
    stepUp: StepUpResolver,
  ) =>
    (
      await protectedRequest<{ data: AiSettings }>('PATCH', `${w(ws)}/ai/settings`, body, stepUp, {
        ifMatch: version,
      })
    ).body.data,
  saveLimits: async (ws: string, limits: Array<Record<string, string>>, stepUp: StepUpResolver) =>
    (await protectedRequest<{ data: AiSettings }>('PUT', `${w(ws)}/ai/limits`, { limits }, stepUp))
      .body.data,
  usage: async (ws: string) =>
    (await api<{ data: AiUsageAdmin }>('GET', `${w(ws)}/ai/usage`)).body.data,
  reconcile: async (
    ws: string,
    run: string,
    attempt: number,
    body: Record<string, unknown>,
    stepUp: StepUpResolver,
  ) =>
    (
      await protectedRequest<{ data: AiRun }>(
        'POST',
        `${w(ws)}/ai/runs/${run}/attempts/${attempt}:reconcile`,
        body,
        stepUp,
      )
    ).body.data,
  brandProfile: async (ws: string, brand: string) =>
    (await api<{ data: BrandAiProfile }>('GET', `${w(ws)}/brands/${brand}/ai-profile`)).body.data,
  saveBrandProfile: async (
    ws: string,
    brand: string,
    body: Record<string, unknown>,
    version: number,
  ) =>
    (
      await api<{ data: BrandAiProfile }>('PATCH', `${w(ws)}/brands/${brand}/ai-profile`, {
        body,
        headers: { 'idempotency-key': newIdempotencyKey(), 'if-match': `"${version}"` },
      })
    ).body.data,
  exportUrl: (ws: string) => `${w(ws)}/portability/exports/ai_history.csv`,
  // 7B: preview the context (works with AI off), estimate a grounded answer, and ask.
  preview: async (ws: string, body: Record<string, unknown>) =>
    (await api<{ data: AiManifest }>('POST', `${w(ws)}/ai/context-previews`, { body })).body.data,
  estimateAnswer: async (ws: string, body: Record<string, unknown>) =>
    (
      await api<{ data: AiEstimate & { manifest: AiManifest } }>(
        'POST',
        `${w(ws)}/ai/answer-estimates`,
        { body },
      )
    ).body.data,
  ask: async (ws: string, body: Record<string, unknown>, key: string) =>
    (
      await api<{ data: AiRun }>('POST', `${w(ws)}/ai/answers`, {
        body,
        headers: { 'idempotency-key': key },
      })
    ).body.data,
  // 7D: change proposals. Generation goes through the same previewed manifest; review, edit,
  // approval, and Apply are explicit steps. Each write carries its own Idempotency-Key, reused
  // when the person retries the same attempt (a repeated click never applies twice).
  propose: async (ws: string, body: Record<string, unknown>, key: string) =>
    (
      await api<{ data: AiRun }>('POST', `${w(ws)}/ai/proposal-runs`, {
        body,
        headers: { 'idempotency-key': key },
      })
    ).body.data,
  proposals: async (ws: string) =>
    (
      await api<{
        data: {
          items: Array<
            Pick<
              AiProposal,
              | 'id'
              | 'state'
              | 'revision'
              | 'created_at'
              | 'run'
              | 'synthetic'
              | 'content'
              | 'title'
              | 'application'
            >
          >;
        };
      }>('GET', `${w(ws)}/ai/proposals`)
    ).body.data.items,
  proposal: async (ws: string, id: string) =>
    (await api<{ data: AiProposal }>('GET', `${w(ws)}/ai/proposals/${id}`)).body.data,
  editProposal: async (ws: string, id: string, body: Record<string, unknown>, key: string) =>
    (
      await api<{ data: AiProposal }>('PATCH', `${w(ws)}/ai/proposals/${id}`, {
        body,
        headers: { 'idempotency-key': key },
      })
    ).body.data,
  validateProposal: async (ws: string, id: string) =>
    (
      await api<{ data: AiProposalValidation }>('POST', `${w(ws)}/ai/proposals/${id}:validate`, {
        body: {},
        headers: { 'idempotency-key': newIdempotencyKey() },
      })
    ).body.data,
  decideProposal: async (
    ws: string,
    id: string,
    verb: 'approve' | 'apply' | 'reject' | 'rebase',
    body: Record<string, unknown>,
    key: string,
  ) =>
    (
      await api<{ data: AiProposal }>('POST', `${w(ws)}/ai/proposals/${id}:${verb}`, {
        body,
        headers: { 'idempotency-key': key },
      })
    ).body.data,
};

/** A person-facing sentence for a refusal (the API's own words when it gave some). */
export function aiProblem(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.offline) return "You're offline. Nothing was sent; try again when you're back online.";
    return err.issues[0]?.message ?? err.message ?? fallback;
  }
  return fallback;
}

export const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled', 'skipped']);
