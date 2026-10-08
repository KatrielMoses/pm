import { useEffect, useState } from 'react';
import { useStepUp } from '../stepup.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Banner } from '../ui/feedback.tsx';
import { SelectField, TextAreaField } from '../ui/form.tsx';
import {
  collaboration,
  REVIEW_NOTE_MAX_CHARS,
  type ReviewKind,
  type ReviewOutcome,
  type ReviewRequest,
  type ReviewRule,
} from './client.ts';
import { PeoplePicker, type Person } from './people-picker.tsx';
import {
  day,
  explain,
  OUTCOME_LABEL,
  Problem,
  REVIEW_STATE_LABEL,
  when,
  type Explained,
} from './shared.tsx';

/**
 * Reviews and approvals on a task or project (4A, ADR-0023 D7). A request names reviewers, a rule
 * and a kind, and is tied to the version of the record that was looked at. Decisions are typed and
 * final; if the record changes after the request, decisions stop and the requester asks again.
 */

export function StateBadge({ state }: { state: string }) {
  const s = REVIEW_STATE_LABEL[state] ?? { icon: '•', text: state };
  return (
    <span className={`badge review-state review-state-${state}`}>
      <span aria-hidden="true">{s.icon} </span>
      {s.text}
    </span>
  );
}

const RULE_TEXT: Record<ReviewRule, string> = {
  any: 'The first answer settles it.',
  all: 'Everyone has to approve.',
};

