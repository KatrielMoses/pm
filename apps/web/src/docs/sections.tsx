import { useEffect, useState } from 'react';
import { Problem, type Explained } from '../collab/shared.tsx';
import { documents, type DocSummary } from './client.ts';
import { DocRow, NewDocumentDialog, explainDoc } from './shared.tsx';

/**
 * The Documents section of a project or task page: the documents attached to it, newest first,
 * and "New document" which creates one attached to it. Mentions elsewhere are a separate list.
 */
export function DocumentsSection({
  ws,
  project,
  task,
  canCreate,
  noun,
  headingId = 'docs-h',
}: {
  ws: string;
  project?: string;
  task?: string;
  canCreate: boolean;
  noun: 'project' | 'task';
  headingId?: string;
}) {
  const [rows, setRows] = useState<DocSummary[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState<Explained | null>(null);
  const [more, setMore] = useState<{ busy: boolean; e: Explained | null }>({ busy: false, e: null });
  const [nonce, setNonce] = useState(0);
  const [creating, setCreating] = useState(false);
  const filter = project ? { project } : { task: task! };
  useEffect(() => {
    let active = true;
    documents.list(ws, { ...filter, limit: 25 }).then(
      (r) => {
        if (!active) return;
        setRows(r.data);
        setNext(r.page.has_more ? (r.page.next_cursor ?? null) : null);
      },
      (err: unknown) =>
        active && setFailed({ ...explainDoc(err, 'loading documents'), retryable: true }),
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, project, task, nonce]);
  const loadMore = async () => {
    if (!next) return;
    setMore({ busy: true, e: null });
    try {
      const r = await documents.list(ws, { ...filter, limit: 25, cursor: next });
      setRows((cur) => [...(cur ?? []), ...r.data]);
      setNext(r.page.has_more ? (r.page.next_cursor ?? null) : null);
      setMore({ busy: false, e: null });
    } catch (err) {
      setMore({ busy: false, e: { ...explainDoc(err, 'loading more'), retryable: true } });
    }
  };
  return (
    <section className="card doc-section" aria-labelledby={headingId}>
      <h2 id={headingId}>Documents</h2>
      <p className="hint">Briefs, notes, and decisions kept with this {noun}.</p>
      {rows === null && !failed ? <p className="loading">Loading documents…</p> : null}
      <Problem
        problem={failed}
        onRetry={() => {
          setFailed(null);
          setNonce((n) => n + 1);
        }}
      />
      {rows && rows.length === 0 ? (
        <p>No documents are attached to this {noun} yet.</p>
      ) : null}
      {rows && rows.length ? (
        <ul className="plain-list record-rows" aria-label={`Documents of this ${noun}`}>
          {rows.map((d) => (
            <DocRow key={d.id} ws={ws} d={d} />
          ))}
        </ul>
      ) : null}
      {next ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={more.busy}
          onClick={() => void loadMore()}
        >
          {more.busy ? 'Loading…' : 'Load more documents'}
        </button>
      ) : null}
      <Problem problem={more.e} onRetry={() => void loadMore()} />
      {canCreate ? (
        <div className="actions">
          <button type="button" className="button button-primary" onClick={() => setCreating(true)}>
            New document
          </button>
        </div>
      ) : null}
      {creating ? (
        <NewDocumentDialog
          ws={ws}
          title="New document"
          fixed={{
            ...(project ? { project } : { task: task! }),
            where: `on this ${noun}`,
          }}
          defaultType={project ? 'project_brief' : 'page'}
          onClose={() => setCreating(false)}
          onCreated={() => setCreating(false)}
        />
      ) : null}
    </section>
  );
}
