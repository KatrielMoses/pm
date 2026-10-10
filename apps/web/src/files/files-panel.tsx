import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../api.ts';
import { useStepUp } from '../stepup.tsx';
import { useResource } from '../tenancy/resource.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Banner, ProblemBanner } from '../ui/feedback.tsx';
import { Field, SelectField } from '../ui/form.tsx';
import {
  files as filesClient,
  formatBytes,
  uploadFile,
  type Comparison,
  type FileItem,
  type FileUrl,
  type FileVersion,
  type StorageStatus,
  type UploadPhase,
} from './client.ts';

/**
 * Files on a host (4E, FILE-001–FILE-012): workspace, brand, project, or task. Upload shows
 * Uploading n% → Scanning → Ready (never "accepted"); a blocked file names why and offers no
 * download; a format without a preview still offers its download. Without upload permission (or
 * storage) the upload control is absent, and links can still be added where permitted.
 */

const TEXT_PREVIEW_MAX = 200_000;

export function versionStateText(v: FileVersion | null): string {
  if (!v) return 'Unavailable';
  if (v.state === 'link') return 'Link';
  if (v.state === 'ready') return 'Ready';
  if (v.state === 'scanning') return 'Scanning';
  return v.blocked_reason === 'malware' ? 'Blocked (malware)' : 'Scan failed';
}

const STATE_BADGE: Record<string, string> = {
  Ready: 'badge badge-success',
  Link: 'badge badge-info',
  Scanning: 'badge badge-warning',
  'Blocked (malware)': 'badge badge-danger',
  'Scan failed': 'badge badge-danger',
};

function typeLabel(v: FileVersion | null): string {
  if (!v) return '';
  if (v.kind === 'link') return 'External link';
  const ext = /\.([A-Za-z0-9]+)$/.exec(v.name)?.[1];
  return ext ? ext.toUpperCase() : (v.content_type ?? 'File');
}

export function explainFileError(err: unknown, storage?: StorageStatus | null): string {
  if (!(err instanceof ApiError)) return 'Something went wrong. Try again.';
  if (err.code === 'usage_limit_reached')
    return storage
      ? `Over quota: this workspace has used ${formatBytes(storage.used_bytes)} of ${formatBytes(storage.quota_bytes)}. Remove files or ask an admin for more space.`
      : 'Over quota: this workspace is out of file storage.';
  if (err.code === 'offline') return "You're offline. Nothing was uploaded.";
  if (err.code === 'network') return 'The connection dropped. Try again.';
  if (err.code === 'file_blocked') return "This file can't be downloaded: it didn't pass its scan.";
  if (err.code === 'file_not_ready') return 'This file is still being scanned.';
  return err.issues[0]?.message ?? err.message;
}

interface Pending {
  key: string;
  name: string;
  phase: UploadPhase;
  retry: () => void;
}

function pendingText(p: UploadPhase): string {
  switch (p.phase) {
    case 'hashing':
      return 'Preparing…';
    case 'uploading':
      return `Uploading ${p.pct}%`;
    case 'finishing':
      return 'Uploading 100%';
    case 'done':
      return 'Scanning';
    case 'failed':
      return 'Failed';
  }
}

