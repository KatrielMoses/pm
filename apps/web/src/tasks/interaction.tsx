import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../api.ts';
import { Link } from '../router.tsx';
import { routeHref } from '../shell/registry.ts';
import { useStepUp } from '../stepup.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Announce, Banner } from '../ui/feedback.tsx';
import { Field, SelectField, SubmitButton } from '../ui/form.tsx';
import {
  tasks,
  type BulkOp,
  type BulkOperation,
  type BulkOutcome,
  type Task,
  type TaskInteraction,
  type TaskSignals,
  type UndoHandle,
} from './client.ts';

/**
 * Phase 2D task interaction quality (ADR-0016): save states and inline field edits (field merge
 * with Keep mine / Use latest / Cancel), the undo toast, signal badges and the missing-information
 * panel, duplicate suggestions, personal reminders and snoozes, reschedule with an explicit choice,
 * ordering by command (drag is only a pointer shortcut over the same command), and the bulk bar
 * with a preview and a per-item report. Every control is keyboard reachable and announced.
 */

// -----------------------------------------------------------------------------------------------
// Save states (D13): saving, saved, conflict, offline, failed
// -----------------------------------------------------------------------------------------------

export type SaveState = 'idle' | 'saving' | 'saved' | 'conflict' | 'offline' | 'failed';

const SAVE_TEXT: Record<Exclude<SaveState, 'idle'>, string> = {
  saving: 'Saving…',
  saved: 'Saved',
  conflict: 'Changed by someone else',
  offline: "You're offline — not saved",
  failed: 'Not saved',
};

export function SaveStatus({ state, label }: { state: SaveState; label: string }) {
  return (
    <span className={`save-state save-${state}`} role="status" aria-live="polite">
      {state === 'idle' ? '' : `${label}: ${SAVE_TEXT[state]}`}
    </span>
  );
}

export const saveStateOf = (err: unknown): SaveState =>
  err instanceof ApiError
    ? err.code === 'conflict'
      ? 'conflict'
      : err.code === 'offline' || err.code === 'network'
        ? 'offline'
        : 'failed'
    : 'failed';

/**
 * One latest-wins read: starting a new request aborts the previous one, and a superseded answer
 * is ignored (D13 "abort stale requests").
 */
export function useLatest() {
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);
  return <T,>(fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    return fn(c.signal).then(
      (v) => (c.signal.aborted ? undefined : v),
      (err) => {
        if (c.signal.aborted || (err instanceof ApiError && err.code === 'aborted'))
          return undefined;
        throw err;
      },
    );
  };
}

// -----------------------------------------------------------------------------------------------
// Undo toast (D11)
// -----------------------------------------------------------------------------------------------

export function UndoToast(props: {
  ws: string;
  handle: UndoHandle | null;
  what: string;
  onDone: (message: string) => void;
}) {
  // One toast per change: a new handle starts fresh (countdown and messages).
  return props.handle ? (
    <UndoCountdown key={props.handle.id} {...props} handle={props.handle} />
  ) : null;
}

