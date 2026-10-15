# 16. Imports, exports, and bulk results

## 16.1 Imports

| Stage | Contract |
|---|---|
| Source | The CSV file is uploaded as a file ([15](15-files.md)). Its `sha256` identifies the content. |
| Mapping | `transfer.import_mapping` with a monotonically increasing `mapping_version` (saved, reusable; DATA-004). Mappings reference destination fields by key and never by display name. Update uses `expected_version`; stale updates conflict. |
| Preview | `transfer.import_preview` binds the digest, schema, owner, and saved mapping version for 30 minutes. Parsing and validation do not write records. The result holds per-row stable issue codes, counts, and duplicate source keys (DATA-008). |
| Apply | `import_apply` operation (`Idempotency-Key` required) references `{preview_id, file sha256, mapping_id, mapping_version, schema_version}`. Any mismatch returns `conflict`. Authorization is rechecked by every existing destination command; one workspace import runs per owner at a time. |
| Row identity | `(import_job, row_number)` is unique, plus an optional `source_row_key` for cross-file dedupe. Re-applying the same file is detected by fingerprint. |
| Resumability | In partial mode, row commands and checkpoints are deterministic and committed separately. Interrupted requests resume unapplied rows. Atomic mode shares one transaction across canonical commands and rolls back on any failure. |
| Partial results | Operation `partial` with a `partial-result`. Per-row errors are downloadable as a CSV export of issues (DATA-006). |
| Source preservation | `transfer.import_row` keeps the original row values and the created or updated record IDs (CAP-016 spirit, 0B §7.5) |
| Rollback | `import_rollback` operation within the persisted `IMPORT_ROLLBACK_PERIOD` deadline (OD-40): created task/project/goal/document/file records are trashed, workflow/field definitions are archived as compensations, and each action requires the exact applied version. Unsupported binary imports are not accepted. |
| Stable IDs | Imported records get new public IDs. External keys are recorded as provenance (`source_ref`). Relationships in the file resolve by `source_row_key` within the import. |

Phase 6D uses bounded direct CSV responses rather than stored export artifacts. Supported metadata schemas, history exports, `@source-row-key` relationship references and exact-migration limitations are defined in [data portability](../../engineering/data-portability.md). Parent rows precede children; all references still pass canonical destination authorization. File bytes use 4E's upload/scanning lifecycle. The artifact contract below remains available for later stored-export integrations; it is not claimed by the direct CSV endpoint.

## 16.2 Exports

| Aspect | Contract |
|---|---|
| Request | `export` operation with `{scope or saved-view query, format, include: [comments, activity, …]}` (DATA-011…014) |
| Authorization | Snapshot at start, **live recheck per batch**. Only rows and fields the requester can read **at materialization** are included (field allow-lists, 0C §7.2). Workspace exports (`workspace.export` action) still exclude sensitive brands without grants (0C AT-068). |
| Progress | `progress.total` counts **authorized rows only**, computed with the same predicate. Hidden records never appear in progress, errors, or file sizes per section. |
| Artifacts | An export file (`exf_…`) in object storage. Formats: CSV, JSON/NDJSON, and attachment archives or references (DATA-014). Every file includes public IDs and relationships (DATA-012). |
| Download | `GET …/exports/{op}/files/{exf}:download` re-authorizes the requester. **If the requester's permission epoch changed since materialization, the export is marked stale and must be re-run.** This avoids per-row rechecks while guaranteeing revoked access is not served from an old file. Downloads expire after `EXPORT_LINK_LIFETIME`. |
| Audit | Every export and download is audited and raises a `security-event` of category export |

## 16.3 Bulk results

Schema `partial-result`, shared by bulk edits, imports, AI proposal application, and template installation:

- `outcome`: `succeeded`, `partial`, `failed`;
- `counts`: applied, conflict, failed, skipped, not_found;
- `items[]`: per input `{ref, status, error?, conflict?}`, where `ref` echoes the caller's input reference;
- `side_effects[]`: external effects and their states, so cancelled or partial work shows what already happened (0E ST-63).
