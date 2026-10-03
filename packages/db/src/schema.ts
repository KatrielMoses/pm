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
  StepUpChallengeState,
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
  /** NULL for platform-scoped jobs (migration 0010). */
  workspace_id: string | null;
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
  /** NULL for account-level (platform-scoped) keys (migration 0010). */
  workspace_id: string | null;
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

type Ts = Timestamp;
type DTs = DefaultTimestamp;
type Bytes = ColumnType<Buffer, Buffer, Buffer>;

export interface AccountTable {
  id: string;
  public_id: string;
  primary_email: string;
  email_key: string;
  display_name: string;
  timezone: string;
  locale: string;
  day_start_offset: Defaulted<string>;
  email_verified_at: Ts | null;
  terms_version: string;
  privacy_version: string;
  legal_acknowledged_at: Ts;
  pseudonym: string | null;
  deleted_at: Ts | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}

export interface CredentialTable {
  account_id: string;
  password_hash: Bytes;
  password_salt: Bytes;
  algorithm: 'argon2id';
  params: Json<{ v: number; m: number; t: number; p: number; len: number }>;
  password_changed_at: DTs;
  failed_attempts: Defaulted<number>;
  last_failed_at: Ts | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}

export interface MfaFactorTable {
  id: string;
  public_id: string;
  account_id: string;
  factor_type: 'totp' | 'webauthn';
  state: Defaulted<'pending' | 'active' | 'revoked'>;
  label: string | null;
  secret_ref: string | null;
  webauthn_credential_id: Bytes | null;
  webauthn_public_key: Bytes | null;
  webauthn_sign_count: number | null;
  last_used_step: number | null;
  created_at: DTs;
  verified_at: Ts | null;
  last_used_at: Ts | null;
  revoked_at: Ts | null;
  updated_at: DTs;
  version: Defaulted<number>;
}

export interface RecoveryCodeTable {
  id: string;
  account_id: string;
  generation: number;
  code_hash: Bytes;
  created_at: DTs;
  used_at: Ts | null;
  revoked_at: Ts | null;
}

export type AuthMethod = 'password' | 'totp' | 'recovery_code' | 'oauth' | 'webauthn';

export interface SessionTable {
  id: string;
  public_id: string;
  account_id: string;
  token_hash: Bytes;
  created_at: DTs;
  last_seen_at: DTs;
  idle_expires_at: Ts;
  absolute_expires_at: Ts;
  revoked_at: Ts | null;
  revoke_reason: string | null;
  auth_methods: AuthMethod[];
  assurance: 'single_factor' | 'multi_factor';
  mfa_verified_at: Ts | null;
  rotated_from_session_id: string | null;
  device_label: string | null;
  network_prefix: string | null;
  version: Defaulted<number>;
}

export interface OauthIdentityTable {
  id: string;
  public_id: string;
  account_id: string;
  provider: string;
  subject: string;
  provider_email: string | null;
  provider_display_name: string | null;
  state: Defaulted<'linked' | 'unlinked'>;
  linked_at: DTs;
  unlinked_at: Ts | null;
  last_sign_in_at: Ts | null;
  version: Defaulted<number>;
}

export type TokenPurpose =
  'email_verification' | 'password_reset' | 'sign_in_continuation' | 'oauth_state';

export interface VerificationTokenTable {
  id: string;
  purpose: TokenPurpose;
  account_id: string | null;
  token_hash: Bytes;
  created_at: DTs;
  expires_at: Ts;
  consumed_at: Ts | null;
  revoked_at: Ts | null;
  attempts: Defaulted<number>;
  supersedes_token_id: string | null;
  context: ColumnType<Record<string, unknown>, string | undefined, string>;
  sealed_ref: string | null;
}

export type StepUpMethod = 'password' | 'totp' | 'webauthn' | 'recovery_code';

