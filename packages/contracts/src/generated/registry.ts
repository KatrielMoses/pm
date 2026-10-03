// GENERATED FILE - do not edit by hand.
// Source: docs/architecture/platform/contracts/registry.json (schema_version 1)
//         docs/architecture/access/policy/policy.json (schema_version 1)
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
  "user_agent"
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
  }
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number]['kind'];

export const ID_PREFIXES = [
  {
    "prefix": "br",
    "entity": "tenancy.brand",
    "ownerModule": "tenancy",
    "platformOnly": false
  },
  {
    "prefix": "team",
    "entity": "tenancy.team",
    "ownerModule": "tenancy",
    "platformOnly": false
  },
  {
    "prefix": "wf",
    "entity": "workflow.workflow",
    "ownerModule": "workflow",
    "platformOnly": false
  },
  {
    "prefix": "file",
    "entity": "files.file",
    "ownerModule": "files",
    "platformOnly": false
  },
  {
    "prefix": "dlv",
    "entity": "files.deliverable",
    "ownerModule": "files",
    "platformOnly": false
  },
  {
    "prefix": "prj",
    "entity": "work.project",
    "ownerModule": "work",
    "platformOnly": false
  },
  {
    "prefix": "ms",
    "entity": "work.milestone",
    "ownerModule": "work",
    "platformOnly": false
  },
  {
    "prefix": "tsk",
    "entity": "work.task",
    "ownerModule": "work",
    "platformOnly": false
  },
  {
    "prefix": "dec",
    "entity": "work.decision_record",
    "ownerModule": "work",
    "platformOnly": false
  },
  {
    "prefix": "inb",
    "entity": "capture.inbox_item",
    "ownerModule": "capture",
    "platformOnly": false
  },
  {
    "prefix": "note",
    "entity": "capture.note",
    "ownerModule": "capture",
    "platformOnly": false
  },
  {
    "prefix": "form",
    "entity": "capture.intake_form",
    "ownerModule": "capture",
    "platformOnly": false
  },
  {
    "prefix": "blk",
    "entity": "planning.work_block",
    "ownerModule": "planning",
    "platformOnly": false
  },
  {
    "prefix": "doc",
    "entity": "knowledge.document",
    "ownerModule": "knowledge",
    "platformOnly": false
  },
  {
    "prefix": "goal",
    "entity": "goals.goal",
    "ownerModule": "goals",
    "platformOnly": false
  },
  {
    "prefix": "kr",
    "entity": "goals.key_result",
    "ownerModule": "goals",
    "platformOnly": false
  },
  {
    "prefix": "pf",
    "entity": "goals.portfolio",
    "ownerModule": "goals",
    "platformOnly": false
  },
  {
    "prefix": "view",
    "entity": "views.saved_view",
    "ownerModule": "views",
    "platformOnly": false
  },
  {
    "prefix": "dash",
    "entity": "insights.dashboard",
    "ownerModule": "insights",
    "platformOnly": false
  },
  {
    "prefix": "rpt",
    "entity": "insights.report_definition",
    "ownerModule": "insights",
    "platformOnly": false
  },
  {
    "prefix": "conn",
    "entity": "integrations.connection",
    "ownerModule": "integrations",
    "platformOnly": false
  },
  {
    "prefix": "whk",
    "entity": "integrations.webhook_subscription",
    "ownerModule": "integrations",
    "platformOnly": false
  },
  {
    "prefix": "tc",
    "entity": "quality.test_case",
    "ownerModule": "quality",
    "platformOnly": false
  },
  {
    "prefix": "ts",
    "entity": "quality.test_suite",
    "ownerModule": "quality",
    "platformOnly": false
  },
  {
    "prefix": "tr",
    "entity": "quality.test_run",
    "ownerModule": "quality",
    "platformOnly": false
  },
  {
    "prefix": "env",
    "entity": "delivery.environment",
    "ownerModule": "delivery",
    "platformOnly": false
  },
  {
    "prefix": "rel",
    "entity": "delivery.release",
    "ownerModule": "delivery",
    "platformOnly": false
  },
  {
    "prefix": "tpl",
    "entity": "templates.template",
    "ownerModule": "templates",
    "platformOnly": false
  },
  {
    "prefix": "auto",
    "entity": "automation.automation",
    "ownerModule": "automation",
    "platformOnly": false
  },
  {
    "prefix": "agt",
    "entity": "agents.agent_profile",
    "ownerModule": "agents",
    "platformOnly": false
  },
  {
    "prefix": "ws",
    "entity": "tenancy.workspace",
    "ownerModule": "tenancy",
    "platformOnly": false
  },
  {
    "prefix": "mem",
    "entity": "tenancy.membership",
    "ownerModule": "tenancy",
    "platformOnly": false
  },
  {
    "prefix": "acct",
    "entity": "identity.account",
    "ownerModule": "identity",
    "platformOnly": false
  },
  {
    "prefix": "grt",
    "entity": "access.record_grant",
    "ownerModule": "access",
    "platformOnly": false
  },
  {
    "prefix": "cmt",
    "entity": "collab.comment",
    "ownerModule": "collab",
    "platformOnly": false
  },
  {
    "prefix": "rvw",
    "entity": "collab.review_request",
    "ownerModule": "collab",
    "platformOnly": false
  },
  {
    "prefix": "te",
    "entity": "time.time_entry",
    "ownerModule": "time",
    "platformOnly": false
  },
  {
    "prefix": "tsh",
    "entity": "time.timesheet",
    "ownerModule": "time",
    "platformOnly": false
  },
  {
    "prefix": "res",
    "entity": "quality.test_result",
    "ownerModule": "quality",
    "platformOnly": false
  },
  {
    "prefix": "op",
    "entity": "execution.operation",
    "ownerModule": "execution",
    "platformOnly": false
  },
  {
    "prefix": "att",
    "entity": "execution.attempt",
    "ownerModule": "execution",
    "platformOnly": false
  },
  {
    "prefix": "evt",
    "entity": null,
    "ownerModule": "execution",
    "platformOnly": true
  },
  {
    "prefix": "whd",
    "entity": "integrations.webhook_delivery",
    "ownerModule": "integrations",
    "platformOnly": false
  },
  {
    "prefix": "ntf",
    "entity": "notify.notification",
    "ownerModule": "notify",
    "platformOnly": false
  },
  {
    "prefix": "upl",
    "entity": "files.upload_session",
    "ownerModule": "files",
    "platformOnly": false
  },
  {
    "prefix": "fv",
    "entity": "files.file_version",
    "ownerModule": "files",
    "platformOnly": false
  },
  {
    "prefix": "dv",
    "entity": "files.deliverable_version",
    "ownerModule": "files",
    "platformOnly": false
  },
  {
    "prefix": "dcv",
    "entity": "knowledge.document_version",
    "ownerModule": "knowledge",
    "platformOnly": false
  },
  {
    "prefix": "tok",
    "entity": "integrations.api_token",
    "ownerModule": "integrations",
    "platformOnly": false
  },
  {
    "prefix": "oac",
    "entity": "integrations.oauth_client",
    "ownerModule": "integrations",
    "platformOnly": false
  },
  {
    "prefix": "svc",
    "entity": "access.service_principal",
    "ownerModule": "access",
    "platformOnly": false
  },
  {
    "prefix": "shr",
    "entity": "access.share_group",
    "ownerModule": "access",
    "platformOnly": false
  },
  {
    "prefix": "apr",
    "entity": "agents.action_approval",
    "ownerModule": "agents",
    "platformOnly": false
  },
  {
    "prefix": "stp",
    "entity": "identity.step_up_challenge",
    "ownerModule": "identity",
    "platformOnly": false
  },
  {
    "prefix": "exf",
    "entity": "transfer.export_file",
    "ownerModule": "transfer",
    "platformOnly": false
  },
  {
    "prefix": "req",
    "entity": null,
    "ownerModule": "execution",
    "platformOnly": true
  },
  {
    "prefix": "ext",
    "entity": "integrations.external_identity",
    "ownerModule": "integrations",
    "platformOnly": false
  },
  {
    "prefix": "cev",
    "entity": "integrations.calendar_event",
    "ownerModule": "integrations",
    "platformOnly": false
  },
  {
    "prefix": "rd",
    "entity": "delivery.release_decision",
    "ownerModule": "delivery",
    "platformOnly": false
  },
  {
    "prefix": "sag",
    "entity": "access.support_access_grant",
    "ownerModule": "access",
    "platformOnly": false
  },
  {
    "prefix": "fpol",
    "entity": "access.field_policy",
    "ownerModule": "access",
    "platformOnly": false
  }
] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number]['prefix'];

