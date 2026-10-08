import { useState, type FormEvent } from 'react';
import { ApiError } from '../api.ts';
import { useDraft, useOnline } from '../collab/shared.tsx';
import { useStepUp } from '../stepup.tsx';
import { useResource } from '../tenancy/resource.tsx';
import { Banner } from '../ui/feedback.tsx';
import { Field, SelectField, TextAreaField } from '../ui/form.tsx';
import {
  CONFIDENCE_LABEL,
  goals,
  type Checkin,
  type CheckinInput,
  type Confidence,
  type CreatedCheckin,
  type GoalDetail,
  type KeyResult,
  type Metric,
} from './client.ts';
import { useIdempotency } from './hooks.ts';
import {
  ConfidenceChip,
  day,
  ProblemLine,
  RadioGroup,
  parseNumber,
  useExplain,
  when,
  type Explained,
} from './shared.tsx';

/**
 * Check-ins (GOAL-004). History is append-only. The form keeps its draft through a failed send and
 * reuses one Idempotency-Key for the same content, so a retry after a dropped connection cannot
 * record the update twice.
 */

type Target = {
  id: string;
  title: string;
  basis: 'manual' | 'key_results' | 'linked_work';
  metric: Metric;
};

/** The targets a person may update: the goal and its key results (derived ones take no number). */
const targetsOf = (goal: GoalDetail): Target[] => [
  { id: '', title: 'This goal', basis: goal.basis, metric: goal.metric },
  ...goal.key_results.map((k) => ({ id: k.id, title: k.title, basis: k.basis, metric: k.metric })),
];

export function CheckinForm({
  ws,
  goal,
  initialTarget = '',
  onRecorded,
  onCancel,
}: {
  ws: string;
  goal: GoalDetail;
  /** A key result's public id, or '' for the goal itself. */
  initialTarget?: string;
  onRecorded: (c: CreatedCheckin) => void;
  onCancel?: () => void;
}) {
  const stepUp = useStepUp();
  const explainError = useExplain();
  const online = useOnline();
  const idem = useIdempotency();
  const targets = targetsOf(goal);
  const [target, setTarget] = useState(initialTarget);
  const current = targets.find((t) => t.id === target) ?? targets[0]!;
  const measurable = current.basis === 'manual';
  const byValue = measurable && current.metric.target !== null;
  const [measure, setMeasure] = useState('');
  const [confidence, setConfidence] = useState<Confidence | ''>('');
  const note = useDraft(`checkin.${goal.id.toLowerCase()}`);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [fieldError, setFieldError] = useState<Record<string, string>>({});
  const [done, setDone] = useState('');

  const build = (): { body: CheckinInput | null; errors: Record<string, string> } => {
    const errors: Record<string, string> = {};
    const body: CheckinInput = {};
    if (target) body.key_result = target;
    if (measurable && measure.trim() !== '') {
      const n = parseNumber(measure);
      if (n === undefined || n === null) errors['ci-measure'] = 'Use a number, like 12 or 0.5.';
      else if (byValue) body.value = n;
      else if (n < 0 || n > 100) errors['ci-measure'] = 'Use a percentage from 0 to 100.';
      else body.percent = n;
    }
    if (confidence) body.confidence = confidence;
    if (note.text.trim()) body.note = note.text.trim();
    if (!Object.keys(errors).length && !Object.keys(body).filter((k) => k !== 'key_result').length)
      errors['ci-note'] = 'Add a value, a confidence, or a note.';
    return { body: Object.keys(errors).length ? null : body, errors };
  };

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const { body, errors } = build();
    setFieldError(errors);
    if (!body) return;
    setBusy(true);
    setProblem(null);
    setDone('');
    try {
      // The same content always carries the same key, so a retry replays instead of repeating.
      const recorded = await goals.checkin(ws, goal.id, body, stepUp, idem.keyFor(body));
      idem.reset();
      note.discard();
      setMeasure('');
      setConfidence('');
      setDone('Check-in recorded.');
      onRecorded(recorded);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'cancelled') return;
      setProblem(explainError(err, 'recording the check-in'));
    } finally {
      setBusy(false);
    }
  };

  if (goal.capabilities && !goal.capabilities.check_in)
    return (
      <p className="hint">
        {goal.lifecycle_state !== 'active'
          ? 'This goal is archived, so check-ins are closed.'
          : goal.status !== 'draft' && goal.status !== 'active'
            ? `This goal is ${goal.status}, so check-ins are closed. Set it back to Active to record an update.`
            : "You don't have permission to record check-ins on this goal."}
      </p>
    );

  return (
    <form
      className="gl-checkin"
      onSubmit={(e) => void send(e)}
      noValidate
      aria-label="Record a check-in"
    >
      {note.restored && !done ? (
        <p className="hint" role="status">
          Your unsent note from earlier is back.
        </p>
      ) : null}
      {!online ? (
        <Banner tone="warning" title="You're offline">
          Your update is kept here. Send it when you're back online.
        </Banner>
      ) : null}
      {targets.length > 1 ? (
        <SelectField
          id="ci-target"
          label="What are you updating?"
          value={target}
          onChange={(v) => {
            setTarget(v);
            setMeasure('');
          }}
          options={targets.map((t) => ({ value: t.id, label: t.title }))}
        />
      ) : null}
      {measurable ? (
        <Field
          id="ci-measure"
          label={
            byValue
              ? `New value${current.metric.unit ? ` (${current.metric.unit})` : ''}`
              : 'Progress (percent, 0 to 100)'
          }
          hint={
            byValue
              ? `Baseline ${current.metric.baseline}, target ${current.metric.target}. Progress is how far the value has moved toward the target.`
              : undefined
          }
          inputMode="decimal"
          value={measure}
          onChange={(e) => setMeasure(e.target.value)}
          error={fieldError['ci-measure']}
        />
      ) : (
        <p className="hint">
          {current.basis === 'key_results'
            ? 'Progress is computed from the key results, so a check-in here records confidence and a note only.'
            : 'Progress is computed from linked work, so a check-in here records confidence and a note only.'}
        </p>
      )}
      <RadioGroup
        legend="Confidence"
        value={confidence}
        onChange={setConfidence}
        name={`ci-conf-${goal.id}`}
        options={[
          { value: '', label: 'No change' },
          ...(Object.keys(CONFIDENCE_LABEL) as Confidence[]).map((c) => ({
            value: c,
            label: CONFIDENCE_LABEL[c],
          })),
        ]}
      />
      <TextAreaField
        id="ci-note"
        label="Note (optional)"
        value={note.text}
        onChange={note.set}
        maxLength={2000}
        error={fieldError['ci-note']}
      />
      <ProblemLine problem={problem} busy={busy} onRetry={() => void send()}>
        <p className="hint">Your update is kept here, and a retry cannot record it twice.</p>
      </ProblemLine>
      <p className="actions">
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? 'Recording…' : 'Record check-in'}
        </button>
        {onCancel ? (
          <button type="button" className="button button-secondary" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </p>
      <p className="announce" role="status">
        {done}
      </p>
    </form>
  );
}