function ReviewerList({ review }: { review: ReviewRequest }) {
  return (
    <ul className="plain-list reviewers" aria-label="Reviewers">
      {review.reviewers.map((r, i) => (
        <li key={r.member?.id ?? `gone-${i}`}>
          <strong>{r.member ? r.member.name : 'Someone who has left'}</strong>
          {r.mine ? <span className="hint"> (you)</span> : null}
          {' — '}
          {r.decision ? (
            <>
              <span>{OUTCOME_LABEL[r.decision.outcome] ?? r.decision.outcome}</span>{' '}
              <span className="hint">
                {when(r.decision.at)}
                {r.decision.self_approval ? ' · decided on their own request' : ''}
              </span>
              {r.decision.note ? <p className="review-note">{r.decision.note}</p> : null}
            </>
          ) : (
            <span className="hint">Has not answered yet</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ReviewCard({
  ws,
  review,
  onChanged,
  onStale,
  compact = false,
}: {
  ws: string;
  review: ReviewRequest;
  onChanged: (r: ReviewRequest) => void;
  onStale: () => void;
  compact?: boolean;
}) {
  const stepUp = useStepUp();
  const [deciding, setDeciding] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const open = review.state === 'requested';
  const mine = review.reviewers.find((r) => r.mine);
  const caps = review.capabilities;
  const kindName = review.kind === 'approval' ? 'Approval' : 'Review';

  const askAgain = async () => {
    setBusy(true);
    setProblem(null);
    try {
      onChanged(await collaboration.refresh(ws, review.id, stepUp));
    } catch (err) {
      const e = explain(err, 'asking again');
      setProblem(e);
      if (e.kind === 'stale' || e.kind === 'gone') onStale();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="review-card" aria-label={`${kindName} request`} role="group">
      <p className="review-head">
        <strong>{kindName} requested</strong> <StateBadge state={review.state} />
      </p>
      <p className="hint">
        {review.requested_by
          ? `Asked by ${review.requested_by.name}`
          : 'Asked by someone who has left'}{' '}
        · {when(review.created_at)} · {RULE_TEXT[review.rule]}
        {review.settled_at ? ` · Settled ${day(review.settled_at)}` : ''}
      </p>
      {review.message ? <p className="review-note">{review.message}</p> : null}
      {review.stale && open ? (
        <Banner
          tone="warning"
          title="This changed after the review began"
          action={
            caps.refresh ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void askAgain()}
                disabled={busy}
              >
                {busy ? 'Asking…' : 'Ask again'}
              </button>
            ) : null
          }
        >
          Answers are paused because they would be about an older version.{' '}
          {caps.refresh
            ? 'Ask again to send a new request about the latest version.'
            : 'The person who asked can send a new request.'}
        </Banner>
      ) : review.stale && !compact ? (
        <p className="hint">
          <span aria-hidden="true">! </span>This changed after the review settled.
        </p>
      ) : null}
      <ReviewerList review={review} />
      <Problem problem={problem} />
      {open && !compact ? (
        <div className="actions">
          {caps.decide && mine && !mine.decision && !review.stale ? (
            <button
              type="button"
              className="button button-primary"
              onClick={() => setDeciding(true)}
            >
              Decide…
            </button>
          ) : null}
          {caps.withdraw ? (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setWithdrawing(true)}
            >
              Withdraw request…
            </button>
          ) : null}
        </div>
      ) : null}
      {deciding ? (
        <DecideDialog
          ws={ws}
          review={review}
          onClose={() => setDeciding(false)}
          onStale={onStale}
          onDone={(r) => {
            setDeciding(false);
            onChanged(r);
          }}
        />
      ) : null}
      {withdrawing ? (
        <WithdrawDialog
          ws={ws}
          review={review}
          onClose={() => setWithdrawing(false)}
          onDone={(r) => {
            setWithdrawing(false);
            onChanged(r);
          }}
        />
      ) : null}
    </div>
  );
}

const OUTCOMES: Array<{ value: ReviewOutcome; label: string; hint: string }> = [
  { value: 'approved', label: 'Approve', hint: 'It is good to go.' },
  { value: 'changes_requested', label: 'Request changes', hint: 'It needs work first.' },
  { value: 'rejected', label: 'Reject', hint: "It shouldn't go ahead." },
];

function DecideDialog({
  ws,
  review,
  onClose,
  onDone,
  onStale,
}: {
  ws: string;
  review: ReviewRequest;
  onClose: () => void;
  onDone: (r: ReviewRequest) => void;
  onStale: () => void;
}) {
  const stepUp = useStepUp();
  const [outcome, setOutcome] = useState<ReviewOutcome | ''>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [missing, setMissing] = useState(false);
  const submit = async () => {
    if (!outcome) {
      setMissing(true);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      onDone(
        await collaboration.decide(
          ws,
          review.id,
          {
            outcome,
            ...(note.trim() ? { note: note.trim() } : {}),
            subject_version: review.current_version,
          },
          stepUp,
        ),
      );
    } catch (err) {
      const e = explain(err, 'sending your decision');
      setProblem(e);
      // The record or the request moved on: refresh the page data underneath this dialog.
      if (e.kind === 'stale' || e.kind === 'rejected' || e.kind === 'gone') onStale();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={review.kind === 'approval' ? 'Decide on this approval' : 'Decide on this review'}
      description={`Your answer is final and is recorded with the version of "${review.subject.title}" you are looking at now.`}
      onClose={onClose}
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className={missing ? 'choices field-invalid' : 'choices'}>
          <legend>Your decision</legend>
          {missing ? (
            <p className="field-error" role="alert">
              <span aria-hidden="true">! </span>Choose approve, request changes, or reject.
            </p>
          ) : null}
          {OUTCOMES.map((o) => (
            <label className="choice" key={o.value}>
              <input
                type="radio"
                name="decision"
                value={o.value}
                checked={outcome === o.value}
                onChange={() => {
                  setOutcome(o.value);
                  setMissing(false);
                }}
              />
              <span>
                {o.label} <span className="hint">— {o.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <TextAreaField
          id="decision-note"
          label="Note (optional)"
          value={note}
          onChange={setNote}
          maxLength={REVIEW_NOTE_MAX_CHARS}
        />
        <Problem problem={problem} onRetry={() => void submit()} busy={busy} />
        <div className="actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            {problem && !problem.retryable ? 'Close' : 'Cancel'}
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Sending…' : 'Send decision'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function WithdrawDialog({
  ws,
  review,
  onClose,
  onDone,
}: {
  ws: string;
  review: ReviewRequest;
  onClose: () => void;
  onDone: (r: ReviewRequest) => void;
}) {
  const stepUp = useStepUp();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const go = async () => {
    setBusy(true);
    setProblem(null);
    try {
      onDone(await collaboration.withdraw(ws, review.id, note.trim() || undefined, stepUp));
    } catch (err) {
      setProblem(explain(err, 'withdrawing'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Withdraw this request?"
      description="Reviewers can no longer answer it. Answers already given stay on record. You can ask again afterwards."
      onClose={onClose}
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <TextAreaField
          id="withdraw-note"
          label="Reason (optional)"
          value={note}
          onChange={setNote}
          maxLength={500}
        />
        <Problem problem={problem} onRetry={() => void go()} busy={busy} />
        <div className="actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Keep the request
          </button>
          <button type="submit" className="button button-danger" disabled={busy}>
            {busy ? 'Withdrawing…' : 'Withdraw request'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function RequestDialog({
  ws,
  rec,
  noun,
  subjectVersion,
  onClose,
  onDone,
  onStale,
}: {
  ws: string;
  rec: string;
  noun: 'task' | 'project';
  subjectVersion: number;
  onClose: () => void;
  onDone: (r: ReviewRequest) => void;
  onStale: () => void;
}) {
  const stepUp = useStepUp();
  const [people, setPeople] = useState<Person[]>([]);
  const [rule, setRule] = useState<ReviewRule>('any');
  const [kind, setKind] = useState<ReviewKind>('review');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [pickError, setPickError] = useState<string | undefined>();
  const submit = async () => {
    if (!people.length) {
      setPickError('Choose at least one reviewer.');
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      onDone(
        await collaboration.requestReview(
          ws,
          rec,
          {
            reviewers: people.map((p) => p.id),
            rule,
            kind,
            ...(message.trim() ? { message: message.trim() } : {}),
            subject_version: subjectVersion,
          },
          stepUp,
        ),
      );
    } catch (err) {
      const e = explain(err, 'sending the request');
      setProblem(e);
      if (e.kind === 'stale' || (e.kind === 'rejected' && !e.retryable)) onStale();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Request a review"
      description={`Choose who looks at this ${noun}. Only people who can already see it can be asked, and asking gives no one new access.`}
      onClose={onClose}
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <PeoplePicker
          ws={ws}
          rec={rec}
          legend="Reviewers"
          mode="many"
          selected={people}
          onChange={(p) => {
            setPeople(p);
            setPickError(undefined);
          }}
          error={pickError}
        />
        <SelectField
          id="review-kind"
          label="What are you asking for?"
          value={kind}
          onChange={(v) => setKind(v as ReviewKind)}
          options={[
            { value: 'review', label: 'A review (feedback)' },
            { value: 'approval', label: 'An approval (a yes or no)' },
          ]}
        />
        <SelectField
          id="review-rule"
          label="Who has to answer?"
          value={rule}
          onChange={(v) => setRule(v as ReviewRule)}
          options={[
            { value: 'any', label: 'Any one reviewer — the first answer settles it' },
            { value: 'all', label: 'All reviewers — everyone has to approve' },
          ]}
        />
        <TextAreaField
          id="review-message"
          label="Message (optional)"
          value={message}
          onChange={setMessage}
          maxLength={REVIEW_NOTE_MAX_CHARS}
        />
        <Problem problem={problem} onRetry={() => void submit()} busy={busy} />
        <div className="actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Sending…' : 'Send request'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function EarlierReviews({
  ws,
  rec,
  currentId,
  version,
}: {
  ws: string;
  rec: string;
  currentId: string | null;
  version: number;
}) {
  const [rows, setRows] = useState<ReviewRequest[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [cursor, setCursor] = useState<string | null>(null);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let active = true;
    collaboration.reviews(ws, rec).then(
      (r) => {
        if (!active) return;
        setRows(r.data);
        setCursor(r.page.has_more ? (r.page.next_cursor ?? null) : null);
        setState('ready');
      },
      (err: unknown) => {
        if (!active) return;
        setProblem(explain(err, 'loading'));
        setState('failed');
      },
    );
    return () => {
      active = false;
    };
  }, [ws, rec, currentId, version, nonce]);
  const more = async () => {
    if (!cursor) return;
    setBusy(true);
    setProblem(null);
    try {
      const r = await collaboration.reviews(ws, rec, cursor);
      setRows((p) => [...p, ...r.data.filter((x) => !p.some((y) => y.id === x.id))]);
      setCursor(r.page.has_more ? (r.page.next_cursor ?? null) : null);
    } catch (err) {
      setProblem(explain(err, 'loading more'));
    } finally {
      setBusy(false);
    }
  };
  if (state === 'loading') return <p className="loading">Loading earlier reviews…</p>;
  if (state === 'failed')
    return (
      <Problem
        problem={{ ...problem!, retryable: true }}
        onRetry={() => {
          setState('loading');
          setNonce((n) => n + 1);
        }}
      />
    );
  const earlier = rows.filter((r) => r.id !== currentId);
  if (!earlier.length) return <p className="hint">There are no earlier reviews.</p>;
  return (
    <>
      <ol className="plain-list review-history" aria-label="Earlier reviews">
        {earlier.map((r) => (
          <li key={r.id}>
            <ReviewCard
              ws={ws}
              review={r}
              compact
              onChanged={() => undefined}
              onStale={() => undefined}
            />
          </li>
        ))}
      </ol>
      <Problem problem={problem && { ...problem, retryable: true }} onRetry={() => void more()} />
      {cursor ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={busy}
          onClick={() => void more()}
        >
          {busy ? 'Loading…' : 'Load more reviews'}
        </button>
      ) : null}
    </>
  );
}

export function ReviewsPanel({
  ws,
  rec,
  noun,
  subjectVersion,
  archived,
  review,
  canRequest,
  onReview,
  onStale,
}: {
  ws: string;
  rec: string;
  noun: 'task' | 'project';
  subjectVersion: number;
  archived: boolean;
  review: ReviewRequest | null;
  canRequest: boolean;
  onReview: (r: ReviewRequest) => void;
  onStale: () => void;
}) {
  const [requesting, setRequesting] = useState(false);
  const [history, setHistory] = useState(false);
  const [said, setSaid] = useState('');
  const open = review?.state === 'requested';
  return (
    <section className="card collab-card" aria-labelledby={`reviews-h-${rec}`}>
      <h2 id={`reviews-h-${rec}`}>Review</h2>
      {review ? (
        <ReviewCard
          ws={ws}
          review={review}
          onStale={onStale}
          onChanged={(r) => {
            onReview(r);
            setSaid(
              r.state === 'requested'
                ? 'A new request was sent.'
                : `Review ${r.state.replace('_', ' ')}.`,
            );
          }}
        />
      ) : (
        <p className="hint">Nobody has been asked to review this {noun} yet.</p>
      )}
      {canRequest && !open ? (
        archived ? (
          <p className="hint">This {noun} is archived. Restore it to ask for a review.</p>
        ) : (
          <div className="actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setRequesting(true)}
            >
              Request review…
            </button>
          </div>
        )
      ) : null}
      {review || canRequest ? (
        <>
          <button
            type="button"
            className="button button-ghost"
            aria-expanded={history}
            onClick={() => setHistory((h) => !h)}
          >
            {history ? 'Hide earlier reviews' : 'Earlier reviews'}
          </button>
          {history ? (
            <EarlierReviews
              ws={ws}
              rec={rec}
              currentId={review?.id ?? null}
              version={review?.version ?? 0}
            />
          ) : null}
        </>
      ) : null}
      <p className="visually-hidden" role="status">
        {said}
      </p>
      {requesting ? (
        <RequestDialog
          ws={ws}
          rec={rec}
          noun={noun}
          subjectVersion={subjectVersion}
          onClose={() => setRequesting(false)}
          onStale={onStale}
          onDone={(r) => {
            setRequesting(false);
            onReview(r);
            setSaid('Review requested.');
          }}
        />
      ) : null}
    </section>
  );
}
