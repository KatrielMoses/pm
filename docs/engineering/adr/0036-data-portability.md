# ADR-0036: CSV data portability

Status: **proposed; implementation complete, acceptance pending full CI**

Date: 2026-10-14

## Context

Phase 6D adds CSV portability to a system whose record readers, file handling, and audit policies are already permission-aware. A portability endpoint must not become a second authorization path or allow imported metadata to impersonate another tenant or actor.

## Decisions

| ID | Decision |
| --- | --- |
| P1 | CSV schema version 1 uses UTF-8, RFC 4180 quoting, a 5 MiB input/output bound, at most 2,000 imported rows, 10,000 exported rows, 100 columns, and 32,000 characters per cell. Export encoding also neutralizes spreadsheet formula prefixes. |
| P2 | Export reads delegate to existing permission-filtered services. Export columns and filenames are static for the selected record type; inaccessible rows never enter counts or output. Direct exports are not retained as artifacts. |
| P3 | Import mappings are allowlisted source-column-to-field maps, stored per workspace membership. Tenant, permission, membership, actor, and internal identifier values supplied in CSV are never authoritative. Existing service commands enforce destination permissions. |
| P4 | Import provenance stores the bounded source values, source row key, resulting public identifier, and applied version. A digest plus per-row idempotency key makes retries deterministic; completed jobs replay their stored result. |
| P5 | The configured recovery window defaults to seven days. Rollback requires the exact applied version and active state; newer edits cause a conflict. Canonical commands share one transaction for atomic import and rollback, so failures leave no partially changed records. Partial import mode checkpoints rows individually. |
| P6 | CSV may create external file links only through the existing `addFileLink` command, which validates the URL and never fetches it. File bytes must use the existing upload, malware-scan, and storage-provider lifecycle. Without a configured scanner/storage provider, binary imports remain unavailable. |
| P7 | Imports are sequential and bounded to 2,000 rows per operation; at most one import job per membership may be running. API callers require the existing `records:read` or `records:write` scope and existing rate limits. |
| P8 | Import/export actions produce work audit entries and export/import security events. Error responses contain stable row codes and do not echo source values or inaccessible record facts. |
| P9 | The accepted 6E chain retains migrations 0048 (MCP access) and 0049 (MCP provenance). The parallel 6D migration is deterministically numbered 0050 and rolls back to the exact 0049 catalog. Both phase migrations and their rollback evidence remain intact. |
| P10 | OD-40 is resolved with `IMPORT_ROLLBACK_PERIOD`, default seven days and operator-configurable from one minute through 90 days. The configured value is milliseconds. Its deadline is stored per job and applies to completed and partial imports; it never changes workspace retention policy. |
| P11 | Comments, activity, and time export delegate to their existing permission-aware readers. Export capability is checked before reading data, including empty exports. Import-created tasks have immutable import origin. Departure erasure removes mapping, preview, job and row source data. |

## Scope and final verification

The seven supported metadata schemas, history exports, audit entitlement boundary and migration limitations are documented in [Data portability](../data-portability.md). Generic CSV is the launch import path. Named vendor adapters remain incremental post-launch work under OD-33; AI/agent/automation history is unavailable until 7A/8A/8B. Accounts, grants and workspace onboarding remain outside the CSV authority. Binary uploads use the existing 4E scanner/storage lifecycle. This ADR remains proposed until the architect reviews the complete CI evidence.