export interface StepUpChallengeTable {
  id: string;
  public_id: string;
  account_id: string;
  session_id: string;
  membership_id: string | null;
  workspace_id: string | null;
  action_key: string;
  target_type: string | null;
  target_hash: Bytes | null;
  methods: StepUpMethod[];
  state: Defaulted<StepUpChallengeState>;
  challenge_nonce_hash: Bytes;
  token_hash: Bytes | null;
  idempotency_key_hash: Bytes | null;
  expires_at: Ts;
  verified_at: Ts | null;
  verified_method: string | null;
  token_expires_at: Ts | null;
  consumed_at: Ts | null;
  cancelled_at: Ts | null;
  failed_attempts: Defaulted<number>;
  locked_at: Ts | null;
  created_at: DTs;
  version: Defaulted<number>;
}

export interface MailDeliveryTable {
  id: string;
  template: string;
  recipient: string | null;
  locale: string;
  account_id: string | null;
  sealed_ref: string | null;
  state: Defaulted<'pending' | 'sent' | 'failed'>;
  attempts: Defaulted<number>;
  provider_message_id: string | null;
  request_id: string | null;
  correlation_id: string;
  traceparent: string | null;
  created_at: DTs;
  sent_at: Ts | null;
}

export interface SecurityEventBufferTable {
  id: string;
  occurred_at: DTs;
  category: string;
  action: string;
  outcome: 'success' | 'failure' | 'denied';
  actor_type: ActorType;
  actor_id: string | null;
  subject_type: string | null;
  subject_id: string | null;
  workspace_id: string | null;
  network_prefix: string | null;
  user_agent_family: string | null;
  correlation_id: string;
  retention_class: Defaulted<'R-AUDIT'>;
}

export interface RateLimitBucketTable {
  policy: string;
  key_hash: Bytes;
  window_start: Ts;
  hits: number;
  strikes: Defaulted<number>;
  blocked_until: Ts | null;
  updated_at: DTs;
}

export interface DevSecretVaultTable {
  ref: string;
  purpose: string;
  nonce: Bytes;
  ciphertext: Bytes;
  auth_tag: Bytes;
  created_at: DTs;
  expires_at: Ts | null;
}

// ---------------------------------------------------------------------------------------------
// Phase 1F: audit, core, governance, recovery
// ---------------------------------------------------------------------------------------------

export type ChangeClass = 'plain' | 'content' | 'personal' | 'secret' | 'credential_ref';
export type RedactionReason = 'purge' | 'account_deletion' | 'privacy_request' | 'legal_request';
/** One stored audit change entry (0D §12.1); `digest` fingerprints the entry before redaction. */
export type StoredChange = {
  field: string;
  class: ChangeClass;
  digest: string;
  old?: unknown;
  new?: unknown;
  hash?: string;
  version_ref?: string;
  changed?: true;
  redacted?: true;
  reason?: RedactionReason;
};
export type SourceKind =
  | 'ui'
  | 'api'
  | 'paste'
  | 'voice'
  | 'email'
  | 'form'
  | 'webhook'
  | 'import'
  | 'integration'
  | 'ai_proposal'
  | 'automation'
  | 'agent'
  | 'template'
  | 'system';

export interface AuditEventTable {
  id: string;
  occurred_at: Ts;
  workspace_id: string;
  brand_id: string | null;
  action: string;
  actor_type: ActorType;
  actor_id: string | null;
  on_behalf_of_membership_id: string | null;
  delegation_chain: Json<Array<{ type: string; id: string }>>;
  target_record_id: string | null;
  target_type: string;
  target_public_id: string | null;
  changes: Json<StoredChange[]>;
  operation_id: string | null;
  attempt_id: string | null;
  correlation_id: string;
  causation_id: string | null;
  source_kind: SourceKind;
  source_ref: string | null;
  workflow_revision_id: string | null;
  retention_class: Defaulted<'R-AUDIT'>;
  chain_seq: ColumnType<string, string | number | bigint, never>;
  prev_hash: Bytes;
  hash: Bytes;
}

