import { api, protectedRequest, type StepUpResolver } from '../api.ts';
import type { StatusView } from '../projects/client.ts';

/** Typed client for the 2C workflow and custom-field API. Every identifier is a public ID. */

export type ScopeRef = string; // 'workspace' | `brand:br_…` | `project:prj_…`
export type Category = 'planned' | 'active' | 'paused' | 'done' | 'cancelled';

export interface WorkflowStatus {
  id: string;
  key: string;
  name: string;
  category: Category;
  color?: string | null;
  icon: string | null;
  state: 'active' | 'archived';
  in_use: boolean;
}
export interface Requirement {
  kind: 'builtin' | 'custom';
  key?: string;
  field?: string | null;
  allow_manager_override: boolean;
}
export interface Transition {
  id: string;
  from: string;
  to: string;
  description: string | null;
  confirmation: 'none' | 'confirm' | 'step_up';
  approval_policy: 'none' | 'one_manager' | 'all_named_approvers';
  allow_self_approval: boolean;
  requirements: Requirement[];
  approvers: string[];
  version: number;
}
export interface Workflow {
  id: string;
  type: 'workflow';
  name: string;
  record_kind: 'project' | 'task';
  scope: { kind: string; brand?: string; project?: string };
  state: 'active' | 'archived';
  statuses: WorkflowStatus[];
  transitions: Transition[];
  archived_transitions: number;
  version: number;
}

export type FieldType =
  | 'text'
  | 'number'
  | 'currency'
  | 'percentage'
  | 'date'
  | 'person'
  | 'label'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'select'
  | 'formula';
export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: 'Text',
  number: 'Number',
  currency: 'Currency',
  percentage: 'Percentage',
  date: 'Date',
  person: 'Person',
  label: 'Label',
  checkbox: 'Checkbox',
  url: 'Web address',
  email: 'Email',
  select: 'Select',
  formula: 'Formula',
};
export interface Option {
  id: string;
  label: string;
  color: string;
  state?: 'active' | 'archived';
  archived?: boolean;
}
export interface FieldDefinition {
  id: string;
  type: 'field_definition';
  name: string;
  description: string | null;
  field_type: FieldType;
  applies_to: Array<'project' | 'task'>;
  config: Record<string, unknown>;
  required: boolean;
  presentation: 'primary' | 'advanced';
  applicability: 'always' | 'via_set';
  view_visibility: Record<string, boolean>;
  visibility: {
    read: 'all_readers' | 'min_level';
    read_min_level: string | null;
    edit_min_level: string | null;
    guest_visible: boolean;
  };
  options: Option[];
  formula: { result_type: string; version: number; depends_on: string[] } | null;
  state: 'active' | 'archived';
  in_use: boolean;
  version: number;
}
export interface RecordField {
  id: string;
  name: string;
  description: string | null;
  field_type: FieldType;
  result_type: string | null;
  presentation: 'primary' | 'advanced';
  required: boolean;
  config: Record<string, unknown>;
  options: Option[];
  value: unknown;
  error: string | null;
  read_only: boolean;
  archived: boolean;
}
export interface RecordFields {
  record: { id: string; type: 'project' | 'task' };
  version: number;
  fields: RecordField[];
  field_sets: Array<{
    id: string;
    name: string;
    version: number;
    current_version: number;
    upgrade_available: boolean;
  }>;
}
export interface FieldSet {
  id: string;
  type: 'field_set';
  name: string;
  applies_to: Array<'project' | 'task'>;
  current_version: number;
  versions: Array<{
    version: number;
    items: Array<{ field: string; presentation: string | null }>;
  }>;
  attached_records: number;
  state: 'active' | 'archived';
  version: number;
}
export interface Evaluation {
  allowed: boolean;
  from: StatusView;
  to: StatusView;
  before_category: Category;
  after_category: Category;
  required_fields: Array<{
    pointer: string;
    label: string;
    satisfied: boolean;
    overridable: boolean;
  }>;
  confirmation: 'none' | 'confirm' | 'step_up';
  approval: { policy: string; required: boolean };
  issues: Array<{ pointer: string; code: string; message: string }>;
}
export interface Approval {
  id: string;
  type: 'workflow_approval';
  record: { id: string; type: 'project' | 'task' };
  transition: string;
  from: StatusView;
  to: StatusView;
  policy: string;
  state: 'pending' | 'approved' | 'rejected' | 'stale' | 'expired' | 'applied' | 'withdrawn';
  requester: string | null;
  decisions: Array<{ approver: string; decision: 'approve' | 'reject'; decided_at: string }>;
  expires_at: string;
  can_decide: boolean;
  can_apply: boolean;
  can_withdraw: boolean;
  self_requested: boolean;
}

