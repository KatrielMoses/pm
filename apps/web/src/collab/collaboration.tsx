import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api.ts';
import { useStepUp } from '../stepup.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { TextAreaField } from '../ui/form.tsx';
import { LoadProblem } from '../tenancy/resource.tsx';
import {
  collaboration,
  HANDOVER_NOTE_MAX_CHARS,
  type AssignmentEvent,
  type CollaborationSummary,
  type ReviewRequest,
} from './client.ts';
import { CommentsPanel } from './comments.tsx';
import { PeoplePicker, type Person } from './people-picker.tsx';
import { ReviewsPanel } from './reviews.tsx';
import { day, explain, Problem, when, type Explained } from './shared.tsx';

/**
 * The 4A sections of a task or project page: following, followers, review, hand-over, assignment
 * history, and comments. One summary read decides what is shown, and it is read again whenever the
 * record's version changes so a stale review is noticed. Share-only people see only what they may.
 */

type Kind = 'task' | 'project';

export function CollaborationSections({
  ws,
  rec,
  kind,
  version,
  archived,
  sharedOnly,
  onRecordChanged,
}: {
  ws: string;
  rec: string;
  kind: Kind;
  /** The record's current version (a review is about one version of it). */
  version: number;
  archived: boolean;
  /** Share-only readers: no people picker, no history. */
  sharedOnly: boolean;
  /** Called after something that changes the record itself (a hand-over). */
  onRecordChanged: () => void;
}) {
  const [summary, setSummary] = useState<CollaborationSummary | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const have = useRef(false);
  useEffect(() => {
    let active = true;
    collaboration.summary(ws, rec).then(
      (s) => {
        if (!active) return;
        have.current = true;
        setSummary(s);
        setFailed(null);
      },
      (err: unknown) => {
        if (!active) return;
        // A background refresh that fails keeps what is on screen, unless the record is gone.
        if (!have.current || (err instanceof ApiError && err.code === 'not_found')) setFailed(err);
      },
    );
    return () => {
      active = false;
    };
  }, [ws, rec, version, nonce]);

  if (!summary) {
    if (failed)
      return (
        <section className="card collab-card" aria-labelledby={`collab-h-${rec}`}>
          <h2 id={`collab-h-${rec}`}>Following and comments</h2>
          <LoadProblem
            error={failed}
            what="comments"
            onRetry={() => {
              setFailed(null);
              setNonce((n) => n + 1);
            }}
          />
        </section>
      );
    return (
      <section className="card collab-card" aria-labelledby={`collab-h-${rec}`}>
        <h2 id={`collab-h-${rec}`}>Following and comments</h2>
        <p className="loading" role="status">
          Loading comments…
        </p>
      </section>
    );
  }
  const caps = summary.capabilities;
  const showReviews = caps.request_review || !!summary.review;
  return (
    <>
      <FollowCard ws={ws} rec={rec} kind={kind} summary={summary} onSummary={setSummary} />
      {showReviews ? (
        <ReviewsPanel
          ws={ws}
          rec={rec}
          noun={kind}
          subjectVersion={version}
          archived={archived}
          review={summary.review ?? null}
          canRequest={caps.request_review}
          onReview={(r: ReviewRequest) => setSummary({ ...summary, review: r })}
          onStale={() => setNonce((n) => n + 1)}
        />
      ) : null}
      {kind === 'task' && !sharedOnly ? (
        <AssignmentSection
          ws={ws}
          tsk={rec}
          version={version}
          canDelegate={caps.delegate}
          onRecordChanged={onRecordChanged}
        />
      ) : null}
      <CommentsPanel
        ws={ws}
        rec={rec}
        canComment={caps.comment}
        archived={archived}
        canMention={!sharedOnly}
        noun={kind}
      />
    </>
  );
}

