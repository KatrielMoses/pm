import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, newIdempotencyKey } from '../api.ts';
import { Problem, useAccountId, useOnline, type Explained } from '../collab/shared.tsx';
import { useLeaveGuard } from '../router.tsx';
import { discardDraft, loadDraft, saveDraft } from '../shell/drafts.ts';
import { useStepUp } from '../stepup.tsx';
import { Banner } from '../ui/feedback.tsx';
import { documents, type Block, type Doc } from './client.ts';
import { BlockEditor } from './editor.tsx';
import { applyReview, buildReview, type ReviewRow, type Side } from './merge.ts';
import {
  blocksToPlainText,
  collectLabels,
  labelsInBlocks,
  contentFingerprint,
  groupIssues,
  newKey,
  toBlock,
  toEdit,
  type EditBlock,
} from './model.ts';
import { blockSummary, DocView } from './render.tsx';
import { explainDoc, isArchivedConflict, isVersionConflict } from './shared.tsx';

/**
 * Editing one document (4C): the title, the block editor, saving against the version that was
 * loaded, and everything that can go wrong without losing a word: a newer version (409), no
 * connection, a rejected block (422), too many saves (429), archiving or lost access while writing.
 * Text is kept on this device (the shell's draft store) until the server has accepted it.
 */

export const draftKeyFor = (ws: string, doc: string) =>
  `doc.${ws.toLowerCase()}.${doc.toLowerCase()}`;

type Failure =
  | { kind: 'offline'; e: Explained }
  | { kind: 'limit'; e: Explained }
  | { kind: 'invalid'; e: Explained }
  | { kind: 'other'; e: Explained };
type Locked = 'archived' | 'permission' | 'gone' | null;

interface StoredDraft {
  base: number;
  title: string;
  blocks: Array<Omit<EditBlock, 'key'>>;
}

const withKeys = (blocks: StoredDraft['blocks']): EditBlock[] =>
  blocks.map((b) => {
    const k = { ...b, key: newKey() } as EditBlock;
    if (k.type === 'checklist') k.items = k.items.map((i) => ({ ...i, key: newKey() }));
    return k;
  });

const fromDoc = (d: Doc): EditBlock[] => d.content.blocks.map((b) => toEdit(b, d.references));

export function readDraft(account: string, ws: string, doc: Doc): StoredDraft | null {
  const raw = loadDraft(account, draftKeyFor(ws, doc.id));
  if (!raw) return null;
  try {
    const d = JSON.parse(raw.value) as StoredDraft;
    if (typeof d.base !== 'number' || typeof d.title !== 'string' || !Array.isArray(d.blocks))
      return null;
    return d;
  } catch {
    return null;
  }
}