function UndoCountdown({
  ws,
  handle,
  what,
  onDone,
}: {
  ws: string;
  handle: UndoHandle;
  what: string;
  onDone: (message: string) => void;
}) {
  const stepUp = useStepUp();
  const remaining = () =>
    Math.max(0, Math.ceil((Date.parse(handle.expires_at) - Date.now()) / 1000));
  const [left, setLeft] = useState(remaining);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    const t = setInterval(() => setLeft(remaining()), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle.expires_at]);
  if (left === 0 && !problem) return null;
  const undo = async () => {
    setBusy(true);
    try {
      await tasks.undo(ws, handle.id, stepUp);
      onDone(`Undone: ${what}.`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'cancelled') return;
      setProblem(
        err instanceof ApiError && err.issues.some((i) => i.code === 'undo_expired')
          ? 'The time to undo this change has passed.'
          : err instanceof ApiError && err.code === 'conflict'
            ? 'Someone changed this since, so it can no longer be undone.'
            : "This couldn't be undone. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="toast" role="region" aria-label="Undo">
      {problem ? (
        <p role="alert">{problem}</p>
      ) : (
        <p>
          {what}.{' '}
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() => void undo()}
          >
            Undo
          </button>{' '}
          <span className="hint">{left} s</span>
        </p>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------------------------
// Inline field edits (D10) for list rows
// -----------------------------------------------------------------------------------------------

type InlineField = 'title' | 'priority' | 'due_date';

/**
 * Edits one field of one task in place with field merge: the request carries the value the person
 * started from (base). A conflict on the same field offers Keep mine (resend over the latest),
 * Use latest (discard mine), or Cancel. The control reverts visibly on failure.
 */
export function InlineEditor({
  ws,
  taskId,
  version,
  field,
  value,
  label,
  onSaved,
}: {
  ws: string;
  taskId: string;
  version: number;
  field: InlineField;
  value: string | null;
  label: string;
  onSaved: (t: Task, message: string) => void;
}) {
  const stepUp = useStepUp();
  const [draft, setDraft] = useState(value ?? '');
  const [state, setState] = useState<SaveState>('idle');
  const [conflict, setConflict] = useState<{ theirs: unknown; version: number } | null>(null);
  // The parent remounts this editor (key) when the stored value changes, so draft and base
  // always start from the latest value the person sees.
  const base = useRef<unknown>(value);
  const send = async (from: unknown, at: number) => {
    setState('saving');
    const next = field === 'due_date' && draft === '' ? null : draft;
    try {
      const t = await tasks.update(
        ws,
        taskId,
        at,
        { [field]: { base: from, value: next } },
        stepUp,
      );
      setState('saved');
      setConflict(null);
      base.current = next;
      onSaved(t, `${label} saved.`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'cancelled') return setState('idle');
      const s = saveStateOf(err);
      setState(s);
      const f =
        err instanceof ApiError ? err.conflict?.fields?.find((x) => x.field === field) : null;
      if (s === 'conflict' && f && err instanceof ApiError)
        setConflict({ theirs: f.theirs, version: err.conflict!.current_version });
      else setDraft((base.current as string | null) ?? '');
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if ((draft || null) === (base.current ?? null)) return;
    void send(base.current, version);
  };
  const id = `inline-${field}-${taskId}`;
  return (
    <form className="inline-edit" onSubmit={submit} noValidate aria-label={`Edit ${label}`}>
      {field === 'priority' ? (
        <SelectField
          id={id}
          label={label}
          value={draft}
          onChange={(v) => setDraft(v)}
          options={['none', 'low', 'medium', 'high', 'urgent'].map((p) => ({
            value: p,
            label: p === 'none' ? 'No priority' : p[0]!.toUpperCase() + p.slice(1),
          }))}
        />
      ) : (
        <Field
          id={id}
          label={label}
          type={field === 'due_date' ? 'date' : 'text'}
          value={draft}
          maxLength={300}
          onChange={(e) => setDraft(e.target.value)}
        />
      )}
      <button type="submit" className="button button-secondary" disabled={state === 'saving'}>
        Save {label.toLowerCase()}
      </button>
      <SaveStatus state={state} label={label} />
      {conflict ? (
        <Banner
          tone="warning"
          title="This was changed by someone else while you were editing"
          action={
            <div className="actions actions-compact">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void send(conflict.theirs, conflict.version)}
              >
                Keep mine
              </button>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  base.current = conflict.theirs;
                  setDraft((conflict.theirs as string | null) ?? '');
                  setConflict(null);
                  setState('idle');
                }}
              >
                Use latest
              </button>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  setDraft((base.current as string | null) ?? '');
                  setConflict(null);
                  setState('idle');
                }}
              >
                Cancel
              </button>
            </div>
          }
        >
          Theirs: {String(conflict.theirs ?? 'empty')}. Yours: {draft || 'empty'}.
        </Banner>
      ) : null}
    </form>
  );
}