const w = (ws: string) => `/v1/workspaces/${ws}`;
const q = (scope: ScopeRef) => `scope=${encodeURIComponent(scope)}`;

export const workflows = {
  async list(ws: string, scope: ScopeRef, all = false) {
    const r = await api<{
      data: Workflow[];
      scope: unknown;
      applies: Record<'project' | 'task', { id: string; scope_kind: string; name: string } | null>;
    }>('GET', `${w(ws)}/workflows?${q(scope)}${all ? '&state=all' : ''}`);
    return r.body;
  },
  async create(ws: string, body: unknown, stepUp: StepUpResolver) {
    return (await protectedRequest<{ data: Workflow }>('POST', `${w(ws)}/workflows`, body, stepUp))
      .body.data;
  },
  async patch(ws: string, path: string, version: number, body: unknown, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Workflow }>(
        'PATCH',
        `${w(ws)}/workflows/${path}`,
        body,
        stepUp,
        { ifMatch: version },
      )
    ).body.data;
  },
  async post(
    ws: string,
    path: string,
    version: number | undefined,
    body: unknown,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Workflow }>(
        'POST',
        `${w(ws)}/workflows/${path}`,
        body ?? {},
        stepUp,
        { ifMatch: version },
      )
    ).body.data;
  },
  async remove(ws: string, path: string, version: number, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Workflow }>(
        'DELETE',
        `${w(ws)}/workflows/${path}`,
        {},
        stepUp,
        { ifMatch: version },
      )
    ).body.data;
  },
};

export const fields = {
  async list(ws: string, scope: ScopeRef, all = false) {
    return (
      await api<{
        data: FieldDefinition[];
        inherited: Array<{ id: string; name: string; field_type: FieldType; scope_kind: string }>;
      }>('GET', `${w(ws)}/fields?${q(scope)}${all ? '&state=all' : ''}`)
    ).body;
  },
  async create(ws: string, body: unknown, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: FieldDefinition }>('POST', `${w(ws)}/fields`, body, stepUp)
    ).body.data;
  },
  async patch(ws: string, path: string, version: number, body: unknown, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: FieldDefinition }>(
        'PATCH',
        `${w(ws)}/fields/${path}`,
        body,
        stepUp,
        { ifMatch: version },
      )
    ).body.data;
  },
  async post(
    ws: string,
    path: string,
    version: number | undefined,
    body: unknown,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: FieldDefinition }>(
        'POST',
        `${w(ws)}/fields/${path}`,
        body ?? {},
        stepUp,
        { ifMatch: version },
      )
    ).body.data;
  },
  async remove(ws: string, path: string, version: number, body: unknown, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: FieldDefinition & { remaining?: number } }>(
        'DELETE',
        `${w(ws)}/fields/${path}`,
        body ?? {},
        stepUp,
        { ifMatch: version },
      )
    ).body.data;
  },
  async previewFormula(ws: string, body: unknown) {
    return (
      await api<{
        data: {
          result_type: string;
          source: string;
          depends_on: Array<{ id: string; name: string }>;
          sample_result: unknown;
          sample_error: string | null;
        };
      }>('POST', `${w(ws)}/fields:preview_formula`, { body })
    ).body.data;
  },
  async record(ws: string, rec: string) {
    return (await api<{ data: RecordFields }>('GET', `${w(ws)}/records/${rec}/fields`)).body.data;
  },
  async setValues(
    ws: string,
    rec: string,
    version: number,
    changes: Record<string, { base: unknown; value: unknown }>,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: RecordFields }>(
        'PATCH',
        `${w(ws)}/records/${rec}/fields`,
        { changes },
        stepUp,
        { ifMatch: version },
      )
    ).body.data;
  },
  async explain(ws: string, rec: string, fld: string) {
    return (
      await api<{
        data: {
          source: string;
          result: unknown;
          error: string | null;
          inputs: Array<{ id: string; name: string; has_value: boolean }>;
        };
      }>('GET', `${w(ws)}/records/${rec}/fields/${fld}/explain`)
    ).body.data;
  },
};

