import type { ColumnType, Generated } from 'kysely';
import type {
  ActorType,
  BrandNotificationContentMode,
  BrandOperationalStatus,
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
  logo_file_ref: string | null;
  creation_key_hash: Buffer | null;
  creation_request_hash: Buffer | null;
  bootstrap_account_id: string | null;
  bootstrap_membership_id: string | null;
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
  /** 0061: sha256 of the registered destination and its contract (null only before 0061). */
  destination_fingerprint: string | null;
  /** 0061: the current claim (set only while `dispatching`). */
  claim_token: string | null;
  /** 0061: when the last claim was taken (a claim means the effect may have left). */
  claimed_at: Timestamp | null;
  /** 0061: the claim lease; after it (or the claimant's attempt ending) the claim is abandoned. */
  claim_until: Timestamp | null;
  /** 0061: the typed proof code of a `failed` (not sent) outcome. */
  not_sent_code: 'refused_before_send' | 'rejected_by_receiver' | 'precondition_failed' | null;
  /** 0061: why an outcome is unknown. */
  uncertainty_reason:
    'outcome_unknown' | 'unproven_failure' | 'abandoned_claim' | 'legacy_attempted' | null;
  /** 0061: an outcome a stale claimant reported after its claim ended (evidence only). */
  late_outcome: 'sent' | 'unknown' | 'failed' | null;
  late_outcome_at: Timestamp | null;
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
  | 'email_verification'
  | 'password_reset'
  | 'sign_in_continuation'
  | 'oauth_state'
  | 'invitation_acceptance';

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
  key_id: Defaulted<number>;
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
  | 'mcp'
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

export type MembershipKind = 'member' | 'guest';
export type MembershipState = 'invited' | 'active' | 'suspended' | 'removed';

export interface MembershipTable {
  id: string;
  public_id: string;
  workspace_id: string;
  account_id: string;
  kind: MembershipKind;
  state: MembershipState;
  display_name_override: string | null;
  invited_at: Ts | null;
  joined_at: Ts | null;
  suspended_at: Ts | null;
  removed_at: Ts | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
  departure_reason: 'removed' | 'left' | 'account_deleted' | null;
  state_changed_by_membership_id: string | null;
}

export type RoleKind = 'workspace_role' | 'scope_level';

export interface RoleTable {
  id: string;
  workspace_id: string;
  key: string;
  kind: RoleKind;
  level: string | null;
  builtin: Defaulted<boolean>;
  created_at: DTs;
  version: Defaulted<number>;
}

export type GrantSource =
  | 'bootstrap_owner'
  | 'brand_creator'
  | 'sensitivity_creator'
  | 'assigned'
  | 'elevation'
  | 'project_manager';

export interface RoleAssignmentTable {
  id: string;
  workspace_id: string;
  principal_type: 'membership' | 'team';
  principal_id: string;
  membership_principal_id: Generated<string | null>;
  team_principal_id: Generated<string | null>;
  scope_type: 'workspace' | 'brand' | 'project';
  scope_id: string;
  brand_scope_id: Generated<string | null>;
  project_scope_id: Generated<string | null>;
  role_id: string;
  role_kind: RoleKind;
  grant_source: GrantSource;
  granted_by_membership_id: string | null;
  expires_at: Ts | null;
  elevated: Defaulted<boolean>;
  elevation_reason: string | null;
  elevation_step_up_id: string | null;
  created_at: DTs;
  version: Defaulted<number>;
}

export interface PermissionEpochTable {
  workspace_id: string;
  epoch_kind: 'workspace' | 'principal' | 'agent_class';
  subject_id: string | null;
  epoch: Defaulted<number>;
  bumped_at: DTs;
}

export type { BrandOperationalStatus } from '@pm/contracts';
export type NotificationContentMode = BrandNotificationContentMode;

export interface BrandTable {
  id: string;
  workspace_id: string;
  scope_key: string;
  lifecycle_state: Defaulted<LifecycleState>;
  name: string;
  short_name: string | null;
  logo_file_ref: string | null;
  color: string;
  icon: string;
  description: string | null;
  operational_status: Defaulted<BrandOperationalStatus>;
  timezone: string;
  is_sensitive: Defaulted<boolean>;
  notification_content_mode: Defaulted<NotificationContentMode>;
  created_at: DTs;
  created_by_membership_id: string;
  updated_at: DTs;
  updated_by_membership_id: string | null;
  version: Defaulted<number>;
}

export interface BrandSettingTable {
  workspace_id: string;
  brand_id: string;
  working_hours: Json<Record<string, unknown>>;
  calendar: Json<Record<string, unknown>>;
  priorities: Json<Record<string, unknown>>;
  notification_settings: Json<Record<string, unknown>> | null;
  ai_settings: Json<Record<string, unknown>> | null;
  integration_settings: Json<Record<string, unknown>> | null;
  updated_at: DTs;
  updated_by_membership_id: string | null;
  version: Defaulted<number>;
}

export interface ScopePreferenceTable {
  workspace_id: string;
  owner_membership_id: string;
  scope_kind: 'brand' | 'all';
  brand_id: string | null;
  updated_at: DTs;
}

export type ShareLevel = 'read' | 'comment' | 'edit';
export type ShareState = 'active' | 'revoked' | 'expired';
export type GranteeType = 'brand' | 'membership' | 'team';

export interface TeamTable {
  id: string;
  workspace_id: string;
  scope_key: string;
  lifecycle_state: Defaulted<LifecycleState>;
  name: string;
  description: string | null;
  created_by_membership_id: string;
  created_at: DTs;
  updated_at: DTs;
  updated_by_membership_id: string | null;
  version: Defaulted<number>;
}

export interface TeamMemberTable {
  workspace_id: string;
  team_id: string;
  membership_id: string;
  added_by_membership_id: string;
  created_at: DTs;
}

export interface WorkspacePolicyTable {
  workspace_id: string;
  self_approval_mode: Defaulted<'auto' | 'allowed' | 'forbidden'>;
  require_independent_for: Defaulted<string[]>;
  members_invite_guests: Defaulted<boolean>;
  limited_members_can_export: Defaulted<boolean>;
  limited_members_tokens: Defaulted<boolean>;
  limited_members_ai: Defaulted<boolean>;
  limited_members_agents: Defaulted<boolean>;
  read_only_ai: Defaulted<boolean>;
  members_configure_agents: Defaulted<boolean>;
  admins_manage_billing: Defaulted<boolean>;
  comment_on_archived: Defaulted<boolean>;
  workspace_records_default_level: Defaulted<'none' | 'view' | 'comment' | 'edit'>;
  cross_brand_sharing_enabled: Defaulted<boolean>;
  guest_invitations_enabled: Defaulted<boolean>;
  public_links_enabled: Defaulted<boolean>;
  share_max_expiry: string | null;
  token_max_lifetime: string | null;
  low_impact_agent_actions: Defaulted<string[]>;
  updated_at: DTs;
  updated_by_membership_id: string | null;
  version: Defaulted<number>;
}

export type InvitationState = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface InvitationTable {
  id: string;
  public_id: string;
  workspace_id: string;
  email_key: string;
  kind: MembershipKind;
  role_key: string | null;
  scope_proposal: Json<Record<string, unknown>>;
  invited_by_membership_id: string;
  state: Defaulted<InvitationState>;
  expires_at: Ts;
  send_count: Defaulted<number>;
  last_sent_at: DTs;
  token_id: string;
  accepted_account_id: string | null;
  accepted_membership_id: string | null;
  revoked_by_membership_id: string | null;
  decided_at: Ts | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}

export interface ShareGroupTable {
  id: string;
  public_id: string;
  workspace_id: string;
  source_record_id: string;
  source_brand_id: string | null;
  grantee_type: GranteeType;
  grantee_id: string;
  grantee_membership_id: Generated<string | null>;
  grantee_team_id: Generated<string | null>;
  grantee_brand_id: Generated<string | null>;
  level: ShareLevel;
  expires_at: Ts | null;
  state: Defaulted<ShareState>;
  created_by_membership_id: string;
  created_at: DTs;
  revoked_at: Ts | null;
  revoked_by_membership_id: string | null;
  record_count: number;
  version: Defaulted<number>;
}

export interface RecordGrantTable {
  id: string;
  public_id: string;
  workspace_id: string;
  share_group_id: string;
  record_id: string;
  source_brand_id: string | null;
  grantee_type: GranteeType;
  grantee_id: string;
  grantee_key: Generated<string>;
  grantee_membership_id: Generated<string | null>;
  grantee_team_id: Generated<string | null>;
  grantee_brand_id: Generated<string | null>;
  level: ShareLevel;
  state: Defaulted<ShareState>;
  expires_at: Ts | null;
  created_by_membership_id: string;
  created_at: DTs;
  revoked_at: Ts | null;
  revoked_by_membership_id: string | null;
  version: Defaulted<number>;
}

export type OwnershipTransferState = 'pending' | 'accepted' | 'cancelled' | 'expired';

export interface OwnershipTransferTable {
  id: string;
  public_id: string;
  workspace_id: string;
  from_membership_id: string;
  to_membership_id: string;
  state: Defaulted<OwnershipTransferState>;
  demote_previous: boolean;
  expires_at: Ts;
  requested_step_up_id: string;
  accepted_step_up_id: string | null;
  decided_at: Ts | null;
  decided_by_membership_id: string | null;
  created_at: DTs;
  version: Defaulted<number>;
}

export type ThemePreference = 'system' | 'light' | 'dark';
export type DensityPreference = 'comfortable' | 'compact';
export type MotionPreference = 'system' | 'reduce';
export type ShortcutsPreference = 'auto' | 'on' | 'off';
export type RecordOpenPreference = 'panel' | 'full_page';

export interface AccountPreferenceTable {
  account_id: string;
  theme: Defaulted<ThemePreference>;
  density: Defaulted<DensityPreference>;
  motion: Defaulted<MotionPreference>;
  shortcuts: Defaulted<ShortcutsPreference>;
  start_destination: string | null;
  record_open: Defaulted<RecordOpenPreference>;
  hidden_destinations: Defaulted<string[]>;
  updated_at: DTs;
  version: Defaulted<number>;
}

export interface FavoriteTable {
  workspace_id: string;
  owner_membership_id: string;
  record_id: string;
  rank: string;
  created_at: DTs;
}

export interface RecentItemTable {
  workspace_id: string;
  owner_membership_id: string;
  record_id: string;
  visited_at: DTs;
  visit_count: Defaulted<number>;
}

export interface ViewStateTable {
  workspace_id: string;
  owner_membership_id: string;
  device_key_hash: Bytes;
  view_key: string;
  schema_version: number;
  state: Json<Record<string, unknown>>;
  updated_at: DTs;
  expires_at: Ts;
  version: Defaulted<number>;
}

export interface ViewPinTable {
  workspace_id: string;
  scope_key: string;
  brand_id: string | null;
  saved_view_id: string;
  rank: string;
  pinned_by_membership_id: string;
  created_at: DTs;
}

// ---- Phase 3A: saved views and view defaults (0031) --------------------------------------------

export type ViewEntity = 'task' | 'project';
export type ViewLayout =
  | 'list'
  | 'board'
  | 'table'
  | 'calendar'
  | 'timeline'
  | 'gantt'
  | 'workload'
  | 'milestones'
  | 'portfolio'
  | 'activity'
  | 'timesheet';

export interface SavedViewTable {
  id: string;
  workspace_id: string;
  scope_key: string;
  lifecycle_state: Defaulted<LifecycleState>;
  entity: ViewEntity;
  name: string;
  description: Defaulted<string>;
  owner_membership_id: string;
  visibility: Defaulted<'personal' | 'shared'>;
  share_scope: 'workspace' | 'brand' | 'project' | null;
  share_brand_id: string | null;
  share_project_id: string | null;
  schema_version: Defaulted<number>;
  query: Json<Record<string, unknown>>;
  presentation: ColumnType<Record<string, unknown>, string | undefined, string>;
  layout: Defaulted<ViewLayout>;
  shared_at: Ts | null;
  shared_by_membership_id: string | null;
  created_at: DTs;
  updated_at: DTs;
  updated_by_membership_id: string | null;
  version: Defaulted<number>;
}

export interface ViewDefaultTable {
  workspace_id: string;
  target_kind: 'member' | 'brand' | 'project';
  target_key: string;
  entity: ViewEntity;
  member_id: string | null;
  brand_id: string | null;
  project_id: string | null;
  saved_view_id: string;
  set_by_membership_id: string;
  updated_at: DTs;
  version: Defaulted<number>;
}

// ---- Phase 2A: work, workflow, relations, templates, planning (0021, 0022) ----------------------

export type StatusCategory = 'planned' | 'active' | 'paused' | 'done' | 'cancelled';
export type ProjectPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';
export type ProjectHealth = 'on_track' | 'at_risk' | 'off_track';

export interface PlatformStatusTable {
  id: string;
  record_type: string;
  key: string;
  name: string;
  category: StatusCategory;
  rank: number;
}

export interface ProjectTable {
  id: string;
  workspace_id: string;
  brand_id: string;
  scope_key: string;
  lifecycle_state: Defaulted<LifecycleState>;
  parent_project_id: string | null;
  ancestor_ids: Defaulted<string[]>;
  depth: Defaulted<number>;
  name: string;
  /** Rich text version 1 (0D PL-23); validated by tenancy.valid_rich_text. */
  description_rich: Json<unknown> | null;
  icon: string | null;
  color: string | null;
  status_id: string;
  status_category: Defaulted<StatusCategory>;
  priority: Defaulted<ProjectPriority>;
  start_date: string | null;
  target_date: string | null;
  deadline_date: string | null;
  completed_at: Ts | null;
  health: ProjectHealth | null;
  health_source: 'manual' | 'suggested' | null;
  owner_membership_id: string;
  budget_amount: string | null;
  budget_currency: string | null;
  time_budget_minutes: number | null;
  ai_budget_micros: string | null;
  rank: string;
  access_mode: Defaulted<'inherit' | 'restricted'>;
  allow_record_shares: Defaulted<boolean>;
  recurrence_series_id: string | null;
  occurrence_key: string | null;
  intake_source_id: string | null;
  created_by_membership_id: string | null;
  created_at: DTs;
  updated_at: DTs;
  updated_by_membership_id: string | null;
  version: Defaulted<number>;
}

export interface PhaseTable {
  id: string;
  workspace_id: string;
  brand_id: string;
  scope_key: string;
  lifecycle_state: Defaulted<LifecycleState>;
  project_id: string;
  name: string;
  rank: string;
  start_date: string | null;
  end_date: string | null;
  status: Defaulted<'planned' | 'active' | 'completed'>;
  owner_membership_id: string | null;
  created_at: DTs;
  updated_at: DTs;
  updated_by_membership_id: string | null;
  version: Defaulted<number>;
}

export interface MilestoneTable {
  id: string;
  workspace_id: string;
  brand_id: string;
  scope_key: string;
  lifecycle_state: Defaulted<LifecycleState>;
  project_id: string;
  phase_id: string | null;
  name: string;
  rank: string;
  due_date: string | null;
  status: Defaulted<'planned' | 'reached' | 'missed' | 'cancelled'>;
  reached_at: Ts | null;
  owner_membership_id: string | null;
  created_at: DTs;
  updated_at: DTs;
  updated_by_membership_id: string | null;
  version: Defaulted<number>;
}

export interface CriteriaItemTable {
  id: string;
  public_id: string;
  workspace_id: string;
  brand_id: string;
  owner_kind: Defaulted<'project' | 'task'>;
  project_id: string | null;
  kind: 'success' | 'definition_of_done' | 'acceptance';
  text: string;
  rank: string;
  met: Defaulted<boolean>;
  met_by_membership_id: string | null;
  met_at: Ts | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
  /** Phase 2B: task-owned items (owner_kind = 'task'). */
  task_id: string | null;
  required: Defaulted<boolean>;
}

/** Phase 2B tasks (0B ADR-22). */
export interface TaskTable {
  id: string;
  workspace_id: string;
  brand_id: string;
  scope_key: string;
  lifecycle_state: Defaulted<LifecycleState>;
  project_id: string | null;
  parent_task_id: string | null;
  ancestor_ids: Defaulted<string[]>;
  depth: Defaulted<number>;
  title: string;
  description_rich: Json<unknown> | null;
  status_id: string;
  status_category: string;
  prior_status_id: string | null;
  priority: Defaulted<string>;
  start_date: string | null;
  due_date: string | null;
  deadline_date: string | null;
  deadline_at: Ts | null;
  deadline_tz: string | null;
  estimate_minutes: number | null;
  remaining_estimate_minutes: number | null;
  completed_at: Ts | null;
  completed_by_membership_id: string | null;
  completion_override_reason: string | null;
  expected_deliverable_type: string | null;
  expected_deliverable_detail: string | null;
  requires_acceptance: Defaulted<boolean>;
  rank: string;
  created_by_membership_id: string | null;
  created_at: DTs;
  updated_at: DTs;
  updated_by_membership_id: string | null;
  version: Defaulted<number>;
  // Phase 2D (0027): origin (immutable), recurrence identity, and OD-17 freshness.
  origin_kind: Defaulted<TaskOriginKind>;
  origin_ref: ColumnType<Record<string, string | number>, string | undefined, string>;
  recurrence_series_id: string | null;
  occurrence_key: string | null;
  last_meaningful_update_at: DTs;
}
export const TASK_ORIGIN_KINDS = [
  'manual',
  'recurring',
  'template',
  'intake',
  'import',
  'integration',
  'ai_draft',
] as const;
export type TaskOriginKind = (typeof TASK_ORIGIN_KINDS)[number];
export interface TaskAssigneeTable {
  workspace_id: string;
  brand_id: string;
  task_id: string;
  membership_id: string;
  is_primary: Defaulted<boolean>;
  rank: string;
  assigned_by_membership_id: string | null;
  assigned_at: DTs;
  delegated_from_membership_id: string | null;
  delegated_at: Ts | null;
}
export interface ChecklistItemTable {
  id: string;
  public_id: string;
  workspace_id: string;
  brand_id: string;
  task_id: string;
  text: string;
  rank: string;
  done: Defaulted<boolean>;
  done_by_membership_id: string | null;
  done_at: Ts | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface TaskInheritedCriterionTable {
  workspace_id: string;
  brand_id: string;
  task_id: string;
  criteria_item_id: string;
  state: 'met' | 'dismissed';
  by_membership_id: string;
  at: DTs;
}
export interface LabelTable {
  id: string;
  public_id: string;
  workspace_id: string;
  brand_id: string;
  name: string;
  normalized_name: string;
  color: string;
  icon: string | null;
  rank: string;
  state: Defaulted<'active' | 'archived'>;
  created_by_membership_id: string | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface TaskLabelTable {
  workspace_id: string;
  brand_id: string;
  task_id: string;
  label_id: string;
  added_by_membership_id: string | null;
  added_at: DTs;
}
export interface RecordLinkTable {
  id: string;
  public_id: string;
  workspace_id: string;
  source_record_id: string;
  target_kind: 'url' | 'record';
  url: string | null;
  target_record_id: string | null;
  title: string | null;
  rank: string;
  created_by_membership_id: string | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}

export type ScopeItemKind = 'scope' | 'exclusion' | 'risk' | 'assumption' | 'constraint';
export interface ScopeItemTable {
  id: string;
  public_id: string;
  workspace_id: string;
  brand_id: string;
  project_id: string;
  kind: ScopeItemKind;
  text: string;
  rank: string;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}

export interface ProjectUpdateTable {
  id: string;
  public_id: string;
  workspace_id: string;
  brand_id: string;
  project_id: string;
  body: string;
  health: ProjectHealth | null;
  source_kind: 'human' | 'ai_draft' | 'import' | 'system';
  author_membership_id: string | null;
  created_at: DTs;
}

export interface ProjectUpdateVerificationTable {
  workspace_id: string;
  update_id: string;
  project_id: string;
  verifier_membership_id: string;
  verified_at: DTs;
  audit_event_id: string;
}

export type DecisionKind = 'decision' | 'open_question';
export type DecisionState = 'proposed' | 'decided' | 'superseded' | 'open' | 'resolved';
export interface DecisionRecordTable {
  id: string;
  workspace_id: string;
  brand_id: string;
  scope_key: string;
  lifecycle_state: Defaulted<LifecycleState>;
  project_id: string | null;
  kind: DecisionKind;
  state: DecisionState;
  statement: string;
  outcome: string | null;
  owner_membership_id: string | null;
  due_date: string | null;
  decided_at: Ts | null;
  resolved_at: Ts | null;
  superseded_by_id: string | null;
  created_at: DTs;
  updated_at: DTs;
  updated_by_membership_id: string | null;
  version: Defaulted<number>;
}

export interface RecordRelationshipTable {
  id: string;
  workspace_id: string;
  kind: 'blocks' | 'related';
  from_record_id: string;
  to_record_id: string;
  from_brand_id: string;
  to_brand_id: string;
  created_by_membership_id: string | null;
  created_at: DTs;
}

export interface TemplateTable {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  scope_key: string;
  lifecycle_state: Defaulted<LifecycleState>;
  name: string;
  target_record_type: 'project' | 'task';
  current_version_id: string | null;
  created_by_membership_id: string | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}

export interface TemplateVersionTable {
  id: string;
  workspace_id: string;
  template_id: string;
  version_number: number;
  schema_version: number;
  content: Json<Record<string, unknown>>;
  item_count: number;
  created_from_record_type: string | null;
  created_by_membership_id: string | null;
  created_at: DTs;
}

export interface RecurrenceSeriesTable {
  id: string;
  public_id: string;
  workspace_id: string;
  brand_id: string;
  target_kind: 'project' | 'task';
  source_record_id: string | null;
  state: Defaulted<'active' | 'paused'>;
  rrule: string;
  anchor_tz: string;
  dtstart_local: string;
  mode: Defaulted<'schedule'>;
  template_payload: Json<Record<string, unknown>>;
  payload_item_count: number;
  generated_through: string | null;
  next_due_at: Ts | null;
  last_run_at: DTs;
  ends_at_occurrence: string | null;
  split_from_series_id: string | null;
  owner_membership_id: string;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
  /** Phase 2D (0027): a task series' project (same brand). */
  project_id: string | null;
}

// Phase 2D (0027, 0028): personal reminders and snoozes, bulk operations, undo entries.
export interface TaskReminderTable {
  id: string;
  public_id: string;
  workspace_id: string;
  owner_membership_id: string;
  task_id: string;
  remind_at: Ts;
  state: Defaulted<'scheduled' | 'fired' | 'dismissed' | 'cancelled'>;
  fired_at: Ts | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface TaskSnoozeTable {
  workspace_id: string;
  owner_membership_id: string;
  task_id: string;
  until_at: Ts;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface BulkOperationTable {
  id: string;
  public_id: string;
  workspace_id: string;
  owner_membership_id: string;
  operation: string;
  params: ColumnType<Record<string, unknown>, string | undefined, string>;
  mode: 'atomic' | 'partial';
  state: Defaulted<'previewed' | 'executed' | 'expired'>;
  item_ids: string[];
  fingerprint: Buffer;
  results: Json<unknown[]> | null;
  created_at: DTs;
  expires_at: Ts;
  executed_at: Ts | null;
  version: Defaulted<number>;
}
export interface UndoEntryTable {
  id: string;
  public_id: string;
  workspace_id: string;
  owner_membership_id: string;
  command: string;
  targets: Json<unknown[]>;
  inverse: Json<Record<string, unknown>>;
  state: Defaulted<'available' | 'applied' | 'expired' | 'conflicted'>;
  created_at: DTs;
  expires_at: Ts;
  closed_at: Ts | null;
  version: Defaulted<number>;
}

// Phase 2E (0029, 0030): personal Inbox items and notes, conversion lineage, intake forms.
export const CAPTURE_SOURCE_KINDS = [
  'typed',
  'paste',
  'form',
  'voice',
  'email',
  'api',
  'webhook',
  'mcp',
] as const;
export type CaptureSourceKind = (typeof CAPTURE_SOURCE_KINDS)[number];
export interface InboxItemTable {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  scope_key: string;
  lifecycle_state: Defaulted<LifecycleState>;
  owner_membership_id: string;
  intent: Defaulted<'task' | 'note'>;
  raw_text: string;
  source_kind: CaptureSourceKind;
  source_ref: string | null;
  correlation_id: string;
  parse_version: number;
  parsed: ColumnType<Record<string, unknown>, string | undefined, string>;
  capture_batch_id: string | null;
  triage_state: Defaulted<'untriaged' | 'converted' | 'merged' | 'discarded'>;
  converted_kind: 'task' | 'note' | 'project' | null;
  converted_record_id: string | null;
  merged_into_id: string | null;
  triaged_at: Ts | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export type VoiceCaptureState =
  'uploaded' | 'transcribing' | 'transcribed' | 'failed' | 'cancelled' | 'expired' | 'saved';
/** 7F: one ephemeral voice upload; the transcript is AI content of its transcription run. */
export interface VoiceCaptureTable {
  id: string;
  workspace_id: string;
  public_id: string;
  membership_id: string;
  state: Defaulted<VoiceCaptureState>;
  format: 'audio/wav' | 'audio/webm' | 'audio/ogg';
  byte_size: number;
  duration_ms: number;
  content_sha256: string;
  storage_key: string | null;
  operation_id: string | null;
  inbox_item_id: string | null;
  failure_code: string | null;
  expires_at: Timestamp;
  discarded_at: Timestamp | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface NoteTable {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  scope_key: string;
  lifecycle_state: Defaulted<LifecycleState>;
  owner_membership_id: string;
  title: string;
  body: Defaulted<string>;
  source_inbox_item_id: string | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface CaptureConversionTable {
  id: string;
  workspace_id: string;
  source_record_id: string;
  source_kind: 'inbox_item' | 'note';
  target_record_id: string;
  target_kind: 'task' | 'note' | 'project';
  by_membership_id: string;
  created_at: DTs;
}
export interface IntakeFormTable {
  id: string;
  workspace_id: string;
  brand_id: string;
  scope_key: string;
  lifecycle_state: Defaulted<LifecycleState>;
  name: string;
  description: Defaulted<string>;
  target_kind: Defaulted<'task' | 'project'>;
  queue_owner_membership_id: string;
  state: Defaulted<'active' | 'archived'>;
  created_by_membership_id: string | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface IntakeSubmissionTable {
  id: string;
  workspace_id: string;
  form_id: string;
  submitter_membership_id: string;
  inbox_item_id: string;
  submitted_at: DTs;
}

// Phase 3D (0031): time entries, segments, timesheets, approval lines, decisions, period locks.
export type TimeEntryState = 'running' | 'paused' | 'stopped';
export interface TimeEntryTable {
  id: string;
  public_id: string;
  workspace_id: string;
  brand_id: string;
  membership_id: string;
  task_id: string | null;
  project_id: string | null;
  source: 'manual' | 'timer';
  state: Defaulted<TimeEntryState>;
  started_at: Ts | null;
  ended_at: Ts | null;
  work_date: string;
  tz: string;
  duration_seconds: Defaulted<number>;
  billable: Defaulted<boolean>;
  note: Defaulted<string>;
  auto_stopped: Defaulted<boolean>;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface TimeSegmentTable {
  id: string;
  workspace_id: string;
  entry_id: string;
  membership_id: string;
  started_at: Ts;
  ended_at: Ts | null;
}
export type TimesheetState = 'open' | 'submitted' | 'approved';
export interface TimesheetTable {
  id: string;
  public_id: string;
  workspace_id: string;
  membership_id: string;
  period_start: string;
  period_end: string;
  state: Defaulted<TimesheetState>;
  submitted_at: Ts | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export type TimesheetLineState = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'unlocked';
export interface TimesheetLineTable {
  id: string;
  workspace_id: string;
  timesheet_id: string;
  brand_id: string;
  state: TimesheetLineState;
  submitted_seconds: number;
  submitted_billable_seconds: number;
  submitted_entries: number;
  submitted_hash: string;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface TimesheetApprovalTable {
  id: string;
  workspace_id: string;
  timesheet_id: string;
  line_id: string;
  brand_id: string;
  membership_id: string;
  period_start: string;
  period_end: string;
  decided_by_membership_id: string;
  decision: 'approve' | 'reject';
  self_approval: boolean;
  note_hash: string | null;
  total_seconds: number;
  billable_seconds: number;
  entry_count: number;
  entries_hash: string;
  timesheet_version: number;
  created_at: DTs;
}
export interface PeriodLockTable {
  id: string;
  workspace_id: string;
  brand_id: string;
  membership_id: string;
  period_start: string;
  period_end: string;
  action: 'lock' | 'unlock';
  approval_id: string | null;
  reason: string | null;
  by_membership_id: string;
  step_up_id: string | null;
  created_at: DTs;
}

// Phase 3C (0033): work blocks, block series, Today commitments, daily records.
export interface WorkBlockTable {
  id: string;
  public_id: string;
  workspace_id: string;
  owner_membership_id: string;
  task_id: string | null;
  brand_id: string | null;
  title: string | null;
  starts_at: Ts;
  ends_at: Ts;
  source_tz: string;
  focus: Defaulted<boolean>;
  locked: Defaulted<boolean>;
  prep_minutes: Defaulted<number>;
  buffer_minutes: Defaulted<number>;
  /** 7F: `plan` for a block a person created by applying a daily-plan proposal. */
  source: Defaulted<'manual' | 'estimate' | 'recurrence' | 'plan'>;
  series_id: string | null;
  occurrence_key: string | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface BlockSeriesTable {
  id: string;
  public_id: string;
  workspace_id: string;
  owner_membership_id: string;
  task_id: string | null;
  brand_id: string | null;
  title: string | null;
  rrule: string;
  anchor_tz: string;
  dtstart_local: string;
  duration_minutes: number;
  focus: Defaulted<boolean>;
  prep_minutes: Defaulted<number>;
  buffer_minutes: Defaulted<number>;
  state: Defaulted<'active' | 'ended'>;
  generated_through: string | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export type CommitmentOutcome = 'open' | 'done' | 'carried' | 'returned' | 'dropped';
export interface TodayCommitmentTable {
  id: string;
  workspace_id: string;
  owner_membership_id: string;
  day: string;
  task_id: string;
  brand_id: string;
  rank: string;
  locked: Defaulted<boolean>;
  outcome: Defaulted<CommitmentOutcome>;
  carried_to: string | null;
  source: Defaulted<'manual' | 'plan' | 'carry'>;
  created_at: DTs;
  closed_at: Ts | null;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface DailyRecordTable {
  id: string;
  workspace_id: string;
  owner_membership_id: string;
  day: string;
  tz: string;
  closed_by: 'shutdown' | 'auto';
  committed: number;
  completed: number;
  carried: number;
  returned: number;
  dropped: number;
  planned_minutes: number;
  unestimated: number;
  block_minutes: number;
  focus_minutes: number;
  actual_seconds: number;
  items: ColumnType<unknown[], string, string>;
  created_at: DTs;
}

// Phase 2C (0025, 0026): workflows, approvals, custom fields, field sets, field policy.
export interface WorkflowTable {
  id: string;
  public_id: string;
  workspace_id: string;
  brand_id: string | null;
  project_id: string | null;
  scope_kind: string;
  record_kind: string;
  name: string;
  state: Defaulted<string>;
  created_by_membership_id: string | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface WorkflowStatusTable {
  id: string;
  public_id: string;
  workspace_id: string;
  workflow_id: string;
  name: string;
  normalized_name: string;
  description: string | null;
  category: string;
  color: string;
  icon: string | null;
  rank: string;
  state: Defaulted<string>;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface WfTransitionTable {
  id: string;
  public_id: string;
  workspace_id: string;
  workflow_id: string;
  from_status_id: string;
  to_status_id: string;
  description: string | null;
  rank: string;
  confirmation_tier: Defaulted<string>;
  approval_policy: Defaulted<string>;
  allow_self_approval: Defaulted<boolean>;
  state: Defaulted<string>;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface WfTransitionRequirementTable {
  id: string;
  workspace_id: string;
  transition_id: string;
  field_kind: string;
  builtin_key: string | null;
  definition_id: string | null;
  allow_manager_override: Defaulted<boolean>;
  rank: string;
  created_at: DTs;
}
export interface WfTransitionApproverTable {
  workspace_id: string;
  transition_id: string;
  membership_id: string;
  rank: string;
}
export interface WfApprovalRequestTable {
  id: string;
  public_id: string;
  workspace_id: string;
  brand_id: string;
  workflow_id: string;
  transition_id: string;
  transition_version: number;
  record_id: string;
  record_type: string;
  record_version: number;
  fingerprint: string;
  requester_membership_id: string;
  policy: string;
  approver_membership_ids: Defaulted<string[]>;
  allow_self_approval: boolean;
  expires_at: Ts;
  created_at: DTs;
  closed_at: Ts | null;
  closed_reason: string | null;
}
export interface WfApprovalDecisionTable {
  id: string;
  workspace_id: string;
  approval_request_id: string;
  approver_membership_id: string;
  decision: string;
  note_hash: string | null;
  decided_at: DTs;
}
export interface WfFieldDefinitionTable {
  id: string;
  public_id: string;
  workspace_id: string;
  brand_id: string | null;
  project_id: string | null;
  scope_kind: string;
  lineage_id: string;
  applies_to_project: boolean;
  applies_to_task: boolean;
  name: string;
  normalized_name: string;
  description: string | null;
  field_type: string;
  config: ColumnType<Record<string, unknown>, string | undefined, string>;
  required: Defaulted<boolean>;
  presentation: Defaulted<string>;
  applicability: Defaulted<string>;
  view_visibility: ColumnType<Record<string, unknown>, string | undefined, string>;
  formula_ast: Json<Record<string, unknown>> | null;
  formula_version: Defaulted<number>;
  result_type: string | null;
  extensions: ColumnType<Record<string, unknown>, string | undefined, string>;
  rank: string;
  state: Defaulted<string>;
  created_by_membership_id: string | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface WfFieldOptionTable {
  id: string;
  public_id: string;
  workspace_id: string;
  definition_id: string;
  label: string;
  normalized_label: string;
  color: string;
  rank: string;
  state: Defaulted<string>;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface WfFormulaDependencyTable {
  workspace_id: string;
  definition_id: string;
  depends_on_definition_id: string;
}
export interface WfFieldValueTable {
  workspace_id: string;
  brand_id: string;
  definition_id: string;
  record_id: string;
  value: Json<unknown> | null;
  value_text: string | null;
  value_numeric: string | null;
  value_date: string | null;
  value_bool: boolean | null;
  value_ref: string | null;
  currency_code: string | null;
  computed: Defaulted<boolean>;
  formula_version: number | null;
  error_code: string | null;
  extensions: ColumnType<Record<string, unknown>, string | undefined, string>;
  updated_by_membership_id: string | null;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface WfFieldSetTable {
  id: string;
  public_id: string;
  workspace_id: string;
  brand_id: string | null;
  project_id: string | null;
  scope_kind: string;
  applies_to_project: boolean;
  applies_to_task: boolean;
  name: string;
  normalized_name: string;
  current_version: Defaulted<number>;
  state: Defaulted<string>;
  created_by_membership_id: string | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface WfFieldSetVersionTable {
  workspace_id: string;
  field_set_id: string;
  version: number;
  items: Json<unknown[]>;
  created_by_membership_id: string | null;
  created_at: DTs;
}
export interface WfFieldSetAttachmentTable {
  workspace_id: string;
  brand_id: string;
  record_id: string;
  field_set_id: string;
  version: number;
  attached_by_membership_id: string | null;
  attached_at: DTs;
}
export interface FieldPolicyTable {
  workspace_id: string;
  definition_id: string;
  read_rule: Defaulted<string>;
  read_min_level: string | null;
  edit_min_level: string | null;
  guest_visible: Defaulted<boolean>;
  index_for_search: Defaulted<boolean>;
  updated_at: DTs;
  version: Defaulted<number>;
}

// ---- Phase 3E: capacity (0035) -----------------------------------------------------------------

export interface CapacityProfileTable {
  workspace_id: string;
  membership_id: string;
  weekly_capacity_minutes: number | null;
  observe_brand_holidays: Defaulted<boolean>;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface AvailabilityRuleTable {
  workspace_id: string;
  membership_id: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
}
export interface TimeOffTable {
  id: string;
  public_id: string;
  workspace_id: string;
  membership_id: string;
  kind: 'vacation' | 'sick' | 'personal' | 'holiday' | 'unavailable';
  all_day: boolean;
  starts_on: string | null;
  ends_on: string | null;
  starts_at: Ts | null;
  ends_at: Ts | null;
  source_tz: string;
  label: string | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface HolidayTable {
  id: string;
  public_id: string;
  workspace_id: string;
  brand_id: string;
  day: string;
  name: string;
  created_by_membership_id: string | null;
  created_at: DTs;
}
export interface CapacityReservationTable {
  id: string;
  public_id: string;
  workspace_id: string;
  brand_id: string;
  membership_id: string;
  minutes_per_week: number;
  effective_from: string;
  effective_to: string | null;
  set_by_membership_id: string;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}

// ---- Phase 4A: comments, mentions, followers, reviews, assignment history (0036) --------------

export type ReviewState =
  'requested' | 'changes_requested' | 'approved' | 'rejected' | 'withdrawn' | 'superseded';
export type ReviewOutcome = 'approved' | 'changes_requested' | 'rejected';

export interface CommentTable {
  id: string;
  public_id: string;
  workspace_id: string;
  host_record_id: string;
  root_comment_id: string | null;
  in_reply_to_comment_id: string | null;
  body_rich: Json<unknown> | null;
  body_text: string | null;
  author_membership_id: string;
  author_actor_type: Defaulted<'member'>;
  created_at: DTs;
  edited_at: Ts | null;
  edit_count: Defaulted<number>;
  deleted_at: Ts | null;
  deleted_by_membership_id: string | null;
  deleted_by_kind: 'author' | 'moderator' | null;
  version: Defaulted<number>;
}
export interface CommentRevisionTable {
  id: string;
  workspace_id: string;
  comment_id: string;
  revision_no: number;
  kind: 'edited' | 'deleted';
  body_rich: Json<unknown>;
  body_text: string;
  actor_membership_id: string;
  created_at: DTs;
}
export interface ReactionTable {
  workspace_id: string;
  comment_id: string;
  membership_id: string;
  reaction: string;
  created_at: DTs;
}
export interface MentionTable {
  id: string;
  workspace_id: string;
  source_kind: Defaulted<'comment'>;
  source_id: string;
  target_kind: 'member' | 'team' | 'record';
  target_membership_id: string | null;
  target_team_id: string | null;
  target_record_id: string | null;
  position: Defaulted<number>;
  notified: Defaulted<boolean>;
  created_at: DTs;
}
export interface FollowerTable {
  workspace_id: string;
  record_id: string;
  membership_id: string;
  source: Defaulted<'explicit'>;
  created_at: DTs;
}
export interface ReviewRequestTable {
  id: string;
  public_id: string;
  workspace_id: string;
  subject_record_id: string;
  subject_kind: 'task' | 'project' | 'document' | 'deliverable';
  subject_version: number;
  kind: 'review' | 'approval';
  rule: 'any' | 'all';
  state: Defaulted<ReviewState>;
  requested_by_membership_id: string;
  message_text: string | null;
  previous_request_id: string | null;
  closed_reason: 'requester' | 'requester_departed' | 'reviewer_departed' | 'refreshed' | null;
  settled_at: Ts | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface ReviewReviewerTable {
  workspace_id: string;
  review_request_id: string;
  membership_id: string;
  rank: number;
}
export interface ReviewDecisionTable {
  id: string;
  workspace_id: string;
  review_request_id: string;
  reviewer_membership_id: string;
  outcome: ReviewOutcome;
  subject_version: number;
  note_text: string | null;
  self_approval: Defaulted<boolean>;
  decided_at: DTs;
}
export interface AssignmentEventTable {
  id: string;
  workspace_id: string;
  task_id: string;
  kind: 'assigned' | 'unassigned' | 'reassigned' | 'delegated';
  via: 'assign' | 'delegate' | 'departure';
  from_membership_id: string | null;
  to_membership_id: string | null;
  actor_membership_id: string;
  note_text: string | null;
  occurred_at: DTs;
}

// ---- Phase 4B: notifications (0037) -------------------------------------------------------------

export type NotificationType =
  | 'assignment'
  | 'mention'
  | 'comment'
  | 'review_requested'
  | 'approval_decided'
  | 'blocker'
  | 'due_soon'
  | 'overdue'
  | 'integration_failure'
  | 'automation_failure'
  | 'agent_failure'
  | 'agent_output_ready'
  | 'spend_threshold'
  | 'permission_changed'
  | 'share_changed'
  | 'briefing_ready'
  | 'export_ready'
  | 'hidden_dependency_affects_assignee'
  | 'automation_notice';
export type NotificationState = 'unread' | 'read' | 'saved' | 'dismissed';
export type DeliveryState =
  | 'pending'
  | 'sending'
  | 'delivered'
  | 'failed'
  | 'dead'
  | 'suppressed'
  | 'deferred_quiet_hours'
  | 'expired';

export interface NotificationTable {
  id: string;
  public_id: string;
  workspace_id: string;
  recipient_membership_id: string;
  type: NotificationType;
  record_id: string | null;
  actor_membership_id: string | null;
  source_event_id: string | null;
  dedupe_key: string;
  group_key: string | null;
  facts: ColumnType<Record<string, string | number | boolean | null>, string | undefined, string>;
  occurrences: Defaulted<number>;
  state: Defaulted<NotificationState>;
  digest_pending: Defaulted<boolean>;
  digest_id: string | null;
  created_at: DTs;
  last_occurred_at: DTs;
  state_changed_at: DTs;
  version: Defaulted<number>;
}
export interface DigestTable {
  id: string;
  workspace_id: string;
  recipient_membership_id: string;
  period_kind: 'daily' | 'weekly';
  period_start: Ts;
  period_end: Ts;
  item_count: number;
  state: 'assembled' | 'empty';
  created_at: DTs;
}
export interface DeliveryTable {
  id: string;
  public_id: string;
  workspace_id: string;
  recipient_membership_id: string;
  channel: 'email' | 'browser';
  kind: 'notification' | 'digest';
  notification_id: string | null;
  digest_id: string | null;
  state: Defaulted<DeliveryState>;
  attempts: Defaulted<number>;
  next_attempt_at: DTs;
  lease_until: Ts | null;
  failure_class: 'transient' | 'permanent' | 'unconfigured' | 'rate_limited' | null;
  failure_code: string | null;
  suppress_reason: string | null;
  provider_message_id: string | null;
  ack_source: 'provider' | 'client' | null;
  created_at: DTs;
  updated_at: DTs;
  delivered_at: Ts | null;
  version: Defaulted<number>;
}
export type NotificationMode = 'immediate' | 'digest' | 'muted';
export interface NotificationPreferenceTable {
  id: string;
  workspace_id: string;
  membership_id: string;
  event_type: string;
  scope_kind: 'workspace' | 'brand' | 'project' | 'record';
  scope_record_id: string | null;
  channel: 'all' | 'in_app' | 'email' | 'browser';
  mode: NotificationMode;
  expires_at: Ts | null;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface NotificationProfileTable {
  workspace_id: string;
  membership_id: string;
  timezone: string | null;
  quiet_start_minute: number | null;
  quiet_end_minute: number | null;
  email_enabled: Defaulted<boolean>;
  browser_enabled: Defaulted<boolean>;
  browser_permission: Defaulted<'unknown' | 'granted' | 'denied'>;
  digest_cadence: Defaulted<'off' | 'daily' | 'weekly'>;
  daily_digest_minute: Defaulted<number>;
  weekly_digest_weekday: Defaulted<number>;
  weekly_digest_minute: Defaulted<number>;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface NotificationScopeDefaultTable {
  id: string;
  workspace_id: string;
  scope_kind: 'brand' | 'project';
  scope_record_id: string;
  event_type: string;
  channel: 'in_app' | 'email' | 'browser';
  mode: NotificationMode;
  set_by_membership_id: string;
  updated_at: DTs;
  version: Defaulted<number>;
}
export type DocumentTypeKey =
  | 'page'
  | 'brand_brief'
  | 'project_brief'
  | 'sop'
  | 'specification'
  | 'meeting_notes'
  | 'decision'
  | 'release_notes';
export interface DocumentTable {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  scope_key: string;
  lifecycle_state: Defaulted<'active' | 'archived' | 'trashed' | 'purged'>;
  parent_document_id: string | null;
  ancestor_ids: Defaulted<string[]>;
  depth: Defaulted<number>;
  attached_project_id: string | null;
  attached_task_id: string | null;
  doc_type: Defaulted<DocumentTypeKey>;
  title: string;
  state: Defaulted<'draft' | 'current' | 'stale'>;
  access_mode: Defaulted<'inherit'>;
  allow_record_shares: Defaulted<boolean>;
  owner_membership_id: string;
  review_due_on: ColumnType<string | null, string | null | undefined, string | null>;
  current_version_id: string | null;
  current_version_number: Defaulted<number>;
  rank: string;
  created_by_membership_id: string;
  created_at: DTs;
  updated_at: DTs;
  updated_by_membership_id: string | null;
  version: Defaulted<number>;
}
export interface DocumentVersionTable {
  id: string;
  public_id: string;
  workspace_id: string;
  document_id: string;
  number: number;
  title: string;
  content: Json<Record<string, unknown>>;
  content_hash: string;
  size_bytes: number;
  kind: 'save' | 'restore' | 'suggestion' | 'template';
  restored_from_number: number | null;
  template_key: string | null;
  change_summary: ColumnType<Record<string, number>, string | undefined, string>;
  created_by_membership_id: string;
  created_at: DTs;
}
export interface DocumentReferenceTable {
  id: string;
  workspace_id: string;
  document_id: string;
  block_id: string;
  position: Defaulted<number>;
  kind: 'mention' | 'link';
  target_kind: 'member' | 'team' | 'record';
  target_membership_id: string | null;
  target_team_id: string | null;
  target_record_id: string | null;
  target_record_type: 'task' | 'project' | 'brand' | 'document' | null;
  created_at: DTs;
}
export type DocumentSuggestionState = 'open' | 'accepted' | 'rejected' | 'withdrawn' | 'stale';
export interface DocumentSuggestionTable {
  id: string;
  public_id: string;
  workspace_id: string;
  document_id: string;
  block_id: string;
  base_version: number;
  base_block_hash: string;
  proposed: Json<Record<string, unknown>>;
  note: string | null;
  state: Defaulted<DocumentSuggestionState>;
  author_membership_id: string;
  decided_by_membership_id: string | null;
  decided_at: Ts | null;
  applied_version: number | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface EditDraftTable {
  workspace_id: string;
  document_id: string;
  base_version: number;
  content: Json<Record<string, unknown>>;
  content_hash: string;
  seq: Defaulted<string | number>;
  checkpoint_seq: Defaulted<string | number>;
  dirty: Defaulted<boolean>;
  last_editor_membership_id: string | null;
  created_at: DTs;
  updated_at: DTs;
}
export interface EditSessionTable {
  id: string;
  workspace_id: string;
  document_id: string;
  membership_id: string;
  session_key: string;
  mode: Defaulted<'edit' | 'view'>;
  color: Defaulted<number>;
  caret_block: string | null;
  started_at: DTs;
  last_seen_at: DTs;
  expires_at: Ts;
}
export interface EditOpTable {
  workspace_id: string;
  document_id: string;
  seq: string | number;
  session_id: string | null;
  membership_id: string;
  op_id: string;
  kind: 'insert' | 'replace' | 'delete' | 'move';
  block_id: string;
  payload: Json<Record<string, unknown>>;
  created_at: DTs;
}
export interface SourceApprovalTable {
  id: string;
  workspace_id: string;
  document_id: string;
  version_number: number;
  kind: 'approved' | 'revoked';
  actor_membership_id: string;
  note: string | null;
  created_at: DTs;
}

// Phase 5B: goals, key results, links, check-ins, derived state, and portfolios (ADR-0029).
type NumN = ColumnType<string | null, string | number | null | undefined, string | number | null>;
export type GoalStatus = 'draft' | 'active' | 'achieved' | 'missed' | 'cancelled';
export type GoalPeriodKind = 'quarter' | 'half' | 'year' | 'custom';
export type GoalBasis = 'manual' | 'key_results' | 'linked_work';
export type GoalConfidence = 'on_track' | 'at_risk' | 'off_track';
export interface GoalTable {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  scope_key: string;
  lifecycle_state: Defaulted<'active' | 'archived' | 'trashed' | 'purged'>;
  project_id: string | null;
  title: string;
  description: string | null;
  owner_membership_id: string;
  status: Defaulted<GoalStatus>;
  period_kind: GoalPeriodKind;
  period_start: ColumnType<string, string, string>;
  period_end: ColumnType<string, string, string>;
  progress_basis: Defaulted<GoalBasis>;
  unit: string | null;
  baseline_value: NumN;
  target_value: NumN;
  current_value: NumN;
  latest_percent: NumN;
  latest_checkin_id: string | null;
  latest_checkin_at: Ts | null;
  latest_confidence: GoalConfidence | null;
  created_by_membership_id: string;
  created_at: DTs;
  updated_at: DTs;
  updated_by_membership_id: string | null;
  version: Defaulted<number>;
}
export interface KeyResultTable {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  scope_key: string;
  lifecycle_state: Defaulted<'active' | 'archived' | 'trashed' | 'purged'>;
  goal_id: string;
  title: string;
  owner_membership_id: string;
  progress_basis: Defaulted<'manual' | 'linked_work'>;
  unit: string | null;
  baseline_value: NumN;
  target_value: NumN;
  current_value: NumN;
  latest_percent: NumN;
  latest_checkin_id: string | null;
  latest_checkin_at: Ts | null;
  latest_confidence: GoalConfidence | null;
  rank: string;
  created_by_membership_id: string;
  created_at: DTs;
  updated_at: DTs;
  updated_by_membership_id: string | null;
  version: Defaulted<number>;
}
export interface GoalCheckinTable {
  id: string;
  public_id: string;
  workspace_id: string;
  goal_id: string;
  key_result_id: string | null;
  source: 'manual' | 'computed';
  value: NumN;
  progress_percent: NumN;
  confidence: GoalConfidence | null;
  note: string | null;
  inputs_hash: string | null;
  author_membership_id: string | null;
  created_at: DTs;
}
export interface GoalLinkTable {
  id: string;
  workspace_id: string;
  goal_id: string;
  key_result_id: string | null;
  target_kind: 'project' | 'task';
  target_record_id: string;
  target_brand_id: string;
  created_by_membership_id: string;
  created_at: DTs;
}
export interface GoalStateTable {
  workspace_id: string;
  goal_id: string;
  rollup_percent: NumN;
  rollup_basis: Defaulted<'none' | 'manual' | 'key_results' | 'viewer_dependent'>;
  inputs_hash: string | null;
  update_state: Defaulted<'never' | 'fresh' | 'stale'>;
  period_state: Defaulted<'upcoming' | 'current' | 'ended'>;
  dirty: Defaulted<boolean>;
  next_check_at: DTs;
  claimed_until: Ts | null;
  attempts: Defaulted<number>;
  last_error: string | null;
  computed_at: Ts | null;
}
export interface PortfolioTable {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  scope_key: string;
  lifecycle_state: Defaulted<'active' | 'archived' | 'trashed' | 'purged'>;
  name: string;
  description: string | null;
  owner_membership_id: string;
  created_by_membership_id: string;
  created_at: DTs;
  updated_at: DTs;
  updated_by_membership_id: string | null;
  version: Defaulted<number>;
}
export interface PortfolioProjectTable {
  workspace_id: string;
  portfolio_id: string;
  project_id: string;
  position: number;
  added_by_membership_id: string;
  added_at: DTs;
}

// Phase 5D: dashboards, saved reports, report shares, recipients, and scheduled runs (ADR-0031).
export type DashboardKind = 'owner' | 'brand' | 'project' | 'release' | 'personal';
export type ReportFrequency = 'daily' | 'weekly' | 'monthly';
export type ReportRunState = 'pending' | 'delivered' | 'empty' | 'skipped' | 'failed';
export interface DashboardTable {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  scope_key: string;
  lifecycle_state: Defaulted<'active' | 'archived' | 'trashed' | 'purged'>;
  project_id: string | null;
  kind: DashboardKind;
  title: string;
  description: string | null;
  owner_membership_id: string;
  layout: Json<Record<string, unknown>>;
  filters: Json<Record<string, unknown>>;
  created_by_membership_id: string;
  created_at: DTs;
  updated_at: DTs;
  updated_by_membership_id: string | null;
  version: Defaulted<number>;
}
export interface ReportDefinitionTable {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  scope_key: string;
  lifecycle_state: Defaulted<'active' | 'archived' | 'trashed' | 'purged'>;
  project_id: string | null;
  title: string;
  description: string | null;
  owner_membership_id: string;
  config: Json<Record<string, unknown>>;
  schedule_frequency: ReportFrequency | null;
  schedule_weekday: number | null;
  schedule_monthday: number | null;
  schedule_minute: number | null;
  schedule_timezone: string | null;
  next_run_at: Ts | null;
  last_run_at: Ts | null;
  claimed_until: Ts | null;
  attempts: Defaulted<number>;
  last_error: string | null;
  suspended_reason: 'owner_authority' | 'owner_departed' | 'admin' | null;
  suspended_at: Ts | null;
  created_by_membership_id: string;
  created_at: DTs;
  updated_at: DTs;
  updated_by_membership_id: string | null;
  version: Defaulted<number>;
}
export interface ReportRecipientTable {
  workspace_id: string;
  report_id: string;
  membership_id: string;
  added_by_membership_id: string;
  added_at: DTs;
}
export interface ReportShareTable {
  id: string;
  public_id: string;
  workspace_id: string;
  scope_key: string;
  report_id: string;
  grantee_membership_id: string;
  created_by_membership_id: string;
  created_at: DTs;
  expires_at: Ts | null;
  revoked_at: Ts | null;
  revoked_by_membership_id: string | null;
}
export interface ReportRunTable {
  id: string;
  workspace_id: string;
  report_id: string;
  recipient_membership_id: string;
  occurrence_at: Ts;
  state: Defaulted<ReportRunState>;
  detail: string | null;
  row_count: number | null;
  incomplete: Defaulted<boolean>;
  content_hash: string | null;
  failure_class: 'transient' | 'permanent' | 'rate_limited' | 'unconfigured' | null;
  attempts: Defaulted<number>;
  created_at: DTs;
  finished_at: Ts | null;
}

// Phase 6A: connections, checkpoints, external identities, sync runs, deliveries, and conflicts.
export type ConnectionHealth =
  | 'connected'
  | 'needs_reauthorization'
  | 'error'
  | 'disconnected'
  | 'provider_unconfigured'
  | 'degraded';
export type ConnectionAuthKind = 'oauth' | 'api_key';
export type SyncRunState =
  'pending' | 'running' | 'succeeded' | 'partial' | 'failed' | 'dead' | 'skipped';
export type SyncDeliveryState = 'pending' | 'delivered' | 'retry_scheduled' | 'dead';
export type SyncConflictState = 'open' | 'kept_local' | 'kept_remote' | 'dismissed';
export interface ConnectionTable {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  scope_key: string;
  lifecycle_state: Defaulted<'active' | 'archived' | 'trashed' | 'purged'>;
  provider: 'loopback' | 'google_calendar' | 'github' | 'email_inbound';
  auth_kind: ConnectionAuthKind;
  display_name: string;
  owner_membership_id: string;
  granted_scopes: string[];
  health: Defaulted<ConnectionHealth>;
  credential_secret_ref: string | null;
  credential_key_version: Defaulted<number>;
  last_success_at: Ts | null;
  last_error: string | null;
  suspended_reason: 'owner_authority' | 'owner_departed' | 'admin' | null;
  suspended_at: Ts | null;
  outbound_paused: Defaulted<boolean>;
  retention_choice: 'retain' | 'remove' | null;
  disconnected_at: Ts | null;
  created_by_membership_id: string;
  created_at: DTs;
  updated_at: DTs;
  updated_by_membership_id: string | null;
  version: Defaulted<number>;
}
export interface SyncCheckpointTable {
  workspace_id: string;
  connection_id: string;
  resource_key: string;
  cursor: string;
  version: Defaulted<number>;
  updated_at: DTs;
}
export interface ExternalIdentityTable {
  id: string;
  public_id: string;
  workspace_id: string;
  connection_id: string;
  external_type: string;
  external_id: string;
  label: string;
  record_id: string | null;
  remote_version: string;
  local_version: string;
  base_version: string;
  detached: Defaulted<boolean>;
  last_synced_at: Ts | null;
  created_at: DTs;
  updated_at: DTs;
}
export interface SyncRunTable {
  id: string;
  workspace_id: string;
  connection_id: string;
  idempotency_key: string | null;
  direction: 'inbound' | 'outbound' | 'test';
  state: SyncRunState;
  attempt: Defaulted<number>;
  failure_class: 'transient' | 'permanent' | 'unconfigured' | 'degraded' | null;
  error_code: string | null;
  read_count: Defaulted<number>;
  write_count: Defaulted<number>;
  conflict_count: Defaulted<number>;
  started_at: DTs;
  finished_at: Ts | null;
}
export interface SyncDeliveryTable {
  id: string;
  workspace_id: string;
  connection_id: string;
  dedupe_key: string;
  state: Defaulted<SyncDeliveryState>;
  attempts: Defaulted<number>;
  next_attempt_at: DTs;
  failure_class: 'transient' | 'permanent' | 'unconfigured' | 'degraded' | null;
  error_code: string | null;
  payload_hash: string | null;
  claimed_until: Ts | null;
  created_at: DTs;
  updated_at: DTs;
}
export interface SyncConflictTable {
  id: string;
  public_id: string;
  workspace_id: string;
  connection_id: string;
  external_identity_id: string;
  field_key: string;
  local_version: string;
  remote_version: string;
  state: Defaulted<SyncConflictState>;
  resolved_by_membership_id: string | null;
  resolved_at: Ts | null;
  created_at: DTs;
  version: Defaulted<number>;
}

export interface ConnectionMappingTable {
  id: string;
  workspace_id: string;
  connection_id: string;
  brand_id: string;
  project_id: string | null;
  external_resource_id: string;
  resource_kind: Defaulted<'calendar'>;
  version: Defaulted<number>;
  created_at: DTs;
  updated_at: DTs;
}

export interface CalendarEventTable {
  id: string;
  public_id: string;
  workspace_id: string;
  connection_id: string;
  owner_membership_id: string;
  calendar_id: string;
  external_event_id: string;
  starts_at: Ts;
  ends_at: Ts;
  event_tz: string;
  all_day: Defaulted<boolean>;
  title: string;
  busy: Defaulted<boolean>;
  linked_work_block_id: string | null;
  remote_version: string;
  version: Defaulted<number>;
  created_at: DTs;
  updated_at: DTs;
  source_id: string | null;
  series_id: string | null;
  occurrence_key: string | null;
  detached: Defaulted<boolean>;
  status: Defaulted<'confirmed' | 'tentative'>;
  link_block_version: number | null;
  link_remote_version: string | null;
  push_pending: Defaulted<boolean>;
}

// Phase 6 integration review (ADR-0037): connected calendars, provider series and exceptions.
export interface CalendarSourceTable {
  id: string;
  public_id: string;
  workspace_id: string;
  connection_id: string;
  owner_membership_id: string;
  external_calendar_id: string;
  label: string;
  calendar_tz: string;
  access_role: 'owner' | 'writer' | 'reader' | 'free_busy';
  is_primary: Defaulted<boolean>;
  selected: Defaulted<boolean>;
  direction: Defaulted<'read' | 'two_way'>;
  brand_id: string | null;
  state: Defaulted<'active' | 'removed'>;
  last_synced_at: Ts | null;
  version: Defaulted<number>;
  created_at: DTs;
  updated_at: DTs;
}

export interface CalendarSeriesTable {
  id: string;
  workspace_id: string;
  connection_id: string;
  source_id: string;
  owner_membership_id: string;
  external_series_id: string;
  title: string;
  rrule: string | null;
  supported: boolean;
  until_at: Ts | null;
  anchor_tz: string;
  dtstart_local: string;
  all_day: Defaulted<boolean>;
  duration_minutes: number;
  busy: Defaulted<boolean>;
  remote_version: string;
  expanded_from: Ts | null;
  expanded_through: Ts | null;
  version: Defaulted<number>;
  created_at: DTs;
  updated_at: DTs;
}

export interface CalendarExceptionTable {
  workspace_id: string;
  series_id: string;
  occurrence_key: string;
  kind: 'cancelled' | 'moved';
  created_at: DTs;
}

// Phase 6B: API tokens, outbound webhooks, and inbound endpoints (ADR-0032).
export type ApiTokenKind = 'personal' | 'service';
export type ApiTokenState = 'active' | 'revoked' | 'suspended';
export type WebhookSubscriptionState = 'active' | 'paused' | 'disabled_endpoint' | 'suspended';
export type WebhookDeliveryState =
  | 'pending'
  | 'delivered'
  | 'retry_scheduled'
  | 'failed'
  | 'unknown'
  | 'disabled_endpoint'
  | 'skipped';
export type WebhookObjectKind =
  'record' | 'comment' | 'review_request' | 'synthetic' | 'unsupported';
export interface ApiTokenTable {
  id: string;
  workspace_id: string;
  public_id: string;
  kind: ApiTokenKind;
  principal_type: string;
  principal_id: string;
  accountable_owner_membership_id: string;
  name: string;
  token_prefix: string;
  token_hash: Bytes;
  scopes: string[];
  brand_ids: string[] | null;
  expires_at: Timestamp | null;
  last_used_at: Timestamp | null;
  state: ApiTokenState;
  revoked_at: Timestamp | null;
  created_by_membership_id: string;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface WebhookSubscriptionTable {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  scope_key: string;
  lifecycle_state: Defaulted<LifecycleState>;
  api_version: string;
  event_types: string[];
  field_allowlist_version: number;
  destination_url: string;
  state: WebhookSubscriptionState;
  signing_secret_ref: string;
  previous_secret_ref: string | null;
  previous_secret_until: Timestamp | null;
  consecutive_failures: Defaulted<number>;
  accountable_owner_membership_id: string;
  suspended_reason: string | null;
  suspended_at: Timestamp | null;
  created_by_membership_id: string;
  created_at: DTs;
  updated_at: DTs;
  updated_by_membership_id: string | null;
  version: Defaulted<number>;
  paused_at: Timestamp | null;
  paused_by_membership_id: string | null;
  stopped_at: Timestamp | null;
}
export interface WebhookDeliveryTable {
  id: string;
  workspace_id: string;
  subscription_id: string;
  public_id: string;
  event_public_id: string;
  event_type: string;
  aggregate_id: string | null;
  facts: Json<Record<string, string | number | boolean | null>>;
  state: WebhookDeliveryState;
  attempt: Defaulted<number>;
  response_status: number | null;
  duration_ms: number | null;
  detail: string | null;
  next_attempt_at: Timestamp | null;
  claimed_until: Timestamp | null;
  created_at: DTs;
  updated_at: DTs;
  event_created_at: DTs;
  object_kind: Defaulted<WebhookObjectKind>;
  object_id: string | null;
  source_record_id: string | null;
  cycle: Defaulted<number>;
  total_attempts: Defaulted<number>;
  replayed_at: Timestamp | null;
  replayed_by_membership_id: string | null;
}
export interface InboundEndpointTable {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  public_id: string;
  path_prefix: string;
  path_hash: Bytes;
  action: string;
  signing_secret_ref: string;
  previous_secret_ref: string | null;
  previous_secret_until: Timestamp | null;
  state: 'active' | 'suspended';
  accountable_owner_membership_id: string;
  suspended_reason: string | null;
  suspended_at: Timestamp | null;
  created_by_membership_id: string;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface InboundMessageTable {
  id: string;
  workspace_id: string;
  endpoint_id: string;
  provider_event_id: string;
  state: 'accepted' | 'processed' | 'quarantined' | 'rejected';
  detail: string | null;
  received_at: DTs;
}
export interface OauthClientTable {
  id: string;
  workspace_id: string;
  public_id: string;
  name: string;
  client_prefix: string;
  client_hash: Bytes;
  redirect_uris: string[];
  allowed_scopes: string[];
  state: 'active' | 'revoked';
  revoked_at: Timestamp | null;
  created_by_membership_id: string;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface OauthConsentTable {
  id: string;
  workspace_id: string;
  public_id: string;
  client_id: string;
  membership_id: string;
  scopes: string[];
  brand_ids: string[] | null;
  state: 'active' | 'revoked';
  revoked_at: Timestamp | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface OauthAccessTokenTable {
  id: string;
  workspace_id: string;
  public_id: string;
  consent_id: string;
  client_id: string;
  token_prefix: string;
  token_hash: Bytes;
  expires_at: Timestamp;
  last_used_at: Timestamp | null;
  state: 'active' | 'revoked';
  revoked_at: Timestamp | null;
  created_at: DTs;
}
export interface McpInvocationTable {
  id: string;
  workspace_id: string;
  public_id: string;
  consent_id: string | null;
  token_id: string | null;
  actor_membership_id: string;
  actor_principal: string;
  actor_public_id: string;
  tool_name: string;
  tool_version: string;
  outcome: 'ok' | 'error' | 'timeout' | 'denied';
  duration_ms: number | null;
  detail: string | null;
  created_at: DTs;
}

// Phase 4E: files, immutable versions, upload sessions, deliverables, and storage usage (ADR-0026).
export type FileScanState = 'pending' | 'clean' | 'infected' | 'error';
export type FileHostKind = 'workspace' | 'brand' | 'project' | 'task' | 'comment' | 'document';
export type DeliverableState =
  'draft' | 'ready_for_review' | 'changes_requested' | 'accepted' | 'rejected';
export interface FileObjectTable {
  id: string;
  workspace_id: string;
  storage_key: string;
  quarantined: Defaulted<boolean>;
  sha256: Bytes;
  byte_size: ColumnType<string, string | number, string | number>;
  content_type: string;
  scan_state: Defaulted<FileScanState>;
  scan_signature: string | null;
  scan_attempts: Defaulted<number>;
  scanned_at: Timestamp | null;
  created_at: DTs;
}
export interface FileTable {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  scope_key: string;
  host_kind: FileHostKind;
  host_record_id: string | null;
  comment_id: string | null;
  name: string;
  owner_membership_id: string;
  source_kind: 'upload' | 'external';
  current_version_id: string | null;
  version_count: Defaulted<number>;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface FileVersionTable {
  id: string;
  workspace_id: string;
  file_id: string;
  version_number: number;
  file_object_id: string | null;
  external_url: string | null;
  name: string;
  content_type: string | null;
  byte_size: ColumnType<string | null, string | number | null, string | number | null>;
  sha256: Buffer | null;
  preview_state: 'pending' | 'ready' | 'unsupported' | 'failed';
  evidence_locked: Defaulted<boolean>;
  created_by_membership_id: string;
  created_at: DTs;
}
export interface UploadSessionTable {
  id: string;
  public_id: string;
  workspace_id: string;
  brand_id: string | null;
  host_kind: FileHostKind;
  host_record_id: string | null;
  comment_id: string | null;
  target_file_id: string | null;
  file_name: string;
  content_type: string;
  byte_size: ColumnType<string, string | number, string | number>;
  sha256: Bytes;
  state: Defaulted<'initiated' | 'uploaded' | 'verifying' | 'completed' | 'rejected' | 'expired'>;
  quarantine_object_key: string;
  file_object_id: string | null;
  file_version_id: string | null;
  rejection_code: string | null;
  expires_at: Timestamp;
  created_by_membership_id: string;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface DeliverableTable {
  id: string;
  workspace_id: string;
  brand_id: string;
  task_id: string;
  title: string;
  expected_type: Defaulted<'any' | 'file' | 'url'>;
  state: Defaulted<DeliverableState>;
  current_version_id: string | null;
  accepted_version_id: string | null;
  created_by_membership_id: string;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface DeliverableVersionTable {
  id: string;
  workspace_id: string;
  deliverable_id: string;
  version_number: number;
  source_kind: 'file' | 'url';
  file_version_id: string | null;
  url: string | null;
  content_sha256: Buffer | null;
  note_text: string | null;
  state: Defaulted<DeliverableState | 'withdrawn' | 'superseded'>;
  review_request_id: string | null;
  decided_review_decision_id: string | null;
  accepted_by_membership_id: string | null;
  accepted_at: Timestamp | null;
  evidence_locked: Defaulted<boolean>;
  submitted_by_membership_id: string;
  created_at: DTs;
  updated_at: DTs;
}
export interface StorageUsageTable {
  workspace_id: string;
  used_bytes: ColumnType<string, string | number | undefined, string | number>;
  reserved_bytes: ColumnType<string, string | number | undefined, string | number>;
  object_count: Defaulted<number>;
  updated_at: DTs;
}

// Phase 5A: the permission-aware search projection, its indexing queue, and recent searches (ADR-0028).
export interface SearchDocumentTable {
  workspace_id: string;
  source_kind: string;
  source_id: string;
  auth_record_id: string;
  context_record_id: string | null;
  title: string;
  body: Defaulted<string>;
  owner_membership_id: string | null;
  source_updated_at: Timestamp;
  indexed_at: DTs;
  /** Generated from title (weight A) and body (weight B); never written. */
  tsv: ColumnType<string, never, never>;
}
export interface SearchIndexStatusTable {
  workspace_id: string;
  source_kind: string;
  source_id: string;
  auth_record_id: string;
  state: Defaulted<'pending' | 'failed'>;
  attempts: Defaulted<number>;
  requested_at: DTs;
  next_attempt_at: DTs;
  last_attempt_at: Ts | null;
  failure_code: 'source_error' | 'invalid_content' | 'timeout' | 'unknown_source' | null;
}
export interface SearchRecentSearchTable {
  id: string;
  workspace_id: string;
  owner_membership_id: string;
  query: string;
  filters: ColumnType<Record<string, unknown>, string | undefined, string>;
  query_key: string;
  search_count: Defaulted<number>;
  searched_at: DTs;
}

// Phase 6D: resumable CSV import operation and provenance rows.
export interface ImportJobTable {
  id: string;
  workspace_id: string;
  owner_membership_id: string;
  preview_id: string | null;
  mapping_id: string | null;
  mapping_version: number | null;
  schema_version: string;
  content_sha256: Bytes;
  request_key_sha256: Bytes;
  entity_kind: 'task' | 'project' | 'workflow' | 'field' | 'goal' | 'document' | 'file';
  state: 'previewed' | 'running' | 'partial' | 'completed' | 'failed' | 'rolled_back';
  apply_mode: 'partial' | 'all_or_nothing';
  row_count: number;
  applied_count: number;
  error_count: number;
  checkpoint_row: number;
  rollback_until: Timestamp | null;
  created_at: DTs;
  updated_at: DTs;
}
export interface ImportRowTable {
  workspace_id: string;
  import_job_id: string;
  row_number: number;
  source_row_key: string | null;
  source_values: Json<Record<string, unknown>>;
  state: 'pending' | 'applied' | 'error' | 'rolled_back' | 'conflict';
  issues: Json<unknown[]>;
  record_type: string | null;
  record_id: string | null;
  record_public_id: string | null;
  applied_version: number | null;
  created_at: DTs;
  updated_at: DTs;
}
export interface ImportMappingTable {
  id: string;
  workspace_id: string;
  owner_membership_id: string;
  name: string;
  entity_kind: 'task' | 'project' | 'workflow' | 'field' | 'goal' | 'document' | 'file';
  schema_version: string;
  mapping_version: number;
  column_mapping: Json<Record<string, string>>;
  created_at: DTs;
  updated_at: DTs;
}
export interface ImportPreviewTable {
  id: string;
  workspace_id: string;
  owner_membership_id: string;
  entity_kind: 'task' | 'project' | 'workflow' | 'field' | 'goal' | 'document' | 'file';
  content_sha256: Bytes;
  schema_version: string;
  mapping_id: string | null;
  mapping_version: number | null;
  expires_at: Timestamp;
  created_at: DTs;
}

export type StatusSpanBasis = 'recorded' | 'assumed' | 'repaired';
export interface MetricsTaskStatusSpanTable {
  workspace_id: string;
  task_id: string;
  seq: number;
  status_id: string;
  status_category: 'planned' | 'active' | 'paused' | 'done' | 'cancelled';
  entered_at: Ts;
  left_at: Ts | null;
  basis: Defaulted<StatusSpanBasis>;
}
export interface MetricsReconcileStateTable {
  workspace_id: string;
  next_run_at: DTs;
  lease_until: Ts | null;
  scan_after: string | null;
  pass_started_at: Ts | null;
  pass_repaired: Defaulted<number>;
  attempts: Defaulted<number>;
  last_success_at: Ts | null;
  last_failure_at: Ts | null;
  failure_code: 'source_error' | 'timeout' | null;
  repaired_total: ColumnType<
    string,
    string | number | bigint | undefined,
    string | number | bigint
  >;
}

// Phase 7A: the AI gateway, its policy, actions, dispatches, outputs, and metering (ADR-0038).
// Money columns are exact numeric micro-dollars read as decimal strings.
export interface AiProviderConfigTable {
  id: string;
  workspace_id: string;
  enabled: Defaulted<boolean>;
  model_key: string | null;
  key_source: Defaulted<'deployment' | 'workspace'>;
  workspace_key_ref: string | null;
  workspace_key_set_at: Timestamp | null;
  max_data_class: Defaulted<'C0' | 'C1' | 'C2'>;
  require_training_exclusion: Defaulted<boolean>;
  confirm_above_micros: Defaulted<string>;
  dispatch_suspended_reason: 'bound_breach' | null;
  dispatch_suspended_at: Timestamp | null;
  updated_by_membership_id: string;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface BrandAiProfileTable {
  id: string;
  workspace_id: string;
  brand_id: string;
  instructions: Defaulted<string>;
  terminology: Defaulted<string>;
  audience: Defaulted<string>;
  voice: Defaulted<string>;
  approved_sources: Defaulted<'readable' | 'brand_only'>;
  updated_by_membership_id: string;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export type AiFunding = 'platform' | 'workspace_key' | 'synthetic';
export interface AiActionTable {
  operation_id: string;
  workspace_id: string;
  initiating_membership_id: string;
  brand_id: string | null;
  /** 7F: `transcription` turns an uploaded voice capture into a transcript (its output). */
  purpose: 'test_run' | 'grounded_answer' | 'change_proposal' | 'analysis' | 'transcription';
  synthetic: boolean;
  model_key: string;
  provider: string;
  model_id: string;
  registry_version: string;
  prompt_template_version: string;
  price_snapshot: Json<Record<string, unknown>>;
  privacy_snapshot: Json<Record<string, unknown>>;
  funding: AiFunding;
  caller_kind: 'ui' | 'api' | 'mcp' | 'automation';
  delegation_principal_type: string | null;
  delegation_token_id: string | null;
  prompt_text: string | null;
  redaction_count: Defaulted<number>;
  max_output_tokens: number;
  estimated_max_micros: string;
  rerun_of_operation_id: string | null;
  content_state: Defaulted<'present' | 'erased'>;
  content_erased_at: Timestamp | null;
  created_at: DTs;
  retrieval_scope: Json<Record<string, unknown>> | null;
  manifest_digest: string | null;
  /** 7C: the versioned action (analysis and drafting actions only). */
  action_key: string | null;
  /** 7C: sha256 of the exact action input, template, bounds, and manifest the person confirmed. */
  input_digest: string | null;
}
export interface AiContextRefTable {
  id: string;
  workspace_id: string;
  operation_id: string;
  position: number;
  record_id: string;
  record_type:
    | 'task'
    | 'project'
    | 'document'
    | 'comment'
    | 'activity'
    | 'goal'
    | 'meeting'
    | 'label'
    | 'member';
  record_public_id: string;
  fields: string[];
  record_version: number;
  included: boolean;
  exclusion_reason: string | null;
  handle: string | null;
  content_hash: string | null;
  source_version: string | null;
  source_flags: Defaulted<string[]>;
  selection: Defaulted<'explicit' | 'scope' | 'search'>;
}
export type AiDispatchState =
  'dispatching' | 'succeeded' | 'partial' | 'refused' | 'failed' | 'unknown' | 'reconciled';
export interface AiDispatchTable {
  id: string;
  workspace_id: string;
  operation_id: string;
  attempt_id: string;
  dispatch_number: number;
  state: Defaulted<AiDispatchState>;
  period_start: string;
  input_token_bound: number;
  output_token_bound: number;
  reserved_micros: string;
  provider_request_id: string | null;
  stop_reason: string | null;
  error_kind: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  settled_micros: string | null;
  usage_basis: 'measured' | 'not_charged' | 'reported' | 'reserved_bound' | null;
  cancel_observed: Defaulted<boolean>;
  started_at: DTs;
  ended_at: Timestamp | null;
  reconciled_by_membership_id: string | null;
  reconciled_at: Timestamp | null;
  price_snapshot: Json<Record<string, unknown>> | null;
  capability_snapshot: Json<Record<string, unknown>> | null;
  bound_breach: Defaulted<boolean>;
  clipped_locally: Defaulted<boolean>;
  failure_detail:
    | 'protocol_invalid'
    | 'stream_overflow'
    | 'unsupported_stop'
    | 'usage_invalid'
    | 'configuration_changed'
    | 'bound_unverified'
    | 'bound_breach'
    | 'content_unavailable'
    | null;
}
export interface AiOutputTable {
  id: string;
  workspace_id: string;
  operation_id: string;
  dispatch_id: string;
  completeness: 'complete' | 'truncated' | 'partial' | 'erased';
  content: string | null;
  created_at: DTs;
  grounding: Json<Record<string, unknown>> | null;
}
export type ProposalOp =
  | 'task.create'
  | 'task.update'
  | 'project.create'
  | 'project.update'
  | 'milestone.create'
  | 'relation.add'
  | 'document.replace'
  | 'task.assign'
  | 'label.add'
  | 'criterion.add'
  // 7F planning operations: canonical 3C block and Today commitment commands.
  | 'block.create'
  | 'block.update'
  | 'block.delete'
  | 'commitment.add'
  | 'commitment.remove';
export interface ChangeProposalTable {
  id: string;
  workspace_id: string;
  public_id: string;
  operation_id: string;
  initiating_membership_id: string;
  schema_version: Defaulted<string>;
  state: Defaulted<'open' | 'approved' | 'applied' | 'failed' | 'rejected'>;
  revision: Defaulted<number>;
  fingerprint: string;
  title: string | null;
  reject_reason: string | null;
  /** 7C: visible assumptions the drafted proposal relies on (content; erased). */
  assumptions: string[] | null;
  content_state: Defaulted<'present' | 'erased'>;
  content_erased_at: Timestamp | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
  /** 7F: `planner` for a deterministic daily plan (no model); `ai_action` for an AI run. */
  origin: Defaulted<'ai_action' | 'planner'>;
  /** 7F: a planner proposal's day, zone, scope, constraint snapshot, and deferrals (content). */
  plan: Json<Record<string, unknown>> | null;
}
export interface ProposedChangeTable {
  id: string;
  workspace_id: string;
  proposal_id: string;
  change_key: string;
  position: number;
  op: ProposalOp;
  temp_ref: string | null;
  target_record_id: string | null;
  target_public_id: string | null;
  expected_version: number | null;
  depends_on: Defaulted<string[]>;
  payload: Json<Record<string, unknown>> | null;
  sources: Defaulted<string[]>;
  selected: Defaulted<boolean>;
  decision: Defaulted<'pending' | 'accepted' | 'edited' | 'rejected'>;
  applied_state: Defaulted<'not_applied' | 'applied' | 'failed' | 'rolled_back' | 'blocked'>;
  result_record_id: string | null;
  result_public_id: string | null;
  failure_code: string | null;
  updated_at: DTs;
}
export interface ProposalEventTable {
  id: string;
  workspace_id: string;
  proposal_id: string;
  revision: number;
  kind:
    | 'generated'
    | 'edited'
    | 'rebased'
    | 'approved'
    | 'approval_superseded'
    | 'rejected'
    | 'applied'
    | 'apply_failed'
    | 'erased';
  actor_membership_id: string | null;
  change_keys: Defaulted<string[]>;
  fingerprint: string;
  created_at: DTs;
}
export interface ProposalApprovalTable {
  id: string;
  workspace_id: string;
  proposal_id: string;
  revision: number;
  approver_membership_id: string;
  selected: string[];
  fingerprint: string;
  target_versions: Json<Record<string, number>>;
  /** The run's scope references and the approver's permission epochs at approval (no content). */
  scope: Json<Record<string, unknown>>;
  risk_class: Defaulted<'R1' | 'R2' | 'R3' | 'R4'>;
  step_up_required: Defaulted<boolean>;
  state: Defaulted<'active' | 'used' | 'superseded' | 'expired' | 'revoked'>;
  expires_at: Timestamp;
  created_at: DTs;
  used_at: Timestamp | null;
}
export type BriefingKind =
  'owner_daily' | 'brand_daily' | 'weekly_review' | 'project_status' | 'release_readiness';
export interface BriefingScheduleTable {
  id: string;
  workspace_id: string;
  public_id: string;
  membership_id: string;
  kind: BriefingKind;
  scope: Json<Record<string, unknown>>;
  scope_key: string;
  timezone: string;
  local_minute: number;
  weekdays: number[];
  channels: Defaulted<string[]>;
  enabled: Defaulted<boolean>;
  revision: Defaulted<number>;
  next_run_at: Timestamp | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface BriefingTable {
  id: string;
  workspace_id: string;
  public_id: string;
  operation_id: string;
  recipient_membership_id: string;
  schedule_id: string | null;
  schedule_revision: number | null;
  occurrence_key: string | null;
  trigger: 'schedule' | 'manual' | 'regenerate';
  regenerates_id: string | null;
  kind: BriefingKind;
  scope: Json<Record<string, unknown>>;
  scope_key: string;
  template_version: string;
  timezone: string;
  window_start: Timestamp;
  window_end: Timestamp;
  baseline_briefing_id: string | null;
  state: Defaulted<'queued' | 'published' | 'failed' | 'superseded'>;
  attempts: Defaulted<number>;
  failure_code: string | null;
  coverage: Json<Record<string, unknown>> | null;
  content_state: Defaulted<'present' | 'erased'>;
  content_erased_at: Timestamp | null;
  published_at: Timestamp | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface BriefingStatementTable {
  id: string;
  workspace_id: string;
  briefing_id: string;
  position: number;
  section: string;
  kind:
    'fact' | 'calculation' | 'excerpt' | 'suggestion' | 'unknown' | 'annotation' | 'unavailable';
  statement_key: string;
  text: string | null;
  refs: ColumnType<unknown[], string | undefined, string>;
  figures: Json<Record<string, unknown>> | null;
  correction_id: string | null;
}
export interface BriefingCorrectionTable {
  id: string;
  workspace_id: string;
  public_id: string;
  recipient_membership_id: string;
  origin_briefing_id: string;
  kind: BriefingKind;
  scope_key: string;
  statement_key: string;
  subject_public_id: string | null;
  subject_version: string | null;
  text: string | null;
  state: Defaulted<'proposed' | 'approved' | 'rejected' | 'superseded' | 'stale' | 'erased'>;
  revision: Defaulted<number>;
  decided_at: Timestamp | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface BriefingCorrectionEventTable {
  id: string;
  workspace_id: string;
  correction_id: string;
  kind: 'proposed' | 'edited' | 'approved' | 'rejected' | 'superseded' | 'stale' | 'erased';
  revision: number;
  actor_membership_id: string | null;
  created_at: DTs;
}
export interface BriefingEvidenceTable {
  id: string;
  workspace_id: string;
  briefing_id: string | null;
  correction_id: string | null;
  position: number | null;
  kind: 'record' | 'brand' | 'permission';
  record_id: string | null;
  brand_id: string | null;
  permission: 'timesheet.approve' | null;
  /** 7F: the planner proposal this evidence row belongs to. */
  proposal_id: string | null;
}
export interface ProposalApplicationTable {
  id: string;
  workspace_id: string;
  proposal_id: string;
  operation_id: string;
  approval_id: string;
  revision: number;
  outcome: 'applied' | 'failed';
  applied_count: number;
  failed_count: number;
  results: Json<Array<Record<string, unknown>>>;
  created_at: DTs;
}
export type AiMeter = 'ai.cost' | 'ai.input_tokens' | 'ai.output_tokens';
export interface SpendLimitTable {
  id: string;
  workspace_id: string;
  scope_key: string;
  meter: AiMeter;
  monthly_allowance: string;
  hard_limit: string;
  updated_by_membership_id: string;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface UsageBalanceTable {
  id: string;
  workspace_id: string;
  scope_key: string;
  meter: AiMeter;
  period_start: string;
  period_end: string;
  consumed: Defaulted<string>;
  allowance_consumed: Defaulted<string>;
  reserved: Defaulted<string>;
  last_threshold_bp: Defaulted<number>;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface UsageReservationTable {
  id: string;
  workspace_id: string;
  operation_id: string;
  dispatch_id: string;
  meter: AiMeter;
  period_start: string;
  amount: string;
  state: Defaulted<'held' | 'unknown' | 'settled' | 'released'>;
  settled_amount: string | null;
  created_at: DTs;
  updated_at: DTs;
}
export interface UsageEventTable {
  id: string;
  workspace_id: string;
  meter: AiMeter;
  quantity: string;
  unit: 'usd_micros' | 'tokens';
  cost_micros: string | null;
  cost_basis: 'measured' | 'estimated' | 'reported';
  funding: AiFunding;
  billable: Defaulted<boolean>;
  brand_id: string | null;
  actor_type: 'ai';
  operation_id: string;
  dispatch_id: string;
  occurred_at: DTs;
  period_start: string;
  correction_of: string | null;
  sequence: number;
}

// ---------------------------------------------------------------------------------------------
// Phase 8A automations (migration 0062)
// ---------------------------------------------------------------------------------------------
export type AutomationRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'policy_rejected'
  | 'cancelled'
  | 'skipped';
export type AutomationStepState =
  | 'succeeded'
  | 'failed'
  | 'refused'
  | 'skipped'
  | 'waiting'
  | 'dispatching'
  | 'unknown'
  | 'cancelled';
export interface AutomationTable {
  id: string;
  workspace_id: string;
  brand_id: string | null;
  scope_key: string;
  lifecycle_state: Defaulted<LifecycleState>;
  name: string;
  description: string | null;
  owner_membership_id: string;
  enabled: Defaulted<boolean>;
  active_revision_id: string | null;
  trigger_kind: string | null;
  trigger_event: string | null;
  activated_at: Timestamp | null;
  draft: Json<Record<string, unknown>>;
  draft_base_revision: number | null;
  template_key: string | null;
  duplicated_from_id: string | null;
  suspended_reason: string | null;
  suspended_at: Timestamp | null;
  active_runs: Defaulted<number>;
  consecutive_failures: Defaulted<number>;
  alerted_at: Timestamp | null;
  created_by_membership_id: string;
  updated_by_membership_id: string | null;
  created_at: DTs;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface AutomationRevisionTable {
  id: string;
  workspace_id: string;
  automation_id: string;
  revision_number: number;
  schema_version: number;
  definition: Json<Record<string, unknown>>;
  definition_hash: string;
  trigger_kind: string;
  record_kind: 'task' | 'project' | null;
  declared_brand_ids: string[];
  declared_project_ids: Defaulted<string[]>;
  action_keys: string[];
  action_classes: string[];
  created_by_membership_id: string;
  created_at: DTs;
}
export interface AutomationRunTable {
  id: string;
  workspace_id: string;
  automation_id: string;
  revision_id: string;
  operation_id: string;
  current_operation_id: string;
  owner_membership_id: string;
  trigger_kind: string;
  trigger_key: string;
  trigger_event_id: string | null;
  trigger_record_id: string | null;
  root_causation_id: string | null;
  lineage: Defaulted<string[]>;
  chain_depth: Defaulted<number>;
  scope_snapshot: Json<Record<string, unknown>>;
  run_day: string;
  timezone: string;
  status: Defaulted<AutomationRunStatus>;
  reason: string | null;
  cursor: string | null;
  wake_at: Timestamp | null;
  steps_executed: Defaulted<number>;
  retry_count: Defaulted<number>;
  usage_state: Defaulted<'none' | 'reserved' | 'settled' | 'released'>;
  slot_held: Defaulted<boolean>;
  initiated_by_membership_id: string | null;
  created_at: DTs;
  started_at: Timestamp | null;
  ended_at: Timestamp | null;
  updated_at: DTs;
  version: Defaulted<number>;
}
export interface AutomationStepRunTable {
  id: string;
  workspace_id: string;
  run_id: string;
  node_id: string;
  attempt: number;
  kind: 'admission' | 'conditions' | 'action' | 'branch' | 'delay';
  action_key: string | null;
  state: AutomationStepState;
  failure_class: string | null;
  code: string | null;
  decision: Json<Record<string, unknown>> | null;
  targets: Json<unknown[]> | null;
  output: Json<Record<string, unknown>> | null;
  logical_key: string | null;
  operation_id: string;
  started_at: DTs;
  ended_at: Timestamp | null;
}
export interface StandingApprovalTable {
  id: string;
  workspace_id: string;
  automation_id: string;
  revision_id: string;
  node_id: string;
  subscription_id: string;
  destination_fingerprint: string;
  field_set: string[];
  scope_hash: string;
  action_class: 'outbound.webhook';
  approved_by_membership_id: string;
  step_up_id: string;
  state: Defaulted<'active' | 'revoked' | 'superseded'>;
  approved_at: DTs;
  ended_at: Timestamp | null;
}
export interface TriggerScheduleTable {
  automation_id: string;
  workspace_id: string;
  revision_id: string;
  kind: 'schedule' | 'date';
  next_due_at: Timestamp | null;
  last_key: string | null;
  updated_at: DTs;
}
export interface AutomationUsagePeriodTable {
  workspace_id: string;
  period_start: string;
  runs_reserved: Defaulted<number>;
  runs_settled: Defaulted<number>;
  runs_released: Defaulted<number>;
  steps_executed: Defaulted<number>;
  alerted_bp: Defaulted<number>;
  updated_at: DTs;
}

// ---------------------------------------------------------------------------------------------
// Phase 8B agent profiles, connectors, and assignments (migration 0064)
// ---------------------------------------------------------------------------------------------
export interface AgentProfileTable {
  id: string;
  workspace_id: string;
  scope_key: string;
  lifecycle_state: Defaulted<LifecycleState>;
  kind: string;
  name: string;
  purpose: string | null;
  owner_membership_id: string;
  state: Defaulted<string>;
  active_revision_id: string | null;
  activated_at: Timestamp | null;
  draft: Json<unknown>;
  draft_base_revision: number | null;
  template_key: string | null;
  duplicated_from_id: string | null;
  suspended_reason: string | null;
  suspended_at: Timestamp | null;
  created_by_membership_id: string;
  updated_by_membership_id: string | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
  version: Defaulted<number>;
}
export interface AgentProfileRevisionTable {
  id: string;
  workspace_id: string;
  profile_id: string;
  revision_number: number;
  schema_version: number;
  kind: string;
  config: Json<unknown>;
  config_hash: string;
  model_key: string | null;
  created_by_membership_id: string;
  created_at: DefaultTimestamp;
}
export interface AgentScopeGrantTable {
  id: string;
  workspace_id: string;
  revision_id: string;
  kind: string;
  target_id: string;
}
export interface AgentToolGrantTable {
  id: string;
  workspace_id: string;
  revision_id: string;
  tool: string;
  tool_version: string;
  tool_class: string;
  approval_class: string;
}
export interface AgentConnectorTable {
  id: string;
  workspace_id: string;
  profile_id: string;
  kind: string;
  endpoint_url: string;
  secret_ref: string | null;
  config_version: Defaulted<number>;
  state: Defaulted<string>;
  verified_version: number | null;
  verified_at: Timestamp | null;
  verified_synthetic: Defaulted<boolean>;
  capabilities: Json<unknown> | null;
  last_code: string | null;
  last_tested_at: Timestamp | null;
  disconnected_at: Timestamp | null;
  created_by_membership_id: string;
  updated_by_membership_id: string | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
  version: Defaulted<number>;
}
export interface AgentConnectorTestTable {
  id: string;
  workspace_id: string;
  connector_id: string;
  operation_id: string;
  config_version: number;
  requested_by_membership_id: string;
  state: Defaulted<string>;
  code: string | null;
  synthetic: Defaulted<boolean>;
  duration_ms: number | null;
  created_at: DefaultTimestamp;
  ended_at: Timestamp | null;
}
export interface AgentAssignmentTable {
  id: string;
  workspace_id: string;
  brand_id: string;
  task_id: string;
  profile_id: string;
  state: Defaulted<string>;
  current_revision_id: string | null;
  assigned_by_membership_id: string;
  withdrawn_by_membership_id: string | null;
  withdrawn_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
  version: Defaulted<number>;
}
export interface AgentAssignmentRevisionTable {
  id: string;
  workspace_id: string;
  assignment_id: string;
  revision_number: number;
  profile_revision_id: string;
  assigner_membership_id: string;
  goal: string;
  constraints: string | null;
  deliverable: string | null;
  criteria: ColumnType<unknown, string | undefined, string>;
  context_refs: Defaulted<string[]>;
  scope_brand_ids: Defaulted<string[]>;
  scope_project_ids: Defaulted<string[]>;
  scope_record_ids: Defaulted<string[]>;
  scope_integration_ids: Defaulted<string[]>;
  created_at: DefaultTimestamp;
}

export interface Database {
  'files.file_object': FileObjectTable;
  'files.file': FileTable;
  'files.file_version': FileVersionTable;
  'files.upload_session': UploadSessionTable;
  'files.deliverable': DeliverableTable;
  'files.deliverable_version': DeliverableVersionTable;
  'files.storage_usage': StorageUsageTable;
  'search.search_document': SearchDocumentTable;
  'search.index_status': SearchIndexStatusTable;
  'search.recent_search': SearchRecentSearchTable;
  'metrics.task_status_span': MetricsTaskStatusSpanTable;
  'metrics.reconcile_state': MetricsReconcileStateTable;
  'notify.notification': NotificationTable;
  'knowledge.document': DocumentTable;
  'knowledge.document_version': DocumentVersionTable;
  'knowledge.document_reference': DocumentReferenceTable;
  'knowledge.document_suggestion': DocumentSuggestionTable;
  'knowledge.source_approval': SourceApprovalTable;
  'knowledge.edit_draft': EditDraftTable;
  'knowledge.edit_session': EditSessionTable;
  'knowledge.edit_op': EditOpTable;
  'goals.goal': GoalTable;
  'goals.key_result': KeyResultTable;
  'goals.goal_checkin': GoalCheckinTable;
  'goals.goal_link': GoalLinkTable;
  'goals.goal_state': GoalStateTable;
  'goals.portfolio': PortfolioTable;
  'goals.portfolio_project': PortfolioProjectTable;
  'insights.dashboard': DashboardTable;
  'insights.report_definition': ReportDefinitionTable;
  'insights.report_recipient': ReportRecipientTable;
  'insights.report_share': ReportShareTable;
  'insights.report_run': ReportRunTable;
  'integrations.connection': ConnectionTable;
  'integrations.sync_checkpoint': SyncCheckpointTable;
  'integrations.external_identity': ExternalIdentityTable;
  'integrations.sync_run': SyncRunTable;
  'integrations.sync_delivery': SyncDeliveryTable;
  'integrations.sync_conflict': SyncConflictTable;
  'integrations.connection_mapping': ConnectionMappingTable;
  'integrations.calendar_event': CalendarEventTable;
  'integrations.calendar_source': CalendarSourceTable;
  'integrations.calendar_series': CalendarSeriesTable;
  'integrations.calendar_exception': CalendarExceptionTable;
  'integrations.api_token': ApiTokenTable;
  'integrations.webhook_subscription': WebhookSubscriptionTable;
  'integrations.webhook_delivery': WebhookDeliveryTable;
  'integrations.inbound_endpoint': InboundEndpointTable;
  'integrations.inbound_message': InboundMessageTable;
  'integrations.oauth_client': OauthClientTable;
  'integrations.oauth_consent': OauthConsentTable;
  'integrations.oauth_access_token': OauthAccessTokenTable;
  'integrations.mcp_invocation': McpInvocationTable;
  'notify.digest': DigestTable;
  'notify.delivery': DeliveryTable;
  'notify.preference': NotificationPreferenceTable;
  'notify.profile': NotificationProfileTable;
  'notify.scope_default': NotificationScopeDefaultTable;
  'collab.comment': CommentTable;
  'collab.comment_revision': CommentRevisionTable;
  'collab.reaction': ReactionTable;
  'relations.mention': MentionTable;
  'relations.follower': FollowerTable;
  'collab.review_request': ReviewRequestTable;
  'collab.review_reviewer': ReviewReviewerTable;
  'collab.review_decision': ReviewDecisionTable;
  'collab.assignment_event': AssignmentEventTable;
  'planning.capacity_profile': CapacityProfileTable;
  'planning.availability_rule': AvailabilityRuleTable;
  'planning.time_off': TimeOffTable;
  'planning.holiday': HolidayTable;
  'planning.capacity_reservation': CapacityReservationTable;
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
  'tenancy.membership': MembershipTable;
  'access.role': RoleTable;
  'access.role_assignment': RoleAssignmentTable;
  'access.permission_epoch': PermissionEpochTable;
  'tenancy.brand': BrandTable;
  'tenancy.brand_setting': BrandSettingTable;
  'tenancy.scope_preference': ScopePreferenceTable;
  'tenancy.team': TeamTable;
  'tenancy.team_member': TeamMemberTable;
  'access.workspace_policy': WorkspacePolicyTable;
  'tenancy.invitation': InvitationTable;
  'access.share_group': ShareGroupTable;
  'access.record_grant': RecordGrantTable;
  'tenancy.ownership_transfer': OwnershipTransferTable;
  'identity.account_preference': AccountPreferenceTable;
  'views.favorite': FavoriteTable;
  'views.recent_item': RecentItemTable;
  'views.view_state': ViewStateTable;
  'views.view_pin': ViewPinTable;
  'views.saved_view': SavedViewTable;
  'views.view_default': ViewDefaultTable;
  'workflow.platform_status': PlatformStatusTable;
  'work.project': ProjectTable;
  'work.phase': PhaseTable;
  'work.milestone': MilestoneTable;
  'work.criteria_item': CriteriaItemTable;
  'work.task': TaskTable;
  'work.task_assignee': TaskAssigneeTable;
  'work.checklist_item': ChecklistItemTable;
  'work.task_inherited_criterion': TaskInheritedCriterionTable;
  'work.label': LabelTable;
  'work.task_label': TaskLabelTable;
  'relations.record_link': RecordLinkTable;
  'work.scope_item': ScopeItemTable;
  'work.project_update': ProjectUpdateTable;
  'work.project_update_verification': ProjectUpdateVerificationTable;
  'work.decision_record': DecisionRecordTable;
  'relations.record_relationship': RecordRelationshipTable;
  'templates.template': TemplateTable;
  'templates.template_version': TemplateVersionTable;
  'planning.recurrence_series': RecurrenceSeriesTable;
  'workflow.workflow': WorkflowTable;
  'workflow.workflow_status': WorkflowStatusTable;
  'workflow.transition': WfTransitionTable;
  'workflow.transition_requirement': WfTransitionRequirementTable;
  'workflow.transition_approver': WfTransitionApproverTable;
  'workflow.approval_request': WfApprovalRequestTable;
  'workflow.approval_decision': WfApprovalDecisionTable;
  'workflow.field_definition': WfFieldDefinitionTable;
  'workflow.field_option': WfFieldOptionTable;
  'workflow.formula_dependency': WfFormulaDependencyTable;
  'workflow.field_value': WfFieldValueTable;
  'workflow.field_set': WfFieldSetTable;
  'workflow.field_set_version': WfFieldSetVersionTable;
  'workflow.field_set_attachment': WfFieldSetAttachmentTable;
  'access.field_policy': FieldPolicyTable;
  'planning.task_reminder': TaskReminderTable;
  'planning.task_snooze': TaskSnoozeTable;
  'work.bulk_operation': BulkOperationTable;
  'work.undo_entry': UndoEntryTable;
  'capture.inbox_item': InboxItemTable;
  'capture.voice_capture': VoiceCaptureTable;
  'capture.note': NoteTable;
  'capture.capture_conversion': CaptureConversionTable;
  'capture.intake_form': IntakeFormTable;
  'capture.intake_submission': IntakeSubmissionTable;
  'timetrack.time_entry': TimeEntryTable;
  'timetrack.time_segment': TimeSegmentTable;
  'timetrack.timesheet': TimesheetTable;
  'timetrack.timesheet_line': TimesheetLineTable;
  'timetrack.timesheet_approval': TimesheetApprovalTable;
  'timetrack.period_lock': PeriodLockTable;
  'planning.work_block': WorkBlockTable;
  'planning.block_series': BlockSeriesTable;
  'planning.today_commitment': TodayCommitmentTable;
  'planning.daily_record': DailyRecordTable;
  'transfer.import_job': ImportJobTable;
  'transfer.import_row': ImportRowTable;
  'transfer.import_mapping': ImportMappingTable;
  'transfer.import_preview': ImportPreviewTable;
  'ai.ai_provider_config': AiProviderConfigTable;
  'ai.brand_ai_profile': BrandAiProfileTable;
  'ai.ai_action': AiActionTable;
  'ai.ai_context_ref': AiContextRefTable;
  'ai.ai_dispatch': AiDispatchTable;
  'ai.ai_output': AiOutputTable;
  'ai.change_proposal': ChangeProposalTable;
  'ai.proposed_change': ProposedChangeTable;
  'ai.proposal_event': ProposalEventTable;
  'ai.proposal_approval': ProposalApprovalTable;
  'ai.proposal_application': ProposalApplicationTable;
  'ai.briefing_schedule': BriefingScheduleTable;
  'ai.briefing': BriefingTable;
  'ai.briefing_statement': BriefingStatementTable;
  'ai.briefing_correction': BriefingCorrectionTable;
  'ai.briefing_correction_event': BriefingCorrectionEventTable;
  'ai.briefing_evidence': BriefingEvidenceTable;
  'metering.spend_limit': SpendLimitTable;
  'metering.usage_balance': UsageBalanceTable;
  'metering.usage_reservation': UsageReservationTable;
  'metering.usage_event': UsageEventTable;
  'automation.automation': AutomationTable;
  'automation.automation_revision': AutomationRevisionTable;
  'automation.automation_run': AutomationRunTable;
  'automation.automation_step_run': AutomationStepRunTable;
  'automation.standing_approval': StandingApprovalTable;
  'automation.trigger_schedule': TriggerScheduleTable;
  'automation.usage_period': AutomationUsagePeriodTable;
  'agents.agent_profile': AgentProfileTable;
  'agents.agent_profile_revision': AgentProfileRevisionTable;
  'agents.agent_scope_grant': AgentScopeGrantTable;
  'agents.agent_tool_grant': AgentToolGrantTable;
  'agents.agent_connector': AgentConnectorTable;
  'agents.agent_connector_test': AgentConnectorTestTable;
  'agents.agent_assignment': AgentAssignmentTable;
  'agents.agent_assignment_revision': AgentAssignmentRevisionTable;
}

/** Column inventory per table, compared with the migrated catalog by the schema-drift test. */
export const TABLE_COLUMNS: Readonly<Record<keyof Database, readonly string[]>> = {
  'files.file_object': [
    'id',
    'workspace_id',
    'storage_key',
    'quarantined',
    'sha256',
    'byte_size',
    'content_type',
    'scan_state',
    'scan_signature',
    'scan_attempts',
    'scanned_at',
    'created_at',
  ],
  'files.file': [
    'id',
    'workspace_id',
    'brand_id',
    'scope_key',
    'host_kind',
    'host_record_id',
    'comment_id',
    'name',
    'owner_membership_id',
    'source_kind',
    'current_version_id',
    'version_count',
    'created_at',
    'updated_at',
    'version',
  ],
  'files.file_version': [
    'id',
    'workspace_id',
    'file_id',
    'version_number',
    'file_object_id',
    'external_url',
    'name',
    'content_type',
    'byte_size',
    'sha256',
    'preview_state',
    'evidence_locked',
    'created_by_membership_id',
    'created_at',
  ],
  'files.upload_session': [
    'id',
    'public_id',
    'workspace_id',
    'brand_id',
    'host_kind',
    'host_record_id',
    'comment_id',
    'target_file_id',
    'file_name',
    'content_type',
    'byte_size',
    'sha256',
    'state',
    'quarantine_object_key',
    'file_object_id',
    'file_version_id',
    'rejection_code',
    'expires_at',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'version',
  ],
  'files.deliverable': [
    'id',
    'workspace_id',
    'brand_id',
    'task_id',
    'title',
    'expected_type',
    'state',
    'current_version_id',
    'accepted_version_id',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'version',
  ],
  'files.deliverable_version': [
    'id',
    'workspace_id',
    'deliverable_id',
    'version_number',
    'source_kind',
    'file_version_id',
    'url',
    'content_sha256',
    'note_text',
    'state',
    'review_request_id',
    'decided_review_decision_id',
    'accepted_by_membership_id',
    'accepted_at',
    'evidence_locked',
    'submitted_by_membership_id',
    'created_at',
    'updated_at',
  ],
  'files.storage_usage': [
    'workspace_id',
    'used_bytes',
    'reserved_bytes',
    'object_count',
    'updated_at',
  ],
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
    'logo_file_ref',
    'creation_key_hash',
    'creation_request_hash',
    'bootstrap_account_id',
    'bootstrap_membership_id',
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
    'destination_fingerprint',
    'claim_token',
    'claimed_at',
    'claim_until',
    'not_sent_code',
    'uncertainty_reason',
    'late_outcome',
    'late_outcome_at',
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
    'key_id',
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
  'tenancy.membership': [
    'id',
    'public_id',
    'workspace_id',
    'account_id',
    'kind',
    'state',
    'display_name_override',
    'invited_at',
    'joined_at',
    'suspended_at',
    'removed_at',
    'created_at',
    'updated_at',
    'version',
    'departure_reason',
    'state_changed_by_membership_id',
  ],
  'access.role': ['id', 'workspace_id', 'key', 'kind', 'level', 'builtin', 'created_at', 'version'],
  'access.role_assignment': [
    'id',
    'workspace_id',
    'principal_type',
    'principal_id',
    'membership_principal_id',
    'team_principal_id',
    'scope_type',
    'scope_id',
    'brand_scope_id',
    'project_scope_id',
    'role_id',
    'role_kind',
    'grant_source',
    'granted_by_membership_id',
    'expires_at',
    'elevated',
    'elevation_reason',
    'elevation_step_up_id',
    'created_at',
    'version',
  ],
  'access.permission_epoch': ['workspace_id', 'epoch_kind', 'subject_id', 'epoch', 'bumped_at'],
  'tenancy.brand': [
    'id',
    'workspace_id',
    'scope_key',
    'lifecycle_state',
    'name',
    'short_name',
    'logo_file_ref',
    'color',
    'icon',
    'description',
    'operational_status',
    'timezone',
    'is_sensitive',
    'notification_content_mode',
    'created_at',
    'created_by_membership_id',
    'updated_at',
    'updated_by_membership_id',
    'version',
  ],
  'tenancy.brand_setting': [
    'workspace_id',
    'brand_id',
    'working_hours',
    'calendar',
    'priorities',
    'notification_settings',
    'ai_settings',
    'integration_settings',
    'updated_at',
    'updated_by_membership_id',
    'version',
  ],
  'tenancy.scope_preference': [
    'workspace_id',
    'owner_membership_id',
    'scope_kind',
    'brand_id',
    'updated_at',
  ],
  'tenancy.team': [
    'id',
    'workspace_id',
    'scope_key',
    'lifecycle_state',
    'name',
    'description',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'updated_by_membership_id',
    'version',
  ],
  'tenancy.team_member': [
    'workspace_id',
    'team_id',
    'membership_id',
    'added_by_membership_id',
    'created_at',
  ],
  'access.workspace_policy': [
    'workspace_id',
    'self_approval_mode',
    'require_independent_for',
    'members_invite_guests',
    'limited_members_can_export',
    'limited_members_tokens',
    'limited_members_ai',
    'limited_members_agents',
    'read_only_ai',
    'members_configure_agents',
    'admins_manage_billing',
    'comment_on_archived',
    'workspace_records_default_level',
    'cross_brand_sharing_enabled',
    'guest_invitations_enabled',
    'public_links_enabled',
    'share_max_expiry',
    'token_max_lifetime',
    'low_impact_agent_actions',
    'updated_at',
    'updated_by_membership_id',
    'version',
  ],
  'tenancy.invitation': [
    'id',
    'public_id',
    'workspace_id',
    'email_key',
    'kind',
    'role_key',
    'scope_proposal',
    'invited_by_membership_id',
    'state',
    'expires_at',
    'send_count',
    'last_sent_at',
    'token_id',
    'accepted_account_id',
    'accepted_membership_id',
    'revoked_by_membership_id',
    'decided_at',
    'created_at',
    'updated_at',
    'version',
  ],
  'access.share_group': [
    'id',
    'public_id',
    'workspace_id',
    'source_record_id',
    'source_brand_id',
    'grantee_type',
    'grantee_id',
    'grantee_membership_id',
    'grantee_team_id',
    'grantee_brand_id',
    'level',
    'expires_at',
    'state',
    'created_by_membership_id',
    'created_at',
    'revoked_at',
    'revoked_by_membership_id',
    'record_count',
    'version',
  ],
  'access.record_grant': [
    'id',
    'public_id',
    'workspace_id',
    'share_group_id',
    'record_id',
    'source_brand_id',
    'grantee_type',
    'grantee_id',
    'grantee_key',
    'grantee_membership_id',
    'grantee_team_id',
    'grantee_brand_id',
    'level',
    'state',
    'expires_at',
    'created_by_membership_id',
    'created_at',
    'revoked_at',
    'revoked_by_membership_id',
    'version',
  ],
  'tenancy.ownership_transfer': [
    'id',
    'public_id',
    'workspace_id',
    'from_membership_id',
    'to_membership_id',
    'state',
    'demote_previous',
    'expires_at',
    'requested_step_up_id',
    'accepted_step_up_id',
    'decided_at',
    'decided_by_membership_id',
    'created_at',
    'version',
  ],
  'identity.account_preference': [
    'account_id',
    'theme',
    'density',
    'motion',
    'shortcuts',
    'start_destination',
    'record_open',
    'hidden_destinations',
    'updated_at',
    'version',
  ],
  'views.favorite': ['workspace_id', 'owner_membership_id', 'record_id', 'rank', 'created_at'],
  'views.recent_item': [
    'workspace_id',
    'owner_membership_id',
    'record_id',
    'visited_at',
    'visit_count',
  ],
  'views.view_state': [
    'workspace_id',
    'owner_membership_id',
    'device_key_hash',
    'view_key',
    'schema_version',
    'state',
    'updated_at',
    'expires_at',
    'version',
  ],
  'views.view_pin': [
    'workspace_id',
    'scope_key',
    'brand_id',
    'saved_view_id',
    'rank',
    'pinned_by_membership_id',
    'created_at',
  ],
  'views.saved_view': [
    'id',
    'workspace_id',
    'scope_key',
    'lifecycle_state',
    'entity',
    'name',
    'description',
    'owner_membership_id',
    'visibility',
    'share_scope',
    'share_brand_id',
    'share_project_id',
    'schema_version',
    'query',
    'presentation',
    'layout',
    'shared_at',
    'shared_by_membership_id',
    'created_at',
    'updated_at',
    'updated_by_membership_id',
    'version',
  ],
  'views.view_default': [
    'workspace_id',
    'target_kind',
    'target_key',
    'entity',
    'member_id',
    'brand_id',
    'project_id',
    'saved_view_id',
    'set_by_membership_id',
    'updated_at',
    'version',
  ],
  'planning.capacity_profile': [
    'workspace_id',
    'membership_id',
    'weekly_capacity_minutes',
    'observe_brand_holidays',
    'updated_at',
    'version',
  ],
  'planning.availability_rule': [
    'workspace_id',
    'membership_id',
    'weekday',
    'start_minute',
    'end_minute',
  ],
  'planning.time_off': [
    'id',
    'public_id',
    'workspace_id',
    'membership_id',
    'kind',
    'all_day',
    'starts_on',
    'ends_on',
    'starts_at',
    'ends_at',
    'source_tz',
    'label',
    'created_at',
    'updated_at',
    'version',
  ],
  'planning.holiday': [
    'id',
    'public_id',
    'workspace_id',
    'brand_id',
    'day',
    'name',
    'created_by_membership_id',
    'created_at',
  ],
  'planning.capacity_reservation': [
    'id',
    'public_id',
    'workspace_id',
    'brand_id',
    'membership_id',
    'minutes_per_week',
    'effective_from',
    'effective_to',
    'set_by_membership_id',
    'created_at',
    'updated_at',
    'version',
  ],
  'collab.comment': [
    'id',
    'public_id',
    'workspace_id',
    'host_record_id',
    'root_comment_id',
    'in_reply_to_comment_id',
    'body_rich',
    'body_text',
    'author_membership_id',
    'author_actor_type',
    'created_at',
    'edited_at',
    'edit_count',
    'deleted_at',
    'deleted_by_membership_id',
    'deleted_by_kind',
    'version',
  ],
  'collab.comment_revision': [
    'id',
    'workspace_id',
    'comment_id',
    'revision_no',
    'kind',
    'body_rich',
    'body_text',
    'actor_membership_id',
    'created_at',
  ],
  'collab.reaction': ['workspace_id', 'comment_id', 'membership_id', 'reaction', 'created_at'],
  'relations.mention': [
    'id',
    'workspace_id',
    'source_kind',
    'source_id',
    'target_kind',
    'target_membership_id',
    'target_team_id',
    'target_record_id',
    'position',
    'notified',
    'created_at',
  ],
  'relations.follower': ['workspace_id', 'record_id', 'membership_id', 'source', 'created_at'],
  'collab.review_request': [
    'id',
    'public_id',
    'workspace_id',
    'subject_record_id',
    'subject_kind',
    'subject_version',
    'kind',
    'rule',
    'state',
    'requested_by_membership_id',
    'message_text',
    'previous_request_id',
    'closed_reason',
    'settled_at',
    'created_at',
    'updated_at',
    'version',
  ],
  'collab.review_reviewer': ['workspace_id', 'review_request_id', 'membership_id', 'rank'],
  'collab.review_decision': [
    'id',
    'workspace_id',
    'review_request_id',
    'reviewer_membership_id',
    'outcome',
    'subject_version',
    'note_text',
    'self_approval',
    'decided_at',
  ],
  'collab.assignment_event': [
    'id',
    'workspace_id',
    'task_id',
    'kind',
    'via',
    'from_membership_id',
    'to_membership_id',
    'actor_membership_id',
    'note_text',
    'occurred_at',
  ],
  'knowledge.document': [
    'id',
    'workspace_id',
    'brand_id',
    'scope_key',
    'lifecycle_state',
    'parent_document_id',
    'ancestor_ids',
    'depth',
    'attached_project_id',
    'attached_task_id',
    'doc_type',
    'title',
    'state',
    'owner_membership_id',
    'review_due_on',
    'current_version_id',
    'current_version_number',
    'access_mode',
    'allow_record_shares',
    'rank',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'updated_by_membership_id',
    'version',
  ],
  'knowledge.document_version': [
    'id',
    'public_id',
    'workspace_id',
    'document_id',
    'number',
    'title',
    'content',
    'content_hash',
    'size_bytes',
    'kind',
    'restored_from_number',
    'template_key',
    'change_summary',
    'created_by_membership_id',
    'created_at',
  ],
  'knowledge.document_reference': [
    'id',
    'workspace_id',
    'document_id',
    'block_id',
    'position',
    'kind',
    'target_kind',
    'target_membership_id',
    'target_team_id',
    'target_record_id',
    'target_record_type',
    'created_at',
  ],
  'knowledge.document_suggestion': [
    'id',
    'public_id',
    'workspace_id',
    'document_id',
    'block_id',
    'base_version',
    'base_block_hash',
    'proposed',
    'note',
    'state',
    'author_membership_id',
    'decided_by_membership_id',
    'decided_at',
    'applied_version',
    'created_at',
    'updated_at',
    'version',
  ],
  'search.search_document': [
    'workspace_id',
    'source_kind',
    'source_id',
    'auth_record_id',
    'context_record_id',
    'title',
    'body',
    'owner_membership_id',
    'source_updated_at',
    'indexed_at',
    'tsv',
  ],
  'search.index_status': [
    'workspace_id',
    'source_kind',
    'source_id',
    'auth_record_id',
    'state',
    'attempts',
    'requested_at',
    'next_attempt_at',
    'last_attempt_at',
    'failure_code',
  ],
  'metrics.task_status_span': [
    'workspace_id',
    'task_id',
    'seq',
    'status_id',
    'status_category',
    'entered_at',
    'left_at',
    'basis',
  ],
  'metrics.reconcile_state': [
    'workspace_id',
    'next_run_at',
    'lease_until',
    'scan_after',
    'pass_started_at',
    'pass_repaired',
    'attempts',
    'last_success_at',
    'last_failure_at',
    'failure_code',
    'repaired_total',
  ],
  'search.recent_search': [
    'id',
    'workspace_id',
    'owner_membership_id',
    'query',
    'filters',
    'query_key',
    'search_count',
    'searched_at',
  ],
  'knowledge.edit_draft': [
    'workspace_id',
    'document_id',
    'base_version',
    'content',
    'content_hash',
    'seq',
    'checkpoint_seq',
    'dirty',
    'last_editor_membership_id',
    'created_at',
    'updated_at',
  ],
  'knowledge.edit_session': [
    'id',
    'workspace_id',
    'document_id',
    'membership_id',
    'session_key',
    'mode',
    'color',
    'caret_block',
    'started_at',
    'last_seen_at',
    'expires_at',
  ],
  'knowledge.edit_op': [
    'workspace_id',
    'document_id',
    'seq',
    'session_id',
    'membership_id',
    'op_id',
    'kind',
    'block_id',
    'payload',
    'created_at',
  ],
  'goals.goal': [
    'id',
    'workspace_id',
    'brand_id',
    'scope_key',
    'lifecycle_state',
    'project_id',
    'title',
    'description',
    'owner_membership_id',
    'status',
    'period_kind',
    'period_start',
    'period_end',
    'progress_basis',
    'unit',
    'baseline_value',
    'target_value',
    'current_value',
    'latest_percent',
    'latest_checkin_id',
    'latest_checkin_at',
    'latest_confidence',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'updated_by_membership_id',
    'version',
  ],
  'goals.key_result': [
    'id',
    'workspace_id',
    'brand_id',
    'scope_key',
    'lifecycle_state',
    'goal_id',
    'title',
    'owner_membership_id',
    'progress_basis',
    'unit',
    'baseline_value',
    'target_value',
    'current_value',
    'latest_percent',
    'latest_checkin_id',
    'latest_checkin_at',
    'latest_confidence',
    'rank',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'updated_by_membership_id',
    'version',
  ],
  'goals.goal_checkin': [
    'id',
    'public_id',
    'workspace_id',
    'goal_id',
    'key_result_id',
    'source',
    'value',
    'progress_percent',
    'confidence',
    'note',
    'inputs_hash',
    'author_membership_id',
    'created_at',
  ],
  'goals.goal_link': [
    'id',
    'workspace_id',
    'goal_id',
    'key_result_id',
    'target_kind',
    'target_record_id',
    'target_brand_id',
    'created_by_membership_id',
    'created_at',
  ],
  'goals.goal_state': [
    'workspace_id',
    'goal_id',
    'rollup_percent',
    'rollup_basis',
    'inputs_hash',
    'update_state',
    'period_state',
    'dirty',
    'next_check_at',
    'claimed_until',
    'attempts',
    'last_error',
    'computed_at',
  ],
  'goals.portfolio': [
    'id',
    'workspace_id',
    'brand_id',
    'scope_key',
    'lifecycle_state',
    'name',
    'description',
    'owner_membership_id',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'updated_by_membership_id',
    'version',
  ],
  'goals.portfolio_project': [
    'workspace_id',
    'portfolio_id',
    'project_id',
    'position',
    'added_by_membership_id',
    'added_at',
  ],
  'insights.dashboard': [
    'id',
    'workspace_id',
    'brand_id',
    'scope_key',
    'lifecycle_state',
    'project_id',
    'kind',
    'title',
    'description',
    'owner_membership_id',
    'layout',
    'filters',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'updated_by_membership_id',
    'version',
  ],
  'insights.report_definition': [
    'id',
    'workspace_id',
    'brand_id',
    'scope_key',
    'lifecycle_state',
    'project_id',
    'title',
    'description',
    'owner_membership_id',
    'config',
    'schedule_frequency',
    'schedule_weekday',
    'schedule_monthday',
    'schedule_minute',
    'schedule_timezone',
    'next_run_at',
    'last_run_at',
    'claimed_until',
    'attempts',
    'last_error',
    'suspended_reason',
    'suspended_at',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'updated_by_membership_id',
    'version',
  ],
  'insights.report_recipient': [
    'workspace_id',
    'report_id',
    'membership_id',
    'added_by_membership_id',
    'added_at',
  ],
  'insights.report_share': [
    'id',
    'public_id',
    'workspace_id',
    'scope_key',
    'report_id',
    'grantee_membership_id',
    'created_by_membership_id',
    'created_at',
    'expires_at',
    'revoked_at',
    'revoked_by_membership_id',
  ],
  'insights.report_run': [
    'id',
    'workspace_id',
    'report_id',
    'recipient_membership_id',
    'occurrence_at',
    'state',
    'detail',
    'row_count',
    'incomplete',
    'content_hash',
    'failure_class',
    'attempts',
    'created_at',
    'finished_at',
  ],
  'integrations.connection': [
    'id',
    'workspace_id',
    'brand_id',
    'scope_key',
    'lifecycle_state',
    'provider',
    'auth_kind',
    'display_name',
    'owner_membership_id',
    'granted_scopes',
    'health',
    'credential_secret_ref',
    'credential_key_version',
    'last_success_at',
    'last_error',
    'suspended_reason',
    'suspended_at',
    'outbound_paused',
    'retention_choice',
    'disconnected_at',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'updated_by_membership_id',
    'version',
  ],
  'integrations.sync_checkpoint': [
    'workspace_id',
    'connection_id',
    'resource_key',
    'cursor',
    'version',
    'updated_at',
  ],
  'integrations.external_identity': [
    'id',
    'public_id',
    'workspace_id',
    'connection_id',
    'external_type',
    'external_id',
    'label',
    'record_id',
    'remote_version',
    'local_version',
    'base_version',
    'detached',
    'last_synced_at',
    'created_at',
    'updated_at',
  ],
  'integrations.sync_run': [
    'id',
    'workspace_id',
    'connection_id',
    'idempotency_key',
    'direction',
    'state',
    'attempt',
    'failure_class',
    'error_code',
    'read_count',
    'write_count',
    'conflict_count',
    'started_at',
    'finished_at',
  ],
  'integrations.sync_delivery': [
    'id',
    'workspace_id',
    'connection_id',
    'dedupe_key',
    'state',
    'attempts',
    'next_attempt_at',
    'failure_class',
    'error_code',
    'payload_hash',
    'claimed_until',
    'created_at',
    'updated_at',
  ],
  'integrations.sync_conflict': [
    'id',
    'public_id',
    'workspace_id',
    'connection_id',
    'external_identity_id',
    'field_key',
    'local_version',
    'remote_version',
    'state',
    'resolved_by_membership_id',
    'resolved_at',
    'created_at',
    'version',
  ],
  'integrations.connection_mapping': [
    'id',
    'workspace_id',
    'connection_id',
    'brand_id',
    'project_id',
    'external_resource_id',
    'resource_kind',
    'version',
    'created_at',
    'updated_at',
  ],
  'integrations.calendar_event': [
    'id',
    'public_id',
    'workspace_id',
    'connection_id',
    'owner_membership_id',
    'calendar_id',
    'external_event_id',
    'starts_at',
    'ends_at',
    'event_tz',
    'all_day',
    'title',
    'busy',
    'linked_work_block_id',
    'remote_version',
    'version',
    'created_at',
    'updated_at',
    'source_id',
    'series_id',
    'occurrence_key',
    'detached',
    'status',
    'link_block_version',
    'link_remote_version',
    'push_pending',
  ],
  'integrations.calendar_source': [
    'id',
    'public_id',
    'workspace_id',
    'connection_id',
    'owner_membership_id',
    'external_calendar_id',
    'label',
    'calendar_tz',
    'access_role',
    'is_primary',
    'selected',
    'direction',
    'brand_id',
    'state',
    'last_synced_at',
    'version',
    'created_at',
    'updated_at',
  ],
  'integrations.calendar_series': [
    'id',
    'workspace_id',
    'connection_id',
    'source_id',
    'owner_membership_id',
    'external_series_id',
    'title',
    'rrule',
    'supported',
    'until_at',
    'anchor_tz',
    'dtstart_local',
    'all_day',
    'duration_minutes',
    'busy',
    'remote_version',
    'expanded_from',
    'expanded_through',
    'version',
    'created_at',
    'updated_at',
  ],
  'integrations.calendar_exception': [
    'workspace_id',
    'series_id',
    'occurrence_key',
    'kind',
    'created_at',
  ],
  'integrations.api_token': [
    'id',
    'workspace_id',
    'public_id',
    'kind',
    'principal_type',
    'principal_id',
    'accountable_owner_membership_id',
    'name',
    'token_prefix',
    'token_hash',
    'scopes',
    'brand_ids',
    'expires_at',
    'last_used_at',
    'state',
    'revoked_at',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'version',
  ],
  'integrations.webhook_subscription': [
    'id',
    'workspace_id',
    'brand_id',
    'scope_key',
    'lifecycle_state',
    'api_version',
    'event_types',
    'field_allowlist_version',
    'destination_url',
    'state',
    'signing_secret_ref',
    'previous_secret_ref',
    'previous_secret_until',
    'consecutive_failures',
    'accountable_owner_membership_id',
    'suspended_reason',
    'suspended_at',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'updated_by_membership_id',
    'version',
    'paused_at',
    'paused_by_membership_id',
    'stopped_at',
  ],
  'integrations.webhook_delivery': [
    'id',
    'workspace_id',
    'subscription_id',
    'public_id',
    'event_public_id',
    'event_type',
    'aggregate_id',
    'facts',
    'state',
    'attempt',
    'response_status',
    'duration_ms',
    'detail',
    'next_attempt_at',
    'claimed_until',
    'created_at',
    'updated_at',
    'event_created_at',
    'object_kind',
    'object_id',
    'source_record_id',
    'cycle',
    'total_attempts',
    'replayed_at',
    'replayed_by_membership_id',
  ],
  'integrations.inbound_endpoint': [
    'id',
    'workspace_id',
    'brand_id',
    'public_id',
    'path_prefix',
    'path_hash',
    'action',
    'signing_secret_ref',
    'previous_secret_ref',
    'previous_secret_until',
    'state',
    'accountable_owner_membership_id',
    'suspended_reason',
    'suspended_at',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'version',
  ],
  'integrations.inbound_message': [
    'id',
    'workspace_id',
    'endpoint_id',
    'provider_event_id',
    'state',
    'detail',
    'received_at',
  ],
  'integrations.oauth_client': [
    'id',
    'workspace_id',
    'public_id',
    'name',
    'client_prefix',
    'client_hash',
    'redirect_uris',
    'allowed_scopes',
    'state',
    'revoked_at',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'version',
  ],
  'integrations.oauth_consent': [
    'id',
    'workspace_id',
    'public_id',
    'client_id',
    'membership_id',
    'scopes',
    'brand_ids',
    'state',
    'revoked_at',
    'created_at',
    'updated_at',
    'version',
  ],
  'integrations.oauth_access_token': [
    'id',
    'workspace_id',
    'public_id',
    'consent_id',
    'client_id',
    'token_prefix',
    'token_hash',
    'expires_at',
    'last_used_at',
    'state',
    'revoked_at',
    'created_at',
  ],
  'integrations.mcp_invocation': [
    'id',
    'workspace_id',
    'public_id',
    'consent_id',
    'token_id',
    'actor_membership_id',
    'actor_principal',
    'actor_public_id',
    'tool_name',
    'tool_version',
    'outcome',
    'duration_ms',
    'detail',
    'created_at',
  ],
  'knowledge.source_approval': [
    'id',
    'workspace_id',
    'document_id',
    'version_number',
    'kind',
    'actor_membership_id',
    'note',
    'created_at',
  ],
  'notify.notification': [
    'id',
    'public_id',
    'workspace_id',
    'recipient_membership_id',
    'type',
    'record_id',
    'actor_membership_id',
    'source_event_id',
    'dedupe_key',
    'group_key',
    'facts',
    'occurrences',
    'state',
    'digest_pending',
    'digest_id',
    'created_at',
    'last_occurred_at',
    'state_changed_at',
    'version',
  ],
  'notify.digest': [
    'id',
    'workspace_id',
    'recipient_membership_id',
    'period_kind',
    'period_start',
    'period_end',
    'item_count',
    'state',
    'created_at',
  ],
  'notify.delivery': [
    'id',
    'public_id',
    'workspace_id',
    'recipient_membership_id',
    'channel',
    'kind',
    'notification_id',
    'digest_id',
    'state',
    'attempts',
    'next_attempt_at',
    'lease_until',
    'failure_class',
    'failure_code',
    'suppress_reason',
    'provider_message_id',
    'ack_source',
    'created_at',
    'updated_at',
    'delivered_at',
    'version',
  ],
  'notify.preference': [
    'id',
    'workspace_id',
    'membership_id',
    'event_type',
    'scope_kind',
    'scope_record_id',
    'channel',
    'mode',
    'expires_at',
    'updated_at',
    'version',
  ],
  'notify.profile': [
    'workspace_id',
    'membership_id',
    'timezone',
    'quiet_start_minute',
    'quiet_end_minute',
    'email_enabled',
    'browser_enabled',
    'browser_permission',
    'digest_cadence',
    'daily_digest_minute',
    'weekly_digest_weekday',
    'weekly_digest_minute',
    'updated_at',
    'version',
  ],
  'notify.scope_default': [
    'id',
    'workspace_id',
    'scope_kind',
    'scope_record_id',
    'event_type',
    'channel',
    'mode',
    'set_by_membership_id',
    'updated_at',
    'version',
  ],
  'workflow.platform_status': ['id', 'record_type', 'key', 'name', 'category', 'rank'],
  'work.project': [
    'id',
    'workspace_id',
    'brand_id',
    'scope_key',
    'lifecycle_state',
    'parent_project_id',
    'ancestor_ids',
    'depth',
    'name',
    'description_rich',
    'icon',
    'color',
    'status_id',
    'status_category',
    'priority',
    'start_date',
    'target_date',
    'deadline_date',
    'completed_at',
    'health',
    'health_source',
    'owner_membership_id',
    'budget_amount',
    'budget_currency',
    'time_budget_minutes',
    'ai_budget_micros',
    'rank',
    'access_mode',
    'allow_record_shares',
    'recurrence_series_id',
    'occurrence_key',
    'intake_source_id',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'updated_by_membership_id',
    'version',
  ],
  'work.phase': [
    'id',
    'workspace_id',
    'brand_id',
    'scope_key',
    'lifecycle_state',
    'project_id',
    'name',
    'rank',
    'start_date',
    'end_date',
    'status',
    'owner_membership_id',
    'created_at',
    'updated_at',
    'updated_by_membership_id',
    'version',
  ],
  'work.milestone': [
    'id',
    'workspace_id',
    'brand_id',
    'scope_key',
    'lifecycle_state',
    'project_id',
    'phase_id',
    'name',
    'rank',
    'due_date',
    'status',
    'reached_at',
    'owner_membership_id',
    'created_at',
    'updated_at',
    'updated_by_membership_id',
    'version',
  ],
  'work.criteria_item': [
    'id',
    'public_id',
    'workspace_id',
    'brand_id',
    'owner_kind',
    'project_id',
    'kind',
    'text',
    'rank',
    'met',
    'met_by_membership_id',
    'met_at',
    'created_at',
    'updated_at',
    'version',
    'task_id',
    'required',
  ],
  'work.task': [
    'id',
    'workspace_id',
    'brand_id',
    'scope_key',
    'lifecycle_state',
    'project_id',
    'parent_task_id',
    'ancestor_ids',
    'depth',
    'title',
    'description_rich',
    'status_id',
    'status_category',
    'prior_status_id',
    'priority',
    'start_date',
    'due_date',
    'deadline_date',
    'deadline_at',
    'deadline_tz',
    'estimate_minutes',
    'remaining_estimate_minutes',
    'completed_at',
    'completed_by_membership_id',
    'completion_override_reason',
    'expected_deliverable_type',
    'expected_deliverable_detail',
    'requires_acceptance',
    'rank',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'updated_by_membership_id',
    'version',
    'origin_kind',
    'origin_ref',
    'recurrence_series_id',
    'occurrence_key',
    'last_meaningful_update_at',
  ],
  'work.task_assignee': [
    'workspace_id',
    'brand_id',
    'task_id',
    'membership_id',
    'is_primary',
    'rank',
    'assigned_by_membership_id',
    'assigned_at',
    'delegated_from_membership_id',
    'delegated_at',
  ],
  'work.checklist_item': [
    'id',
    'public_id',
    'workspace_id',
    'brand_id',
    'task_id',
    'text',
    'rank',
    'done',
    'done_by_membership_id',
    'done_at',
    'created_at',
    'updated_at',
    'version',
  ],
  'work.task_inherited_criterion': [
    'workspace_id',
    'brand_id',
    'task_id',
    'criteria_item_id',
    'state',
    'by_membership_id',
    'at',
  ],
  'work.label': [
    'id',
    'public_id',
    'workspace_id',
    'brand_id',
    'name',
    'normalized_name',
    'color',
    'icon',
    'rank',
    'state',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'version',
  ],
  'work.task_label': [
    'workspace_id',
    'brand_id',
    'task_id',
    'label_id',
    'added_by_membership_id',
    'added_at',
  ],
  'relations.record_link': [
    'id',
    'public_id',
    'workspace_id',
    'source_record_id',
    'target_kind',
    'url',
    'target_record_id',
    'title',
    'rank',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'version',
  ],
  'work.scope_item': [
    'id',
    'public_id',
    'workspace_id',
    'brand_id',
    'project_id',
    'kind',
    'text',
    'rank',
    'created_at',
    'updated_at',
    'version',
  ],
  'work.project_update': [
    'id',
    'public_id',
    'workspace_id',
    'brand_id',
    'project_id',
    'body',
    'health',
    'source_kind',
    'author_membership_id',
    'created_at',
  ],
  'work.project_update_verification': [
    'workspace_id',
    'update_id',
    'project_id',
    'verifier_membership_id',
    'verified_at',
    'audit_event_id',
  ],
  'work.decision_record': [
    'id',
    'workspace_id',
    'brand_id',
    'scope_key',
    'lifecycle_state',
    'project_id',
    'kind',
    'state',
    'statement',
    'outcome',
    'owner_membership_id',
    'due_date',
    'decided_at',
    'resolved_at',
    'superseded_by_id',
    'created_at',
    'updated_at',
    'updated_by_membership_id',
    'version',
  ],
  'relations.record_relationship': [
    'id',
    'workspace_id',
    'kind',
    'from_record_id',
    'to_record_id',
    'from_brand_id',
    'to_brand_id',
    'created_by_membership_id',
    'created_at',
  ],
  'templates.template': [
    'id',
    'workspace_id',
    'brand_id',
    'scope_key',
    'lifecycle_state',
    'name',
    'target_record_type',
    'current_version_id',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'version',
  ],
  'templates.template_version': [
    'id',
    'workspace_id',
    'template_id',
    'version_number',
    'schema_version',
    'content',
    'item_count',
    'created_from_record_type',
    'created_by_membership_id',
    'created_at',
  ],
  'planning.recurrence_series': [
    'id',
    'public_id',
    'workspace_id',
    'brand_id',
    'target_kind',
    'source_record_id',
    'state',
    'rrule',
    'anchor_tz',
    'dtstart_local',
    'mode',
    'template_payload',
    'payload_item_count',
    'generated_through',
    'next_due_at',
    'last_run_at',
    'ends_at_occurrence',
    'split_from_series_id',
    'owner_membership_id',
    'created_at',
    'updated_at',
    'version',
    'project_id',
  ],
  'workflow.workflow': [
    'id',
    'public_id',
    'workspace_id',
    'brand_id',
    'project_id',
    'scope_kind',
    'record_kind',
    'name',
    'state',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'version',
  ],
  'workflow.workflow_status': [
    'id',
    'public_id',
    'workspace_id',
    'workflow_id',
    'name',
    'normalized_name',
    'description',
    'category',
    'color',
    'icon',
    'rank',
    'state',
    'created_at',
    'updated_at',
    'version',
  ],
  'workflow.transition': [
    'id',
    'public_id',
    'workspace_id',
    'workflow_id',
    'from_status_id',
    'to_status_id',
    'description',
    'rank',
    'confirmation_tier',
    'approval_policy',
    'allow_self_approval',
    'state',
    'created_at',
    'updated_at',
    'version',
  ],
  'workflow.transition_requirement': [
    'id',
    'workspace_id',
    'transition_id',
    'field_kind',
    'builtin_key',
    'definition_id',
    'allow_manager_override',
    'rank',
    'created_at',
  ],
  'workflow.transition_approver': ['workspace_id', 'transition_id', 'membership_id', 'rank'],
  'workflow.approval_request': [
    'id',
    'public_id',
    'workspace_id',
    'brand_id',
    'workflow_id',
    'transition_id',
    'transition_version',
    'record_id',
    'record_type',
    'record_version',
    'fingerprint',
    'requester_membership_id',
    'policy',
    'approver_membership_ids',
    'allow_self_approval',
    'expires_at',
    'created_at',
    'closed_at',
    'closed_reason',
  ],
  'workflow.approval_decision': [
    'id',
    'workspace_id',
    'approval_request_id',
    'approver_membership_id',
    'decision',
    'note_hash',
    'decided_at',
  ],
  'workflow.field_definition': [
    'id',
    'public_id',
    'workspace_id',
    'brand_id',
    'project_id',
    'scope_kind',
    'lineage_id',
    'applies_to_project',
    'applies_to_task',
    'name',
    'normalized_name',
    'description',
    'field_type',
    'config',
    'required',
    'presentation',
    'applicability',
    'view_visibility',
    'formula_ast',
    'formula_version',
    'result_type',
    'extensions',
    'rank',
    'state',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'version',
  ],
  'workflow.field_option': [
    'id',
    'public_id',
    'workspace_id',
    'definition_id',
    'label',
    'normalized_label',
    'color',
    'rank',
    'state',
    'created_at',
    'updated_at',
    'version',
  ],
  'workflow.formula_dependency': ['workspace_id', 'definition_id', 'depends_on_definition_id'],
  'workflow.field_value': [
    'workspace_id',
    'brand_id',
    'definition_id',
    'record_id',
    'value',
    'value_text',
    'value_numeric',
    'value_date',
    'value_bool',
    'value_ref',
    'currency_code',
    'computed',
    'formula_version',
    'error_code',
    'extensions',
    'updated_by_membership_id',
    'updated_at',
    'version',
  ],
  'workflow.field_set': [
    'id',
    'public_id',
    'workspace_id',
    'brand_id',
    'project_id',
    'scope_kind',
    'applies_to_project',
    'applies_to_task',
    'name',
    'normalized_name',
    'current_version',
    'state',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'version',
  ],
  'workflow.field_set_version': [
    'workspace_id',
    'field_set_id',
    'version',
    'items',
    'created_by_membership_id',
    'created_at',
  ],
  'workflow.field_set_attachment': [
    'workspace_id',
    'brand_id',
    'record_id',
    'field_set_id',
    'version',
    'attached_by_membership_id',
    'attached_at',
  ],
  'access.field_policy': [
    'workspace_id',
    'definition_id',
    'read_rule',
    'read_min_level',
    'edit_min_level',
    'guest_visible',
    'index_for_search',
    'updated_at',
    'version',
  ],
  'planning.task_reminder': [
    'id',
    'public_id',
    'workspace_id',
    'owner_membership_id',
    'task_id',
    'remind_at',
    'state',
    'fired_at',
    'created_at',
    'updated_at',
    'version',
  ],
  'planning.task_snooze': [
    'workspace_id',
    'owner_membership_id',
    'task_id',
    'until_at',
    'created_at',
    'updated_at',
    'version',
  ],
  'work.bulk_operation': [
    'id',
    'public_id',
    'workspace_id',
    'owner_membership_id',
    'operation',
    'params',
    'mode',
    'state',
    'item_ids',
    'fingerprint',
    'results',
    'created_at',
    'expires_at',
    'executed_at',
    'version',
  ],
  'work.undo_entry': [
    'id',
    'public_id',
    'workspace_id',
    'owner_membership_id',
    'command',
    'targets',
    'inverse',
    'state',
    'created_at',
    'expires_at',
    'closed_at',
    'version',
  ],
  'capture.inbox_item': [
    'id',
    'workspace_id',
    'brand_id',
    'scope_key',
    'lifecycle_state',
    'owner_membership_id',
    'intent',
    'raw_text',
    'source_kind',
    'source_ref',
    'correlation_id',
    'parse_version',
    'parsed',
    'capture_batch_id',
    'triage_state',
    'converted_kind',
    'converted_record_id',
    'merged_into_id',
    'triaged_at',
    'created_at',
    'updated_at',
    'version',
  ],
  'capture.voice_capture': [
    'id',
    'workspace_id',
    'public_id',
    'membership_id',
    'state',
    'format',
    'byte_size',
    'duration_ms',
    'content_sha256',
    'storage_key',
    'operation_id',
    'inbox_item_id',
    'failure_code',
    'expires_at',
    'discarded_at',
    'created_at',
    'updated_at',
    'version',
  ],
  'capture.note': [
    'id',
    'workspace_id',
    'brand_id',
    'scope_key',
    'lifecycle_state',
    'owner_membership_id',
    'title',
    'body',
    'source_inbox_item_id',
    'created_at',
    'updated_at',
    'version',
  ],
  'capture.capture_conversion': [
    'id',
    'workspace_id',
    'source_record_id',
    'source_kind',
    'target_record_id',
    'target_kind',
    'by_membership_id',
    'created_at',
  ],
  'capture.intake_form': [
    'id',
    'workspace_id',
    'brand_id',
    'scope_key',
    'lifecycle_state',
    'name',
    'description',
    'target_kind',
    'queue_owner_membership_id',
    'state',
    'created_by_membership_id',
    'created_at',
    'updated_at',
    'version',
  ],
  'capture.intake_submission': [
    'id',
    'workspace_id',
    'form_id',
    'submitter_membership_id',
    'inbox_item_id',
    'submitted_at',
  ],
  'timetrack.time_entry': [
    'id',
    'public_id',
    'workspace_id',
    'brand_id',
    'membership_id',
    'task_id',
    'project_id',
    'source',
    'state',
    'started_at',
    'ended_at',
    'work_date',
    'tz',
    'duration_seconds',
    'billable',
    'note',
    'auto_stopped',
    'created_at',
    'updated_at',
    'version',
  ],
  'timetrack.time_segment': [
    'id',
    'workspace_id',
    'entry_id',
    'membership_id',
    'started_at',
    'ended_at',
  ],
  'timetrack.timesheet': [
    'id',
    'public_id',
    'workspace_id',
    'membership_id',
    'period_start',
    'period_end',
    'state',
    'submitted_at',
    'created_at',
    'updated_at',
    'version',
  ],
  'timetrack.timesheet_line': [
    'id',
    'workspace_id',
    'timesheet_id',
    'brand_id',
    'state',
    'submitted_seconds',
    'submitted_billable_seconds',
    'submitted_entries',
    'submitted_hash',
    'updated_at',
    'version',
  ],
  'timetrack.timesheet_approval': [
    'id',
    'workspace_id',
    'timesheet_id',
    'line_id',
    'brand_id',
    'membership_id',
    'period_start',
    'period_end',
    'decided_by_membership_id',
    'decision',
    'self_approval',
    'note_hash',
    'total_seconds',
    'billable_seconds',
    'entry_count',
    'entries_hash',
    'timesheet_version',
    'created_at',
  ],
  'timetrack.period_lock': [
    'id',
    'workspace_id',
    'brand_id',
    'membership_id',
    'period_start',
    'period_end',
    'action',
    'approval_id',
    'reason',
    'by_membership_id',
    'step_up_id',
    'created_at',
  ],
  'planning.work_block': [
    'id',
    'public_id',
    'workspace_id',
    'owner_membership_id',
    'task_id',
    'brand_id',
    'title',
    'starts_at',
    'ends_at',
    'source_tz',
    'focus',
    'locked',
    'prep_minutes',
    'buffer_minutes',
    'source',
    'series_id',
    'occurrence_key',
    'created_at',
    'updated_at',
    'version',
  ],
  'planning.block_series': [
    'id',
    'public_id',
    'workspace_id',
    'owner_membership_id',
    'task_id',
    'brand_id',
    'title',
    'rrule',
    'anchor_tz',
    'dtstart_local',
    'duration_minutes',
    'focus',
    'prep_minutes',
    'buffer_minutes',
    'state',
    'generated_through',
    'created_at',
    'updated_at',
    'version',
  ],
  'planning.today_commitment': [
    'id',
    'workspace_id',
    'owner_membership_id',
    'day',
    'task_id',
    'brand_id',
    'rank',
    'locked',
    'outcome',
    'carried_to',
    'source',
    'created_at',
    'closed_at',
    'updated_at',
    'version',
  ],
  'planning.daily_record': [
    'id',
    'workspace_id',
    'owner_membership_id',
    'day',
    'tz',
    'closed_by',
    'committed',
    'completed',
    'carried',
    'returned',
    'dropped',
    'planned_minutes',
    'unestimated',
    'block_minutes',
    'focus_minutes',
    'actual_seconds',
    'items',
    'created_at',
  ],
  'transfer.import_job': [
    'id',
    'workspace_id',
    'owner_membership_id',
    'preview_id',
    'mapping_id',
    'mapping_version',
    'schema_version',
    'content_sha256',
    'request_key_sha256',
    'entity_kind',
    'state',
    'apply_mode',
    'row_count',
    'applied_count',
    'error_count',
    'checkpoint_row',
    'rollback_until',
    'created_at',
    'updated_at',
  ],
  'transfer.import_row': [
    'workspace_id',
    'import_job_id',
    'row_number',
    'source_row_key',
    'source_values',
    'state',
    'issues',
    'record_type',
    'record_id',
    'record_public_id',
    'applied_version',
    'created_at',
    'updated_at',
  ],
  'transfer.import_mapping': [
    'id',
    'workspace_id',
    'owner_membership_id',
    'name',
    'entity_kind',
    'schema_version',
    'mapping_version',
    'column_mapping',
    'created_at',
    'updated_at',
  ],
  'transfer.import_preview': [
    'id',
    'workspace_id',
    'owner_membership_id',
    'entity_kind',
    'content_sha256',
    'schema_version',
    'mapping_id',
    'mapping_version',
    'expires_at',
    'created_at',
  ],
  'ai.ai_provider_config': [
    'id',
    'workspace_id',
    'enabled',
    'model_key',
    'key_source',
    'workspace_key_ref',
    'workspace_key_set_at',
    'max_data_class',
    'require_training_exclusion',
    'confirm_above_micros',
    'updated_by_membership_id',
    'created_at',
    'updated_at',
    'version',
    'dispatch_suspended_reason',
    'dispatch_suspended_at',
  ],
  'ai.brand_ai_profile': [
    'id',
    'workspace_id',
    'brand_id',
    'instructions',
    'terminology',
    'audience',
    'voice',
    'approved_sources',
    'updated_by_membership_id',
    'created_at',
    'updated_at',
    'version',
  ],
  'ai.ai_action': [
    'operation_id',
    'workspace_id',
    'initiating_membership_id',
    'brand_id',
    'purpose',
    'synthetic',
    'model_key',
    'provider',
    'model_id',
    'registry_version',
    'prompt_template_version',
    'price_snapshot',
    'privacy_snapshot',
    'funding',
    'caller_kind',
    'delegation_principal_type',
    'delegation_token_id',
    'prompt_text',
    'redaction_count',
    'max_output_tokens',
    'estimated_max_micros',
    'rerun_of_operation_id',
    'content_state',
    'content_erased_at',
    'created_at',
    'retrieval_scope',
    'manifest_digest',
    'action_key',
    'input_digest',
  ],
  'ai.ai_context_ref': [
    'id',
    'workspace_id',
    'operation_id',
    'position',
    'record_id',
    'record_type',
    'record_public_id',
    'fields',
    'record_version',
    'included',
    'exclusion_reason',
    'handle',
    'content_hash',
    'source_version',
    'source_flags',
    'selection',
  ],
  'ai.ai_dispatch': [
    'id',
    'workspace_id',
    'operation_id',
    'attempt_id',
    'dispatch_number',
    'state',
    'period_start',
    'input_token_bound',
    'output_token_bound',
    'reserved_micros',
    'provider_request_id',
    'stop_reason',
    'error_kind',
    'input_tokens',
    'output_tokens',
    'settled_micros',
    'usage_basis',
    'cancel_observed',
    'started_at',
    'ended_at',
    'reconciled_by_membership_id',
    'reconciled_at',
    'price_snapshot',
    'capability_snapshot',
    'bound_breach',
    'clipped_locally',
    'failure_detail',
  ],
  'ai.ai_output': [
    'id',
    'workspace_id',
    'operation_id',
    'dispatch_id',
    'completeness',
    'content',
    'created_at',
    'grounding',
  ],
  'ai.change_proposal': [
    'id',
    'workspace_id',
    'public_id',
    'operation_id',
    'initiating_membership_id',
    'schema_version',
    'state',
    'revision',
    'fingerprint',
    'title',
    'reject_reason',
    'assumptions',
    'content_state',
    'content_erased_at',
    'created_at',
    'updated_at',
    'version',
    'origin',
    'plan',
  ],
  'ai.proposed_change': [
    'id',
    'workspace_id',
    'proposal_id',
    'change_key',
    'position',
    'op',
    'temp_ref',
    'target_record_id',
    'target_public_id',
    'expected_version',
    'depends_on',
    'payload',
    'sources',
    'selected',
    'decision',
    'applied_state',
    'result_record_id',
    'result_public_id',
    'failure_code',
    'updated_at',
  ],
  'ai.proposal_event': [
    'id',
    'workspace_id',
    'proposal_id',
    'revision',
    'kind',
    'actor_membership_id',
    'change_keys',
    'fingerprint',
    'created_at',
  ],
  'ai.proposal_approval': [
    'id',
    'workspace_id',
    'proposal_id',
    'revision',
    'approver_membership_id',
    'selected',
    'fingerprint',
    'target_versions',
    'scope',
    'risk_class',
    'step_up_required',
    'state',
    'expires_at',
    'created_at',
    'used_at',
  ],
  'ai.briefing_schedule': [
    'id',
    'workspace_id',
    'public_id',
    'membership_id',
    'kind',
    'scope',
    'scope_key',
    'timezone',
    'local_minute',
    'weekdays',
    'channels',
    'enabled',
    'revision',
    'next_run_at',
    'created_at',
    'updated_at',
    'version',
  ],
  'ai.briefing': [
    'id',
    'workspace_id',
    'public_id',
    'operation_id',
    'recipient_membership_id',
    'schedule_id',
    'schedule_revision',
    'occurrence_key',
    'trigger',
    'regenerates_id',
    'kind',
    'scope',
    'scope_key',
    'template_version',
    'timezone',
    'window_start',
    'window_end',
    'baseline_briefing_id',
    'state',
    'attempts',
    'failure_code',
    'coverage',
    'content_state',
    'content_erased_at',
    'published_at',
    'created_at',
    'updated_at',
    'version',
  ],
  'ai.briefing_statement': [
    'id',
    'workspace_id',
    'briefing_id',
    'position',
    'section',
    'kind',
    'statement_key',
    'text',
    'refs',
    'figures',
    'correction_id',
  ],
  'ai.briefing_correction': [
    'id',
    'workspace_id',
    'public_id',
    'recipient_membership_id',
    'origin_briefing_id',
    'kind',
    'scope_key',
    'statement_key',
    'subject_public_id',
    'subject_version',
    'text',
    'state',
    'revision',
    'decided_at',
    'created_at',
    'updated_at',
    'version',
  ],
  'ai.briefing_correction_event': [
    'id',
    'workspace_id',
    'correction_id',
    'kind',
    'revision',
    'actor_membership_id',
    'created_at',
  ],
  'ai.briefing_evidence': [
    'id',
    'workspace_id',
    'briefing_id',
    'correction_id',
    'position',
    'kind',
    'record_id',
    'brand_id',
    'permission',
    'proposal_id',
  ],
  'ai.proposal_application': [
    'id',
    'workspace_id',
    'proposal_id',
    'operation_id',
    'approval_id',
    'revision',
    'outcome',
    'applied_count',
    'failed_count',
    'results',
    'created_at',
  ],
  'metering.spend_limit': [
    'id',
    'workspace_id',
    'scope_key',
    'meter',
    'monthly_allowance',
    'hard_limit',
    'updated_by_membership_id',
    'created_at',
    'updated_at',
    'version',
  ],
  'metering.usage_balance': [
    'id',
    'workspace_id',
    'scope_key',
    'meter',
    'period_start',
    'period_end',
    'consumed',
    'allowance_consumed',
    'reserved',
    'last_threshold_bp',
    'updated_at',
    'version',
  ],
  'metering.usage_reservation': [
    'id',
    'workspace_id',
    'operation_id',
    'dispatch_id',
    'meter',
    'period_start',
    'amount',
    'state',
    'settled_amount',
    'created_at',
    'updated_at',
  ],
  'metering.usage_event': [
    'id',
    'workspace_id',
    'meter',
    'quantity',
    'unit',
    'cost_micros',
    'cost_basis',
    'funding',
    'billable',
    'brand_id',
    'actor_type',
    'operation_id',
    'dispatch_id',
    'occurred_at',
    'period_start',
    'correction_of',
    'sequence',
  ],
  'automation.automation': [
    'id',
    'workspace_id',
    'brand_id',
    'scope_key',
    'lifecycle_state',
    'name',
    'description',
    'owner_membership_id',
    'enabled',
    'active_revision_id',
    'trigger_kind',
    'trigger_event',
    'activated_at',
    'draft',
    'draft_base_revision',
    'template_key',
    'duplicated_from_id',
    'suspended_reason',
    'suspended_at',
    'active_runs',
    'consecutive_failures',
    'alerted_at',
    'created_by_membership_id',
    'updated_by_membership_id',
    'created_at',
    'updated_at',
    'version',
  ],
  'automation.automation_revision': [
    'id',
    'workspace_id',
    'automation_id',
    'revision_number',
    'schema_version',
    'definition',
    'definition_hash',
    'trigger_kind',
    'record_kind',
    'declared_brand_ids',
    'declared_project_ids',
    'action_keys',
    'action_classes',
    'created_by_membership_id',
    'created_at',
  ],
  'automation.automation_run': [
    'id',
    'workspace_id',
    'automation_id',
    'revision_id',
    'operation_id',
    'current_operation_id',
    'owner_membership_id',
    'trigger_kind',
    'trigger_key',
    'trigger_event_id',
    'trigger_record_id',
    'root_causation_id',
    'lineage',
    'chain_depth',
    'scope_snapshot',
    'run_day',
    'timezone',
    'status',
    'reason',
    'cursor',
    'wake_at',
    'steps_executed',
    'retry_count',
    'usage_state',
    'slot_held',
    'initiated_by_membership_id',
    'created_at',
    'started_at',
    'ended_at',
    'updated_at',
    'version',
  ],
  'automation.automation_step_run': [
    'id',
    'workspace_id',
    'run_id',
    'node_id',
    'attempt',
    'kind',
    'action_key',
    'state',
    'failure_class',
    'code',
    'decision',
    'targets',
    'output',
    'logical_key',
    'operation_id',
    'started_at',
    'ended_at',
  ],
  'automation.standing_approval': [
    'id',
    'workspace_id',
    'automation_id',
    'revision_id',
    'node_id',
    'subscription_id',
    'destination_fingerprint',
    'field_set',
    'scope_hash',
    'action_class',
    'approved_by_membership_id',
    'step_up_id',
    'state',
    'approved_at',
    'ended_at',
  ],
  'automation.trigger_schedule': [
    'automation_id',
    'workspace_id',
    'revision_id',
    'kind',
    'next_due_at',
    'last_key',
    'updated_at',
  ],
  'automation.usage_period': [
    'workspace_id',
    'period_start',
    'runs_reserved',
    'runs_settled',
    'runs_released',
    'steps_executed',
    'alerted_bp',
    'updated_at',
  ],
  'agents.agent_profile': [
    'id',
    'workspace_id',
    'scope_key',
    'lifecycle_state',
    'kind',
    'name',
    'purpose',
    'owner_membership_id',
    'state',
    'active_revision_id',
    'activated_at',
    'draft',
    'draft_base_revision',
    'template_key',
    'duplicated_from_id',
    'suspended_reason',
    'suspended_at',
    'created_by_membership_id',
    'updated_by_membership_id',
    'created_at',
    'updated_at',
    'version',
  ],
  'agents.agent_profile_revision': [
    'id',
    'workspace_id',
    'profile_id',
    'revision_number',
    'schema_version',
    'kind',
    'config',
    'config_hash',
    'model_key',
    'created_by_membership_id',
    'created_at',
  ],
  'agents.agent_scope_grant': ['id', 'workspace_id', 'revision_id', 'kind', 'target_id'],
  'agents.agent_tool_grant': [
    'id',
    'workspace_id',
    'revision_id',
    'tool',
    'tool_version',
    'tool_class',
    'approval_class',
  ],
  'agents.agent_connector': [
    'id',
    'workspace_id',
    'profile_id',
    'kind',
    'endpoint_url',
    'secret_ref',
    'config_version',
    'state',
    'verified_version',
    'verified_at',
    'verified_synthetic',
    'capabilities',
    'last_code',
    'last_tested_at',
    'disconnected_at',
    'created_by_membership_id',
    'updated_by_membership_id',
    'created_at',
    'updated_at',
    'version',
  ],
  'agents.agent_connector_test': [
    'id',
    'workspace_id',
    'connector_id',
    'operation_id',
    'config_version',
    'requested_by_membership_id',
    'state',
    'code',
    'synthetic',
    'duration_ms',
    'created_at',
    'ended_at',
  ],
  'agents.agent_assignment': [
    'id',
    'workspace_id',
    'brand_id',
    'task_id',
    'profile_id',
    'state',
    'current_revision_id',
    'assigned_by_membership_id',
    'withdrawn_by_membership_id',
    'withdrawn_at',
    'created_at',
    'updated_at',
    'version',
  ],
  'agents.agent_assignment_revision': [
    'id',
    'workspace_id',
    'assignment_id',
    'revision_number',
    'profile_revision_id',
    'assigner_membership_id',
    'goal',
    'constraints',
    'deliverable',
    'criteria',
    'context_refs',
    'scope_brand_ids',
    'scope_project_ids',
    'scope_record_ids',
    'scope_integration_ids',
    'created_at',
  ],
};
