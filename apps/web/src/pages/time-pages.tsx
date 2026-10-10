import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError } from '../api.ts';
import { projects } from '../projects/client.ts';
import { Link } from '../router.tsx';
import { routeHref } from '../shell/registry.ts';
import { useStepUp } from '../stepup.tsx';
import { tasks } from '../tasks/client.ts';
import { ResourceView, useResource } from '../tenancy/resource.tsx';
import {
  clock,
  spoken,
  stopwatch,
  time,
  type ReportRow,
  type TimeEntry,
  type Timesheet,
  type TimesheetLine,
  type TimesheetPeriod,
  type WorkSummary,
} from '../time/client.ts';
import { flushActions, pendingActions, queueAction } from '../time/offline.ts';
import { Dialog } from '../ui/dialog.tsx';
import { Announce, Banner } from '../ui/feedback.tsx';
import { Field, SelectField, TextAreaField } from '../ui/form.tsx';
import { Page } from '../ui/layout.tsx';

/**
 * Phase 3D time tracking (0E Phase 3D note, ADR-0019): the live timer (recoverable after a refresh
 * and while offline), time on a task or project (planned, actual, remaining), the Time page with
 * the person's week and timesheet, the approval queue with admin unlock, and the planned-versus-
 * actual report with exports. Durations are shown as h:mm from exact seconds and spoken in words.
 */

const LINE_STATE: Record<string, string> = {
  pending: 'Waiting for approval',
  approved: 'Approved and locked',
  rejected: 'Returned for changes',
  withdrawn: 'Withdrawn',
  unlocked: 'Unlocked: submit again',
};
const STATUS_TEXT: Record<TimeEntry['status'], string> = {
  open: 'Open',
  submitted: 'Submitted',
  locked: 'Approved (locked)',
};

const describe = (err: unknown, fallback = 'That did not work. Try again.') =>
  err instanceof ApiError
    ? err.code === 'offline' || err.code === 'network'
      ? "You're offline. Nothing was saved; try again when you're back."
      : (err.issues[0]?.message ?? (err.code === 'cancelled' ? 'Cancelled.' : fallback))
    : fallback;

/** Local `YYYY-MM-DD` of this device. */
const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const shiftDay = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dayLabel = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

/** Minutes from "1:30", "90", "1.5h", "1h 30m", or "45m"; null when unreadable or not positive. */
export function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,2}):([0-5]\d)$/.exec(s))) return Number(m[1]) * 60 + Number(m[2]) || null;
  if ((m = /^(\d+)$/.exec(s))) return Number(m[1]) || null;
  if ((m = /^(\d+(?:\.\d+)?)\s*h$/.exec(s))) return Math.round(Number(m[1]) * 60) || null;
  if ((m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/.exec(s)) && (m[1] || m[2]))
    return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) || null;
  return null;
}

/** `<input type="datetime-local">` value → ISO instant in this device's zone (or undefined). */
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : undefined);
const toLocal = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function Duration({ seconds }: { seconds: number }) {
  return (
    <span>
      <span aria-hidden="true">{clock(seconds)}</span>
      <span className="visually-hidden">{spoken(seconds)}</span>
    </span>
  );
}

// -----------------------------------------------------------------------------------------------
// The live timer
// -----------------------------------------------------------------------------------------------

/**
 * The person's live timer. Elapsed time is computed from the server's clock (so a wrong device
 * clock does not change it) and updates every second without announcing each tick; state changes
 * are announced. Pause, resume, and stop pressed offline are kept on this device and sent when
 * the connection returns.
 */