export interface AuditRedactionTable {
  id: string;
  redacted_at: DTs;
  workspace_id: string;
  audit_event_id: string;
  audit_event_occurred_at: Ts;
  fields: string[];
  reason: RedactionReason;
  authorized_by_type: ActorType;
  authorized_by_id: string | null;
  operation_id: string;
  correlation_id: string;
}

export interface SecurityEventTable {
  id: string;
  occurred_at: DTs;
  category: string;
  action: string;
  outcome: 'success' | 'failure' | 'denied';
  actor_type: ActorType;
  actor_id: string | null;
  subject_type: string | null;
  subject_id: string | null;
  workspace_id: string | null;
  network_prefix: string | null;
  user_agent_family: string | null;
  correlation_id: string;
  retention_class: Defaulted<'R-AUDIT'>;
}

export interface ChainCheckpointTable {
  id: string;
  recorded_at: DTs;
  workspace_id: string;
  chain_seq: ColumnType<string, string | number | bigint, never>;
  hash: Bytes;
}

export interface ActivityItemTable {
  id: string;
  created_at: DTs;
  workspace_id: string;
  brand_id: string | null;
  project_id: string | null;
  target_record_id: string;
  related_record_id: string | null;
  audit_event_id: string;
  occurred_at: Ts;
  summary_key: string;
  display_values: Json<Record<string, string | number | boolean | null>>;
  group_key: string | null;
}

export interface BufferVerificationTable {
  id: string;
  verified_at: DTs;
  outcome: 'verified' | 'mismatch';
  buffer_count: ColumnType<string, string | number | bigint, never>;
  sink_count: ColumnType<string, string | number | bigint, never>;
  buffer_digest: string;
  sink_digest: string;
  per_day: Json<Array<{ day: string; buffer: number; sink: number }>>;
}

export type LifecycleState = 'active' | 'archived' | 'trashed' | 'purged';
export type ArchiveCause = 'self' | 'cascade';
export type DeletionBatchState = 'trashed' | 'restoring' | 'restored' | 'purging' | 'purged';

export interface RecordTypeTable {
  record_type: string;
  public_id_prefix: string;
  owner_module: string;
  test_only: Defaulted<boolean>;
}

export interface RecordTable {
  id: string;
  public_id: string;
  record_type: string;
  workspace_id: string;
  brand_id: string | null;
  scope_key: ColumnType<string, never, never>;
  owner_membership_id: string | null;
  lifecycle_state: Defaulted<LifecycleState>;
  archive_cause: ArchiveCause | null;
  archive_batch_id: string | null;
  archived_at: Ts | null;
  archived_by_type: ActorType | null;
  archived_by_id: string | null;
  deletion_batch_id: string | null;
  prior_lifecycle_state: LifecycleState | null;
  trashed_at: Ts | null;
  trashed_by_type: ActorType | null;
  trashed_by_id: string | null;
  purged_at: Ts | null;
  source_kind: SourceKind;
  source_ref: string | null;
  template_installation_id: string | null;
  created_at: DTs;
  created_by_actor_type: ActorType;
  created_by_actor_id: string | null;
  updated_at: DTs;
  version: ColumnType<string, string | number | undefined, string | number>;
}

export interface ArchiveBatchTable {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  root_record_id: string;
  state: Defaulted<'archived' | 'restored'>;
  member_count: number;
  archived_at: DTs;
  archived_by_type: ActorType;
  archived_by_id: string | null;
  restored_at: Ts | null;
  restored_by_type: ActorType | null;
  restored_by_id: string | null;
  operation_id: string | null;
  correlation_id: string;
  version: ColumnType<string, string | number | undefined, string | number>;
}

export interface ArchiveBatchMemberTable {
  workspace_id: string;
  batch_id: string;
  record_id: string;
  cause: ArchiveCause;
}

