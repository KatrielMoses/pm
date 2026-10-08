import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api.ts';
import { CollaborationSections } from '../collab/collaboration.tsx';
import { PeoplePicker, type Person } from '../collab/people-picker.tsx';
import { day, Problem, type Explained } from '../collab/shared.tsx';
import {
  documents,
  STATE_LABEL,
  type Block,
  type Doc,
  type DocExport,
  type DocState,
  type DocSummary,
} from '../docs/client.ts';
import {
  LinkedRecords,
  SourceApproval,
  SuggestDialog,
  SuggestionsPanel,
  VersionHistory,
} from '../docs/panels.tsx';
import { DocView } from '../docs/render.tsx';
import { LiveReadView } from '../docs/live-view.tsx';
import { DocumentEditor } from '../docs/session.tsx';
import {
  HonestAbsences,
  NewDocumentDialog,
  StateBadges,
  docHref,
  explainDoc,
  ownerName,
} from '../docs/shared.tsx';
import { Link, useRouter } from '../router.tsx';
import { BrandMarker } from '../shell/brand-marker.tsx';
import { routeHref } from '../shell/registry.ts';
import { useWorkspaceShell } from '../shell/workspace.tsx';
import { useStepUp } from '../stepup.tsx';
import { LoadProblem, useResource } from '../tenancy/resource.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Banner } from '../ui/feedback.tsx';
import { fieldErrorsFrom } from '../ui/form.tsx';
import { Page } from '../ui/layout.tsx';

/** A document page (4C): header, details, subpages, the editor or a read-only view, and panels. */

export function DocumentPage({ ws, doc: id }: { ws: string; doc: string }) {
  const res = useResource(() => documents.get(ws, id), `doc:${ws}:${id}`, {
    keepOnRefreshError: true,
  });
  const [editorKey, setEditorKey] = useState(0);
  const loaded = res.state.status === 'ready' ? res.state.data : null;
  const gone =
    res.state.status === 'failed' &&
    res.state.error instanceof ApiError &&
    res.state.error.code === 'not_found';

  if (gone)
    return (
      <Page title="This document isn't available to you" section="Knowledge" record={null}>
        <p>
          It may have been moved to the trash or deleted, or you may not have access. Check the
          link, or ask the person who shared it.
        </p>
        <p className="actions">
          <Link to={routeHref('knowledge', { ws })} className="button button-primary">
            Go to Knowledge
          </Link>
        </p>
      </Page>
    );
  return (
    <DocumentFrame
      ws={ws}
      doc={loaded}
      state={res.state}
      retry={res.retry}
      editorKey={editorKey}
      set={res.set}
      refresh={async () => {
        await res.refresh();
        setEditorKey((k) => k + 1);
      }}
      reloadQuiet={() => res.reload()}
    />
  );
}

