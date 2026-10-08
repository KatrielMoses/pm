import { useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api.ts';
import { explain, type Explained } from '../collab/shared.tsx';
import { Link, useRouter } from '../router.tsx';
import { BrandMarker } from '../shell/brand-marker.tsx';
import { routeHref } from '../shell/registry.ts';
import { useStepUp } from '../stepup.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { ErrorSummary, Field, SelectField, SubmitButton, fieldErrorsFrom } from '../ui/form.tsx';
import {
  documents,
  DOC_TYPES,
  STATE_LABEL,
  type Doc,
  type DocSummary,
  type DocType,
} from './client.ts';
import { newIdempotencyKey } from '../api.ts';

/** Plain copy and small pieces shared by the 4C document pages (ADR-0025). */

const DOC_CONFLICT: Record<string, string> = {
  document_archived: "This document is archived, so it can't be changed. Unarchive it to edit.",
  already_current: 'That is already the current version.',
  already_decided: 'This suggestion was already settled by someone else.',
  version_changed: 'The document changed. Look at the current version first, then try again.',
  too_large: 'This export is too large. Export fewer pages.',
  documents_attached: 'This page still has pages under it. Move or remove them first.',
  invalid_state: "That isn't possible in the document's current state.",
};
const DOC_VALIDATION: Record<string, string> = {
  too_far: 'That date is too far away. Choose a nearer review date.',
  invalid_date: 'Use a real date, like 2026-12-31.',
  invalid_reference: 'Choose from the list. That choice may have been removed or hidden.',
  not_linkable: "One of those records can't be linked. It may be hidden from you or gone.",
};

/** Turns any failure into honest, plain copy. Documents add their own conflict and date reasons. */
export function explainDoc(error: unknown, what = 'that'): Explained {
  if (error instanceof ApiError) {
    const code = error.issues[0]?.code;
    if (error.code === 'conflict' && code && DOC_CONFLICT[code])
      return {
        message: DOC_CONFLICT[code]!,
        kind: code === 'document_archived' ? 'rejected' : 'stale',
        retryable: false,
        version: error.conflict?.current_version,
      };
    if (error.code === 'validation_failed' && code && DOC_VALIDATION[code])
      return { message: DOC_VALIDATION[code]!, kind: 'rejected', retryable: false };
  }
  return explain(error, what);
}

export const isArchivedConflict = (e: unknown): boolean =>
  e instanceof ApiError && e.code === 'conflict' && e.issues.some((i) => i.code === 'document_archived');

export const isVersionConflict = (e: unknown): boolean =>
  e instanceof ApiError &&
  e.code === 'conflict' &&
  e.conflict !== undefined &&
  !e.issues.some((i) => i.code === 'document_archived');

export const docHref = (ws: string, id: string) => routeHref('document', { ws, doc: id });

/** Whether the version of the editor and the row version of the document header should be shown. */
export function StateBadges({
  doc,
}: {
  doc: Pick<DocSummary, 'state' | 'effective_state' | 'review_overdue' | 'archived'> & {
    ai_source?: Doc['ai_source'];
  };
}) {
  const label = STATE_LABEL[doc.effective_state] ?? doc.effective_state;
  return (
    <span className="doc-badges">
      <span className={`badge doc-state doc-state-${doc.effective_state}`}>
        <span aria-hidden="true">{doc.effective_state === 'current' ? '✓ ' : doc.effective_state === 'stale' ? '! ' : '… '}</span>
        {label}
      </span>
      {doc.review_overdue ? <span className="badge badge-warning">Review overdue</span> : null}
      {doc.ai_source?.approved ? <span className="badge badge-info">Approved AI source</span> : null}
      {doc.archived ? <span className="badge">Archived</span> : null}
    </span>
  );
}

export const ownerName = (o: { name: string } | null) => (o ? o.name : 'No owner');

export function DocRow({
  ws,
  d,
  showPlace = false,
}: {
  ws: string;
  d: DocSummary;
  showPlace?: boolean;
}) {
  return (
    <li className="record-row doc-row">
      <Link className="record-link" to={docHref(ws, d.id)}>
        {d.title || 'Untitled'}
      </Link>{' '}
      <span className="hint">{d.doc_type_label}</span> <StateBadges doc={d} />
      <span className="hint">
        {' '}
        · {ownerName(d.owner)} · Updated {new Date(d.updated_at).toLocaleDateString()}
        {showPlace && d.brand ? null : null}
      </span>
      {showPlace && d.brand ? (
        <span className="doc-place">
          {' '}
          <BrandMarker marker={d.brand} size={16} />
        </span>
      ) : null}
    </li>
  );
}

/** A plain block of copy about what documents don't do yet (never hidden in a tooltip). */
export function HonestAbsences() {
  return (
    <section className="card doc-absences" aria-labelledby="doc-absent-h">
      <h2 id="doc-absent-h">Not available yet</h2>
      <ul>
        <li>
          Editing together at the same time and seeing who else is here arrives with live editing
          (4D). Until then, a save that finds a newer version asks you what to keep.
        </li>
        <li>Uploading files and previewing them arrives with files (4E). Files can't be embedded yet.</li>
        <li>
          PDF export isn't offered. Save the HTML export as PDF from your browser's print dialog.
        </li>
      </ul>
    </section>
  );
}

export const STARTERS_NOTE =
  'A starter gives the page typical headings for its type. You can change or delete all of it.';

/**
 * New page: title, type, who owns it (workspace or a brand, with the brand rule), optional starter,
 * and where it goes (a parent page, a project, or a task when those are given).
 */
export function NewDocumentDialog({
  ws,
  title: dialogTitle = 'New page',
  brands,
  defaultBrand,
  fixed,
  onClose,
  onCreated,
  defaultType = 'page',
}: {
  ws: string;
  title?: string;
  /** Brands the person may place a page in (workspace-level pages are always offered). */
  brands?: Array<{ id: string; name: string }>;
  /** The brand to start from (the current brand scope, when it is just one). */
  defaultBrand?: string;
  /** A fixed placement: a parent page, a project, a task, or a brand (no choice shown). */
  fixed?: { parent?: string; project?: string; task?: string; brand?: string; where: string };
  onClose: () => void;
  onCreated: (doc: Doc) => void;
  defaultType?: DocType;
}) {
  const stepUp = useStepUp();
  const { navigate } = useRouter();
  const [title, setTitle] = useState('');
  const [type, setType] = useState<DocType>(defaultType);
  // '' means "not chosen yet": with several brands the person says which one owns the page.
  const [place, setPlace] = useState<string>(
    defaultBrand ?? (brands && brands.length > 1 ? '' : brands?.length === 1 ? brands[0]!.id : '__none'),
  );
  const [starter, setStarter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [focus, setFocus] = useState(0);
  const [local, setLocal] = useState<Record<string, string>>({});
  const key = useRef(newIdempotencyKey());
  const needsBrand = !fixed && type === 'brand_brief';
  const needsProject = type === 'project_brief' && !fixed?.project;
  const choices = brands ?? [];
  const errors: Record<string, string> = {
    ...fieldErrorsFrom(error, {
      '/title': 'new-doc-title',
      '/type': 'new-doc-type',
      '/brand': 'new-doc-place',
    }),
    ...local,
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const next: Record<string, string> = {};
    if (needsProject)
      next['new-doc-type'] = 'A project brief belongs to a project. Create it from the project page.';
    if (!fixed && choices.length && (place === '' || (needsBrand && place === '__none')))
      next['new-doc-place'] = needsBrand
        ? 'Choose the brand this brief is for.'
        : 'Choose which brand owns this, or keep it at the workspace level.';
    setLocal(next);
    if (Object.keys(next).length) {
      setFocus((n) => n + 1);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const doc = await documents.create(
        ws,
        {
          type,
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(fixed?.parent ? { parent: fixed.parent } : {}),
          ...(fixed?.project ? { project: fixed.project } : {}),
          ...(fixed?.task ? { task: fixed.task } : {}),
          ...(fixed?.brand ? { brand: fixed.brand } : {}),
          ...(!fixed && place && place !== '__none' ? { brand: place } : {}),
          starter,
        },
        stepUp,
        key.current,
      );
      onCreated(doc);
      navigate(docHref(ws, doc.id));
    } catch (err) {
      setError(err);
      setFocus((n) => n + 1);
      // A new key only after a definite answer; an unknown outcome retries with the same key.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500)
        key.current = newIdempotencyKey();
    } finally {
      setBusy(false);
    }
  };
  const problem =
    error && Object.keys(errors).length === 0 ? explainDoc(error, 'creating the page') : null;
  const placeOptions = [
    ...(place === '' ? [{ value: '', label: 'Choose where it belongs' }] : []),
    ...(needsBrand ? [] : [{ value: '__none', label: 'Workspace (no brand)' }]),
    ...choices.map((b) => ({ value: b.id, label: b.name })),
  ];
  return (
    <Dialog title={dialogTitle} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} noValidate aria-label={dialogTitle}>
        <ErrorSummary
          errors={errors}
          labels={{
            'new-doc-title': 'Title',
            'new-doc-type': 'Type',
            'new-doc-place': 'Belongs to',
          }}
          focusKey={focus}
        />
        {problem ? (
          <p className="field-error" role="alert">
            <span aria-hidden="true">! </span>
            {problem.message}
          </p>
        ) : null}
        <Field
          id="new-doc-title"
          label="Title"
          hint="Optional. You can name it later."
          maxLength={200}
          value={title}
          error={errors['new-doc-title']}
          onChange={(e) => setTitle(e.target.value)}
          data-initial
        />
        <SelectField
          id="new-doc-type"
          label="Type"
          value={type}
          error={errors['new-doc-type']}
          options={DOC_TYPES.map((t) => ({ value: t.id, label: t.label }))}
          onChange={(v) => {
            setType(v as DocType);
            setLocal({});
          }}
        />
        {fixed ? (
          <p className="hint">It will be created {fixed.where}.</p>
        ) : choices.length > 0 ? (
          <SelectField
            id="new-doc-place"
            label="Belongs to"
            hint={
              choices.length > 1
                ? 'Choose which brand owns this. Who can see it follows where it belongs.'
                : 'Who can see it follows where it belongs.'
            }
            value={needsBrand && place === '__none' ? '' : place}
            error={errors['new-doc-place']}
            options={
              needsBrand && place === '__none'
                ? [{ value: '', label: 'Choose a brand' }, ...choices.map((b) => ({ value: b.id, label: b.name }))]
                : placeOptions
            }
            onChange={(v) => {
              setPlace(v);
              setLocal({});
            }}
          />
        ) : (
          <p className="hint">It will be created at the workspace level.</p>
        )}
        <label className="choice">
          <input
            type="checkbox"
            checked={starter}
            onChange={(e) => setStarter(e.target.checked)}
          />
          Start from the type's starter
        </label>
        <p className="hint">{STARTERS_NOTE}</p>
        <div className="actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <SubmitButton busy={busy}>Create page</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

export function Status({ children }: { children: ReactNode }) {
  return (
    <p className="visually-hidden" role="status">
      {children}
    </p>
  );
}