// -----------------------------------------------------------------------------------------------
// Signals (D5, D6)
// -----------------------------------------------------------------------------------------------

const SIGNAL_TEXT: Record<keyof TaskSignals, string> = {
  stale: 'Stale',
  blocked: 'Blocked',
  repeatedly_rescheduled: 'Rescheduled often',
  missing_owner: 'No owner',
  missing_date: 'No date',
  missing_criteria: 'No acceptance criteria',
  missing_dependency: 'Waiting on work that will not finish',
};
const MISSING: Array<keyof TaskSignals> = [
  'missing_owner',
  'missing_date',
  'missing_criteria',
  'missing_dependency',
];

export function SignalBadges({ signals }: { signals: TaskSignals }) {
  const on = (Object.keys(SIGNAL_TEXT) as Array<keyof TaskSignals>).filter((k) => signals[k]);
  if (!on.length) return null;
  return (
    <ul className="badges" aria-label="Signals">
      {on.map((k) => (
        <li key={k} className={`badge badge-${k}`}>
          {SIGNAL_TEXT[k]}
        </li>
      ))}
    </ul>
  );
}

const SOURCE_TEXT: Record<string, string> = {
  manual: 'Created by a person',
  recurring: 'Created by a recurring schedule',
  template: 'Created from a template',
  intake: 'Created from intake',
  import: 'Imported',
  integration: 'Created by an integration',
  ai_draft: 'Drafted with AI',
};