function DocumentFrame({
  ws,
  doc,
  state,
  retry,
  editorKey,
  set,
  refresh,
  reloadQuiet,
}: {
  ws: string;
  doc: Doc | null;
  state: ReturnType<typeof useResource<Doc>>['state'];
  retry: () => void;
  editorKey: number;
  set: (d: Doc) => void;
  refresh: () => Promise<void>;
  reloadQuiet: () => void;
}) {
  const shell = useWorkspaceShell();
  const guest = shell?.context?.principal === 'guest';
  const stepUp = useStepUp();
  const { navigate } = useRouter();
  const [dirty, setDirty] = useState(false);
  const onDirty = useCallback((d: boolean) => setDirty(d), []);
  const [exporting, setExporting] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const [suggesting, setSuggesting] = useState<Block | null>(null);
  const [suggestionsKey, setSuggestionsKey] = useState(0);
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [said, setSaid] = useState('');
  const [lifecycleBusy, setLifecycleBusy] = useState(false);

  const trail = doc
    ? [
        {
          label: doc.brand?.kind === 'brand' ? doc.brand.name : 'Workspace',
          ...(doc.brand ? { marker: doc.brand } : { marker: { kind: 'workspace' as const } }),
          to: routeHref('knowledge', { ws }),
        },
        ...doc.ancestors.map((a) => ({ label: a.title || 'Untitled', to: docHref(ws, a.id) })),
        { label: doc.title || 'Untitled' },
      ]
    : undefined;

  const lifecycle = async (verb: 'archive' | 'unarchive') => {
    if (!doc) return;
    setLifecycleBusy(true);
    setProblem(null);
    try {
      await documents.lifecycle(ws, doc.id, verb, stepUp);
      setSaid(verb === 'archive' ? 'Archived.' : 'Unarchived.');
      await refresh();
    } catch (err) {
      setProblem(explainDoc(err, verb === 'archive' ? 'archiving' : 'unarchiving'));
    } finally {
      setLifecycleBusy(false);
    }
  };
  const canEdit =
    !!doc && doc.capabilities.edit && !doc.archived && doc.lifecycle_state === 'active';

  return (
    <Page
      title={doc ? doc.title || 'Untitled' : 'Document'}
      wide
      section="Knowledge"
      record={doc ? { title: doc.title || 'Untitled' } : null}
      {...(trail && !guest ? { breadcrumbs: trail } : {})}
      actions={
        doc ? (
          <>
            {doc.capabilities.export ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setExporting(true)}
              >
                Export…
              </button>
            ) : null}
            {/* The server reports no archive capability on an archived page (it is judged as an archive
                of something already archived), so Unarchive is offered to members and a refusal is explained. */}
            {doc.capabilities.archive || (doc.archived && !guest) ? (
              <button
                type="button"
                className="button button-secondary"
                disabled={lifecycleBusy}
                onClick={() => void lifecycle(doc.archived ? 'unarchive' : 'archive')}
              >
                {doc.archived ? 'Unarchive' : 'Archive'}
              </button>
            ) : null}
            {doc.capabilities.trash ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setTrashing(true)}
              >
                Move to trash
              </button>
            ) : null}
          </>
        ) : null
      }
    >
      {state.status === 'loading' ? (
        <p className="loading" role="status" aria-live="polite">
          Loading document…
        </p>
      ) : null}
      {state.status === 'failed' && !doc ? (
        <LoadProblem error={state.error} what="document" onRetry={retry} />
      ) : null}
      {doc ? (
        <>
          <DocHeader ws={ws} doc={doc} />
          <Problem problem={problem} />
          <p className="visually-hidden" role="status">
            {said}
          </p>
          <DetailsCard
            ws={ws}
            doc={doc}
            onSaved={set}
            onStale={reloadQuiet}
            onMoved={() => void refresh()}
          />
          <Subpages ws={ws} doc={doc} onAdd={() => setAdding(true)} onChanged={reloadQuiet} />
          <section className="card doc-content" aria-labelledby="doc-content-h">
            <h2 id="doc-content-h">Content</h2>
            {canEdit ? (
              <DocumentEditor
                key={`${doc.id}:${editorKey}`}
                ws={ws}
                doc={doc}
                onSaved={set}
                onDirty={onDirty}
              />
            ) : (
              <>
                <p className="hint doc-readonly-note">
                  {doc.archived
                    ? 'This document is archived, so it is read-only. Unarchive it to make changes.'
                    : doc.capabilities.suggest
                      ? "You can read this document and suggest changes. You can't edit it directly."
                      : "You can read this document. You can't edit it."}
                </p>
                <div className="doc-print">
                  {!doc.archived && doc.lifecycle_state === 'active' ? (
                    <LiveReadView
                      ws={ws}
                      doc={doc}
                      {...(doc.capabilities.suggest
                        ? { suggest: (b: Block) => setSuggesting(b) }
                        : {})}
                    />
                  ) : (
                    <DocView
                      content={doc.content}
                      refs={doc.references}
                      idBase="read"
                      {...(doc.capabilities.suggest && !doc.archived
                        ? { suggest: (b: Block) => setSuggesting(b) }
                        : {})}
                    />
                  )}
                </div>
              </>
            )}
          </section>
          <VersionHistory
            ws={ws}
            doc={doc}
            canRestore={canEdit}
            dirty={dirty}
            onRestored={() => void refresh()}
            onStale={reloadQuiet}
          />
          <SuggestionsPanel
            ws={ws}
            doc={doc}
            refresh={suggestionsKey}
            onApplied={() => (dirty ? reloadQuiet() : void refresh())}
          />
          {doc.lifecycle_state !== 'trashed' ? (
            <CollaborationSections
              ws={ws}
              rec={doc.id}
              kind="document"
              version={doc.content_version}
              archived={doc.archived}
              sharedOnly={!!guest}
              onRecordChanged={reloadQuiet}
              commentsFirst
              commentsNote="Comments are on the whole document. Comments on a specific passage arrive with live editing (4D)."
            />
          ) : null}
          <LinkedRecords ws={ws} doc={doc} onSaved={set} onStale={reloadQuiet} />
          <SourceApproval ws={ws} doc={doc} onChanged={set} />
          <HonestAbsences />
        </>
      ) : null}
      {doc && exporting ? (
        <ExportDialog ws={ws} doc={doc} onClose={() => setExporting(false)} />
      ) : null}
      {doc && trashing ? (
        <Dialog
          title="Move this document to the trash?"
          destructive
          onClose={() => setTrashing(false)}
        >
          <p>
            "{doc.title || 'Untitled'}"{doc.children_count > 0 ? ' and its subpages' : ''} will
            leave Knowledge. You can restore it from the trash.
          </p>
          <TrashActions
            onCancel={() => setTrashing(false)}
            onConfirm={async () => {
              await documents.lifecycle(ws, doc.id, 'trash', stepUp);
              setTrashing(false);
              navigate(doc.parent ? docHref(ws, doc.parent.id) : routeHref('knowledge', { ws }));
            }}
          />
        </Dialog>
      ) : null}
      {doc && suggesting ? (
        <SuggestDialog
          ws={ws}
          doc={doc}
          block={suggesting}
          onClose={() => setSuggesting(null)}
          onDone={() => {
            setSuggesting(null);
            setSaid('Suggestion sent.');
            setSuggestionsKey((k) => k + 1);
            reloadQuiet();
          }}
        />
      ) : null}
      {doc && adding ? (
        <NewDocumentDialog
          ws={ws}
          title="Add page"
          fixed={{ parent: doc.id, where: 'under this page' }}
          onClose={() => setAdding(false)}
          onCreated={() => setAdding(false)}
        />
      ) : null}
    </Page>
  );
}