function FollowCard({
  ws,
  rec,
  kind,
  summary,
  onSummary,
}: {
  ws: string;
  rec: string;
  kind: Kind;
  summary: CollaborationSummary;
  onSummary: (s: CollaborationSummary) => void;
}) {
  const stepUp = useStepUp();
  const [problem, setProblem] = useState<Explained | null>(null);
  const [said, setSaid] = useState('');
  const [followers, setFollowers] = useState(false);
  const pending = useRef(false);
  const following = summary.following;
  const toggle = async () => {
    if (pending.current) return;
    pending.current = true;
    const want = !following;
    // Immediate: the button flips now and is put back, with a message, if the server refuses.
    onSummary({ ...summary, following: want });
    setProblem(null);
    setSaid(want ? `You follow this ${kind}.` : `You no longer follow this ${kind}.`);
    try {
      const next = await collaboration.follow(ws, rec, want, stepUp);
      onSummary({ ...summary, ...next, review: summary.review });
    } catch (err) {
      onSummary(summary);
      const e = explain(err, want ? 'following' : 'unfollowing');
      setProblem({
        ...e,
        message: `${want ? "We couldn't follow this" : "We couldn't stop following this"} ${kind}, so nothing changed. ${e.message}`,
      });
      setSaid('');
    } finally {
      pending.current = false;
    }
  };
  return (
    <section className="card collab-card" aria-labelledby={`follow-h-${rec}`}>
      <h2 id={`follow-h-${rec}`}>Following</h2>
      <p className="hint">
        Follow this {kind} to find it under My Work, Following. Following is yours alone and gives
        no one any access.
      </p>
      {summary.capabilities.follow ? (
        <div className="actions">
          <button
            type="button"
            className="button button-secondary follow-button"
            aria-pressed={following}
            onClick={() => void toggle()}
          >
            <span aria-hidden="true">{following ? '✓ ' : ''}</span>Follow
          </button>
        </div>
      ) : (
        <p className="hint">You can't follow this {kind}.</p>
      )}
      <p className="collab-state">
        {following
          ? `You follow this ${kind}${summary.followed_at ? ` since ${day(summary.followed_at)}` : ''}.`
          : `You are not following this ${kind}.`}
      </p>
      <Problem problem={problem} onRetry={() => void toggle()} />
      <p className="visually-hidden" role="status">
        {said}
      </p>
      {summary.capabilities.see_followers ? (
        <>
          <button
            type="button"
            className="button button-ghost"
            aria-expanded={followers}
            aria-controls={`followers-${rec}`}
            onClick={() => setFollowers((f) => !f)}
          >
            {followers ? 'Hide followers' : 'Followers'}
          </button>
          {followers ? <Followers id={`followers-${rec}`} ws={ws} rec={rec} /> : null}
        </>
      ) : null}
    </section>
  );
}