export function FilesPanel({
  ws,
  host,
  title = 'Files',
  noun = 'here',
  onChanged,
  upload = uploadFile,
}: {
  ws: string;
  /** `workspace`, or the host's public identifier (`prj_`, `tsk_`, `br_`). */
  host: string;
  title?: string;
  noun?: string;
  onChanged?: () => void;
  /** Injected in component tests. */
  upload?: typeof uploadFile;
}) {
  const stepUp = useStepUp();
  const id = useId();
  const list = useResource(() => filesClient.list(ws, host), `files:${ws}:${host}`, {
    keepOnRefreshError: true,
  });
  const storage = useResource(() => filesClient.storage(ws), `storage:${ws}`);
  const [pending, setPending] = useState<Pending[]>([]);
  const [said, setSaid] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<
    | { kind: 'preview' | 'versions' | 'rename' | 'trash' | 'version'; file: FileItem }
    | { kind: 'link' }
    | null
  >(null);
  const close = useCallback(() => setDialog(null), []);
  const inputRef = useRef<HTMLInputElement>(null);

  const data = list.state.status === 'ready' ? list.state.data : null;
  const st = storage.state.status === 'ready' ? storage.state.data : null;
  const scanning = !!data?.data.some((f) => f.current?.state === 'scanning');

  // While anything is scanning, look again shortly (the scan job settles it).
  const reload = list.reload;
  useEffect(() => {
    if (!scanning) return;
    const t = setTimeout(reload, 800);
    return () => clearTimeout(t);
  }, [scanning, data, reload]);

  // Announce scan outcomes once.
  const seen = useRef(new Map<string, string>());
  useEffect(() => {
    if (!data) return;
    for (const f of data.data) {
      const now = versionStateText(f.current);
      const before = seen.current.get(f.id);
      if (before === 'Scanning' && now !== 'Scanning') setSaid(`${f.name}: ${now}.`);
      seen.current.set(f.id, now);
    }
  }, [data]);

  const start = (file: File, target: { host: string } | { file: string }) => {
    const key = `${Date.now()}-${Math.random()}`;
    const set = (phase: UploadPhase) =>
      setPending((ps) => ps.map((p) => (p.key === key ? { ...p, phase } : p)));
    const run = () => {
      set({ phase: 'hashing' });
      upload(ws, target, file, stepUp, set).then(
        (done) => {
          // The row stays as "Scanning" until the refreshed list carries the file.
          set({ phase: 'done', file: done.file });
          setSaid(`${file.name}: uploaded, now scanning.`);
          void list.refresh().then(() => setPending((ps) => ps.filter((p) => p.key !== key)));
          storage.reload();
          onChanged?.();
        },
        (err: unknown) => set({ phase: 'failed', error: err }),
      );
    };
    setPending((ps) => [...ps, { key, name: file.name, phase: { phase: 'hashing' }, retry: run }]);
    run();
  };

  const canUpload = !!data?.can_upload && !!st?.accepting_uploads;
  const changed = () => {
    list.reload();
    onChanged?.();
  };

  return (
    <section className="card files-panel" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{title}</h2>
      {st && !st.accepting_uploads && data?.can_upload ? (
        <Banner
          tone="info"
          title={
            st.object_storage !== 'ok'
              ? "File storage isn't set up here"
              : "Malware scanning isn't set up here"
          }
        >
          Uploads are off until it is. You can still add links.
        </Banner>
      ) : null}
      {list.state.status === 'loading' ? (
        <p className="loading" role="status">
          Loading files…
        </p>
      ) : list.state.status === 'failed' ? (
        <ProblemBanner error={list.state.error} onRetry={list.retry} />
      ) : null}
      {canUpload ? (
        <div className="field file-input">
          <label htmlFor={`${id}-input`}>Upload a file</label>
          <p className="hint" id={`${id}-hint`}>
            Up to {formatBytes(st?.upload_max_bytes)}. Every file is scanned before anyone can
            download it.
          </p>
          <input
            ref={inputRef}
            id={`${id}-input`}
            type="file"
            aria-describedby={`${id}-hint`}
            onChange={(e) => {
              const picked = [...(e.target.files ?? [])];
              e.target.value = '';
              for (const f of picked) start(f, { host });
            }}
          />
        </div>
      ) : null}
      {pending.length ? (
        <ul className="plain-list file-list" aria-label="Uploads in progress">
          {pending.map((p) => (
            <li key={p.key} className="file-row">
              <span className="file-name">{p.name}</span>{' '}
              <span
                className={p.phase.phase === 'failed' ? 'badge badge-danger' : 'badge badge-info'}
              >
                {pendingText(p.phase)}
              </span>
              {p.phase.phase === 'uploading' ? (
                <progress
                  max={100}
                  value={p.phase.pct}
                  aria-label={`Uploading ${p.name}`}
                  className="file-progress"
                />
              ) : null}
              {p.phase.phase === 'failed' ? (
                <>
                  <p className="field-error" role="alert">
                    {explainFileError(p.phase.error, st)}
                  </p>
                  <div className="actions actions-compact">
                    <button type="button" className="button button-secondary" onClick={p.retry}>
                      Try again<span className="visually-hidden"> uploading {p.name}</span>
                    </button>
                    <button
                      type="button"
                      className="button button-ghost"
                      onClick={() => setPending((ps) => ps.filter((x) => x.key !== p.key))}
                    >
                      Dismiss<span className="visually-hidden"> {p.name}</span>
                    </button>
                  </div>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {data ? (
        data.data.length ? (
          <ul className="plain-list file-list" aria-label={title}>
            {data.data.map((f) => (
              <FileRow
                key={f.id}
                ws={ws}
                file={f}
                canUpload={!!st?.accepting_uploads}
                open={(kind) => setDialog({ kind, file: f })}
              />
            ))}
          </ul>
        ) : (
          <p className="hint">
            No files {noun} yet.
            {canUpload ? ' Choose a file above to upload it.' : ''}
          </p>
        )
      ) : null}
      {data?.can_upload ? (
        <div className="actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setDialog({ kind: 'link' })}
          >
            Add external link…
          </button>
        </div>
      ) : null}
      {error ? <p className="field-error">{explainFileError(error, st)}</p> : null}
      <p className="visually-hidden" role="status">
        {said}
      </p>
      {dialog?.kind === 'preview' ? (
        <PreviewDialog ws={ws} file={dialog.file} onClose={close} />
      ) : dialog?.kind === 'versions' ? (
        <VersionsDialog ws={ws} file={dialog.file} onClose={close} />
      ) : dialog?.kind === 'rename' ? (
        <RenameDialog
          ws={ws}
          file={dialog.file}
          onClose={close}
          onDone={(f) => {
            setDialog(null);
            setSaid(`Renamed to ${f.name}.`);
            changed();
          }}
        />
      ) : dialog?.kind === 'trash' ? (
        <TrashDialog
          ws={ws}
          file={dialog.file}
          onClose={close}
          onDone={() => {
            setSaid(`${dialog.file.name} moved to trash.`);
            setDialog(null);
            setError(null);
            changed();
          }}
        />
      ) : dialog?.kind === 'version' ? (
        <NewVersionDialog
          file={dialog.file}
          onClose={close}
          onPick={(picked) => {
            setDialog(null);
            start(picked, { file: dialog.file.id });
          }}
        />
      ) : dialog?.kind === 'link' ? (
        <LinkDialog
          ws={ws}
          host={host}
          onClose={close}
          onDone={(f) => {
            setDialog(null);
            setSaid(`Link ${f.name} added.`);
            changed();
          }}
        />
      ) : null}
    </section>
  );
}

function FileRow({
  ws,
  file,
  canUpload,
  open,
}: {
  ws: string;
  file: FileItem;
  canUpload: boolean;
  open: (kind: 'preview' | 'versions' | 'rename' | 'trash' | 'version') => void;
}) {
  const v = file.current;
  const state = versionStateText(v);
  const ready = v?.state === 'ready';
  const link = v?.state === 'link';
  const hidden = <span className="visually-hidden"> {file.name}</span>;
  return (
    <li className="file-row">
      <h3 className="file-name">{file.name}</h3>
      <p className="file-meta">
        <span className={STATE_BADGE[state] ?? 'badge'}>{state}</span>{' '}
        <span className="hint">
          {typeLabel(v)}
          {v?.byte_size !== null && v?.byte_size !== undefined
            ? ` · ${formatBytes(v.byte_size)}`
            : ''}
          {' · '}
          {file.versions.length === 1 ? '1 version' : `${file.versions.length} versions`}
          {file.owner ? ` · ${file.owner.name}` : ''}
        </span>
      </p>
      {ready && v.preview === 'none' ? (
        <p className="hint">No preview for this type. Download it to open it.</p>
      ) : null}
      <div className="actions actions-compact">
        {link && v.url ? (
          <a className="button button-secondary" href={v.url} target="_blank" rel="noreferrer">
            Open link{hidden}
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        ) : null}
        {ready && file.can.download ? (
          <a className="button button-secondary" href={filesClient.downloadHref(ws, file.id)}>
            Download{hidden}
          </a>
        ) : null}
        {ready && file.can.download && v.preview !== 'none' ? (
          <button type="button" className="button button-secondary" onClick={() => open('preview')}>
            Preview{hidden}
          </button>
        ) : null}
        {file.can.upload && canUpload ? (
          <button type="button" className="button button-ghost" onClick={() => open('version')}>
            Upload new version{hidden}
          </button>
        ) : null}
        <button type="button" className="button button-ghost" onClick={() => open('versions')}>
          Versions{hidden}
        </button>
        {file.can.rename ? (
          <button type="button" className="button button-ghost" onClick={() => open('rename')}>
            Rename{hidden}
          </button>
        ) : null}
        {file.can.trash ? (
          <button type="button" className="button button-ghost" onClick={() => open('trash')}>
            Move to trash{hidden}
          </button>
        ) : null}
      </div>
    </li>
  );
}

export function PreviewDialog({
  ws,
  file,
  version,
  onClose,
}: {
  ws: string;
  file: FileItem;
  version?: FileVersion;
  onClose: () => void;
}) {
  const v = version ?? file.current!;
  const [url, setUrl] = useState<FileUrl | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    filesClient
      .preview(ws, file.id, version?.number)
      .then(
        async (u) => {
          if (!live) return;
          setUrl(u);
          if (v.preview === 'text' && u.kind === 'object') {
            const res = await fetch(u.url, { credentials: 'omit' });
            if (!res.ok) throw new ApiError({ code: 'network', status: res.status, message: '' });
            const body = await res.text();
            if (live) setText(body.slice(0, TEXT_PREVIEW_MAX));
          }
        },
        (err: unknown) => live && setError(err),
      )
      .catch((err: unknown) => live && setError(err));
    return () => {
      live = false;
    };
  }, [ws, file.id, version?.number, v.preview]);
  const label = `Preview of ${v.name}`;
  return (
    <Dialog title={`Preview: ${v.name}`} onClose={onClose}>
      <div className="file-preview">
        {error ? (
          <Banner tone="warning" title="Preview unavailable">
            {explainFileError(error)} You can still download the file.
          </Banner>
        ) : !url ? (
          <p className="loading" role="status">
            Loading preview…
          </p>
        ) : v.preview === 'image' ? (
          <img src={url.url} alt={label} />
        ) : v.preview === 'video' ? (
          <video src={url.url} controls aria-label={label} />
        ) : v.preview === 'audio' ? (
          <audio src={url.url} controls aria-label={label} />
        ) : v.preview === 'pdf' ? (
          <iframe src={url.url} sandbox="" title={label} />
        ) : v.preview === 'text' ? (
          text === null ? (
            <p className="loading" role="status">
              Loading preview…
            </p>
          ) : (
            <pre tabIndex={0} aria-label={label} className="file-text">
              {text}
            </pre>
          )
        ) : (
          <p>No preview for this type.</p>
        )}
      </div>
      <div className="actions">
        {file.can.download ? (
          <a
            className="button button-secondary"
            href={filesClient.downloadHref(ws, file.id, version?.number)}
          >
            Download
          </a>
        ) : null}
        <button type="button" className="button button-primary" onClick={onClose} data-initial>
          Close
        </button>
      </div>
    </Dialog>
  );
}

function versionLabel(v: FileVersion) {
  return `Version ${v.number} — ${v.name}${v.created_by ? `, ${v.created_by.name}` : ''}`;
}

export function VersionsDialog({
  ws,
  file,
  onClose,
  compare = filesClient.compare,
}: {
  ws: string;
  file: FileItem;
  onClose: () => void;
  compare?: typeof filesClient.compare;
}) {
  const id = useId();
  const sorted = [...file.versions].sort((a, b) => b.number - a.number);
  const [from, setFrom] = useState(String(sorted[1]?.number ?? sorted[0]?.number ?? 1));
  const [to, setTo] = useState(String(sorted[0]?.number ?? 1));
  const [result, setResult] = useState<Comparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const options = sorted.map((v) => ({ value: String(v.number), label: `Version ${v.number}` }));
  const run = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await compare(ws, file.id, Number(from), Number(to)));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Versions of ${file.name}`} onClose={onClose}>
      <ol className="plain-list version-list" aria-label="Versions">
        {sorted.map((v) => (
          <li key={v.number}>
            <strong>{versionLabel(v)}</strong>{' '}
            <span className={STATE_BADGE[versionStateText(v)] ?? 'badge'}>
              {versionStateText(v)}
            </span>
            <span className="hint">
              {' '}
              {v.byte_size !== null ? formatBytes(v.byte_size) : ''} ·{' '}
              {new Date(v.created_at).toLocaleString()}
              {v.evidence_locked ? ' · Locked as accepted evidence' : ''}
            </span>
          </li>
        ))}
      </ol>
      {sorted.length > 1 ? (
        <form onSubmit={run} aria-labelledby={`${id}-cmp`}>
          <h3 id={`${id}-cmp`}>Compare two versions</h3>
          <div className="compare-pick">
            <SelectField
              id={`${id}-from`}
              label="From"
              value={from}
              onChange={setFrom}
              options={options}
            />
            <SelectField id={`${id}-to`} label="To" value={to} onChange={setTo} options={options} />
          </div>
          <div className="actions">
            <button type="submit" className="button button-secondary" disabled={busy}>
              {busy ? 'Comparing…' : 'Compare'}
            </button>
          </div>
        </form>
      ) : (
        <p className="hint">Upload another version to compare.</p>
      )}
      {error ? <p className="field-error">{explainFileError(error)}</p> : null}
      {result ? <ComparisonView c={result} /> : null}
      <div className="actions">
        <button type="button" className="button button-primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

export function ComparisonView({ c }: { c: Comparison }) {
  const added = c.lines?.filter((l) => l.op === 'add').length ?? 0;
  const removed = c.lines?.filter((l) => l.op === 'remove').length ?? 0;
  return (
    <div className="comparison" role="region" aria-label="Comparison">
      <p>
        Version {c.from.number} → version {c.to.number}:{' '}
        {c.same_content
          ? 'the content is identical.'
          : c.mode === 'lines'
            ? `${added} line${added === 1 ? '' : 's'} added, ${removed} removed.`
            : 'the content differs.'}
        {c.size_change !== null && c.size_change !== 0
          ? ` Size ${c.size_change > 0 ? '+' : '−'}${formatBytes(Math.abs(c.size_change))}.`
          : ''}
      </p>
      {c.mode === 'lines' && c.lines ? (
        <ol className="plain-list diff" aria-label="Line changes" tabIndex={0}>
          {c.lines.map((l, i) => (
            <li key={i} className={`diff-${l.op}`}>
              <span aria-hidden="true" className="diff-mark">
                {l.op === 'add' ? '+' : l.op === 'remove' ? '−' : ' '}
              </span>
              <span className="visually-hidden">
                {l.op === 'add' ? 'Added: ' : l.op === 'remove' ? 'Removed: ' : 'Unchanged: '}
              </span>
              <code>{l.text}</code>
            </li>
          ))}
        </ol>
      ) : (
        <dl className="facts">
          <dt>Compared</dt>
          <dd>
            {c.reason === 'format'
              ? 'Details only (this type has no line comparison)'
              : c.reason === 'not_clean'
                ? 'Details only (a version did not pass its scan)'
                : 'Details only (too large for a line comparison)'}
          </dd>
          <dt>Version {c.from.number}</dt>
          <dd>
            {c.from.name} · {formatBytes(c.from.byte_size)}
          </dd>
          <dt>Version {c.to.number}</dt>
          <dd>
            {c.to.name} · {formatBytes(c.to.byte_size)}
          </dd>
        </dl>
      )}
    </div>
  );
}

function RenameDialog({
  ws,
  file,
  onClose,
  onDone,
}: {
  ws: string;
  file: FileItem;
  onClose: () => void;
  onDone: (f: FileItem) => void;
}) {
  const stepUp = useStepUp();
  const id = useId();
  const [name, setName] = useState(file.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onDone(await filesClient.rename(ws, file.id, name.trim(), file.version, stepUp));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Rename ${file.name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <Field
          id={`${id}-name`}
          label="Name"
          required
          value={name}
          maxLength={255}
          onChange={(e) => setName(e.target.value)}
          error={error ? explainFileError(error) : undefined}
        />
        <div className="actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Working…' : 'Rename'}
          </button>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function TrashDialog({
  ws,
  file,
  onClose,
  onDone,
}: {
  ws: string;
  file: FileItem;
  onClose: () => void;
  onDone: () => void;
}) {
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog
      title={`Move ${file.name} to trash?`}
      destructive
      onClose={onClose}
      description="It disappears from this list. It can be restored from the trash until it is purged."
    >
      {error ? <p className="field-error">{explainFileError(error)}</p> : null}
      <div className="actions">
        <button
          type="button"
          className="button button-danger"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            filesClient.trash(ws, file.id, stepUp).then(onDone, (err: unknown) => {
              setError(err);
              setBusy(false);
            });
          }}
        >
          {busy ? 'Working…' : 'Move to trash'}
        </button>
        <button type="button" className="button button-secondary" onClick={onClose} data-cancel>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

function NewVersionDialog({
  file,
  onClose,
  onPick,
}: {
  file: FileItem;
  onClose: () => void;
  onPick: (f: File) => void;
}) {
  const id = useId();
  const [picked, setPicked] = useState<File | null>(null);
  return (
    <Dialog title={`New version of ${file.name}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (picked) onPick(picked);
        }}
      >
        <div className="field file-input">
          <label htmlFor={`${id}-f`}>File for the new version</label>
          <input
            id={`${id}-f`}
            type="file"
            onChange={(e) => setPicked(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="actions">
          <button type="submit" className="button button-primary" disabled={!picked}>
            Upload version
          </button>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function LinkDialog({
  ws,
  host,
  onClose,
  onDone,
}: {
  ws: string;
  host: string;
  onClose: () => void;
  onDone: (f: FileItem) => void;
}) {
  const stepUp = useStepUp();
  const id = useId();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const issue = (ptr: string) =>
    error instanceof ApiError ? error.issues.find((i) => i.pointer === ptr)?.message : undefined;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onDone(
        await filesClient.addLink(
          ws,
          { host, url: url.trim(), ...(name.trim() ? { name: name.trim() } : {}) },
          stepUp,
        ),
      );
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  const general = error && !issue('/url') && !issue('/name') ? explainFileError(error) : null;
  return (
    <Dialog
      title="Add an external link"
      onClose={onClose}
      description="The link is stored as written. It is never fetched or copied."
    >
      <form onSubmit={submit}>
        <Field
          id={`${id}-url`}
          label="Link"
          type="url"
          required
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          error={issue('/url')}
        />
        <Field
          id={`${id}-name`}
          label="Name (optional)"
          value={name}
          maxLength={255}
          onChange={(e) => setName(e.target.value)}
          error={issue('/name')}
        />
        {general ? <p className="field-error">{general}</p> : null}
        <div className="actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Working…' : 'Add link'}
          </button>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Workspace storage usage (FILE-010), for workspace settings. */
export function StorageUsage({ ws }: { ws: string }) {
  const s = useResource(() => filesClient.storage(ws), `storage:${ws}`);
  if (s.state.status !== 'ready') return null;
  const d = s.state.data;
  const pct = d.quota_bytes ? Math.min(100, Math.round((d.used_bytes / d.quota_bytes) * 100)) : 0;
  return (
    <section className="card" aria-labelledby="storage-usage-h">
      <h2 id="storage-usage-h">File storage</h2>
      {!d.accepting_uploads ? (
        <p>
          {d.object_storage !== 'ok'
            ? "File storage isn't set up here."
            : "Malware scanning isn't set up here."}{' '}
          Uploads are off until it is.
        </p>
      ) : null}
      <p>
        {formatBytes(d.used_bytes)} of {formatBytes(d.quota_bytes)} used ({pct}%) · {d.objects}{' '}
        {d.objects === 1 ? 'file' : 'files'}
      </p>
      <progress max={100} value={pct} aria-label="Storage used" className="file-progress" />
    </section>
  );
}
