# 15. Files, uploads, downloads, and object access

Data foundations: 0B [§4.9](../data/04-relationship-primitives.md#49-files-attachments-versions-deliverables-evidence) and [§10.8](../data/10-postgresql-guidance.md#108-object-storage).

## 15.1 Upload flow

1. **Initiate:** `POST …/uploads` (`Idempotency-Key` required) with `{file_name, content_type, byte_size, sha256, host: {id, type}, purpose}`. The server checks:
   - edit access on the host (`record.upload` action);
   - the content-type allow-list;
   - per-file and plan size limits and the storage quota (FILE-010).
   The response is an `upload-session` (`upl_…`) with a signed `PUT` URL (or multipart part URLs), the required headers (`Content-Type`, `Content-Length`, checksum header), and `expires_at` (`SIGNED_URL_LIFETIME`). The session itself expires after `UPLOAD_SESSION_LIFETIME`.
2. **Upload** goes directly to object storage into a **quarantine** prefix. The key is random (`ws/{workspace_uuid}/{random}`), with no names or secrets.
3. **Complete:** `POST …/uploads/{upl}:complete`. The server verifies size and checksum from storage metadata: a mismatch gives the `checksum_mismatch` error, and the session is `rejected`. It then creates the `file_version` (`scan_state: pending`) and enqueues the scan.
4. **Scan:** a clean file is promoted out of quarantine with `scan_state: clean`. An infected file is `infected`, never downloadable, and the uploader and admins are notified. A scanner error leaves `error`, retried, and the file stays undownloadable.
5. **Preview:** `preview_state` moves independently (`pending` → `ready`/`unsupported`/`failed`). Previews are generated only from clean versions.

## 15.2 Download flow

- `GET …/file-versions/{fv}:download` re-authorizes the caller (`record.download` action) and checks `scan_state = clean`. Otherwise:
  - pending → the `file_not_ready` error;
  - infected or error → the `file_blocked` error;
  - unreadable → the `not_found` error.
- On success: `303` to a short-lived signed GET URL (`SIGNED_URL_LIFETIME`) with `Content-Disposition: attachment` for active content types and the correct `Content-Type`. Range requests are served by storage.
- **Possession of a signed URL is not durable authorization.** URLs are short-lived, issued per authorized request, never cached across principals, and never embedded in persisted content, notifications, or exports. Exports reference API download routes instead. The residual risk of a URL leaking within its lifetime is accepted and bounded by `SIGNED_URL_LIFETIME`.

## 15.3 External links and versions

- External links (FILE-005) are `file_version` records with `source: external_url`. They are never fetched server-side, except for optional preview through an SSRF-guarded fetcher.
- Version identity is `fv_…` + `version_number`. A new upload is a new version, and objects are immutable.

## 15.4 Evidence immutability and deletion

- `evidence_locked: true` versions (accepted deliverables, defect evidence, release evidence) cannot be replaced or deleted. Attempts give the `evidence_locked` error.
- Object deletion happens only through the purge job via effects (0B §8.8), after no version references the object. Retention follows 0A/0B (`TRASH_RECOVERY_PERIOD`). Export files expire per `EXPORT_LINK_LIFETIME`.

## 15.5 As implemented (Phase 4E, [PL-36](19-decisions.md#pl-36))

- **Routes.** `GET …/storage`; `POST …/uploads`, `GET …/uploads/{upl}`, `POST …/uploads/{upl}:complete`; `GET …/files?host=`, `GET`/`PATCH …/files/{file}`, `GET …/files/{file}:download`, `…:preview`, `…:compare`, `POST …/files/{file}:trash`; `POST …/file-links`; `GET`/`POST …/tasks/{tsk}/deliverables`, `GET …/projects/{prj}/deliverables`, `GET …/deliverables/{dlv}`, `POST …/deliverables/{dlv}:submit`. The initiate body is `{host | file, name, content_type, byte_size, sha256}`, where `host` is `workspace` or a `br_`, `prj_`, `tsk_`, or `cmt_` id and `file` adds a version.
- **Keys.** Object keys carry no identifiers: `q.{64 hex}` in quarantine and `o.{same}` once promoted (replacing `ws/{workspace_uuid}/{random}` in §15.1). The row binds the key to its workspace.
- **Download.** `files/{file}:download` (current version, or `?version=`) returns `303` with `Cache-Control: no-store` to a signed GET URL valid for `SIGNED_URL_LIFETIME` (default 300 seconds), always `attachment` with an RFC 6266 file name and `nosniff`. An external link redirects to its URL; the server never fetches it. `:preview` returns a `file_url` envelope, `inline` only for raster images, audio, video, PDF, and text or code (served as `text/plain`); SVG, HTML, office, and archive formats stay `attachment`. No preview is rendered or transcoded on the server.
- **Completion.** A missing object is the retryable `file_not_ready` (`missing_object`); a size, checksum, or type mismatch rejects the session and releases its reservation. An idempotent replay of initiation signs a fresh URL.
- **Scan.** A ClamAV (stream protocol) or development test-signature scanner runs as a job per object with retries; the last of `FILE_SCAN_MAX_ATTEMPTS` failing marks the object `error` (fail closed: the bytes are deleted and the quota released). Infected bytes are deleted and the signature is never shown. Notifications to the uploader about infected files are not sent in 4E.
- **Unconfigured.** Without object storage or a scanner, `storage` says `not_configured`, readiness reports `object_storage: not_configured`, and initiating an upload is `dependency_unavailable`; external links still work.
- **Multipart.** Not implemented; one signed `PUT` up to `FILE_UPLOAD_MAX_BYTES`.
