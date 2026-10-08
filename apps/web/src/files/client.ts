import { api, ApiError, newIdempotencyKey, protectedRequest, type StepUpResolver } from '../api.ts';

/**
 * Typed client for files and deliverables (4E, ADR-0025). Bytes never pass through the API: an
 * upload is a session whose signed PUT goes straight to object storage, then `:complete` records
 * the version and the scan job decides whether it becomes Ready. Downloads are a 303 to a
 * short-lived signed GET; previews read the same URL as data.
 */

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'none';
export type Availability = 'ready' | 'scanning' | 'blocked' | 'link';
export type HostKind = 'workspace' | 'brand' | 'project' | 'task' | 'comment';

export interface PersonRef {
  id: string;
  name: string;
}

export interface FileVersion {
  number: number;
  name: string;
  kind: 'upload' | 'link';
  url: string | null;
  content_type: string | null;
  byte_size: number | null;
  sha256: string | null;
  state: Availability;
  blocked_reason: 'malware' | 'scan_failed' | null;
  preview: PreviewKind;
  evidence_locked: boolean;
  created_by: PersonRef | null;
  created_at: string;
}

export interface FileItem {
  id: string;
  type: 'file';
  name: string;
  source: 'upload' | 'external';
  host: { kind: HostKind; id: string; title: string | null };
  brand: { id: string; name: string } | null;
  owner: PersonRef | null;
  current: FileVersion | null;
  versions: FileVersion[];
  can: { upload: boolean; download: boolean; rename: boolean; trash: boolean };
  created_at: string;
  updated_at: string;
  version: number;
}

export interface FileList {
  data: FileItem[];
  host: { kind: HostKind; id: string; title: string | null };
  can_upload: boolean;
}

export interface StorageStatus {
  object_storage: 'ok' | 'not_configured' | 'unavailable';
  malware_scanner: 'ok' | 'not_configured' | 'unavailable';
  accepting_uploads: boolean;
  quota_bytes: number;
  used_bytes: number;
  reserved_bytes: number;
  objects: number;
  upload_max_bytes: number;
}

export interface UploadSession {
  id: string;
  type: 'upload_session';
  state: 'initiated' | 'completed' | 'rejected' | 'expired' | string;
  name: string;
  content_type: string;
  byte_size: number;
  rejection: string | null;
  file: string | null;
  expires_at: string;
  upload: {
    url: string;
    method: 'PUT';
    headers: Record<string, string>;
    expires_at: string;
  } | null;
  version: number;
}

export interface FileUrl {
  kind: 'object' | 'link';
  url: string;
  expires_at: string | null;
  disposition: 'inline' | 'attachment' | null;
}

export interface Comparison {
  from: FileVersion;
  to: FileVersion;
  same_content: boolean;
  size_change: number | null;
  mode: 'lines' | 'metadata';
  reason: 'format' | 'not_clean' | 'too_large' | null;
  lines: Array<{ op: 'same' | 'add' | 'remove'; text: string }> | null;
}

export type DeliverableState =
  'draft' | 'ready_for_review' | 'changes_requested' | 'accepted' | 'rejected';

export interface DeliverableVersion {
  number: number;
  source: 'file' | 'url';
  url: string | null;
  file: { id: string; version: number | null; name: string | null } | null;
  note: string | null;
  state: string;
  review: string | null;
  accepted_by: PersonRef | null;
  accepted_at: string | null;
  evidence_locked: boolean;
  submitted_by: PersonRef | null;
  created_at: string;
}

export interface Deliverable {
  id: string;
  type: 'deliverable';
  title: string;
  expected_type: 'any' | 'file' | 'url';
  state: DeliverableState;
  task: { id: string; title: string | null };
  created_by: PersonRef | null;
  versions: DeliverableVersion[];
  can: { submit: boolean; review: boolean };
  created_at: string;
  updated_at: string;
  version: number;
}

export interface DeliverableList {
  counts: {
    accepted: number;
    pending: number;
    changes_requested: number;
    rejected: number;
    draft: number;
  };
  data: Deliverable[];
}

/** Browser-side type guess when `File.type` is empty (mirrors the server's allow-list). */
const BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  rtf: 'application/rtf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  woff2: 'font/woff2',
};

export function contentTypeOf(file: { name: string; type: string }): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? '';
  // Browsers disagree on many types (and report none for most code); the server checks the
  // extension against the declared type, so prefer the allow-list's own name for it.
  return BY_EXTENSION[ext] ?? (file.type ? file.type.split(';')[0]!.trim() : 'text/plain');
}

export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1_073_741_824) return `${(n / 1_048_576).toFixed(1)} MB`;
  return `${(n / 1_073_741_824).toFixed(1)} GB`;
}

