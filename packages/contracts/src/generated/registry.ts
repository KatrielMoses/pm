// GENERATED FILE - do not edit by hand.
// Source: docs/architecture/platform/contracts/registry.json (schema_version 1)
//         docs/architecture/access/policy/policy.json (schema_version 1)
//         docs/architecture/data/model/model.json (schema_version 1)
//         docs/architecture/platform/contracts/schemas/step-up-challenge.schema.json
// Regenerate: pnpm contracts:generate

export const ACTOR_TYPES = [
  "human",
  "ai",
  "automation",
  "integration",
  "agent",
  "system"
] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const EXEC_STATES = [
  "queued",
  "running",
  "waiting",
  "paused",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "skipped"
] as const;
export type ExecState = (typeof EXEC_STATES)[number];

export const TERMINAL_REASONS = [
  "error",
  "timed_out",
  "limit_exceeded",
  "policy_rejected",
  "user_cancelled",
  "emergency_stop",
  "superseded",
  "deduplicated"
] as const;
export type TerminalReason = (typeof TERMINAL_REASONS)[number];

export const WAITING_REASONS = [
  "approval",
  "input",
  "rate_limit",
  "delay",
  "external_confirmation",
  "reconciliation_required",
  "authorization_changed",
  "dependency_unavailable"
] as const;
export type WaitingReason = (typeof WAITING_REASONS)[number];

