import type { ColumnType, Generated } from 'kysely';
import type {
  ActorType,
  DataClass,
  EffectDestinationClass,
  EffectState,
  ExecState,
  IdempotencyState,
  JobErrorClass,
  JobState,
  RiskClass,
  TerminalReason,
  WaitingReason,
} from '@pm/contracts';

// Typed view of the reviewed SQL migrations. The SQL is authoritative; `test/schema-drift`
// compares these column lists with the migrated catalog.

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json<T> = ColumnType<T, string, string>;
type Defaulted<T> = ColumnType<T, T | undefined, T>;

export interface ContextColumns {
  authenticated_principal_type: string;
  authenticated_principal_id: string;
  effective_principal_type: string;
  effective_principal_id: string;
  initiating_membership_id: string | null;
  delegation_chain: Json<unknown[]>;
  selected_scope: ColumnType<Record<string, unknown>, string | undefined, string>;
  workspace_epoch_at_enqueue: number;
  principal_epoch_at_enqueue: number;
  agent_class_epoch_at_enqueue: number | null;
  risk_action_key: string | null;
  risk_class: RiskClass | null;
  approval_class: string | null;
  approval_id: string | null;
  step_up_id: string | null;
  data_class_limit: DataClass;
  locale: string | null;
  timezone: string | null;
  request_id: string | null;
  traceparent: string | null;
  correlation_id: string;
  causation_id: string | null;
}

export interface WorkspaceTable {
  id: string;
  public_id: string;
  name: string;
  timezone: string;
  locale: string;
  currency: string;
  week_start: number;
  state: Defaulted<'active' | 'read_only' | 'deletion_pending' | 'purging'>;
  deletion_requested_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
  created_by_actor_type: ActorType;
  created_by_actor_id: string | null;
  updated_by_actor_type: ActorType;
  updated_by_actor_id: string | null;
  version: Defaulted<number>;
}

export interface OperationTable extends ContextColumns {
  id: string;
  workspace_id: string;
  public_id: string;
  kind: string;
  execution_state: Defaulted<ExecState>;
  terminal_reason: TerminalReason | null;
  waiting_reason: WaitingReason | null;
  outcome_detail: Json<Record<string, unknown>> | null;
  dedupe_key: string | null;
  rerun_of_operation_id: string | null;
  started_at: Timestamp | null;
  ended_at: Timestamp | null;
  cancel_requested_at: Timestamp | null;
  progress_phase: string | null;
  progress_completed: Defaulted<number>;
  progress_total: number | null;
  progress_unit: string | null;
  progress_estimated: Defaulted<boolean>;
  initiated_by_actor_type: ActorType;
  initiated_by_id: string | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
  version: Defaulted<number>;
}

export interface AttemptTable {
  id: string;
  workspace_id: string;
  public_id: string;
  operation_id: string;
  job_id: string | null;
  attempt_number: number;
  execution_state: Defaulted<ExecState>;
  terminal_reason: TerminalReason | null;
  error_class: JobErrorClass | null;
  error_detail: Json<Record<string, unknown>> | null;
  worker_lost: Defaulted<boolean>;
  started_at: DefaultTimestamp;
  ended_at: Timestamp | null;
  created_at: DefaultTimestamp;
}