/** PUTs the bytes to the signed URL, reporting progress (0–100). Resolves on a 2xx. */
export function putBytes(
  target: NonNullable<UploadSession['upload']>,
  body: Blob,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', target.url);
    for (const [k, v] of Object.entries(target.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.floor((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(
            new ApiError({ code: 'upload_failed', status: xhr.status, message: 'Upload failed.' }),
          );
    xhr.onerror = () =>
      reject(new ApiError({ code: 'network', status: 0, message: 'Network error.' }));
    xhr.send(body);
  });
}

const w = (ws: string) => `/v1/workspaces/${ws}`;

export const files = {
  async storage(ws: string) {
    return (await api<{ data: StorageStatus }>('GET', `${w(ws)}/storage`)).body.data;
  },
  async list(ws: string, host: string) {
    const r = (await api<FileList>('GET', `${w(ws)}/files?host=${encodeURIComponent(host)}`)).body;
    return { data: r.data, host: r.host, can_upload: r.can_upload };
  },
  async get(ws: string, file: string) {
    return (await api<{ data: FileItem }>('GET', `${w(ws)}/files/${file}`)).body.data;
  },
  async initiate(
    ws: string,
    body: {
      host?: string;
      file?: string;
      name: string;
      content_type: string;
      byte_size: number;
      sha256: string;
    },
    stepUp: StepUpResolver,
    idempotencyKey: string,
  ) {
    return (
      await protectedRequest<{ data: UploadSession }>('POST', `${w(ws)}/uploads`, body, stepUp, {
        idempotencyKey,
      })
    ).body.data;
  },
  async session(ws: string, upl: string) {
    return (await api<{ data: UploadSession }>('GET', `${w(ws)}/uploads/${upl}`)).body.data;
  },
  async complete(ws: string, upl: string, stepUp: StepUpResolver, idempotencyKey: string) {
    return (
      await protectedRequest<{ data: UploadSession }>(
        'POST',
        `${w(ws)}/uploads/${upl}:complete`,
        {},
        stepUp,
        { idempotencyKey },
      )
    ).body.data;
  },
  async addLink(
    ws: string,
    body: { host: string; url: string; name?: string },
    stepUp: StepUpResolver,
  ) {
    return (await protectedRequest<{ data: FileItem }>('POST', `${w(ws)}/file-links`, body, stepUp))
      .body.data;
  },
  async rename(ws: string, file: string, name: string, version: number, stepUp: StepUpResolver) {
    return (
      await protectedRequest<{ data: FileItem }>(
        'PATCH',
        `${w(ws)}/files/${file}`,
        { name },
        stepUp,
        { ifMatch: version },
      )
    ).body.data;
  },
  async trash(ws: string, file: string, stepUp: StepUpResolver) {
    await protectedRequest('POST', `${w(ws)}/files/${file}:trash`, {}, stepUp);
  },
  downloadHref(ws: string, file: string, version?: number) {
    return `${w(ws)}/files/${file}:download${version ? `?version=${version}` : ''}`;
  },
  async preview(ws: string, file: string, version?: number) {
    return (
      await api<{ data: FileUrl }>(
        'GET',
        `${w(ws)}/files/${file}:preview${version ? `?version=${version}` : ''}`,
      )
    ).body.data;
  },
  async compare(ws: string, file: string, from: number, to: number) {
    return (
      await api<{ data: Comparison }>('GET', `${w(ws)}/files/${file}:compare?from=${from}&to=${to}`)
    ).body.data;
  },

  // ---- Deliverables ------------------------------------------------------------------------
  async deliverables(ws: string, rec: string) {
    const kind = rec.startsWith('prj_') ? 'projects' : 'tasks';
    return (await api<{ data: DeliverableList }>('GET', `${w(ws)}/${kind}/${rec}/deliverables`))
      .body.data;
  },
  async createDeliverable(
    ws: string,
    tsk: string,
    body: { title: string; expected_type: 'any' | 'file' | 'url' },
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Deliverable }>(
        'POST',
        `${w(ws)}/tasks/${tsk}/deliverables`,
        body,
        stepUp,
      )
    ).body.data;
  },
  async submit(
    ws: string,
    dlv: string,
    body: { file?: string; url?: string; note?: string; reviewers: string[] },
    version: number,
    stepUp: StepUpResolver,
  ) {
    return (
      await protectedRequest<{ data: Deliverable }>(
        'POST',
        `${w(ws)}/deliverables/${dlv}:submit`,
        body,
        stepUp,
        { ifMatch: version },
      )
    ).body.data;
  },
};

export type UploadPhase =
  | { phase: 'hashing' }
  | { phase: 'uploading'; pct: number }
  | { phase: 'finishing' }
  | { phase: 'done'; file: string | null }
  | { phase: 'failed'; error: unknown };

/**
 * The whole upload: hash, start a session, PUT the bytes, complete. Retry-safe: one Idempotency-Key
 * per step for the whole attempt, and a failed PUT asks the session for a fresh signed URL and tries
 * again (once) while the session still accepts bytes.
 */
export async function uploadFile(
  ws: string,
  target: { host: string } | { file: string },
  blob: File,
  stepUp: StepUpResolver,
  onPhase: (p: UploadPhase) => void,
  deps: { put?: typeof putBytes } = {},
): Promise<UploadSession> {
  const put = deps.put ?? putBytes;
  onPhase({ phase: 'hashing' });
  const sha256 = await sha256Hex(blob);
  const session = await files.initiate(
    ws,
    {
      ...target,
      name: blob.name,
      content_type: contentTypeOf(blob),
      byte_size: blob.size,
      sha256,
    },
    stepUp,
    newIdempotencyKey(),
  );
  onPhase({ phase: 'uploading', pct: 0 });
  const progress = (pct: number) => onPhase({ phase: 'uploading', pct });
  if (!session.upload)
    throw new ApiError({ code: 'upload_failed', status: 0, message: 'Upload failed.' });
  try {
    await put(session.upload, blob, progress);
  } catch (err) {
    const fresh = await files.session(ws, session.id);
    if (!fresh.upload) throw err;
    await put(fresh.upload, blob, progress);
  }
  onPhase({ phase: 'finishing' });
  const done = await files.complete(ws, session.id, stepUp, newIdempotencyKey());
  if (done.state === 'rejected')
    throw new ApiError({
      code: 'upload_rejected',
      status: 0,
      message: "The uploaded file didn't match what was sent. Try again.",
    });
  onPhase({ phase: 'done', file: done.file });
  return done;
}
