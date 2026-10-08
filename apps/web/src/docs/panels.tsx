import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api.ts';
import { day, Problem, when, type Explained } from '../collab/shared.tsx';
import { Link } from '../router.tsx';
import { useStepUp } from '../stepup.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { LoadProblem } from '../tenancy/resource.tsx';
import {
  documents,
  type Backlink,
  type Block,
  type Doc,
  type DocVersion,
  type DocVersionBody,
  type Suggestion,
} from './client.ts';
import { BlockEditor } from './editor.tsx';
import { DOC_TYPE_LABEL } from './client.ts';
import { blankBlock, groupIssues, toBlock, toEdit, type EditBlock } from './model.ts';
import { BlockView, DocView } from './render.tsx';
import { candidateRef } from './editor.tsx';
import { docHref, explainDoc } from './shared.tsx';

/** The panels under a document: version history, suggestions, linked records, AI source, mentions. */

const KIND_TEXT: Record<DocVersion['kind'], string> = {
  save: 'Saved',
  restore: 'Restored',
  suggestion: 'Suggestion accepted',
  template: 'Started from template',
};

export const summaryText = (s: DocVersion['summary']) =>
  `+${s.added} added, ${s.changed} changed, ${s.removed} removed`;

function kindText(v: DocVersion): string {
  if (v.kind === 'restore' && v.restored_from) return `Restored from ${v.restored_from}`;
  return KIND_TEXT[v.kind];
}

// -----------------------------------------------------------------------------------------------
// Version history
// -----------------------------------------------------------------------------------------------