function TrashActions({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  return (
    <>
      <Problem problem={problem} />
      <div className="actions">
        <button type="button" className="button button-secondary" data-cancel onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="button button-danger"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setProblem(null);
            onConfirm().catch((err) => {
              setProblem(explainDoc(err, 'moving it to the trash'));
              setBusy(false);
            });
          }}
        >
          {busy ? 'Moving…' : 'Move to trash'}
        </button>
      </div>
    </>
  );
}

function DocHeader({ ws, doc }: { ws: string; doc: Doc }) {
  return (
    <div className="record-header doc-header">
      <p className="record-meta">
        <BrandMarker marker={doc.brand ?? { kind: 'workspace' }} size={20} />{' '}
        <span className="doc-type">{doc.doc_type_label}</span> <StateBadges doc={doc} />
      </p>
      <dl className="facts doc-facts">
        <dt>Owner</dt>
        <dd>{ownerName(doc.owner)}</dd>
        <dt>Review date</dt>
        <dd>{doc.review_due_on ? day(doc.review_due_on) : 'No review date'}</dd>
        {doc.attachment.kind === 'project' || doc.attachment.kind === 'task' ? (
          <>
            <dt>Attached to</dt>
            <dd>
              {doc.attachment.title ? (
                <Link
                  to={
                    doc.attachment.kind === 'project'
                      ? routeHref('project', { ws: ws, prj: doc.attachment.id! })
                      : routeHref('task', { ws: ws, tsk: doc.attachment.id! })
                  }
                >
                  {doc.attachment.title}
                </Link>
              ) : (
                `a ${doc.attachment.kind} you can't open`
              )}
            </dd>
          </>
        ) : null}
        <dt>Updated</dt>
        <dd>
          {new Date(doc.updated_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
          {doc.updated_by ? ` by ${doc.updated_by.name}` : ''}
        </dd>
      </dl>
      {doc.archived ? (
        <Banner tone="info" title="This document is archived">
          It is read-only. Unarchive it to make changes.
        </Banner>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------------------------
// Details (state, owner, review date)
// -----------------------------------------------------------------------------------------------

export function DetailsCard({
  ws,
  doc,
  onSaved,
  onStale,
  onMoved,
}: {
  ws: string;
  doc: Doc;
  onSaved: (d: Doc) => void;
  onStale: () => void;
  onMoved: () => void;
}) {
  const stepUp = useStepUp();
  const editable = doc.capabilities.edit && !doc.archived;
  const [stateValue, setStateValue] = useState<DocState>(doc.state);
  const [review, setReview] = useState(doc.review_due_on ?? '');
  const [owner, setOwner] = useState<Person[]>(
    doc.owner ? [{ id: doc.owner.id, name: doc.owner.name }] : [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  // When the document changed underneath (a reload after a conflict, a save elsewhere) and this
  // form has no edit in flight, the stored values are the new starting point.
  const [seen, setSeen] = useState(doc.version);
  if (doc.version !== seen && !busy && !error) {
    setSeen(doc.version);
    setStateValue(doc.state);
    setReview(doc.review_due_on ?? '');
    setOwner(doc.owner ? [{ id: doc.owner.id, name: doc.owner.name }] : []);
  }
  const errs = fieldErrorsFrom(error, {
    '/state': 'doc-state',
    '/owner': 'doc-owner',
    '/review_due_on': 'doc-review',
  });
  const copy = (field: string, fallback: string | undefined) => {
    if (!(error instanceof ApiError)) return fallback;
    const i = error.issues.find((x) => errs[field] === x.message);
    return i
      ? explainDoc(
          new ApiError({ code: 'validation_failed', status: 422, message: i.message, issues: [i] }),
        ).message
      : fallback;
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body: { state?: DocState; owner?: string; review_due_on?: string | null } = {};
    if (stateValue !== doc.state) body.state = stateValue;
    if ((review || null) !== doc.review_due_on) body.review_due_on = review || null;
    if (owner[0] && owner[0].id !== doc.owner?.id) body.owner = owner[0].id;
    if (!Object.keys(body).length) {
      setNotice('Nothing to change.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const d = await documents.patch(ws, doc.id, doc.version, body, stepUp);
      setSeen(d.version);
      onSaved(d);
      setNotice('Details saved.');
    } catch (err) {
      setError(err);
      if (explainDoc(err).kind === 'stale') onStale();
    } finally {
      setBusy(false);
    }
  };
  const problem = error ? explainDoc(error, 'saving the details') : null;
  const topLevelMove = async () => {
    try {
      await documents.move(ws, doc.id, { parent: null }, stepUp);
      onMoved();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <section className="card doc-details" aria-labelledby="doc-details-h">
      <h2 id="doc-details-h">Details</h2>
      {editable ? (
        <form aria-label="Document details" noValidate onSubmit={(e) => void submit(e)}>
          <div className={errs['doc-state'] ? 'field field-invalid' : 'field'}>
            <label htmlFor="doc-state">State</label>
            <p className="hint" id="doc-state-hint">
              A Current page whose review date has passed shows as Stale.
            </p>
            <select
              id="doc-state"
              value={stateValue}
              aria-describedby="doc-state-hint"
              onChange={(e) => setStateValue(e.target.value as DocState)}
            >
              {(['draft', 'current', 'stale'] as const).map((s) => (
                <option key={s} value={s}>
                  {STATE_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div className={errs['doc-review'] ? 'field field-invalid' : 'field'}>
            <label htmlFor="doc-review">Review date</label>
            {errs['doc-review'] ? (
              <p className="field-error" id="doc-review-error">
                <span aria-hidden="true">! </span>
                {copy('doc-review', errs['doc-review'])}
              </p>
            ) : null}
            <input
              id="doc-review"
              type="date"
              value={review}
              aria-describedby={errs['doc-review'] ? 'doc-review-error' : undefined}
              aria-invalid={errs['doc-review'] ? true : undefined}
              onChange={(e) => setReview(e.target.value)}
            />
          </div>
          {doc.capabilities.assign_owner ? (
            <PeoplePicker
              ws={ws}
              rec={doc.id}
              legend="Owner"
              mode="one"
              selected={owner}
              onChange={setOwner}
              error={errs['doc-owner']}
            />
          ) : (
            <p>Owner: {ownerName(doc.owner)}</p>
          )}
          {problem && Object.keys(errs).length === 0 ? <Problem problem={problem} /> : null}
          <div className="actions">
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save details'}
            </button>
            {doc.parent && doc.capabilities.move ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void topLevelMove()}
              >
                Move to top level
              </button>
            ) : null}
          </div>
          <p className="hint" role="status">
            {notice}
          </p>
        </form>
      ) : (
        <p className="hint">
          {doc.archived
            ? 'This document is archived. Unarchive it to change these details.'
            : "You can't change these details."}
        </p>
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------------------------
// Subpages
// -----------------------------------------------------------------------------------------------

export function Subpages({
  ws,
  doc,
  onAdd,
  onChanged,
}: {
  ws: string;
  doc: Doc;
  onAdd: () => void;
  onChanged: () => void;
}) {
  const stepUp = useStepUp();
  const [rows, setRows] = useState<DocSummary[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState<Explained | null>(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const show = doc.children_count > 0 || doc.capabilities.create_page;
  useEffect(() => {
    if (!show) return;
    let active = true;
    documents.list(ws, { parent: doc.id, limit: 50 }).then(
      (r) => {
        if (!active) return;
        setRows(r.data);
        setNext(r.page.has_more ? (r.page.next_cursor ?? null) : null);
        setFailed(null);
      },
      (err: unknown) =>
        active && setFailed({ ...explainDoc(err, 'loading subpages'), retryable: true }),
    );
    return () => {
      active = false;
    };
  }, [ws, doc.id, doc.children_count, nonce, show]);
  if (!show) return null;
  const move = async (i: number, dir: -1 | 1) => {
    if (!rows) return;
    const item = rows[i]!;
    const after = dir === -1 ? (rows[i - 2]?.id ?? null) : rows[i + 1]!.id;
    setBusy(true);
    try {
      await documents.move(ws, item.id, { parent: doc.id, after }, stepUp);
      setSaid(`Moved ${item.title || 'Untitled'} ${dir === -1 ? 'up' : 'down'}.`);
      setNonce((n) => n + 1);
      onChanged();
    } catch (err) {
      setFailed(explainDoc(err, 'moving the page'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card doc-subpages" aria-labelledby="doc-sub-h">
      <h2 id="doc-sub-h">Subpages</h2>
      {rows === null && !failed ? <p className="loading">Loading subpages…</p> : null}
      <Problem problem={failed} onRetry={() => setNonce((n) => n + 1)} />
      {rows && rows.length === 0 ? <p>This page has no subpages yet.</p> : null}
      {rows && rows.length ? (
        <ol className="plain-list record-rows" aria-label="Subpages">
          {rows.map((d, i) => (
            <li key={d.id} className="record-row doc-row">
              <Link className="record-link" to={docHref(ws, d.id)}>
                {d.title || 'Untitled'}
              </Link>{' '}
              <span className="hint">{d.doc_type_label}</span> <StateBadges doc={d} />
              {doc.capabilities.move ? (
                <span className="doc-row-tools">
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={busy || i === 0}
                    onClick={() => void move(i, -1)}
                  >
                    Move up <span className="visually-hidden">{d.title || 'Untitled'}</span>
                  </button>
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={busy || i === rows.length - 1}
                    onClick={() => void move(i, 1)}
                  >
                    Move down <span className="visually-hidden">{d.title || 'Untitled'}</span>
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {next ? (
        <p className="hint">
          Only the first 50 subpages are shown here. Open Knowledge to see them all.
        </p>
      ) : null}
      <p className="visually-hidden" role="status">
        {said}
      </p>
      {doc.capabilities.create_page && !doc.archived ? (
        <div className="actions">
          <button type="button" className="button button-secondary" onClick={onAdd}>
            Add page
          </button>
        </div>
      ) : null}
    </section>
  );
}

// -----------------------------------------------------------------------------------------------
// Export
// -----------------------------------------------------------------------------------------------

function saveFile(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ExportDialog({ ws, doc, onClose }: { ws: string; doc: Doc; onClose: () => void }) {
  const stepUp = useStepUp();
  const [format, setFormat] = useState<'markdown' | 'html'>('markdown');
  const [children, setChildren] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [done, setDone] = useState<DocExport | null>(null);
  const run = async () => {
    setBusy(true);
    setProblem(null);
    setDone(null);
    try {
      const out = await documents.export(
        ws,
        doc.id,
        { format, ...(children ? { include_children: true } : {}) },
        stepUp,
      );
      saveFile(out.filename, out.content, out.content_type);
      setDone(out);
    } catch (err) {
      setProblem(explainDoc(err, 'exporting'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Export this document" onClose={onClose}>
      <form
        aria-label="Export"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <fieldset className="choices">
          <legend>Format</legend>
          <label className="choice">
            <input
              type="radio"
              name="fmt"
              checked={format === 'markdown'}
              onChange={() => setFormat('markdown')}
            />
            Markdown
          </label>
          <label className="choice">
            <input
              type="radio"
              name="fmt"
              checked={format === 'html'}
              onChange={() => setFormat('html')}
            />
            HTML
          </label>
        </fieldset>
        {doc.children_count > 0 ? (
          <label className="choice">
            <input
              type="checkbox"
              checked={children}
              onChange={(e) => setChildren(e.target.checked)}
            />
            Include subpages
          </label>
        ) : null}
        <p className="hint">
          PDF isn't offered. Save the HTML export as PDF from your browser's print dialog. Only what
          you can see is exported; items you can't see are left out.
        </p>
        <Problem problem={problem} />
        {done ? (
          <div role="status" className="doc-export-notes">
            <p>
              Exported {done.pages} {done.pages === 1 ? 'page' : 'pages'} as {done.filename} (
              {done.bytes} bytes).
            </p>
            <ul>
              {done.notes.embeds_as_links > 0 ? (
                <li>{done.notes.embeds_as_links} embedded items were exported as links.</li>
              ) : null}
              {done.notes.restricted_items > 0 ? (
                <li>
                  {done.notes.restricted_items} items you can't see were left as "Restricted item".
                </li>
              ) : null}
              {done.notes.pages_omitted > 0 ? (
                <li>{done.notes.pages_omitted} pages you can't see were left out.</li>
              ) : null}
              {done.notes.unsupported.includes('pdf') ? <li>PDF is not available.</li> : null}
            </ul>
          </div>
        ) : null}
        <div className="actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            {done ? 'Close' : 'Cancel'}
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