export function TimerCard({ ws, onChanged }: { ws: string; onChanged?: () => void }) {
  const [nonce, setNonce] = useState(0);
  const data = useResource(
    async () => {
      await flushActions(ws).catch(() => 0);
      const r = await time.timer(ws);
      return { ...r, skew: Date.parse(r.server_now) - Date.now() };
    },
    `timer:${ws}:${nonce}`,
    { keepOnRefreshError: true },
  );
  const [now, setNow] = useState(() => Date.now());
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(() => pendingActions().filter((a) => a.ws === ws));
  const t = data.state.status === 'ready' ? data.state.data.timer : null;
  const skew = data.state.status === 'ready' ? data.state.data.skew : 0;
  const lastPending = pending.filter((a) => a.te === t?.id).at(-1);
  const state = lastPending
    ? lastPending.verb === 'stop'
      ? 'stopped'
      : lastPending.verb === 'pause'
        ? 'paused'
        : 'running'
    : t?.state;
  useEffect(() => {
    if (state !== 'running') return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [state]);
  useEffect(() => {
    const back = () =>
      void flushActions(ws).then(() => {
        setPending(pendingActions().filter((a) => a.ws === ws));
        setNonce((n) => n + 1);
        onChanged?.();
      });
    window.addEventListener('online', back);
    return () => window.removeEventListener('online', back);
  }, [ws, onChanged]);
  if (!t || state === 'stopped')
    return (
      <section className="card timer-card" aria-labelledby="timer-h">
        <h2 id="timer-h">Timer</h2>
        <p>No timer is running. Start one from a task or project.</p>
        <Announce>{said}</Announce>
      </section>
    );
  const elapsed =
    t.duration_seconds +
    (state === 'running' && t.running_since
      ? (now + skew - Date.parse(t.running_since)) / 1000
      : 0);
  const act = async (verb: 'pause' | 'resume' | 'stop') => {
    setError('');
    if (!navigator.onLine && verb !== 'resume') {
      queueAction({ ws, te: t.id, verb });
      setPending(pendingActions().filter((a) => a.ws === ws));
      setSaid(
        verb === 'stop'
          ? 'Timer stopped on this device. It will sync when you are back online.'
          : 'Timer paused on this device. It will sync when you are back online.',
      );
      return;
    }
    try {
      const r = await time.action(ws, t.id, verb, {});
      setSaid(
        verb === 'stop'
          ? `Timer stopped. ${spoken(r.duration_seconds)} recorded.`
          : verb === 'pause'
            ? 'Timer paused.'
            : 'Timer resumed.',
      );
      setNonce((n) => n + 1);
      onChanged?.();
    } catch (err) {
      setError(describe(err));
    }
  };
  return (
    <section className="card timer-card" aria-labelledby="timer-h">
      <h2 id="timer-h">Timer</h2>
      <p className="timer-target">
        {t.target ? (
          <Link
            to={
              t.target.type === 'task'
                ? routeHref('task', { ws, tsk: t.target.id })
                : routeHref('project', { ws, prj: t.target.id })
            }
          >
            {t.target.title}
          </Link>
        ) : (
          <span>Work you can no longer open</span>
        )}{' '}
        <span className="hint">· {t.brand.name}</span>
      </p>
      <p className="timer-elapsed">
        <span role="timer" aria-live="off" aria-label={`Elapsed: ${spoken(elapsed)}`}>
          {stopwatch(elapsed)}
        </span>{' '}
        <span className="badge">{state === 'running' ? 'Running' : 'Paused'}</span>
      </p>
      {pending.length ? (
        <p className="hint">Changes made offline will sync when you are back online.</p>
      ) : null}
      {error ? (
        <Banner tone="danger" title="Timer">
          {error}
        </Banner>
      ) : null}
      <div className="actions">
        {state === 'running' ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void act('pause')}
          >
            Pause
          </button>
        ) : (
          <button
            type="button"
            className="button button-secondary"
            disabled={!t.target}
            onClick={() => void act('resume')}
          >
            Resume
          </button>
        )}
        <button type="button" className="button button-primary" onClick={() => void act('stop')}>
          Stop and save
        </button>
      </div>
      <Announce>{said}</Announce>
    </section>
  );
}

// -----------------------------------------------------------------------------------------------
// Logging time (shared form)
// -----------------------------------------------------------------------------------------------

