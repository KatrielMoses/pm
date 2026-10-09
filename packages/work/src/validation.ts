import {
  CRITERIA_KINDS,
  DECISION_KINDS,
  MILESTONE_STATUSES,
  PHASE_STATUSES,
  PROJECT_HEALTH,
  PROJECT_PRIORITIES,
  PROJECT_STATUSES,
  SCOPE_ITEM_KINDS,
} from '@pm/contracts/shell';
import { validateRichText, type RichTextDoc } from '@pm/contracts';
import { Issues, color as colorValue, currency, text } from '@pm/tenancy';
import {
  composeRule,
  COUNT_MAX,
  isCalendarDate,
  WEEKDAYS,
  type RuleInput,
  type Weekday,
} from './recurrence.ts';

const FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const;

/** Registered bounds (0D PL-22). The database depth ceiling (32) is an invariant, not a setting. */
export interface WorkSettings {
  /** `PROJECT_DEPTH_MAX`: deepest level a command accepts (root = 0). */
  projectDepthMax: number;
  /** `TEMPLATE_ITEMS_MAX`: most structural items per template version or snapshot. */
  templateItemsMax: number;
  /** `RECURRENCE_CATCHUP_MAX`: most missed occurrences one series generates per run. */
  recurrenceCatchupMax: number;
  /** `RECURRENCE_WORKSPACE_DISCOVERY_MAX`: most workspaces one recurrence run visits. */
  recurrenceWorkspaceDiscoveryMax: number;
  /** `RECURRENCE_SERIES_DISCOVERY_MAX`: most due series one run processes per workspace. */
  recurrenceSeriesDiscoveryMax: number;
  /** `TASK_DEPTH_MAX`: deepest subtask level a command accepts (root = 0). */
  taskDepthMax: number;
  /** `TASK_SUBTREE_MAX`: most tasks one subtree operation (move, lifecycle, duplicate) touches. */
  taskSubtreeMax: number;
  /** `TASK_ITEMS_MAX`: most checklist items, criteria items, or links per task (each kind). */
  taskItemsMax: number;
  /** `TASK_ASSIGNEES_MAX` */
  taskAssigneesMax: number;
  /** `TASK_LABELS_MAX` */
  taskLabelsMax: number;
  /** `BRAND_LABELS_MAX` */
  brandLabelsMax: number;
  /** `TASK_ESTIMATE_MINUTES_MAX` */
  taskEstimateMinutesMax: number;
  /** `PAGE_LIMIT_DEFAULT` and `PAGE_LIMIT_MAX` for task and project lists. */
  pageLimitDefault: number;
  pageLimitMax: number;
  /** `WORKFLOW_STATUSES_MAX` */
  workflowStatusesMax: number;
  /** `WORKFLOW_TRANSITIONS_MAX` */
  workflowTransitionsMax: number;
  /** `TRANSITION_REQUIREMENTS_MAX` */
  transitionRequirementsMax: number;
  /** `TRANSITION_APPROVERS_MAX` */
  transitionApproversMax: number;
  /** `APPROVAL_EXPIRY_HOURS` */
  approvalExpiryHours: number;
  /** `TRANSITION_PREVIEW_TTL_SECONDS` */
  transitionPreviewTtlSeconds: number;
  /** `FIELD_DEFINITIONS_MAX` */
  fieldDefinitionsMax: number;
  /** `FIELD_OPTIONS_MAX` */
  fieldOptionsMax: number;
  /** `FIELD_SETS_MAX` */
  fieldSetsMax: number;
  /** `FIELD_SET_ITEMS_MAX` */
  fieldSetItemsMax: number;
  /** `FIELD_TEXT_MAX` */
  fieldTextMax: number;
  /** `FIELD_PATTERN_MAX` */
  fieldPatternMax: number;
  /** `FORMULA_SOURCE_MAX` */
  formulaSourceMax: number;
  /** `FORMULA_AST_NODES_MAX` */
  formulaAstNodesMax: number;
  /** `FORMULA_DEPTH_MAX` */
  formulaDepthMax: number;
  /** `FORMULA_REFS_MAX` */
  formulaRefsMax: number;
  /** `FIELD_VALUE_BULK_MAX` */
  fieldValueBulkMax: number;
  /** `TASK_STALE_ACTIVE_DAYS` */
  taskStaleActiveDays: number;
  /** `TASK_STALE_PLANNED_DAYS` */
  taskStalePlannedDays: number;
  /** `TASK_RESCHEDULE_COUNT` */
  taskRescheduleCount: number;
  /** `TASK_RESCHEDULE_WINDOW_DAYS` */
  taskRescheduleWindowDays: number;
  /** `TASK_REMINDERS_MAX` */
  taskRemindersMax: number;
  /** `REMINDER_FIRE_BATCH_MAX` */
  reminderFireBatchMax: number;
  /** `TASK_SNOOZE_MAX_DAYS` */
  taskSnoozeMaxDays: number;
  /** `BULK_ITEMS_MAX` */
  bulkItemsMax: number;
  /** `BULK_PREVIEW_TTL_SECONDS` */
  bulkPreviewTtlSeconds: number;
  /** `UNDO_WINDOW_SECONDS` */
  undoWindowSeconds: number;
  /** `DUPLICATE_WINDOW_DAYS` */
  duplicateWindowDays: number;
  /** `DUPLICATE_CANDIDATES_MAX` */
  duplicateCandidatesMax: number;
  /** `CAPTURE_TEXT_MAX` */
  captureTextMax: number;
  /** `CAPTURE_PASTE_LINES_MAX` */
  capturePasteLinesMax: number;
  /** `CAPTURE_LINKS_MAX` */
  captureLinksMax: number;
  /** `CAPTURE_FILES_MAX` */
  captureFilesMax: number;
  /** `CAPTURE_PARSE_TOKENS_MAX` */
  captureParseTokensMax: number;
  /** `CAPTURE_RATE_PER_MINUTE` */
  captureRatePerMinute: number;
  /** `TRIAGE_BATCH_MAX` */
  triageBatchMax: number;
  /** `INBOX_MERGE_MAX` */
  inboxMergeMax: number;
  /** `INTAKE_FORMS_MAX` */
  intakeFormsMax: number;
  /** `INTAKE_SUBMISSIONS_PER_HOUR` */
  intakeSubmissionsPerHour: number;
  /** `QUERY_CONDITIONS_MAX` */
  queryConditionsMax: number;
  /** `QUERY_DEPTH_MAX` */
  queryDepthMax: number;
  /** `QUERY_SORTS_MAX` */
  querySortsMax: number;
  /** `QUERY_VALUES_MAX` */
  queryValuesMax: number;
  /** `QUERY_GROUPS_MAX` */
  queryGroupsMax: number;
  /** `VIEW_COLUMNS_MAX` */
  viewColumnsMax: number;
  /** `SAVED_VIEWS_MAX` */
  savedViewsMax: number;
  /** `VIEW_PINS_MAX` */
  viewPinsMax: number;
  /** `EXPORT_ROWS_MAX` */
  exportRowsMax: number;
  /** `TOTAL_COUNT_CAP` */
  totalCountCap: number;
  /** `LAYOUT_ITEMS_MAX` */
  layoutItemsMax: number;
  /** `WORKLOAD_DAYS_MAX` */
  workloadDaysMax: number;
  /** `ACTIVITY_RECORDS_MAX` */
  activityRecordsMax: number;
  /** `AVAILABILITY_WINDOWS_MAX` */
  availabilityWindowsMax: number;
  /** `TIME_OFF_ENTRIES_MAX` */
  timeOffEntriesMax: number;
  /** `BRAND_HOLIDAYS_MAX` */
  brandHolidaysMax: number;
  /** `CAPACITY_RANGE_DAYS_MAX` */
  capacityRangeDaysMax: number;
  /** `CAPACITY_PEOPLE_MAX` */
  capacityPeopleMax: number;
  /** `TIME_ENTRY_MAX_HOURS` */
  timeEntryMaxHours: number;
  /** `TIME_TIMER_MAX_HOURS` */
  timeTimerMaxHours: number;
  /** `TIME_REPORT_RANGE_DAYS_MAX` */
  timeReportRangeDaysMax: number;
  /** `TIME_REPORT_ROWS_MAX` */
  timeReportRowsMax: number;
  /** `TIME_EXPORT_ROWS_MAX` */
  timeExportRowsMax: number;
  /** `TIME_TIMESHEET_ENTRIES_MAX` */
  timeTimesheetEntriesMax: number;
  /** `TIME_RUNAWAY_DISCOVERY_MAX` */
  timeRunawayDiscoveryMax: number;
  /** `TIME_RUNAWAY_BATCH_MAX` */
  timeRunawayBatchMax: number;
  /** `TODAY_ITEMS_MAX` */
  todayItemsMax: number;
  /** `TODAY_LIST_MAX` */
  todayListMax: number;
  /** `UPCOMING_DEADLINE_DAYS` */
  upcomingDeadlineDays: number;
  /** `WORK_BLOCKS_PER_DAY_MAX` */
  workBlocksPerDayMax: number;
  /** `WORK_BLOCKS_RANGE_DAYS_MAX` */
  workBlocksRangeDaysMax: number;
  /** `BLOCK_SERIES_MAX` */
  blockSeriesMax: number;
  /** `BLOCK_SERIES_HORIZON_DAYS` */
  blockSeriesHorizonDays: number;
  /** `DAY_CLOSE_DISCOVERY_MAX` */
  dayCloseDiscoveryMax: number;
  /** `DAY_CLOSE_BATCH_MAX` */
  dayCloseBatchMax: number;
  /** `COMMENT_BODY_MAX_CHARS` */
  commentBodyMaxChars: number;
  /** `COMMENT_EDIT_WINDOW_MINUTES` */
  commentEditWindowMinutes: number;
  /** `COMMENT_MENTIONS_MAX` */
  commentMentionsMax: number;
  /** `COMMENTS_PER_RECORD_MAX` */
  commentsPerRecordMax: number;
  /** `COMMENT_RATE_PER_MINUTE` */
  commentRatePerMinute: number;
  /** `COMMENT_REPLIES_INLINE_MAX` */
  commentRepliesInlineMax: number;
  /** `FOLLOWERS_LIST_MAX` */
  followersListMax: number;
  /** `REVIEW_REVIEWERS_MAX` */
  reviewReviewersMax: number;
  /** `NOTIFY_FANOUT_RECIPIENTS_MAX` */
  notifyFanoutRecipientsMax: number;
  /** `NOTIFY_DEDUPE_WINDOW_MINUTES` */
  notifyDedupeWindowMinutes: number;
  /** `NOTIFY_DELIVERY_BATCH_MAX` */
  notifyDeliveryBatchMax: number;
  /** `NOTIFY_DELIVERY_MAX_ATTEMPTS` */
  notifyDeliveryMaxAttempts: number;
  /** `NOTIFY_RETRY_BASE_SECONDS` */
  notifyRetryBaseSeconds: number;
  /** `NOTIFY_RETRY_MAX_SECONDS` */
  notifyRetryMaxSeconds: number;
  /** `NOTIFY_DIGEST_ITEMS_MAX` */
  notifyDigestItemsMax: number;
  /** `NOTIFY_EMAIL_PER_HOUR_MAX` */
  notifyEmailPerHourMax: number;
  /** `NOTIFY_RETENTION_DAYS` */
  notifyRetentionDays: number;
  /** `NOTIFY_PREFERENCES_MAX` */
  notifyPreferencesMax: number;
  /** `NOTIFY_BROWSER_ACK_TTL_MINUTES` */
  notifyBrowserAckTtlMinutes: number;
  /** `NOTIFY_SEARCH_QUERY_MAX` */
  notifySearchQueryMax: number;
  /** `NOTIFY_DISCOVERY_MAX` */
  notifyDiscoveryMax: number;
  /** `NOTIFY_BULK_STATE_MAX` */
  notifyBulkStateMax: number;
  /** `NOTIFY_DEADLINES_BATCH_MAX` */
  notifyDeadlinesBatchMax: number;
  /** `NOTIFY_FACTS_MAX_BYTES` */
  notifyFactsMaxBytes: number;
  /** `DOCUMENT_BODY_MAX_BYTES` */
  documentBodyMaxBytes: number;
  /** `DOCUMENT_BLOCKS_MAX` */
  documentBlocksMax: number;
  /** `DOCUMENT_BLOCK_TEXT_MAX_CHARS` */
  documentBlockTextMaxChars: number;
  /** `DOCUMENT_TABLE_CELLS_MAX` */
  documentTableCellsMax: number;
  /** `DOCUMENT_DEPTH_MAX` */
  documentDepthMax: number;
  /** `DOCUMENT_CHILDREN_MAX` */
  documentChildrenMax: number;
  /** `DOCUMENT_TREE_MAX` */
  documentTreeMax: number;
  /** `DOCUMENT_VERSIONS_MAX` */
  documentVersionsMax: number;
  /** `DOCUMENT_REFERENCES_MAX` */
  documentReferencesMax: number;
  /** `DOCUMENT_SUGGESTIONS_OPEN_MAX` */
  documentSuggestionsOpenMax: number;
  /** `DOCUMENT_EXPORT_PAGES_MAX` */
  documentExportPagesMax: number;
  /** `DOCUMENT_EXPORT_MAX_BYTES` */
  documentExportMaxBytes: number;
  /** `DOCUMENT_REVIEW_HORIZON_DAYS` */
  documentReviewHorizonDays: number;
  /** `DOCUMENT_SAVE_RATE_PER_MINUTE` */
  documentSaveRatePerMinute: number;
  /** `LIVE_EDITING_ENABLED` */
  liveEditingEnabled: number;
  /** `LIVE_SESSION_TTL_SECONDS` */
  liveSessionTtlSeconds: number;
  /** `LIVE_SESSIONS_MAX` */
  liveSessionsMax: number;
  /** `LIVE_SESSIONS_PER_MEMBER_MAX` */
  liveSessionsPerMemberMax: number;
  /** `LIVE_OPS_BATCH_MAX` */
  liveOpsBatchMax: number;
  /** `LIVE_POLL_WAIT_SECONDS` */
  livePollWaitSeconds: number;
  /** `LIVE_OP_LOG_MAX` */
  liveOpLogMax: number;
  /** `LIVE_RATE_PER_MINUTE` */
  liveRatePerMinute: number;
  /** `SEARCH_QUERY_MAX_CHARS` */
  searchQueryMaxChars: number;
  /** `SEARCH_TERMS_MAX` */
  searchTermsMax: number;
  /** `SEARCH_PAGE_SIZE_MAX` */
  searchPageSizeMax: number;
  /** `SEARCH_RESULTS_MAX` */
  searchResultsMax: number;
  /** `SEARCH_COUNT_MAX` */
  searchCountMax: number;
  /** `SEARCH_SNIPPET_CHARS` */
  searchSnippetChars: number;
  /** `SEARCH_BODY_MAX_CHARS` */
  searchBodyMaxChars: number;
  /** `SEARCH_INDEX_BATCH_MAX` */
  searchIndexBatchMax: number;
  /** `SEARCH_INDEX_DISCOVERY_MAX` */
  searchIndexDiscoveryMax: number;
  /** `SEARCH_INDEX_MAX_ATTEMPTS` */
  searchIndexMaxAttempts: number;
  /** `SEARCH_INDEX_BACKOFF_SECONDS` */
  searchIndexBackoffSeconds: number;
  /** `SEARCH_FAILED_RETRY_MINUTES` */
  searchFailedRetryMinutes: number;
  /** `SEARCH_RECENT_MAX` */
  searchRecentMax: number;
  /** `SEARCH_RECENT_RETENTION_DAYS` */
  searchRecentRetentionDays: number;
  /** `SEARCH_RATE_PER_MINUTE` */
  searchRatePerMinute: number;
  /** `GOALS_PER_SCOPE_MAX` */
  goalsPerScopeMax: number;
  /** `GOAL_KEY_RESULTS_MAX` */
  goalKeyResultsMax: number;
  /** `GOAL_LINKS_MAX` */
  goalLinksMax: number;
  /** `GOAL_UPDATE_STALE_DAYS` */
  goalUpdateStaleDays: number;
  /** `GOAL_CHECKIN_RATE_PER_MINUTE` */
  goalCheckinRatePerMinute: number;
  /** `PORTFOLIOS_MAX` */
  portfoliosMax: number;
  /** `PORTFOLIO_PROJECTS_MAX` */
  portfolioProjectsMax: number;
  /** `PORTFOLIO_READ_PROJECTS_MAX` */
  portfolioReadProjectsMax: number;
  /** `GOALS_EXPORT_ROWS_MAX` */
  goalsExportRowsMax: number;
  /** `GOALS_RECALC_BATCH_MAX` */
  goalsRecalcBatchMax: number;
  /** `GOALS_RECALC_LEASE_SECONDS` */
  goalsRecalcLeaseSeconds: number;
  /** `GOALS_RECALC_INTERVAL_MINUTES` */
  goalsRecalcIntervalMinutes: number;
  /** `GOALS_RECALC_MAX_ATTEMPTS` */
  goalsRecalcMaxAttempts: number;
  /** `DOCUMENT_EMBED_URL_MAX_CHARS` */
  documentEmbedUrlMaxChars: number;
  /** `SIGNED_URL_LIFETIME` (seconds) */
  signedUrlLifetimeSeconds: number;
  /** `UPLOAD_SESSION_LIFETIME` (seconds) */
  uploadSessionLifetimeSeconds: number;
  /** `FILE_UPLOAD_MAX_BYTES` */
  fileUploadMaxBytes: number;
  /** `WORKSPACE_STORAGE_QUOTA_BYTES` */
  workspaceStorageQuotaBytes: number;
  /** `FILE_COMPARE_MAX_BYTES` */
  fileCompareMaxBytes: number;
  /** `FILE_SCAN_MAX_ATTEMPTS` */
  fileScanMaxAttempts: number;
  /** `FILE_VERSIONS_MAX` */
  fileVersionsMax: number;
  /** `FILES_LIST_MAX` */
  filesListMax: number;
  /** `DELIVERABLES_PER_TASK_MAX` */
  deliverablesPerTaskMax: number;
  /** `FILE_DISCOVERY_MAX` */
  fileDiscoveryMax: number;
  /** `FILE_EXPIRY_BATCH_MAX` */
  fileExpiryBatchMax: number;
}