export interface JobTable extends ContextColumns {
  id: string;
  workspace_id: string;
  queue: string;
  kind: string;
  operation_id: string | null;
  state: Defaulted<JobState>;
  run_at: DefaultTimestamp;
  attempts: Defaulted<number>;
  max_attempts: number;
  timeout_seconds: number;
  dedupe_key: string | null;
  payload_ref: string | null;
  lease_token: string | null;
  lease_owner: string | null;
  lease_until: Timestamp | null;
  heartbeat_at: Timestamp | null;
  completed_steps: Defaulted<string[]>;
  checkpoint: Json<Record<string, unknown>> | null;
  last_error: Json<{ class: JobErrorClass; code?: string }> | null;
  last_error_class: JobErrorClass | null;
  cancel_requested_at: Timestamp | null;
  finished_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface OutboxEventTable {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  event_type: string;
  schema_version: number;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_sequence: number;
  payload: Json<Record<string, unknown>>;
  max_class: DataClass;
  operation_id: string | null;
  attempt_id: string | null;
  actor_type: ActorType;
  actor_id: string | null;
  on_behalf_of_membership_id: string | null;
  workspace_epoch: number;
  delegation_depth: number | null;
  public_event_id: string | null;
  correlation_id: string;
  causation_id: string | null;
  traceparent: string | null;
  occurred_at: Timestamp;
  recorded_at: DefaultTimestamp;
  dispatched_at: Timestamp | null;
  dispatch_lease_until: Timestamp | null;
  dispatch_attempts: Defaulted<number>;
}

export interface InboxReceiptTable {
  consumer_name: string;
  event_id: string;
  workspace_id: string;
  processed_at: DefaultTimestamp;
}

export interface IdempotencyKeyTable {
  id: string;
  workspace_id: string;
  principal_type: string;
  principal_id: string;
  key: string;
  request_fingerprint: Buffer;
  state: Defaulted<IdempotencyState>;
  operation_id: string | null;
  response_status: number | null;
  response_ref: Json<Record<string, unknown>> | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
  expires_at: Timestamp;
}

export interface ExternalEffectTable {
  id: string;
  workspace_id: string;
  operation_id: string;
  effect_key: string;
  destination_class: EffectDestinationClass;
  state: Defaulted<EffectState>;
  provider_idempotency_key: string | null;
  external_ref: string | null;
  attempt_count: Defaulted<number>;
  last_attempt_id: string | null;
  reconciliation_decision: 'sent' | 'retry' | 'abandon' | null;
  reconciled_by_actor_type: ActorType | null;
  reconciled_by: string | null;
  reconciled_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
  version: Defaulted<number>;
}

export interface SchemaMigrationTable {
  version: number;
  name: string;
  phase: 'expand' | 'contract';
  checksum: string;
  down_checksum: string;
  chain_hash: string;
  applied_at: DefaultTimestamp;
  applied_by: Generated<string>;
  execution_ms: number;
}

export interface WorkerHeartbeatTable {
  worker_id: string;
  role: string;
  build_id: string;
  started_at: DefaultTimestamp;
  last_seen_at: DefaultTimestamp;
  stopping: Defaulted<boolean>;
}

export interface Database {
  'tenancy.workspace': WorkspaceTable;
  'exec.operation': OperationTable;
  'exec.attempt': AttemptTable;
  'exec.job': JobTable;
  'exec.outbox_event': OutboxEventTable;
  'exec.inbox_receipt': InboxReceiptTable;
  'exec.idempotency_key': IdempotencyKeyTable;
  'exec.external_effect': ExternalEffectTable;
  'ops.schema_migration': SchemaMigrationTable;
  'ops.worker_heartbeat': WorkerHeartbeatTable;
}

/** Column inventory per table, compared with the migrated catalog by the schema-drift test. */
export const TABLE_COLUMNS: Readonly<Record<keyof Database, readonly string[]>> = {
  'tenancy.workspace': [
    'id',
    'public_id',
    'name',
    'timezone',
    'locale',
    'currency',
    'week_start',
    'state',
    'deletion_requested_at',
    'created_at',
    'updated_at',
    'created_by_actor_type',
    'created_by_actor_id',
    'updated_by_actor_type',
    'updated_by_actor_id',
    'version',
  ],
  'exec.operation': [
    'id',
    'workspace_id',
    'public_id',
    'kind',
    'execution_state',
    'terminal_reason',
    'waiting_reason',
    'outcome_detail',
    'dedupe_key',
    'rerun_of_operation_id',
    'started_at',
    'ended_at',
    'cancel_requested_at',
    'progress_phase',
    'progress_completed',
    'progress_total',
    'progress_unit',
    'progress_estimated',
    'initiated_by_actor_type',
    'initiated_by_id',
    'authenticated_principal_type',
    'authenticated_principal_id',
    'effective_principal_type',
    'effective_principal_id',
    'initiating_membership_id',
    'delegation_chain',
    'selected_scope',
    'workspace_epoch_at_enqueue',
    'principal_epoch_at_enqueue',
    'agent_class_epoch_at_enqueue',
    'risk_action_key',
    'risk_class',
    'approval_class',
    'approval_id',
    'step_up_id',
    'data_class_limit',
    'locale',
    'timezone',
    'request_id',
    'correlation_id',
    'causation_id',
    'traceparent',
    'created_at',
    'updated_at',
    'version',
  ],
  'exec.attempt': [
    'id',
    'workspace_id',
    'public_id',
    'operation_id',
    'job_id',
    'attempt_number',
    'execution_state',
    'terminal_reason',
    'error_class',
    'error_detail',
    'worker_lost',
    'started_at',
    'ended_at',
    'created_at',
  ],
  'exec.job': [
    'id',
    'workspace_id',
    'queue',
    'kind',
    'operation_id',
    'state',
    'run_at',
    'attempts',
    'max_attempts',
    'timeout_seconds',
    'dedupe_key',
    'payload_ref',
    'lease_token',
    'lease_owner',
    'lease_until',
    'heartbeat_at',
    'completed_steps',
    'checkpoint',
    'last_error',
    'last_error_class',
    'cancel_requested_at',
    'finished_at',
    'authenticated_principal_type',
    'authenticated_principal_id',
    'effective_principal_type',
    'effective_principal_id',
    'initiating_membership_id',
    'delegation_chain',
    'selected_scope',
    'workspace_epoch_at_enqueue',
    'principal_epoch_at_enqueue',
    'agent_class_epoch_at_enqueue',
    'risk_action_key',
    'risk_class',
    'approval_class',
    'approval_id',
    'step_up_id',
    'data_class_limit',
    'locale',
    'timezone',
    'request_id',
    'traceparent',
    'correlation_id',
    'causation_id',
    'created_at',
    'updated_at',
  ],
  'exec.outbox_event': [
    'id',
    'workspace_id',
    'brand_id',
    'event_type',
    'schema_version',
    'aggregate_type',
    'aggregate_id',
    'aggregate_sequence',
    'payload',
    'max_class',
    'operation_id',
    'attempt_id',
    'actor_type',
    'actor_id',
    'on_behalf_of_membership_id',
    'workspace_epoch',
    'delegation_depth',
    'public_event_id',
    'correlation_id',
    'causation_id',
    'traceparent',
    'occurred_at',
    'recorded_at',
    'dispatched_at',
    'dispatch_lease_until',
    'dispatch_attempts',
  ],
  'exec.inbox_receipt': ['consumer_name', 'event_id', 'workspace_id', 'processed_at'],
  'exec.idempotency_key': [
    'id',
    'workspace_id',
    'principal_type',
    'principal_id',
    'key',
    'request_fingerprint',
    'state',
    'operation_id',
    'response_status',
    'response_ref',
    'created_at',
    'updated_at',
    'expires_at',
  ],
  'exec.external_effect': [
    'id',
    'workspace_id',
    'operation_id',
    'effect_key',
    'destination_class',
    'state',
    'provider_idempotency_key',
    'external_ref',
    'attempt_count',
    'last_attempt_id',
    'reconciliation_decision',
    'reconciled_by_actor_type',
    'reconciled_by',
    'reconciled_at',
    'created_at',
    'updated_at',
    'version',
  ],
  'ops.schema_migration': [
    'version',
    'name',
    'phase',
    'checksum',
    'down_checksum',
    'chain_hash',
    'applied_at',
    'applied_by',
    'execution_ms',
  ],
  'ops.worker_heartbeat': [
    'worker_id',
    'role',
    'build_id',
    'started_at',
    'last_seen_at',
    'stopping',
  ],
};