export const JOB_STATES = [
  "queued",
  "leased",
  "retry_scheduled",
  "succeeded",
  "dead",
  "cancelled"
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** 0D §7.2: job state -> operation exec_state (default mapping). */
export const JOB_STATE_TO_EXEC_STATE = {
  "queued": "queued",
  "leased": "running",
  "retry_scheduled": "running",
  "succeeded": "succeeded",
  "dead": "failed",
  "cancelled": "cancelled"
} as const satisfies Record<JobState, ExecState>;

export const FORBIDDEN_METRIC_LABELS = [
  "workspace_id",
  "brand_id",
  "record_id",
  "public_id",
  "email",
  "title",
  "name",
  "query",
  "ip",
  "user_agent",
  "workspace",
  "brand",
  "membership",
  "membership_id",
  "account",
  "account_id",
  "timezone",
  "content"
] as const;
export type ForbiddenMetricLabel = (typeof FORBIDDEN_METRIC_LABELS)[number];

export const TELEMETRY_SIGNALS = [
  {
    "name": "http.server.request.duration",
    "type": "histogram",
    "labels": [
      "route",
      "method",
      "status_class",
      "principal_class"
    ]
  },
  {
    "name": "http.server.requests",
    "type": "counter",
    "labels": [
      "route",
      "method",
      "status_class"
    ]
  },
  {
    "name": "authz.denials",
    "type": "counter",
    "labels": [
      "route",
      "action_key",
      "response_shape",
      "principal_class"
    ]
  },
  {
    "name": "authz.context_build.duration",
    "type": "histogram",
    "labels": [
      "cache_hit"
    ]
  },
  {
    "name": "db.transaction.duration",
    "type": "histogram",
    "labels": [
      "module",
      "kind"
    ]
  },
  {
    "name": "db.rls_context_assertion_failures",
    "type": "counter",
    "labels": [
      "module"
    ]
  },
  {
    "name": "job.queue.lag",
    "type": "gauge",
    "labels": [
      "queue"
    ]
  },
  {
    "name": "job.attempts",
    "type": "counter",
    "labels": [
      "queue",
      "outcome"
    ]
  },
  {
    "name": "job.dead",
    "type": "counter",
    "labels": [
      "queue"
    ]
  },
  {
    "name": "job.lease_expired",
    "type": "counter",
    "labels": [
      "queue"
    ]
  },
  {
    "name": "outbox.dispatch.lag",
    "type": "gauge",
    "labels": []
  },
  {
    "name": "inbox.duplicates_skipped",
    "type": "counter",
    "labels": [
      "consumer"
    ]
  },
  {
    "name": "webhook.delivery.duration",
    "type": "histogram",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "webhook.deliveries",
    "type": "counter",
    "labels": [
      "outcome",
      "status_class"
    ]
  },
  {
    "name": "webhook.endpoints_disabled",
    "type": "counter",
    "labels": []
  },
  {
    "name": "webhook.inbound.rejected",
    "type": "counter",
    "labels": [
      "reason"
    ]
  },
  {
    "name": "sse.connections",
    "type": "gauge",
    "labels": []
  },
  {
    "name": "sse.resets",
    "type": "counter",
    "labels": [
      "reason"
    ]
  },
  {
    "name": "upload.completed",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "file.scan.duration",
    "type": "histogram",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "integrations.requests",
    "type": "counter",
    "labels": [
      "op",
      "outcome"
    ]
  },
  {
    "name": "integrations.jobs",
    "type": "counter",
    "labels": [
      "kind",
      "outcome"
    ]
  },
  {
    "name": "integration.sync.duration",
    "type": "histogram",
    "labels": [
      "provider",
      "outcome"
    ]
  },
  {
    "name": "ai.request.duration",
    "type": "histogram",
    "labels": [
      "provider_class",
      "outcome"
    ]
  },
  {
    "name": "agent.tool_calls",
    "type": "counter",
    "labels": [
      "tool_class",
      "outcome"
    ]
  },
  {
    "name": "automation.runs",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "usage.reservations_denied",
    "type": "counter",
    "labels": [
      "meter"
    ]
  },
  {
    "name": "usage.cap_stops",
    "type": "counter",
    "labels": [
      "meter"
    ]
  },
  {
    "name": "audit.write_failures",
    "type": "counter",
    "labels": [
      "module"
    ]
  },
  {
    "name": "step_up.challenges",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "security.support_access_actions",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "tenancy.commands",
    "type": "counter",
    "labels": [
      "command",
      "outcome"
    ]
  },
  {
    "name": "tenancy.authz_decisions",
    "type": "counter",
    "labels": [
      "action_key",
      "outcome"
    ]
  },
  {
    "name": "tenancy.context_failures",
    "type": "counter",
    "labels": [
      "reason"
    ]
  },
  {
    "name": "tenancy.context_fallbacks",
    "type": "counter",
    "labels": [
      "reason"
    ]
  },
  {
    "name": "tenancy.rls_denials",
    "type": "counter",
    "labels": [
      "module"
    ]
  },
  {
    "name": "tenancy.invitation_outcomes",
    "type": "counter",
    "labels": [
      "stage",
      "outcome"
    ]
  },
  {
    "name": "tenancy.revocations",
    "type": "counter",
    "labels": [
      "kind",
      "outcome"
    ]
  },
  {
    "name": "tenancy.epoch_stale",
    "type": "counter",
    "labels": [
      "consumer"
    ]
  },
  {
    "name": "tenancy.ownership_hook_failures",
    "type": "counter",
    "labels": [
      "hook"
    ]
  },
  {
    "name": "tenancy.context_strategy",
    "type": "counter",
    "labels": [
      "strategy"
    ]
  },
  {
    "name": "views.recent_writes",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "views.favorite_changes",
    "type": "counter",
    "labels": [
      "op",
      "outcome"
    ]
  },
  {
    "name": "views.state_ops",
    "type": "counter",
    "labels": [
      "op",
      "outcome"
    ]
  },
  {
    "name": "views.state_decode_failures",
    "type": "counter",
    "labels": [
      "source",
      "reason"
    ]
  },
  {
    "name": "views.omitted_targets",
    "type": "counter",
    "labels": [
      "list"
    ]
  },
  {
    "name": "views.cleanup",
    "type": "counter",
    "labels": [
      "kind"
    ]
  },
  {
    "name": "shell.commands",
    "type": "counter",
    "labels": [
      "command",
      "trigger"
    ]
  },
  {
    "name": "identity.preference_updates",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "work.recurrence.occurrences",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "work.hierarchy.moves",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "work.task.moves",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "work.task.completions",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "workflow.transitions",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "workflow.transition.duration",
    "type": "histogram",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "workflow.formula.evaluations",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "work.reminders.fired",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "work.bulk.items",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "work.undo.applied",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "capture.items",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "capture.parse",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "capture.triage",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "views.queries",
    "type": "counter",
    "labels": [
      "entity",
      "outcome"
    ]
  },
  {
    "name": "views.query_duration",
    "type": "histogram",
    "labels": [
      "entity"
    ]
  },
  {
    "name": "views.exports",
    "type": "counter",
    "labels": [
      "entity",
      "format"
    ]
  },
  {
    "name": "time.entries",
    "type": "counter",
    "labels": [
      "source",
      "outcome"
    ]
  },
  {
    "name": "time.timers",
    "type": "counter",
    "labels": [
      "action",
      "outcome"
    ]
  },
  {
    "name": "time.timesheets",
    "type": "counter",
    "labels": [
      "action",
      "outcome"
    ]
  },
  {
    "name": "time.exports",
    "type": "counter",
    "labels": [
      "format"
    ]
  },
  {
    "name": "time.timer_guard",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "views.layout_reads",
    "type": "counter",
    "labels": [
      "layout",
      "outcome"
    ]
  },
  {
    "name": "planning.today",
    "type": "counter",
    "labels": [
      "action",
      "outcome"
    ]
  },
  {
    "name": "planning.blocks",
    "type": "counter",
    "labels": [
      "action",
      "outcome"
    ]
  },
  {
    "name": "planning.block_series",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "planning.day_close",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "capacity.reads",
    "type": "counter",
    "labels": [
      "view",
      "outcome"
    ]
  },
  {
    "name": "capacity.changes",
    "type": "counter",
    "labels": [
      "kind",
      "outcome"
    ]
  },
  {
    "name": "collab.comments",
    "type": "counter",
    "labels": [
      "action",
      "outcome"
    ]
  },
  {
    "name": "collab.reactions",
    "type": "counter",
    "labels": [
      "change",
      "outcome"
    ]
  },
  {
    "name": "collab.follows",
    "type": "counter",
    "labels": [
      "change",
      "outcome"
    ]
  },
  {
    "name": "collab.reviews",
    "type": "counter",
    "labels": [
      "action",
      "outcome"
    ]
  },
  {
    "name": "collab.delegations",
    "type": "counter",
    "labels": [
      "kind",
      "outcome"
    ]
  },
  {
    "name": "notify.fanout",
    "type": "counter",
    "labels": [
      "type",
      "outcome"
    ]
  },
  {
    "name": "notify.deliveries",
    "type": "counter",
    "labels": [
      "channel",
      "outcome"
    ]
  },
  {
    "name": "notify.digests",
    "type": "counter",
    "labels": [
      "kind",
      "outcome"
    ]
  },
  {
    "name": "notify.reads",
    "type": "counter",
    "labels": [
      "view",
      "outcome"
    ]
  },
  {
    "name": "knowledge.documents",
    "type": "counter",
    "labels": [
      "action",
      "outcome"
    ]
  },
  {
    "name": "knowledge.versions",
    "type": "counter",
    "labels": [
      "action",
      "outcome"
    ]
  },
  {
    "name": "knowledge.suggestions",
    "type": "counter",
    "labels": [
      "action",
      "outcome"
    ]
  },
  {
    "name": "knowledge.exports",
    "type": "counter",
    "labels": [
      "format",
      "outcome"
    ]
  },
  {
    "name": "knowledge.references",
    "type": "counter",
    "labels": [
      "action",
      "outcome"
    ]
  },
  {
    "name": "knowledge.live",
    "type": "counter",
    "labels": [
      "action",
      "outcome"
    ]
  },
  {
    "name": "search.requests",
    "type": "counter",
    "labels": [
      "op",
      "outcome"
    ]
  },
  {
    "name": "search.index.jobs",
    "type": "counter",
    "labels": [
      "kind",
      "outcome"
    ]
  },
  {
    "name": "search.query.duration",
    "type": "histogram",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "files.requests",
    "type": "counter",
    "labels": [
      "op",
      "outcome"
    ]
  },
  {
    "name": "files.jobs",
    "type": "counter",
    "labels": [
      "kind",
      "outcome"
    ]
  },
  {
    "name": "goals.reads",
    "type": "counter",
    "labels": [
      "view",
      "outcome"
    ]
  },
  {
    "name": "goals.changes",
    "type": "counter",
    "labels": [
      "kind",
      "outcome"
    ]
  },
  {
    "name": "goals.jobs",
    "type": "counter",
    "labels": [
      "kind",
      "outcome"
    ]
  },
  {
    "name": "metrics.requests",
    "type": "counter",
    "labels": [
      "op",
      "outcome"
    ]
  },
  {
    "name": "metrics.query.duration",
    "type": "histogram",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "metrics.reconcile.jobs",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "insights.reads",
    "type": "counter",
    "labels": [
      "view",
      "outcome"
    ]
  },
  {
    "name": "insights.changes",
    "type": "counter",
    "labels": [
      "kind",
      "outcome"
    ]
  },
  {
    "name": "insights.jobs",
    "type": "counter",
    "labels": [
      "kind",
      "outcome"
    ]
  },
  {
    "name": "insights.widgets",
    "type": "counter",
    "labels": [
      "metric",
      "outcome"
    ]
  },
  {
    "name": "ai.runs",
    "type": "counter",
    "labels": [
      "outcome",
      "provider_class"
    ]
  },
  {
    "name": "ai.dispatches",
    "type": "counter",
    "labels": [
      "provider_class",
      "outcome"
    ]
  },
  {
    "name": "ai.policy_refusals",
    "type": "counter",
    "labels": [
      "reason"
    ]
  },
  {
    "name": "ai.reservations",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "ai.cancellations",
    "type": "counter",
    "labels": [
      "stage"
    ]
  },
  {
    "name": "ai.tokens",
    "type": "counter",
    "labels": [
      "direction"
    ]
  },
  {
    "name": "ai.cost_micros",
    "type": "counter",
    "labels": [
      "funding"
    ]
  },
  {
    "name": "ai.history.erased",
    "type": "counter",
    "labels": [
      "reason"
    ]
  },
  {
    "name": "ai.context_previews",
    "type": "counter",
    "labels": [
      "index"
    ]
  },
  {
    "name": "ai.answer_validations",
    "type": "counter",
    "labels": [
      "status"
    ]
  },
  {
    "name": "ai.proposals",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "ai.proposal_applications",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "ai.analyses",
    "type": "counter",
    "labels": [
      "status"
    ]
  },
  {
    "name": "ai.briefings",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "planning.plans",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "capture.voice",
    "type": "counter",
    "labels": [
      "outcome"
    ]
  },
  {
    "name": "capture.interpretations",
    "type": "counter",
    "labels": [
      "status"
    ]
  }
] as const;
export type TelemetrySignalName = (typeof TELEMETRY_SIGNALS)[number]['name'];

export const ERROR_CODES = [
  {
    "code": "malformed_request",
    "httpStatus": 400,
    "category": "client",
    "retryable": false,
    "safeMessage": "The request could not be read.",
    "usage": "http"
  },
  {
    "code": "cursor_invalid",
    "httpStatus": 400,
    "category": "client",
    "retryable": false,
    "safeMessage": "This page link is no longer valid. Start again from the first page.",
    "usage": "http"
  },
  {
    "code": "unauthenticated",
    "httpStatus": 401,
    "category": "auth",
    "retryable": false,
    "safeMessage": "Sign in again to continue.",
    "usage": "http"
  },
  {
    "code": "forbidden",
    "httpStatus": 403,
    "category": "authz",
    "retryable": false,
    "safeMessage": "You don't have permission to do that.",
    "usage": "http"
  },
  {
    "code": "step_up_required",
    "httpStatus": 403,
    "category": "auth",
    "retryable": false,
    "safeMessage": "Confirm it's you to continue.",
    "usage": "http"
  },
  {
    "code": "step_up_unavailable",
    "httpStatus": 403,
    "category": "auth",
    "retryable": false,
    "safeMessage": "This action needs a person to confirm it.",
    "usage": "http"
  },
  {
    "code": "approval_required",
    "httpStatus": 403,
    "category": "authz",
    "retryable": false,
    "safeMessage": "This action needs approval first.",
    "usage": "http"
  },
  {
    "code": "principal_suspended",
    "httpStatus": 403,
    "category": "authz",
    "retryable": false,
    "safeMessage": "This automation or integration is paused until it has an owner with access.",
    "usage": "http"
  },
  {
    "code": "entitlement_required",
    "httpStatus": 403,
    "category": "commercial",
    "retryable": false,
    "safeMessage": "Your plan doesn't include this feature.",
    "usage": "http"
  },
  {
    "code": "usage_limit_reached",
    "httpStatus": 403,
    "category": "commercial",
    "retryable": false,
    "safeMessage": "This would exceed a usage limit.",
    "usage": "http"
  },
  {
    "code": "workspace_read_only",
    "httpStatus": 403,
    "category": "commercial",
    "retryable": false,
    "safeMessage": "This workspace is read-only.",
    "usage": "http"
  },
  {
    "code": "not_found",
    "httpStatus": 404,
    "category": "authz",
    "retryable": false,
    "safeMessage": "The requested resource was not found.",
    "usage": "http"
  },
  {
    "code": "method_not_allowed",
    "httpStatus": 405,
    "category": "client",
    "retryable": false,
    "safeMessage": "That operation isn't supported here.",
    "usage": "http"
  },
  {
    "code": "conflict",
    "httpStatus": 409,
    "category": "concurrency",
    "retryable": false,
    "safeMessage": "This item was changed by someone else.",
    "usage": "http"
  },
  {
    "code": "evidence_locked",
    "httpStatus": 409,
    "category": "concurrency",
    "retryable": false,
    "safeMessage": "This version is locked as evidence and can't be changed.",
    "usage": "http"
  },
  {
    "code": "file_not_ready",
    "httpStatus": 409,
    "category": "files",
    "retryable": true,
    "safeMessage": "This file is still being checked.",
    "usage": "http"
  },
  {
    "code": "file_blocked",
    "httpStatus": 403,
    "category": "files",
    "retryable": false,
    "safeMessage": "This file can't be downloaded.",
    "usage": "http"
  },
  {
    "code": "idempotency_key_reuse",
    "httpStatus": 409,
    "category": "idempotency",
    "retryable": false,
    "safeMessage": "This request key was already used for a different request.",
    "usage": "http"
  },
  {
    "code": "idempotency_in_progress",
    "httpStatus": 409,
    "category": "idempotency",
    "retryable": true,
    "safeMessage": "This request is still being processed.",
    "usage": "http"
  },
  {
    "code": "payload_too_large",
    "httpStatus": 413,
    "category": "client",
    "retryable": false,
    "safeMessage": "The request is too large.",
    "usage": "http"
  },
  {
    "code": "unsupported_media_type",
    "httpStatus": 415,
    "category": "client",
    "retryable": false,
    "safeMessage": "That content type isn't supported.",
    "usage": "http"
  },
  {
    "code": "validation_failed",
    "httpStatus": 422,
    "category": "client",
    "retryable": false,
    "safeMessage": "Some fields need attention.",
    "usage": "http"
  },
  {
    "code": "checksum_mismatch",
    "httpStatus": 422,
    "category": "files",
    "retryable": false,
    "safeMessage": "The uploaded file didn't match its checksum.",
    "usage": "http"
  },
  {
    "code": "precondition_required",
    "httpStatus": 428,
    "category": "concurrency",
    "retryable": false,
    "safeMessage": "Include the version you are changing.",
    "usage": "http"
  },
  {
    "code": "rate_limited",
    "httpStatus": 429,
    "category": "throttle",
    "retryable": true,
    "safeMessage": "Too many requests. Try again shortly.",
    "usage": "http"
  },
  {
    "code": "internal_error",
    "httpStatus": 500,
    "category": "server",
    "retryable": true,
    "safeMessage": "Something went wrong on our side.",
    "usage": "http"
  },
  {
    "code": "dependency_unavailable",
    "httpStatus": 503,
    "category": "server",
    "retryable": true,
    "safeMessage": "A connected service is unavailable. Core features still work.",
    "usage": "http"
  },
  {
    "code": "service_unavailable",
    "httpStatus": 503,
    "category": "server",
    "retryable": true,
    "safeMessage": "The service is temporarily unavailable.",
    "usage": "http"
  },
  {
    "code": "partial_failure",
    "httpStatus": null,
    "category": "outcome",
    "retryable": false,
    "safeMessage": "Some items couldn't be completed.",
    "usage": "operation_or_bulk_outcome"
  },
  {
    "code": "timed_out",
    "httpStatus": null,
    "category": "outcome",
    "retryable": true,
    "safeMessage": "This took too long and was stopped.",
    "usage": "terminal_reason"
  },
  {
    "code": "limit_exceeded",
    "httpStatus": null,
    "category": "outcome",
    "retryable": false,
    "safeMessage": "This stopped at a configured limit.",
    "usage": "terminal_reason"
  },
  {
    "code": "policy_rejected",
    "httpStatus": null,
    "category": "outcome",
    "retryable": false,
    "safeMessage": "This was stopped because access or policy changed.",
    "usage": "terminal_reason"
  }
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number]['code'];

export const OPERATION_KINDS = [
  {
    "kind": "ai_action",
    "supports": [
      "cancel",
      "retry",
      "rerun"
    ],
    "riskClass": "R1"
  },
  {
    "kind": "agent_run",
    "supports": [
      "cancel",
      "pause",
      "resume",
      "retry",
      "rerun"
    ],
    "riskClass": "R2"
  },
  {
    "kind": "automation_run",
    "supports": [
      "cancel",
      "retry"
    ],
    "riskClass": "R2"
  },
  {
    "kind": "sync",
    "supports": [
      "cancel",
      "retry"
    ],
    "riskClass": "R1"
  },
  {
    "kind": "import_preview",
    "supports": [
      "cancel",
      "rerun"
    ],
    "riskClass": "R0"
  },
  {
    "kind": "import_apply",
    "supports": [
      "cancel",
      "retry"
    ],
    "riskClass": "R2"
  },
  {
    "kind": "import_rollback",
    "supports": [
      "retry"
    ],
    "riskClass": "R2"
  },
  {
    "kind": "export",
    "supports": [
      "cancel",
      "retry",
      "rerun"
    ],
    "riskClass": "R2"
  },
  {
    "kind": "bulk_edit",
    "supports": [
      "cancel"
    ],
    "riskClass": "R1"
  },
  {
    "kind": "undo",
    "supports": [],
    "riskClass": "R1"
  },
  {
    "kind": "report_run",
    "supports": [
      "retry",
      "rerun"
    ],
    "riskClass": "R0"
  },
  {
    "kind": "briefing",
    "supports": [
      "retry",
      "rerun"
    ],
    "riskClass": "R0"
  },
  {
    "kind": "brand_move",
    "supports": [],
    "riskClass": "R3"
  },
  {
    "kind": "purge",
    "supports": [
      "retry"
    ],
    "riskClass": "R4"
  },
  {
    "kind": "template_installation",
    "supports": [
      "retry"
    ],
    "riskClass": "R2"
  },
  {
    "kind": "test_ingest",
    "supports": [
      "retry"
    ],
    "riskClass": "R1"
  },
  {
    "kind": "webhook_delivery",
    "supports": [
      "retry"
    ],
    "riskClass": "R3"
  },
  {
    "kind": "proposal_apply",
    "supports": [],
    "riskClass": "R1"
  },
  {
    "kind": "workspace_deletion",
    "supports": [
      "cancel"
    ],
    "riskClass": "R4"
  },
  {
    "kind": "plan_proposal",
    "supports": [],
    "riskClass": "R0"
  }
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number]['kind'];

export const ID_PREFIXES = [
  {
    "prefix": "br",
    "resource": "brand",
    "entity": "tenancy.brand",
    "ownerModule": "tenancy",
    "platformOnly": false
  },
  {
    "prefix": "team",
    "resource": "team",
    "entity": "tenancy.team",
    "ownerModule": "tenancy",
    "platformOnly": false
  },
  {
    "prefix": "wf",
    "resource": "workflow",
    "entity": "workflow.workflow",
    "ownerModule": "workflow",
    "platformOnly": false
  },
  {
    "prefix": "file",
    "resource": "file",
    "entity": "files.file",
    "ownerModule": "files",
    "platformOnly": false
  },
  {
    "prefix": "dlv",
    "resource": "deliverable",
    "entity": "files.deliverable",
    "ownerModule": "files",
    "platformOnly": false
  },
  {
    "prefix": "prj",
    "resource": "project",
    "entity": "work.project",
    "ownerModule": "work",
    "platformOnly": false
  },
  {
    "prefix": "ms",
    "resource": "milestone",
    "entity": "work.milestone",
    "ownerModule": "work",
    "platformOnly": false
  },
  {
    "prefix": "tsk",
    "resource": "task",
    "entity": "work.task",
    "ownerModule": "work",
    "platformOnly": false
  },
  {
    "prefix": "dec",
    "resource": "decision_record",
    "entity": "work.decision_record",
    "ownerModule": "work",
    "platformOnly": false
  },
  {
    "prefix": "inb",
    "resource": "inbox_item",
    "entity": "capture.inbox_item",
    "ownerModule": "capture",
    "platformOnly": false
  },
  {
    "prefix": "note",
    "resource": "note",
    "entity": "capture.note",
    "ownerModule": "capture",
    "platformOnly": false
  },
  {
    "prefix": "form",
    "resource": "intake_form",
    "entity": "capture.intake_form",
    "ownerModule": "capture",
    "platformOnly": false
  },
  {
    "prefix": "blk",
    "resource": "work_block",
    "entity": "planning.work_block",
    "ownerModule": "planning",
    "platformOnly": false
  },
  {
    "prefix": "doc",
    "resource": "document",
    "entity": "knowledge.document",
    "ownerModule": "knowledge",
    "platformOnly": false
  },
  {
    "prefix": "goal",
    "resource": "goal",
    "entity": "goals.goal",
    "ownerModule": "goals",
    "platformOnly": false
  },
  {
    "prefix": "kr",
    "resource": "key_result",
    "entity": "goals.key_result",
    "ownerModule": "goals",
    "platformOnly": false
  },
  {
    "prefix": "pf",
    "resource": "portfolio",
    "entity": "goals.portfolio",
    "ownerModule": "goals",
    "platformOnly": false
  },
  {
    "prefix": "view",
    "resource": "saved_view",
    "entity": "views.saved_view",
    "ownerModule": "views",
    "platformOnly": false
  },
  {
    "prefix": "dash",
    "resource": "dashboard",
    "entity": "insights.dashboard",
    "ownerModule": "insights",
    "platformOnly": false
  },
  {
    "prefix": "rpt",
    "resource": "report_definition",
    "entity": "insights.report_definition",
    "ownerModule": "insights",
    "platformOnly": false
  },
  {
    "prefix": "conn",
    "resource": "connection",
    "entity": "integrations.connection",
    "ownerModule": "integrations",
    "platformOnly": false
  },
  {
    "prefix": "cnf",
    "resource": "sync_conflict",
    "entity": "integrations.sync_conflict",
    "ownerModule": "integrations",
    "platformOnly": false
  },
  {
    "prefix": "whk",
    "resource": "webhook_subscription",
    "entity": "integrations.webhook_subscription",
    "ownerModule": "integrations",
    "platformOnly": false
  },
  {
    "prefix": "tc",
    "resource": "test_case",
    "entity": "quality.test_case",
    "ownerModule": "quality",
    "platformOnly": false
  },
  {
    "prefix": "ts",
    "resource": "test_suite",
    "entity": "quality.test_suite",
    "ownerModule": "quality",
    "platformOnly": false
  },
  {
    "prefix": "tr",
    "resource": "test_run",
    "entity": "quality.test_run",
    "ownerModule": "quality",
    "platformOnly": false
  },
  {
    "prefix": "env",
    "resource": "environment",
    "entity": "delivery.environment",
    "ownerModule": "delivery",
    "platformOnly": false
  },
  {
    "prefix": "rel",
    "resource": "release",
    "entity": "delivery.release",
    "ownerModule": "delivery",
    "platformOnly": false
  },
  {
    "prefix": "tpl",
    "resource": "template",
    "entity": "templates.template",
    "ownerModule": "templates",
    "platformOnly": false
  },
  {
    "prefix": "auto",
    "resource": "automation",
    "entity": "automation.automation",
    "ownerModule": "automation",
    "platformOnly": false
  },
  {
    "prefix": "agt",
    "resource": "agent_profile",
    "entity": "agents.agent_profile",
    "ownerModule": "agents",
    "platformOnly": false
  },
  {
    "prefix": "ws",
    "resource": "workspace",
    "entity": "tenancy.workspace",
    "ownerModule": "tenancy",
    "platformOnly": false
  },
  {
    "prefix": "mem",
    "resource": "membership",
    "entity": "tenancy.membership",
    "ownerModule": "tenancy",
    "platformOnly": false
  },
  {
    "prefix": "acct",
    "resource": "account",
    "entity": "identity.account",
    "ownerModule": "identity",
    "platformOnly": false
  },
  {
    "prefix": "grt",
    "resource": "record_grant",
    "entity": "access.record_grant",
    "ownerModule": "access",
    "platformOnly": false
  },
  {
    "prefix": "cmt",
    "resource": "comment",
    "entity": "collab.comment",
    "ownerModule": "collab",
    "platformOnly": false
  },
  {
    "prefix": "rvw",
    "resource": "review_request",
    "entity": "collab.review_request",
    "ownerModule": "collab",
    "platformOnly": false
  },
  {
    "prefix": "te",
    "resource": "time_entry",
    "entity": "time.time_entry",
    "ownerModule": "time",
    "platformOnly": false
  },
  {
    "prefix": "tsh",
    "resource": "timesheet",
    "entity": "time.timesheet",
    "ownerModule": "time",
    "platformOnly": false
  },
  {
    "prefix": "res",
    "resource": "test_result",
    "entity": "quality.test_result",
    "ownerModule": "quality",
    "platformOnly": false
  },
  {
    "prefix": "op",
    "resource": "operation",
    "entity": "execution.operation",
    "ownerModule": "execution",
    "platformOnly": false
  },
  {
    "prefix": "att",
    "resource": "attempt",
    "entity": "execution.attempt",
    "ownerModule": "execution",
    "platformOnly": false
  },
  {
    "prefix": "evt",
    "resource": "event",
    "entity": null,
    "ownerModule": "execution",
    "platformOnly": true
  },
  {
    "prefix": "whd",
    "resource": "webhook_delivery",
    "entity": "integrations.webhook_delivery",
    "ownerModule": "integrations",
    "platformOnly": false
  },
  {
    "prefix": "ntf",
    "resource": "notification",
    "entity": "notify.notification",
    "ownerModule": "notify",
    "platformOnly": false
  },
  {
    "prefix": "upl",
    "resource": "upload_session",
    "entity": "files.upload_session",
    "ownerModule": "files",
    "platformOnly": false
  },
  {
    "prefix": "fv",
    "resource": "file_version",
    "entity": "files.file_version",
    "ownerModule": "files",
    "platformOnly": false
  },
  {
    "prefix": "dv",
    "resource": "deliverable_version",
    "entity": "files.deliverable_version",
    "ownerModule": "files",
    "platformOnly": false
  },
  {
    "prefix": "dcv",
    "resource": "document_version",
    "entity": "knowledge.document_version",
    "ownerModule": "knowledge",
    "platformOnly": false
  },
  {
    "prefix": "tok",
    "resource": "api_token",
    "entity": "integrations.api_token",
    "ownerModule": "integrations",
    "platformOnly": false
  },
  {
    "prefix": "oac",
    "resource": "oauth_client",
    "entity": "integrations.oauth_client",
    "ownerModule": "integrations",
    "platformOnly": false
  },
  {
    "prefix": "svc",
    "resource": "service_principal",
    "entity": "access.service_principal",
    "ownerModule": "access",
    "platformOnly": false
  },
  {
    "prefix": "shr",
    "resource": "share_group",
    "entity": "access.share_group",
    "ownerModule": "access",
    "platformOnly": false
  },
  {
    "prefix": "apr",
    "resource": "action_approval",
    "entity": "agents.action_approval",
    "ownerModule": "agents",
    "platformOnly": false
  },
  {
    "prefix": "stp",
    "resource": "step_up_challenge",
    "entity": "identity.step_up_challenge",
    "ownerModule": "identity",
    "platformOnly": false
  },
  {
    "prefix": "ses",
    "resource": "session",
    "entity": "identity.session",
    "ownerModule": "identity",
    "platformOnly": false
  },
  {
    "prefix": "mfa",
    "resource": "mfa_factor",
    "entity": "identity.mfa_factor",
    "ownerModule": "identity",
    "platformOnly": false
  },
  {
    "prefix": "oid",
    "resource": "oauth_identity",
    "entity": "identity.oauth_identity",
    "ownerModule": "identity",
    "platformOnly": false
  },
  {
    "prefix": "exf",
    "resource": "export_file",
    "entity": "transfer.export_file",
    "ownerModule": "transfer",
    "platformOnly": false
  },
  {
    "prefix": "req",
    "resource": "request",
    "entity": null,
    "ownerModule": "execution",
    "platformOnly": true
  },
  {
    "prefix": "ext",
    "resource": "external_identity",
    "entity": "integrations.external_identity",
    "ownerModule": "integrations",
    "platformOnly": false
  },
  {
    "prefix": "cev",
    "resource": "calendar_event",
    "entity": "integrations.calendar_event",
    "ownerModule": "integrations",
    "platformOnly": false
  },
  {
    "prefix": "cal",
    "resource": "calendar_source",
    "entity": "integrations.calendar_source",
    "ownerModule": "integrations",
    "platformOnly": false
  },
  {
    "prefix": "rd",
    "resource": "release_decision",
    "entity": "delivery.release_decision",
    "ownerModule": "delivery",
    "platformOnly": false
  },
  {
    "prefix": "sag",
    "resource": "support_access_grant",
    "entity": "access.support_access_grant",
    "ownerModule": "access",
    "platformOnly": false
  },
  {
    "prefix": "fpol",
    "resource": "field_policy",
    "entity": "access.field_policy",
    "ownerModule": "access",
    "platformOnly": false
  },
  {
    "prefix": "inv",
    "resource": "invitation",
    "entity": "tenancy.invitation",
    "ownerModule": "tenancy",
    "platformOnly": false
  },
  {
    "prefix": "otr",
    "resource": "ownership_transfer",
    "entity": "tenancy.ownership_transfer",
    "ownerModule": "tenancy",
    "platformOnly": false
  },
  {
    "prefix": "phs",
    "resource": "phase",
    "entity": "work.phase",
    "ownerModule": "work",
    "platformOnly": false
  },
  {
    "prefix": "sco",
    "resource": "scope_item",
    "entity": "work.scope_item",
    "ownerModule": "work",
    "platformOnly": false
  },
  {
    "prefix": "cri",
    "resource": "criteria_item",
    "entity": "work.criteria_item",
    "ownerModule": "work",
    "platformOnly": false
  },
  {
    "prefix": "pup",
    "resource": "project_update",
    "entity": "work.project_update",
    "ownerModule": "work",
    "platformOnly": false
  },
  {
    "prefix": "rcs",
    "resource": "recurrence_series",
    "entity": "planning.recurrence_series",
    "ownerModule": "planning",
    "platformOnly": false
  },
  {
    "prefix": "chk",
    "resource": "checklist_item",
    "entity": "work.checklist_item",
    "ownerModule": "work",
    "platformOnly": false
  },
  {
    "prefix": "lbl",
    "resource": "label",
    "entity": "work.label",
    "ownerModule": "work",
    "platformOnly": false
  },
  {
    "prefix": "lnk",
    "resource": "record_link",
    "entity": "relations.record_link",
    "ownerModule": "relations",
    "platformOnly": false
  },
  {
    "prefix": "sts",
    "resource": "workflow_status",
    "entity": "workflow.workflow_status",
    "ownerModule": "workflow",
    "platformOnly": false
  },
  {
    "prefix": "trn",
    "resource": "transition",
    "entity": "workflow.transition",
    "ownerModule": "workflow",
    "platformOnly": false
  },
  {
    "prefix": "wap",
    "resource": "workflow_approval",
    "entity": "workflow.approval_request",
    "ownerModule": "workflow",
    "platformOnly": false
  },
  {
    "prefix": "prp",
    "resource": "change_proposal",
    "entity": "ai.change_proposal",
    "ownerModule": "ai",
    "platformOnly": false
  },
  {
    "prefix": "bsc",
    "resource": "briefing_schedule",
    "entity": "ai.briefing_schedule",
    "ownerModule": "ai",
    "platformOnly": false
  },
  {
    "prefix": "brf",
    "resource": "briefing",
    "entity": "ai.briefing",
    "ownerModule": "ai",
    "platformOnly": false
  },
  {
    "prefix": "bco",
    "resource": "briefing_correction",
    "entity": "ai.briefing_correction",
    "ownerModule": "ai",
    "platformOnly": false
  },
  {
    "prefix": "fld",
    "resource": "field_definition",
    "entity": "workflow.field_definition",
    "ownerModule": "workflow",
    "platformOnly": false
  },
  {
    "prefix": "fop",
    "resource": "field_option",
    "entity": "workflow.field_option",
    "ownerModule": "workflow",
    "platformOnly": false
  },
  {
    "prefix": "fst",
    "resource": "field_set",
    "entity": "workflow.field_set",
    "ownerModule": "workflow",
    "platformOnly": false
  },
  {
    "prefix": "rem",
    "resource": "task_reminder",
    "entity": "planning.task_reminder",
    "ownerModule": "planning",
    "platformOnly": false
  },
  {
    "prefix": "bop",
    "resource": "bulk_operation",
    "entity": "work.bulk_operation",
    "ownerModule": "work",
    "platformOnly": false
  },
  {
    "prefix": "und",
    "resource": "undo_entry",
    "entity": "work.undo_entry",
    "ownerModule": "work",
    "platformOnly": false
  },
  {
    "prefix": "bls",
    "resource": "block_series",
    "entity": "planning.block_series",
    "ownerModule": "planning",
    "platformOnly": false
  },
  {
    "prefix": "tof",
    "resource": "time_off",
    "entity": "planning.time_off",
    "ownerModule": "planning",
    "platformOnly": false
  },
  {
    "prefix": "hol",
    "resource": "holiday",
    "entity": "planning.holiday",
    "ownerModule": "planning",
    "platformOnly": false
  },
  {
    "prefix": "rsv",
    "resource": "capacity_reservation",
    "entity": "planning.capacity_reservation",
    "ownerModule": "planning",
    "platformOnly": false
  },
  {
    "prefix": "ndl",
    "resource": "notification_delivery",
    "entity": "notify.notification_delivery",
    "ownerModule": "notify",
    "platformOnly": false
  },
  {
    "prefix": "dsg",
    "resource": "document_suggestion",
    "entity": "knowledge.document_suggestion",
    "ownerModule": "knowledge",
    "platformOnly": false
  },
  {
    "prefix": "gci",
    "resource": "goal_checkin",
    "entity": "goals.goal_checkin",
    "ownerModule": "goals",
    "platformOnly": false
  },
  {
    "prefix": "rsh",
    "resource": "report_share",
    "entity": "insights.report_share",
    "ownerModule": "insights",
    "platformOnly": false
  },
  {
    "prefix": "mci",
    "resource": "mcp_invocation",
    "entity": "integrations.mcp_invocation",
    "ownerModule": "integrations",
    "platformOnly": false
  },
  {
    "prefix": "oat",
    "resource": "oauth_access_token",
    "entity": "integrations.oauth_access_token",
    "ownerModule": "integrations",
    "platformOnly": false
  },
  {
    "prefix": "ocs",
    "resource": "oauth_consent",
    "entity": "integrations.oauth_consent",
    "ownerModule": "integrations",
    "platformOnly": false
  },
  {
    "prefix": "vcp",
    "resource": "voice_capture",
    "entity": "capture.voice_capture",
    "ownerModule": "capture",
    "platformOnly": false
  }
] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number]['prefix'];