// ---- History ----------------------------------------------------------------------------------

function describeCheckin(c: Checkin, krs: KeyResult[], goalMetric: Metric): string {
  const parts: string[] = [];
  const unit = c.key_result ? krs.find((k) => k.id === c.key_result)?.metric.unit : goalMetric.unit;
  if (c.value !== null) parts.push(`Value ${c.value}${unit ? ` ${unit}` : ''}`);
  if (c.progress_percent !== null) parts.push(`${c.progress_percent}% progress`);
  return parts.join(' · ');
}

/** Newest first, append-only; computed roll-ups are labelled as such. */
export function CheckinHistory({
  ws,
  goal,
  nonce,
}: {
  ws: string;
  goal: GoalDetail;
  /** Changes when a check-in was recorded, so the list reloads. */
  nonce: number;
}) {
  const first = useResource(
    () => goals.checkins(ws, goal.id, { limit: 25 }),
    `ci:${ws}:${goal.id}:${nonce}`,
  );
  const [more, setMore] = useState<{
    base: string;
    items: Checkin[];
    cursor: string | null;
    hasMore: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Explained | null>(null);
  const explainError = useExplain();
  const krTitle = (id: string | null) =>
    id ? (goal.key_results.find((k) => k.id === id)?.title ?? 'A key result') : 'Goal';

  if (first.state.status === 'loading')
    return (
      <p className="loading" role="status">
        Loading check-ins…
      </p>
    );
  if (first.state.status === 'failed')
    return (
      <Banner
        tone="danger"
        title="We couldn't load the check-in history"
        action={
          <button type="button" className="button button-secondary" onClick={first.retry}>
            Try again
          </button>
        }
      >
        Try again in a moment.
      </Banner>
    );
  const base = `${goal.id}:${nonce}`;
  const page = first.state.data;
  const extra = more && more.base === base ? more : null;
  const items = [...page.data, ...(extra?.items ?? [])];
  const hasMore = extra ? extra.hasMore : page.page.has_more;
  const cursor = extra ? extra.cursor : (page.page.next_cursor ?? null);
  const load = async () => {
    if (!cursor) return;
    setLoading(true);
    setError(null);
    try {
      const next = await goals.checkins(ws, goal.id, { limit: 25, cursor });
      setMore({
        base,
        items: [...(extra?.items ?? []), ...next.data],
        cursor: next.page.next_cursor ?? null,
        hasMore: next.page.has_more,
      });
    } catch (err) {
      setError(explainError(err, 'loading more'));
    } finally {
      setLoading(false);
    }
  };
  if (!items.length)
    return <p className="hint">No check-ins yet. The history is append-only and newest first.</p>;
  return (
    <>
      <ol className="gl-history" aria-label="Check-in history, newest first">
        {items.map((c) => {
          const computed = c.source === 'computed';
          return (
            <li key={c.id} className="gl-history-item">
              <p className="gl-history-head">
                <strong>
                  {computed ? 'Computed from key results' : (c.author?.name ?? 'Former member')}
                </strong>
                <span className="hint">
                  {' '}
                  · <time dateTime={c.created_at}>{when(c.created_at)}</time> ·{' '}
                  {krTitle(c.key_result)}
                </span>
              </p>
              {describeCheckin(c, goal.key_results, goal.metric) ? (
                <p>{describeCheckin(c, goal.key_results, goal.metric)}</p>
              ) : null}
              {c.confidence ? <ConfidenceChip value={c.confidence} /> : null}
              {c.note ? <p className="gl-note">{c.note}</p> : null}
              <span className="visually-hidden">Recorded {day(c.created_at)}</span>
            </li>
          );
        })}
      </ol>
      <ProblemLine problem={error} />
      {hasMore ? (
        <p className="actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? 'Loading…' : 'Show older check-ins'}
          </button>
        </p>
      ) : null}
    </>
  );
}
