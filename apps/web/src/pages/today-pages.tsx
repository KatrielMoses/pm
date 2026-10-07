import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../api.ts';
import {
  deviceZone,
  localInstant,
  planning,
  timeOf,
  type Block,
  type Commitment,
  type TaskBrief,
  type TodayView,
} from '../planning/client.ts';
import { Link } from '../router.tsx';
import { routeHref } from '../shell/registry.ts';
import { useStepUp } from '../stepup.tsx';
import { ResourceView, useResource } from '../tenancy/resource.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Announce, Banner } from '../ui/feedback.tsx';
import { Field, SelectField } from '../ui/form.tsx';
import { Page } from '../ui/layout.tsx';

/**
 * Phase 3C Today (0E Phase 3C note, ADR-0020): the day in the person's own zone (OD-18) with
 * commitments in manual order, scheduled work blocks, and separate overdue, due-today, and
 * upcoming-deadline sections; daily planning; blocks with focus, lock, preparation, and buffer;
 * recurring blocks; and shutdown with carry, pick a day, return, or leave. Nothing here changes a
 * due date or deadline. Capacity (3E) and meetings (6C) are honest absences.
 */

const describe = (err: unknown, fallback = 'That did not work. Try again.') =>
  err instanceof ApiError
    ? err.code === 'offline' || err.code === 'network'
      ? "You're offline. Nothing changed; try again when you're back."
      : err.code === 'conflict' && !err.issues.length
        ? 'This changed elsewhere. The day has been refreshed.'
        : (err.issues[0]?.message ?? (err.code === 'cancelled' ? 'Cancelled.' : fallback))
    : fallback;

const shiftDay = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dayTitle = (day: string, today: string) =>
  day === today
    ? 'Today'
    : new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC',
      });
const mins = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
const WARN: Record<Block['warnings'][number], string> = {
  after_due_date: 'Ends after the due date',
  after_deadline: 'Ends after the deadline',
};
const OUTCOME: Record<Commitment['outcome'], string> = {
  open: '',
  done: 'Done',
  carried: 'Carried over',
  returned: 'Returned to backlog',
  dropped: 'Not finished',
};

function useRunner(reload: () => void) {
  const stepUp = useStepUp();
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: (s: typeof stepUp) => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn(stepUp);
      setSaid(done);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
      reload();
    }
  };
  return { said, error, busy, run };
}