export type DeletionBlockResult =
  | 'hold'
  | 'evidence_lock_partial'
  | 'evidence_lock_all'
  | 'missing_purge_hook'
  | 'ledger_unavailable';

export interface DeletionBatchTable {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  scope_key: ColumnType<string, never, never>;
  root_record_id: string;
  state: Defaulted<DeletionBatchState>;
  trashed_at: DTs;
  trashed_by_type: ActorType;
  trashed_by_id: string | null;
  restore_location: Json<{ container_record_id?: string | null; container_type?: string | null }>;
  member_count: number;
  hold: Defaulted<boolean>;
  evidence_locked_count: Defaulted<number>;
  block_result: DeletionBlockResult | null;
  operation_id: string | null;
  restored_at: Ts | null;
  restored_by_type: ActorType | null;
  restored_by_id: string | null;
  purge_started_at: Ts | null;
  purged_at: Ts | null;
  ledger_entry_id: string | null;
  ledger_acknowledged_at: Ts | null;
  terminal_outcome: 'restored' | 'purged' | 'purged_with_exclusions' | null;
  correlation_id: string;
  /** Residual batch lineage: the batch this one was split from, and the purge that split it. */
  split_from_batch_id: string | null;
  split_operation_id: string | null;
  version: ColumnType<string, string | number | undefined, string | number>;
}

export interface DeletionBatchMemberTable {
  workspace_id: string;
  batch_id: string;
  record_id: string;
  record_type: string;
  prior_lifecycle_state: LifecycleState;
  depth: number;
  outcome: Defaulted<'pending' | 'restored' | 'purged' | 'moved_to_successor'>;
  /** Set when a residual (evidence-locked) member moved to a successor batch. */
  successor_batch_id: string | null;
}

export type RetentionClass =
  | 'R-LIVE'
  | 'R-EVIDENCE'
  | 'R-AUDIT'
  | 'R-EXEC'
  | 'R-PERSONAL'
  | 'R-BILLING'
  | 'R-DERIVED'
  | 'R-EPHEMERAL'
  | 'R-PLATFORM';

export interface RetentionPolicyTable {
  id: string;
  workspace_id: string;
  retention_class: RetentionClass;
  period: string | null;
  source: 'plan' | 'workspace';
  effective_from: DTs;
  created_at: DTs;
  version: Defaulted<number>;
}