export const fieldSets = {
  async list(ws: string, scope: ScopeRef) {
    return (await api<{ data: FieldSet[] }>('GET', `${w(ws)}/field-sets?${q(scope)}`)).body.data;
  },
  async create(ws: string, body: unknown, stepUp: StepUpResolver) {
    return (await protectedRequest<{ data: FieldSet }>('POST', `${w(ws)}/field-sets`, body, stepUp))
      .body.data;
  },
  async patch(ws: string, fst: string, body: unknown, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: FieldSet }>(
        'PATCH',
        `${w(ws)}/field-sets/${fst}`,
        body,
        stepUp,
      )
    ).body.data;
  },
  async preview(ws: string, rec: string, set: string) {
    return (
      await api<{
        data: {
          from_version: number | null;
          to_version: number;
          fields_added: string[];
          fields_removed: string[];
          values_hidden: number;
        };
      }>('POST', `${w(ws)}/records/${rec}:preview_field_set`, { body: { set } })
    ).body.data;
  },
  async apply(ws: string, rec: string, set: string, version: number, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: RecordFields }>(
        'POST',
        `${w(ws)}/records/${rec}:apply_field_set`,
        { set, version },
        stepUp,
      )
    ).body.data;
  },
};

export const transitions = {
  async options(ws: string, rec: string) {
    return (
      await api<{
        data: {
          workflow: { id: string; name: string } | null;
          current: StatusView;
          options: Array<Evaluation & { status: StatusView }>;
        };
      }>('GET', `${w(ws)}/records/${rec}/transitions`)
    ).body.data;
  },
  async preview(ws: string, rec: string, body: unknown) {
    return (
      await api<{
        data: Evaluation & {
          preview_token: string | null;
          record_version: number;
          warnings: string[];
          approval_requests: Array<{ id: string; state: string; mine: boolean }>;
        };
      }>('POST', `${w(ws)}/records/${rec}:preview_transition`, { body })
    ).body.data;
  },
  async apply(ws: string, rec: string, body: unknown, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: { id: string; version: number } }>(
        'POST',
        `${w(ws)}/records/${rec}:transition`,
        body,
        stepUp,
      )
    ).body.data;
  },
  async requestApproval(ws: string, rec: string, body: unknown, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Approval }>(
        'POST',
        `${w(ws)}/records/${rec}:request_approval`,
        body,
        stepUp,
      )
    ).body.data;
  },
};

export const approvals = {
  async list(ws: string, mine?: 'requested') {
    return (
      await api<{ data: Approval[] }>('GET', `${w(ws)}/approvals${mine ? '?mine=requested' : ''}`)
    ).body.data;
  },
  async decide(
    ws: string,
    wap: string,
    decision: 'approve' | 'reject',
    note: string,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Approval }>(
        'POST',
        `${w(ws)}/approvals/${wap}:${decision}`,
        note ? { note } : {},
        stepUp,
      )
    ).body.data;
  },
  async withdraw(ws: string, wap: string, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: Approval }>(
        'POST',
        `${w(ws)}/approvals/${wap}:withdraw`,
        {},
        stepUp,
      )
    ).body.data;
  },
};