function download(name: string, text: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DocumentEditor({
  ws,
  doc,
  onSaved,
  onDirty,
  footer,
}: {
  ws: string;
  doc: Doc;
  /** The server accepted a save (or a newer version was loaded): the page replaces its copy. */
  onSaved: (d: Doc) => void;
  onDirty: (dirty: boolean) => void;
  footer?: ReactNode;
}) {
  const account = useAccountId();
  const stepUp = useStepUp();
  const online = useOnline();
  const key = draftKeyFor(ws, doc.id);

  const initial = useMemo(() => {
    const server = fromDoc(doc);
    const draft = readDraft(account, ws, doc);
    if (draft) {
      const blocks = withKeys(draft.blocks);
      if (
        contentFingerprint(blocks, draft.title) !== contentFingerprint(server, doc.title)
      )
        return { blocks, title: draft.title, base: draft.base, restored: true, server };
    }
    return { blocks: server, title: doc.title, base: doc.content_version, restored: false, server };
    // Loaded once per mount; the page remounts the editor when the content is replaced from outside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [title, setTitle] = useState(initial.title);
  const [blocks, setBlocks] = useState<EditBlock[]>(initial.blocks);
  const [base, setBase] = useState(initial.base);
  const [baseline, setBaseline] = useState(() => contentFingerprint(initial.server, doc.title));
  const [restored, setRestored] = useState(initial.restored);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [issues, setIssues] = useState<ApiIssueList>([]);
  const [conflict, setConflict] = useState<{ current: number } | null>(null);
  const [locked, setLocked] = useState<Locked>(null);
  const [mine, setMine] = useState<{ name: string; text: string } | null>(null);
  const [kept, setKept] = useState(true);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [said, setSaid] = useState('');
  const attempt = useRef<{ fp: string; key: string; unknown: boolean } | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const fp = contentFingerprint(blocks, title);
  const dirty = fp !== baseline;
  useLeaveGuard(dirty, dirty);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  // Keep what has been typed on this device until the server has it.
  const live = useRef({ blocks, title, base, dirty });
  useEffect(() => {
    live.current = { blocks, title, base, dirty };
  });
  const persist = useCallback(() => {
    const l = live.current;
    if (!l.dirty) {
      discardDraft(account, key);
      return;
    }
    const data: StoredDraft = {
      base: l.base,
      title: l.title,
      blocks: l.blocks.map(({ key: _k, ...rest }) => rest),
    };
    setKept(saveDraft(account, key, JSON.stringify(data)));
  }, [account, key]);
  useEffect(() => {
    const t = setTimeout(persist, 250);
    return () => clearTimeout(t);
  }, [fp, base, persist]);
  useEffect(() => {
    window.addEventListener('pagehide', persist);
    return () => {
      window.removeEventListener('pagehide', persist);
      persist();
    };
  }, [persist]);

  const grouped = useMemo(() => groupIssues(issues), [issues]);
  const issueMap = grouped.byBlock;

  const save = useCallback(async () => {
    const cur = live.current;
    if (saving || locked) return;
    const sentBlocks = cur.blocks;
    const sentTitle = cur.title.trim();
    const sentFp = contentFingerprint(sentBlocks, cur.title);
    const prior = attempt.current;
    const idem = prior && prior.unknown && prior.fp === sentFp ? prior.key : newIdempotencyKey();
    attempt.current = { fp: sentFp, key: idem, unknown: false };
    setSaving(true);
    setFailure(null);
    setIssues([]);
    setSaid('Saving…');
    try {
      const d = await documents.saveContent(
        ws,
        doc.id,
        {
          base_version: cur.base,
          ...(sentTitle ? { title: sentTitle } : {}),
          content: { v: 2, blocks: sentBlocks.map((b) => toBlock(b)) },
        },
        stepUp,
        idem,
      );
      // New blocks now have identifiers; blocks changed while saving stay as typed (and unsaved).
      const idByKey = new Map(
        sentBlocks.map((b, i) => [b.key, d.content.blocks[i]?.id] as const),
      );
      const withIds = (list: EditBlock[]) =>
        list.map((b) => {
          const id = idByKey.get(b.key);
          return id && !b.id ? ({ ...b, id } as EditBlock) : b;
        });
      setBlocks((now) => withIds(now));
      setBase(d.content_version);
      setBaseline(contentFingerprint(withIds(sentBlocks), sentTitle));
      setConflict(null);
      setRestored(false);
      setSaid('Saved.');
      // The server has it: nothing more to keep here unless more was typed while saving.
      if (contentFingerprint(live.current.blocks, live.current.title) === sentFp)
        discardDraft(account, key);
      onSaved(d);
    } catch (err) {
      const e = explainDoc(err, 'saving');
      setSaid('');
      // Whatever went wrong, what was typed is on this device before anything is said about it.
      persist();
      if (err instanceof ApiError) {
        if (isArchivedConflict(err)) {
          setLocked('archived');
          return;
        }
        if (isVersionConflict(err)) {
          setConflict({ current: err.conflict!.current_version });
          return;
        }
        if (err.code === 'not_found') {
          setLocked('gone');
          return;
        }
        if (err.code === 'forbidden') {
          setLocked('permission');
          return;
        }
        if (err.code === 'validation_failed') {
          setIssues(err.issues);
          setFailure({
            kind: 'invalid',
            e: {
              ...e,
              message:
                err.issues.length > 0
                  ? "Couldn't save: some parts need attention. They are marked below, and nothing was lost."
                  : `Couldn't save: ${e.message}`,
            },
          });
          return;
        }
        if (err.code === 'rate_limited') {
          setFailure({ kind: 'limit', e: { ...e, message: `Couldn't save: ${e.message}` } });
          return;
        }
        if (err.code === 'offline' || err.code === 'network' || err.status >= 500)
          attempt.current = { fp: sentFp, key: idem, unknown: true };
        if (err.code === 'offline' || err.code === 'network') {
          setFailure({
            kind: 'offline',
            e: {
              ...e,
              message:
                "Couldn't save: you're offline or the connection dropped. Your changes are kept on this device. Try again when you're back online.",
            },
          });
          return;
        }
      }
      setFailure({ kind: 'other', e: { ...e, message: `Couldn't save: ${e.message}` } });
    } finally {
      setSaving(false);
    }
  }, [saving, locked, ws, doc.id, stepUp, onSaved, persist, account, key]);

  const label = useCallback((_key: string, _label: string) => undefined, []);

  // ---- A newer version exists --------------------------------------------------------------
  const keepMine = (): { name: string; text: string } => {
    const text = blocksToPlainText(title, blocks);
    const m = { name: `my-version-${doc.id.toLowerCase()}.txt`, text };
    setMine(m);
    return m;
  };
  const loadLatest = async () => {
    try {
      const d = await documents.get(ws, doc.id);
      keepMine();
      const next = fromDoc(d);
      setBlocks(next);
      setTitle(d.title);
      setBase(d.content_version);
      setBaseline(contentFingerprint(next, d.title));
      setConflict(null);
      setFailure(null);
      setIssues([]);
      setRestored(false);
      discardDraft(account, key);
      setSaid('Loaded the latest version. Your version is kept below as a download.');
      onSaved(d);
    } catch (err) {
      setFailure({ kind: 'other', e: { ...explainDoc(err, 'loading the latest version'), retryable: true } });
    }
  };
  const startReview = async () => {
    setReview({ status: 'loading' });
    try {
      const latest = await documents.get(ws, doc.id);
      let baseBlocks: Block[] | null = null;
      try {
        baseBlocks = (await documents.version(ws, doc.id, base)).content.blocks;
      } catch {
        baseBlocks = null;
      }
      const mineBlocks = blocks.map((b) => toBlock(b));
      const rows = buildReview(baseBlocks, mineBlocks, latest.content.blocks);
      setReview({
        status: 'ready',
        latest,
        mineBlocks,
        rows,
        picks: Object.fromEntries(rows.flatMap((r) => (r.preset ? [[r.id, r.preset]] : []))),
        titleDiffers: title.trim() !== latest.title,
        mineTitle: title.trim(),
        titlePick: null,
      });
    } catch (err) {
      setReview({ status: 'failed', e: explainDoc(err, 'loading the latest version') });
    }
  };
  const applyReviewChoices = () => {
    if (review?.status !== 'ready') return;
    const { latest, mineBlocks, rows, picks } = review;
    const merged = applyReview(mineBlocks, latest.content.blocks, rows, (r) => picks[r.id] ?? 'theirs');
    const next = merged.map((b) =>
      toEdit(b, latest.references, { ...labelsInBlocks(blocks), ...collectLabels(latest.references) }),
    );
    keepMine();
    setBlocks(next);
    setTitle(review.titleDiffers && review.titlePick === 'mine' ? title : latest.title);
    setBase(latest.content_version);
    setBaseline(contentFingerprint(fromDoc(latest), latest.title));
    setConflict(null);
    setFailure(null);
    setReview(null);
    setSaid('Your choices are in the editor. Save to keep them on top of the latest version.');
    onSaved(latest);
  };

  const discardRestored = () => {
    const server = fromDoc(doc);
    setBlocks(server);
    setTitle(doc.title);
    setBase(doc.content_version);
    setBaseline(contentFingerprint(server, doc.title));
    setRestored(false);
    discardDraft(account, key);
    setSaid('Discarded the restored changes.');
  };

  const status = saving
    ? 'Saving…'
    : conflict
      ? "Couldn't save: someone saved a newer version."
      : failure
        ? failure.e.message
        : dirty
          ? kept
            ? 'Unsaved changes (kept on this device)'
            : "Unsaved changes (too large to keep on this device, so save soon)"
          : 'Saved';
  const stateKind = saving ? 'saving' : conflict || failure ? 'failed' : dirty ? 'dirty' : 'saved';

  if (locked) {
    const text = blocksToPlainText(title, blocks);
    return (
      <div className="doc-locked">
        <Banner
          tone="warning"
          title={
            locked === 'archived'
              ? 'This document is archived, so it is read-only now'
              : locked === 'gone'
                ? "This document isn't available to you any more"
                : "You can't edit this any more"
          }
          action={
            <button
              type="button"
              className="button button-secondary"
              onClick={() => download(`my-version-${doc.id.toLowerCase()}.txt`, text)}
            >
              Download my unsaved text
            </button>
          }
        >
          {locked === 'archived'
            ? 'Unarchive it to make changes. What you had typed is kept on this device.'
            : locked === 'gone'
              ? 'It may have been moved to the trash, or your access may have changed. What you had typed is kept on this device.'
              : 'Your access to edit it changed. What you had typed is kept on this device, and you can still read it below.'}
        </Banner>
        <DocView
          content={{ v: 2, blocks: blocks.map((b) => toBlock(b)) }}
          refs={doc.references}
          idBase="locked"
          label="Your last text"
        />
      </div>
    );
  }

  return (
    <div
      className="doc-session"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          void save();
        }
      }}
    >
      {restored ? (
        <Banner
          tone="info"
          title="Restored your unsaved changes from this device"
          action={
            <button type="button" className="button button-secondary" onClick={discardRestored}>
              Discard restored changes
            </button>
          }
        >
          These changes were not saved yet. Save to keep them, or discard them to go back to the
          saved document.
        </Banner>
      ) : null}
      {mine ? (
        <Banner
          tone="info"
          title="Your version was kept"
          action={
            <button
              type="button"
              className="button button-secondary"
              onClick={() => download(mine.name, mine.text)}
            >
              Download my version
            </button>
          }
        >
          The editor now shows the latest saved version. Your own text is still available as a
          download.
        </Banner>
      ) : null}
      {conflict ? (
        <div className="doc-conflict" role="alert">
          <p className="banner-title">Someone saved a newer version</p>
          <p>
            Your changes are still here and nothing was overwritten. You were editing version{' '}
            {base}; the latest is version {conflict.current}.
          </p>
          <div className="actions">
            <button
              type="button"
              className="button button-primary"
              onClick={() => void loadLatest()}
            >
              Load latest
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void startReview()}
            >
              Review my changes
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                const m = keepMine();
                download(m.name, m.text);
              }}
            >
              Download my version
            </button>
          </div>
          <p className="hint">
            Load latest replaces what is in the editor with the latest saved version, and keeps your
            text as a download. Review my changes lets you choose, block by block.
          </p>
        </div>
      ) : null}
      {review ? (
        <ReviewPanel
          state={review}
          onChange={setReview}
          onApply={applyReviewChoices}
          onClose={() => setReview(null)}
          onRetry={() => void startReview()}
        />
      ) : null}
      <div className="field doc-title-field">
        <label htmlFor="doc-title">Title</label>
        <input
          id="doc-title"
          ref={titleRef}
          value={title}
          maxLength={200}
          autoComplete="off"
          aria-describedby={grouped.general.length ? 'doc-general-issues' : undefined}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      {grouped.general.length ? (
        <ul className="doc-issues" id="doc-general-issues" role="alert">
          {grouped.general.map((i, n) => (
            <li key={n} className="field-error">
              <span aria-hidden="true">! </span>
              {i.message}
            </li>
          ))}
        </ul>
      ) : null}
      <BlockEditor
        ws={ws}
        doc={doc.id}
        blocks={blocks}
        onChange={setBlocks}
        issues={issueMap}
        onLabel={label}
        onSubmit={() => void save()}
        idBase="ed"
      />
      <div className="doc-savebar" data-state={stateKind}>
        <button
          type="button"
          className="button button-primary"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <p className="doc-save-state" role="status" id="doc-save-state">
          <span aria-hidden="true">
            {stateKind === 'saved' ? '✓ ' : stateKind === 'failed' ? '! ' : stateKind === 'dirty' ? '● ' : '… '}
          </span>
          {status}
        </p>
        <p className="hint">Ctrl or Cmd + S also saves.</p>
      </div>
      {failure ? (
        <Problem
          problem={{ ...failure.e, retryable: failure.kind !== 'invalid' }}
          onRetry={() => void save()}
          busy={saving}
        >
          {failure.kind === 'offline' && !online ? (
            <p className="hint">You are offline right now.</p>
          ) : null}
        </Problem>
      ) : null}
      <p className="visually-hidden" role="status">
        {said}
      </p>
      {footer}
    </div>
  );
}

