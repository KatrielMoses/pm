import { randomBytes } from 'node:crypto';
import { change } from '@pm/audit';
import { newPublicId, newUuidV7, type ActionKey } from '@pm/contracts';
import { sql, type WorkspaceTransaction } from '@pm/db';
import { enqueueJob, writeOutboxEvent } from '@pm/platform';
import {
  decideBrand,
  decideWorkspace,
  findBrand,
  invalid,
  issue,
  parseIfMatch,
  requireVersion,
  TenancyError,
  type Caller,
  type BrandFacts,
  type Level,
  type Mutation,
  type Principal,
  type ProjectChain,
} from '@pm/tenancy';
import type { CollabHost } from '../collab/comment-service.ts';
import { parseReviewRequest } from '../collab/validation.ts';
import { NotificationService } from '../notify/notification-service.ts';
import {
  asText,
  canSubmit,
  cleanExternalUrl,
  cleanFileName,
  inlineType,
  lineDiff,
  linkName,
  previewKind,
  quarantineKey,
  SHA256_HEX,
  stateAfterReview,
  uploadTypeProblem,
  type DeliverableState,
} from './semantics.ts';
import type { MalwareScanner } from './scanner.ts';
import { StorageUnavailableError, type ObjectStorage } from './storage.ts';

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const ID = (prefix: string) => new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`);
const FILE_ID = ID('file');
const UPL_ID = ID('upl');
const DLV_ID = ID('dlv');
const NIL_TASK = `tsk_${'0'.repeat(26)}`;
const NIL = '00000000-0000-7000-8000-000000000000';

export const FILE_JOB_KINDS = { scan: 'files.scan', sweep: 'files.sweep' } as const;
export const FILE_QUEUE = 'default';

export type FileHostKind = 'workspace' | 'brand' | 'project' | 'task' | 'comment';

/** Where a file lives, and the authority that decides over it (always re-evaluated). */
export interface FileHost {
  kind: FileHostKind;
  /** `workspace`, or the host's (or comment's) public identifier. */
  ref: string;
  recordId: string | null;
  commentId: string | null;
  brand: { id: string; publicId: string; name: string } | null;
  title: string;
  /** Throws not_found (hidden or unknown) or forbidden (visible but not allowed). */
  decide(action: ActionKey): void;
  allows(action: ActionKey): boolean;
  /** The comment's author (comment hosts only): only the author attaches to a comment. */
  commentAuthor: string | null;
  /** Authority facts for lifecycle commands on files hosted here. */
  lc: { brand: BrandFacts | null; chain: ProjectChain };
}

interface FileRow {
  id: string;
  public_id: string;
  lifecycle_state: string;
  brand_id: string | null;
  host_kind: FileHostKind;
  host_record_id: string | null;
  comment_id: string | null;
  host_public: string | null;
  comment_public: string | null;
  name: string;
  owner_membership_id: string;
  source_kind: 'upload' | 'external';
  current_version_id: string | null;
  version_count: number;
  created_at: Date;
  updated_at: Date;
  version: string | number;
}

interface VersionRow {
  id: string;
  file_id: string;
  version_number: number;
  file_object_id: string | null;
  external_url: string | null;
  name: string;
  content_type: string | null;
  byte_size: string | null;
  sha256: Buffer | null;
  preview_state: string;
  evidence_locked: boolean;
  created_by_membership_id: string;
  created_at: Date;
  scan_state: string | null;
  storage_key: string | null;
  quarantined: boolean | null;
}

/** What the file module needs that the rest of the work service does not. */
export interface FileDeps {
  storage: ObjectStorage | null;
  scanner: MalwareScanner | null;
}

/**
 * Phase 4E files and deliverables (ADR-0026; 0B ADR-34, 0C AZ-34, 0D PL-36). Files live on a
 * workspace, brand, project, task, or comment and inherit that host's authority every time they
 * are touched: a hidden host makes its files, versions, links, previews, and downloads the same
 * `not_found` as an unknown identifier. Bytes go straight between the browser and object storage
 * through short-lived signed URLs; nothing here stores a URL or serves bytes. Uploads land in
 * quarantine and are downloadable only once a scan says `clean` (fail closed). Deliverables are
 * task outputs whose submitted versions are reviewed through 4A; an approval accepts the version
 * and evidence-locks it with the deciding review and reviewer.
 */
export class FileService extends NotificationService {
  readonly #storage: ObjectStorage | null;
  readonly #scanner: MalwareScanner | null;

  constructor(deps: ConstructorParameters<typeof NotificationService>[0] & { files?: FileDeps }) {
    super(deps);
    this.#storage = deps.files?.storage ?? null;
    this.#scanner = deps.files?.scanner ?? null;
  }

  protected get storage(): ObjectStorage | null {
    return this.#storage;
  }

  // ---------------------------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------------------------

  protected async trackFiles<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      const out = await fn();
      this.d.metrics.count('files.requests', 1, { op, outcome: 'ok' });
      return out;
    } catch (err) {
      this.d.metrics.count('files.requests', 1, {
        op,
        outcome: err instanceof TenancyError ? err.code : 'error',
      });
      throw err;
    }
  }

  /** Storage and scanning must both be configured to accept bytes (never claim either). */
  protected requireStorage(): { storage: ObjectStorage; scanner: MalwareScanner } {
    if (!this.#storage)
      throw new TenancyError('dependency_unavailable', {
        issues: [issue('/', 'storage_not_configured', 'File storage is not set up here.')],
      });
    if (!this.#scanner)
      throw new TenancyError('dependency_unavailable', {
        issues: [issue('/', 'scanner_not_configured', 'Malware scanning is not set up here.')],
      });
    return { storage: this.#storage, scanner: this.#scanner };
  }

  protected storageDown(): TenancyError {
    return new TenancyError('dependency_unavailable', {
      issues: [issue('/', 'storage_unavailable', "File storage isn't responding. Try again.")],
    });
  }

  protected async fileAudit(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    action: string,
    target: { recordId: string; type: string; publicId: string | null },
    changes: ReturnType<typeof change.plain>[],
    brandId: string | null,
  ) {
    await this.workWriter.write(tx, this.cmd(caller, p, brandId), { action, target, changes });
  }

  protected async fileEvent(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    type: Parameters<typeof writeOutboxEvent>[1]['type'],
    aggregate: { type: string; id: string; sequence: number },
    data: Record<string, string | number | boolean | null>,
    brandId: string | null,
  ) {
    await writeOutboxEvent(tx, {
      type,
      aggregate,
      data,
      actor: { type: 'human', id: p.membershipId },
      context: this.exec(caller, p),
      ...(brandId ? { brandId } : {}),
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Hosts and authority
  // ---------------------------------------------------------------------------------------------

  /**
   * Resolves a host reference (`workspace`, `br_`, `prj_`, `tsk_`, `cmt_`). Unknown, hidden, and
   * malformed references are one `not_found`, after the same statements as a missing task.
   */
  protected async fileHost(
    tx: WorkspaceTransaction,
    p: Principal,
    ref: unknown,
  ): Promise<FileHost> {
    if (ref === 'workspace') {
      const visible = (a: ActionKey) => p.kind === 'member' && decideWorkspace(p, a).allowed;
      if (!visible('record.read')) throw new TenancyError('not_found');
      return {
        kind: 'workspace',
        ref: 'workspace',
        recordId: null,
        commentId: null,
        brand: null,
        title: 'Workspace',
        decide: (a) => {
          const o = decideWorkspace(p, a);
          this.decision(a, o);
          if (!o.allowed) throw new TenancyError(o.code);
        },
        allows: visible,
        commentAuthor: null,
        lc: { brand: null, chain: [] },
      };
    }
    if (typeof ref === 'string' && ref.startsWith('br_')) {
      const b = await findBrand(tx, p, ref);
      const facts = {
        id: b.id,
        isSensitive: b.is_sensitive,
        lifecycleState: b.lifecycle_state as 'active',
      };
      if (!decideBrand(p, 'record.read', facts).allowed) throw new TenancyError('not_found');
      return {
        kind: 'brand',
        ref: b.public_id,
        recordId: b.id,
        commentId: null,
        brand: { id: b.id, publicId: b.public_id, name: b.name },
        title: b.name,
        decide: (a) => {
          const o = decideBrand(p, a, facts);
          this.decision(a, o);
          if (!o.allowed) throw new TenancyError(o.code);
        },
        allows: (a) => decideBrand(p, a, facts).allowed,
        commentAuthor: null,
        lc: { brand: facts as unknown as BrandFacts, chain: [] },
      };
    }
    if (typeof ref === 'string' && ref.startsWith('cmt_')) {
      const { row, host } = await this.loadComment(tx, p, ref);
      if ((row as { deleted_at?: Date | null }).deleted_at) throw new TenancyError('not_found');
      return {
        ...this.fromCollab(host),
        kind: 'comment',
        ref,
        commentId: row.id,
        commentAuthor: row.author_membership_id,
      };
    }
    if (typeof ref === 'string' && (ref.startsWith('prj_') || ref.startsWith('tsk_'))) {
      return this.fromCollab(await this.loadHost(tx, p, ref));
    }
    await this.loadTask(tx, p, NIL_TASK).catch(() => undefined);
    throw new TenancyError('not_found');
  }

  protected fromCollab(host: CollabHost): FileHost {
    return {
      kind: host.kind === 'project' ? 'project' : 'task',
      ref: host.publicId,
      recordId: host.id,
      commentId: null,
      brand: { id: host.brand.id, publicId: host.brand.publicId, name: host.brand.name },
      title: host.title,
      decide: (a) => host.decide(a),
      allows: (a) => host.allows(a),
      commentAuthor: null,
      lc: { brand: host.brand, chain: host.chain },
    };
  }

  /** A host may take new files only while active. */
  protected requireActiveHost(tx: WorkspaceTransaction, host: FileHost) {
    void tx;
    return host;
  }

  protected async fileRow(
    tx: WorkspaceTransaction,
    ref: unknown,
    opts: { lock?: boolean } = {},
  ): Promise<FileRow | undefined> {
    if (typeof ref !== 'string' || !FILE_ID.test(ref)) return undefined;
    return (
      await sql<FileRow>`SELECT f.id, r.public_id, r.lifecycle_state, f.brand_id, f.host_kind, f.host_record_id,
          f.comment_id, hr.public_id AS host_public, c.public_id AS comment_public, f.name,
          f.owner_membership_id, f.source_kind, f.current_version_id, f.version_count, f.created_at,
          f.updated_at, f.version
        FROM files.file f
        JOIN core.record r ON r.workspace_id = f.workspace_id AND r.id = f.id
        LEFT JOIN core.record hr ON hr.workspace_id = f.workspace_id AND hr.id = f.host_record_id
        LEFT JOIN collab.comment c ON c.workspace_id = f.workspace_id AND c.id = f.comment_id
        WHERE f.workspace_id = ${tx.workspaceId} AND r.public_id = ${ref}
        ${opts.lock ? sql`FOR UPDATE OF f` : sql``}`.execute(tx.db)
    ).rows[0];
  }

  /**
   * A file the caller may read: the host decides `record.read` now. Trashed files, hidden hosts,
   * and unknown identifiers are the same `not_found`.
   */
  protected async loadFile(
    tx: WorkspaceTransaction,
    p: Principal,
    ref: unknown,
    opts: { lock?: boolean } = {},
  ): Promise<{ row: FileRow; host: FileHost }> {
    const row = await this.fileRow(tx, ref, opts);
    if (!row || (row.lifecycle_state !== 'active' && row.lifecycle_state !== 'archived')) {
      await this.loadTask(tx, p, NIL_TASK).catch(() => undefined);
      throw new TenancyError('not_found');
    }
    const host = await this.fileHost(
      tx,
      p,
      row.host_kind === 'workspace'
        ? 'workspace'
        : row.host_kind === 'comment'
          ? row.comment_public
          : row.host_public,
    );
    host.decide('record.read');
    return { row, host };
  }

  protected async versions(tx: WorkspaceTransaction, fileIds: readonly string[]) {
    if (!fileIds.length) return [] as VersionRow[];
    return (
      await sql<VersionRow>`SELECT v.id, v.file_id, v.version_number, v.file_object_id, v.external_url, v.name,
          v.content_type, v.byte_size::text AS byte_size, v.sha256, v.preview_state, v.evidence_locked,
          v.created_by_membership_id, v.created_at, o.scan_state, o.storage_key, o.quarantined
        FROM files.file_version v
        LEFT JOIN files.file_object o ON o.workspace_id = v.workspace_id AND o.id = v.file_object_id
        WHERE v.workspace_id = ${tx.workspaceId} AND v.file_id = ANY(${[...fileIds]}::uuid[])
        ORDER BY v.file_id, v.version_number DESC`.execute(tx.db)
    ).rows;
  }

  /** The download state a person sees: ready only when the bytes are clean (fail closed). */
  protected availability(v: VersionRow): 'ready' | 'scanning' | 'blocked' | 'link' {
    if (v.external_url) return 'link';
    if (v.scan_state === 'clean') return 'ready';
    if (v.scan_state === 'pending') return 'scanning';
    return 'blocked';
  }

  protected versionView(v: VersionRow, people: Map<string, { id: string; name: string }>) {
    return {
      number: v.version_number,
      name: v.name,
      kind: v.external_url ? ('link' as const) : ('upload' as const),
      url: v.external_url,
      content_type: v.content_type,
      byte_size: v.byte_size === null ? null : Number(v.byte_size),
      sha256: v.sha256 ? v.sha256.toString('hex') : null,
      state: this.availability(v),
      // A blocked file names the reason class only (never a signature).
      blocked_reason:
        v.scan_state === 'infected' ? 'malware' : v.scan_state === 'error' ? 'scan_failed' : null,
      preview: v.external_url
        ? 'none'
        : v.scan_state === 'clean'
          ? previewKind(v.content_type)
          : 'none',
      evidence_locked: v.evidence_locked,
      created_by: people.get(v.created_by_membership_id) ?? null,
      created_at: iso(v.created_at)!,
    };
  }

  protected async people(tx: WorkspaceTransaction, p: Principal, ids: readonly string[]) {
    if (p.kind !== 'member' || !ids.length) return new Map<string, { id: string; name: string }>();
    const rows = await tx.db
      .selectFrom('tenancy.membership as m')
      .innerJoin('identity.account as a', 'a.id', 'm.account_id')
      .select(['m.id', 'm.public_id', 'm.display_name_override', 'a.display_name'])
      .where('m.id', 'in', [...new Set(ids)])
      .execute();
    return new Map(
      rows.map((m) => [m.id, { id: m.public_id, name: m.display_name_override ?? m.display_name }]),
    );
  }

  protected async fileView(tx: WorkspaceTransaction, p: Principal, row: FileRow, host: FileHost) {
    const vs = await this.versions(tx, [row.id]);
    const people = await this.people(tx, p, [
      row.owner_membership_id,
      ...vs.map((v) => v.created_by_membership_id),
    ]);
    const current = vs.find((v) => v.id === row.current_version_id) ?? null;
    return {
      id: row.public_id,
      type: 'file' as const,
      name: row.name,
      source: row.source_kind,
      host: { kind: host.kind, id: host.ref, title: host.title },
      brand: host.brand ? { id: host.brand.publicId, name: host.brand.name } : null,
      owner: people.get(row.owner_membership_id) ?? null,
      current: current ? this.versionView(current, people) : null,
      versions: vs.map((v) => this.versionView(v, people)),
      can: {
        upload: host.allows('record.upload') && row.source_kind === 'upload',
        download: host.allows('record.download'),
        rename: host.allows('record.upload'),
        trash: host.allows('record.trash'),
      },
      created_at: iso(row.created_at)!,
      updated_at: iso(row.updated_at)!,
      version: Number(row.version),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Storage status and usage (FILE-010)
  // ---------------------------------------------------------------------------------------------

  /** Whether files can be stored and scanned here, and the workspace's usage against its quota. */
  async storageStatus(caller: Caller, ws: unknown) {
    return this.trackFiles('status', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        if (p.kind !== 'member') throw new TenancyError('not_found');
        const u = await tx.db.selectFrom('files.storage_usage').selectAll().executeTakeFirst();
        let storage: 'ok' | 'not_configured' | 'unavailable' = 'not_configured';
        if (this.#storage)
          storage = await this.#storage.check().catch(() => 'unavailable' as const);
        const scanner = this.#scanner
          ? await this.#scanner.check().catch(() => 'unavailable' as const)
          : ('not_configured' as const);
        return {
          object_storage: storage,
          malware_scanner: scanner,
          accepting_uploads: storage === 'ok' && scanner === 'ok',
          quota_bytes: this.ws.workspaceStorageQuotaBytes,
          used_bytes: Number(u?.used_bytes ?? 0),
          reserved_bytes: Number(u?.reserved_bytes ?? 0),
          objects: Number(u?.object_count ?? 0),
          upload_max_bytes: this.ws.fileUploadMaxBytes,
        };
      }),
    );
  }

  /** Locks the workspace's usage row (created on first use) for a reservation or release. */
  protected async lockUsage(tx: WorkspaceTransaction) {
    await tx.db
      .insertInto('files.storage_usage')
      .values({ workspace_id: tx.workspaceId })
      .onConflict((oc) => oc.column('workspace_id').doNothing())
      .execute();
    return (
      await sql<{
        used: string;
        reserved: string;
        objects: number;
      }>`SELECT used_bytes::text AS used,
        reserved_bytes::text AS reserved, object_count AS objects FROM files.storage_usage
        WHERE workspace_id = ${tx.workspaceId} FOR UPDATE`.execute(tx.db)
    ).rows[0]!;
  }

  // ---------------------------------------------------------------------------------------------
  // Uploads (0D §15.1; FILE-001, FILE-003, FILE-004, FILE-010, FILE-011)
  // ---------------------------------------------------------------------------------------------

  protected parseUpload(body: unknown) {
    const b = isObj(body) ? body : {};
    const issues: ReturnType<typeof issue>[] = [];
    for (const k of Object.keys(b))
      if (!['host', 'file', 'name', 'content_type', 'byte_size', 'sha256'].includes(k))
        issues.push(issue(`/${k}`, 'unknown_field', 'This field is not allowed.'));
    const name = cleanFileName(b.name);
    if (!name)
      issues.push(issue('/name', 'invalid', 'Give the file a name (up to 255 characters).'));
    const contentType =
      typeof b.content_type === 'string' ? b.content_type.trim().toLowerCase() : '';
    const problem = name ? uploadTypeProblem(name, contentType) : null;
    if (problem === 'unsupported_type')
      issues.push(
        issue('/content_type', 'unsupported_type', "This kind of file can't be uploaded."),
      );
    if (problem === 'type_mismatch')
      issues.push(issue('/name', 'type_mismatch', "The file's extension doesn't match its type."));
    const size = b.byte_size;
    if (!Number.isInteger(size) || (size as number) < 0)
      issues.push(issue('/byte_size', 'invalid', 'Send the size in bytes.'));
    else if ((size as number) > this.ws.fileUploadMaxBytes)
      issues.push(
        issue(
          '/byte_size',
          'too_large',
          `Files can be at most ${Math.floor(this.ws.fileUploadMaxBytes / 1_048_576)} MB.`,
        ),
      );
    const sha = typeof b.sha256 === 'string' ? b.sha256.toLowerCase() : '';
    if (!SHA256_HEX.test(sha))
      issues.push(issue('/sha256', 'invalid', 'Send the SHA-256 of the file as 64 hex digits.'));
    if (b.host === undefined && b.file === undefined)
      issues.push(issue('/host', 'required', 'Say where the file goes.'));
    if (issues.length) throw invalid(...issues);
    return {
      host: b.host,
      file: b.file,
      name: name!,
      contentType,
      byteSize: size as number,
      sha256: sha,
    };
  }

  /**
   * Starts an upload: checks authority, type, size, and quota (reserving the bytes), and returns a
   * short-lived signed PUT to a quarantine key. Retry-safe: the same Idempotency-Key replays the
   * session with a freshly signed URL; nothing signed is ever stored.
   */
  async initiateUpload(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const input = this.parseUpload(body);
    return this.trackFiles('upload_initiate', () =>
      this.mutate(
        caller,
        'record.upload',
        ws,
        req,
        async (tx, p) => {
          const { storage } = this.requireStorage();
          let host: FileHost;
          let target: FileRow | null = null;
          if (input.file !== undefined) {
            const loaded = await this.loadFile(tx, p, input.file, { lock: true });
            if (loaded.row.source_kind !== 'upload')
              throw invalid(issue('/file', 'external_link', 'A link has no uploaded versions.'));
            if (loaded.row.version_count >= this.ws.fileVersionsMax)
              throw invalid(
                issue(
                  '/file',
                  'too_many_versions',
                  `A file keeps at most ${this.ws.fileVersionsMax} versions.`,
                ),
              );
            host = loaded.host;
            target = loaded.row;
          } else host = await this.fileHost(tx, p, input.host);
          host.decide('record.upload');
          if (host.kind === 'comment' && host.commentAuthor !== p.membershipId)
            throw new TenancyError('forbidden', {
              issues: [
                issue('/host', 'not_author', 'Only the comment author can attach files to it.'),
              ],
            });
          const usage = await this.lockUsage(tx);
          if (
            Number(usage.used) + Number(usage.reserved) + input.byteSize >
            this.ws.workspaceStorageQuotaBytes
          )
            throw new TenancyError('usage_limit_reached', {
              issues: [
                issue('/byte_size', 'quota_exceeded', 'This workspace is out of file storage.'),
              ],
            });
          await sql`UPDATE files.storage_usage SET reserved_bytes = reserved_bytes + ${input.byteSize},
              updated_at = now() WHERE workspace_id = ${tx.workspaceId}`.execute(tx.db);
          const id = newUuidV7();
          const publicId = newPublicId('upl');
          const key = quarantineKey(randomBytes(32).toString('hex'));
          const expires = new Date(Date.now() + this.ws.uploadSessionLifetimeSeconds * 1000);
          await tx.db
            .insertInto('files.upload_session')
            .values({
              id,
              public_id: publicId,
              workspace_id: tx.workspaceId,
              brand_id: host.brand?.id ?? null,
              host_kind: host.kind,
              host_record_id: host.recordId,
              comment_id: host.commentId,
              target_file_id: target?.id ?? null,
              file_name: input.name,
              content_type: input.contentType,
              byte_size: input.byteSize,
              sha256: Buffer.from(input.sha256, 'hex'),
              quarantine_object_key: key,
              expires_at: expires,
              created_by_membership_id: p.membershipId,
            })
            .execute();
          await this.fileAudit(
            tx,
            caller,
            p,
            'file.upload_started',
            {
              recordId: target?.id ?? host.recordId ?? tx.workspaceId,
              type: target ? 'file' : host.kind,
              publicId: target?.public_id ?? (host.kind === 'workspace' ? null : host.ref),
            },
            [
              change.plain('upload', null, publicId),
              change.plain('byte_size', null, input.byteSize),
              change.plain('content_type', null, input.contentType),
            ],
            host.brand?.id ?? null,
          );
          return {
            status: 201,
            ref: { id: publicId, type: 'upload_session' },
            data: await this.sessionOut(tx, p, publicId, storage),
          };
        },
        async (tx, p, ref) => this.sessionOut(tx, p, ref.id, this.requireStorage().storage),
      ),
    );
  }

  /** The caller's own upload session (a fresh signed PUT while it still accepts bytes). */
  async getUpload(caller: Caller, ws: unknown, upl: unknown) {
    return this.trackFiles('upload_get', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const { storage } = this.requireStorage();
        if (typeof upl !== 'string') throw new TenancyError('not_found');
        return this.sessionOut(tx, p, upl, storage);
      }),
    );
  }

  protected async sessionRow(tx: WorkspaceTransaction, ref: unknown, lock = false) {
    if (typeof ref !== 'string' || !UPL_ID.test(ref)) return undefined;
    return tx.db
      .selectFrom('files.upload_session')
      .selectAll()
      .where('public_id', '=', ref)
      .$if(lock, (q) => q.forUpdate())
      .executeTakeFirst();
  }

  /** The session (its creator only), with a fresh signed PUT while it still accepts bytes. */
  protected async sessionOut(
    tx: WorkspaceTransaction,
    p: Principal,
    ref: string,
    storage: ObjectStorage,
  ) {
    const s = await this.sessionRow(tx, ref);
    if (!s || s.created_by_membership_id !== p.membershipId) throw new TenancyError('not_found');
    const file = s.file_version_id
      ? ((
          await sql<{ public_id: string }>`SELECT r.public_id FROM files.file_version v
            JOIN core.record r ON r.workspace_id = v.workspace_id AND r.id = v.file_id
            WHERE v.workspace_id = ${tx.workspaceId} AND v.id = ${s.file_version_id}`.execute(tx.db)
        ).rows[0]?.public_id ?? null)
      : null;
    let upload: {
      url: string;
      method: 'PUT';
      headers: Record<string, string>;
      expires_at: string;
    } | null = null;
    if (s.state === 'initiated' && new Date(s.expires_at) > new Date()) {
      const left = Math.floor((new Date(s.expires_at).getTime() - Date.now()) / 1000);
      try {
        const pre = await storage.presignPut(s.quarantine_object_key, {
          contentType: s.content_type,
          byteSize: Number(s.byte_size),
          sha256Hex: s.sha256.toString('hex'),
          expiresInSeconds: Math.max(1, Math.min(this.ws.signedUrlLifetimeSeconds, left)),
        });
        upload = {
          url: pre.url,
          method: 'PUT',
          headers: pre.headers,
          expires_at: pre.expiresAt.toISOString(),
        };
      } catch (err) {
        if (err instanceof StorageUnavailableError) throw this.storageDown();
        throw err;
      }
    }
    return {
      id: s.public_id,
      type: 'upload_session' as const,
      state: s.state,
      name: s.file_name,
      content_type: s.content_type,
      byte_size: Number(s.byte_size),
      rejection: s.rejection_code,
      file,
      expires_at: iso(s.expires_at)!,
      upload,
      version: Number(s.version),
    };
  }

  /**
   * Verifies the uploaded object (present, exact size, checksum) and records the file version; the
   * bytes stay quarantined until the scan job promotes them. A missing object leaves the session
   * open (the browser may retry its PUT); a mismatch rejects it and releases the reservation.
   */
  async completeUpload(caller: Caller, ws: unknown, upl: unknown, req: Mutation) {
    return this.trackFiles('upload_complete', () =>
      this.mutate(
        caller,
        'record.upload',
        ws,
        req,
        async (tx, p) => {
          const { storage } = this.requireStorage();
          const s = await this.sessionRow(tx, upl, true);
          if (!s || s.created_by_membership_id !== p.membershipId)
            throw new TenancyError('not_found');
          const done = (status = 200) => ({
            status,
            ref: { id: s.public_id, type: 'upload_session' },
          });
          if (s.state === 'completed' || s.state === 'rejected')
            return { ...done(), data: await this.sessionOut(tx, p, s.public_id, storage) };
          if (s.state === 'expired' || new Date(s.expires_at) <= new Date())
            throw new TenancyError('conflict', {
              issues: [issue('/', 'upload_expired', 'This upload expired. Start it again.')],
            });
          // Authority is re-evaluated at completion (permission loss between start and finish).
          let host: FileHost;
          let target: FileRow | null = null;
          if (s.target_file_id) {
            const t = (
              await sql<{
                public_id: string;
              }>`SELECT public_id FROM core.record WHERE workspace_id = ${tx.workspaceId}
                AND id = ${s.target_file_id}`.execute(tx.db)
            ).rows[0];
            const loaded = await this.loadFile(tx, p, t?.public_id, { lock: true });
            host = loaded.host;
            target = loaded.row;
          } else host = await this.hostOfSession(tx, p, s);
          host.decide('record.upload');
          let head;
          try {
            head = await storage.head(s.quarantine_object_key);
          } catch (err) {
            if (err instanceof StorageUnavailableError) throw this.storageDown();
            throw err;
          }
          if (!head)
            throw new TenancyError('file_not_ready', {
              issues: [
                issue(
                  '/',
                  'missing_object',
                  "The file hasn't arrived yet. Upload it, then try again.",
                ),
              ],
            });
          const declared = s.sha256.toString('hex');
          let actual = head.sha256Hex;
          if (head.byteSize === Number(s.byte_size) && !actual) {
            const { sha256Hex } = await import('./storage.ts');
            actual = sha256Hex(
              await storage.read(s.quarantine_object_key, { maxBytes: Number(s.byte_size) }),
            );
          }
          const reject =
            head.byteSize !== Number(s.byte_size)
              ? 'size_mismatch'
              : actual !== declared
                ? 'checksum_mismatch'
                : head.contentType &&
                    head.contentType.split(';')[0]!.trim().toLowerCase() !== s.content_type
                  ? 'type_mismatch'
                  : null;
          if (reject) {
            await this.rejectSession(tx, s.id, Number(s.byte_size), reject);
            await storage.delete(s.quarantine_object_key).catch(() => undefined);
            this.d.metrics.count('upload.completed', 1, { outcome: reject });
            if (reject === 'checksum_mismatch')
              throw new TenancyError('checksum_mismatch', {
                issues: [
                  issue('/', 'checksum_mismatch', "The uploaded file didn't match its checksum."),
                ],
              });
            throw invalid(issue('/', reject, "The uploaded file didn't match what was declared."));
          }
          const objectId = newUuidV7();
          await tx.db
            .insertInto('files.file_object')
            .values({
              id: objectId,
              workspace_id: tx.workspaceId,
              storage_key: s.quarantine_object_key,
              sha256: s.sha256,
              byte_size: Number(s.byte_size),
              content_type: s.content_type,
            })
            .execute();
          // The reservation becomes usage now; infected or failed objects release it later.
          await sql`UPDATE files.storage_usage SET reserved_bytes = greatest(reserved_bytes - ${Number(s.byte_size)}, 0),
              used_bytes = used_bytes + ${Number(s.byte_size)}, object_count = object_count + 1, updated_at = now()
              WHERE workspace_id = ${tx.workspaceId}`.execute(tx.db);
          const made = await this.addVersion(tx, caller, p, host, target, {
            name: s.file_name,
            objectId,
            contentType: s.content_type,
            byteSize: Number(s.byte_size),
            sha256: s.sha256,
            url: null,
          });
          await tx.db
            .updateTable('files.upload_session')
            .set({
              state: 'completed',
              file_object_id: objectId,
              file_version_id: made.versionId,
              updated_at: new Date(),
              version: Number(s.version) + 1,
            })
            .where('id', '=', s.id)
            .execute();
          await enqueueJob(tx, {
            queue: FILE_QUEUE,
            kind: FILE_JOB_KINDS.scan,
            context: this.exec(caller, p),
            payloadRef: objectId,
            dedupeKey: `files.scan:${objectId}`,
            maxAttempts: this.ws.fileScanMaxAttempts,
            timeoutSeconds: 300,
          });
          this.d.metrics.count('upload.completed', 1, { outcome: 'ok' });
          return { ...done(), data: await this.sessionOut(tx, p, s.public_id, storage) };
        },
        async (tx, p, ref) => this.sessionOut(tx, p, ref.id, this.requireStorage().storage),
      ),
    );
  }

  protected async hostOfSession(
    tx: WorkspaceTransaction,
    p: Principal,
    s: { host_kind: string; host_record_id: string | null; comment_id: string | null },
  ) {
    if (s.host_kind === 'workspace') return this.fileHost(tx, p, 'workspace');
    const ref = (
      await sql<{ ref: string }>`SELECT ${
        s.host_kind === 'comment'
          ? sql`c.public_id FROM collab.comment c WHERE c.workspace_id = ${tx.workspaceId} AND c.id = ${s.comment_id}`
          : sql`r.public_id FROM core.record r WHERE r.workspace_id = ${tx.workspaceId} AND r.id = ${s.host_record_id}`
      }`.execute(tx.db)
    ).rows[0] as unknown as { public_id?: string; ref?: string } | undefined;
    return this.fileHost(tx, p, ref?.public_id ?? ref?.ref ?? null);
  }

  protected async rejectSession(
    tx: WorkspaceTransaction,
    sessionId: string,
    bytes: number,
    code: string,
  ) {
    await sql`UPDATE files.upload_session SET state = 'rejected', rejection_code = ${code}, updated_at = now(),
        version = version + 1 WHERE workspace_id = ${tx.workspaceId} AND id = ${sessionId}`.execute(
      tx.db,
    );
    await sql`UPDATE files.storage_usage SET reserved_bytes = greatest(reserved_bytes - ${bytes}, 0),
        updated_at = now() WHERE workspace_id = ${tx.workspaceId}`.execute(tx.db);
  }

  /** Creates the file on first version, or appends a version (row-locked) and moves `current`. */
  protected async addVersion(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    host: FileHost,
    target: FileRow | null,
    v: {
      name: string;
      objectId: string | null;
      contentType: string | null;
      byteSize: number | null;
      sha256: Buffer | null;
      url: string | null;
    },
  ): Promise<{ fileId: string; publicId: string; versionId: string; number: number }> {
    let fileId = target?.id;
    let publicId = target?.public_id;
    let number = (target?.version_count ?? 0) + 1;
    if (!target) {
      const count = await sql<{ n: number }>`SELECT count(*)::int AS n FROM files.file
          WHERE workspace_id = ${tx.workspaceId}
            AND ${host.kind === 'workspace' ? sql`host_kind = 'workspace'` : host.kind === 'comment' ? sql`comment_id = ${host.commentId}` : sql`host_record_id = ${host.recordId} AND comment_id IS NULL`}`.execute(
        tx.db,
      );
      if (count.rows[0]!.n >= this.ws.filesListMax)
        throw invalid(
          issue('/host', 'too_many_files', `A record holds at most ${this.ws.filesListMax} files.`),
        );
      fileId = newUuidV7();
      publicId = newPublicId('file');
      number = 1;
      const cmd = this.cmd(caller, p, host.brand?.id ?? null);
      await tx.db
        .insertInto('core.record')
        .values({
          id: fileId,
          public_id: publicId,
          record_type: 'file',
          workspace_id: tx.workspaceId,
          brand_id: host.brand?.id ?? null,
          source_kind: 'ui',
          source_ref: null,
          created_by_actor_type: cmd.actor.type,
          created_by_actor_id: cmd.actor.id,
        })
        .execute();
      await tx.db
        .insertInto('files.file')
        .values({
          id: fileId,
          workspace_id: tx.workspaceId,
          brand_id: host.brand?.id ?? null,
          scope_key: host.brand?.id ?? tx.workspaceId,
          host_kind: host.kind,
          host_record_id: host.recordId,
          comment_id: host.commentId,
          name: v.name,
          owner_membership_id: p.membershipId,
          source_kind: v.url ? 'external' : 'upload',
        })
        .execute();
    }
    const versionId = newUuidV7();
    await tx.db
      .insertInto('files.file_version')
      .values({
        id: versionId,
        workspace_id: tx.workspaceId,
        file_id: fileId!,
        version_number: number,
        file_object_id: v.objectId,
        external_url: v.url,
        name: v.name,
        content_type: v.contentType,
        byte_size: v.byteSize,
        sha256: v.sha256,
        preview_state: v.url ? 'unsupported' : 'pending',
        created_by_membership_id: p.membershipId,
      })
      .execute();
    await tx.db
      .updateTable('files.file')
      .set({
        current_version_id: versionId,
        version_count: number,
        ...(target ? { name: v.name } : {}),
        updated_at: new Date(),
        version: target ? Number(target.version) + 1 : 0,
      })
      .where('id', '=', fileId!)
      .execute();
    await this.fileAudit(
      tx,
      caller,
      p,
      target ? 'file.version_added' : v.url ? 'file.linked' : 'file.uploaded',
      { recordId: fileId!, type: 'file', publicId: publicId! },
      [
        change.plain('version', null, number),
        change.plain('host_kind', null, host.kind),
        ...(v.byteSize !== null ? [change.plain('byte_size', null, v.byteSize)] : []),
        ...(v.contentType ? [change.plain('content_type', null, v.contentType)] : []),
      ],
      host.brand?.id ?? null,
    );
    await this.fileEvent(
      tx,
      caller,
      p,
      target ? 'files.file.version_added' : 'files.file.added',
      { type: 'files.file', id: fileId!, sequence: number },
      { version_number: number, source: v.url ? 'external' : 'upload' },
      host.brand?.id ?? null,
    );
    return { fileId: fileId!, publicId: publicId!, versionId, number };
  }

  // ---------------------------------------------------------------------------------------------
  // External links (FILE-005): never fetched, never copied
  // ---------------------------------------------------------------------------------------------

  async addFileLink(caller: Caller, ws: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    for (const k of Object.keys(b))
      if (!['host', 'url', 'name'].includes(k))
        throw invalid(issue(`/${k}`, 'unknown_field', 'This field is not allowed.'));
    const url = cleanExternalUrl(b.url);
    if (!url)
      throw invalid(issue('/url', 'invalid', 'Use a full http or https link without a password.'));
    const name = b.name === undefined ? linkName(url) : cleanFileName(b.name);
    if (!name)
      throw invalid(issue('/name', 'invalid', 'Give the link a name (up to 255 characters).'));
    return this.trackFiles('link', () =>
      this.mutate(
        caller,
        'record.upload',
        ws,
        req,
        async (tx, p) => {
          const host = await this.fileHost(tx, p, b.host);
          host.decide('record.upload');
          if (host.kind === 'comment' && host.commentAuthor !== p.membershipId)
            throw new TenancyError('forbidden', {
              issues: [
                issue('/host', 'not_author', 'Only the comment author can attach links to it.'),
              ],
            });
          const made = await this.addVersion(tx, caller, p, host, null, {
            name,
            objectId: null,
            contentType: null,
            byteSize: null,
            sha256: null,
            url,
          });
          const loaded = await this.loadFile(tx, p, made.publicId);
          return {
            status: 201,
            ref: { id: made.publicId, type: 'file' },
            data: await this.fileView(tx, p, loaded.row, loaded.host),
          };
        },
        async (tx, p, ref) => {
          const loaded = await this.loadFile(tx, p, ref.id);
          return this.fileView(tx, p, loaded.row, loaded.host);
        },
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Reading, renaming, and listing (FILE-003, FILE-012)
  // ---------------------------------------------------------------------------------------------

  async listFiles(caller: Caller, ws: unknown, hostRef: unknown) {
    return this.trackFiles('list', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const host = await this.fileHost(tx, p, hostRef);
        host.decide('record.read');
        const rows = (
          await sql<FileRow>`SELECT f.id, r.public_id, r.lifecycle_state, f.brand_id, f.host_kind, f.host_record_id,
              f.comment_id, NULL AS host_public, NULL AS comment_public, f.name, f.owner_membership_id,
              f.source_kind, f.current_version_id, f.version_count, f.created_at, f.updated_at, f.version
            FROM files.file f JOIN core.record r ON r.workspace_id = f.workspace_id AND r.id = f.id
            WHERE f.workspace_id = ${tx.workspaceId} AND r.lifecycle_state IN ('active', 'archived')
              AND ${
                host.kind === 'workspace'
                  ? sql`f.host_kind = 'workspace'`
                  : host.kind === 'comment'
                    ? sql`f.comment_id = ${host.commentId}`
                    : sql`f.host_record_id = ${host.recordId} AND f.comment_id IS NULL`
              }
            ORDER BY f.created_at DESC, f.id DESC LIMIT ${this.ws.filesListMax}`.execute(tx.db)
        ).rows;
        const out = [];
        for (const r of rows) out.push(await this.fileView(tx, p, r, host));
        return {
          host: { kind: host.kind, id: host.ref, title: host.title },
          can_upload:
            host.allows('record.upload') &&
            (host.kind !== 'comment' || host.commentAuthor === p.membershipId),
          data: out,
        };
      }),
    );
  }

  async getFile(caller: Caller, ws: unknown, file: unknown) {
    return this.trackFiles('get', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const { row, host } = await this.loadFile(tx, p, file);
        return this.fileView(tx, p, row, host);
      }),
    );
  }

  async renameFile(caller: Caller, ws: unknown, file: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    const name = cleanFileName(b.name);
    if (!name)
      throw invalid(issue('/name', 'invalid', 'Give the file a name (up to 255 characters).'));
    return this.trackFiles('rename', () =>
      this.mutate(
        caller,
        'record.upload',
        ws,
        req,
        async (tx, p) => {
          const { row, host } = await this.loadFile(tx, p, file, { lock: true });
          host.decide('record.upload');
          const expected =
            req.ifMatch !== undefined
              ? parseIfMatch(req.ifMatch)
              : (b.version as number | undefined);
          if (expected === undefined) throw new TenancyError('precondition_required');
          requireVersion(expected, Number(row.version));
          await tx.db
            .updateTable('files.file')
            .set({ name, updated_at: new Date(), version: Number(row.version) + 1 })
            .where('id', '=', row.id)
            .execute();
          await this.fileAudit(
            tx,
            caller,
            p,
            'file.renamed',
            { recordId: row.id, type: 'file', publicId: row.public_id },
            [change.plain('name', row.name, name)],
            host.brand?.id ?? null,
          );
          const fresh = await this.loadFile(tx, p, row.public_id);
          return {
            status: 200,
            ref: { id: row.public_id, type: 'file' },
            data: await this.fileView(tx, p, fresh.row, fresh.host),
          };
        },
        async (tx, p, ref) => {
          const loaded = await this.loadFile(tx, p, ref.id);
          return this.fileView(tx, p, loaded.row, loaded.host);
        },
      ),
    );
  }

  /**
   * Moves a file to trash through the lifecycle core (FILE-013): versions and objects stay until
   * purge, which removes rows and records object deletions as external effects. Evidence-locked
   * versions (accepted deliverables) are never removed.
   */
  async trashFile(caller: Caller, ws: unknown, file: unknown, req: Mutation) {
    return this.trackFiles('trash', () =>
      this.mutate(
        caller,
        'record.trash',
        ws,
        req,
        async (tx, p) => {
          const { row, host } = await this.loadFile(tx, p, file, { lock: true });
          host.decide('record.trash');
          const locked = await tx.db
            .selectFrom('files.file_version')
            .select('id')
            .where('file_id', '=', row.id)
            .where('evidence_locked', '=', true)
            .executeTakeFirst();
          if (locked)
            throw new TenancyError('evidence_locked', {
              issues: [issue('/', 'evidence_locked', 'An accepted deliverable uses this file.')],
            });
          await this.d.lifecycle.trash(
            tx,
            this.issueLifecycle(tx, p, 'record.trash', {
              id: row.id,
              brand: host.lc.brand,
              lifecycleState: row.lifecycle_state as 'active' | 'archived',
              chain: host.lc.chain,
            }),
            { exec: this.exec(caller, p), source: { kind: 'ui' as const } },
            row.id,
          );
          return {
            status: 200,
            ref: { id: row.public_id, type: 'file' },
            data: { id: row.public_id, type: 'file', trashed: true },
          };
        },
        async (_tx, _p, ref) => ({ id: ref.id, type: 'file', trashed: true }),
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Downloads and previews (FILE-002, FILE-012): clean bytes only, short-lived signed GETs
  // ---------------------------------------------------------------------------------------------

  protected async pickVersion(tx: WorkspaceTransaction, row: FileRow, n: unknown) {
    const vs = await this.versions(tx, [row.id]);
    if (n === undefined || n === null || n === 'current')
      return vs.find((v) => v.id === row.current_version_id);
    const num = typeof n === 'string' ? Number(n) : n;
    return Number.isInteger(num) ? vs.find((v) => v.version_number === num) : undefined;
  }

  /**
   * A signed GET for one version. `inline` is honoured only for formats that render without
   * running content (otherwise it is an attachment); external links return the link itself.
   * Pending scans are `file_not_ready`; infected or failed scans are `file_blocked`.
   */
  async fileUrl(
    caller: Caller,
    ws: unknown,
    file: unknown,
    query: { version?: unknown; disposition?: unknown },
  ) {
    return this.trackFiles(query.disposition === 'inline' ? 'preview' : 'download', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const { row, host } = await this.loadFile(tx, p, file);
        host.decide('record.download');
        const v = await this.pickVersion(tx, row, query.version);
        if (!v) throw new TenancyError('not_found');
        if (v.external_url)
          return {
            kind: 'link' as const,
            url: v.external_url,
            expires_at: null,
            disposition: null,
          };
        if (v.scan_state === 'pending')
          throw new TenancyError('file_not_ready', {
            issues: [issue('/', 'scanning', 'This file is still being checked.')],
          });
        if (v.scan_state !== 'clean' || v.quarantined)
          throw new TenancyError('file_blocked', {
            issues: [
              issue(
                '/',
                v.scan_state === 'infected' ? 'malware' : 'scan_failed',
                "This file can't be downloaded.",
              ),
            ],
          });
        const inline = query.disposition === 'inline' ? inlineType(v.content_type) : null;
        const storage = this.#storage;
        if (!storage) throw this.requireStorage() as never;
        try {
          const pre = await storage.presignGet(v.storage_key!, {
            filename: v.name,
            contentType: inline ?? v.content_type ?? 'application/octet-stream',
            disposition: inline ? 'inline' : 'attachment',
            expiresInSeconds: this.ws.signedUrlLifetimeSeconds,
          });
          return {
            kind: 'object' as const,
            url: pre.url,
            expires_at: pre.expiresAt.toISOString(),
            disposition: inline ? ('inline' as const) : ('attachment' as const),
          };
        } catch (err) {
          if (err instanceof StorageUnavailableError) throw this.storageDown();
          throw err;
        }
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Comparisons (FILE-008): bounded
  // ---------------------------------------------------------------------------------------------

  async compareVersions(
    caller: Caller,
    ws: unknown,
    file: unknown,
    query: { from?: unknown; to?: unknown },
  ) {
    return this.trackFiles('compare', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const { row, host } = await this.loadFile(tx, p, file);
        host.decide('record.download');
        const a = await this.pickVersion(tx, row, query.from);
        const b = await this.pickVersion(tx, row, query.to ?? 'current');
        if (!a || !b) throw new TenancyError('not_found');
        const people = await this.people(tx, p, [
          a.created_by_membership_id,
          b.created_by_membership_id,
        ]);
        const meta = {
          from: this.versionView(a, people),
          to: this.versionView(b, people),
          same_content: !!a.sha256 && !!b.sha256 && a.sha256.equals(b.sha256),
          size_change:
            a.byte_size !== null && b.byte_size !== null
              ? Number(b.byte_size) - Number(a.byte_size)
              : null,
        };
        const textual =
          previewKind(a.content_type) === 'text' && previewKind(b.content_type) === 'text';
        if (!textual)
          return { ...meta, mode: 'metadata' as const, reason: 'format' as const, lines: null };
        for (const v of [a, b]) {
          if (v.scan_state !== 'clean')
            return {
              ...meta,
              mode: 'metadata' as const,
              reason: 'not_clean' as const,
              lines: null,
            };
          if (Number(v.byte_size) > this.ws.fileCompareMaxBytes)
            return {
              ...meta,
              mode: 'metadata' as const,
              reason: 'too_large' as const,
              lines: null,
            };
        }
        const storage = this.#storage;
        if (!storage) throw this.requireStorage() as never;
        let ta: string | null;
        let tb: string | null;
        try {
          ta = asText(
            await storage.read(a.storage_key!, { maxBytes: this.ws.fileCompareMaxBytes }),
          );
          tb = asText(
            await storage.read(b.storage_key!, { maxBytes: this.ws.fileCompareMaxBytes }),
          );
        } catch (err) {
          if (err instanceof StorageUnavailableError) throw this.storageDown();
          throw err;
        }
        const lines = ta !== null && tb !== null ? lineDiff(ta, tb) : null;
        return lines
          ? { ...meta, mode: 'lines' as const, reason: null, lines }
          : { ...meta, mode: 'metadata' as const, reason: 'too_large' as const, lines: null };
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Deliverables (FILE-006–FILE-009, PRJ-023, TSK-022)
  // ---------------------------------------------------------------------------------------------

  protected async deliverableRow(tx: WorkspaceTransaction, ref: unknown, lock = false) {
    if (typeof ref !== 'string' || !DLV_ID.test(ref)) return undefined;
    return (
      await sql<{
        id: string;
        public_id: string;
        lifecycle_state: string;
        task_id: string;
        task_public: string;
        brand_id: string;
        title: string;
        expected_type: 'any' | 'file' | 'url';
        state: DeliverableState;
        current_version_id: string | null;
        accepted_version_id: string | null;
        created_by_membership_id: string;
        created_at: Date;
        updated_at: Date;
        version: string;
      }>`SELECT d.id, r.public_id, r.lifecycle_state, d.task_id, tr.public_id AS task_public, d.brand_id, d.title,
          d.expected_type, d.state, d.current_version_id, d.accepted_version_id, d.created_by_membership_id,
          d.created_at, d.updated_at, d.version::text AS version
        FROM files.deliverable d
        JOIN core.record r ON r.workspace_id = d.workspace_id AND r.id = d.id
        JOIN core.record tr ON tr.workspace_id = d.workspace_id AND tr.id = d.task_id
        WHERE d.workspace_id = ${tx.workspaceId} AND r.public_id = ${ref}
        ${lock ? sql`FOR UPDATE OF d` : sql``}`.execute(tx.db)
    ).rows[0];
  }

  /**
   * 4A host for a deliverable: its own record (comments, reviews, and decisions attach to it),
   * decided through its task (the deliverable has no grants of its own).
   */
  protected override async loadHost(
    tx: WorkspaceTransaction,
    p: Principal,
    rec: unknown,
    opts: { lock?: boolean } = {},
  ): Promise<CollabHost> {
    if (typeof rec !== 'string' || !rec.startsWith('dlv_')) return super.loadHost(tx, p, rec, opts);
    const d = await this.deliverableRow(tx, rec, opts.lock);
    if (!d || d.lifecycle_state === 'trashed' || d.lifecycle_state === 'purged') {
      await this.loadTask(tx, p, NIL_TASK).catch(() => undefined);
      throw new TenancyError('not_found');
    }
    const task = await super.loadHost(tx, p, d.task_public);
    return {
      ...task,
      kind: 'deliverable' as CollabHost['kind'],
      id: d.id,
      publicId: d.public_id,
      title: d.title,
      lifecycleState: d.lifecycle_state as CollabHost['lifecycleState'],
      version: Number(d.version),
      task: task.task,
    };
  }

  /** Reviewer eligibility for a deliverable is eligibility on its task. */
  protected override async memberReaches(
    tx: WorkspaceTransaction,
    host: CollabHost,
    m: { id: string; account_id: string; kind: 'member' | 'guest' },
    need: Level,
  ): Promise<boolean> {
    if ((host.kind as string) !== 'deliverable') return super.memberReaches(tx, host, m, need);
    return super.memberReaches(
      tx,
      { ...host, kind: 'task', id: host.task!.id, publicId: host.task!.publicId },
      m,
      need,
    );
  }

  protected async deliverableView(tx: WorkspaceTransaction, p: Principal, ref: string) {
    const d = (await this.deliverableRow(tx, ref))!;
    const host = await this.loadHost(tx, p, ref);
    const vs = (
      await sql<{
        id: string;
        version_number: number;
        source_kind: 'file' | 'url';
        url: string | null;
        note_text: string | null;
        state: string;
        file_public: string | null;
        file_version_number: number | null;
        file_name: string | null;
        review_public: string | null;
        accepted_by_membership_id: string | null;
        accepted_at: Date | null;
        evidence_locked: boolean;
        submitted_by_membership_id: string;
        created_at: Date;
      }>`SELECT v.id, v.version_number, v.source_kind, v.url, v.note_text, v.state, fr.public_id AS file_public,
          fv.version_number AS file_version_number, fv.name AS file_name, q.public_id AS review_public,
          v.accepted_by_membership_id, v.accepted_at, v.evidence_locked, v.submitted_by_membership_id, v.created_at
        FROM files.deliverable_version v
        LEFT JOIN files.file_version fv ON fv.workspace_id = v.workspace_id AND fv.id = v.file_version_id
        LEFT JOIN core.record fr ON fr.workspace_id = fv.workspace_id AND fr.id = fv.file_id
        LEFT JOIN collab.review_request q ON q.workspace_id = v.workspace_id AND q.id = v.review_request_id
        WHERE v.workspace_id = ${tx.workspaceId} AND v.deliverable_id = ${d.id}
        ORDER BY v.version_number DESC`.execute(tx.db)
    ).rows;
    const people = await this.people(tx, p, [
      d.created_by_membership_id,
      ...vs.flatMap((v) => [v.submitted_by_membership_id, v.accepted_by_membership_id ?? NIL]),
    ]);
    return {
      id: d.public_id,
      type: 'deliverable' as const,
      title: d.title,
      expected_type: d.expected_type,
      state: d.state,
      task: { id: d.task_public, title: host.task?.row.title ?? null },
      created_by: people.get(d.created_by_membership_id) ?? null,
      versions: vs.map((v) => ({
        number: v.version_number,
        source: v.source_kind,
        url: v.url,
        file: v.file_public
          ? { id: v.file_public, version: v.file_version_number, name: v.file_name }
          : null,
        note: v.note_text,
        state: v.state,
        review: v.review_public,
        // FILE-009: who accepted, and when.
        accepted_by: v.accepted_by_membership_id
          ? (people.get(v.accepted_by_membership_id) ?? null)
          : null,
        accepted_at: iso(v.accepted_at),
        evidence_locked: v.evidence_locked,
        submitted_by: people.get(v.submitted_by_membership_id) ?? null,
        created_at: iso(v.created_at)!,
      })),
      can: {
        submit: host.allows('deliverable.submit') && canSubmit(d.state),
        review: host.allows('review.decide'),
      },
      created_at: iso(d.created_at)!,
      updated_at: iso(d.updated_at)!,
      version: Number(d.version),
    };
  }

  /** Marks expected output on a task (FILE-006, TSK-022). */
  async createDeliverable(caller: Caller, ws: unknown, tsk: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    for (const k of Object.keys(b))
      if (!['title', 'expected_type'].includes(k))
        throw invalid(issue(`/${k}`, 'unknown_field', 'This field is not allowed.'));
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    if (title.length < 1 || title.length > 200)
      throw invalid(issue('/title', 'invalid', 'Name the deliverable (up to 200 characters).'));
    const expected = b.expected_type ?? 'any';
    if (!['any', 'file', 'url'].includes(expected as string))
      throw invalid(issue('/expected_type', 'invalid_option', 'Choose any, file, or url.'));
    return this.trackFiles('deliverable_create', () =>
      this.mutate(
        caller,
        'deliverable.submit',
        ws,
        req,
        async (tx, p) => {
          const task = await this.loadTask(tx, p, tsk, { lock: true });
          this.requireTaskAction(p, 'deliverable.submit', task, {
            shares: false,
            excluded: 'forbidden',
          });
          const n = await sql<{ n: number }>`SELECT count(*)::int AS n FROM files.deliverable d
              JOIN core.record r ON r.workspace_id = d.workspace_id AND r.id = d.id
              WHERE d.workspace_id = ${tx.workspaceId} AND d.task_id = ${task.id}
                AND r.lifecycle_state <> 'purged'`.execute(tx.db);
          if (n.rows[0]!.n >= this.ws.deliverablesPerTaskMax)
            throw invalid(
              issue(
                '/',
                'too_many',
                `A task holds at most ${this.ws.deliverablesPerTaskMax} deliverables.`,
              ),
            );
          const id = newUuidV7();
          const publicId = newPublicId('dlv');
          const cmd = this.cmd(caller, p, task.brand.id);
          await tx.db
            .insertInto('core.record')
            .values({
              id,
              public_id: publicId,
              record_type: 'deliverable',
              workspace_id: tx.workspaceId,
              brand_id: task.brand.id,
              source_kind: 'ui',
              source_ref: null,
              created_by_actor_type: cmd.actor.type,
              created_by_actor_id: cmd.actor.id,
            })
            .execute();
          await tx.db
            .insertInto('files.deliverable')
            .values({
              id,
              workspace_id: tx.workspaceId,
              brand_id: task.brand.id,
              task_id: task.id,
              title,
              expected_type: expected as 'any' | 'file' | 'url',
              created_by_membership_id: p.membershipId,
            })
            .execute();
          await this.fileAudit(
            tx,
            caller,
            p,
            'deliverable.created',
            { recordId: id, type: 'deliverable', publicId },
            [
              change.plain('task', null, task.publicId),
              change.plain('expected_type', null, expected as string),
            ],
            task.brand.id,
          );
          return {
            status: 201,
            ref: { id: publicId, type: 'deliverable' },
            data: await this.deliverableView(tx, p, publicId),
          };
        },
        async (tx, p, ref) => this.deliverableView(tx, p, ref.id),
      ),
    );
  }

  async listDeliverables(caller: Caller, ws: unknown, rec: unknown) {
    return this.trackFiles('deliverable_list', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        let where;
        if (typeof rec === 'string' && rec.startsWith('prj_')) {
          const pr = await this.loadProject(tx, p, rec);
          this.requireProjectAction(p, 'record.read', pr);
          where = sql`t.project_id = ${pr.id}`;
        } else {
          const t = await this.loadTask(tx, p, rec);
          this.requireTaskAction(p, 'record.read', t);
          where = sql`d.task_id = ${t.id}`;
        }
        // Only deliverables whose task the caller can read (a project lists many tasks).
        const vis = await this.taskVisibility(tx, p, true);
        const rows = (
          await sql<{ public_id: string; state: DeliverableState }>`SELECT r.public_id, d.state
            FROM files.deliverable d
            JOIN core.record r ON r.workspace_id = d.workspace_id AND r.id = d.id
            JOIN work.task t ON t.workspace_id = d.workspace_id AND t.id = d.task_id
            JOIN core.record tr ON tr.workspace_id = t.workspace_id AND tr.id = t.id
            WHERE d.workspace_id = ${tx.workspaceId} AND r.lifecycle_state IN ('active', 'archived')
              AND ${where} AND ${vis.where('tr', { project: sql`t.project_id` })}
            ORDER BY d.created_at, d.id LIMIT ${this.ws.filesListMax}`.execute(tx.db)
        ).rows;
        const data = [];
        for (const r of rows) data.push(await this.deliverableView(tx, p, r.public_id));
        const counts = { accepted: 0, pending: 0, changes_requested: 0, rejected: 0, draft: 0 };
        for (const r of rows) counts[r.state === 'ready_for_review' ? 'pending' : r.state] += 1;
        // PRJ-023: accepted versus pending (anything not yet accepted or rejected is pending work).
        return { counts, data };
      }),
    );
  }

  async getDeliverable(caller: Caller, ws: unknown, dlv: unknown) {
    return this.trackFiles('deliverable_get', () =>
      this.inWorkspace(caller, ws, { readOnly: true }, async (tx, p) => {
        const host = await this.loadHost(tx, p, dlv);
        host.decide('record.read');
        return this.deliverableView(tx, p, host.publicId);
      }),
    );
  }

  /**
   * Submits a version for review (FILE-007): a file of this task (its current version) or a URL,
   * and the 4A review request in the same transaction. A previous open review of this deliverable
   * is superseded; an accepted deliverable takes no more versions.
   */
  async submitDeliverable(caller: Caller, ws: unknown, dlv: unknown, body: unknown, req: Mutation) {
    const b = isObj(body) ? body : {};
    for (const k of Object.keys(b))
      if (!['file', 'url', 'note', 'reviewers', 'rule', 'version'].includes(k))
        throw invalid(issue(`/${k}`, 'unknown_field', 'This field is not allowed.'));
    if ((b.file === undefined) === (b.url === undefined))
      throw invalid(issue('/', 'source_required', 'Submit either a file or a link.'));
    const url = b.url === undefined ? null : cleanExternalUrl(b.url);
    if (b.url !== undefined && !url)
      throw invalid(issue('/url', 'invalid', 'Use a full http or https link without a password.'));
    const note =
      b.note === undefined || b.note === null
        ? null
        : typeof b.note === 'string'
          ? b.note.trim()
          : '';
    if (note !== null && (note.length < 1 || note.length > 2000))
      throw invalid(issue('/note', 'invalid', 'Keep the note to 2000 characters.'));
    const review = parseReviewRequest(
      {
        reviewers: b.reviewers,
        ...(b.rule !== undefined ? { rule: b.rule } : {}),
        kind: 'approval',
      },
      this.ws.reviewReviewersMax,
    );
    return this.trackFiles('deliverable_submit', () =>
      this.mutate(
        caller,
        'deliverable.submit',
        ws,
        req,
        async (tx, p) => {
          const d = await this.deliverableRow(tx, dlv, true);
          const host = await this.loadHost(tx, p, dlv);
          host.decide('deliverable.submit', { shares: false, excluded: 'forbidden' });
          this.requireReviewable(host);
          if (!d || !canSubmit(d.state))
            throw new TenancyError('evidence_locked', {
              issues: [
                issue('/', 'accepted', 'This deliverable is accepted; its version is locked.'),
              ],
            });
          const expected =
            req.ifMatch !== undefined
              ? parseIfMatch(req.ifMatch)
              : (b.version as number | undefined);
          if (expected !== undefined) requireVersion(expected, Number(d.version));
          if (d.expected_type === 'file' && url)
            throw invalid(issue('/url', 'expected_file', 'This deliverable expects a file.'));
          if (d.expected_type === 'url' && b.file !== undefined)
            throw invalid(issue('/file', 'expected_url', 'This deliverable expects a link.'));
          let fileVersionId: string | null = null;
          let sha: Buffer | null = null;
          if (b.file !== undefined) {
            const loaded = await this.loadFile(tx, p, b.file);
            if (loaded.row.host_kind !== 'task' || loaded.row.host_record_id !== d.task_id)
              throw invalid(issue('/file', 'not_on_task', 'Choose a file attached to this task.'));
            const v = (await this.versions(tx, [loaded.row.id])).find(
              (x) => x.id === loaded.row.current_version_id,
            )!;
            if (!v.external_url && v.scan_state !== 'clean')
              throw new TenancyError(
                v.scan_state === 'pending' ? 'file_not_ready' : 'file_blocked',
                {
                  issues: [
                    issue(
                      '/file',
                      v.scan_state === 'pending' ? 'scanning' : 'blocked',
                      'Submit a file that has passed its scan.',
                    ),
                  ],
                },
              );
            fileVersionId = v.id;
            sha = v.sha256;
          }
          // Supersede an open review of an earlier version (4A keeps one open request per record).
          const open = await tx.db
            .selectFrom('collab.review_request')
            .select(['id', 'version'])
            .where('subject_record_id', '=', d.id)
            .where('state', '=', 'requested')
            .forUpdate()
            .executeTakeFirst();
          if (open)
            await tx.db
              .updateTable('collab.review_request')
              .set({
                state: 'superseded',
                closed_reason: 'refreshed',
                settled_at: new Date(),
                updated_at: new Date(),
                version: Number(open.version) + 1,
              })
              .where('id', '=', open.id)
              .execute();
          await sql`UPDATE files.deliverable_version SET state = 'superseded', updated_at = now()
              WHERE workspace_id = ${tx.workspaceId} AND deliverable_id = ${d.id}
                AND state IN ('draft', 'ready_for_review') AND NOT evidence_locked`.execute(tx.db);
          const number =
            ((
              await sql<{
                n: number | null;
              }>`SELECT max(version_number) AS n FROM files.deliverable_version
                WHERE workspace_id = ${tx.workspaceId} AND deliverable_id = ${d.id}`.execute(tx.db)
            ).rows[0]!.n ?? 0) + 1;
          const versionId = newUuidV7();
          await tx.db
            .insertInto('files.deliverable_version')
            .values({
              id: versionId,
              workspace_id: tx.workspaceId,
              deliverable_id: d.id,
              version_number: number,
              source_kind: url ? 'url' : 'file',
              file_version_id: fileVersionId,
              url,
              content_sha256: sha,
              note_text: note,
              state: 'ready_for_review',
              submitted_by_membership_id: p.membershipId,
            })
            .execute();
          const nextVersion = Number(d.version) + 1;
          await tx.db
            .updateTable('files.deliverable')
            .set({
              state: 'ready_for_review',
              current_version_id: versionId,
              updated_at: new Date(),
              version: nextVersion,
            })
            .where('id', '=', d.id)
            .execute();
          // The review is bound to this version of the deliverable.
          const subject = { ...host, version: nextVersion };
          const reviewers = await this.resolveReviewers(
            tx,
            p,
            subject,
            review.reviewers,
            await this.selfDecisionAllowed(tx, p),
          );
          const made = await this.insertRequest(
            tx,
            caller,
            p,
            subject,
            { ...review, subjectVersion: nextVersion },
            reviewers,
            null,
          );
          await tx.db
            .updateTable('files.deliverable_version')
            .set({ review_request_id: made.id, updated_at: new Date() })
            .where('id', '=', versionId)
            .execute();
          await this.fileAudit(
            tx,
            caller,
            p,
            'deliverable.submitted',
            { recordId: d.id, type: 'deliverable', publicId: d.public_id },
            [
              change.plain('version', null, number),
              change.plain('source', null, url ? 'url' : 'file'),
              change.plain('review', null, made.publicId),
            ],
            d.brand_id,
          );
          await this.workEvent(
            tx,
            caller,
            p,
            'files.deliverable.version_submitted',
            { type: 'files.deliverable_version', id: versionId, sequence: 0 },
            { deliverable_id: d.id, version_number: number },
            d.brand_id,
          );
          await this.workEvent(
            tx,
            caller,
            p,
            'files.deliverable.state_changed',
            { type: 'files.deliverable', id: d.id, sequence: nextVersion },
            { state: 'ready_for_review', version_number: number },
            d.brand_id,
          );
          return {
            status: 201,
            ref: { id: d.public_id, type: 'deliverable' },
            data: await this.deliverableView(tx, p, d.public_id),
          };
        },
        async (tx, p, ref) => this.deliverableView(tx, p, ref.id),
      ),
    );
  }

  /**
   * 4A settled (or withdrew) a review of a deliverable: its current version takes the outcome. An
   * approval accepts it in the same transaction — version evidence-locked with the decision, the
   * reviewer, and the time (FILE-009) — and locks the file version it points at.
   */
  protected override async reviewSettled(
    tx: WorkspaceTransaction,
    caller: Caller,
    p: Principal,
    host: CollabHost,
    request: { id: string },
    outcome: 'approved' | 'changes_requested' | 'rejected' | 'withdrawn',
    decisionId: string | null,
  ): Promise<void> {
    await super.reviewSettled(tx, caller, p, host, request, outcome, decisionId);
    if ((host.kind as string) !== 'deliverable') return;
    const v = await tx.db
      .selectFrom('files.deliverable_version')
      .select(['id', 'version_number', 'file_version_id'])
      .where('review_request_id', '=', request.id)
      .where('state', '=', 'ready_for_review')
      .forUpdate()
      .executeTakeFirst();
    if (!v) return;
    const next = stateAfterReview(outcome);
    const accepted = next === 'accepted';
    await tx.db
      .updateTable('files.deliverable_version')
      .set({
        state: outcome === 'withdrawn' ? 'withdrawn' : next,
        decided_review_decision_id: decisionId,
        ...(accepted
          ? {
              accepted_by_membership_id: p.membershipId,
              accepted_at: new Date(),
              evidence_locked: true,
            }
          : {}),
        updated_at: new Date(),
      })
      .where('id', '=', v.id)
      .execute();
    if (accepted && v.file_version_id)
      await tx.db
        .updateTable('files.file_version')
        .set({ evidence_locked: true })
        .where('id', '=', v.file_version_id)
        .execute();
    await sql`UPDATE files.deliverable SET state = ${next}, accepted_version_id = ${accepted ? v.id : null},
        updated_at = now(), version = version + 1
        WHERE workspace_id = ${tx.workspaceId} AND id = ${host.id}`.execute(tx.db);
    await this.workEvent(
      tx,
      caller,
      p,
      'files.deliverable.state_changed',
      { type: 'files.deliverable', id: host.id, sequence: host.version + 1 },
      { state: next, version_number: v.version_number },
      host.brand.id,
    );
    await this.fileAudit(
      tx,
      caller,
      p,
      accepted ? 'deliverable.accepted' : 'deliverable.review_settled',
      { recordId: host.id, type: 'deliverable', publicId: host.publicId },
      [
        change.plain('version', null, v.version_number),
        change.plain('state', 'ready_for_review', next),
      ],
      host.brand.id,
    );
  }
}