/** Signals, freshness, origin, and the missing-information panel on the task page. */
export function TaskSignalsPanel({
  ws,
  task,
  info,
  reload,
}: {
  ws: string;
  task: Task;
  info: TaskInteraction;
  reload: () => void;
}) {
  const stepUp = useStepUp();
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');
  const s = info.signals;
  const missing = MISSING.filter((k) => s[k]);
  const fresh = info.freshness.last_meaningful_update_at
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(info.freshness.last_meaningful_update_at),
      )
    : null;
  return (
    <section className="card" aria-labelledby="sig-h">
      <h2 id="sig-h">Status signals</h2>
      <SignalBadges signals={s} />
      {!Object.values(s).some(Boolean) ? <p>Nothing needs attention.</p> : null}
      {fresh ? (
        <p className="hint">
          Last meaningful update {fresh}
          {info.freshness.stale_after_days
            ? ` · stale after ${info.freshness.stale_after_days} days without one`
            : ''}
          .
        </p>
      ) : null}
      {s.repeatedly_rescheduled ? (
        <p className="hint">
          The due date or deadline changed {info.freshness.reschedule_rule.count} or more times in{' '}
          {info.freshness.reschedule_rule.window_days} days.
        </p>
      ) : null}
      <p className="hint">
        {SOURCE_TEXT[info.source.kind] ?? 'Created'}
        {info.source.kind === 'template' && info.source.version
          ? ` (version ${String(info.source.version)})`
          : ''}
        {info.source.occurrence ? ` (${String(info.source.occurrence).replace('T', ' ')})` : ''}.
      </p>
      {missing.length ? (
        <section aria-labelledby="miss-h">
          <h3 id="miss-h">Missing information</h3>
          <ul>
            {missing.map((k) => (
              <li key={k}>{SIGNAL_TEXT[k]}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {task.capabilities.edit ? (
        <button
          type="button"
          className="button button-secondary"
          onClick={() =>
            void tasks
              .verb(ws, task.id, 'mark_updated', {}, stepUp)
              .then(() => {
                setSaid('Marked as updated.');
                setError('');
                reload();
              })
              .catch((err) => {
                if (!(err instanceof ApiError && err.code === 'cancelled'))
                  setError("Couldn't mark this as updated.");
              })
          }
        >
          Mark as updated
        </button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <Announce>{said}</Announce>
    </section>
  );
}

// -----------------------------------------------------------------------------------------------
// Duplicate suggestions while creating (D7; advisory only)
// -----------------------------------------------------------------------------------------------

export function DuplicateHint({
  ws,
  brand,
  project,
  title,
}: {
  ws: string;
  brand: string | null;
  project?: string | null;
  title: string;
}) {
  const latest = useLatest();
  const [found, setFound] = useState<Array<{ id: string; title: string }>>([]);
  const active = !!brand && title.trim().length >= 3;
  useEffect(() => {
    if (!brand || title.trim().length < 3) return;
    const t = setTimeout(() => {
      void latest((signal) =>
        tasks.duplicates(ws, { brand, title, ...(project ? { project } : {}) }, signal),
      )
        .then((r) => {
          if (r) setFound(r);
        })
        .catch(() => setFound([]));
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, brand, project, title]);
  if (!active || !found.length) return null;
  return (
    <div className="hint" role="status" aria-live="polite">
      <p>Possible duplicates (you can still add this task):</p>
      <ul>
        {found.map((d) => (
          <li key={d.id}>
            <Link to={routeHref('task', { ws, tsk: d.id })}>{d.title}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// -----------------------------------------------------------------------------------------------
// Personal reminders and snooze (D3, D4)
// -----------------------------------------------------------------------------------------------

const toInstant = (local: string) => (local ? new Date(local).toISOString() : '');
const fmt = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );

export function RemindersSection({
  ws,
  task,
  info,
  reload,
}: {
  ws: string;
  task: Task;
  info: TaskInteraction;
  reload: () => void;
}) {
  const stepUp = useStepUp();
  const [at, setAt] = useState('');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setSaid(message);
      reload();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'cancelled') return;
      setError(
        err instanceof ApiError && err.issues.length
          ? err.issues[0]!.message
          : 'That did not work. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="rem-h">
      <h2 id="rem-h">Reminders and snooze</h2>
      <p className="hint">Only you see these. They never change the task’s dates.</p>
      {info.reminders.length ? (
        <ul className="plain-list" aria-label="Your reminders">
          {info.reminders.map((r) => (
            <li key={r.id}>
              {fmt(r.remind_at)} · {r.state === 'fired' ? 'reminded' : 'scheduled'}{' '}
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      tasks.updateReminder(
                        ws,
                        r.id,
                        { state: r.state === 'fired' ? 'dismissed' : 'cancelled' },
                        stepUp,
                      ),
                    r.state === 'fired' ? 'Reminder dismissed.' : 'Reminder removed.',
                  )
                }
              >
                {r.state === 'fired' ? 'Dismiss' : 'Remove'}
                <span className="visually-hidden"> reminder at {fmt(r.remind_at)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>No reminders.</p>
      )}
      <form
        aria-label="Add a reminder"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!at) return setError('Choose when to be reminded.');
          void run(() => tasks.remind(ws, task.id, toInstant(at), stepUp), 'Reminder added.');
        }}
      >
        <Field
          id="rem-at"
          label="Remind me at"
          type="datetime-local"
          value={at}
          onChange={(e) => setAt(e.target.value)}
        />
        <SubmitButton busy={busy}>Add reminder</SubmitButton>
      </form>
      {info.snooze ? (
        <p>
          Snoozed until {fmt(info.snooze.until)}.{' '}
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() =>
              void run(() => tasks.verb(ws, task.id, 'unsnooze', {}, stepUp), 'Snooze ended.')
            }
          >
            End snooze
          </button>
        </p>
      ) : (
        <form
          aria-label="Snooze"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!until) return setError('Choose until when.');
            void run(
              () => tasks.verb(ws, task.id, 'snooze', { until: toInstant(until) }, stepUp),
              'Snoozed.',
            );
          }}
        >
          <Field
            id="snooze-until"
            label="Snooze until"
            hint="Hides this task from your reminders until then."
            type="datetime-local"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
          />
          <SubmitButton busy={busy}>Snooze</SubmitButton>
        </form>
      )}
      {error ? <p role="alert">{error}</p> : null}
      <Announce>{said}</Announce>
    </section>
  );
}

// -----------------------------------------------------------------------------------------------
// Reschedule (D4): an explicit choice of due date or deadline; the deadline never moves implicitly
// -----------------------------------------------------------------------------------------------

export function RescheduleDialog({
  ws,
  task,
  onClose,
  onDone,
}: {
  ws: string;
  task: Task;
  onClose: () => void;
  onDone: (t: Task) => void;
}) {
  const stepUp = useStepUp();
  const [which, setWhich] = useState<'due_date' | 'deadline'>('due_date');
  const [date, setDate] = useState(task.due_date ?? '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const current = which === 'due_date' ? task.due_date : task.deadline;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const value = which === 'due_date' ? date || null : date ? { date } : null;
      const t = await tasks.update(
        ws,
        task.id,
        task.version,
        { [which]: { base: current, value } },
        stepUp,
      );
      onDone(t);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled')) setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Reschedule" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <fieldset>
          <legend>What changes</legend>
          <label className="choice">
            <input
              type="radio"
              name="resched"
              checked={which === 'due_date'}
              onChange={() => {
                setWhich('due_date');
                setDate(task.due_date ?? '');
              }}
            />{' '}
            Due date (when you plan to finish)
          </label>
          <label className="choice">
            <input
              type="radio"
              name="resched"
              checked={which === 'deadline'}
              onChange={() => {
                setWhich('deadline');
                setDate(task.deadline && 'date' in task.deadline ? task.deadline.date : '');
              }}
            />{' '}
            Deadline (the commitment; others may rely on it)
          </label>
        </fieldset>
        <Field
          id="resched-date"
          label={which === 'due_date' ? 'New due date' : 'New deadline'}
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        {error instanceof ApiError ? (
          <p role="alert">{error.issues[0]?.message ?? 'This could not be saved.'}</p>
        ) : null}
        <div className="actions">
          <SubmitButton busy={busy}>Reschedule</SubmitButton>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------------------------
// Bulk (D8)
// -----------------------------------------------------------------------------------------------

const OPERATION_TEXT: Record<BulkOperation, string> = {
  set_status: 'Set status',
  set_priority: 'Set priority',
  set_due_date: 'Set due date',
  add_label: 'Add label',
  remove_label: 'Remove label',
  archive: 'Archive',
  trash: 'Move to trash',
};
const OUTCOME_TEXT: Record<BulkOutcome, string> = {
  ready: 'Will change',
  no_change: 'Already set',
  applied: 'Changed',
  not_found: 'Not available',
  forbidden: "You can't change this one",
  conflict: 'Changed by someone else',
  invalid: "Can't be changed this way",
  skipped: 'Skipped',
};
const CODE_TEXT: Record<string, string> = {
  status_unavailable: 'Its workflow doesn’t offer this status',
  transition_not_allowed: 'Its workflow doesn’t allow this change',
  requirements_unmet: 'Required fields are missing',
  required: 'Required fields are missing',
  approval_required: 'Needs an approval — change it on the task',
  needs_review: 'Needs confirmation — change it on the task',
  use_reopen: 'Reopen it first',
  stale: 'Changed since the preview',
  archived: 'Archived',
};
const detailOf = (i: BulkOp['items'][number]) =>
  [
    i.code && CODE_TEXT[i.code] ? CODE_TEXT[i.code] : null,
    i.required_fields?.length ? `Needs: ${i.required_fields.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('. ');

/**
 * The bulk bar: choose tasks (checkboxes), an action and its value, preview every item, then
 * apply once. Destructive actions are all-or-nothing unless the person chooses to change only the
 * ones that can be changed. The report lists every item.
 */
export function BulkBar({
  ws,
  choices,
  labels,
  onApplied,
}: {
  ws: string;
  choices: Array<{ id: string; title: string }>;
  labels: Array<{ value: string; label: string }>;
  onApplied: (message: string, undo: UndoHandle | null) => void;
}) {
  const stepUp = useStepUp();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [op, setOp] = useState<BulkOperation>('set_priority');
  const [value, setValue] = useState('high');
  const [partial, setPartial] = useState(false);
  const [preview, setPreview] = useState<BulkOp | null>(null);
  const [report, setReport] = useState<BulkOp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Statuses for the current selection: every workflow involved, custom statuses included, with
  // how many selected tasks offer each (review 01). Never mapped to a built-in status.
  const latest = useLatest();
  const [statusInfo, setStatusInfo] = useState<Awaited<
    ReturnType<typeof tasks.bulkStatusOptions>
  > | null>(null);
  const selectionKey = [...selected].sort().join(',');
  useEffect(() => {
    if (op !== 'set_status' || !selectionKey) return;
    void latest((signal) => tasks.bulkStatusOptions(ws, selectionKey.split(','), signal))
      .then((r) => {
        if (!r) return;
        setStatusInfo(r);
        setValue((v) =>
          r.options.some((o) => o.status.key === v) ? v : (r.options[0]?.status.key ?? ''),
        );
      })
      .catch(() => setStatusInfo(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, op, selectionKey]);
  const statuses =
    statusInfo && selectionKey
      ? statusInfo.options.map((o) => ({
          value: o.status.key,
          label: `${o.status.name}${'custom' in o.status && o.status.custom ? ' (custom)' : ''}${
            o.all ? '' : ` — only ${o.available_for} of ${statusInfo.editable} tasks`
          }`,
        }))
      : [];
  const chosen = statusInfo?.options.find((o) => o.status.key === value);
  const titleOf = (id: string) => choices.find((c) => c.id === id)?.title ?? 'A task you can’t see';
  const destructive = op === 'archive' || op === 'trash';
  const params = (): Record<string, unknown> | undefined =>
    op === 'add_label' || op === 'remove_label'
      ? { label: value }
      : op === 'archive' || op === 'trash'
        ? undefined
        : { value: op === 'set_due_date' && !value ? null : value };
  const doPreview = async () => {
    setBusy(true);
    setError('');
    setReport(null);
    try {
      const p = params();
      setPreview(
        await tasks.previewBulk(
          ws,
          {
            operation: op,
            ...(p ? { params: p } : {}),
            tasks: [...selected],
            ...(destructive ? { mode: partial ? 'partial' : 'atomic' } : {}),
          },
          stepUp,
        ),
      );
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled'))
        setError(
          err instanceof ApiError && err.issues[0] ? err.issues[0].message : 'Preview failed.',
        );
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const r = await tasks.executeBulk(ws, preview.id, stepUp);
      setReport(r);
      setPreview(null);
      setSelected(new Set());
      const changed = r.counts.applied ?? 0;
      onApplied(
        `${OPERATION_TEXT[r.operation]}: ${changed} of ${r.items.length} changed.`,
        r.undo ?? null,
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === 'cancelled') return;
      setError(
        err instanceof ApiError && err.issues.some((i) => i.code === 'bulk_item_failed')
          ? 'One task could not be changed, so none were. Review it, or preview again and choose to change only the ones that can be changed.'
          : err instanceof ApiError && err.code === 'conflict'
            ? 'This preview expired. Preview again.'
            : 'The change failed. Nothing was changed.',
      );
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };
  const valueField =
    op === 'set_status' ? (
      <SelectField
        id="bulk-value"
        label="Status"
        value={value}
        onChange={setValue}
        options={statuses.length ? statuses : [{ value: '', label: 'Select tasks first' }]}
        hint={
          statusInfo?.mixed_workflows
            ? 'These tasks use different workflows. A status only some of them offer is refused for the others in the preview; nothing is mapped to another status.'
            : undefined
        }
      />
    ) : op === 'set_priority' ? (
      <SelectField
        id="bulk-value"
        label="Priority"
        value={value}
        onChange={setValue}
        options={['none', 'low', 'medium', 'high', 'urgent'].map((p) => ({ value: p, label: p }))}
      />
    ) : op === 'set_due_date' ? (
      <Field
        id="bulk-value"
        label="Due date"
        type="date"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    ) : op === 'add_label' || op === 'remove_label' ? (
      <SelectField
        id="bulk-value"
        label="Label"
        value={value}
        onChange={setValue}
        options={labels}
      />
    ) : null;
  return (
    <section className="card bulk" aria-labelledby="bulk-h">
      <h2 id="bulk-h">Change several tasks</h2>
      <fieldset>
        <legend>Tasks ({selected.size} selected)</legend>
        <div className="actions actions-compact">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setSelected(new Set(choices.map((c) => c.id)))}
          >
            Select all shown
          </button>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </button>
        </div>
        {choices.map((c) => (
          <label key={c.id} className="choice">
            <input
              type="checkbox"
              checked={selected.has(c.id)}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(c.id);
                else next.delete(c.id);
                setSelected(next);
              }}
            />{' '}
            {c.title}
          </label>
        ))}
      </fieldset>
      <SelectField
        id="bulk-op"
        label="Action"
        value={op}
        onChange={(v) => {
          setOp(v as BulkOperation);
          setValue(
            v === 'set_status'
              ? (statuses[0]?.value ?? '')
              : v === 'set_priority'
                ? 'high'
                : v === 'add_label' || v === 'remove_label'
                  ? (labels[0]?.value ?? '')
                  : '',
          );
        }}
        options={(Object.keys(OPERATION_TEXT) as BulkOperation[]).map((o) => ({
          value: o,
          label: OPERATION_TEXT[o],
        }))}
      />
      {valueField}
      {op === 'set_status' && chosen && !chosen.all ? (
        <p className="hint" role="status">
          Only {chosen.available_for} of {statusInfo!.editable} selected tasks offer “
          {chosen.status.name}”. The preview refuses it for the others; applying changes only the
          tasks that offer it.
        </p>
      ) : null}
      {destructive ? (
        <label className="choice">
          <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.target.checked)} />{' '}
          Change only the tasks that can be changed (otherwise all or nothing)
        </label>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="button"
          disabled={!selected.size || busy}
          onClick={() => void doPreview()}
        >
          Preview change
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {preview ? (
        <Dialog
          title={`${OPERATION_TEXT[preview.operation]}: preview`}
          destructive={preview.destructive}
          onClose={() => setPreview(null)}
        >
          <p>
            {preview.destructive && preview.mode === 'atomic'
              ? 'All of these change, or none do.'
              : 'Each task is changed separately; you get a report for every one.'}
          </p>
          <table>
            <caption className="visually-hidden">What will happen to each task</caption>
            <thead>
              <tr>
                <th scope="col">Task</th>
                {preview.operation === 'set_status' ? <th scope="col">Proposed status</th> : null}
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {preview.items.map((i) => (
                <tr key={i.task}>
                  <td>{titleOf(i.task)}</td>
                  {preview.operation === 'set_status' ? <td>{i.target?.name ?? '—'}</td> : null}
                  <td>
                    {OUTCOME_TEXT[i.outcome]}
                    {detailOf(i) ? `: ${detailOf(i)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="actions">
            <button
              type="button"
              className={preview.destructive ? 'button button-danger' : 'button'}
              disabled={busy || !(preview.counts.ready ?? 0)}
              onClick={() => void apply()}
            >
              Apply to {preview.counts.ready ?? 0}{' '}
              {(preview.counts.ready ?? 0) === 1 ? 'task' : 'tasks'}
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setPreview(null)}
            >
              Cancel
            </button>
          </div>
        </Dialog>
      ) : null}
      {report ? (
        <section aria-labelledby="bulk-report-h">
          <h3 id="bulk-report-h">Result</h3>
          <ul>
            {report.items.map((i) => (
              <li key={i.task}>
                {titleOf(i.task)}: {OUTCOME_TEXT[i.outcome]}
                {detailOf(i) ? ` (${detailOf(i)})` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