function Followers({ id, ws, rec }: { id: string; ws: string; rec: string }) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; rows: Array<{ id: string; name: string; since: string }> }
    | { status: 'failed'; e: Explained }
  >({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let active = true;
    collaboration.followers(ws, rec).then(
      (rows) => active && setState({ status: 'ready', rows }),
      (err: unknown) =>
        active && setState({ status: 'failed', e: explain(err, 'loading followers') }),
    );
    return () => {
      active = false;
    };
  }, [ws, rec, nonce]);
  return (
    <div id={id}>
      {state.status === 'loading' ? <p className="loading">Loading followers…</p> : null}
      {state.status === 'failed' ? (
        <Problem
          problem={{ ...state.e, retryable: state.e.kind !== 'gone' }}
          onRetry={() => {
            setState({ status: 'loading' });
            setNonce((n) => n + 1);
          }}
        />
      ) : null}
      {state.status === 'ready' && !state.rows.length ? (
        <p className="hint">Nobody who can see this follows it yet.</p>
      ) : null}
      {state.status === 'ready' && state.rows.length ? (
        <ul className="plain-list" aria-label="Followers">
          {state.rows.map((f) => (
            <li key={f.id}>
              {f.name} <span className="hint">since {day(f.since)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function HandOverDialog({
  ws,
  tsk,
  onClose,
  onDone,
}: {
  ws: string;
  tsk: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const stepUp = useStepUp();
  const [to, setTo] = useState<Person[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [pickError, setPickError] = useState<string | undefined>();
  const go = async () => {
    if (!to.length) {
      setPickError('Choose who takes this over.');
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await collaboration.delegate(
        ws,
        tsk,
        { to: to[0]!.id, ...(note.trim() ? { note: note.trim() } : {}) },
        stepUp,
      );
      onDone();
    } catch (err) {
      setProblem(explain(err, 'handing over'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Hand this task over"
      description="Your own assignment moves to the person you choose, and the history keeps a record of who handed it over. Handing over changes who is responsible, never who can see the task."
      onClose={onClose}
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <PeoplePicker
          ws={ws}
          rec={tsk}
          legend="Who takes this over?"
          mode="one"
          selected={to}
          onChange={(p) => {
            setTo(p);
            setPickError(undefined);
          }}
          error={pickError}
        />
        <TextAreaField
          id="handover-note"
          label="Note (optional)"
          value={note}
          onChange={setNote}
          maxLength={HANDOVER_NOTE_MAX_CHARS}
        />
        <Problem problem={problem} onRetry={() => void go()} busy={busy} />
        <div className="actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Handing over…' : 'Hand over'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const EVENT_TEXT = (e: AssignmentEvent): string => {
  const from = e.from?.name ?? 'someone';
  const to = e.to?.name ?? 'someone';
  const by = e.by ? ` by ${e.by.name}` : '';
  if (e.via === 'departure') return `${from} left, so the task was unassigned.`;
  switch (e.kind) {
    case 'delegated':
      return `${from} handed this over to ${to}.`;
    case 'reassigned':
      return `Reassigned from ${from} to ${to}${by}.`;
    case 'unassigned':
      return `${from} was unassigned${by}.`;
    default:
      return `${to} was assigned${by}.`;
  }
};

/** Who held the task and who handed it to whom. Absent (not an error) when the reader has no ownership. */
function AssignmentSection({
  ws,
  tsk,
  version,
  canDelegate,
  onRecordChanged,
}: {
  ws: string;
  tsk: string;
  version: number;
  canDelegate: boolean;
  onRecordChanged: () => void;
}) {
  const [handing, setHanding] = useState(false);
  const [said, setSaid] = useState('');
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<AssignmentEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable' | 'failed'>('loading');
  const [problem, setProblem] = useState<Explained | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    collaboration.assignmentHistory(ws, tsk).then(
      (r) => {
        if (!active) return;
        setRows(r.data);
        setCursor(r.page.has_more ? (r.page.next_cursor ?? null) : null);
        setStatus('ready');
      },
      (err: unknown) => {
        if (!active) return;
        // 404 here means "not shown to you" (a share does not carry ownership), not a fault.
        if (err instanceof ApiError && err.code === 'not_found') setStatus('unavailable');
        else {
          setProblem({ ...explain(err, 'loading the history'), retryable: true });
          setStatus('failed');
        }
      },
    );
    return () => {
      active = false;
    };
  }, [open, ws, tsk, version, nonce]);
  const more = async () => {
    if (!cursor) return;
    setBusy(true);
    try {
      const r = await collaboration.assignmentHistory(ws, tsk, cursor);
      setRows((p) => [...p, ...r.data]);
      setCursor(r.page.has_more ? (r.page.next_cursor ?? null) : null);
    } catch (err) {
      setProblem({ ...explain(err, 'loading more'), retryable: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card collab-card" aria-labelledby={`assign-h-${tsk}`}>
      <h2 id={`assign-h-${tsk}`}>Assignment history</h2>
      {canDelegate ? (
        <div className="actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setHanding(true)}
          >
            Hand over…
          </button>
        </div>
      ) : null}
      <p className="visually-hidden" role="status">
        {said}
      </p>
      <button
        type="button"
        className="button button-ghost"
        aria-expanded={open}
        aria-controls={`assign-body-${tsk}`}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'Hide assignment history' : 'Show assignment history'}
      </button>
      {open ? (
        <div id={`assign-body-${tsk}`}>
          {status === 'loading' ? <p className="loading">Loading history…</p> : null}
          {status === 'unavailable' ? (
            <p className="hint">The assignment history isn't available to you for this task.</p>
          ) : null}
          {status === 'failed' ? (
            <Problem
              problem={problem}
              onRetry={() => {
                setStatus('loading');
                setNonce((n) => n + 1);
              }}
            />
          ) : null}
          {status === 'ready' && !rows.length ? (
            <p className="hint">Nobody has been assigned, reassigned, or handed this task yet.</p>
          ) : null}
          {status === 'ready' && rows.length ? (
            <ol className="plain-list assignment-history" aria-label="Assignment history">
              {rows.map((e, i) => (
                <li key={`${e.at}-${i}`}>
                  <span>{EVENT_TEXT(e)}</span> <span className="hint">{when(e.at)}</span>
                  {e.note ? <p className="review-note">{e.note}</p> : null}
                </li>
              ))}
            </ol>
          ) : null}
          {status === 'ready' && problem ? (
            <Problem problem={problem} onRetry={() => void more()} />
          ) : null}
          {cursor ? (
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => void more()}
            >
              {busy ? 'Loading…' : 'Load more'}
            </button>
          ) : null}
        </div>
      ) : null}
      {handing ? (
        <HandOverDialog
          ws={ws}
          tsk={tsk}
          onClose={() => setHanding(false)}
          onDone={() => {
            setHanding(false);
            setOpen(true);
            setNonce((n) => n + 1);
            setSaid('Handed over. The assignment history shows the change.');
            onRecordChanged();
          }}
        />
      ) : null}
    </section>
  );
}