export const DEFAULT_WORK_SETTINGS: WorkSettings = Object.freeze({
  projectDepthMax: 10,
  templateItemsMax: 500,
  recurrenceCatchupMax: 12,
  recurrenceWorkspaceDiscoveryMax: 200,
  recurrenceSeriesDiscoveryMax: 50,
  taskDepthMax: 20,
  taskSubtreeMax: 500,
  taskItemsMax: 200,
  taskAssigneesMax: 20,
  taskLabelsMax: 50,
  brandLabelsMax: 1000,
  taskEstimateMinutesMax: 100_000,
  pageLimitDefault: 50,
  pageLimitMax: 200,
  workflowStatusesMax: 50,
  workflowTransitionsMax: 400,
  transitionRequirementsMax: 30,
  transitionApproversMax: 10,
  approvalExpiryHours: 168,
  transitionPreviewTtlSeconds: 600,
  fieldDefinitionsMax: 200,
  fieldOptionsMax: 200,
  fieldSetsMax: 100,
  fieldSetItemsMax: 100,
  fieldTextMax: 5_000,
  fieldPatternMax: 200,
  formulaSourceMax: 2_000,
  formulaAstNodesMax: 200,
  formulaDepthMax: 8,
  formulaRefsMax: 20,
  fieldValueBulkMax: 500,
  taskStaleActiveDays: 7,
  taskStalePlannedDays: 14,
  taskRescheduleCount: 3,
  taskRescheduleWindowDays: 14,
  taskRemindersMax: 10,
  reminderFireBatchMax: 500,
  taskSnoozeMaxDays: 365,
  bulkItemsMax: 200,
  bulkPreviewTtlSeconds: 600,
  undoWindowSeconds: 30,
  duplicateWindowDays: 90,
  duplicateCandidatesMax: 5,
  captureTextMax: 10_000,
  capturePasteLinesMax: 100,
  captureLinksMax: 10,
  captureFilesMax: 10,
  captureParseTokensMax: 64,
  captureRatePerMinute: 60,
  triageBatchMax: 50,
  inboxMergeMax: 20,
  intakeFormsMax: 50,
  intakeSubmissionsPerHour: 20,
  queryConditionsMax: 40,
  queryDepthMax: 3,
  querySortsMax: 5,
  queryValuesMax: 100,
  queryGroupsMax: 200,
  viewColumnsMax: 20,
  savedViewsMax: 200,
  viewPinsMax: 20,
  exportRowsMax: 5_000,
  totalCountCap: 10_000,
  layoutItemsMax: 200,
  workloadDaysMax: 366,
  activityRecordsMax: 500,
  availabilityWindowsMax: 28,
  timeOffEntriesMax: 500,
  brandHolidaysMax: 1000,
  capacityRangeDaysMax: 93,
  capacityPeopleMax: 100,
  timeEntryMaxHours: 24,
  timeTimerMaxHours: 12,
  timeReportRangeDaysMax: 366,
  timeReportRowsMax: 500,
  timeExportRowsMax: 10_000,
  timeTimesheetEntriesMax: 2000,
  timeRunawayDiscoveryMax: 100,
  timeRunawayBatchMax: 200,
  todayItemsMax: 100,
  todayListMax: 50,
  upcomingDeadlineDays: 14,
  workBlocksPerDayMax: 50,
  workBlocksRangeDaysMax: 42,
  blockSeriesMax: 50,
  blockSeriesHorizonDays: 28,
  dayCloseDiscoveryMax: 100,
  dayCloseBatchMax: 200,
  commentBodyMaxChars: 10_000,
  commentEditWindowMinutes: 1_440,
  commentMentionsMax: 20,
  commentsPerRecordMax: 5_000,
  commentRatePerMinute: 30,
  commentRepliesInlineMax: 20,
  followersListMax: 200,
  reviewReviewersMax: 10,
  notifyFanoutRecipientsMax: 500,
  notifyDedupeWindowMinutes: 60,
  notifyDeliveryBatchMax: 100,
  notifyDeliveryMaxAttempts: 6,
  notifyRetryBaseSeconds: 60,
  notifyRetryMaxSeconds: 3_600,
  notifyDigestItemsMax: 50,
  notifyEmailPerHourMax: 20,
  notifyRetentionDays: 365,
  notifyPreferencesMax: 200,
  notifyBrowserAckTtlMinutes: 30,
  notifySearchQueryMax: 100,
  notifyDiscoveryMax: 100,
  notifyBulkStateMax: 200,
  notifyDeadlinesBatchMax: 500,
  notifyFactsMaxBytes: 1_024,
  documentBodyMaxBytes: 262_144,
  documentBlocksMax: 2000,
  documentBlockTextMaxChars: 20_000,
  documentTableCellsMax: 1000,
  documentDepthMax: 6,
  documentChildrenMax: 200,
  documentTreeMax: 1000,
  documentVersionsMax: 1000,
  documentReferencesMax: 500,
  documentSuggestionsOpenMax: 100,
  documentExportPagesMax: 100,
  documentExportMaxBytes: 5_242_880,
  documentReviewHorizonDays: 730,
  documentSaveRatePerMinute: 60,
  liveEditingEnabled: 1,
  liveSessionTtlSeconds: 45,
  liveSessionsMax: 20,
  liveSessionsPerMemberMax: 5,
  liveOpsBatchMax: 50,
  livePollWaitSeconds: 20,
  liveOpLogMax: 2000,
  liveRatePerMinute: 1200,
  searchQueryMaxChars: 200,
  searchTermsMax: 12,
  searchPageSizeMax: 50,
  searchResultsMax: 200,
  searchCountMax: 1_000,
  searchSnippetChars: 220,
  searchBodyMaxChars: 100_000,
  searchIndexBatchMax: 200,
  searchIndexDiscoveryMax: 50,
  searchIndexMaxAttempts: 5,
  searchIndexBackoffSeconds: 30,
  searchFailedRetryMinutes: 360,
  searchRecentMax: 25,
  searchRecentRetentionDays: 90,
  searchRatePerMinute: 120,
  goalsPerScopeMax: 500,
  goalKeyResultsMax: 20,
  goalLinksMax: 200,
  goalUpdateStaleDays: 14,
  goalCheckinRatePerMinute: 30,
  portfoliosMax: 100,
  portfolioProjectsMax: 200,
  portfolioReadProjectsMax: 500,
  goalsExportRowsMax: 5000,
  goalsRecalcBatchMax: 200,
  goalsRecalcLeaseSeconds: 300,
  goalsRecalcIntervalMinutes: 360,
  goalsRecalcMaxAttempts: 5,
  documentEmbedUrlMaxChars: 2048,
  signedUrlLifetimeSeconds: 300,
  uploadSessionLifetimeSeconds: 3_600,
  fileUploadMaxBytes: 104_857_600,
  workspaceStorageQuotaBytes: 10_737_418_240,
  fileCompareMaxBytes: 262_144,
  fileScanMaxAttempts: 5,
  fileVersionsMax: 100,
  filesListMax: 200,
  deliverablesPerTaskMax: 50,
  fileDiscoveryMax: 100,
  fileExpiryBatchMax: 200,
});