export interface RecoveryGateTable {
  id: Defaulted<number>;
  state: Defaulted<'open' | 'replay_required'>;
  backup_point: Ts | null;
  replayed_through: Ts | null;
  updated_at: DTs;
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
  'ops.rate_limit_bucket': RateLimitBucketTable;
  'ops.dev_secret_vault': DevSecretVaultTable;
  'identity.account': AccountTable;
  'identity.credential': CredentialTable;
  'identity.mfa_factor': MfaFactorTable;
  'identity.recovery_code': RecoveryCodeTable;
  'identity.session': SessionTable;
  'identity.oauth_identity': OauthIdentityTable;
  'identity.verification_token': VerificationTokenTable;
  'identity.step_up_challenge': StepUpChallengeTable;
  'identity.mail_delivery': MailDeliveryTable;
  'identity.security_event_buffer': SecurityEventBufferTable;
  'audit.audit_event': AuditEventTable;
  'audit.audit_redaction': AuditRedactionTable;
  'audit.security_event': SecurityEventTable;
  'audit.chain_checkpoint': ChainCheckpointTable;
  'audit.activity_item': ActivityItemTable;
  'audit.buffer_verification': BufferVerificationTable;
  'core.record_type': RecordTypeTable;
  'core.record': RecordTable;
  'core.archive_batch': ArchiveBatchTable;
  'core.archive_batch_member': ArchiveBatchMemberTable;
  'core.deletion_batch': DeletionBatchTable;
  'core.deletion_batch_member': DeletionBatchMemberTable;
  'governance.retention_policy': RetentionPolicyTable;
  'ops.recovery_gate': RecoveryGateTable;
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
  'ops.rate_limit_bucket': [
    'policy',
    'key_hash',
    'window_start',
    'hits',
    'strikes',
    'blocked_until',
    'updated_at',
  ],
  'ops.dev_secret_vault': [
    'ref',
    'purpose',
    'nonce',
    'ciphertext',
    'auth_tag',
    'created_at',
    'expires_at',
  ],
  'identity.account': [
    'id',
    'public_id',
    'primary_email',
    'email_key',
    'display_name',
    'timezone',
    'locale',
    'day_start_offset',
    'email_verified_at',
    'terms_version',
    'privacy_version',
    'legal_acknowledged_at',
    'pseudonym',
    'deleted_at',
    'created_at',
    'updated_at',
    'version',
  ],
  'identity.credential': [
    'account_id',
    'password_hash',
    'password_salt',
    'algorithm',
    'params',
    'password_changed_at',
    'failed_attempts',
    'last_failed_at',
    'created_at',
    'updated_at',
    'version',
  ],
  'identity.mfa_factor': [
    'id',
    'public_id',
    'account_id',
    'factor_type',
    'state',
    'label',
    'secret_ref',
    'webauthn_credential_id',
    'webauthn_public_key',
    'webauthn_sign_count',
    'last_used_step',
    'created_at',
    'verified_at',
    'last_used_at',
    'revoked_at',
    'updated_at',
    'version',
  ],
  'identity.recovery_code': [
    'id',
    'account_id',
    'generation',
    'code_hash',
    'created_at',
    'used_at',
    'revoked_at',
  ],
  'identity.session': [
    'id',
    'public_id',
    'account_id',
    'token_hash',
    'created_at',
    'last_seen_at',
    'idle_expires_at',
    'absolute_expires_at',
    'revoked_at',
    'revoke_reason',
    'auth_methods',
    'assurance',
    'mfa_verified_at',
    'rotated_from_session_id',
    'device_label',
    'network_prefix',
    'version',
  ],
  'identity.oauth_identity': [
    'id',
    'public_id',
    'account_id',
    'provider',
    'subject',
    'provider_email',
    'provider_display_name',
    'state',
    'linked_at',
    'unlinked_at',
    'last_sign_in_at',
    'version',
  ],
  'identity.verification_token': [
    'id',
    'purpose',
    'account_id',
    'token_hash',
    'created_at',
    'expires_at',
    'consumed_at',
    'revoked_at',
    'attempts',
    'supersedes_token_id',
    'context',
    'sealed_ref',
  ],
  'identity.step_up_challenge': [
    'id',
    'public_id',
    'account_id',
    'session_id',
    'membership_id',
    'workspace_id',
    'action_key',
    'target_type',
    'target_hash',
    'methods',
    'state',
    'challenge_nonce_hash',
    'token_hash',
    'idempotency_key_hash',
    'expires_at',
    'verified_at',
    'verified_method',
    'token_expires_at',
    'consumed_at',
    'cancelled_at',
    'failed_attempts',
    'locked_at',
    'created_at',
    'version',
  ],
  'identity.mail_delivery': [
    'id',
    'template',
    'recipient',
    'locale',
    'account_id',
    'sealed_ref',
    'state',
    'attempts',
    'provider_message_id',
    'request_id',
    'correlation_id',
    'traceparent',
    'created_at',
    'sent_at',
  ],
  'identity.security_event_buffer': [
    'id',
    'occurred_at',
    'category',
    'action',
    'outcome',
    'actor_type',
    'actor_id',
    'subject_type',
    'subject_id',
    'workspace_id',
    'network_prefix',
    'user_agent_family',
    'correlation_id',
    'retention_class',
  ],
  'audit.audit_event': [
    'id',
    'occurred_at',
    'workspace_id',
    'brand_id',
    'action',
    'actor_type',
    'actor_id',
    'on_behalf_of_membership_id',
    'delegation_chain',
    'target_record_id',
    'target_type',
    'target_public_id',
    'changes',
    'operation_id',
    'attempt_id',
    'correlation_id',
    'causation_id',
    'source_kind',
    'source_ref',
    'workflow_revision_id',
    'retention_class',
    'chain_seq',
    'prev_hash',
    'hash',
  ],
  'audit.audit_redaction': [
    'id',
    'redacted_at',
    'workspace_id',
    'audit_event_id',
    'audit_event_occurred_at',
    'fields',
    'reason',
    'authorized_by_type',
    'authorized_by_id',
    'operation_id',
    'correlation_id',
  ],
  'audit.security_event': [
    'id',
    'occurred_at',
    'category',
    'action',
    'outcome',
    'actor_type',
    'actor_id',
    'subject_type',
    'subject_id',
    'workspace_id',
    'network_prefix',
    'user_agent_family',
    'correlation_id',
    'retention_class',
  ],
  'audit.chain_checkpoint': ['id', 'recorded_at', 'workspace_id', 'chain_seq', 'hash'],
  'audit.activity_item': [
    'id',
    'created_at',
    'workspace_id',
    'brand_id',
    'project_id',
    'target_record_id',
    'related_record_id',
    'audit_event_id',
    'occurred_at',
    'summary_key',
    'display_values',
    'group_key',
  ],
  'audit.buffer_verification': [
    'id',
    'verified_at',
    'outcome',
    'buffer_count',
    'sink_count',
    'buffer_digest',
    'sink_digest',
    'per_day',
  ],
  'core.record_type': ['record_type', 'public_id_prefix', 'owner_module', 'test_only'],
  'core.record': [
    'id',
    'public_id',
    'record_type',
    'workspace_id',
    'brand_id',
    'scope_key',
    'owner_membership_id',
    'lifecycle_state',
    'archive_cause',
    'archive_batch_id',
    'archived_at',
    'archived_by_type',
    'archived_by_id',
    'deletion_batch_id',
    'prior_lifecycle_state',
    'trashed_at',
    'trashed_by_type',
    'trashed_by_id',
    'purged_at',
    'source_kind',
    'source_ref',
    'template_installation_id',
    'created_at',
    'created_by_actor_type',
    'created_by_actor_id',
    'updated_at',
    'version',
  ],
  'core.archive_batch': [
    'id',
    'workspace_id',
    'brand_id',
    'root_record_id',
    'state',
    'member_count',
    'archived_at',
    'archived_by_type',
    'archived_by_id',
    'restored_at',
    'restored_by_type',
    'restored_by_id',
    'operation_id',
    'correlation_id',
    'version',
  ],
  'core.archive_batch_member': ['workspace_id', 'batch_id', 'record_id', 'cause'],
  'core.deletion_batch': [
    'id',
    'workspace_id',
    'brand_id',
    'scope_key',
    'root_record_id',
    'state',
    'trashed_at',
    'trashed_by_type',
    'trashed_by_id',
    'restore_location',
    'member_count',
    'hold',
    'evidence_locked_count',
    'block_result',
    'operation_id',
    'restored_at',
    'restored_by_type',
    'restored_by_id',
    'purge_started_at',
    'purged_at',
    'ledger_entry_id',
    'ledger_acknowledged_at',
    'terminal_outcome',
    'correlation_id',
    'version',
    'split_from_batch_id',
    'split_operation_id',
  ],
  'core.deletion_batch_member': [
    'workspace_id',
    'batch_id',
    'record_id',
    'record_type',
    'prior_lifecycle_state',
    'depth',
    'outcome',
    'successor_batch_id',
  ],
  'governance.retention_policy': [
    'id',
    'workspace_id',
    'retention_class',
    'period',
    'source',
    'effective_from',
    'created_at',
    'version',
  ],
  'ops.recovery_gate': ['id', 'state', 'backup_point', 'replayed_through', 'updated_at'],
};