export const INTERNAL_EVENTS = [
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
    "type": "core.record.purged",
    "schemaVersion": 1,
    "aggregateEntity": "core.record",
    "fields": [
      "record_type"
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
    "type": "work.task.updated",
    "schemaVersion": 1,
    "aggregateEntity": "work.task",
    "fields": [
      "changed_fields"
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
    "type": "work.task.assigned",
    "schemaVersion": 1,
    "aggregateEntity": "work.task",
    "fields": [
      "assignee_membership_ids"
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
    "type": "collab.review.requested",
    "schemaVersion": 1,
    "aggregateEntity": "collab.review_request",
    "fields": [
      "subject_kind",
      "subject_ref",
      "reviewer_rule"
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
      "subject_ref"
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
    "type": "files.file.scanned",
    "schemaVersion": 1,
    "aggregateEntity": "files.file_version",
    "fields": [
      "scan_state"
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
    "type": "capture.inbox.captured",
    "schemaVersion": 1,
    "aggregateEntity": "capture.inbox_item",
    "fields": [
      "source_kind"
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
    "type": "time.time_entry.recorded",
    "schemaVersion": 1,
    "aggregateEntity": "time.time_entry",
    "fields": [
      "duration_seconds",
      "billable"
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
    "type": "knowledge.document.source_approved",
    "schemaVersion": 1,
    "aggregateEntity": "knowledge.source_approval",
    "fields": [
      "document_version_id"
    ],
    "maxClass": "C1"
  },
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
    "type": "tenancy.membership.removed",
    "schemaVersion": 1,
    "aggregateEntity": "tenancy.membership",
    "fields": [
      "reason"
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
    "type": "agents.agent_run.output_returned",
    "schemaVersion": 1,
    "aggregateEntity": "agents.agent_run",
    "fields": [
      "deliverable_version_id"
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
    "type": "integrations.connection.health_changed",
    "schemaVersion": 1,
    "aggregateEntity": "integrations.connection",
    "fields": [
      "health"
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
    "type": "metering.usage.limit_reached",
    "schemaVersion": 1,
    "aggregateEntity": "metering.usage_balance",
    "fields": [
      "meter"
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
    "type": "transfer.export.ready",
    "schemaVersion": 1,
    "aggregateEntity": "transfer.export_job",
    "fields": [
      "format"
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
  }
] as const;
export type InternalEventType = (typeof INTERNAL_EVENTS)[number]['type'];

export const PARAMETER_NAMES = [
  "IDEMPOTENCY_RETENTION",
  "OUTBOX_REPLAY_WINDOW",
  "JOB_LEASE_DURATION",
  "JOB_HEARTBEAT_INTERVAL",
  "JOB_BACKOFF_BASE",
  "JOB_BACKOFF_CAP",
  "JOB_MAX_ATTEMPTS",
  "JOB_TIMEOUT",
  "WORKSPACE_CONCURRENCY_CAP",
  "WEBHOOK_TIMESTAMP_TOLERANCE",
  "WEBHOOK_DISABLE_THRESHOLD",
  "WEBHOOK_RESPONSE_TIMEOUT",
  "SSE_HEARTBEAT_INTERVAL",
  "SSE_BUFFER_LIMIT",
  "SSE_MAX_STREAMS_PER_PRINCIPAL",
  "SIGNED_URL_LIFETIME",
  "UPLOAD_SESSION_LIFETIME",
  "STEP_UP_WINDOW",
  "STEP_UP_CHALLENGE_LIFETIME",
  "PAGE_LIMIT_DEFAULT",
  "PAGE_LIMIT_MAX",
  "TOTAL_COUNT_CAP",
  "BULK_SYNC_LIMIT",
  "ATOMIC_BULK_LIMIT",
  "RATE_LIMIT_POLICIES",
  "DEPRECATION_NOTICE_PERIOD",
  "EXPORT_LINK_LIFETIME",
  "IMPORT_ROLLBACK_PERIOD",
  "USAGE_WARNING_THRESHOLDS",
  "UNDO_RETENTION"
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

/** 0C actions (workspace-scoped authorization vocabulary). */
export const ACTIONS = [
  {
    "key": "record.read",
    "stepUp": false,
    "riskClass": "R0"
  },
  {
    "key": "record.create",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "record.update",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "record.archive",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "record.restore",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "record.trash",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "record.purge",
    "stepUp": true,
    "riskClass": "R4"
  },
  {
    "key": "record.comment",
    "stepUp": false,
    "riskClass": "R0"
  },
  {
    "key": "comment.edit_own",
    "stepUp": false,
    "riskClass": "R0"
  },
  {
    "key": "comment.moderate",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "record.follow",
    "stepUp": false,
    "riskClass": "R0"
  },
  {
    "key": "record.assign",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "record.delegate",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "record.relate",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "record.upload",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "record.download",
    "stepUp": false,
    "riskClass": "R0"
  },
  {
    "key": "record.move",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "record.move_brand",
    "stepUp": false,
    "riskClass": "R3"
  },
  {
    "key": "record.share",
    "stepUp": false,
    "riskClass": "R3"
  },
  {
    "key": "record.share_revoke",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "record.export",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "task.complete",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "project.complete",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "deliverable.submit",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "review.request",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "review.decide",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "review.self_approve",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "defect.verify",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "time.log_own",
    "stepUp": false,
    "riskClass": "R0"
  },
  {
    "key": "timesheet.submit_own",
    "stepUp": false,
    "riskClass": "R0"
  },
  {
    "key": "timesheet.approve",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "timesheet.unlock",
    "stepUp": true,
    "riskClass": "R3"
  },
  {
    "key": "view.share",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "report.schedule",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "release.decide",
    "stepUp": true,
    "riskClass": "R4"
  },
  {
    "key": "release.production_action",
    "stepUp": true,
    "riskClass": "R4"
  },
  {
    "key": "environment.configure",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "tests.execute",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "personal.manage_own",
    "stepUp": false,
    "riskClass": "R0"
  },
  {
    "key": "sessions.manage_own",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "api_tokens.personal",
    "stepUp": true,
    "riskClass": "R3"
  },
  {
    "key": "workspace.view_settings",
    "stepUp": false,
    "riskClass": "R0"
  },
  {
    "key": "workspace.configure",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "workspace.delete",
    "stepUp": true,
    "riskClass": "R4"
  },
  {
    "key": "ownership.transfer",
    "stepUp": true,
    "riskClass": "R4"
  },
  {
    "key": "brand.create",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "brand.configure",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "brand.archive",
    "stepUp": false,
    "riskClass": "R3"
  },
  {
    "key": "brand.delete",
    "stepUp": true,
    "riskClass": "R4"
  },
  {
    "key": "brand.mark_sensitive",
    "stepUp": true,
    "riskClass": "R3"
  },
  {
    "key": "membership.invite_member",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "membership.invite_guest",
    "stepUp": false,
    "riskClass": "R3"
  },
  {
    "key": "membership.manage",
    "stepUp": true,
    "riskClass": "R3"
  },
  {
    "key": "team.manage",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "access.grant_scope",
    "stepUp": false,
    "riskClass": "R3"
  },
  {
    "key": "access.restrict_scope",
    "stepUp": false,
    "riskClass": "R3"
  },
  {
    "key": "access.preview",
    "stepUp": false,
    "riskClass": "R0"
  },
  {
    "key": "access.elevate_sensitive",
    "stepUp": true,
    "riskClass": "R4"
  },
  {
    "key": "sharing.policy.configure",
    "stepUp": true,
    "riskClass": "R3"
  },
  {
    "key": "feature_availability.configure",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "custom_roles.manage",
    "stepUp": true,
    "riskClass": "R3"
  },
  {
    "key": "workflow.configure",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "fields.configure",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "views.configure",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "templates.manage",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "notifications.configure_scope",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "ai.configure_brand",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "ai.providers.manage",
    "stepUp": true,
    "riskClass": "R3"
  },
  {
    "key": "ai.limits.configure",
    "stepUp": true,
    "riskClass": "R3"
  },
  {
    "key": "agents.configure",
    "stepUp": false,
    "riskClass": "R3"
  },
  {
    "key": "automations.configure",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "integrations.configure",
    "stepUp": false,
    "riskClass": "R3"
  },
  {
    "key": "api_tokens.service.manage",
    "stepUp": true,
    "riskClass": "R3"
  },
  {
    "key": "webhooks.manage",
    "stepUp": false,
    "riskClass": "R3"
  },
  {
    "key": "security.configure",
    "stepUp": true,
    "riskClass": "R4"
  },
  {
    "key": "sessions.manage_others",
    "stepUp": true,
    "riskClass": "R3"
  },
  {
    "key": "retention.configure",
    "stepUp": true,
    "riskClass": "R4"
  },
  {
    "key": "legal_hold.manage",
    "stepUp": true,
    "riskClass": "R4"
  },
  {
    "key": "trash.manage",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "audit.view",
    "stepUp": false,
    "riskClass": "R0"
  },
  {
    "key": "audit.export",
    "stepUp": true,
    "riskClass": "R3"
  },
  {
    "key": "workspace.export",
    "stepUp": true,
    "riskClass": "R3"
  },
  {
    "key": "usage.view",
    "stepUp": false,
    "riskClass": "R0"
  },
  {
    "key": "billing.view",
    "stepUp": false,
    "riskClass": "R0"
  },
  {
    "key": "billing.manage",
    "stepUp": true,
    "riskClass": "R3"
  },
  {
    "key": "secrets_metadata.view",
    "stepUp": false,
    "riskClass": "R0"
  },
  {
    "key": "health.view",
    "stepUp": false,
    "riskClass": "R0"
  },
  {
    "key": "support_access.grant",
    "stepUp": true,
    "riskClass": "R4"
  },
  {
    "key": "emergency_stop.trigger",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "ai.execute",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "ai.apply_proposal",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "agent.assign",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "agent.run_control",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "agent.action_approve",
    "stepUp": false,
    "riskClass": "R3"
  },
  {
    "key": "automation.run_manual",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "integration.sync_now",
    "stepUp": false,
    "riskClass": "R1"
  },
  {
    "key": "import.execute",
    "stepUp": false,
    "riskClass": "R2"
  },
  {
    "key": "webhook.test_send",
    "stepUp": false,
    "riskClass": "R2"
  }
] as const;
export type ActionKey = (typeof ACTIONS)[number]['key'];