/** The database invariant behind `TASK_DEPTH_MAX` (migration 0023). */
export const TASK_DEPTH_CEILING = 64;

/** The database invariant behind `PROJECT_DEPTH_MAX` (migration 0021). */
export const PROJECT_DEPTH_CEILING = 32;

export const PROJECT_ICONS = [
  'folder',
  'rocket',
  'target',
  'flag',
  'star',
  'calendar',
  'chart',
  'box',
  'book',
  'tool',
] as const;

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Identifiers of comments and review requests (4A). They are not records, so history and activity
 * show them as references only because the event's own target record was already authorized.
 */
export const COLLAB_REF = /^(cmt|rvw)_[0-9A-HJKMNP-TV-Z]{26}$/;

const PUBLIC = (prefix: string) => new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`);
export const isPublic = (v: unknown, prefix: string): v is string =>
  typeof v === 'string' && PUBLIC(prefix).test(v);

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function date(v: unknown, pointer: string, issues: Issues): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    issues.add(pointer, 'invalid_date', 'Use a date like 2026-10-04.');
    return undefined;
  }
  return v;
}

export function enumValue<T extends string>(
  v: unknown,
  allowed: readonly T[],
  pointer: string,
  issues: Issues,
  nullable = false,
): T | null | undefined {
  if (v === undefined) return undefined;
  if (v === null && nullable) return null;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    issues.add(pointer, 'invalid_option', 'Choose one of the listed options.');
    return undefined;
  }
  return v as T;
}

export function nonNegativeInt(
  v: unknown,
  pointer: string,
  issues: Issues,
  max: number,
): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) {
    issues.add(pointer, 'invalid_number', 'Use a whole number of zero or more.');
    return undefined;
  }
  return v;
}

function money(v: unknown, pointer: string, issues: Issues): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || !/^\d{1,14}(\.\d{1,2})?$/.test(s)) {
    issues.add(pointer, 'invalid_number', 'Use an amount like 1500 or 1500.50.');
    return undefined;
  }
  return s;
}

/** Integer micros as a string (0D money convention: int64-safe for JavaScript). */
function micros(v: unknown, pointer: string, issues: Issues): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== 'string' || !/^(0|[1-9]\d{0,17})$/.test(s)) {
    issues.add(pointer, 'invalid_number', 'Use a whole number of zero or more.');
    return undefined;
  }
  return s;
}

/** Most characters of a project description's extracted text (rich text version 1, 0D PL-23). */
export const DESCRIPTION_TEXT_MAX = 20_000;

/**
 * A rich-text field (0D PL-23): `null` clears it; otherwise a version 1 document whose extracted
 * text fits `max`. Unsupported nodes, marks, attributes, and versions are refused, never stored.
 */
export function richText(
  v: unknown,
  pointer: string,
  issues: Issues,
  max: number,
): RichTextDoc | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const r = validateRichText(v, max);
  if (!r.ok) {
    issues.add(`${pointer}${r.path}`, r.code, r.message);
    return undefined;
  }
  return r.doc;
}

/** Fields a project may set on create and change by field-merge (0D field-merge-request). */
export const PROJECT_FIELDS = [
  'name',
  'description',
  'icon',
  'color',
  'status',
  'priority',
  'start_date',
  'target_date',
  'deadline_date',
  'health',
  'budget_amount',
  'budget_currency',
  'time_budget_minutes',
  'ai_budget_micros',
] as const;
export type ProjectField = (typeof PROJECT_FIELDS)[number];

export const PROJECT_CONTENT_FIELDS: Record<string, 'content'> = {
  name: 'content',
  description: 'content',
};

/** Validates one project field value; undefined means invalid (an issue was added). */
export function projectField(field: string, v: unknown, issues: Issues): unknown {
  const p = `/changes/${field}`;
  switch (field as ProjectField) {
    case 'name':
      return text(v, p, issues, { max: 200, required: true, label: 'Project name' });
    case 'description':
      return richText(v, p, issues, DESCRIPTION_TEXT_MAX);
    case 'icon':
      return enumValue(v, PROJECT_ICONS, p, issues, true);
    case 'color':
      return v === null ? null : colorValue(v, p, issues);
    case 'status':
      // A platform key or a workflow status ID; the applicable workflow decides (ADR-0015 W3).
      if (typeof v === 'string' && /^sts_[0-9A-HJKMNP-TV-Z]{26}$/.test(v)) return v;
      return enumValue(
        v,
        PROJECT_STATUSES.map((s) => s.key),
        p,
        issues,
      );
    case 'priority':
      return enumValue(v, PROJECT_PRIORITIES, p, issues);
    case 'start_date':
    case 'target_date':
    case 'deadline_date':
      return date(v, p, issues);
    case 'health':
      return enumValue(v, PROJECT_HEALTH, p, issues, true);
    case 'budget_amount':
      return money(v, p, issues);
    case 'budget_currency':
      return v === null ? null : currency(v, p, issues);
    case 'time_budget_minutes':
      return nonNegativeInt(v, p, issues, 100_000_000);
    case 'ai_budget_micros':
      return micros(v, p, issues);
    default:
      issues.add(p, 'unsupported_field', 'This field is not supported.');
      return undefined;
  }
}

export interface ProjectCreateInput {
  brand: string | null;
  parent: string | null;
  template: string | null;
  intake_source: string | null;
  fields: Partial<Record<ProjectField, unknown>>;
}

export function parseProjectCreate(body: unknown): ProjectCreateInput {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  const allowed = new Set<string>([
    ...PROJECT_FIELDS,
    'brand',
    'parent',
    'template',
    'intake_source',
  ]);
  for (const k of Object.keys(b))
    if (!allowed.has(k)) issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const ref = (k: string, prefix: string) => {
    const v = b[k];
    if (v === undefined || v === null) return null;
    if (!isPublic(v, prefix)) {
      issues.add(`/${k}`, 'invalid_reference', 'Choose an item from the list.');
      return null;
    }
    return v;
  };
  const brand = ref('brand', 'br');
  const parent = ref('parent', 'prj');
  const template = ref('template', 'tpl');
  const intake = ref('intake_source', 'form');
  const fields: Partial<Record<ProjectField, unknown>> = {};
  for (const f of PROJECT_FIELDS) {
    if (b[f] === undefined) continue;
    const v = projectField(f, b[f], issues);
    if (v !== undefined) fields[f] = v;
  }
  if (b.name === undefined && template === null)
    issues.add('/name', 'required', 'Project name is required.');
  if (brand === null && parent === null)
    issues.add('/brand', 'brand_required', 'Choose which brand owns this');
  issues.throwIfAny();
  return { brand, parent, template, intake_source: intake, fields };
}

/** Reorder/reparent body: the new parent (null = root) and the sibling to place after. */
export function parseMove(body: unknown): { parent: string | null; after: string | null } {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (k !== 'parent' && k !== 'after')
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const parent = b.parent ?? null;
  const after = b.after ?? null;
  if (parent !== null && !isPublic(parent, 'prj'))
    issues.add('/parent', 'invalid_reference', 'Choose a project.');
  if (after !== null && !isPublic(after, 'prj'))
    issues.add('/after', 'invalid_reference', 'Choose a project.');
  issues.throwIfAny();
  return { parent: parent as string | null, after: after as string | null };
}

/** Ordered child rows (phases, milestones, criteria, scope items): place after a sibling or first. */
export function parseAfter(body: unknown, prefix: string): string | null {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  const after = b.after ?? null;
  if (after !== null && !isPublic(after, prefix))
    issues.add('/after', 'invalid_reference', 'Choose an item from the list.');
  issues.throwIfAny();
  return after as string | null;
}

export function parsePhase(body: unknown, partial: boolean) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (!['name', 'start_date', 'end_date', 'status', 'owner'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const out = {
    name: text(b.name, '/name', issues, { max: 120, required: !partial, label: 'Phase name' }),
    start_date: date(b.start_date, '/start_date', issues),
    end_date: date(b.end_date, '/end_date', issues),
    status: enumValue(b.status, PHASE_STATUSES, '/status', issues),
    owner: ownerRef(b.owner, issues),
  };
  if (out.start_date && out.end_date && out.end_date < out.start_date)
    issues.add('/end_date', 'date_order', 'The end date is before the start date.');
  issues.throwIfAny();
  return out;
}

export function parseMilestone(body: unknown, partial: boolean) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (!['name', 'due_date', 'status', 'phase', 'owner'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const phase = b.phase;
  if (phase !== undefined && phase !== null && !isPublic(phase, 'phs'))
    issues.add('/phase', 'invalid_reference', 'Choose a phase of this project.');
  const out = {
    name: text(b.name, '/name', issues, { max: 120, required: !partial, label: 'Milestone name' }),
    due_date: date(b.due_date, '/due_date', issues),
    status: enumValue(b.status, MILESTONE_STATUSES, '/status', issues),
    phase: phase as string | null | undefined,
    owner: ownerRef(b.owner, issues),
  };
  issues.throwIfAny();
  return out;
}

function ownerRef(v: unknown, issues: Issues): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!isPublic(v, 'mem')) {
    issues.add('/owner', 'invalid_reference', 'Choose a person.');
    return undefined;
  }
  return v;
}

export function parseCriterion(body: unknown, partial: boolean) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (!['kind', 'text', 'met'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const out = {
    kind: partial
      ? enumValue(b.kind, CRITERIA_KINDS, '/kind', issues)
      : (enumValue(b.kind ?? 'success', CRITERIA_KINDS, '/kind', issues) as
          (typeof CRITERIA_KINDS)[number] | undefined),
    text: text(b.text, '/text', issues, { max: 500, required: !partial, label: 'Criterion' }),
    met: b.met === undefined ? undefined : b.met === true,
  };
  if (b.met !== undefined && typeof b.met !== 'boolean')
    issues.add('/met', 'invalid_type', 'Choose met or not met.');
  issues.throwIfAny();
  return out;
}

export function parseScopeItem(body: unknown, partial: boolean) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (!['kind', 'text'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const out = {
    kind: partial
      ? enumValue(b.kind, SCOPE_ITEM_KINDS, '/kind', issues)
      : enumValue(b.kind, SCOPE_ITEM_KINDS, '/kind', issues),
    text: text(b.text, '/text', issues, { max: 1000, required: !partial, label: 'Entry' }),
  };
  if (!partial && out.kind === undefined && b.kind === undefined)
    issues.add('/kind', 'required', 'Choose what kind of entry this is.');
  issues.throwIfAny();
  return out;
}

export function parseUpdate(body: unknown) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (!['body', 'health'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const out = {
    body: text(b.body, '/body', issues, { max: 10000, required: true, label: 'Update' }) as string,
    health: enumValue(b.health ?? null, PROJECT_HEALTH, '/health', issues, true) ?? null,
  };
  issues.throwIfAny();
  return out;
}

export function parseDecision(body: unknown, partial: boolean) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (
      !['kind', 'statement', 'outcome', 'owner', 'due_date', 'state', 'superseded_by'].includes(k)
    )
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const out = {
    kind: partial ? undefined : enumValue(b.kind ?? 'decision', DECISION_KINDS, '/kind', issues),
    statement: text(b.statement, '/statement', issues, {
      max: 2000,
      required: !partial,
      label: 'Statement',
    }),
    outcome: text(b.outcome, '/outcome', issues, { max: 4000, required: false, label: 'Outcome' }),
    owner: ownerRef(b.owner, issues),
    due_date: date(b.due_date, '/due_date', issues),
    state:
      b.state === undefined
        ? undefined
        : enumValue(
            b.state,
            ['proposed', 'decided', 'superseded', 'open', 'resolved'],
            '/state',
            issues,
          ),
    superseded_by:
      b.superseded_by === undefined || b.superseded_by === null
        ? null
        : isPublic(b.superseded_by, 'dec')
          ? b.superseded_by
          : (issues.add('/superseded_by', 'invalid_reference', 'Choose a decision.'), null),
  };
  issues.throwIfAny();
  return out;
}

export function parseDependency(body: unknown): { target: string } {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (k !== 'target' && k !== 'kind')
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  if (b.kind !== undefined && b.kind !== 'blocks')
    issues.add('/kind', 'invalid_option', 'Projects depend on each other with "blocks".');
  if (!isPublic(b.target, 'prj')) issues.add('/target', 'invalid_reference', 'Choose a project.');
  issues.throwIfAny();
  return { target: b.target as string };
}

export function parseAccess(body: unknown) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (!['access_mode', 'allow_record_shares'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const mode = enumValue(b.access_mode, ['inherit', 'restricted'] as const, '/access_mode', issues);
  if (b.allow_record_shares !== undefined && typeof b.allow_record_shares !== 'boolean')
    issues.add('/allow_record_shares', 'invalid_type', 'Choose on or off.');
  issues.throwIfAny();
  return {
    access_mode: mode ?? undefined,
    allow_record_shares: b.allow_record_shares as boolean | undefined,
  };
}

export function parseTemplateFromProject(body: unknown) {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (!['name', 'scope'].includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const out = {
    name: text(b.name, '/name', issues, {
      max: 200,
      required: true,
      label: 'Template name',
    }) as string,
    scope: (enumValue(b.scope ?? 'brand', ['brand', 'workspace'] as const, '/scope', issues) ??
      'brand') as 'brand' | 'workspace',
  };
  issues.throwIfAny();
  return out;
}

/**
 * A recurrence definition as people choose it (ADR-0013 P11): frequency, interval, weekdays
 * (weekly), month days (monthly), the anchor local date-time and IANA zone, and one end condition.
 * Combinations the rule subset does not support are field errors; nothing is silently normalized.
 */
export function parseRecurrence(body: unknown): {
  rule: RuleInput;
  rrule: string;
  anchor_tz: string;
  start: string;
} {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  for (const k of Object.keys(b))
    if (
      !['frequency', 'interval', 'weekdays', 'month_days', 'start', 'anchor_tz', 'ends'].includes(k)
    )
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
  const frequency = enumValue(b.frequency, FREQUENCIES, '/frequency', issues);
  if (frequency === undefined && b.frequency === undefined)
    issues.add('/frequency', 'required', 'Choose how often this repeats.');
  let interval = 1;
  if (b.interval !== undefined) {
    if (
      typeof b.interval !== 'number' ||
      !Number.isInteger(b.interval) ||
      b.interval < 1 ||
      b.interval > 366
    )
      issues.add('/interval', 'invalid_number', 'Use a whole number from 1 to 366.');
    else interval = b.interval;
  }
  let weekdays: Weekday[] | null = null;
  if (b.weekdays !== undefined && b.weekdays !== null) {
    if (frequency !== 'weekly')
      issues.add('/weekdays', 'not_applicable', 'Weekdays apply only to weekly schedules.');
    else if (
      !Array.isArray(b.weekdays) ||
      !b.weekdays.length ||
      b.weekdays.some((d) => !(WEEKDAYS as readonly unknown[]).includes(d)) ||
      new Set(b.weekdays).size !== b.weekdays.length
    )
      issues.add('/weekdays', 'invalid_option', 'Choose one or more different weekdays.');
    else weekdays = b.weekdays as Weekday[];
  }
  let monthDays: number[] | null = null;
  if (b.month_days !== undefined && b.month_days !== null) {
    if (frequency !== 'monthly')
      issues.add(
        '/month_days',
        'not_applicable',
        'Days of the month apply only to monthly schedules.',
      );
    else if (
      !Array.isArray(b.month_days) ||
      !b.month_days.length ||
      b.month_days.some((d) => typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 31) ||
      new Set(b.month_days).size !== b.month_days.length
    )
      issues.add(
        '/month_days',
        'invalid_option',
        'Choose one or more different days from 1 to 31.',
      );
    else monthDays = b.month_days as number[];
  }
  const tz = typeof b.anchor_tz === 'string' ? b.anchor_tz : '';
  try {
    if (!tz) throw new Error('empty');
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    issues.add('/anchor_tz', 'invalid_timezone', 'Choose a time zone.');
  }
  const start = typeof b.start === 'string' ? b.start : '';
  const sm = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(start);
  if (!sm || !isCalendarDate(+sm[1]!, +sm[2]!, +sm[3]!))
    issues.add('/start', 'invalid_date', 'Choose the first date and time, like 2026-11-02T09:00.');
  let ends: RuleInput['ends'] = { type: 'never' };
  const e = b.ends;
  if (e !== undefined && e !== null) {
    const t = isObject(e) ? e.type : undefined;
    if (t === 'never' && isObject(e) && Object.keys(e).length === 1) ends = { type: 'never' };
    else if (t === 'after' && isObject(e)) {
      const c = e.count;
      if (typeof c !== 'number' || !Number.isInteger(c) || c < 1 || c > COUNT_MAX)
        issues.add('/ends/count', 'invalid_number', `Use a whole number from 1 to ${COUNT_MAX}.`);
      else ends = { type: 'after', count: c };
    } else if (t === 'on' && isObject(e)) {
      const d = typeof e.date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.date) : null;
      if (!d || !isCalendarDate(+d[1]!, +d[2]!, +d[3]!))
        issues.add('/ends/date', 'invalid_date', 'Choose the last date, like 2027-06-30.');
      else if (sm && (e.date as string) < start.slice(0, 10))
        issues.add(
          '/ends/date',
          'before_start',
          'The last date must be on or after the first one.',
        );
      else ends = { type: 'on', date: e.date as string };
    } else
      issues.add('/ends', 'invalid_option', 'Choose never, after a number of times, or on a date.');
  }
  issues.throwIfAny();
  const rule: RuleInput = { frequency: frequency!, interval, weekdays, monthDays, ends };
  return { rule, rrule: composeRule(rule), anchor_tz: tz, start };
}

export { colorValue };
