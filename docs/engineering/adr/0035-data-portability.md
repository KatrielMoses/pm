# ADR-0035: CSV data portability

Status: **candidate; implementation evidence is incomplete**

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
| P5 | The configured recovery window is seven days. Rollback is permitted only for imported task/project rows that remain active at the exact applied version; a newer edit causes a conflict. Other record kinds cannot be rolled back by this endpoint. |
| P6 | CSV metadata cannot create a file object or bypass quarantine. File bytes must use the existing upload, malware-scan, and storage-provider lifecycle. Without a configured scanner/storage provider, binary imports remain unavailable. |
| P7 | Imports are sequential and bounded to 2,000 rows per operation; at most one import job per membership may be running. API callers require the existing `records:read` or `records:write` scope and existing rate limits. |
| P8 | Import/export actions produce work audit entries and export/import security events. Error responses contain stable row codes and do not echo source values or inaccessible record facts. |
| P9 | Migration 0048 is reserved for 6D after accepted 6C migration 0047. When the parallel 6E branch is stacked after 6D, its currently named 0048 migration must be renumbered to 0049 and its rollback must restore 0048. Neither branch may ship with two migration 0048 files. |

## Remaining implementation work

The present code is a candidate. Workspace/brand/user/label/comment/time/activity/AI/agent/automation history imports and exports, portable goal round-tripping, file metadata import, full browser/accessibility regression coverage, and the no-skip acceptance pipeline remain unverified or incomplete. This ADR does not mark Phase 6D accepted.
