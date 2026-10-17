import type { AiConfig } from '@pm/config';
import {
  MODELS,
  modelByKey,
  modelsForTransport,
  monetaryGate,
  type ModelEntry,
} from './registry.ts';

/**
 * Dispatch policy (ADR-0038 A4): pure decisions over the workspace AI policy, the deployment
 * configuration, and the registry. Every refusal has a stable code and a plain reason the person
 * can act on; nothing silently substitutes another model or weakens a privacy guarantee.
 */

export type AiAvailability =
  | 'unconfigured' // no provider transport in this deployment
  | 'disabled' // the workspace has not turned AI on
  | 'model_unavailable' // the selected model is not reachable through this deployment
  | 'suspended' // a provider reported usage above its reserved bound; an owner must review it
  | 'price_unverified' // the model's price is not verified against the provider's official table
  | 'bound_unverified' // no evidenced strict input bound for this model's request protocol
  | 'not_approved' // the model has no provider/data-use approval (OD-41)
  | 'key_unavailable' // the selected key source cannot be used (OD-46, missing key)
  | 'not_entitled' // the commercial entitlement port denies AI (10A)
  | 'ready';

export interface WorkspaceAiPolicy {
  enabled: boolean;
  modelKey: string | null;
  keySource: 'deployment' | 'workspace';
  workspaceKeySet: boolean;
  maxDataClass: 'C0' | 'C1' | 'C2';
  requireTrainingExclusion: boolean;
  /** Set when a provider reported usage beyond a reserved bound (corrective review 01). */
  suspendedReason?: string | null;
}

export interface AvailabilityDecision {
  availability: AiAvailability;
  reason: string;
  model: ModelEntry | null;
  approved: boolean;
  funding: 'platform' | 'workspace_key' | 'synthetic';
}

export const AVAILABILITY_REASONS: Record<AiAvailability, string> = {
  unconfigured:
    'AI is not configured for this deployment. Everything else works as usual; continue manually.',
  disabled: 'AI is turned off for this workspace. An owner or administrator can turn it on.',
  model_unavailable:
    'The selected model is not available in this deployment. Choose another model in AI settings.',
  suspended:
    'AI is paused for this workspace: a provider reported usage above the reserved bound. An owner must review the run and resume AI in settings. Nothing new was sent.',
  price_unverified:
    'This model has no verified price for this request type, so its cost cannot be bounded. Nothing was sent.',
  bound_unverified:
    'There is no evidenced upper bound on what this model can charge for a request, so a hard spending limit cannot be guaranteed. Nothing was sent.',
  not_approved:
    'This model has not been approved for workspace data (provider data-use review is open). Nothing was sent.',
  key_unavailable:
    'The selected provider key cannot be used. Workspace-provided keys are not available, or no key is stored.',
  not_entitled: 'AI is not included for this workspace. Nothing was sent and nothing was charged.',
  ready: 'AI is available.',
};

export function decideAvailability(
  config: AiConfig,
  policy: WorkspaceAiPolicy | null,
  entitled: boolean,
  models: readonly ModelEntry[] = MODELS,
): AvailabilityDecision {
  const none = (availability: AiAvailability, model: ModelEntry | null = null) => ({
    availability,
    reason: AVAILABILITY_REASONS[availability],
    model,
    approved: false,
    funding: 'platform' as const,
  });
  const transport = config.provider.provider;
  if (transport === 'none') return none('unconfigured');
  if (!policy?.enabled || !policy.modelKey) return none('disabled');
  const model = modelByKey(policy.modelKey, models);
  if (!model || !modelsForTransport(transport, models).includes(model))
    return none('model_unavailable');
  if (policy.suspendedReason) return none('suspended', model);
  // Price verification and an evidenced bound are their own gates, independent of approval.
  const gate = monetaryGate(model);
  if (gate) return none(gate, model);
  const approved = model.synthetic || config.approvedModels.includes(model.key);
  if (!approved) return none('not_approved', model);
  // Training exclusion is required (OD-41 safe default): a real model qualifies only through the
  // explicit approval above, which records that a contract excludes training.
  if (policy.requireTrainingExclusion && !model.synthetic && !approved)
    return none('not_approved', model);
  if (policy.keySource === 'workspace') {
    if (!config.byokEnabled || !model.workspaceKeySupported || !policy.workspaceKeySet)
      return none('key_unavailable', model);
  } else if (!config.provider.apiKey) return none('key_unavailable', model);
  if (!entitled) return none('not_entitled', model);
  return {
    availability: 'ready',
    reason: AVAILABILITY_REASONS.ready,
    model,
    approved,
    funding: model.synthetic
      ? 'synthetic'
      : policy.keySource === 'workspace'
        ? 'workspace_key'
        : 'platform',
  };
}

/** Context fields the gateway may send (0B C2 with `search_ai = yes`); everything else is excluded. */
export const AI_CONTEXT_FIELDS = {
  task: { title: 'C2', description: 'C2' },
  project: { name: 'C2', description: 'C2' },
} as const satisfies Record<'task' | 'project', Record<string, 'C1' | 'C2'>>;

export type ContextType = keyof typeof AI_CONTEXT_FIELDS;

/**
 * 7C corrective review 01 R1: the registered classes of the display text a drafting action may be
 * offered as choices. A label name is workspace taxonomy and a member's display name is personal
 * data; both are C1, so neither is sent under a C0 policy. Readable is not the same as AI-eligible:
 * these fields go through the manifest's redaction, data-class policy, and current eligibility.
 */
export const AI_CHOICE_FIELDS = {
  label: { name: 'C1' },
  member: { display_name: 'C1' },
} as const satisfies Record<'label' | 'member', Record<string, 'C1' | 'C2'>>;

const CLASS_RANK = { C0: 0, C1: 1, C2: 2 } as const;

export function fieldAllowed(type: ContextType, field: string, maxDataClass: 'C0' | 'C1' | 'C2') {
  const cls = (AI_CONTEXT_FIELDS[type] as Record<string, 'C1' | 'C2'>)[field];
  if (!cls) return 'field_not_ai_eligible' as const;
  return CLASS_RANK[cls] <= CLASS_RANK[maxDataClass] ? null : ('data_class' as const);
}