type IssueItem = { pointer?: string; code: string; message: string };
type ApiIssueList = IssueItem[];

type ReviewState =
  | { status: 'loading' }
  | { status: 'failed'; e: Explained }
  | {
      status: 'ready';
      latest: Doc;
      mineBlocks: Block[];
      rows: ReviewRow[];
      picks: Record<string, Side>;
      titleDiffers: boolean;
      mineTitle: string;
      titlePick: Side | null;
    };

const KIND_COPY: Record<ReviewRow['kind'], string> = {
  mine_changed: 'Only you changed this.',
  theirs_changed: 'Only someone else changed this.',
  both_changed: 'You and someone else both changed this.',
  differs: 'This differs.',
  added_by_me: 'You added this.',
  added_by_them: 'Someone else added this.',
  removed_by_me: 'You removed this.',
  removed_by_them: 'Someone else removed this.',
};

function ReviewPanel({
  state,
  onChange,
  onApply,
  onClose,
  onRetry,
}: {
  state: ReviewState;
  onChange: (s: ReviewState) => void;
  onApply: () => void;
  onClose: () => void;
  onRetry: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (state.status === 'ready') ref.current?.focus();
  }, [state.status]);
  if (state.status === 'loading')
    return (
      <p className="loading" role="status">
        Loading the latest version…
      </p>
    );
  if (state.status === 'failed')
    return (
      <Problem problem={{ ...state.e, retryable: true }} onRetry={onRetry}>
        <button type="button" className="button button-ghost" onClick={onClose}>
          Close
        </button>
      </Problem>
    );
  const { rows, latest, picks } = state;
  const missing = rows.filter((r) => !picks[r.id]).length + (state.titleDiffers && !state.titlePick ? 1 : 0);
  const summary = (b: Block | null) =>
    b ? blockSummary(b, latest.references) || '(empty)' : '(nothing: not there)';
  return (
    <section
      className="card doc-review"
      aria-labelledby="doc-review-h"
      tabIndex={-1}
      ref={ref}
    >
      <h2 id="doc-review-h">Review my changes</h2>
      <p>
        {rows.length === 0 && !state.titleDiffers
          ? 'Your text and the latest version are the same.'
          : `Your changes are on the left, the latest saved version (${latest.content_version}) on the right. Choose one for each difference, then save.`}
      </p>
      {state.titleDiffers ? (
        <fieldset className="doc-review-row">
          <legend>Title</legend>
          <div className="doc-review-cols">
            <p>
              <strong>Yours:</strong> {state.mineTitle || '(no title)'}
            </p>
            <p>
              <strong>Latest:</strong> {latest.title}
            </p>
          </div>
          <label className="choice">
            <input
              type="radio"
              name="pick-title"
              checked={state.titlePick === 'mine'}
              onChange={() => onChange({ ...state, titlePick: 'mine' })}
            />
            Keep my title
          </label>
          <label className="choice">
            <input
              type="radio"
              name="pick-title"
              checked={state.titlePick === 'theirs'}
              onChange={() => onChange({ ...state, titlePick: 'theirs' })}
            />
            Use the latest title
          </label>
        </fieldset>
      ) : null}
      <ul className="plain-list">
        {rows.map((r, n) => (
          <li key={r.id}>
            <fieldset className="doc-review-row">
              <legend>
                Difference {n + 1} of {rows.length}: {KIND_COPY[r.kind]}
              </legend>
              <div className="doc-review-cols">
                <div>
                  <p className="doc-review-label">Your version</p>
                  <p className="doc-review-text">{summary(r.mine)}</p>
                </div>
                <div>
                  <p className="doc-review-label">Latest version</p>
                  <p className="doc-review-text">{summary(r.latest)}</p>
                </div>
              </div>
              <label className="choice">
                <input
                  type="radio"
                  name={`pick-${r.id}`}
                  checked={picks[r.id] === 'mine'}
                  onChange={() => onChange({ ...state, picks: { ...picks, [r.id]: 'mine' } })}
                />
                Keep mine
              </label>
              <label className="choice">
                <input
                  type="radio"
                  name={`pick-${r.id}`}
                  checked={picks[r.id] === 'theirs'}
                  onChange={() => onChange({ ...state, picks: { ...picks, [r.id]: 'theirs' } })}
                />
                Use the latest
              </label>
            </fieldset>
          </li>
        ))}
      </ul>
      <p className="hint" role="status">
        {missing ? `${missing} still to choose.` : 'Every difference has a choice.'}
      </p>
      <div className="actions">
        <button
          type="button"
          className="button button-primary"
          disabled={missing > 0}
          onClick={onApply}
        >
          Use these choices
        </button>
        <button type="button" className="button button-secondary" onClick={onClose}>
          Cancel
        </button>
      </div>
    </section>
  );
}