export const INTERNAL_EVENTS = [
  {
    "type": "access.grant.created",
    "schemaVersion": 1,
    "aggregateEntity": "access.record_grant",
    "fields": [
      "record_id",
      "grantee_type",
      "level",
      "expires_at"
    ],
    "maxClass": "C1"
  },
  {
    "type": "access.grant.revoked",
    "schemaVersion": 1,
    "aggregateEntity": "access.record_grant",
    "fields": [
      "record_id",
      "grantee_type"
    ],
    "maxClass": "C1"
  },
  {
    "type": "access.role.assigned",
    "schemaVersion": 1,
    "aggregateEntity": "access.role_assignment",
    "fields": [
      "scope_type",
      "role_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "access.role.revoked",
    "schemaVersion": 1,
    "aggregateEntity": "access.role_assignment",
    "fields": [
      "scope_type"
    ],
    "maxClass": "C1"
  },
  {
    "type": "agents.action_approval.requested",
    "schemaVersion": 1,
    "aggregateEntity": "agents.action_approval",
    "fields": [
      "action_class",
      "risk_class"
    ],
    "maxClass": "C1"
  },
  {
    "type": "agents.agent_run.output_returned",
    "schemaVersion": 1,
    "aggregateEntity": "agents.agent_run",
    "fields": [
      "deliverable_version_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "ai.briefing.generated",
    "schemaVersion": 1,
    "aggregateEntity": "ai.briefing",
    "fields": [
      "kind",
      "period_key"
    ],
    "maxClass": "C1"
  },
  {
    "type": "ai.proposal.applied",
    "schemaVersion": 1,
    "aggregateEntity": "ai.change_proposal",
    "fields": [
      "applied_count",
      "failed_count"
    ],
    "maxClass": "C1"
  },
  {
    "type": "automation.automation_run.failed",
    "schemaVersion": 1,
    "aggregateEntity": "automation.automation_run",
    "fields": [
      "automation_id",
      "terminal_reason"
    ],
    "maxClass": "C1"
  },
  {
    "type": "capture.inbox.captured",
    "schemaVersion": 1,
    "aggregateEntity": "capture.inbox_item",
    "fields": [
      "source_kind",
      "intent"
    ],
    "maxClass": "C1"
  },
  {
    "type": "capture.inbox.merged",
    "schemaVersion": 1,
    "aggregateEntity": "capture.inbox_item",
    "fields": [
      "merged_count"
    ],
    "maxClass": "C1"
  },
  {
    "type": "capture.inbox.triaged",
    "schemaVersion": 1,
    "aggregateEntity": "capture.inbox_item",
    "fields": [
      "outcome",
      "converted_record_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "capture.intake.submitted",
    "schemaVersion": 1,
    "aggregateEntity": "capture.intake_form",
    "fields": [
      "inbox_item_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "capture.intake_form.created",
    "schemaVersion": 1,
    "aggregateEntity": "capture.intake_form",
    "fields": [
      "target_kind"
    ],
    "maxClass": "C1"
  },
  {
    "type": "capture.intake_form.updated",
    "schemaVersion": 1,
    "aggregateEntity": "capture.intake_form",
    "fields": [
      "state"
    ],
    "maxClass": "C1"
  },
  {
    "type": "capture.note.converted",
    "schemaVersion": 1,
    "aggregateEntity": "capture.note",
    "fields": [
      "target_kind",
      "target_record_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "capture.note.created",
    "schemaVersion": 1,
    "aggregateEntity": "capture.note",
    "fields": [
      "source_kind"
    ],
    "maxClass": "C1"
  },
  {
    "type": "collab.comment.created",
    "schemaVersion": 1,
    "aggregateEntity": "collab.comment",
    "fields": [
      "host_record_id",
      "root_comment_id",
      "mention_ids"
    ],
    "maxClass": "C1"
  },
  {
    "type": "collab.comment.deleted",
    "schemaVersion": 1,
    "aggregateEntity": "collab.comment",
    "fields": [
      "host_record_id",
      "deleted_by"
    ],
    "maxClass": "C1"
  },
  {
    "type": "collab.comment.edited",
    "schemaVersion": 1,
    "aggregateEntity": "collab.comment",
    "fields": [
      "host_record_id",
      "edit_count"
    ],
    "maxClass": "C1"
  },
  {
    "type": "collab.comment.reaction_changed",
    "schemaVersion": 1,
    "aggregateEntity": "collab.comment",
    "fields": [
      "host_record_id",
      "reaction",
      "change"
    ],
    "maxClass": "C1"
  },
  {
    "type": "collab.review.decided",
    "schemaVersion": 1,
    "aggregateEntity": "collab.review_decision",
    "fields": [
      "decision",
      "self_approval",
      "subject_ref",
      "review_state"
    ],
    "maxClass": "C1"
  },
  {
    "type": "collab.review.requested",
    "schemaVersion": 1,
    "aggregateEntity": "collab.review_request",
    "fields": [
      "subject_kind",
      "subject_ref",
      "reviewer_rule",
      "request_kind"
    ],
    "maxClass": "C1"
  },
  {
    "type": "collab.review.superseded",
    "schemaVersion": 1,
    "aggregateEntity": "collab.review_request",
    "fields": [
      "subject_kind",
      "subject_ref",
      "successor_ref"
    ],
    "maxClass": "C1"
  },
  {
    "type": "collab.review.withdrawn",
    "schemaVersion": 1,
    "aggregateEntity": "collab.review_request",
    "fields": [
      "subject_kind",
      "subject_ref",
      "reason"
    ],
    "maxClass": "C1"
  },
  {
    "type": "core.record.archived",
    "schemaVersion": 1,
    "aggregateEntity": "core.record",
    "fields": [
      "record_type",
      "archive_cause",
      "batch_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "core.record.moved_brand",
    "schemaVersion": 1,
    "aggregateEntity": "core.record",
    "fields": [
      "from_brand_id",
      "to_brand_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "core.record.purged",
    "schemaVersion": 1,
    "aggregateEntity": "core.record",
    "fields": [
      "record_type"
    ],
    "maxClass": "C1"
  },
  {
    "type": "core.record.restored",
    "schemaVersion": 1,
    "aggregateEntity": "core.record",
    "fields": [
      "record_type",
      "batch_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "core.record.trashed",
    "schemaVersion": 1,
    "aggregateEntity": "core.record",
    "fields": [
      "record_type",
      "deletion_batch_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "delivery.deployment.recorded",
    "schemaVersion": 1,
    "aggregateEntity": "delivery.deployment",
    "fields": [
      "environment_id",
      "version_label"
    ],
    "maxClass": "C1"
  },
  {
    "type": "delivery.release.decided",
    "schemaVersion": 1,
    "aggregateEntity": "delivery.release_decision",
    "fields": [
      "release_id",
      "decision",
      "sequence"
    ],
    "maxClass": "C1"
  },
  {
    "type": "execution.operation.state_changed",
    "schemaVersion": 1,
    "aggregateEntity": "execution.operation",
    "fields": [
      "kind",
      "state",
      "terminal_reason",
      "waiting_reason"
    ],
    "maxClass": "C1"
  },
  {
    "type": "files.deliverable.state_changed",
    "schemaVersion": 1,
    "aggregateEntity": "files.deliverable",
    "fields": [
      "state",
      "version_number"
    ],
    "maxClass": "C1"
  },
  {
    "type": "files.deliverable.version_submitted",
    "schemaVersion": 1,
    "aggregateEntity": "files.deliverable_version",
    "fields": [
      "deliverable_id",
      "version_number"
    ],
    "maxClass": "C1"
  },
  {
    "type": "files.file.added",
    "schemaVersion": 1,
    "aggregateEntity": "files.file",
    "fields": [
      "version_number",
      "source"
    ],
    "maxClass": "C1"
  },
  {
    "type": "files.file.scanned",
    "schemaVersion": 1,
    "aggregateEntity": "files.file_version",
    "fields": [
      "scan_state"
    ],
    "maxClass": "C1"
  },
  {
    "type": "files.file.version_added",
    "schemaVersion": 1,
    "aggregateEntity": "files.file",
    "fields": [
      "version_number",
      "source"
    ],
    "maxClass": "C1"
  },
  {
    "type": "goals.goal.checkin_recorded",
    "schemaVersion": 1,
    "aggregateEntity": "goals.goal_checkin",
    "fields": [
      "source",
      "confidence",
      "has_value"
    ],
    "maxClass": "C1"
  },
  {
    "type": "goals.goal.created",
    "schemaVersion": 1,
    "aggregateEntity": "goals.goal",
    "fields": [
      "scope",
      "period_kind",
      "progress_basis"
    ],
    "maxClass": "C1"
  },
  {
    "type": "goals.goal.link_changed",
    "schemaVersion": 1,
    "aggregateEntity": "goals.goal_link",
    "fields": [
      "change",
      "target_kind"
    ],
    "maxClass": "C1"
  },
  {
    "type": "goals.goal.status_changed",
    "schemaVersion": 1,
    "aggregateEntity": "goals.goal",
    "fields": [
      "status"
    ],
    "maxClass": "C1"
  },
  {
    "type": "goals.goal.update_stale",
    "schemaVersion": 1,
    "aggregateEntity": "goals.goal",
    "fields": [
      "days_stale"
    ],
    "maxClass": "C1"
  },
  {
    "type": "goals.goal.updated",
    "schemaVersion": 1,
    "aggregateEntity": "goals.goal",
    "fields": [
      "change"
    ],
    "maxClass": "C1"
  },
  {
    "type": "goals.key_result.created",
    "schemaVersion": 1,
    "aggregateEntity": "goals.key_result",
    "fields": [
      "progress_basis"
    ],
    "maxClass": "C1"
  },
  {
    "type": "goals.key_result.updated",
    "schemaVersion": 1,
    "aggregateEntity": "goals.key_result",
    "fields": [
      "change"
    ],
    "maxClass": "C1"
  },
  {
    "type": "goals.portfolio.created",
    "schemaVersion": 1,
    "aggregateEntity": "goals.portfolio",
    "fields": [
      "scope"
    ],
    "maxClass": "C1"
  },
  {
    "type": "goals.portfolio.members_changed",
    "schemaVersion": 1,
    "aggregateEntity": "goals.portfolio",
    "fields": [
      "count"
    ],
    "maxClass": "C1"
  },
  {
    "type": "goals.portfolio.updated",
    "schemaVersion": 1,
    "aggregateEntity": "goals.portfolio",
    "fields": [
      "change"
    ],
    "maxClass": "C1"
  },
  {
    "type": "insights.dashboard.created",
    "schemaVersion": 1,
    "aggregateEntity": "insights.dashboard",
    "fields": [
      "kind",
      "scope"
    ],
    "maxClass": "C1"
  },
  {
    "type": "insights.dashboard.updated",
    "schemaVersion": 1,
    "aggregateEntity": "insights.dashboard",
    "fields": [
      "change"
    ],
    "maxClass": "C1"
  },
  {
    "type": "insights.report.created",
    "schemaVersion": 1,
    "aggregateEntity": "insights.report_definition",
    "fields": [
      "scope"
    ],
    "maxClass": "C1"
  },
  {
    "type": "insights.report.resumed",
    "schemaVersion": 1,
    "aggregateEntity": "insights.report_definition",
    "fields": [
      "reason"
    ],
    "maxClass": "C1"
  },
  {
    "type": "insights.report.schedule_changed",
    "schemaVersion": 1,
    "aggregateEntity": "insights.report_definition",
    "fields": [
      "frequency",
      "recipients"
    ],
    "maxClass": "C1"
  },
  {
    "type": "insights.report.share_revoked",
    "schemaVersion": 1,
    "aggregateEntity": "insights.report_definition",
    "fields": [
      "scope"
    ],
    "maxClass": "C1"
  },
  {
    "type": "insights.report.shared",
    "schemaVersion": 1,
    "aggregateEntity": "insights.report_definition",
    "fields": [
      "scope"
    ],
    "maxClass": "C1"
  },
  {
    "type": "insights.report.suspended",
    "schemaVersion": 1,
    "aggregateEntity": "insights.report_definition",
    "fields": [
      "reason"
    ],
    "maxClass": "C1"
  },
  {
    "type": "insights.report.updated",
    "schemaVersion": 1,
    "aggregateEntity": "insights.report_definition",
    "fields": [
      "change"
    ],
    "maxClass": "C1"
  },
  {
    "type": "integrations.api_token.created",
    "schemaVersion": 1,
    "aggregateEntity": "integrations.api_token",
    "fields": [
      "kind",
      "scope_count"
    ],
    "maxClass": "C1"
  },
  {
    "type": "integrations.api_token.revoked",
    "schemaVersion": 1,
    "aggregateEntity": "integrations.api_token",
    "fields": [
      "kind"
    ],
    "maxClass": "C1"
  },
  {
    "type": "integrations.api_token.rotated",
    "schemaVersion": 1,
    "aggregateEntity": "integrations.api_token",
    "fields": [
      "kind"
    ],
    "maxClass": "C1"
  },
  {
    "type": "integrations.conflict.detected",
    "schemaVersion": 1,
    "aggregateEntity": "integrations.connection",
    "fields": [
      "field"
    ],
    "maxClass": "C1"
  },
  {
    "type": "integrations.conflict.resolved",
    "schemaVersion": 1,
    "aggregateEntity": "integrations.connection",
    "fields": [
      "resolution"
    ],
    "maxClass": "C1"
  },
  {
    "type": "integrations.connection.created",
    "schemaVersion": 1,
    "aggregateEntity": "integrations.connection",
    "fields": [
      "provider",
      "auth_kind",
      "scope"
    ],
    "maxClass": "C1"
  },
  {
    "type": "integrations.connection.disconnected",
    "schemaVersion": 1,
    "aggregateEntity": "integrations.connection",
    "fields": [
      "retention"
    ],
    "maxClass": "C1"
  },
  {
    "type": "integrations.connection.health_changed",
    "schemaVersion": 1,
    "aggregateEntity": "integrations.connection",
    "fields": [
      "health"
    ],
    "maxClass": "C1"
  },
  {
    "type": "integrations.connection.reauthorized",
    "schemaVersion": 1,
    "aggregateEntity": "integrations.connection",
    "fields": [
      "auth_kind"
    ],
    "maxClass": "C1"
  },
  {
    "type": "integrations.credential.rotated",
    "schemaVersion": 1,
    "aggregateEntity": "integrations.connection",
    "fields": [
      "key_version"
    ],
    "maxClass": "C1"
  },
  {
    "type": "integrations.sync.completed",
    "schemaVersion": 1,
    "aggregateEntity": "integrations.connection",
    "fields": [
      "outcome",
      "conflicts"
    ],
    "maxClass": "C1"
  },
  {
    "type": "integrations.sync.failed",
    "schemaVersion": 1,
    "aggregateEntity": "integrations.sync_run",
    "fields": [
      "connection_id",
      "terminal_reason"
    ],
    "maxClass": "C1"
  },
  {
    "type": "integrations.webhook.delivery_failed",
    "schemaVersion": 1,
    "aggregateEntity": "integrations.webhook_delivery",
    "fields": [
      "subscription_id",
      "attempt"
    ],
    "maxClass": "C1"
  },
  {
    "type": "knowledge.document.created",
    "schemaVersion": 1,
    "aggregateEntity": "knowledge.document",
    "fields": [
      "doc_type",
      "parent_document_id",
      "attached_kind"
    ],
    "maxClass": "C1"
  },
  {
    "type": "knowledge.document.mention_added",
    "schemaVersion": 1,
    "aggregateEntity": "knowledge.document",
    "fields": [
      "reference_id",
      "block_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "knowledge.document.source_approved",
    "schemaVersion": 1,
    "aggregateEntity": "knowledge.source_approval",
    "fields": [
      "document_version_id",
      "kind"
    ],
    "maxClass": "C1"
  },
  {
    "type": "knowledge.document.suggestion_created",
    "schemaVersion": 1,
    "aggregateEntity": "knowledge.document_suggestion",
    "fields": [
      "document_id",
      "block_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "knowledge.document.suggestion_decided",
    "schemaVersion": 1,
    "aggregateEntity": "knowledge.document_suggestion",
    "fields": [
      "document_id",
      "state",
      "applied_version"
    ],
    "maxClass": "C1"
  },
  {
    "type": "knowledge.document.updated",
    "schemaVersion": 1,
    "aggregateEntity": "knowledge.document",
    "fields": [
      "change"
    ],
    "maxClass": "C1"
  },
  {
    "type": "knowledge.document.version_saved",
    "schemaVersion": 1,
    "aggregateEntity": "knowledge.document",
    "fields": [
      "version_number",
      "kind",
      "size_bytes"
    ],
    "maxClass": "C1"
  },
  {
    "type": "metering.usage.limit_reached",
    "schemaVersion": 1,
    "aggregateEntity": "metering.usage_balance",
    "fields": [
      "meter"
    ],
    "maxClass": "C1"
  },
  {
    "type": "metering.usage.threshold_reached",
    "schemaVersion": 1,
    "aggregateEntity": "metering.usage_balance",
    "fields": [
      "meter",
      "threshold_bp"
    ],
    "maxClass": "C1"
  },
  {
    "type": "notify.delivery.state_changed",
    "schemaVersion": 1,
    "aggregateEntity": "notify.notification_delivery",
    "fields": [
      "channel",
      "kind",
      "state",
      "failure_class"
    ],
    "maxClass": "C1"
  },
  {
    "type": "notify.notification.created",
    "schemaVersion": 1,
    "aggregateEntity": "notify.notification",
    "fields": [
      "type",
      "record_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.block_series.defined",
    "schemaVersion": 1,
    "aggregateEntity": "planning.block_series",
    "fields": [
      "occurrences"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.block_series.ended",
    "schemaVersion": 1,
    "aggregateEntity": "planning.block_series",
    "fields": [
      "removed"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.capacity_profile.updated",
    "schemaVersion": 1,
    "aggregateEntity": "planning.capacity_profile",
    "fields": [
      "windows",
      "weekly_capacity_minutes",
      "observe_brand_holidays"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.capacity_reservation.removed",
    "schemaVersion": 1,
    "aggregateEntity": "planning.capacity_reservation",
    "fields": [
      "effective_from"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.capacity_reservation.set",
    "schemaVersion": 1,
    "aggregateEntity": "planning.capacity_reservation",
    "fields": [
      "minutes_per_week",
      "effective_from",
      "effective_to"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.day.closed",
    "schemaVersion": 1,
    "aggregateEntity": "planning.daily_record",
    "fields": [
      "day",
      "closed_by",
      "committed",
      "completed"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.holiday.created",
    "schemaVersion": 1,
    "aggregateEntity": "planning.holiday",
    "fields": [
      "day"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.holiday.deleted",
    "schemaVersion": 1,
    "aggregateEntity": "planning.holiday",
    "fields": [
      "day"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.occurrence.generated",
    "schemaVersion": 1,
    "aggregateEntity": "planning.recurrence_series",
    "fields": [
      "occurrence_key",
      "record_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.recurrence_series.defined",
    "schemaVersion": 1,
    "aggregateEntity": "planning.recurrence_series",
    "fields": [
      "target_kind"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.recurrence_series.state_changed",
    "schemaVersion": 1,
    "aggregateEntity": "planning.recurrence_series",
    "fields": [
      "state"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.task_reminder.fired",
    "schemaVersion": 1,
    "aggregateEntity": "planning.task_reminder",
    "fields": [
      "task_id",
      "account_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.task_reminder.scheduled",
    "schemaVersion": 1,
    "aggregateEntity": "planning.task_reminder",
    "fields": [
      "task_id",
      "state"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.time_off.created",
    "schemaVersion": 1,
    "aggregateEntity": "planning.time_off",
    "fields": [
      "kind",
      "all_day",
      "days"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.time_off.deleted",
    "schemaVersion": 1,
    "aggregateEntity": "planning.time_off",
    "fields": [
      "kind"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.time_off.updated",
    "schemaVersion": 1,
    "aggregateEntity": "planning.time_off",
    "fields": [
      "kind",
      "all_day",
      "days"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.today.changed",
    "schemaVersion": 1,
    "aggregateEntity": "planning.today_commitment",
    "fields": [
      "day",
      "change"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.today.committed",
    "schemaVersion": 1,
    "aggregateEntity": "planning.today_commitment",
    "fields": [
      "day",
      "source"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.work_block.created",
    "schemaVersion": 1,
    "aggregateEntity": "planning.work_block",
    "fields": [
      "source",
      "focus"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.work_block.deleted",
    "schemaVersion": 1,
    "aggregateEntity": "planning.work_block",
    "fields": [
      "source"
    ],
    "maxClass": "C1"
  },
  {
    "type": "planning.work_block.moved",
    "schemaVersion": 1,
    "aggregateEntity": "planning.work_block",
    "fields": [
      "starts_at",
      "ends_at",
      "source"
    ],
    "maxClass": "C1"
  },
  {
    "type": "quality.defect.verified",
    "schemaVersion": 1,
    "aggregateEntity": "quality.verification_record",
    "fields": [
      "defect_task_id",
      "method"
    ],
    "maxClass": "C1"
  },
  {
    "type": "quality.test_result.recorded",
    "schemaVersion": 1,
    "aggregateEntity": "quality.test_result",
    "fields": [
      "test_run_id",
      "outcome"
    ],
    "maxClass": "C1"
  },
  {
    "type": "relations.follow.added",
    "schemaVersion": 1,
    "aggregateEntity": "relations.follower",
    "fields": [
      "record_type",
      "membership_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "relations.follow.removed",
    "schemaVersion": 1,
    "aggregateEntity": "relations.follower",
    "fields": [
      "record_type",
      "membership_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "relations.mention.created",
    "schemaVersion": 1,
    "aggregateEntity": "relations.mention",
    "fields": [
      "source_kind",
      "target_kind",
      "target_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "relations.relationship.created",
    "schemaVersion": 1,
    "aggregateEntity": "relations.record_relationship",
    "fields": [
      "kind",
      "from_record_id",
      "to_record_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "relations.relationship.removed",
    "schemaVersion": 1,
    "aggregateEntity": "relations.record_relationship",
    "fields": [
      "kind",
      "from_record_id",
      "to_record_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "templates.template.applied",
    "schemaVersion": 1,
    "aggregateEntity": "templates.template",
    "fields": [
      "template_version_id",
      "record_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "templates.template.created",
    "schemaVersion": 1,
    "aggregateEntity": "templates.template",
    "fields": [
      "target_record_type",
      "item_count"
    ],
    "maxClass": "C1"
  },
  {
    "type": "templates.template.installed",
    "schemaVersion": 1,
    "aggregateEntity": "templates.template_installation",
    "fields": [
      "template_version_id",
      "sample"
    ],
    "maxClass": "C1"
  },
  {
    "type": "templates.template.versioned",
    "schemaVersion": 1,
    "aggregateEntity": "templates.template",
    "fields": [
      "target_record_type",
      "version",
      "item_count"
    ],
    "maxClass": "C1"
  },
  {
    "type": "tenancy.membership.activated",
    "schemaVersion": 1,
    "aggregateEntity": "tenancy.membership",
    "fields": [
      "kind",
      "reason"
    ],
    "maxClass": "C1"
  },
  {
    "type": "tenancy.membership.removed",
    "schemaVersion": 1,
    "aggregateEntity": "tenancy.membership",
    "fields": [
      "reason"
    ],
    "maxClass": "C1"
  },
  {
    "type": "tenancy.membership.suspended",
    "schemaVersion": 1,
    "aggregateEntity": "tenancy.membership",
    "fields": [
      "reason"
    ],
    "maxClass": "C1"
  },
  {
    "type": "tenancy.ownership.transferred",
    "schemaVersion": 1,
    "aggregateEntity": "tenancy.ownership_transfer",
    "fields": [
      "demoted_previous"
    ],
    "maxClass": "C1"
  },
  {
    "type": "tenancy.team.membership_changed",
    "schemaVersion": 1,
    "aggregateEntity": "tenancy.team_member",
    "fields": [
      "change"
    ],
    "maxClass": "C1"
  },
  {
    "type": "time.time_entry.deleted",
    "schemaVersion": 1,
    "aggregateEntity": "time.time_entry",
    "fields": [
      "duration_seconds"
    ],
    "maxClass": "C1"
  },
  {
    "type": "time.time_entry.recorded",
    "schemaVersion": 1,
    "aggregateEntity": "time.time_entry",
    "fields": [
      "duration_seconds",
      "billable",
      "source"
    ],
    "maxClass": "C1"
  },
  {
    "type": "time.time_entry.updated",
    "schemaVersion": 1,
    "aggregateEntity": "time.time_entry",
    "fields": [
      "duration_seconds",
      "billable"
    ],
    "maxClass": "C1"
  },
  {
    "type": "time.timer.auto_stopped",
    "schemaVersion": 1,
    "aggregateEntity": "time.time_entry",
    "fields": [
      "duration_seconds"
    ],
    "maxClass": "C1"
  },
  {
    "type": "time.timesheet.approved",
    "schemaVersion": 1,
    "aggregateEntity": "time.timesheet_approval",
    "fields": [
      "period_start",
      "brand_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "time.timesheet.rejected",
    "schemaVersion": 1,
    "aggregateEntity": "time.timesheet_approval",
    "fields": [
      "period_start",
      "brand_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "time.timesheet.submitted",
    "schemaVersion": 1,
    "aggregateEntity": "time.timesheet",
    "fields": [
      "period_start",
      "lines"
    ],
    "maxClass": "C1"
  },
  {
    "type": "time.timesheet.unlocked",
    "schemaVersion": 1,
    "aggregateEntity": "time.period_lock",
    "fields": [
      "period_start",
      "brand_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "time.timesheet.withdrawn",
    "schemaVersion": 1,
    "aggregateEntity": "time.timesheet",
    "fields": [
      "period_start"
    ],
    "maxClass": "C1"
  },
  {
    "type": "transfer.export.ready",
    "schemaVersion": 1,
    "aggregateEntity": "transfer.export_job",
    "fields": [
      "format"
    ],
    "maxClass": "C1"
  },
  {
    "type": "views.default.changed",
    "schemaVersion": 1,
    "aggregateEntity": "views.view_default",
    "fields": [
      "target",
      "entity",
      "cleared"
    ],
    "maxClass": "C1"
  },
  {
    "type": "views.pin.changed",
    "schemaVersion": 1,
    "aggregateEntity": "views.view_pin",
    "fields": [
      "scope",
      "pinned"
    ],
    "maxClass": "C1"
  },
  {
    "type": "views.saved_view.created",
    "schemaVersion": 1,
    "aggregateEntity": "views.saved_view",
    "fields": [
      "entity",
      "visibility"
    ],
    "maxClass": "C1"
  },
  {
    "type": "views.saved_view.deleted",
    "schemaVersion": 1,
    "aggregateEntity": "views.saved_view",
    "fields": [
      "entity"
    ],
    "maxClass": "C1"
  },
  {
    "type": "views.saved_view.shared",
    "schemaVersion": 1,
    "aggregateEntity": "views.saved_view",
    "fields": [
      "entity",
      "scope"
    ],
    "maxClass": "C1"
  },
  {
    "type": "views.saved_view.unshared",
    "schemaVersion": 1,
    "aggregateEntity": "views.saved_view",
    "fields": [
      "entity"
    ],
    "maxClass": "C1"
  },
  {
    "type": "views.saved_view.updated",
    "schemaVersion": 1,
    "aggregateEntity": "views.saved_view",
    "fields": [
      "entity",
      "visibility"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.bulk_operation.executed",
    "schemaVersion": 1,
    "aggregateEntity": "work.bulk_operation",
    "fields": [
      "operation",
      "mode",
      "item_count",
      "succeeded",
      "failed"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.decision_record.created",
    "schemaVersion": 1,
    "aggregateEntity": "work.decision_record",
    "fields": [
      "project_id",
      "kind",
      "state"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.decision_record.state_changed",
    "schemaVersion": 1,
    "aggregateEntity": "work.decision_record",
    "fields": [
      "kind",
      "state"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.label.created",
    "schemaVersion": 1,
    "aggregateEntity": "work.label",
    "fields": [
      "label_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.label.updated",
    "schemaVersion": 1,
    "aggregateEntity": "work.label",
    "fields": [
      "label_id",
      "lifecycle_state"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.milestone.created",
    "schemaVersion": 1,
    "aggregateEntity": "work.milestone",
    "fields": [
      "project_id",
      "phase_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.milestone.updated",
    "schemaVersion": 1,
    "aggregateEntity": "work.milestone",
    "fields": [
      "project_id",
      "status",
      "changed_fields"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.phase.created",
    "schemaVersion": 1,
    "aggregateEntity": "work.phase",
    "fields": [
      "project_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.phase.updated",
    "schemaVersion": 1,
    "aggregateEntity": "work.phase",
    "fields": [
      "project_id",
      "changed_fields"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.project.created",
    "schemaVersion": 1,
    "aggregateEntity": "work.project",
    "fields": [
      "parent_project_id",
      "status_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.project.moved",
    "schemaVersion": 1,
    "aggregateEntity": "work.project",
    "fields": [
      "parent_project_id",
      "depth"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.project.owner_changed",
    "schemaVersion": 1,
    "aggregateEntity": "work.project",
    "fields": [
      "owner_membership_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.project.status_changed",
    "schemaVersion": 1,
    "aggregateEntity": "work.project",
    "fields": [
      "to_category",
      "health"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.project.updated",
    "schemaVersion": 1,
    "aggregateEntity": "work.project",
    "fields": [
      "changed_fields"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.project_update.posted",
    "schemaVersion": 1,
    "aggregateEntity": "work.project_update",
    "fields": [
      "project_id",
      "source_kind",
      "health"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.project_update.verified",
    "schemaVersion": 1,
    "aggregateEntity": "work.project_update",
    "fields": [
      "project_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.task.assigned",
    "schemaVersion": 1,
    "aggregateEntity": "work.task",
    "fields": [
      "assignee_membership_ids"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.task.completed",
    "schemaVersion": 1,
    "aggregateEntity": "work.task",
    "fields": [
      "completed_at",
      "status_category",
      "project_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.task.created",
    "schemaVersion": 1,
    "aggregateEntity": "work.task",
    "fields": [
      "project_id",
      "parent_task_id",
      "status_id",
      "source_kind"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.task.delegated",
    "schemaVersion": 1,
    "aggregateEntity": "work.task",
    "fields": [
      "from_membership_id",
      "to_membership_id"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.task.moved",
    "schemaVersion": 1,
    "aggregateEntity": "work.task",
    "fields": [
      "project_id",
      "parent_task_id",
      "depth"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.task.reopened",
    "schemaVersion": 1,
    "aggregateEntity": "work.task",
    "fields": [
      "status_id",
      "status_category"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.task.status_changed",
    "schemaVersion": 1,
    "aggregateEntity": "work.task",
    "fields": [
      "from_status_id",
      "to_status_id",
      "to_category"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.task.undone",
    "schemaVersion": 1,
    "aggregateEntity": "work.task",
    "fields": [
      "task_id",
      "command"
    ],
    "maxClass": "C1"
  },
  {
    "type": "work.task.updated",
    "schemaVersion": 1,
    "aggregateEntity": "work.task",
    "fields": [
      "changed_fields"
    ],
    "maxClass": "C1"
  },
  {
    "type": "workflow.approval_request.closed",
    "schemaVersion": 1,
    "aggregateEntity": "workflow.approval_request",
    "fields": [
      "closed_reason"
    ],
    "maxClass": "C1"
  },
  {
    "type": "workflow.approval_request.created",
    "schemaVersion": 1,
    "aggregateEntity": "workflow.approval_request",
    "fields": [
      "transition_id",
      "policy",
      "record_type"
    ],
    "maxClass": "C1"
  },
  {
    "type": "workflow.approval_request.decided",
    "schemaVersion": 1,
    "aggregateEntity": "workflow.approval_request",
    "fields": [
      "decision",
      "state"
    ],
    "maxClass": "C1"
  },
  {
    "type": "workflow.field_definition.created",
    "schemaVersion": 1,
    "aggregateEntity": "workflow.field_definition",
    "fields": [
      "field_type",
      "scope_kind"
    ],
    "maxClass": "C1"
  },
  {
    "type": "workflow.field_definition.updated",
    "schemaVersion": 1,
    "aggregateEntity": "workflow.field_definition",
    "fields": [
      "changed_fields",
      "lifecycle_state"
    ],
    "maxClass": "C1"
  },
  {
    "type": "workflow.field_set.applied",
    "schemaVersion": 1,
    "aggregateEntity": "workflow.field_set",
    "fields": [
      "record_type",
      "version"
    ],
    "maxClass": "C1"
  },
  {
    "type": "workflow.field_set.versioned",
    "schemaVersion": 1,
    "aggregateEntity": "workflow.field_set",
    "fields": [
      "version"
    ],
    "maxClass": "C1"
  },
  {
    "type": "workflow.field_value.changed",
    "schemaVersion": 1,
    "aggregateEntity": "workflow.field_value",
    "fields": [
      "record_type",
      "definition_ids"
    ],
    "maxClass": "C1"
  },
  {
    "type": "workflow.status.created",
    "schemaVersion": 1,
    "aggregateEntity": "workflow.workflow_status",
    "fields": [
      "workflow_id",
      "category"
    ],
    "maxClass": "C1"
  },
  {
    "type": "workflow.status.updated",
    "schemaVersion": 1,
    "aggregateEntity": "workflow.workflow_status",
    "fields": [
      "workflow_id",
      "changed_fields",
      "lifecycle_state"
    ],
    "maxClass": "C1"
  },
  {
    "type": "workflow.transition.created",
    "schemaVersion": 1,
    "aggregateEntity": "workflow.transition",
    "fields": [
      "workflow_id",
      "approval_policy"
    ],
    "maxClass": "C1"
  },
  {
    "type": "workflow.transition.updated",
    "schemaVersion": 1,
    "aggregateEntity": "workflow.transition",
    "fields": [
      "workflow_id",
      "changed_fields",
      "lifecycle_state"
    ],
    "maxClass": "C1"
  },
  {
    "type": "workflow.workflow.created",
    "schemaVersion": 1,
    "aggregateEntity": "workflow.workflow",
    "fields": [
      "record_kind",
      "scope_kind"
    ],
    "maxClass": "C1"
  },
  {
    "type": "workflow.workflow.updated",
    "schemaVersion": 1,
    "aggregateEntity": "workflow.workflow",
    "fields": [
      "changed_fields",
      "lifecycle_state"
    ],
    "maxClass": "C1"
  },
  {
    "type": "integrations.oauth_client.created",
    "schemaVersion": 1,
    "aggregateEntity": "integrations.oauth_client",
    "fields": [
      "scope_count"
    ],
    "maxClass": "C1"
  },
  {
    "type": "integrations.oauth_client.revoked",
    "schemaVersion": 1,
    "aggregateEntity": "integrations.oauth_client",
    "fields": [],
    "maxClass": "C1"
  },
  {
    "type": "integrations.oauth_consent.granted",
    "schemaVersion": 1,
    "aggregateEntity": "integrations.oauth_consent",
    "fields": [
      "scope_count",
      "brand_count"
    ],
    "maxClass": "C1"
  },
  {
    "type": "integrations.oauth_consent.revoked",
    "schemaVersion": 1,
    "aggregateEntity": "integrations.oauth_consent",
    "fields": [],
    "maxClass": "C1"
  },
  {
    "type": "integrations.oauth_access_token.issued",
    "schemaVersion": 1,
    "aggregateEntity": "integrations.oauth_access_token",
    "fields": [
      "expires_in"
    ],
    "maxClass": "C1"
  }
] as const;
export type InternalEventType = (typeof INTERNAL_EVENTS)[number]['type'];

export const PARAMETER_NAMES = [
  "ACTIVITY_RECORDS_MAX",
  "API_EXPORT_RATE_PER_MINUTE",
  "API_READ_RATE_PER_MINUTE",
  "API_TOKENS_PERSONAL_MAX",
  "API_TOKENS_SERVICE_MAX",
  "API_WRITE_RATE_PER_MINUTE",
  "APPROVAL_EXPIRY_HOURS",
  "ATOMIC_BULK_LIMIT",
  "AVAILABILITY_WINDOWS_MAX",
  "BLOCK_SERIES_HORIZON_DAYS",
  "BLOCK_SERIES_MAX",
  "BRAND_HOLIDAYS_MAX",
  "BRAND_LABELS_MAX",
  "BULK_ITEMS_MAX",
  "BULK_PREVIEW_TTL_SECONDS",
  "BULK_SYNC_LIMIT",
  "CAPACITY_PEOPLE_MAX",
  "CAPACITY_RANGE_DAYS_MAX",
  "CAPTURE_FILES_MAX",
  "CAPTURE_LINKS_MAX",
  "CAPTURE_PARSE_TOKENS_MAX",
  "CAPTURE_PASTE_LINES_MAX",
  "CAPTURE_RATE_PER_MINUTE",
  "CAPTURE_TEXT_MAX",
  "COMMENTS_PER_RECORD_MAX",
  "COMMENT_BODY_MAX_CHARS",
  "COMMENT_EDIT_WINDOW_MINUTES",
  "COMMENT_MENTIONS_MAX",
  "COMMENT_RATE_PER_MINUTE",
  "COMMENT_REPLIES_INLINE_MAX",
  "CONNECTIONS_PER_SCOPE_MAX",
  "CONNECTION_SCOPES_MAX",
  "DASHBOARDS_PER_SCOPE_MAX",
  "DASHBOARD_PERSONAL_MAX",
  "DASHBOARD_WIDGETS_MAX",
  "DAY_CLOSE_BATCH_MAX",
  "DAY_CLOSE_DISCOVERY_MAX",
  "DELIVERABLES_PER_TASK_MAX",
  "DEPRECATION_NOTICE_PERIOD",
  "DOCUMENT_BLOCKS_MAX",
  "DOCUMENT_BLOCK_TEXT_MAX_CHARS",
  "DOCUMENT_BODY_MAX_BYTES",
  "DOCUMENT_CHILDREN_MAX",
  "DOCUMENT_DEPTH_MAX",
  "DOCUMENT_EMBED_URL_MAX_CHARS",
  "DOCUMENT_EXPORT_MAX_BYTES",
  "DOCUMENT_EXPORT_PAGES_MAX",
  "DOCUMENT_REFERENCES_MAX",
  "DOCUMENT_REVIEW_HORIZON_DAYS",
  "DOCUMENT_SAVE_RATE_PER_MINUTE",
  "DOCUMENT_SUGGESTIONS_OPEN_MAX",
  "DOCUMENT_TABLE_CELLS_MAX",
  "DOCUMENT_TREE_MAX",
  "DOCUMENT_VERSIONS_MAX",
  "DUPLICATE_CANDIDATES_MAX",
  "DUPLICATE_WINDOW_DAYS",
  "EXPORT_LINK_LIFETIME",
  "EXPORT_ROWS_MAX",
  "FAVORITES_MAX",
  "FIELD_DEFINITIONS_MAX",
  "FIELD_OPTIONS_MAX",
  "FIELD_PATTERN_MAX",
  "FIELD_SETS_MAX",
  "FIELD_SET_ITEMS_MAX",
  "FIELD_TEXT_MAX",
  "FIELD_VALUE_BULK_MAX",
  "FILES_LIST_MAX",
  "FILE_COMPARE_MAX_BYTES",
  "FILE_DISCOVERY_MAX",
  "FILE_EXPIRY_BATCH_MAX",
  "FILE_SCAN_MAX_ATTEMPTS",
  "FILE_UPLOAD_MAX_BYTES",
  "FILE_VERSIONS_MAX",
  "FOLLOWERS_LIST_MAX",
  "FORMULA_AST_NODES_MAX",
  "FORMULA_DEPTH_MAX",
  "FORMULA_REFS_MAX",
  "FORMULA_SOURCE_MAX",
  "GOALS_EXPORT_ROWS_MAX",
  "GOALS_PER_SCOPE_MAX",
  "GOALS_RECALC_BATCH_MAX",
  "GOALS_RECALC_INTERVAL_MINUTES",
  "GOALS_RECALC_LEASE_SECONDS",
  "GOALS_RECALC_MAX_ATTEMPTS",
  "GOAL_CHECKIN_RATE_PER_MINUTE",
  "GOAL_KEY_RESULTS_MAX",
  "GOAL_LINKS_MAX",
  "GOAL_UPDATE_STALE_DAYS",
  "IDEMPOTENCY_RETENTION",
  "IMPORT_ROLLBACK_PERIOD",
  "INBOX_MERGE_MAX",
  "INTAKE_FORMS_MAX",
  "INTAKE_SUBMISSIONS_PER_HOUR",
  "INTEGRATION_LOOPBACK_ENABLED",
  "INVITATION_LIFETIME",
  "JOB_BACKOFF_BASE",
  "JOB_BACKOFF_CAP",
  "JOB_HEARTBEAT_INTERVAL",
  "JOB_LEASE_DURATION",
  "JOB_MAX_ATTEMPTS",
  "JOB_TIMEOUT",
  "LAYOUT_ITEMS_MAX",
  "LIVE_EDITING_ENABLED",
  "LIVE_OPS_BATCH_MAX",
  "LIVE_OP_LOG_MAX",
  "LIVE_POLL_WAIT_SECONDS",
  "LIVE_RATE_PER_MINUTE",
  "LIVE_SESSIONS_MAX",
  "LIVE_SESSIONS_PER_MEMBER_MAX",
  "LIVE_SESSION_TTL_SECONDS",
  "MCP_ENABLED",
  "MCP_READ_RATE_PER_MINUTE",
  "MCP_TOOL_CALL_TIMEOUT_MS",
  "MCP_TOOL_RESULT_MAX_BYTES",
  "MCP_WRITE_RATE_PER_MINUTE",
  "METRICS_DEFAULT_WINDOW_DAYS",
  "METRICS_DRILL_PAGE_MAX",
  "METRICS_DRILL_RESULTS_MAX",
  "METRICS_RATE_PER_MINUTE",
  "METRICS_RECONCILE_BACKOFF_SECONDS",
  "METRICS_RECONCILE_BATCH_MAX",
  "METRICS_RECONCILE_DISCOVERY_MAX",
  "METRICS_RECONCILE_INTERVAL_MINUTES",
  "METRICS_RECONCILE_LEASE_SECONDS",
  "METRICS_RECONCILE_MAX_ATTEMPTS",
  "METRICS_SAMPLE_MIN",
  "METRICS_SCOPE_TASKS_MAX",
  "METRICS_WINDOW_DAYS_MAX",
  "NOTIFY_BROWSER_ACK_TTL_MINUTES",
  "NOTIFY_BULK_STATE_MAX",
  "NOTIFY_DEADLINES_BATCH_MAX",
  "NOTIFY_DEDUPE_WINDOW_MINUTES",
  "NOTIFY_DELIVERY_BATCH_MAX",
  "NOTIFY_DELIVERY_MAX_ATTEMPTS",
  "NOTIFY_DIGEST_ITEMS_MAX",
  "NOTIFY_DISCOVERY_MAX",
  "NOTIFY_EMAIL_PER_HOUR_MAX",
  "NOTIFY_FACTS_MAX_BYTES",
  "NOTIFY_FANOUT_RECIPIENTS_MAX",
  "NOTIFY_PREFERENCES_MAX",
  "NOTIFY_RETENTION_DAYS",
  "NOTIFY_RETRY_BASE_SECONDS",
  "NOTIFY_RETRY_MAX_SECONDS",
  "NOTIFY_SEARCH_QUERY_MAX",
  "OAUTH_CLIENTS_MAX",
  "OUTBOX_REPLAY_WINDOW",
  "OWNERSHIP_TRANSFER_LIFETIME",
  "PAGE_LIMIT_DEFAULT",
  "PAGE_LIMIT_MAX",
  "PORTFOLIOS_MAX",
  "PORTFOLIO_PROJECTS_MAX",
  "PORTFOLIO_READ_PROJECTS_MAX",
  "PRINCIPAL_CONTEXT_ARRAY_MAX",
  "PROJECT_DEPTH_MAX",
  "QUERY_CONDITIONS_MAX",
  "QUERY_DEPTH_MAX",
  "QUERY_GROUPS_MAX",
  "QUERY_SORTS_MAX",
  "QUERY_VALUES_MAX",
  "RATE_LIMIT_POLICIES",
  "RECENT_ITEMS_MAX",
  "RECENT_VISIT_COALESCE",
  "RECURRENCE_CATCHUP_MAX",
  "RECURRENCE_SERIES_DISCOVERY_MAX",
  "RECURRENCE_WORKSPACE_DISCOVERY_MAX",
  "REMINDER_FIRE_BATCH_MAX",
  "REPORTS_PER_SCOPE_MAX",
  "REPORT_BATCH_MAX",
  "REPORT_EMAIL_ROWS_MAX",
  "REPORT_EXPORT_RATE_PER_MINUTE",
  "REPORT_EXPORT_ROWS_MAX",
  "REPORT_FRESHNESS_MINUTES",
  "REPORT_LEASE_SECONDS",
  "REPORT_MAX_ATTEMPTS",
  "REPORT_RECIPIENTS_MAX",
  "REPORT_RUN_RETENTION_DAYS",
  "REPORT_SHARES_MAX",
  "REVIEW_REVIEWERS_MAX",
  "SAVED_VIEWS_MAX",
  "SEARCH_BODY_MAX_CHARS",
  "SEARCH_COUNT_MAX",
  "SEARCH_FAILED_RETRY_MINUTES",
  "SEARCH_INDEX_BACKOFF_SECONDS",
  "SEARCH_INDEX_BATCH_MAX",
  "SEARCH_INDEX_DISCOVERY_MAX",
  "SEARCH_INDEX_MAX_ATTEMPTS",
  "SEARCH_PAGE_SIZE_MAX",
  "SEARCH_QUERY_MAX_CHARS",
  "SEARCH_RATE_PER_MINUTE",
  "SEARCH_RECENT_MAX",
  "SEARCH_RECENT_RETENTION_DAYS",
  "SEARCH_RESULTS_MAX",
  "SEARCH_SNIPPET_CHARS",
  "SEARCH_TERMS_MAX",
  "SIGNED_URL_LIFETIME",
  "SSE_BUFFER_LIMIT",
  "SSE_HEARTBEAT_INTERVAL",
  "SSE_MAX_STREAMS_PER_PRINCIPAL",
  "STEP_UP_CHALLENGE_LIFETIME",
  "STEP_UP_MAX_ATTEMPTS",
  "STEP_UP_WINDOW",
  "SYNC_BACKOFF_SECONDS",
  "SYNC_BATCH_MAX",
  "SYNC_HISTORY_RETENTION_DAYS",
  "SYNC_LEASE_SECONDS",
  "SYNC_MAX_ATTEMPTS",
  "SYNC_RATE_PER_MINUTE",
  "WEBHOOK_ALLOW_LOOPBACK",
  "GOOGLE_CALENDAR_LOOPBACK_ENABLED",
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "GOOGLE_CALENDAR_REDIRECT_URI",
  "GOOGLE_CALENDAR_AUTHORIZE_URL",
  "GOOGLE_CALENDAR_TOKEN_URL",
  "GOOGLE_CALENDAR_REVOKE_URL",
  "GOOGLE_CALENDAR_API_BASE",
  "GOOGLE_CALENDAR_TIMEOUT_MS",
  "CALENDAR_SYNC_PAGES_MAX",
  "CALENDAR_SYNC_PAST_DAYS",
  "CALENDAR_SYNC_HORIZON_DAYS",
  "CALENDARS_PER_CONNECTION_MAX",
  "CALENDAR_OCCURRENCES_MAX",
  "CALENDAR_EVENTS_LIST_MAX",
  "TASK_ASSIGNEES_MAX",
  "TASK_DEPTH_MAX",
  "TASK_ESTIMATE_MINUTES_MAX",
  "TASK_ITEMS_MAX",
  "TASK_LABELS_MAX",
  "TASK_REMINDERS_MAX",
  "TASK_RESCHEDULE_COUNT",
  "TASK_RESCHEDULE_WINDOW_DAYS",
  "TASK_SNOOZE_MAX_DAYS",
  "TASK_STALE_ACTIVE_DAYS",
  "TASK_STALE_PLANNED_DAYS",
  "TASK_SUBTREE_MAX",
  "TEMPLATE_ITEMS_MAX",
  "TIME_ENTRY_MAX_HOURS",
  "TIME_EXPORT_ROWS_MAX",
  "TIME_OFF_ENTRIES_MAX",
  "TIME_REPORT_RANGE_DAYS_MAX",
  "TIME_REPORT_ROWS_MAX",
  "TIME_RUNAWAY_BATCH_MAX",
  "TIME_RUNAWAY_DISCOVERY_MAX",
  "TIME_TIMER_MAX_HOURS",
  "TIME_TIMESHEET_ENTRIES_MAX",
  "TODAY_ITEMS_MAX",
  "TODAY_LIST_MAX",
  "TOTAL_COUNT_CAP",
  "TRANSITION_APPROVERS_MAX",
  "TRANSITION_PREVIEW_TTL_SECONDS",
  "TRANSITION_REQUIREMENTS_MAX",
  "TRIAGE_BATCH_MAX",
  "UNDO_RETENTION",
  "UNDO_WINDOW_SECONDS",
  "UPCOMING_DEADLINE_DAYS",
  "UPLOAD_SESSION_LIFETIME",
  "USAGE_WARNING_THRESHOLDS",
  "VIEW_COLUMNS_MAX",
  "VIEW_PINS_MAX",
  "VIEW_STATE_MAX_BYTES",
  "VIEW_STATE_TTL",
  "WEBHOOK_BODY_MAX_BYTES",
  "WEBHOOK_CONCURRENCY_PER_DESTINATION",
  "WEBHOOK_DELIVERY_RETENTION_DAYS",
  "WEBHOOK_DISABLE_THRESHOLD",
  "WEBHOOK_EVENT_TYPES_MAX",
  "WEBHOOK_INBOUND_MAX",
  "WEBHOOK_MAX_ATTEMPTS",
  "WEBHOOK_RESPONSE_TIMEOUT",
  "WEBHOOK_SUBSCRIPTIONS_MAX",
  "WEBHOOK_SWEEP_BATCH_MAX",
  "WEBHOOK_TIMESTAMP_TOLERANCE",
  "WORKFLOW_STATUSES_MAX",
  "WORKFLOW_TRANSITIONS_MAX",
  "WORKLOAD_DAYS_MAX",
  "WORKSPACE_CONCURRENCY_CAP",
  "WORKSPACE_STORAGE_QUOTA_BYTES",
  "WORK_BLOCKS_PER_DAY_MAX",
  "WORK_BLOCKS_RANGE_DAYS_MAX",
  "AI_PROVIDER",
  "AI_PROVIDER_BASE_URL",
  "AI_PROVIDER_API_KEY",
  "AI_PROVIDER_TIMEOUT_MS",
  "AI_APPROVED_MODELS",
  "AI_BYOK_ENABLED",
  "AI_DEFAULT_MONTHLY_ALLOWANCE_MICROS",
  "AI_DEFAULT_HARD_LIMIT_MICROS",
  "AI_DEFAULT_INPUT_TOKEN_LIMIT",
  "AI_DEFAULT_OUTPUT_TOKEN_LIMIT",
  "AI_MAX_OUTPUT_TOKENS",
  "AI_MAX_ATTEMPTS",
  "AI_OUTPUT_MAX_CHARS",
  "AI_STREAM_EVENT_MAX_BYTES",
  "AI_STREAM_MAX_BYTES",
  "AI_CONTEXT_SOURCES_MAX",
  "AI_CONTEXT_SOURCE_CHARS",
  "AI_PROPOSAL_APPROVAL_HOURS",
  "AI_PROPOSAL_CHANGES_MAX",
  "TRANSCRIPTION_PROVIDER",
  "TRANSCRIPTION_BASE_URL",
  "TRANSCRIPTION_API_KEY",
  "TRANSCRIPTION_TIMEOUT_MS",
  "VOICE_MAX_SECONDS",
  "VOICE_MAX_BYTES",
  "VOICE_FORMATS",
  "VOICE_QUEUE_MAX",
  "VOICE_UPLOAD_TTL_SECONDS",
  "VOICE_TRANSCRIPT_MAX_CHARS",
  "AI_HISTORY_RETENTION_DAYS",
  "AUTOMATIONS_PER_WORKSPACE_MAX",
  "AUTOMATION_DEFINITION_BYTES_MAX",
  "AUTOMATION_NODES_MAX",
  "AUTOMATION_CONDITION_DEPTH_MAX",
  "AUTOMATION_CONDITIONS_MAX",
  "AUTOMATION_TARGET_FANOUT_MAX",
  "AUTOMATION_CHAIN_DEPTH_MAX",
  "AUTOMATION_RUN_STEPS_MAX",
  "AUTOMATION_ACTIVE_RUNS_MAX",
  "AUTOMATION_DELAY_HORIZON_MINUTES",
  "AUTOMATION_RETRIES_MAX",
  "AUTOMATION_RUNS_PER_MONTH",
  "AUTOMATION_TRIGGER_FANOUT_MAX",
  "AUTOMATION_SWEEP_BATCH_MAX",
  "AUTOMATION_ALERT_FAILURE_THRESHOLD",
  "AUTOMATION_ALERT_INTERVAL_MINUTES"
] as const;
export type ParameterName = (typeof PARAMETER_NAMES)[number];

export const PRINCIPALS = [
  {
    "id": "account",
    "platformOnly": false
  },
  {
    "id": "member",
    "platformOnly": false
  },
  {
    "id": "guest",
    "platformOnly": false
  },
  {
    "id": "team",
    "platformOnly": false
  },
  {
    "id": "support_operator",
    "platformOnly": true
  },
  {
    "id": "api_token_personal",
    "platformOnly": false
  },
  {
    "id": "service_principal",
    "platformOnly": false
  },
  {
    "id": "oauth_client",
    "platformOnly": false
  },
  {
    "id": "integration_connection",
    "platformOnly": false
  },
  {
    "id": "inbound_webhook",
    "platformOnly": false
  },
  {
    "id": "automation",
    "platformOnly": false
  },
  {
    "id": "ai_action",
    "platformOnly": false
  },
  {
    "id": "agent_profile",
    "platformOnly": false
  },
  {
    "id": "agent_run",
    "platformOnly": false
  },
  {
    "id": "tool_invocation",
    "platformOnly": false
  },
  {
    "id": "system_job",
    "platformOnly": false
  },
  {
    "id": "anonymous_public",
    "platformOnly": true
  }
] as const;
export type PrincipalType = (typeof PRINCIPALS)[number]['id'];

/** 0C actions: workspace-scoped kinds plus personal (own-account) actions. */
export const ACTIONS = [
  {
    "key": "record.read",
    "kind": "record",
    "scopes": [
      "brand",
      "project",
      "record",
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R0",
    "requiredLevel": "view",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:view",
      "limited_member": "grant:view",
      "read_only": "grant:view",
      "guest": "grant:view"
    }
  },
  {
    "key": "record.create",
    "kind": "record",
    "scopes": [
      "workspace",
      "brand",
      "project",
      "record"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "grant:edit"
    }
  },
  {
    "key": "record.update",
    "kind": "record",
    "scopes": [
      "brand",
      "project",
      "record",
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "grant:edit"
    }
  },
  {
    "key": "record.archive",
    "kind": "record",
    "scopes": [
      "brand",
      "project",
      "record",
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "record.restore",
    "kind": "record",
    "scopes": [
      "brand",
      "project",
      "record",
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "record.trash",
    "kind": "record",
    "scopes": [
      "brand",
      "project",
      "record",
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "record.purge",
    "kind": "admin",
    "scopes": [
      "workspace",
      "brand"
    ],
    "stepUp": true,
    "riskClass": "R4",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "record.comment",
    "kind": "record",
    "scopes": [
      "brand",
      "project",
      "record",
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R0",
    "requiredLevel": "comment",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:comment",
      "limited_member": "grant:comment",
      "read_only": "deny",
      "guest": "grant:comment"
    }
  },
  {
    "key": "comment.edit_own",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R0",
    "requiredLevel": "comment",
    "roles": {
      "owner": "own",
      "administrator": "own",
      "member": "own",
      "limited_member": "own",
      "read_only": "own",
      "guest": "own"
    }
  },
  {
    "key": "comment.moderate",
    "kind": "record",
    "scopes": [
      "brand",
      "project",
      "record"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": "manage",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "grant:manage",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "record.follow",
    "kind": "record",
    "scopes": [
      "brand",
      "project",
      "record",
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R0",
    "requiredLevel": "view",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:view",
      "limited_member": "grant:view",
      "read_only": "grant:view",
      "guest": "grant:view"
    }
  },
  {
    "key": "record.assign",
    "kind": "record",
    "scopes": [
      "project",
      "record"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "grant:edit"
    }
  },
  {
    "key": "record.delegate",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "grant:edit"
    }
  },
  {
    "key": "record.relate",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "grant:edit"
    }
  },
  {
    "key": "record.upload",
    "kind": "record",
    "scopes": [
      "brand",
      "project",
      "record",
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "grant:edit"
    }
  },
  {
    "key": "record.download",
    "kind": "record",
    "scopes": [
      "brand",
      "project",
      "record",
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R0",
    "requiredLevel": "view",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:view",
      "limited_member": "grant:view",
      "read_only": "grant:view",
      "guest": "grant:view"
    }
  },
  {
    "key": "record.move",
    "kind": "record",
    "scopes": [
      "brand",
      "project",
      "record"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "record.move_brand",
    "kind": "record",
    "scopes": [
      "brand"
    ],
    "stepUp": false,
    "riskClass": "R3",
    "requiredLevel": "manage",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "record.share",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R3",
    "requiredLevel": "manage",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "record.share_revoke",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": "manage",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "record.export",
    "kind": "record",
    "scopes": [
      "brand",
      "project",
      "record",
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": "view",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:view",
      "limited_member": "policy:limited_members_can_export",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "task.complete",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "grant:edit"
    }
  },
  {
    "key": "task.override_completion",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": "manage",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "label.manage",
    "kind": "admin",
    "scopes": [
      "brand"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "project.complete",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": "manage",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "grant:manage",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "project.verify_update",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "project.manage_recurrence",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": "manage",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "deliverable.submit",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "grant:edit"
    }
  },
  {
    "key": "review.request",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "grant:edit"
    }
  },
  {
    "key": "review.decide",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": "comment",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:comment",
      "limited_member": "grant:comment",
      "read_only": "deny",
      "guest": "grant:comment"
    }
  },
  {
    "key": "review.self_approve",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": "comment",
    "roles": {
      "owner": "policy:self_approval",
      "administrator": "policy:self_approval",
      "member": "policy:self_approval",
      "limited_member": "policy:self_approval",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "defect.verify",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "time.log_own",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R0",
    "requiredLevel": "comment",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:comment",
      "limited_member": "grant:comment",
      "read_only": "deny",
      "guest": "grant:comment"
    }
  },
  {
    "key": "timesheet.submit_own",
    "kind": "personal",
    "scopes": [
      "personal"
    ],
    "stepUp": false,
    "riskClass": "R0",
    "requiredLevel": null,
    "roles": {
      "owner": "own",
      "administrator": "own",
      "member": "own",
      "limited_member": "own",
      "read_only": "own",
      "guest": "deny"
    }
  },
  {
    "key": "timesheet.approve",
    "kind": "record",
    "scopes": [
      "brand"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": "manage",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "timesheet.unlock",
    "kind": "admin",
    "scopes": [
      "brand"
    ],
    "stepUp": true,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "view.share",
    "kind": "record",
    "scopes": [
      "brand",
      "project",
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "report.schedule",
    "kind": "record",
    "scopes": [
      "brand",
      "project",
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "release.decide",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": true,
    "riskClass": "R4",
    "requiredLevel": "manage",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "release.production_action",
    "kind": "execution",
    "scopes": [
      "record"
    ],
    "stepUp": true,
    "riskClass": "R4",
    "requiredLevel": "manage",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "environment.configure",
    "kind": "record",
    "scopes": [
      "brand"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": "manage",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "tests.execute",
    "kind": "execution",
    "scopes": [
      "brand",
      "project",
      "record"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "personal.manage_own",
    "kind": "personal",
    "scopes": [
      "personal"
    ],
    "stepUp": false,
    "riskClass": "R0",
    "requiredLevel": null,
    "roles": {
      "owner": "own",
      "administrator": "own",
      "member": "own",
      "limited_member": "own",
      "read_only": "own",
      "guest": "own"
    }
  },
  {
    "key": "sessions.manage_own",
    "kind": "personal",
    "scopes": [
      "personal"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": null,
    "roles": {
      "owner": "own",
      "administrator": "own",
      "member": "own",
      "limited_member": "own",
      "read_only": "own",
      "guest": "own"
    }
  },
  {
    "key": "account.mfa_enroll",
    "kind": "personal",
    "scopes": [
      "personal"
    ],
    "stepUp": true,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "own",
      "administrator": "own",
      "member": "own",
      "limited_member": "own",
      "read_only": "own",
      "guest": "own"
    }
  },
  {
    "key": "account.mfa_disable",
    "kind": "personal",
    "scopes": [
      "personal"
    ],
    "stepUp": true,
    "riskClass": "R4",
    "requiredLevel": null,
    "roles": {
      "owner": "own",
      "administrator": "own",
      "member": "own",
      "limited_member": "own",
      "read_only": "own",
      "guest": "own"
    }
  },
  {
    "key": "account.recovery_codes_regenerate",
    "kind": "personal",
    "scopes": [
      "personal"
    ],
    "stepUp": true,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "own",
      "administrator": "own",
      "member": "own",
      "limited_member": "own",
      "read_only": "own",
      "guest": "own"
    }
  },
  {
    "key": "api_tokens.personal",
    "kind": "personal",
    "scopes": [
      "personal"
    ],
    "stepUp": true,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "own",
      "administrator": "own",
      "member": "own",
      "limited_member": "policy:limited_members_tokens",
      "read_only": "own",
      "guest": "deny"
    }
  },
  {
    "key": "workspace.create",
    "kind": "personal",
    "scopes": [
      "personal"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": null,
    "roles": {
      "owner": "deny",
      "administrator": "deny",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "workspace.view_settings",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R0",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "implicit",
      "limited_member": "implicit",
      "read_only": "implicit",
      "guest": "deny"
    }
  },
  {
    "key": "workspace.configure",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "workspace.delete",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": true,
    "riskClass": "R4",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "deny",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "ownership.transfer",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": true,
    "riskClass": "R4",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "deny",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "brand.create",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "brand.configure",
    "kind": "admin",
    "scopes": [
      "brand"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "grant:manage",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "brand.archive",
    "kind": "admin",
    "scopes": [
      "brand"
    ],
    "stepUp": false,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "brand.delete",
    "kind": "admin",
    "scopes": [
      "brand"
    ],
    "stepUp": true,
    "riskClass": "R4",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "brand.mark_sensitive",
    "kind": "admin",
    "scopes": [
      "brand"
    ],
    "stepUp": true,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "membership.invite_member",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "membership.invite_guest",
    "kind": "admin",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "policy:members_invite_guests",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "membership.manage",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": true,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "invitation.accept",
    "kind": "personal",
    "scopes": [
      "personal"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": null,
    "roles": {
      "owner": "deny",
      "administrator": "deny",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "ownership.accept",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": true,
    "riskClass": "R4",
    "requiredLevel": null,
    "roles": {
      "owner": "own",
      "administrator": "own",
      "member": "own",
      "limited_member": "own",
      "read_only": "own",
      "guest": "deny"
    }
  },
  {
    "key": "membership.leave",
    "kind": "personal",
    "scopes": [
      "personal"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": null,
    "roles": {
      "owner": "own",
      "administrator": "own",
      "member": "own",
      "limited_member": "own",
      "read_only": "own",
      "guest": "own"
    }
  },
  {
    "key": "team.manage",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "access.grant_scope",
    "kind": "admin",
    "scopes": [
      "workspace",
      "brand",
      "project"
    ],
    "stepUp": false,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "grant:manage",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "access.restrict_scope",
    "kind": "admin",
    "scopes": [
      "brand",
      "project",
      "record",
      "field"
    ],
    "stepUp": false,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "grant:manage",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "access.preview",
    "kind": "admin",
    "scopes": [
      "workspace",
      "brand",
      "project"
    ],
    "stepUp": false,
    "riskClass": "R0",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "grant:manage",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "access.elevate_sensitive",
    "kind": "admin",
    "scopes": [
      "brand",
      "project"
    ],
    "stepUp": true,
    "riskClass": "R4",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "deny",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "sharing.policy.configure",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": true,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "feature_availability.configure",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "custom_roles.manage",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": true,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "workflow.configure",
    "kind": "admin",
    "scopes": [
      "workspace",
      "brand",
      "project"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "grant:manage",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "fields.configure",
    "kind": "admin",
    "scopes": [
      "workspace",
      "brand",
      "project"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "grant:manage",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "views.configure",
    "kind": "admin",
    "scopes": [
      "workspace",
      "brand",
      "project"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "grant:manage",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "templates.manage",
    "kind": "admin",
    "scopes": [
      "workspace",
      "brand"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "grant:manage",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "notifications.configure_scope",
    "kind": "admin",
    "scopes": [
      "brand",
      "project"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "grant:manage",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "ai.configure_brand",
    "kind": "admin",
    "scopes": [
      "brand"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "grant:manage",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "ai.providers.manage",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": true,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "ai.limits.configure",
    "kind": "admin",
    "scopes": [
      "workspace",
      "brand"
    ],
    "stepUp": true,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "operation.reconcile_effect",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": true,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "agents.configure",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "policy:members_configure_agents",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "automations.configure",
    "kind": "admin",
    "scopes": [
      "workspace",
      "brand"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "grant:manage",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "integrations.configure",
    "kind": "admin",
    "scopes": [
      "workspace",
      "brand"
    ],
    "stepUp": false,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "api_tokens.service.manage",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": true,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "webhooks.manage",
    "kind": "admin",
    "scopes": [
      "workspace",
      "brand"
    ],
    "stepUp": false,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "security.configure",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": true,
    "riskClass": "R4",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "sessions.manage_others",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": true,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "retention.configure",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": true,
    "riskClass": "R4",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "deny",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "legal_hold.manage",
    "kind": "admin",
    "scopes": [
      "workspace",
      "brand"
    ],
    "stepUp": true,
    "riskClass": "R4",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "deny",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "trash.manage",
    "kind": "admin",
    "scopes": [
      "workspace",
      "brand"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "audit.view",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R0",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "audit.export",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": true,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "workspace.export",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": true,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "usage.view",
    "kind": "admin",
    "scopes": [
      "workspace",
      "brand"
    ],
    "stepUp": false,
    "riskClass": "R0",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "grant:manage",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "billing.view",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R0",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "billing.manage",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": true,
    "riskClass": "R3",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "policy:admins_manage_billing",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "secrets_metadata.view",
    "kind": "admin",
    "scopes": [
      "workspace",
      "connection"
    ],
    "stepUp": false,
    "riskClass": "R0",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "health.view",
    "kind": "admin",
    "scopes": [
      "workspace",
      "brand"
    ],
    "stepUp": false,
    "riskClass": "R0",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "support_access.grant",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": true,
    "riskClass": "R4",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "emergency_stop.trigger",
    "kind": "admin",
    "scopes": [
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "deny",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "ai.execute",
    "kind": "execution",
    "scopes": [
      "workspace",
      "brand",
      "project",
      "record"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "view",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:view",
      "limited_member": "policy:limited_members_ai",
      "read_only": "policy:read_only_ai",
      "guest": "deny"
    }
  },
  {
    "key": "ai.apply_proposal",
    "kind": "execution",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "agent.assign",
    "kind": "execution",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "policy:limited_members_agents",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "agent.run_control",
    "kind": "execution",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "agent.action_approve",
    "kind": "execution",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R3",
    "requiredLevel": "manage",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "automation.run_manual",
    "kind": "execution",
    "scopes": [
      "brand",
      "workspace"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": "manage",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "grant:manage",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "integration.sync_now",
    "kind": "execution",
    "scopes": [
      "connection"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "import.execute",
    "kind": "execution",
    "scopes": [
      "workspace",
      "brand"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "webhook.test_send",
    "kind": "execution",
    "scopes": [
      "workspace",
      "brand"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "workflow.transition",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "grant:edit"
    }
  },
  {
    "key": "workflow.approval_request",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "grant:edit"
    }
  },
  {
    "key": "workflow.approval_decide",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": "view",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:view",
      "limited_member": "grant:view",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "field.value_read",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R0",
    "requiredLevel": "view",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:view",
      "limited_member": "grant:view",
      "read_only": "grant:view",
      "guest": "grant:view"
    }
  },
  {
    "key": "field.value_edit",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "edit",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:edit",
      "limited_member": "grant:edit",
      "read_only": "deny",
      "guest": "grant:edit"
    }
  },
  {
    "key": "field.formula_inspect",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R0",
    "requiredLevel": "view",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:view",
      "limited_member": "grant:view",
      "read_only": "grant:view",
      "guest": "deny"
    }
  },
  {
    "key": "task.remind",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R0",
    "requiredLevel": "view",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:view",
      "limited_member": "grant:view",
      "read_only": "grant:view",
      "guest": "grant:view"
    }
  },
  {
    "key": "task.snooze",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R0",
    "requiredLevel": "view",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:view",
      "limited_member": "grant:view",
      "read_only": "grant:view",
      "guest": "grant:view"
    }
  },
  {
    "key": "task.manage_recurrence",
    "kind": "record",
    "scopes": [
      "record"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": "manage",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "intake.manage",
    "kind": "admin",
    "scopes": [
      "brand"
    ],
    "stepUp": false,
    "riskClass": "R2",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "intake.submit",
    "kind": "record",
    "scopes": [
      "brand"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": "view",
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:view",
      "limited_member": "grant:view",
      "read_only": "grant:view",
      "guest": "deny"
    }
  },
  {
    "key": "capacity.view",
    "kind": "admin",
    "scopes": [
      "workspace",
      "brand"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  },
  {
    "key": "capacity.reserve",
    "kind": "admin",
    "scopes": [
      "brand"
    ],
    "stepUp": false,
    "riskClass": "R1",
    "requiredLevel": null,
    "roles": {
      "owner": "implicit",
      "administrator": "implicit",
      "member": "grant:manage",
      "limited_member": "deny",
      "read_only": "deny",
      "guest": "deny"
    }
  }
] as const;
export type ActionKey = (typeof ACTIONS)[number]['key'];

/** 0C account commands (AZ-18): account-level actions performed before any tenant context. */
export const ACCOUNT_COMMANDS = [
  {
    "action": "workspace.create",
    "principals": [
      "account"
    ],
    "gates": [
      "email_verified",
      "account_active",
      "rate_limit",
      "idempotency_key"
    ]
  },
  {
    "action": "invitation.accept",
    "principals": [
      "account"
    ],
    "gates": [
      "email_verified",
      "account_active",
      "rate_limit",
      "idempotency_key",
      "email_match",
      "single_use_token"
    ]
  }
] as const;
export type AccountCommand = (typeof ACCOUNT_COMMANDS)[number]['action'];

/** 0C §3.1 default roles: membership kind, level cap, and grantable authority (I-11). */
export const ROLE_DEFINITIONS = [
  {
    "id": "owner",
    "membershipKind": "member",
    "levelCap": null,
    "canAssign": [
      "owner",
      "administrator",
      "member",
      "limited_member",
      "read_only",
      "guest"
    ]
  },
  {
    "id": "administrator",
    "membershipKind": "member",
    "levelCap": null,
    "canAssign": [
      "administrator",
      "member",
      "limited_member",
      "read_only",
      "guest"
    ]
  },
  {
    "id": "member",
    "membershipKind": "member",
    "levelCap": null,
    "canAssign": [
      "guest"
    ]
  },
  {
    "id": "limited_member",
    "membershipKind": "member",
    "levelCap": null,
    "canAssign": []
  },
  {
    "id": "read_only",
    "membershipKind": "member",
    "levelCap": "view",
    "canAssign": []
  },
  {
    "id": "guest",
    "membershipKind": "guest",
    "levelCap": "edit",
    "canAssign": []
  }
] as const;
export type RoleId = (typeof ROLE_DEFINITIONS)[number]['id'];

/** 0C AZ-19 workspace policy fields: safe defaults and governing actions. */
export const WORKSPACE_POLICY_FIELDS = [
  {
    "field": "self_approval_mode",
    "default": "auto",
    "governedBy": "sharing.policy.configure",
    "ownerOnly": false
  },
  {
    "field": "require_independent_for",
    "default": [],
    "governedBy": "sharing.policy.configure",
    "ownerOnly": false
  },
  {
    "field": "members_invite_guests",
    "default": false,
    "governedBy": "sharing.policy.configure",
    "ownerOnly": false
  },
  {
    "field": "limited_members_can_export",
    "default": false,
    "governedBy": "sharing.policy.configure",
    "ownerOnly": false
  },
  {
    "field": "limited_members_tokens",
    "default": false,
    "governedBy": "workspace.configure",
    "ownerOnly": false
  },
  {
    "field": "limited_members_ai",
    "default": false,
    "governedBy": "workspace.configure",
    "ownerOnly": false
  },
  {
    "field": "limited_members_agents",
    "default": false,
    "governedBy": "workspace.configure",
    "ownerOnly": false
  },
  {
    "field": "read_only_ai",
    "default": false,
    "governedBy": "workspace.configure",
    "ownerOnly": false
  },
  {
    "field": "members_configure_agents",
    "default": false,
    "governedBy": "workspace.configure",
    "ownerOnly": false
  },
  {
    "field": "admins_manage_billing",
    "default": false,
    "governedBy": "billing.manage",
    "ownerOnly": true
  },
  {
    "field": "comment_on_archived",
    "default": false,
    "governedBy": "workspace.configure",
    "ownerOnly": false
  },
  {
    "field": "workspace_records_default_level",
    "default": "view",
    "governedBy": "workspace.configure",
    "ownerOnly": false
  },
  {
    "field": "cross_brand_sharing_enabled",
    "default": false,
    "governedBy": "sharing.policy.configure",
    "ownerOnly": false
  },
  {
    "field": "guest_invitations_enabled",
    "default": true,
    "governedBy": "sharing.policy.configure",
    "ownerOnly": false
  },
  {
    "field": "public_links_enabled",
    "default": false,
    "governedBy": "sharing.policy.configure",
    "ownerOnly": false
  },
  {
    "field": "share_max_expiry",
    "default": null,
    "governedBy": "sharing.policy.configure",
    "ownerOnly": false
  },
  {
    "field": "token_max_lifetime",
    "default": null,
    "governedBy": "workspace.configure",
    "ownerOnly": false
  },
  {
    "field": "low_impact_agent_actions",
    "default": [],
    "governedBy": "workspace.configure",
    "ownerOnly": false
  }
] as const;
export type WorkspacePolicyField = (typeof WORKSPACE_POLICY_FIELDS)[number]['field'];

/** 0B brand operational status (ADR-19): business metadata, never lifecycle. */
export const BRAND_OPERATIONAL_STATUSES = [
  "operating",
  "paused",
  "planned"
] as const;
export type BrandOperationalStatus = (typeof BRAND_OPERATIONAL_STATUSES)[number];

/** 0B brand notification content mode. */
export const BRAND_NOTIFICATION_CONTENT_MODES = [
  "standard",
  "minimal"
] as const;
export type BrandNotificationContentMode = (typeof BRAND_NOTIFICATION_CONTENT_MODES)[number];

/** 0D §11.2 step-up challenge states (`locked` is stored and terminal). */
export const STEP_UP_CHALLENGE_STATES = [
  "pending",
  "verified",
  "consumed",
  "expired",
  "cancelled",
  "locked"
] as const;
export type StepUpChallengeState = (typeof STEP_UP_CHALLENGE_STATES)[number];
