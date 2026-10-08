import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.ts';
import type { ReviewRequest } from '../collab/client.ts';
import { PeoplePicker, type Person } from '../collab/people-picker.tsx';
import { ReviewCard } from '../collab/reviews.tsx';
import { useStepUp } from '../stepup.tsx';
import { useResource } from '../tenancy/resource.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { ProblemBanner } from '../ui/feedback.tsx';
import { Field, SelectField, TextAreaField } from '../ui/form.tsx';
import {
  files as filesClient,
  type Deliverable,
  type DeliverableList,
  type DeliverableState,
  type DeliverableVersion,
  type FileItem,
} from './client.ts';
import { explainFileError } from './files-panel.tsx';

/**
 * Deliverables on a task (FILE-006–FILE-009, TSK-022): expected output, versions submitted for a
 * 4A review, and the acceptance record. Decisions are made through the 4A review card (the review
 * request is the authority); this panel never decides anything itself.
 */

export const DELIVERABLE_STATE_TEXT: Record<DeliverableState, string> = {
  draft: 'Draft',
  ready_for_review: 'Ready for review',
  changes_requested: 'Changes requested',
  accepted: 'Accepted',
  rejected: 'Rejected',
};
const STATE_CLASS: Record<DeliverableState, string> = {
  draft: 'badge',
  ready_for_review: 'badge badge-info',
  changes_requested: 'badge badge-warning',
  accepted: 'badge badge-success',
  rejected: 'badge badge-danger',
};

const day = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : '';