function TaskList({
  ws,
  title,
  id,
  items,
  hasMore,
  onCommit,
  empty,
  busy,
}: {
  ws: string;
  title: string;
  id: string;
  items: TaskBrief[];
  hasMore: boolean;
  onCommit?: (t: TaskBrief) => void;
  empty: string;
  busy: boolean;
}) {
  return (
    <section className="card" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {items.length ? (
        <ul className="today-list">
          {items.map((t) => (
            <li key={t.id} className="today-item">
              <span className="today-item-main">
                <Link to={routeHref('task', { ws, tsk: t.id })}>{t.title}</Link>{' '}
                <span className="hint">
                  · {t.brand.name}
                  {t.due_date ? ` · due ${t.due_date}` : ''}
                  {t.deadline_date ? ` · deadline ${t.deadline_date}` : ''}
                  {t.estimate_minutes ? ` · ${mins(t.estimate_minutes)}` : ''}
                </span>
              </span>
              {t.committed ? (
                <span className="badge">On today</span>
              ) : onCommit ? (
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={busy}
                  onClick={() => onCommit(t)}
                  aria-label={`Add ${t.title} to this day`}
                >
                  Add to day
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">{empty}</p>
      )}
      {hasMore ? <p className="hint">More are not shown; open My Work for the full list.</p> : null}
    </section>
  );
}

function ShutdownDialog({
  ws,
  v,
  onClose,
  onDone,
}: {
  ws: string;
  v: TodayView;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const stepUp = useStepUp();
  const open = v.committed.filter((c) => c.outcome === 'open' && !c.done);
  const [choice, setChoice] = useState<Record<string, { action: string; day: string }>>(() =>
    Object.fromEntries(
      open.map((c) => [
        c.task.id,
        { action: c.locked ? 'leave' : 'carry', day: shiftDay(v.day, 2) },
      ]),
    ),
  );
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await planning.shutdown(
        ws,
        v.day,
        open.map((c) => ({
          task: c.task.id,
          action: choice[c.task.id]!.action,
          ...(choice[c.task.id]!.action === 'pick_day' ? { day: choice[c.task.id]!.day } : {}),
        })),
        stepUp,
      );
      onDone(
        `Day closed: ${r.completed} done, ${r.carried} carried over, ${r.returned} returned, ${r.dropped} not finished.`,
      );
      onClose();
    } catch (err) {
      setError(describe(err));
    }
  };
  return (
    <Dialog
      title="Shut down the day"
      description="Decide what happens to unfinished work. Due dates and deadlines never change here."
      onClose={onClose}
    >
      <form onSubmit={(e) => void submit(e)} noValidate>
        {open.length ? (
          open.map((c) => (
            <fieldset key={c.task.id} className="shutdown-item">
              <legend>
                {c.task.title}
                {c.locked ? <span className="hint"> (locked: it stays as is)</span> : null}
              </legend>
              <SelectField
                id={`sd-${c.task.id}`}
                label="What happens to it"
                value={choice[c.task.id]!.action}
                disabled={c.locked}
                onChange={(a) =>
                  setChoice((x) => ({ ...x, [c.task.id]: { ...x[c.task.id]!, action: a } }))
                }
                options={[
                  { value: 'carry', label: 'Carry to tomorrow' },
                  { value: 'pick_day', label: 'Pick a day' },
                  { value: 'return', label: 'Return to backlog' },
                  { value: 'leave', label: 'Leave it unfinished' },
                ]}
              />
              {choice[c.task.id]!.action === 'pick_day' ? (
                <Field
                  id={`sd-day-${c.task.id}`}
                  label="Day"
                  type="date"
                  min={shiftDay(v.day, 1)}
                  value={choice[c.task.id]!.day}
                  onChange={(e) =>
                    setChoice((x) => ({
                      ...x,
                      [c.task.id]: { ...x[c.task.id]!, day: e.target.value },
                    }))
                  }
                />
              ) : null}
            </fieldset>
          ))
        ) : (
          <p>Everything on this day is done or decided.</p>
        )}
        {error ? <p className="field-error">{error}</p> : null}
        <div className="actions">
          <button type="submit" className="button button-primary" data-initial>
            Close the day
          </button>
          <button type="button" className="button button-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function BlockForm({ ws, v, onDone }: { ws: string; v: TodayView; onDone: (msg: string) => void }) {
  const stepUp = useStepUp();
  const [what, setWhat] = useState(v.committed[0]?.task.id ?? '');
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('09:00');
  const [duration, setDuration] = useState('60');
  const [focus, setFocus] = useState(false);
  const [prep, setPrep] = useState('0');
  const [buffer, setBuffer] = useState('0');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const b = await planning.createBlock(
        ws,
        {
          ...(what ? { task: what } : { title }),
          starts_at: localInstant(v.day, start),
          duration_minutes: Number(duration),
          focus,
          prep_minutes: Number(prep),
          buffer_minutes: Number(buffer),
        },
        stepUp,
      );
      onDone(
        `Scheduled ${timeOf(b.starts_at)}–${timeOf(b.ends_at)}.${b.warnings.length ? ` ${b.warnings.map((x) => WARN[x]).join('. ')}.` : ''}`,
      );
      setTitle('');
    } catch (err) {
      setError(describe(err));
    }
  };
  return (
    <form
      className="grant-form"
      aria-label="Schedule a block"
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <SelectField
        id="blk-what"
        label="For"
        value={what}
        onChange={setWhat}
        options={[
          ...v.committed
            .filter((c) => c.outcome === 'open')
            .map((c) => ({ value: c.task.id, label: c.task.title })),
          { value: '', label: 'Something else (name it)' },
        ]}
      />
      {what ? null : (
        <Field
          id="blk-title"
          label="Name"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
        />
      )}
      <Field
        id="blk-start"
        label="Start"
        type="time"
        value={start}
        onChange={(e) => setStart(e.target.value)}
      />
      <Field
        id="blk-duration"
        label="Minutes"
        type="number"
        min={5}
        max={1440}
        value={duration}
        onChange={(e) => setDuration(e.target.value)}
      />
      <Field
        id="blk-prep"
        label="Preparation (min)"
        type="number"
        min={0}
        max={240}
        value={prep}
        onChange={(e) => setPrep(e.target.value)}
      />
      <Field
        id="blk-buffer"
        label="Buffer after (min)"
        type="number"
        min={0}
        max={240}
        value={buffer}
        onChange={(e) => setBuffer(e.target.value)}
      />
      <label className="choice">
        <input type="checkbox" checked={focus} onChange={(e) => setFocus(e.target.checked)} /> Focus
        block (protected)
      </label>
      <button type="submit" className="button button-secondary">
        Schedule
      </button>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function SeriesSection({ ws, onDone }: { ws: string; onDone: (msg: string) => void }) {
  const stepUp = useStepUp();
  const [nonce, setNonce] = useState(0);
  const data = useResource(() => planning.series(ws), `series:${ws}:${nonce}`);
  const [title, setTitle] = useState('');
  const [days, setDays] = useState<string[]>(['MO']);
  const [time, setTime] = useState('09:00');
  const [duration, setDuration] = useState('90');
  const [focus, setFocus] = useState(true);
  const [error, setError] = useState('');
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  const DAYS = [
    ['MO', 'Mon'],
    ['TU', 'Tue'],
    ['WE', 'Wed'],
    ['TH', 'Thu'],
    ['FR', 'Fri'],
    ['SA', 'Sat'],
    ['SU', 'Sun'],
  ] as const;
  return (
    <section className="card" aria-labelledby="series-h">
      <h2 id="series-h">Recurring blocks</h2>
      <ResourceView resource={data.state} onRetry={data.retry} what="recurring blocks">
        {(list) =>
          list.filter((s) => s.state === 'active').length ? (
            <ul className="today-list">
              {list
                .filter((s) => s.state === 'active')
                .map((s) => (
                  <li key={s.id} className="today-item">
                    <span className="today-item-main">
                      {s.title ?? 'Task block'}{' '}
                      <span className="hint">
                        · {s.rrule.replace('FREQ=', '').toLowerCase()} at {s.start_local.slice(11)}{' '}
                        · {mins(s.duration_minutes)}
                        {s.focus ? ' · focus' : ''}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="button button-ghost"
                      onClick={() =>
                        void planning
                          .endSeries(ws, s.id, s.version, stepUp)
                          .then(() => {
                            onDone(
                              'Recurring block ended. Future blocks you had not changed were removed.',
                            );
                            setNonce((n) => n + 1);
                          })
                          .catch((err) => setError(describe(err)))
                      }
                    >
                      End<span className="visually-hidden"> {s.title ?? 'recurring block'}</span>
                    </button>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="empty">No recurring blocks.</p>
          )
        }
      </ResourceView>
      <form
        className="grant-form"
        aria-label="Add a recurring block"
        onSubmit={(e) => {
          e.preventDefault();
          void planning
            .createSeries(
              ws,
              {
                title,
                rule: { frequency: 'weekly', weekdays: days },
                start_date: today,
                start_time: time,
                duration_minutes: Number(duration),
                focus,
              },
              stepUp,
            )
            .then((s) => {
              onDone(
                `Recurring block added: ${s.generated} scheduled${s.skipped ? `, ${s.skipped} skipped (focus time already there)` : ''}.`,
              );
              setTitle('');
              setNonce((n) => n + 1);
            })
            .catch((err) => setError(describe(err)));
        }}
      >
        <Field
          id="ser-title"
          label="Name"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
        />
        <fieldset className="choices">
          <legend>Days</legend>
          {DAYS.map(([k, label]) => (
            <label key={k} className="choice">
              <input
                type="checkbox"
                checked={days.includes(k)}
                onChange={() =>
                  setDays((d) => (d.includes(k) ? d.filter((x) => x !== k) : [...d, k]))
                }
              />{' '}
              {label}
            </label>
          ))}
        </fieldset>
        <Field
          id="ser-time"
          label="Start"
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
        />
        <Field
          id="ser-duration"
          label="Minutes"
          type="number"
          min={5}
          max={1440}
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
        />
        <label className="choice">
          <input type="checkbox" checked={focus} onChange={(e) => setFocus(e.target.checked)} />{' '}
          Focus
        </label>
        <button
          type="submit"
          className="button button-secondary"
          disabled={!title.trim() || !days.length}
        >
          Add recurring block
        </button>
      </form>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function TodayPage({ ws }: { ws: string }) {
  const [day, setDay] = useState('today');
  const [nonce, setNonce] = useState(0);
  const reload = () => setNonce((n) => n + 1);
  const data = useResource(() => planning.today(ws, day), `today:${ws}:${day}:${nonce}`, {
    keepOnRefreshError: true,
  });
  const r = useRunner(reload);
  const [said, setSaid] = useState('');
  const [shutdown, setShutdown] = useState(false);
  useEffect(() => {
    // Back online: refresh the day so it matches the server again.
    const back = () => reload();
    window.addEventListener('online', back);
    return () => window.removeEventListener('online', back);
  }, []);
  const v = data.state.status === 'ready' ? data.state.data : null;
  return (
    <Page title={v ? dayTitle(v.day, v.today) : 'Today'} wide section="Today">
      <ResourceView resource={data.state} onRetry={data.retry} what="your day">
        {(v: TodayView) => {
          const commit = (t: TaskBrief) =>
            void r.run(
              (s) => planning.commit(ws, v.day, [t.id], s),
              `${t.title} added to ${v.day === v.today ? 'today' : v.day}.`,
            );
          const move = (c: Commitment, after: string | null) =>
            void r.run(
              (s) => planning.update(ws, v.day, c.task.id, c.version, { after }, s),
              `${c.task.title} moved.`,
            );
          return (
            <>
              <div className="actions-compact" role="group" aria-label="Choose day">
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => setDay(shiftDay(v.day, -1))}
                >
                  Previous day
                </button>
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => setDay('today')}
                >
                  Today
                </button>
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => setDay(shiftDay(v.day, 1))}
                >
                  Next day
                </button>
              </div>
              <p className="hint">
                Times are in your zone ({v.tz}); this device shows {deviceZone()}.
              </p>
              {r.error ? (
                <Banner tone="danger" title="Not changed">
                  {r.error}
                </Banner>
              ) : null}
              <section className="card" aria-labelledby="sum-h">
                <h2 id="sum-h">Plan</h2>
                <dl className="facts time-facts">
                  <div>
                    <dt>Committed</dt>
                    <dd>
                      {v.totals.committed} tasks · {mins(v.totals.estimate_minutes)} estimated
                      {v.totals.unestimated ? ` (${v.totals.unestimated} without an estimate)` : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>Scheduled</dt>
                    <dd>
                      {mins(v.totals.block_minutes)} in blocks · {mins(v.totals.focus_minutes)}{' '}
                      focus
                    </dd>
                  </div>
                  <div>
                    <dt>Available time</dt>
                    <dd>Working hours and capacity arrive with capacity planning (3E).</dd>
                  </div>
                  <div>
                    <dt>Meetings</dt>
                    <dd>Calendar events arrive with calendar sync (6C).</dd>
                  </div>
                </dl>
                {v.record ? (
                  <Banner tone="info" title="This day is closed">
                    Planned {v.record.committed}: {v.record.completed} done, {v.record.carried}{' '}
                    carried over, {v.record.returned} returned, {v.record.dropped} not finished.{' '}
                    {mins(v.record.planned_minutes)} planned,{' '}
                    {mins(Math.round(v.record.actual_seconds / 60))} tracked.
                  </Banner>
                ) : v.can_shutdown ? (
                  <div className="actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => setShutdown(true)}
                    >
                      Shut down the day…
                    </button>
                  </div>
                ) : null}
              </section>
              <section className="card" aria-labelledby="com-h">
                <h2 id="com-h">Committed</h2>
                {v.committed.length ? (
                  <ol className="today-list" aria-label="Committed tasks in order">
                    {v.committed.map((c, i) => (
                      <li key={c.task.id} className="today-item">
                        <span className="today-item-main">
                          <Link to={routeHref('task', { ws, tsk: c.task.id })}>{c.task.title}</Link>{' '}
                          <span className="hint">
                            · {c.task.brand.name}
                            {c.task.estimate_minutes ? ` · ${mins(c.task.estimate_minutes)}` : ''}
                            {c.source === 'carry' ? ' · carried over' : ''}
                          </span>
                        </span>
                        <span className="badges">
                          {c.done ? <span className="badge badge-success">Done</span> : null}
                          {c.locked ? <span className="badge">Locked</span> : null}
                          {OUTCOME[c.outcome] ? (
                            <span className="badge">{OUTCOME[c.outcome]}</span>
                          ) : null}
                        </span>
                        {c.outcome === 'open' && !v.closed ? (
                          <span className="actions-compact">
                            <button
                              type="button"
                              className="button button-ghost"
                              disabled={i === 0 || c.locked || r.busy}
                              onClick={() => move(c, i >= 2 ? v.committed[i - 2]!.task.id : null)}
                            >
                              Move up<span className="visually-hidden"> {c.task.title}</span>
                            </button>
                            <button
                              type="button"
                              className="button button-ghost"
                              disabled={i === v.committed.length - 1 || c.locked || r.busy}
                              onClick={() => move(c, v.committed[i + 1]!.task.id)}
                            >
                              Move down<span className="visually-hidden"> {c.task.title}</span>
                            </button>
                            <button
                              type="button"
                              className="button button-ghost"
                              aria-pressed={c.locked}
                              disabled={r.busy}
                              onClick={() =>
                                void r.run(
                                  (s) =>
                                    planning.update(
                                      ws,
                                      v.day,
                                      c.task.id,
                                      c.version,
                                      { locked: !c.locked },
                                      s,
                                    ),
                                  c.locked
                                    ? `${c.task.title} unlocked.`
                                    : `${c.task.title} locked.`,
                                )
                              }
                            >
                              {c.locked ? 'Unlock' : 'Lock'}
                              <span className="visually-hidden"> {c.task.title}</span>
                            </button>
                            <button
                              type="button"
                              className="button button-ghost"
                              disabled={c.locked || r.busy}
                              onClick={() =>
                                void r.run(
                                  (s) =>
                                    planning.update(
                                      ws,
                                      v.day,
                                      c.task.id,
                                      c.version,
                                      { move_to: shiftDay(v.day, 1) },
                                      s,
                                    ),
                                  `${c.task.title} moved to the next day.`,
                                )
                              }
                            >
                              Next day<span className="visually-hidden"> for {c.task.title}</span>
                            </button>
                            <button
                              type="button"
                              className="button button-ghost"
                              disabled={c.locked || r.busy}
                              onClick={() =>
                                void r.run(
                                  (s) => planning.remove(ws, v.day, c.task.id, c.version, s),
                                  `${c.task.title} removed from the day.`,
                                )
                              }
                            >
                              Remove<span className="visually-hidden"> {c.task.title}</span>
                            </button>
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="empty">Nothing committed yet. Add tasks from the lists below.</p>
                )}
              </section>
              <section className="card" aria-labelledby="blk-h">
                <h2 id="blk-h">Scheduled</h2>
                {v.scheduled.length ? (
                  <ul className="today-list">
                    {v.scheduled.map((b) => (
                      <li key={b.id} className="today-item">
                        <span className="today-item-main">
                          <strong>
                            {timeOf(b.starts_at)}–{timeOf(b.ends_at)}
                          </strong>{' '}
                          {b.task ? (
                            <Link to={routeHref('task', { ws, tsk: b.task.id })}>
                              {b.task.title}
                            </Link>
                          ) : b.unavailable ? (
                            <span>Busy (unavailable item)</span>
                          ) : (
                            <span>{b.title}</span>
                          )}
                          {b.prep_minutes || b.buffer_minutes ? (
                            <span className="hint">
                              {' '}
                              · {b.prep_minutes ? `${b.prep_minutes} min prep` : ''}
                              {b.prep_minutes && b.buffer_minutes ? ', ' : ''}
                              {b.buffer_minutes ? `${b.buffer_minutes} min buffer` : ''}
                            </span>
                          ) : null}
                          {b.warnings.map((w) => (
                            <span key={w} className="badge badge-warning">
                              {WARN[w]}
                            </span>
                          ))}
                        </span>
                        <span className="badges">
                          {b.focus ? <span className="badge badge-info">Focus</span> : null}
                          {b.series ? <span className="badge">Repeats</span> : null}
                        </span>
                        <span className="actions-compact">
                          <button
                            type="button"
                            className="button button-ghost"
                            aria-pressed={b.locked}
                            disabled={r.busy}
                            onClick={() =>
                              void r.run(
                                (s) =>
                                  planning.updateBlock(
                                    ws,
                                    b.id,
                                    b.version,
                                    { locked: !b.locked },
                                    s,
                                  ),
                                b.locked ? 'Block unlocked.' : 'Block locked.',
                              )
                            }
                          >
                            {b.locked ? 'Unlock' : 'Lock'}
                            <span className="visually-hidden"> block at {timeOf(b.starts_at)}</span>
                          </button>
                          <button
                            type="button"
                            className="button button-ghost"
                            disabled={b.locked || r.busy}
                            onClick={() =>
                              void r.run(
                                (s) =>
                                  planning.updateBlock(
                                    ws,
                                    b.id,
                                    b.version,
                                    {
                                      starts_at: new Date(
                                        Date.parse(b.starts_at) + 30 * 60_000,
                                      ).toISOString(),
                                      ends_at: new Date(
                                        Date.parse(b.ends_at) + 30 * 60_000,
                                      ).toISOString(),
                                    },
                                    s,
                                  ),
                                'Block moved 30 minutes later. Due dates did not change.',
                              )
                            }
                          >
                            Later
                            <span className="visually-hidden"> block at {timeOf(b.starts_at)}</span>
                          </button>
                          <button
                            type="button"
                            className="button button-ghost"
                            disabled={b.locked || r.busy}
                            onClick={() =>
                              void r.run(
                                (s) => planning.deleteBlock(ws, b.id, b.version, s),
                                'Block removed.',
                              )
                            }
                          >
                            Remove
                            <span className="visually-hidden"> block at {timeOf(b.starts_at)}</span>
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="empty">No time scheduled.</p>
                )}
                {!v.closed ? (
                  <BlockForm
                    ws={ws}
                    v={v}
                    onDone={(m) => {
                      setSaid(m);
                      reload();
                    }}
                  />
                ) : null}
              </section>
              <TaskList
                ws={ws}
                title="Overdue"
                id="ovd-h"
                items={v.overdue.items}
                hasMore={v.overdue.has_more}
                onCommit={v.closed ? undefined : commit}
                empty="Nothing overdue."
                busy={r.busy}
              />
              <TaskList
                ws={ws}
                title="Due today"
                id="due-h"
                items={v.due_today.items}
                hasMore={v.due_today.has_more}
                onCommit={v.closed ? undefined : commit}
                empty="Nothing due today."
                busy={r.busy}
              />
              <TaskList
                ws={ws}
                title="Upcoming deadlines"
                id="ddl-h"
                items={v.upcoming_deadlines.items}
                hasMore={v.upcoming_deadlines.has_more}
                onCommit={v.closed ? undefined : commit}
                empty="No deadlines soon."
                busy={r.busy}
              />
              <SeriesSection
                ws={ws}
                onDone={(m) => {
                  setSaid(m);
                  reload();
                }}
              />
              {shutdown ? (
                <ShutdownDialog
                  ws={ws}
                  v={v}
                  onClose={() => setShutdown(false)}
                  onDone={(m) => {
                    setSaid(m);
                    reload();
                  }}
                />
              ) : null}
            </>
          );
        }}
      </ResourceView>
      <Announce>{said || r.said}</Announce>
    </Page>
  );
}

/** On the task page: add it to today, or schedule focus time from its estimate (CAL-011). */
export function TaskPlanPanel({
  ws,
  task,
  estimate,
}: {
  ws: string;
  task: string;
  estimate: number | null;
}) {
  const stepUp = useStepUp();
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');
  const [time, setTime] = useState('09:00');
  const [day, setDay] = useState(() =>
    new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
  );
  return (
    <section className="card" aria-labelledby={`plan-${task}`}>
      <h2 id={`plan-${task}`}>Plan</h2>
      <p className="hint">Planning never changes the due date or deadline.</p>
      <div className="actions">
        <button
          type="button"
          className="button button-secondary"
          onClick={() =>
            void planning
              .today(ws)
              .then((v) => planning.commit(ws, v.today, [task], stepUp))
              .then(() => setSaid('Added to today.'))
              .catch((err) => setError(describe(err)))
          }
        >
          Add to today
        </button>
      </div>
      {estimate ? (
        <form
          className="grant-form"
          aria-label="Schedule focus time"
          onSubmit={(e) => {
            e.preventDefault();
            void planning
              .fromEstimate(ws, { task, starts_at: localInstant(day, time) }, stepUp)
              .then((b) =>
                setSaid(
                  `Focus time scheduled ${timeOf(b.starts_at)}–${timeOf(b.ends_at)}.${b.warnings.length ? ` ${b.warnings.map((x) => WARN[x]).join('. ')}.` : ''}`,
                ),
              )
              .catch((err) => setError(describe(err)));
          }}
        >
          <Field
            id={`ft-day-${task}`}
            label="Day"
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
          <Field
            id={`ft-time-${task}`}
            label="Start"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
          <button type="submit" className="button button-secondary">
            Schedule focus time ({mins(estimate)})
          </button>
        </form>
      ) : (
        <p className="hint">Add an estimate to schedule focus time from it.</p>
      )}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <Announce>{said}</Announce>
    </section>
  );
}