function LogTimeForm({
  ws,
  target,
  targets,
  onSaved,
  idPrefix,
}: {
  ws: string;
  target?: string;
  targets?: Array<{ value: string; label: string }>;
  onSaved: () => void;
  idPrefix: string;
}) {
  const stepUp = useStepUp();
  const [picked, setPicked] = useState(target ?? targets?.[0]?.value ?? '');
  const [day, setDay] = useState(today());
  const [duration, setDuration] = useState('');
  const [billable, setBillable] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [said, setSaid] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const minutes = parseDuration(duration);
    const errs: Record<string, string> = {};
    if (!minutes) errs.duration = 'Enter the time spent, like 1:30 or 45m.';
    if (!(target ?? picked)) errs.target = 'Choose a task or project.';
    setErrors(errs);
    if (Object.keys(errs).length) {
      document.getElementById(`${idPrefix}-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    try {
      const r = await time.create(
        ws,
        { target: target ?? picked, work_date: day, duration_minutes: minutes, billable, note },
        stepUp,
      );
      setSaid(`Logged ${spoken(r.duration_seconds)} on ${dayLabel(r.work_date)}.`);
      setDuration('');
      setNote('');
      onSaved();
    } catch (err) {
      const msg = describe(err);
      const pointer = err instanceof ApiError ? err.issues[0]?.pointer : undefined;
      setErrors(
        pointer === '/work_date'
          ? { day: msg }
          : pointer === '/target'
            ? { target: msg }
            : pointer === '/note'
              ? { note: msg }
              : { duration: msg },
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="log-time" onSubmit={(e) => void submit(e)} noValidate>
      {targets && !target ? (
        <SelectField
          id={`${idPrefix}-target`}
          label="Task or project"
          value={picked}
          onChange={setPicked}
          options={targets}
          error={errors.target}
          required
        />
      ) : null}
      <div className="log-time-row">
        <Field
          id={`${idPrefix}-day`}
          label="Date"
          type="date"
          value={day}
          max={today()}
          onChange={(e) => setDay(e.target.value)}
          error={errors.day}
          required
        />
        <Field
          id={`${idPrefix}-duration`}
          label="Time spent"
          hint="Like 1:30, 90, or 45m"
          inputMode="text"
          autoComplete="off"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          error={errors.duration}
          required
        />
      </div>
      <label className="choice">
        <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} />{' '}
        Billable
      </label>
      <TextAreaField
        id={`${idPrefix}-note`}
        label="Note (optional)"
        value={note}
        onChange={setNote}
        maxLength={1000}
      />
      <div className="actions">
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Log time'}
        </button>
      </div>
      <Announce>{said}</Announce>
    </form>
  );
}

// -----------------------------------------------------------------------------------------------
// Entries (list, edit, delete)
// -----------------------------------------------------------------------------------------------

function EntryEditor({
  ws,
  entry,
  onClose,
  onSaved,
}: {
  ws: string;
  entry: TimeEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const stepUp = useStepUp();
  const timed = entry.started_at !== null;
  const [start, setStart] = useState(toLocal(entry.started_at));
  const [end, setEnd] = useState(toLocal(entry.ended_at));
  const [day, setDay] = useState(entry.work_date);
  const [duration, setDuration] = useState(clock(entry.duration_seconds));
  const [billable, setBillable] = useState(entry.billable);
  const [note, setNote] = useState(entry.note);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = { billable, note };
    if (timed) {
      if (start !== toLocal(entry.started_at) || end !== toLocal(entry.ended_at)) {
        body.started_at = fromLocal(start);
        body.ended_at = fromLocal(end);
        body.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      }
    } else {
      const minutes = parseDuration(duration);
      if (!minutes) return setError('Enter the time spent, like 1:30 or 45m.');
      if (minutes * 60 !== entry.duration_seconds) body.duration_minutes = minutes;
      if (day !== entry.work_date) body.work_date = day;
    }
    try {
      await time.update(ws, entry.id, entry.version, body, stepUp);
      onSaved();
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'conflict' && !err.issues.length
          ? 'This entry changed elsewhere. Close and open it again.'
          : describe(err),
      );
    }
  };
  if (confirmDelete)
    return (
      <Dialog title="Delete this time?" onClose={() => setConfirmDelete(false)} destructive>
        <p>
          {spoken(entry.duration_seconds)} on {dayLabel(entry.work_date)} will be removed. This
          can't be undone.
        </p>
        {error ? <p className="field-error">{error}</p> : null}
        <div className="actions">
          <button
            type="button"
            className="button button-secondary"
            data-cancel
            onClick={() => setConfirmDelete(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button button-danger"
            onClick={() =>
              void time
                .remove(ws, entry.id, entry.version, stepUp)
                .then(() => {
                  onSaved();
                  onClose();
                })
                .catch((err) => setError(describe(err)))
            }
          >
            Delete
          </button>
        </div>
      </Dialog>
    );
  return (
    <Dialog title="Edit time" onClose={onClose}>
      <form onSubmit={(e) => void save(e)} noValidate>
        {error ? (
          <Banner tone="danger" title="Not saved">
            {error}
          </Banner>
        ) : null}
        {timed ? (
          <>
            <Field
              id="edit-start"
              label="Start"
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
            <Field
              id="edit-end"
              label="End"
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </>
        ) : (
          <>
            <Field
              id="edit-day"
              label="Date"
              type="date"
              value={day}
              max={today()}
              onChange={(e) => setDay(e.target.value)}
            />
            <Field
              id="edit-duration"
              label="Time spent"
              hint="Like 1:30, 90, or 45m"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </>
        )}
        <label className="choice">
          <input
            type="checkbox"
            checked={billable}
            onChange={(e) => setBillable(e.target.checked)}
          />{' '}
          Billable
        </label>
        <TextAreaField
          id="edit-note"
          label="Note"
          value={note}
          onChange={setNote}
          maxLength={1000}
        />
        <div className="actions">
          <button type="submit" className="button button-primary" data-initial>
            Save
          </button>
          <button
            type="button"
            className="button button-danger"
            onClick={() => setConfirmDelete(true)}
          >
            Delete…
          </button>
          <button type="button" className="button button-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function EntryList({
  ws,
  entries,
  onChanged,
  showTarget = true,
  showPerson = false,
}: {
  ws: string;
  entries: TimeEntry[];
  onChanged: () => void;
  showTarget?: boolean;
  showPerson?: boolean;
}) {
  const [editing, setEditing] = useState<TimeEntry | null>(null);
  if (!entries.length) return <p className="empty">No time logged yet.</p>;
  return (
    <>
      <ul className="time-entries">
        {entries.map((e) => (
          <li key={e.id} className="time-entry">
            <span className="time-entry-main">
              <strong>
                <Duration seconds={e.duration_seconds} />
              </strong>{' '}
              {showTarget ? (
                <span>
                  {e.target ? e.target.title : 'Unavailable work'}{' '}
                  <span className="hint">· {e.brand.name}</span>
                </span>
              ) : null}
              {showPerson ? <span className="hint"> · {e.person.name}</span> : null}
            </span>
            <span className="time-entry-meta hint">
              {dayLabel(e.work_date)}
              {e.started_at && e.ended_at
                ? ` · ${new Date(e.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–${new Date(e.ended_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                : ''}
              {e.source === 'timer' ? ' · timer' : ''}
              {e.auto_stopped ? ' · stopped automatically, please check' : ''}
            </span>
            <span className="badges">
              {e.billable ? <span className="badge badge-info">Billable</span> : null}
              {e.state !== 'stopped' ? (
                <span className="badge">{e.state === 'running' ? 'Running' : 'Paused'}</span>
              ) : null}
              {e.status !== 'open' ? (
                <span className="badge badge-warning">{STATUS_TEXT[e.status]}</span>
              ) : null}
            </span>
            {e.note ? <span className="time-entry-note">{e.note}</span> : null}
            {e.editable && e.state === 'stopped' ? (
              <button
                type="button"
                className="button button-ghost"
                aria-label={`Edit ${spoken(e.duration_seconds)} on ${dayLabel(e.work_date)}`}
                onClick={() => setEditing(e)}
              >
                Edit
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {editing ? (
        <EntryEditor ws={ws} entry={editing} onClose={() => setEditing(null)} onSaved={onChanged} />
      ) : null}
    </>
  );
}

// -----------------------------------------------------------------------------------------------
// Time on a task or project (task and project pages)
// -----------------------------------------------------------------------------------------------

/**
 * Planned, actual, and remaining effort for one task or project (TIME-003, TIME-006, PRJ-022),
 * with a timer and a log-time form when the person may log time here, and recent entries.
 */
export function WorkTimePanel({
  ws,
  target,
  canLog,
  version = 0,
}: {
  ws: string;
  target: string;
  canLog: boolean;
  /** The task or project version: planned effort reloads when the record changes. */
  version?: number;
}) {
  const stepUp = useStepUp();
  const [nonce, setNonce] = useState(0);
  const summary = useResource(
    () => time.summary(ws, target),
    `tsum:${ws}:${target}:${version}:${nonce}`,
    {
      keepOnRefreshError: true,
    },
  );
  const recent = useResource(
    () => time.entries(ws, { target, limit: '10' }),
    `tent:${ws}:${target}:${nonce}`,
    { keepOnRefreshError: true },
  );
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');
  const reload = () => setNonce((n) => n + 1);
  const isProject = target.startsWith('prj_');
  return (
    <section className="card" aria-labelledby={`time-${target}`}>
      <h2 id={`time-${target}`}>Time</h2>
      <ResourceView resource={summary.state} onRetry={summary.retry} what="time">
        {(s: WorkSummary) => (
          <>
            <dl className="facts time-facts">
              {isProject ? (
                <>
                  <div>
                    <dt>Time budget</dt>
                    <dd>
                      {s.planned.budget_minutes !== null &&
                      s.planned.budget_minutes !== undefined ? (
                        <Duration seconds={s.planned.budget_minutes * 60} />
                      ) : (
                        'Not set'
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Task estimates</dt>
                    <dd>
                      {s.planned.task_estimate_minutes !== null &&
                      s.planned.task_estimate_minutes !== undefined ? (
                        <Duration seconds={s.planned.task_estimate_minutes * 60} />
                      ) : (
                        'None'
                      )}{' '}
                      <span className="hint">
                        ({s.planned.estimated_tasks} of {s.planned.tasks} tasks estimated)
                      </span>
                    </dd>
                  </div>
                </>
              ) : (
                <div>
                  <dt>Estimate</dt>
                  <dd>
                    {s.planned.estimate_minutes !== null &&
                    s.planned.estimate_minutes !== undefined ? (
                      <Duration seconds={s.planned.estimate_minutes * 60} />
                    ) : (
                      'Not set'
                    )}
                  </dd>
                </div>
              )}
              <div>
                <dt>Logged</dt>
                <dd>
                  <Duration seconds={s.actual.seconds} />{' '}
                  <span className="hint">
                    (billable <Duration seconds={s.actual.billable_seconds} />, yours{' '}
                    <Duration seconds={s.actual.mine_seconds} />)
                  </span>
                </dd>
              </div>
              <div>
                <dt>Remaining</dt>
                <dd>
                  {s.remaining.minutes !== null && s.remaining.minutes !== undefined ? (
                    <Duration seconds={s.remaining.minutes * 60} />
                  ) : (
                    'Unknown'
                  )}
                  {s.remaining.unestimated_open_tasks ? (
                    <span className="hint">
                      {' '}
                      ({s.remaining.unestimated_open_tasks} open tasks have no estimate)
                    </span>
                  ) : null}
                </dd>
              </div>
            </dl>
            <p className="hint">
              Planned effort uses estimates{isProject ? ' and the time budget' : ''}; logged time
              counts only work you can see. Remaining uses the remaining estimate, or the estimate
              less logged time.
            </p>
            {canLog ? (
              <div className="actions">
                {s.live_timer ? (
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={() =>
                      void time
                        .action(ws, s.live_timer!, 'stop', {})
                        .then((r) => {
                          setSaid(`Timer stopped. ${spoken(r.duration_seconds)} recorded.`);
                          reload();
                        })
                        .catch((err) => setError(describe(err)))
                    }
                  >
                    Stop timer
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() =>
                      void time
                        .start(ws, { target, replace: true }, stepUp)
                        .then(() => {
                          setSaid('Timer started.');
                          reload();
                        })
                        .catch((err) => setError(describe(err)))
                    }
                  >
                    Start timer
                  </button>
                )}
              </div>
            ) : null}
          </>
        )}
      </ResourceView>
      {error ? (
        <Banner tone="danger" title="Time">
          {error}
        </Banner>
      ) : null}
      {canLog ? (
        <details className="log-time-details">
          <summary>Log time</summary>
          <LogTimeForm ws={ws} target={target} onSaved={reload} idPrefix={`log-${target}`} />
        </details>
      ) : null}
      <h3>Recent time</h3>
      <ResourceView resource={recent.state} onRetry={recent.retry} what="time entries">
        {(r) => (
          <EntryList
            ws={ws}
            entries={r.data}
            onChanged={reload}
            showTarget={isProject}
            showPerson
          />
        )}
      </ResourceView>
      <Announce>{said}</Announce>
    </section>
  );
}

// -----------------------------------------------------------------------------------------------
// The Time page: my week and timesheet
// -----------------------------------------------------------------------------------------------

function LineStatus({ line }: { line: TimesheetLine }) {
  const last = line.decisions.at(-1);
  return (
    <span className="time-line-status">
      <strong>{line.brand.name}</strong>{' '}
      <span
        className={
          line.state === 'approved'
            ? 'badge badge-success'
            : line.state === 'rejected'
              ? 'badge badge-warning'
              : 'badge'
        }
      >
        {line.state ? LINE_STATE[line.state] : 'Not submitted'}
      </span>
      {last ? (
        <span className="hint">
          {' '}
          · {last.decision === 'approve' ? 'Approved' : 'Returned'} by {last.by.name}
          {last.self_approval ? ' (self-approved)' : ''}
        </span>
      ) : null}
      {line.locks
        .filter((l) => l.action === 'unlock')
        .map((l) => (
          <span key={l.at} className="hint">
            {' '}
            · Unlocked by {l.by.name}
            {l.reason ? `: “${l.reason}”` : ''}
          </span>
        ))}
    </span>
  );
}

export function TimePage({ ws }: { ws: string }) {
  const stepUp = useStepUp();
  const [date, setDate] = useState(today());
  const [nonce, setNonce] = useState(0);
  const data = useResource(() => time.period(ws, date), `tper:${ws}:${date}:${nonce}`, {
    keepOnRefreshError: true,
  });
  const reload = () => setNonce((n) => n + 1);
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');
  const targets = useResource(async () => {
    const [p, t] = await Promise.all([
      projects.list(ws, { state: 'active' }),
      tasks.list(ws, { limit: '200' }),
    ]);
    return [
      ...t.data.map((x) => ({ value: x.id, label: `Task: ${x.title}` })),
      ...p.data.map((x) => ({ value: x.id, label: `Project: ${x.name}` })),
    ];
  }, `ttgt:${ws}`);
  return (
    <Page title="Time" wide>
      <p className="actions-compact">
        <Link to={routeHref('time_approvals', { ws })}>Approvals</Link>{' '}
        <Link to={routeHref('time_report', { ws })}>Reports and export</Link>
      </p>
      <TimerCard ws={ws} onChanged={reload} />
      <ResourceView resource={data.state} onRetry={data.retry} what="your week">
        {(v: TimesheetPeriod) => (
          <>
            <section className="card" aria-labelledby="week-h">
              <div className="section-head">
                <h2 id="week-h">Week of {dayLabel(v.period.start)}</h2>
                <div className="actions-compact" role="group" aria-label="Choose week">
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={() => setDate(shiftDay(v.period.start, -7))}
                  >
                    Previous week
                  </button>
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={() => setDate(today())}
                  >
                    This week
                  </button>
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={() => setDate(shiftDay(v.period.start, 7))}
                  >
                    Next week
                  </button>
                </div>
              </div>
              <div className="table-scroll" role="region" aria-label="Time per day" tabIndex={0}>
                <table className="access-table time-week">
                  <caption className="visually-hidden">Time per day this week</caption>
                  <thead>
                    <tr>
                      {v.days.map((d) => (
                        <th key={d.date} scope="col">
                          {dayLabel(d.date)}
                        </th>
                      ))}
                      <th scope="col">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      {v.days.map((d) => (
                        <td key={d.date}>
                          <Duration seconds={d.seconds} />
                        </td>
                      ))}
                      <td>
                        <strong>
                          <Duration seconds={v.totals.seconds} />
                        </strong>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="hint">
                Billable <Duration seconds={v.totals.billable_seconds} /> · Non-billable{' '}
                <Duration seconds={v.totals.non_billable_seconds} />
              </p>
            </section>
            <section className="card" aria-labelledby="sheet-h">
              <h2 id="sheet-h">Timesheet</h2>
              <p>
                {v.timesheet?.state === 'submitted'
                  ? 'Submitted for approval. Your time this week is read-only until it is decided or you withdraw it.'
                  : v.timesheet?.state === 'approved'
                    ? 'Approved. Approved time is locked; ask an admin if something must change.'
                    : 'Submit the week when your time is complete. Each brand approves its own time.'}
              </p>
              {v.lines.length ? (
                <ul className="time-lines">
                  {v.lines.map((l) => (
                    <li key={l.brand.id} className="time-line">
                      <LineStatus line={l} />
                    </li>
                  ))}
                </ul>
              ) : null}
              {v.has_live_timer ? (
                <p className="hint">Stop the running timer before submitting.</p>
              ) : null}
              {error ? (
                <Banner tone="danger" title="Timesheet">
                  {error}
                </Banner>
              ) : null}
              <div className="actions">
                {v.can_submit ? (
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={() =>
                      void time
                        .submit(ws, v.period.start, stepUp)
                        .then(() => {
                          setSaid('Week submitted for approval.');
                          reload();
                        })
                        .catch((err) => setError(describe(err)))
                    }
                  >
                    Submit week
                  </button>
                ) : null}
                {v.can_withdraw && v.timesheet ? (
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() =>
                      void time
                        .withdraw(ws, v.timesheet!.id, v.timesheet!.version, stepUp)
                        .then(() => {
                          setSaid('Submission withdrawn. You can change this week again.');
                          reload();
                        })
                        .catch((err) => setError(describe(err)))
                    }
                  >
                    Withdraw
                  </button>
                ) : null}
              </div>
            </section>
            <section className="card" aria-labelledby="entries-h">
              <h2 id="entries-h">Entries</h2>
              <EntryList ws={ws} entries={v.entries} onChanged={reload} />
            </section>
          </>
        )}
      </ResourceView>
      <section className="card" aria-labelledby="log-h">
        <h2 id="log-h">Log time</h2>
        <ResourceView resource={targets.state} onRetry={targets.retry} what="tasks and projects">
          {(opts) =>
            opts.length ? (
              <LogTimeForm ws={ws} targets={opts} onSaved={reload} idPrefix="page-log" />
            ) : (
              <p className="empty">There is no work you can log time on yet.</p>
            )
          }
        </ResourceView>
      </section>
      <Announce>{said}</Announce>
    </Page>
  );
}

// -----------------------------------------------------------------------------------------------
// Approvals
// -----------------------------------------------------------------------------------------------

function DecideDialog({
  ws,
  sheet,
  line,
  mode,
  onClose,
  onDone,
}: {
  ws: string;
  sheet: Timesheet;
  line: TimesheetLine;
  mode: 'reject' | 'unlock';
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const stepUp = useStepUp();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const run = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (mode === 'reject')
        await time.decide(
          ws,
          sheet.id,
          sheet.version,
          { brand: line.brand.id, decision: 'reject', note: text },
          stepUp,
        );
      else
        await time.unlock(
          ws,
          sheet.id,
          sheet.version,
          { brand: line.brand.id, reason: text },
          stepUp,
        );
      onDone(
        mode === 'reject'
          ? 'Returned for changes.'
          : 'Unlocked. The person can change this time and submit it again.',
      );
      onClose();
    } catch (err) {
      setError(describe(err));
    }
  };
  return (
    <Dialog
      title={
        mode === 'reject'
          ? `Return ${line.brand.name} time for changes`
          : `Unlock ${line.brand.name} time`
      }
      description={
        mode === 'unlock'
          ? 'Unlocking lets the person change approved time. You will confirm it is you, the reason is recorded, and the time must be approved again.'
          : undefined
      }
      onClose={onClose}
    >
      <form onSubmit={(e) => void run(e)} noValidate>
        <TextAreaField
          id="decide-text"
          label={mode === 'reject' ? 'What needs to change' : 'Reason for unlocking'}
          value={text}
          onChange={setText}
          maxLength={mode === 'reject' ? 1000 : 500}
          initial
        />
        {error ? <p className="field-error">{error}</p> : null}
        <div className="actions">
          <button type="submit" className="button button-primary">
            {mode === 'reject' ? 'Return for changes' : 'Unlock'}
          </button>
          <button type="button" className="button button-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function SheetCard({
  ws,
  sheet,
  onChanged,
}: {
  ws: string;
  sheet: Timesheet;
  onChanged: (msg: string) => void;
}) {
  const stepUp = useStepUp();
  const [dialog, setDialog] = useState<{ line: TimesheetLine; mode: 'reject' | 'unlock' } | null>(
    null,
  );
  const [error, setError] = useState('');
  const total = sheet.entries.reduce((s, e) => s + e.duration_seconds, 0);
  return (
    <article className="card" aria-labelledby={`sh-${sheet.id}`}>
      <h3 id={`sh-${sheet.id}`}>
        {sheet.person.name} · week of {dayLabel(sheet.period.start)}
      </h3>
      <p className="hint">
        <Duration seconds={total} /> you can see · {sheet.entries.length} entries
      </p>
      <ul className="time-lines">
        {sheet.lines.map((l) => (
          <li key={l.brand.id} className="time-line">
            <LineStatus line={l} />
            <div className="actions-compact">
              {l.can_approve ? (
                <>
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={() =>
                      void time
                        .decide(
                          ws,
                          sheet.id,
                          sheet.version,
                          { brand: l.brand.id, decision: 'approve' },
                          stepUp,
                        )
                        .then(() => onChanged(`${l.brand.name} time approved and locked.`))
                        .catch((err) => setError(describe(err)))
                    }
                  >
                    Approve {l.brand.name}
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => setDialog({ line: l, mode: 'reject' })}
                  >
                    Return…
                  </button>
                </>
              ) : null}
              {l.can_unlock ? (
                <button
                  type="button"
                  className="button button-danger"
                  onClick={() => setDialog({ line: l, mode: 'unlock' })}
                >
                  Unlock…
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {error ? (
        <Banner tone="danger" title="Not decided">
          {error}
        </Banner>
      ) : null}
      <details>
        <summary>Entries</summary>
        <EntryList
          ws={ws}
          entries={sheet.entries}
          onChanged={() => onChanged('')}
          showPerson={false}
        />
      </details>
      {dialog ? (
        <DecideDialog
          ws={ws}
          sheet={sheet}
          line={dialog.line}
          mode={dialog.mode}
          onClose={() => setDialog(null)}
          onDone={onChanged}
        />
      ) : null}
    </article>
  );
}

export function TimeApprovalsPage({ ws }: { ws: string }) {
  const [state, setState] = useState<'pending' | 'decided'>('pending');
  const [nonce, setNonce] = useState(0);
  const data = useResource(() => time.approvals(ws, state), `tapp:${ws}:${state}:${nonce}`);
  const [said, setSaid] = useState('');
  return (
    <Page
      title="Timesheet approvals"
      wide
      breadcrumbs={[{ label: 'Time', to: routeHref('time', { ws }) }, { label: 'Approvals' }]}
    >
      <div className="actions-compact" role="group" aria-label="Show">
        <button
          type="button"
          className="button button-ghost"
          aria-pressed={state === 'pending'}
          onClick={() => setState('pending')}
        >
          Waiting
        </button>
        <button
          type="button"
          className="button button-ghost"
          aria-pressed={state === 'decided'}
          onClick={() => setState('decided')}
        >
          Decided
        </button>
      </div>
      <ResourceView resource={data.state} onRetry={data.retry} what="timesheets">
        {(list) =>
          list.length ? (
            <div className="time-sheets">
              {list.map((s) => (
                <SheetCard
                  key={s.id}
                  ws={ws}
                  sheet={s}
                  onChanged={(msg) => {
                    if (msg) setSaid(msg);
                    setNonce((n) => n + 1);
                  }}
                />
              ))}
            </div>
          ) : (
            <p className="empty">
              {state === 'pending'
                ? 'Nothing is waiting for your approval.'
                : 'No decided timesheets yet.'}
            </p>
          )
        }
      </ResourceView>
      <Announce>{said}</Announce>
    </Page>
  );
}

// -----------------------------------------------------------------------------------------------
// Reports and export
// -----------------------------------------------------------------------------------------------

const GROUPS = [
  { value: 'brand', label: 'Brand' },
  { value: 'project', label: 'Project' },
  { value: 'task', label: 'Task' },
  { value: 'member', label: 'Person' },
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

export function TimeReportPage({ ws }: { ws: string }) {
  const [from, setFrom] = useState(shiftDay(today(), -27));
  const [to, setTo] = useState(today());
  const [group, setGroup] = useState('brand');
  const [billable, setBillable] = useState('all');
  const [query, setQuery] = useState({ from, to, group, billable });
  const data = useResource(
    () =>
      time.report(ws, {
        ...query,
        billable: query.billable === 'all' ? undefined : query.billable,
      }),
    `trep:${ws}:${JSON.stringify(query)}`,
  );
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');
  const download = async (format: 'csv' | 'json') => {
    setError('');
    try {
      const f = await time.export(ws, {
        from: query.from,
        to: query.to,
        format,
        ...(query.billable === 'all' ? {} : { billable: query.billable }),
      });
      const url = URL.createObjectURL(f.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setSaid(`Exported ${f.name}.`);
    } catch (err) {
      setError(describe(err, 'The export failed.'));
    }
  };
  const variance = (r: ReportRow) =>
    r.planned_minutes === null ? null : r.actual_seconds - r.planned_minutes * 60;
  const label = useMemo(
    () => GROUPS.find((g) => g.value === query.group)?.label ?? 'Group',
    [query.group],
  );
  return (
    <Page
      title="Planned versus actual"
      wide
      breadcrumbs={[{ label: 'Time', to: routeHref('time', { ws }) }, { label: 'Reports' }]}
    >
      <form
        className="grant-form"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery({ from, to, group, billable });
        }}
      >
        <Field
          id="rep-from"
          label="From"
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Field
          id="rep-to"
          label="To"
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <SelectField
          id="rep-group"
          label="Group by"
          value={group}
          onChange={setGroup}
          options={GROUPS}
        />
        <SelectField
          id="rep-billable"
          label="Time"
          value={billable}
          onChange={setBillable}
          options={[
            { value: 'all', label: 'All time' },
            { value: 'billable', label: 'Billable only' },
            { value: 'non_billable', label: 'Non-billable only' },
          ]}
        />
        <button type="submit" className="button button-primary">
          Show
        </button>
      </form>
      <ResourceView resource={data.state} onRetry={data.retry} what="the report">
        {(r) => (
          <section className="card" aria-labelledby="rep-h">
            <h2 id="rep-h">
              {dayLabel(r.range.from)} – {dayLabel(r.range.to)}
            </h2>
            <p className="hint">
              Planned is the sum of task estimates
              {r.planned_measure === 'task_estimate_by_due_date'
                ? ' by due date'
                : ' for tasks due in the range or with time in it'}
              {r.billable === 'all' ? '' : '; actual is limited to the selected time'}. Only work
              you can see is counted.
            </p>
            {r.rows.length ? (
              <div className="table-scroll" role="region" aria-label="Report table" tabIndex={0}>
                <table className="access-table time-report">
                  <caption className="visually-hidden">
                    Planned versus actual by {label.toLowerCase()}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{label}</th>
                      <th scope="col">Planned</th>
                      <th scope="col">Actual</th>
                      <th scope="col">Difference</th>
                      <th scope="col">Billable</th>
                      <th scope="col">Non-billable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.rows.map((row) => {
                      const v = variance(row);
                      return (
                        <tr key={`${row.key.id ?? row.key.label}`}>
                          <th scope="row">
                            {row.key.label}
                            {row.budget_minutes !== null && row.budget_minutes !== undefined ? (
                              <span className="hint">
                                {' '}
                                (budget <Duration seconds={row.budget_minutes * 60} />)
                              </span>
                            ) : null}
                          </th>
                          <td>
                            {row.planned_minutes === null ? (
                              '—'
                            ) : (
                              <Duration seconds={row.planned_minutes * 60} />
                            )}
                          </td>
                          <td>
                            <Duration seconds={row.actual_seconds} />
                          </td>
                          <td>
                            {v === null ? (
                              '—'
                            ) : (
                              <span>
                                {v > 0 ? 'over ' : v < 0 ? 'under ' : ''}
                                <Duration seconds={Math.abs(v)} />
                              </span>
                            )}
                          </td>
                          <td>
                            <Duration seconds={row.billable_seconds} />
                          </td>
                          <td>
                            <Duration seconds={row.non_billable_seconds} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Total</th>
                      <td>
                        <Duration seconds={r.totals.planned_minutes * 60} />
                      </td>
                      <td>
                        <Duration seconds={r.totals.actual_seconds} />
                      </td>
                      <td />
                      <td>
                        <Duration seconds={r.totals.billable_seconds} />
                      </td>
                      <td>
                        <Duration seconds={r.totals.non_billable_seconds} />
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              <p className="empty">No planned or logged time in this range.</p>
            )}
            {r.truncated ? (
              <p className="hint">Showing the largest rows; totals include every row.</p>
            ) : null}
            <div className="actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void download('csv')}
              >
                Export CSV
              </button>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => void download('json')}
              >
                Export JSON
              </button>
            </div>
            {error ? (
              <Banner tone="danger" title="Export">
                {error}
              </Banner>
            ) : null}
          </section>
        )}
      </ResourceView>
      <Announce>{said}</Announce>
    </Page>
  );
}