export function VersionHistory({
  ws,
  doc,
  canRestore,
  dirty,
  onRestored,
  onStale,
}: {
  ws: string;
  doc: Doc;
  canRestore: boolean;
  dirty: boolean;
  onRestored: (d: Doc) => void;
  onStale: () => void;
}) {
  const stepUp = useStepUp();
  const [rows, setRows] = useState<DocVersion[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [more, setMore] = useState<{ busy: boolean; e: Explained | null }>({ busy: false, e: null });
  const [nonce, setNonce] = useState(0);
  const [open, setOpen] = useState<
    | null
    | { n: number; state: 'loading' }
    | { n: number; state: 'failed'; e: Explained }
    | { n: number; state: 'ready'; v: DocVersionBody }
  >(null);
  const [restore, setRestore] = useState<{ busy: boolean; e: Explained | null; said: string }>({
    busy: false,
    e: null,
    said: '',
  });
  const viewer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    documents.versions(ws, doc.id).then(
      (r) => {
        if (!active) return;
        setRows(r.data);
        setNext(r.page.has_more ? (r.page.next_cursor ?? null) : null);
        setFailed(null);
      },
      (err: unknown) => active && setFailed(err),
    );
    return () => {
      active = false;
    };
  }, [ws, doc.id, doc.content_version, nonce]);

  const view = async (n: number) => {
    setOpen({ n, state: 'loading' });
    setRestore({ busy: false, e: null, said: '' });
    try {
      const v = await documents.version(ws, doc.id, n);
      setOpen({ n, state: 'ready', v });
      setTimeout(() => viewer.current?.focus(), 0);
    } catch (err) {
      setOpen({ n, state: 'failed', e: explainDoc(err, 'opening that version') });
    }
  };
  const doRestore = async (n: number) => {
    setRestore({ busy: true, e: null, said: '' });
    try {
      const d = await documents.restoreVersion(
        ws,
        doc.id,
        { version: n, base_version: doc.content_version },
        stepUp,
      );
      setRestore({ busy: false, e: null, said: `Restored version ${n} as a new version.` });
      setOpen(null);
      onRestored(d);
    } catch (err) {
      const e = explainDoc(err, 'restoring');
      if (err instanceof ApiError && err.code === 'conflict' && !err.issues.some((i) => i.code === 'already_current')) onStale();
      setRestore({ busy: false, e, said: '' });
    }
  };
  const loadMore = async () => {
    if (!next) return;
    setMore({ busy: true, e: null });
    try {
      const r = await documents.versions(ws, doc.id, next);
      setRows((cur) => [...(cur ?? []), ...r.data]);
      setNext(r.page.has_more ? (r.page.next_cursor ?? null) : null);
      setMore({ busy: false, e: null });
    } catch (err) {
      setMore({ busy: false, e: { ...explainDoc(err, 'loading more'), retryable: true } });
    }
  };

  return (
    <section className="card doc-history" aria-labelledby="doc-history-h">
      <h2 id="doc-history-h">Version history</h2>
      <p className="hint">
        Every save is kept. Restoring an older version adds a new version; nothing is deleted.
      </p>
      {rows === null && !failed ? <p className="loading">Loading versions…</p> : null}
      {failed && !rows ? (
        <LoadProblem error={failed} what="version history" onRetry={() => setNonce((n) => n + 1)} />
      ) : null}
      {rows ? (
        <ol className="plain-list doc-versions" aria-label="Versions, newest first">
          {rows.map((v) => (
            <li key={v.id} className="doc-version">
              <p>
                <strong>Version {v.number}</strong>
                {v.current ? <span className="badge badge-success">Current</span> : null}
                {v.ai_source ? <span className="badge badge-info">Approved AI source</span> : null}
                <span className="badge">{kindText(v)}</span>
              </p>
              <p className="hint">
                {v.by ? v.by.name : 'Someone who has left'} · {when(v.at)} · {summaryText(v.summary)}
              </p>
              <button
                type="button"
                className="button button-secondary"
                aria-expanded={open?.n === v.number}
                onClick={() => (open?.n === v.number ? setOpen(null) : void view(v.number))}
              >
                {open?.n === v.number ? 'Close' : 'View'}{' '}
                <span className="visually-hidden">version {v.number}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      {next ? (
        <button type="button" className="button button-secondary" disabled={more.busy} onClick={() => void loadMore()}>
          {more.busy ? 'Loading…' : 'Load more versions'}
        </button>
      ) : null}
      <Problem problem={more.e} onRetry={() => void loadMore()} />
      <p className="visually-hidden" role="status">
        {restore.said}
      </p>
      {open ? (
        <div
          className="doc-version-view card"
          tabIndex={-1}
          ref={viewer}
          role="region"
          aria-label={`Version ${open.n}`}
        >
          {open.state === 'loading' ? <p className="loading">Loading version {open.n}…</p> : null}
          {open.state === 'failed' ? <Problem problem={{ ...open.e, retryable: true }} onRetry={() => void view(open.n)} /> : null}
          {open.state === 'ready' ? (
            <>
              <h3>
                Version {open.v.number}: {open.v.title}
              </h3>
              <p className="hint">
                Read-only. {open.v.by ? open.v.by.name : 'Someone who has left'} · {when(open.v.at)}
              </p>
              <DocView
                content={open.v.content}
                refs={open.v.references}
                idBase={`ver${open.v.number}`}
                label={`Version ${open.v.number} content`}
              />
              {canRestore && !open.v.current ? (
                <>
                  <p className="hint">This adds a new version; nothing is deleted.</p>
                  {dirty ? (
                    <p className="hint" role="status">
                      Save or discard your unsaved changes first, then restore.
                    </p>
                  ) : null}
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={restore.busy || dirty}
                    onClick={() => void doRestore(open.v.number)}
                  >
                    {restore.busy ? 'Restoring…' : 'Restore this version'}
                  </button>
                </>
              ) : open.v.current ? (
                <p className="hint">This is the current version.</p>
              ) : null}
              <Problem problem={restore.e} />
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// -----------------------------------------------------------------------------------------------
// Suggestions
// -----------------------------------------------------------------------------------------------

const SUGGESTION_STATE: Record<string, string> = {
  open: 'Open',
  accepted: 'Accepted',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  stale: 'Stale',
};

export function SuggestionsPanel({
  ws,
  doc,
  onApplied,
  refresh = 0,
}: {
  ws: string;
  doc: Doc;
  /** Changes when a suggestion was just sent from elsewhere on the page. */
  refresh?: number;
  /** A suggestion was accepted: the content changed on the server. */
  onApplied: () => void;
}) {
  const stepUp = useStepUp();
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [rows, setRows] = useState<Suggestion[] | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [said, setSaid] = useState('');
  useEffect(() => {
    let active = true;
    documents.suggestions(ws, doc.id, filter).then(
      (r) => {
        if (!active) return;
        setRows(r.data);
        setFailed(null);
      },
      (err: unknown) => active && setFailed(err),
    );
    return () => {
      active = false;
    };
  }, [ws, doc.id, filter, nonce, doc.content_version, refresh]);

  const act = async (s: Suggestion, what: 'accept' | 'reject' | 'withdraw') => {
    setBusy(s.id);
    setProblem(null);
    try {
      const out =
        what === 'withdraw'
          ? await documents.withdraw(ws, s.id, stepUp)
          : await documents.decide(ws, s.id, what, stepUp);
      const final = out.effective_state ?? out.state;
      setSaid(
        what === 'accept' && final === 'accepted'
          ? 'Suggestion accepted. It is now part of the document as a new version.'
          : what === 'accept'
            ? 'This part changed since the suggestion was made. Nothing was applied.'
            : what === 'reject'
              ? 'Suggestion rejected.'
              : 'Suggestion withdrawn.',
      );
      setNonce((n) => n + 1);
      if (what === 'accept') onApplied();
    } catch (err) {
      setProblem(explainDoc(err, `${what === 'accept' ? 'accepting' : what === 'reject' ? 'rejecting' : 'withdrawing'}`));
      setNonce((n) => n + 1);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="card doc-suggestions" aria-labelledby="doc-sugg-h">
      <h2 id="doc-sugg-h">Suggestions</h2>
      <p className="hint">
        A suggestion proposes new text for one block. It changes nothing until the owner or an
        editor accepts it, and only if that block hasn't changed since.
      </p>
      <div role="group" aria-label="Show suggestions" className="segments">
        {(['open', 'all'] as const).map((f) => (
          <button
            key={f}
            type="button"
            className="button button-secondary segment"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {f === 'open' ? 'Open' : 'All'}
          </button>
        ))}
      </div>
      {rows === null && !failed ? <p className="loading">Loading suggestions…</p> : null}
      {failed && !rows ? (
        <LoadProblem error={failed} what="suggestions" onRetry={() => setNonce((n) => n + 1)} />
      ) : null}
      {rows && rows.length === 0 ? (
        <p>
          {filter === 'open'
            ? 'No open suggestions.'
            : 'Nobody has suggested a change to this document yet.'}
          {doc.capabilities.suggest && !doc.capabilities.edit
            ? ' Use "Suggest a change" under any block.'
            : ''}
        </p>
      ) : null}
      {rows && rows.length ? (
        <ul className="plain-list doc-sugg-list" aria-label="Suggestions">
          {rows.map((s) => {
            const state = s.effective_state ?? s.state;
            return (
              <li key={s.id} className="doc-sugg">
                <p>
                  <strong>{s.author ? s.author.name : 'Someone who has left'}</strong>{' '}
                  <span className={`badge doc-sugg-state doc-sugg-${state}`}>
                    {SUGGESTION_STATE[state] ?? state}
                  </span>{' '}
                  <span className="hint">{when(s.created_at)}</span>
                </p>
                {s.note ? <p className="doc-sugg-note">Note: {s.note}</p> : null}
                <div className="doc-sugg-cols">
                  <div>
                    <p className="doc-review-label">Current text</p>
                    {s.current ? (
                      <BlockView block={s.current} refs={s.references} id={`${s.id}-cur`} />
                    ) : (
                      <p className="hint">That block is no longer in the document.</p>
                    )}
                  </div>
                  <div>
                    <p className="doc-review-label">Proposed text</p>
                    <BlockView block={s.proposed} refs={s.references} id={`${s.id}-new`} />
                  </div>
                </div>
                {state === 'stale' ? (
                  <p className="hint">
                    This part changed since the suggestion was made. Nothing was applied.
                  </p>
                ) : null}
                {state === 'accepted' && s.decided_by ? (
                  <p className="hint">
                    Accepted by {s.decided_by.name} {s.decided_at ? `on ${day(s.decided_at)}` : ''}
                    {s.applied_version ? `; it became version ${s.applied_version}.` : '.'}
                  </p>
                ) : null}
                {state === 'rejected' && s.decided_by ? (
                  <p className="hint">Rejected by {s.decided_by.name}.</p>
                ) : null}
                <div className="actions">
                  {s.capabilities.accept ? (
                    <button
                      type="button"
                      className="button button-primary"
                      disabled={busy === s.id}
                      onClick={() => void act(s, 'accept')}
                    >
                      Accept{' '}<span className="visually-hidden">suggestion by {s.author?.name ?? 'someone'}</span>
                    </button>
                  ) : null}
                  {s.capabilities.reject ? (
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={busy === s.id}
                      onClick={() => void act(s, 'reject')}
                    >
                      Reject{' '}<span className="visually-hidden">suggestion by {s.author?.name ?? 'someone'}</span>
                    </button>
                  ) : null}
                  {s.capabilities.withdraw ? (
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={busy === s.id}
                      onClick={() => void act(s, 'withdraw')}
                    >
                      Withdraw{' '}<span className="visually-hidden">your suggestion</span>
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      <Problem problem={problem} />
      <p className="visually-hidden" role="status">
        {said}
      </p>
    </section>
  );
}

/** "Suggest a change" for one block: an editor for that block and an optional note. */
export function SuggestDialog({
  ws,
  doc,
  block,
  onClose,
  onDone,
}: {
  ws: string;
  doc: Doc;
  block: Block;
  onClose: () => void;
  onDone: () => void;
}) {
  const stepUp = useStepUp();
  const [edit, setEdit] = useState<EditBlock[]>(() => [toEdit(block, doc.references)]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await documents.suggest(
        ws,
        doc.id,
        {
          block: block.id!,
          base_version: doc.content_version,
          proposed: toBlock(edit[0]!, false),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        stepUp,
      );
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const issues =
    error instanceof ApiError
      ? error.issues.map((i) => ({
          ...i,
          pointer: (i.pointer ?? '').replace(/^\/proposed/, '/content/blocks/0'),
        }))
      : [];
  const grouped = groupIssues(issues);
  const problem = error ? explainDoc(error, 'suggesting') : null;
  return (
    <Dialog title="Suggest a change" onClose={onClose}>
      <form
        aria-label="Suggest a change"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="hint">
          Edit this block as you would have it. The owner or an editor decides whether to accept it.
        </p>
        <BlockEditor
          ws={ws}
          doc={doc.id}
          blocks={edit}
          onChange={setEdit}
          issues={grouped.byBlock}
          onLabel={() => undefined}
          onSubmit={() => void submit()}
          single
          idBase="sg"
        />
        <div className="field">
          <label htmlFor="sg-note">Note (optional)</label>
          <textarea
            id="sg-note"
            rows={2}
            value={note}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {problem && grouped.byBlock.size === 0 ? (
          <p className="field-error" role="alert">
            <span aria-hidden="true">! </span>
            {problem.message}
          </p>
        ) : null}
        <div className="actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Sending…' : 'Send suggestion'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------------------------
// Linked records
// -----------------------------------------------------------------------------------------------

const LINK_KIND: Record<string, string> = {
  task: 'Task',
  project: 'Project',
  brand: 'Brand',
  document: 'Document',
  member: 'Person',
  team: 'Team',
};

export function LinkedRecords({
  ws,
  doc,
  onSaved,
  onStale,
}: {
  ws: string;
  doc: Doc;
  onSaved: (d: Doc) => void;
  onStale: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const links = doc.links.filter((l) => l.kind !== 'restricted');
  return (
    <section className="card doc-links" aria-labelledby="doc-links-h">
      <h2 id="doc-links-h">Linked records</h2>
      <p className="hint">
        Links connect this document to tasks, projects, and other documents. They appear on those
        records under "Mentioned in documents" for people who can see both.
      </p>
      {links.length ? (
        <ul className="plain-list" aria-label="Linked records">
          {links.map((l) => (
            <li key={`${l.kind}:${l.id}`}>
              {l.path ? <Link to={l.path}>{l.label}</Link> : <span>{l.label}</span>}{' '}
              <span className="hint">{LINK_KIND[l.kind] ?? l.kind}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p>Nothing is linked yet.</p>
      )}
      {doc.links_restricted > 0 ? (
        <p className="hint">
          {doc.links_restricted} linked {doc.links_restricted === 1 ? 'item' : 'items'} you can't
          open.
        </p>
      ) : null}
      {doc.capabilities.edit && !doc.archived ? (
        <button type="button" className="button button-secondary" onClick={() => setEditing(true)}>
          Link records
        </button>
      ) : null}
      {editing ? (
        <LinkDialog
          ws={ws}
          doc={doc}
          onClose={() => setEditing(false)}
          onSaved={(d) => {
            setEditing(false);
            onSaved(d);
          }}
          onStale={onStale}
        />
      ) : null}
    </section>
  );
}

function LinkDialog({
  ws,
  doc,
  onClose,
  onSaved,
  onStale,
}: {
  ws: string;
  doc: Doc;
  onClose: () => void;
  onSaved: (d: Doc) => void;
  onStale: () => void;
}) {
  const stepUp = useStepUp();
  const visible = doc.links.filter((l) => l.kind !== 'restricted');
  const [chosen, setChosen] = useState(visible.map((l) => ({ id: l.id, label: l.label, kind: l.kind as string })));
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Array<{ id: string; label: string; kind: string }> | null>(null);
  const [searchProblem, setSearchProblem] = useState<Explained | null>(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const t = setTimeout(() => {
      documents.candidates(ws, doc.id, q.trim(), controller.signal).then(
        (list) => {
          if (controller.signal.aborted) return;
          setFound(
            list.flatMap((c) => {
              const r = c.kind === 'record' ? candidateRef(c) : null;
              return r && r.id !== doc.id ? [{ id: r.id, label: r.label, kind: r.kind }] : [];
            }),
          );
          setSearchProblem(null);
        },
        (err: unknown) => {
          if (controller.signal.aborted) return;
          setFound([]);
          setSearchProblem({ ...explainDoc(err, 'searching'), retryable: true });
        },
      );
    }, 200);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [ws, doc.id, q, nonce]);
  const has = (id: string) => chosen.some((c) => c.id === id);
  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const d = await documents.setLinks(
        ws,
        doc.id,
        doc.version,
        chosen.map((c) => c.id),
        stepUp,
      );
      onSaved(d);
    } catch (err) {
      const e = explainDoc(err, 'saving the links');
      if (e.kind === 'stale') onStale();
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Link records" onClose={onClose}>
      <form
        aria-label="Link records"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="field">
          <label htmlFor="link-q">Search tasks, projects, and documents</label>
          <input
            id="link-q"
            type="search"
            value={q}
            autoComplete="off"
            data-initial
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Problem problem={searchProblem} onRetry={() => setNonce((n) => n + 1)} />
        {found === null ? <p className="loading">Loading…</p> : null}
        {found && found.length ? (
          <ul className="plain-list picker-list" aria-label="Matches">
            {found.map((r) => (
              <li key={r.id}>
                <label className="choice">
                  <input
                    type="checkbox"
                    checked={has(r.id)}
                    onChange={() =>
                      setChosen((cur) =>
                        has(r.id) ? cur.filter((c) => c.id !== r.id) : [...cur, r],
                      )
                    }
                  />
                  {r.label} <span className="hint">{LINK_KIND[r.kind] ?? r.kind}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : null}
        {found && !found.length && !searchProblem ? (
          <p className="hint">Nothing matches. Only records you can see are listed.</p>
        ) : null}
        <div aria-live="polite">
          <p className="hint">Linked ({chosen.length}):</p>
          {chosen.length ? (
            <ul className="plain-list picker-chosen">
              {chosen.map((c) => (
                <li key={c.id}>
                  {c.label}{' '}
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={() => setChosen((cur) => cur.filter((x) => x.id !== c.id))}
                  >
                    Remove{' '}<span className="visually-hidden">{c.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No links.</p>
          )}
        </div>
        {doc.links_restricted > 0 ? (
          <p className="hint">
            Saving replaces every link, including {doc.links_restricted} you can't see. Those are
            removed too.
          </p>
        ) : null}
        <Problem problem={problem} />
        <div className="actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save links'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------------------------
// AI source approval
// -----------------------------------------------------------------------------------------------

export function SourceApproval({ ws, doc, onChanged }: { ws: string; doc: Doc; onChanged: (d: Doc) => void }) {
  const stepUp = useStepUp();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [said, setSaid] = useState('');
  if (!doc.capabilities.approve_source) return null;
  const a = doc.ai_source;
  const go = async (verb: 'approve_source' | 'revoke_source') => {
    setBusy(true);
    setProblem(null);
    try {
      const d = await documents.approveSource(
        ws,
        doc.id,
        verb,
        { version: doc.content_version, ...(note.trim() ? { note: note.trim() } : {}) },
        stepUp,
      );
      setNote('');
      setSaid(verb === 'approve_source' ? 'Approved this version as an AI source.' : 'Revoked the approval.');
      onChanged(d);
    } catch (err) {
      setProblem(explainDoc(err, 'that'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card doc-source" aria-labelledby="doc-source-h">
      <h2 id="doc-source-h">AI source</h2>
      <p>
        {a.approved
          ? `Version ${a.version} is approved as an AI source${a.by ? ` by ${a.by.name}` : ''}${a.at ? ` on ${day(a.at)}` : ''}.`
          : 'This version is not approved as an AI source.'}
      </p>
      <p className="hint">
        An approval applies only to this version and stops when a newer version is saved. It does
        not change who can see the document.
      </p>
      <div className="field">
        <label htmlFor="src-note">Note (optional)</label>
        <input id="src-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="actions">
        {!a.approved ? (
          <button type="button" className="button button-secondary" disabled={busy} onClick={() => void go('approve_source')}>
            Approve this version as an AI source
          </button>
        ) : (
          <button type="button" className="button button-secondary" disabled={busy} onClick={() => void go('revoke_source')}>
            Revoke approval
          </button>
        )}
      </div>
      <Problem problem={problem} />
      <p className="visually-hidden" role="status">
        {said}
      </p>
    </section>
  );
}

// -----------------------------------------------------------------------------------------------
// Mentioned in documents (backlinks)
// -----------------------------------------------------------------------------------------------

/** Documents that mention or link this record, for people who can read both (title and type only). */
export function MentionedInDocuments({ ws, rec, headingId = 'mentioned-h' }: { ws: string; rec: string; headingId?: string }) {
  const [rows, setRows] = useState<Backlink[] | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const load = useCallback(() => {
    let active = true;
    documents.backlinks(ws, rec).then(
      (r) => active && (setRows(r.data), setFailed(null)),
      (err: unknown) => active && setFailed(err),
    );
    return () => {
      active = false;
    };
  }, [ws, rec]);
  useEffect(() => load(), [load, nonce]);
  return (
    <section className="card doc-backlinks" aria-labelledby={headingId}>
      <h2 id={headingId}>Mentioned in documents</h2>
      {rows === null && !failed ? <p className="loading">Loading…</p> : null}
      {failed && !rows ? (
        <LoadProblem error={failed} what="documents" onRetry={() => setNonce((n) => n + 1)} />
      ) : null}
      {rows && rows.length === 0 ? <p>No document mentions or links this yet.</p> : null}
      {rows && rows.length ? (
        <ul className="plain-list" aria-label="Documents that mention this">
          {rows.map((d) => (
            <li key={d.id}>
              <Link to={docHref(ws, d.id)}>{d.title || 'Untitled'}</Link>{' '}
              <span className="hint">
                {DOC_TYPE_LABEL[d.doc_type] ?? d.doc_type} ·{' '}
                {d.via === 'mention' ? 'mentioned' : 'linked'}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export { blankBlock };