export function DeliverablesPanel({
  ws,
  tsk,
  canCreate,
  filesNonce = 0,
}: {
  ws: string;
  tsk: string;
  canCreate: boolean;
  /** Bumped when the task's files change (so the submit dialog sees new ones). */
  filesNonce?: number;
}) {
  const stepUp = useStepUp();
  const id = useId();
  const list = useResource(() => filesClient.deliverables(ws, tsk), `dlv:${ws}:${tsk}`, {
    keepOnRefreshError: true,
  });
  const [title, setTitle] = useState('');
  const [expected, setExpected] = useState<'any' | 'file' | 'url'>('any');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [said, setSaid] = useState('');
  const [submitting, setSubmitting] = useState<Deliverable | null>(null);
  const close = useCallback(() => setSubmitting(null), []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const d = await filesClient.createDeliverable(
        ws,
        tsk,
        { title: title.trim(), expected_type: expected },
        stepUp,
      );
      setTitle('');
      setSaid(`Deliverable ${d.title} added.`);
      list.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const titleError =
    error instanceof ApiError
      ? error.issues.find((i) => i.pointer === '/title')?.message
      : undefined;

  return (
    <section className="card" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Deliverables</h2>
      {list.state.status === 'loading' ? (
        <p className="loading" role="status">
          Loading deliverables…
        </p>
      ) : list.state.status === 'failed' ? (
        <ProblemBanner error={list.state.error} onRetry={list.retry} />
      ) : list.state.data.data.length ? (
        <ul className="plain-list deliverable-list" aria-label="Deliverables">
          {list.state.data.data.map((d) => (
            <DeliverableItem
              key={d.id}
              ws={ws}
              d={d}
              onSubmit={() => setSubmitting(d)}
              onChanged={() => list.reload()}
            />
          ))}
        </ul>
      ) : (
        <p className="hint">No deliverables yet. Add one to say what this task should produce.</p>
      )}
      {canCreate ? (
        <form onSubmit={create} className="deliverable-create" aria-label="Add a deliverable">
          <Field
            id={`${id}-title`}
            label="Deliverable title"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            error={titleError}
          />
          <SelectField
            id={`${id}-type`}
            label="Expected"
            value={expected}
            onChange={(v) => setExpected(v as 'any' | 'file' | 'url')}
            options={[
              { value: 'any', label: 'A file or a link' },
              { value: 'file', label: 'A file' },
              { value: 'url', label: 'A link' },
            ]}
          />
          {error && !titleError ? <ProblemBanner error={error} /> : null}
          <div className="actions">
            <button type="submit" className="button button-secondary" disabled={busy}>
              {busy ? 'Working…' : 'Add deliverable'}
            </button>
          </div>
        </form>
      ) : null}
      <p className="visually-hidden" role="status">
        {said}
      </p>
      {submitting ? (
        <SubmitDialog
          key={filesNonce}
          ws={ws}
          tsk={tsk}
          d={submitting}
          onClose={close}
          onDone={(d) => {
            setSubmitting(null);
            setSaid(`${d.title} submitted for review.`);
            list.reload();
          }}
        />
      ) : null}
    </section>
  );
}

function VersionSource({ v }: { v: DeliverableVersion }) {
  if (v.file)
    return (
      <>
        {v.file.name ?? 'A file'}
        {v.file.version ? ` (file version ${v.file.version})` : ''}
      </>
    );
  if (v.url)
    return (
      <a href={v.url} target="_blank" rel="noreferrer">
        {v.url}
        <span className="visually-hidden"> (opens in a new tab)</span>
      </a>
    );
  return <>Not shown</>;
}

function DeliverableItem({
  ws,
  d,
  onSubmit,
  onChanged,
}: {
  ws: string;
  d: Deliverable;
  onSubmit: () => void;
  onChanged: () => void;
}) {
  const latest = d.versions[0] ?? null;
  const accepted = d.versions.find((v) => v.accepted_at) ?? null;
  return (
    <li className="deliverable">
      <h3>{d.title}</h3>
      <p>
        <span className={STATE_CLASS[d.state]}>{DELIVERABLE_STATE_TEXT[d.state]}</span>{' '}
        <span className="hint">
          Expects{' '}
          {d.expected_type === 'any'
            ? 'a file or a link'
            : d.expected_type === 'file'
              ? 'a file'
              : 'a link'}
        </span>
      </p>
      {accepted ? (
        <p className="deliverable-accepted">
          <span aria-hidden="true">🔒 </span>
          Accepted by {accepted.accepted_by?.name ?? 'someone who has left'} on{' '}
          {day(accepted.accepted_at)}. Version {accepted.number} is locked.
        </p>
      ) : null}
      {d.versions.length ? (
        <ol className="plain-list deliverable-versions" aria-label={`Versions of ${d.title}`}>
          {d.versions.map((v) => (
            <li key={v.number}>
              <strong>Version {v.number}</strong>: <VersionSource v={v} />
              <span className="hint">
                {' '}
                · submitted by {v.submitted_by?.name ?? 'someone who has left'} on{' '}
                {day(v.created_at)}
              </span>
              {v.note ? <p className="review-note">{v.note}</p> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {latest?.review ? (
        <DeliverableReview ws={ws} rvw={latest.review} onChanged={onChanged} />
      ) : null}
      {d.can.submit ? (
        <div className="actions actions-compact">
          <button type="button" className="button button-secondary" onClick={onSubmit}>
            {d.versions.length ? 'Submit a new version…' : 'Submit for review…'}
            <span className="visually-hidden"> {d.title}</span>
          </button>
        </div>
      ) : null}
    </li>
  );
}

function DeliverableReview({
  ws,
  rvw,
  onChanged,
}: {
  ws: string;
  rvw: string;
  onChanged: () => void;
}) {
  const r = useResource(
    async () =>
      (await api<{ data: ReviewRequest }>('GET', `/v1/workspaces/${ws}/reviews/${rvw}`)).body.data,
    `rvw:${ws}:${rvw}`,
  );
  if (r.state.status !== 'ready') return null;
  return (
    <ReviewCard
      ws={ws}
      review={r.state.data}
      onStale={() => {
        r.reload();
        onChanged();
      }}
      onChanged={(next) => {
        r.set(next);
        onChanged();
      }}
    />
  );
}

function SubmitDialog({
  ws,
  tsk,
  d,
  onClose,
  onDone,
}: {
  ws: string;
  tsk: string;
  d: Deliverable;
  onClose: () => void;
  onDone: (d: Deliverable) => void;
}) {
  const stepUp = useStepUp();
  const id = useId();
  const [source, setSource] = useState<'file' | 'url'>(d.expected_type === 'url' ? 'url' : 'file');
  const [taskFiles, setTaskFiles] = useState<FileItem[] | null>(null);
  const [file, setFile] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [reviewers, setReviewers] = useState<Person[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    filesClient.list(ws, tsk).then(
      (l) => {
        const clean = l.data.filter((f) => f.current?.state === 'ready');
        setTaskFiles(clean);
        setFile((cur) => cur || clean[0]?.id || '');
      },
      () => setTaskFiles([]),
    );
  }, [ws, tsk]);
  const issue = (ptr: string) =>
    error instanceof ApiError ? error.issues.find((i) => i.pointer === ptr)?.message : undefined;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(
        await filesClient.submit(
          ws,
          d.id,
          {
            ...(source === 'file' ? { file } : { url: url.trim() }),
            ...(note.trim() ? { note: note.trim() } : {}),
            reviewers: reviewers.map((r) => r.id),
          },
          d.version,
          stepUp,
        ),
      );
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  const fieldErr = issue('/file') ?? issue('/url') ?? issue('/note') ?? issue('/reviewers');
  return (
    <Dialog title={`Submit ${d.title} for review`} onClose={onClose}>
      <form onSubmit={submit}>
        {d.expected_type === 'any' ? (
          <fieldset className="choices">
            <legend>What are you submitting?</legend>
            <label className="choice">
              <input
                type="radio"
                name={`${id}-src`}
                checked={source === 'file'}
                onChange={() => setSource('file')}
              />
              A file on this task
            </label>
            <label className="choice">
              <input
                type="radio"
                name={`${id}-src`}
                checked={source === 'url'}
                onChange={() => setSource('url')}
              />
              A link
            </label>
          </fieldset>
        ) : null}
        {source === 'file' ? (
          taskFiles === null ? (
            <p className="loading">Loading files…</p>
          ) : taskFiles.length ? (
            <SelectField
              id={`${id}-file`}
              label="File"
              hint="Only files that passed their scan are listed."
              value={file}
              onChange={setFile}
              options={taskFiles.map((f) => ({ value: f.id, label: f.name }))}
              error={issue('/file')}
            />
          ) : (
            <p className="hint">
              No ready files on this task. Upload one in Files and wait until it says Ready.
            </p>
          )
        ) : (
          <Field
            id={`${id}-url`}
            label="Link"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            error={issue('/url')}
          />
        )}
        <TextAreaField
          id={`${id}-note`}
          label="Note (optional)"
          value={note}
          maxLength={2000}
          onChange={setNote}
          error={issue('/note')}
        />
        <PeoplePicker
          ws={ws}
          rec={tsk}
          legend="Reviewers"
          mode="many"
          selected={reviewers}
          onChange={setReviewers}
          error={issue('/reviewers')}
        />
        {error && !fieldErr ? <p className="field-error">{explainFileError(error)}</p> : null}
        <div className="actions">
          <button
            type="submit"
            className="button button-primary"
            disabled={busy || (source === 'file' && !file)}
          >
            {busy ? 'Working…' : 'Submit for review'}
          </button>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** PRJ-023: accepted versus pending deliverables in a project (only tasks the viewer can read). */
export function DeliverablesSummary({ ws, prj }: { ws: string; prj: string }) {
  const r = useResource(() => filesClient.deliverables(ws, prj), `dlv:${ws}:${prj}`);
  const id = useId();
  return (
    <section className="card" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Deliverables</h2>
      {r.state.status === 'loading' ? (
        <p className="loading" role="status">
          Loading deliverables…
        </p>
      ) : r.state.status === 'failed' ? (
        <ProblemBanner error={r.state.error} onRetry={r.retry} />
      ) : (
        <SummaryBody list={r.state.data} />
      )}
    </section>
  );
}

function SummaryBody({ list }: { list: DeliverableList }) {
  const c = list.counts;
  if (!list.data.length) return <p className="hint">No deliverables in tasks you can see.</p>;
  return (
    <>
      <p>
        {c.accepted} accepted · {c.pending} pending review
        {c.changes_requested ? ` · ${c.changes_requested} with changes requested` : ''}
        {c.draft ? ` · ${c.draft} not yet submitted` : ''}
        {c.rejected ? ` · ${c.rejected} rejected` : ''}
      </p>
      <p className="hint">Counts cover tasks you can access.</p>
      <ul className="plain-list deliverable-list" aria-label="Project deliverables">
        {list.data.map((d) => (
          <li key={d.id}>
            <strong>{d.title}</strong>{' '}
            <span className={STATE_CLASS[d.state]}>{DELIVERABLE_STATE_TEXT[d.state]}</span>
            {d.task.title ? <span className="hint"> · {d.task.title}</span> : null}
          </li>
        ))}
      </ul>
    </>
  );
}
