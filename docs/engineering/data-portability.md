# CSV import/export and data portability

The portability page is in workspace Settings → Integrations. It is available independently of billing state; cancellation must not remove the account's export access. Commercial cancellation/recovery flows belong to 10A.

## Supported records

CSV schema version `1` supports task, project, workflow, field-definition, goal, document metadata, and external file-link imports. Tasks include subtasks when their parent is an existing readable public task identifier. Imported public identifiers, source actors and timestamps are provenance; they never impersonate a local actor or overwrite a local record. Local identifiers are generated through canonical commands and the import row keeps the source-to-destination correspondence.

Workspaces, brands and accounts are established through their existing onboarding/invitation flows. CSV never creates an account, sets roles, grants access, or switches a tenant. Labels, comments and time are authored through their existing record commands. Unsupported column names are refused, and row errors name stable codes without repeating source content.

## Import workflow

Upload UTF-8 RFC 4180 CSV, choose an allowlisted mapping, preview, and explicitly apply. Save mappings privately for reuse; edits require their current version. Apply is bound to the preview's digest and mapping version. Atomic mode runs every canonical command, checkpoint, audit and event in one database transaction. A failure rolls everything back. Partial mode returns a result per row and checkpoints successful rows; retrying the same input resumes safely without creating duplicates.

Inputs and outputs are bounded to 5 MiB, 100 columns, 32,000 characters per cell, 2,000 imported rows and 10,000 exported rows. The browser reads uploads in bounded chunks; binary files use 4E's upload, scanning and quarantine APIs. CSV file rows create external links without fetching their URLs. A binary file represented only by metadata cannot be reconstructed, and its import is refused.

Rollback is available for the configured recovery period, default seven days. It uses canonical lifecycle/state commands and requires every affected record to remain at the applied version. A conflict rolls back the whole rollback transaction. Imports, previews, mappings and source-row data are private to the membership and are erased on departure/account deletion.

## Exports and history

`GET /v1/workspaces/{ws}/portability/exports/{entity}.csv` exports current, readable records. Exports enforce `record.export`, rate limits, formula neutralization and audit/security events. The headers `X-Export-Rows` and `X-Export-Truncated` explicitly identify bounded, partial results. File metadata defaults to workspace files; `?host={public-record-id}` selects a task, project or document through its file-host policy.

Read-only history types are `comments?record=…`, `task_detail?record=…`, `task_activity`, `project_activity`, `time?from=YYYY-MM-DD&to=YYYY-MM-DD`, and (7A) `ai_history`. Comment export includes paged replies. Task details include authorized relationships, checklist/criteria, labels and stable record identifiers. Time export uses explicit date bounds. History CSV contains JSON data in its `data` column and is documented as an export rather than an import schema.

`POST …/exports/audit` requires `audit.export`, fresh step-up, and the audit-export entitlement. The entitlement adapter defaults to denied and is enabled in local/test only until 10A supplies the commercial provider (OD-45). Exported audit metadata includes sequence, occurrence time, action and readable target public identifiers. It excludes changes, content, private identifiers, credential material and personal data. Phase 6D deferred AI, agent and automation history to 7A/8A/8B. Since 7A, `ai_history` exports the caller's own AI runs through the same gates: usage metadata always, and prompt, output and context only while every source is still readable to them (ADR-0038 D9). Agent and automation history remain 8A/8B.

## Exact-migration limitations

CSV is a supported-record transfer format, not a database backup. It does not reproduce account credentials, permissions, source record IDs, audit chains, computed values, signed URLs, external object bytes, historical versions, formulas' original dependency IDs, or provider secrets. Document rows carry metadata and create a draft starter; use the document Markdown/HTML export for authored content. Workflow and field rows carry supported configuration; use canonical 2C serialization for complete configuration snapshots and lineage. Reusing an exported public reference requires an authorized destination reference; cross-workspace identifiers never grant access.

Named vendor-specific import adapters are incremental post-launch work under OD-33. This phase supplies the generic column-mapping boundary; it does not claim proprietary vendor APIs or formats are implemented.
