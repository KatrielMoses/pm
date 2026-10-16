import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api.ts';
import { projects } from '../projects/client.ts';
import { Link, useRouter } from '../router.tsx';
import { routeHref } from '../shell/registry.ts';
import { useWidthClass } from '../shell/width.ts';
import { useStepUp } from '../stepup.tsx';
import { calendars, type CalendarEventView } from '../integrations/calendar-client.ts';
import { localInstant, planning } from '../planning/client.ts';
import { tasks } from '../tasks/client.ts';
import { Dialog } from '../ui/dialog.tsx';
import { Announce, Banner } from '../ui/feedback.tsx';
import { Field, SelectField } from '../ui/form.tsx';
import { transitions } from '../workflow/client.ts';
import {
  layouts,
  type ActivityItem,
  type Catalog,
  type Entity,
  type Presentation,
  type Query,
  type QueryPage,
  type QueryRow,
} from './client.ts';

/**
 * Phase 3B core view layouts (ADR-0020). Every layout renders rows the 3A engine returned for
 * this person; layout facts come from reads over the same query. Each visual layout has a
 * keyboard and non-drag way to act and a text or table equivalent (A11Y-SR-08, A11Y-PA-16).
 */

export interface LayoutProps {
  ws: string;
  entity: Entity;
  rows: QueryRow[];
  page: QueryPage;
  presentation: Presentation;
  query: Query;
  scope: string[];
  catalog: Catalog;
  onOpen: (id: string) => void;
  onChanged: () => void;
}

const titleCase = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1).replace(/_/g, ' ') : s);
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return day(d);
};
const weekStart = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return addDays(iso, -((d.getUTCDay() + 6) % 7));
};
const localToday = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const fmtDay = (
  iso: string,
  opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' },
) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
/** The local calendar day of an instant (the viewer's zone). */
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const hours = (m: number) => (m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);
const owner = (r: QueryRow) => (r.owner as { name: string } | null | undefined)?.name ?? '';
const dateOf = (r: QueryRow, f: string) => {
  const v = r[f];
  return typeof v === 'string' ? v.slice(0, 10) : null;
};
const describe = (err: unknown) =>
  err instanceof ApiError
    ? err.issues.length
      ? err.issues.map((i) => i.message).join(' ')
      : err.message
    : 'Something went wrong.';

function OpenButton({
  id,
  title,
  onOpen,
}: {
  id: string;
  title: string;
  onOpen: (id: string) => void;
}) {
  return (
    <button type="button" className="link-button card-title" onClick={() => onOpen(id)}>
      {title}
    </button>
  );
}

// -------------------------------------------------------------------------------------------------
// List (RS-50)
// -------------------------------------------------------------------------------------------------

export function ListLayout({ rows, page, entity, onOpen }: LayoutProps) {
  const groups = page.view.groups;
  const label = (k: string | undefined) => groups?.find((g) => (g.key ?? undefined) === k);
  const blocks: Array<{ key: string | undefined; rows: QueryRow[] }> = [];
  for (const r of rows) {
    const last = blocks.at(-1);
    if (groups && last && last.key === r.group) last.rows.push(r);
    else if (groups) blocks.push({ key: r.group, rows: [r] });
    else if (last) last.rows.push(r);
    else blocks.push({ key: undefined, rows: [r] });
  }
  return (
    <div className="list-layout">
      {blocks.map((b, i) => (
        <section
          key={`${b.key ?? 'none'}:${i}`}
          aria-label={groups ? (label(b.key)?.label ?? 'None') : undefined}
        >
          {groups ? (
            <h3 className="group-heading">
              {label(b.key)?.label ?? 'None'}{' '}
              <span className="hint">({label(b.key)?.count ?? b.rows.length})</span>
            </h3>
          ) : null}
          <ul className="list-rows">
            {b.rows.map((r) => (
              <li key={r.id} data-anchor-id={r.id} className="list-row">
                <OpenButton id={r.id} title={r.title} onOpen={onOpen} />
                <span className="list-meta">
                  <span>{r.brand.name}</span>
                  <span>{r.status.name}</span>
                  {dateOf(r, entity === 'task' ? 'due_date' : 'target_date') ? (
                    <span>
                      {entity === 'task' ? 'Due' : 'Target'}{' '}
                      {fmtDay(dateOf(r, entity === 'task' ? 'due_date' : 'target_date')!)}
                    </span>
                  ) : null}
                  {owner(r) ? <span>{owner(r)}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// Board (RS-51, A11Y-PA-06): canonical transitions, per-item outcomes, Move to… without dragging
// -------------------------------------------------------------------------------------------------

interface Column {
  key: string;
  label: string;
}

export function BoardLayout(props: LayoutProps) {
  const { ws, rows, presentation, onOpen, onChanged, entity } = props;
  const stepUp = useStepUp();
  const width = useWidthClass();
  const field = presentation.board_field ?? 'status';
  // Status columns are the statuses the tasks' own workflows offer (2D status options), plus any
  // status a shown record is in; nothing is invented and nothing hidden is counted.
  const [offered, setOffered] = useState<Array<{ key: string; name: string; category: string }>>(
    [],
  );
  const ids = useMemo(() => rows.map((r) => r.id).slice(0, 200), [rows]);
  useEffect(() => {
    let live = true;
    if (field !== 'status' || entity !== 'task' || !ids.length) {
      setOffered([]);
      return;
    }
    tasks.bulkStatusOptions(ws, ids).then(
      (o) => live && setOffered(o.options.map((x) => x.status)),
      () => live && setOffered([]),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, field, entity, JSON.stringify(ids)]);
  const columns = useMemo<Column[]>(() => {
    if (field === 'priority') return PRIORITIES.map((p) => ({ key: p, label: titleCase(p) }));
    const order = ['planned', 'active', 'paused', 'done', 'cancelled'];
    const seen = new Map<string, Column & { category: string }>();
    for (const st of [...offered, ...rows.map((r) => r.status)])
      if (!seen.has(st.key))
        seen.set(st.key, { key: st.key, label: st.name, category: st.category });
    return [...seen.values()].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
  }, [rows, field, offered]);
  // The Move dialog lists exactly the transitions the record's workflow offers it now.
  const [targets, setTargets] = useState<Column[] | null>(null);
  const keyOf = (r: QueryRow) => (field === 'priority' ? r.priority : r.status.key);
  const [compactColumn, setCompactColumn] = useState(columns[0]?.key ?? '');
  const [moving, setMoving] = useState<QueryRow | null>(null);
  const [said, setSaid] = useState('');
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [dragging, setDragging] = useState<string | null>(null);

  /** One move through the canonical command for the field; outcomes are per item. */
  const move = async (r: QueryRow, to: Column) => {
    if (keyOf(r) === to.key) return;
    setFailures((f) => ({ ...f, [r.id]: '' }));
    try {
      if (field === 'priority') {
        await tasks.update(
          ws,
          r.id,
          r.version,
          { priority: { base: r.priority, value: to.key } },
          stepUp,
        );
      } else {
        const pv = await transitions.preview(ws, r.id, { to: to.key });
        const gated =
          !pv.allowed ||
          pv.approval.required ||
          pv.confirmation !== 'none' ||
          pv.required_fields.some((f) => !f.satisfied);
        if (gated) {
          const why = pv.approval.required
            ? 'needs approval'
            : pv.required_fields.some((f) => !f.satisfied)
              ? `needs ${pv.required_fields
                  .filter((f) => !f.satisfied)
                  .map((f) => f.label)
                  .join(', ')}`
              : pv.confirmation !== 'none'
                ? 'needs confirmation'
                : (pv.issues[0]?.message ?? 'is not allowed');
          setFailures((f) => ({
            ...f,
            [r.id]: `Not moved: this change ${why}. Open the ${entity} to finish it.`,
          }));
          setSaid(`${r.title} was not moved to ${to.label}.`);
          return;
        }
        await transitions.apply(
          ws,
          r.id,
          { to: to.key, version: pv.record_version, preview_token: pv.preview_token },
          stepUp,
        );
      }
      setSaid(`${r.title} moved to ${to.label}.`);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'cancelled') return;
      setFailures((f) => ({
        ...f,
        [r.id]:
          err instanceof ApiError && err.code === 'conflict'
            ? 'Not moved: someone changed it first. The board was refreshed.'
            : `Not moved: ${describe(err)}`,
      }));
      setSaid(`${r.title} was not moved.`);
      if (err instanceof ApiError && err.code === 'conflict') onChanged();
    }
  };
  const shown = width === 'compact' ? columns.filter((c) => c.key === compactColumn) : columns;
  return (
    <div className="board-layout">
      {said ? <Announce>{said}</Announce> : null}
      {width === 'compact' && columns.length ? (
        <SelectField
          id="board-column"
          label="Column"
          value={compactColumn}
          onChange={setCompactColumn}
          options={columns.map((c) => ({
            value: c.key,
            label: `${c.label} (${rows.filter((r) => keyOf(r) === c.key).length})`,
          }))}
        />
      ) : null}
      <div className="board-columns">
        {shown.map((c) => {
          const cards = rows.filter((r) => keyOf(r) === c.key);
          return (
            <section
              key={c.key}
              className={`board-column${dragging ? ' drop-ready' : ''}`}
              aria-labelledby={`col-${c.key}`}
              onDragOver={(e) => {
                if (dragging) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                const r = rows.find((x) => x.id === dragging);
                setDragging(null);
                if (r) void move(r, c);
              }}
            >
              <h3 id={`col-${c.key}`} className="board-column-title">
                {c.label} <span className="hint">({cards.length})</span>
              </h3>
              <ul>
                {cards.map((r) => (
                  <li
                    key={r.id}
                    className="board-card"
                    data-anchor-id={r.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', r.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDragging(r.id);
                    }}
                    onDragEnd={() => setDragging(null)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setDragging(null);
                    }}
                  >
                    <OpenButton id={r.id} title={r.title} onOpen={onOpen} />
                    <span className="hint">
                      {r.brand.name}
                      {owner(r) ? ` · ${owner(r)}` : ''}
                    </span>
                    <button
                      type="button"
                      className="button button-secondary"
                      aria-label={`Move ${r.title}`}
                      onClick={() => {
                        setTargets(null);
                        setMoving(r);
                        if (field === 'status')
                          transitions.options(ws, r.id).then(
                            (o) =>
                              setTargets(
                                o.options.map((x) => ({ key: x.status.key, label: x.status.name })),
                              ),
                            () => setTargets([]),
                          );
                        else setTargets(columns.filter((c) => c.key !== keyOf(r)));
                      }}
                    >
                      Move to…
                    </button>
                    {failures[r.id] ? (
                      <p className="field-error" role="alert">
                        {failures[r.id]}{' '}
                        <button type="button" className="link-button" onClick={() => onOpen(r.id)}>
                          Open
                        </button>
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {moving ? (
        <Dialog title={`Move “${moving.title}”`} onClose={() => setMoving(null)}>
          <p>
            {field === 'status'
              ? 'The move uses the workflow’s rules. If it needs fields or approval, nothing changes and you can finish it on the task.'
              : 'Changes the priority. Dates and deadlines never change.'}
          </p>
          {targets === null ? <p role="status">Loading the moves this item allows…</p> : null}
          {targets && !targets.length ? (
            <p>There is nowhere this item can move right now.</p>
          ) : null}
          <ul className="move-targets">
            {(targets ?? [])
              .filter((c) => c.key !== keyOf(moving))
              .map((c) => (
                <li key={c.key}>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => {
                      const r = moving;
                      setMoving(null);
                      void move(r, c);
                    }}
                  >
                    {c.label}
                  </button>
                </li>
              ))}
          </ul>
          <div className="actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setMoving(null)}
            >
              Cancel
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// Calendar (RS-54, CAL-001/002): day, week, month, agenda; tasks, deadlines, milestones
// -------------------------------------------------------------------------------------------------

export interface CalendarWindow {
  from: string;
  to: string;
}

/** The date window of a calendar mode around an anchor day (the query is narrowed to it). */
export function calendarWindow(
  mode: Presentation['calendar_mode'],
  anchor: string,
): CalendarWindow {
  if (mode === 'day') return { from: anchor, to: anchor };
  if (mode === 'week') {
    const s = weekStart(anchor);
    return { from: s, to: addDays(s, 6) };
  }
  if (mode === 'agenda') return { from: anchor, to: addDays(anchor, 27) };
  const first = `${anchor.slice(0, 7)}-01`;
  const s = weekStart(first);
  const d = new Date(`${first}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const last = addDays(day(d), -1);
  return { from: s, to: addDays(weekStart(last), 6) };
}

export function CalendarLayout(
  props: LayoutProps & {
    anchor: string;
    setAnchor: (d: string) => void;
    mode: NonNullable<Presentation['calendar_mode']>;
    setMode: (m: NonNullable<Presentation['calendar_mode']>) => void;
  },
) {
  const { ws, rows, entity, presentation, anchor, setAnchor, mode, setMode, onOpen, scope } = props;
  const width = useWidthClass();
  const stepUp = useStepUp();
  const field = presentation.date_field ?? (entity === 'task' ? 'due_date' : 'target_date');
  // CAL-003: schedule a task as a 3C work block without dragging; dates never change.
  const [scheduling, setScheduling] = useState<{ id: string; title: string } | null>(null);
  const [slot, setSlot] = useState({ day: '', start: '09:00', minutes: '60' });
  const [scheduleError, setScheduleError] = useState('');
  const [scheduled, setScheduled] = useState('');
  const schedule = async () => {
    if (!scheduling) return;
    setScheduleError('');
    try {
      await planning.createBlock(
        ws,
        {
          task: scheduling.id,
          starts_at: localInstant(slot.day, slot.start),
          duration_minutes: Number(slot.minutes),
        },
        stepUp,
      );
      setScheduled(
        `${scheduling.title} scheduled on ${fmtDay(slot.day)} at ${slot.start}. Its dates did not change.`,
      );
      setScheduling(null);
    } catch (err) {
      setScheduleError(
        err instanceof ApiError ? (err.issues[0]?.message ?? err.message) : 'Not scheduled.',
      );
    }
  };
  const [layers, setLayers] = useState({
    primary: true,
    deadline: entity === 'task',
    milestones: true,
    external: true,
  });
  const win = calendarWindow(mode, anchor);
  // 6C: the viewer's own connected-calendar events in the visible window (read-only here).
  const [external, setExternal] = useState<{
    connected: boolean;
    events: CalendarEventView[];
  } | null>(null);
  useEffect(() => {
    let live = true;
    if (!layers.external) return;
    calendars
      .events(
        ws,
        new Date(`${win.from}T00:00:00`).toISOString(),
        new Date(`${addDays(win.to, 1)}T00:00:00`).toISOString(),
      )
      .then(
        (r) => live && setExternal({ connected: r.connected, events: r.events }),
        () => live && setExternal(null),
      );
    return () => {
      live = false;
    };
  }, [ws, win.from, win.to, layers.external]);
  const [ms, setMs] = useState<
    Array<{ id: string; project: string; name: string; due_date: string | null }>
  >([]);
  const projectIds = useMemo(
    () =>
      [
        ...new Set(
          rows
            .map((r) =>
              entity === 'project' ? r.id : (r.project as { id: string } | undefined)?.id,
            )
            .filter((x): x is string => !!x),
        ),
      ].slice(0, 200),
    [rows, entity],
  );
  useEffect(() => {
    let live = true;
    if (!layers.milestones || !projectIds.length) return;
    layouts
      .milestones(ws, {
        query: { entity: 'project' },
        ids: projectIds,
        ...(scope.length ? { scope } : {}),
      })
      .then(
        (m) => live && setMs(m),
        () => live && setMs([]),
      );
    return () => {
      live = false;
    };
  }, [ws, projectIds, layers.milestones, scope]);
  type Ev = {
    key: string;
    day: string;
    label: string;
    kind: string;
    id: string;
    brand: string;
    open: boolean;
    /** An external calendar event: its time range and calendar, in the viewer's locale. */
    ext?: { time: string; calendar: string };
  };
  const events: Ev[] = [];
  for (const r of rows) {
    const d = dateOf(r, field);
    if (layers.primary && d && d >= win.from && d <= win.to)
      events.push({
        key: `${r.id}:p`,
        day: d,
        label: r.title,
        kind: titleCase(field.replace('_date', '')),
        id: r.id,
        brand: r.brand.name,
        open: true,
      });
    const dl = field !== 'deadline_date' ? dateOf(r, 'deadline_date') : null;
    if (layers.deadline && dl && dl >= win.from && dl <= win.to)
      events.push({
        key: `${r.id}:d`,
        day: dl,
        label: r.title,
        kind: 'Deadline',
        id: r.id,
        brand: r.brand.name,
        open: true,
      });
  }
  for (const m of layers.milestones && projectIds.length ? ms : [])
    if (m.due_date && m.due_date >= win.from && m.due_date <= win.to)
      events.push({
        key: `${m.id}:m`,
        day: m.due_date,
        label: m.name,
        kind: 'Milestone',
        id: m.project,
        brand: '',
        open: false,
      });
  for (const e of layers.external && external ? external.events : []) {
    const start = e.all_day ? e.starts_at.slice(0, 10) : localDay(new Date(e.starts_at));
    const d = start < win.from ? win.from : start;
    if (d > win.to) continue;
    events.push({
      key: `${e.id}:x`,
      day: d,
      label: e.title,
      kind: 'External',
      id: e.id,
      brand: '',
      open: false,
      ext: {
        time: e.all_day ? 'all day' : `${clock(e.starts_at)}–${clock(e.ends_at)}`,
        calendar: e.calendar.label,
      },
    });
  }
  events.sort((a, b) => a.day.localeCompare(b.day) || a.label.localeCompare(b.label));
  const byDay = new Map<string, Ev[]>();
  for (const e of events) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);
  const step = (n: number) => {
    if (mode === 'day') setAnchor(addDays(anchor, n));
    else if (mode === 'week') setAnchor(addDays(anchor, 7 * n));
    else if (mode === 'agenda') setAnchor(addDays(anchor, 28 * n));
    else {
      const d = new Date(`${anchor.slice(0, 7)}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + n);
      setAnchor(day(d));
    }
  };
  const modes =
    width === 'compact'
      ? (['agenda', 'day', 'week'] as const)
      : (['month', 'week', 'day', 'agenda'] as const);
  const title =
    mode === 'month'
      ? new Date(`${anchor.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString(undefined, {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        })
      : `${fmtDay(win.from)} – ${fmtDay(win.to)}`;
  const eventButton = (e: Ev) => (
    <li key={e.key}>
      {e.open ? (
        <button
          type="button"
          className={`calendar-event kind-${e.kind.toLowerCase()}`}
          onClick={() => onOpen(e.id)}
          aria-label={`${e.label}, ${e.kind.toLowerCase()} ${fmtDay(e.day)}${e.brand ? `, ${e.brand}` : ''}`}
        >
          <span className="event-kind">{e.kind}</span> {e.label}
        </button>
      ) : null}
      {e.open && entity === 'task' && e.kind !== 'Deadline' ? (
        <button
          type="button"
          className="button button-ghost calendar-schedule"
          onClick={() => {
            const r = rows.find((x) => x.id === e.id);
            const est = (r as { estimate_minutes?: number | null } | undefined)?.estimate_minutes;
            setSlot({ day: e.day, start: '09:00', minutes: String(est && est <= 1440 ? est : 60) });
            setScheduleError('');
            setScheduling({ id: e.id, title: e.label });
          }}
        >
          Schedule…<span className="visually-hidden"> {e.label}</span>
        </button>
      ) : null}
      {e.open ? null : e.ext ? (
        <span className="calendar-event kind-external" data-event={e.id}>
          <span className="event-kind">Calendar event:</span> {e.label}
          <span className="event-detail">, {e.ext.time}</span>
          <span className="visually-hidden">, {e.ext.calendar}</span>
        </span>
      ) : (
        <span className={`calendar-event kind-${e.kind.toLowerCase()}`}>
          <span className="event-kind">{e.kind}</span> {e.label}
        </span>
      )}
    </li>
  );
  const days: string[] = [];
  for (let d = win.from; d <= win.to; d = addDays(d, 1)) days.push(d);
  return (
    <div className="calendar-layout">
      <div className="calendar-toolbar" role="group" aria-label="Calendar navigation">
        <button type="button" className="button button-secondary" onClick={() => step(-1)}>
          Previous
        </button>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => setAnchor(localToday())}
        >
          Today
        </button>
        <button type="button" className="button button-secondary" onClick={() => step(1)}>
          Next
        </button>
        <SelectField
          id="calendar-mode"
          label="Show"
          value={modes.includes(mode as never) ? mode : modes[0]}
          onChange={(m) => setMode(m as NonNullable<Presentation['calendar_mode']>)}
          options={modes.map((m) => ({ value: m, label: titleCase(m) }))}
        />
        <fieldset className="calendar-layers">
          <legend>Show on the calendar</legend>
          <label className="choice">
            <input
              type="checkbox"
              checked={layers.primary}
              onChange={(e) => setLayers({ ...layers, primary: e.target.checked })}
            />{' '}
            {titleCase(field.replace('_date', ' dates'))}
          </label>
          {entity === 'task' && field !== 'deadline_date' ? (
            <label className="choice">
              <input
                type="checkbox"
                checked={layers.deadline}
                onChange={(e) => setLayers({ ...layers, deadline: e.target.checked })}
              />{' '}
              Deadlines
            </label>
          ) : null}
          <label className="choice">
            <input
              type="checkbox"
              checked={layers.milestones}
              onChange={(e) => setLayers({ ...layers, milestones: e.target.checked })}
            />{' '}
            Milestones
          </label>
          <label className="choice">
            <input
              type="checkbox"
              checked={layers.external}
              onChange={(e) => setLayers({ ...layers, external: e.target.checked })}
            />{' '}
            External calendar events
          </label>
        </fieldset>
      </div>
      <h3 className="calendar-title" aria-live="polite">
        {title}
      </h3>
      {mode === 'month' ? (
        <table className="calendar-month">
          <caption className="visually-hidden">{title}</caption>
          <thead>
            <tr>
              {days.slice(0, 7).map((d) => (
                <th key={d} scope="col">
                  {fmtDay(d, { weekday: 'short' })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: days.length / 7 }, (_, w) => (
              <tr key={w}>
                {days.slice(w * 7, w * 7 + 7).map((d) => {
                  const list = byDay.get(d) ?? [];
                  const outside = d.slice(0, 7) !== anchor.slice(0, 7);
                  return (
                    <td key={d} className={outside ? 'outside' : undefined}>
                      <span className="calendar-day-number">{fmtDay(d, { day: 'numeric' })}</span>
                      {width === 'medium' && list.length ? (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => {
                            setAnchor(d);
                            setMode('day');
                          }}
                        >
                          {list.length} {list.length === 1 ? 'item' : 'items'}
                        </button>
                      ) : list.length ? (
                        <ul>{list.map(eventButton)}</ul>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="calendar-days">
          {days.map((d) => {
            const list = byDay.get(d) ?? [];
            if (mode === 'agenda' && !list.length) return null;
            return (
              <section key={d} aria-labelledby={`day-${d}`} className="calendar-day">
                <h4 id={`day-${d}`}>
                  {fmtDay(d, { weekday: 'long', day: 'numeric', month: 'long' })}
                </h4>
                {list.length ? <ul>{list.map(eventButton)}</ul> : <p className="hint">Nothing.</p>}
              </section>
            );
          })}
          {mode === 'agenda' && !events.length ? (
            <p className="hint">Nothing in these four weeks.</p>
          ) : null}
        </div>
      )}
      {layers.external && external && !external.connected ? (
        <p className="hint calendar-external-none">
          No calendar connected.{' '}
          <Link to={`/workspaces/${ws}/settings/integrations`}>Connect Google Calendar</Link> to
          show your events here.
        </p>
      ) : null}
      <p className="hint">
        Schedule… adds a work block to your plan; see, move, and resize it on Today. External
        calendar events are your own, shown read-only, and visible only to you. Changing a date here
        never changes a deadline.
      </p>
      <Announce>{scheduled}</Announce>
      {scheduling ? (
        <Dialog title={`Schedule “${scheduling.title}”`} onClose={() => setScheduling(null)}>
          <p>Adds a work block to your plan. The due date and deadline do not change.</p>
          {scheduleError ? (
            <Banner tone="danger" title="Not scheduled">
              {scheduleError}
            </Banner>
          ) : null}
          <Field
            id="sched-day"
            label="Day"
            type="date"
            value={slot.day}
            required
            onChange={(ev) => setSlot({ ...slot, day: ev.target.value })}
          />
          <Field
            id="sched-start"
            label="Start"
            type="time"
            value={slot.start}
            required
            onChange={(ev) => setSlot({ ...slot, start: ev.target.value })}
          />
          <Field
            id="sched-minutes"
            label="Minutes"
            type="number"
            min={5}
            max={1440}
            value={slot.minutes}
            required
            onChange={(ev) => setSlot({ ...slot, minutes: ev.target.value })}
          />
          <div className="actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setScheduling(null)}
            >
              Cancel
            </button>
            <button type="button" className="button button-primary" onClick={() => void schedule()}>
              Schedule
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// Timeline and Gantt (RS-52, OD-12): date bars; Gantt adds dependency arrows
// -------------------------------------------------------------------------------------------------

export function TimelineLayout(props: LayoutProps & { gantt: boolean }) {
  const { ws, rows, entity, presentation, onOpen, onChanged, gantt, query, scope } = props;
  const stepUp = useStepUp();
  const zoom = presentation.zoom ?? 'week';
  const endField = entity === 'task' ? 'due_date' : 'target_date';
  const bars = rows
    .map((r) => {
      const s = dateOf(r, 'start_date');
      const e = dateOf(r, endField);
      const from = s ?? e;
      const to = e ?? s;
      return from && to ? { r, from: from <= to ? from : to, to: from <= to ? to : from } : null;
    })
    .filter((x): x is { r: QueryRow; from: string; to: string } => !!x);
  const undated = rows.filter((r) => !bars.some((b) => b.r.id === r.id));
  const [edges, setEdges] = useState<Array<{ from: string; to: string }>>([]);
  const ids = useMemo(() => bars.map((b) => b.r.id).slice(0, 200), [bars]);
  useEffect(() => {
    let live = true;
    if (!gantt || entity !== 'task' || !ids.length) return;
    layouts.dependencies(ws, { query, ids, ...(scope.length ? { scope } : {}) }).then(
      (e) => live && setEdges(e),
      () => live && setEdges([]),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, gantt, entity, JSON.stringify(ids), JSON.stringify(query)]);
  const [shifting, setShifting] = useState<{ r: QueryRow; from: string; to: string } | null>(null);
  const [days, setDays] = useState('7');
  const [withDependents, setWithDependents] = useState(false);
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  if (!bars.length)
    return (
      <div>
        <p className="hint">
          Nothing here has a start or {entity === 'task' ? 'due' : 'target'} date yet.
        </p>
        {undated.length ? <p className="hint">{undated.length} without dates.</p> : null}
      </div>
    );
  const min = bars.reduce((m, b) => (b.from < m ? b.from : m), bars[0]!.from);
  const max = bars.reduce((m, b) => (b.to > m ? b.to : m), bars[0]!.to);
  const unit = zoom === 'day' ? 1 : zoom === 'week' ? 7 : zoom === 'month' ? 30 : 91;
  const start = zoom === 'day' ? min : weekStart(min);
  const spanDays = Math.max(unit, (Date.parse(max) - Date.parse(start)) / 86_400_000 + 1);
  const ticks = Math.ceil(spanDays / unit);
  const pos = (d: string) =>
    ((Date.parse(d) - Date.parse(start)) / 86_400_000 / (ticks * unit)) * 100;
  const titleOf = new Map(rows.map((r) => [r.id, r.title]));
  const shownEdges = gantt && entity === 'task' ? edges : [];
  /** Tasks this one blocks, among those shown (dated). */
  const dependentsOf = (id: string) =>
    shownEdges
      .filter((e) => e.from === id)
      .map((e) => bars.find((b) => b.r.id === e.to)?.r)
      .filter((x): x is QueryRow => !!x);
  const shift = async () => {
    if (!shifting) return;
    const n = Number(days);
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 365)
      return setError('Enter a whole number of days (not 0).');
    const r = shifting.r;
    const shiftOne = async (x: QueryRow) => {
      const changes: Record<string, { base: unknown; value: unknown }> = {};
      for (const f of ['start_date', endField]) {
        const v = dateOf(x, f);
        if (v) changes[f] = { base: v, value: addDays(v, n) };
      }
      if (entity === 'task') await tasks.update(ws, x.id, x.version, changes, stepUp);
      else await projects.update(ws, x.id, x.version, changes, stepUp);
    };
    try {
      await shiftOne(r);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled')) setError(describe(err));
      return;
    }
    // Dependency-aware rescheduling (OD-12): only when chosen, one task at a time, reported.
    const failed: string[] = [];
    let moved = 0;
    if (gantt && withDependents)
      for (const d of dependentsOf(r.id)) {
        try {
          await shiftOne(d);
          moved++;
        } catch {
          failed.push(d.title);
        }
      }
    setShifting(null);
    setSaid(
      `${r.title} moved ${Math.abs(n)} days ${n > 0 ? 'later' : 'earlier'}.` +
        (moved ? ` ${moved} blocked ${moved === 1 ? 'task' : 'tasks'} moved with it.` : '') +
        (failed.length ? ` Not moved: ${failed.join(', ')}.` : '') +
        ' The deadline did not change.',
    );
    onChanged();
  };
  return (
    <div className="timeline-layout">
      {said ? <Announce>{said}</Announce> : null}
      <div className="timeline-scale" aria-hidden="true">
        {Array.from({ length: ticks }, (_, i) => (
          <span key={i} style={{ left: `${(i / ticks) * 100}%` }}>
            {fmtDay(
              addDays(start, i * unit),
              zoom === 'quarter' || zoom === 'month'
                ? { month: 'short', day: 'numeric' }
                : { day: 'numeric', month: 'short' },
            )}
          </span>
        ))}
      </div>
      <ul className="timeline-rows">
        {bars.map((b) => {
          const blocks = edges
            .filter((e) => e.from === b.r.id)
            .map((e) => titleOf.get(e.to) ?? 'a task');
          const blockedBy = edges
            .filter((e) => e.to === b.r.id)
            .map((e) => titleOf.get(e.from) ?? 'a task');
          return (
            <li key={b.r.id} className="timeline-row" data-anchor-id={b.r.id}>
              <span className="timeline-label">
                <OpenButton id={b.r.id} title={b.r.title} onOpen={onOpen} />
              </span>
              <span className="timeline-track">
                <button
                  type="button"
                  className="timeline-bar"
                  style={{
                    left: `${pos(b.from)}%`,
                    width: `max(0.5rem, ${pos(addDays(b.to, 1)) - pos(b.from)}%)`,
                  }}
                  aria-label={`${b.r.title}: ${fmtDay(b.from)} to ${fmtDay(b.to)}. Change dates`}
                  onClick={() => {
                    setError('');
                    setDays('7');
                    setWithDependents(false);
                    setShifting(b);
                  }}
                />
              </span>
              <span className="timeline-dates hint">
                {fmtDay(b.from)} – {fmtDay(b.to)}
                {gantt && blocks.length ? ` · blocks ${blocks.join(', ')}` : ''}
                {gantt && blockedBy.length ? ` · blocked by ${blockedBy.join(', ')}` : ''}
              </span>
            </li>
          );
        })}
      </ul>
      {undated.length ? (
        <p className="hint">{undated.length} without dates are not shown.</p>
      ) : null}
      {gantt ? (
        <p className="hint">
          Gantt shows the “blocks” dependencies between the items shown, and moving a task can move
          the tasks it blocks when you choose to. Baseline versus actual arrives with reporting
          (5C).
        </p>
      ) : null}
      {shifting ? (
        <Dialog title={`Change dates of “${shifting.r.title}”`} onClose={() => setShifting(null)}>
          <p>
            Moves the start and {entity === 'task' ? 'due' : 'target'} dates together. The deadline
            never changes here.
          </p>
          {error ? (
            <Banner tone="danger" title="Not changed">
              {error}
            </Banner>
          ) : null}
          <Field
            id="shift-days"
            label="Move by days (negative for earlier)"
            type="number"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
          {gantt && dependentsOf(shifting.r.id).length ? (
            <label className="choice">
              <input
                type="checkbox"
                checked={withDependents}
                onChange={(e) => setWithDependents(e.target.checked)}
              />{' '}
              Also move the {dependentsOf(shifting.r.id).length} task
              {dependentsOf(shifting.r.id).length === 1 ? '' : 's'} it blocks (
              {dependentsOf(shifting.r.id)
                .map((d) => d.title)
                .join(', ')}
              ) by the same days
            </label>
          ) : null}
          <div className="actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setShifting(null)}
            >
              Cancel
            </button>
            <button type="button" className="button button-primary" onClick={() => void shift()}>
              Move dates
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// Workload (RS-55, VIEW-007, TIME-009): person × day/week/month from the view's tasks
// -------------------------------------------------------------------------------------------------

export function WorkloadLayout({ ws, query, scope, presentation }: LayoutProps) {
  const bucket = presentation.bucket ?? 'week';
  const [from, setFrom] = useState(() => weekStart(localToday()));
  const span = bucket === 'day' ? 13 : bucket === 'week' ? 55 : 180;
  const to = addDays(from, span);
  const [data, setData] = useState<Awaited<ReturnType<typeof layouts.workload>> | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    layouts.workload(ws, { query, bucket, from, to, ...(scope.length ? { scope } : {}) }).then(
      (d) => live && (setData(d), setError(null)),
      (e: unknown) => live && setError(e),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, JSON.stringify(query), bucket, from, JSON.stringify(scope)]);
  const label = (b: string) =>
    bucket === 'month'
      ? new Date(`${b}T00:00:00Z`).toLocaleDateString(undefined, {
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC',
        })
      : bucket === 'week'
        ? `Week of ${fmtDay(b, { day: 'numeric', month: 'short' })}`
        : fmtDay(b);
  return (
    <div className="workload-layout">
      <div className="actions" role="group" aria-label="Workload range">
        <button
          type="button"
          className="button button-secondary"
          onClick={() => setFrom(addDays(from, -(span + 1)))}
        >
          Earlier
        </button>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => setFrom(weekStart(localToday()))}
        >
          This week
        </button>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => setFrom(addDays(from, span + 1))}
        >
          Later
        </button>
      </div>
      {error ? (
        <Banner tone="danger" title="Workload can't be shown">
          {describe(error)}
        </Banner>
      ) : null}
      {data ? (
        data.people.length ? (
          <div className="view-results" role="region" aria-label="Workload grid" tabIndex={0}>
            <table className="view-table workload-table">
              <caption>
                Open work by due date, {fmtDay(from)} – {fmtDay(to)} (remaining estimates)
              </caption>
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  {data.buckets.map((b) => (
                    <th key={b} scope="col">
                      {label(b)}
                    </th>
                  ))}
                  <th scope="col">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => (
                  <tr key={p.id ?? 'none'}>
                    <th scope="row">{p.name}</th>
                    {data.buckets.map((b) => {
                      const c = p.cells[b];
                      const cap = p.capacity?.[b];
                      return (
                        <td key={b} className={cap?.over ? 'workload-over' : undefined}>
                          {c ? (
                            <>
                              {hours(c.minutes)}
                              <span className="hint">
                                {' '}
                                · {c.tasks} {c.tasks === 1 ? 'task' : 'tasks'}
                                {c.unestimated ? `, ${c.unestimated} unestimated` : ''}
                              </span>
                            </>
                          ) : (
                            <span className="hint">—</span>
                          )}
                          {cap ? (
                            <span className="workload-capacity">
                              {' '}
                              of {hours(cap.available)}
                              {cap.over ? <strong> · {hours(cap.over)} over</strong> : null}
                            </span>
                          ) : null}
                        </td>
                      );
                    })}
                    <td>{hours(p.total_minutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="hint">No open work is due in this range.</p>
        )
      ) : null}
      <p className="hint">
        “of” shows available time from working hours and time off, where you may see it; over-
        allocation is a warning and nothing is moved.
      </p>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// Milestones and Portfolio (project views)
// -------------------------------------------------------------------------------------------------

export function MilestonesLayout({ ws, rows, query, scope, onOpen }: LayoutProps) {
  const [ms, setMs] = useState<Awaited<ReturnType<typeof layouts.milestones>> | null>(null);
  const ids = rows.map((r) => r.id).slice(0, 200);
  useEffect(() => {
    let live = true;
    layouts.milestones(ws, { query, ids, ...(scope.length ? { scope } : {}) }).then(
      (m) => live && setMs(m),
      () => live && setMs([]),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, JSON.stringify(ids), JSON.stringify(query)]);
  if (!ms) return <p role="status">Loading milestones…</p>;
  return (
    <div className="milestones-layout">
      {rows.map((r) => {
        const list = ms.filter((m) => m.project === r.id);
        return (
          <section key={r.id} aria-labelledby={`ms-${r.id}`} data-anchor-id={r.id}>
            <h3 id={`ms-${r.id}`}>
              <OpenButton id={r.id} title={r.title} onOpen={onOpen} />
            </h3>
            {list.length ? (
              <ol className="milestone-list">
                {list.map((m) => (
                  <li key={m.id}>
                    <span>{m.name}</span>{' '}
                    <span className="hint">
                      {m.due_date ? fmtDay(m.due_date) : 'No date'} · {titleCase(m.status)}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="hint">No milestones.</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function PortfolioLayout({ ws, rows, query, scope, onOpen }: LayoutProps) {
  const [progress, setProgress] = useState<
    Map<string, { percent: number | null; done: number; total: number }>
  >(new Map());
  const ids = rows.map((r) => r.id).slice(0, 200);
  useEffect(() => {
    let live = true;
    layouts.progress(ws, { query, ids, ...(scope.length ? { scope } : {}) }).then(
      (p) => live && setProgress(new Map(p.map((x) => [x.project, x]))),
      () => undefined,
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, JSON.stringify(ids), JSON.stringify(query)]);
  // Grouped by brand when several brands are shown, else by status (IA portfolio rule).
  const brands = new Set(rows.map((r) => r.brand.id));
  const keyOf = (r: QueryRow) => (brands.size > 1 ? r.brand.name : r.status.name);
  const groups = [...new Set(rows.map(keyOf))];
  return (
    <div className="portfolio-layout">
      {groups.map((g) => (
        <section key={g} aria-labelledby={`pf-${g}`}>
          <h3 id={`pf-${g}`} className="group-heading">
            {g}
          </h3>
          <ul className="portfolio-cards">
            {rows
              .filter((r) => keyOf(r) === g)
              .map((r) => {
                const p = progress.get(r.id);
                return (
                  <li key={r.id} className="portfolio-card" data-anchor-id={r.id}>
                    <OpenButton id={r.id} title={r.title} onOpen={onOpen} />
                    <dl>
                      <div>
                        <dt>Health</dt>
                        <dd>{r.health ? titleCase(String(r.health)) : 'Not set'}</dd>
                      </div>
                      <div>
                        <dt>Progress</dt>
                        <dd>
                          {p?.percent !== null && p?.percent !== undefined
                            ? `${p.percent}% (${p.done} of ${p.total} tasks)`
                            : 'No tasks'}
                        </dd>
                      </div>
                      <div>
                        <dt>Target</dt>
                        <dd>
                          {dateOf(r, 'target_date') ? fmtDay(dateOf(r, 'target_date')!) : 'None'}
                        </dd>
                      </div>
                      <div>
                        <dt>Status</dt>
                        <dd>{r.status.name}</dd>
                      </div>
                    </dl>
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// Activity (VIEW-010; AUD-005 contribution) and Timesheet (VIEW-011)
// -------------------------------------------------------------------------------------------------

export function ActivityLayout({ ws, entity, query, scope, onOpen }: LayoutProps) {
  const [filters, setFilters] = useState<{ actor?: string; actor_type?: string; action?: string }>(
    {},
  );
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const id = useId();
  const load = (after?: string) =>
    layouts
      .activity(ws, entity, {
        query,
        ...(scope.length ? { scope } : {}),
        ...filters,
        ...(after ? { cursor: after } : {}),
        limit: 50,
      })
      .then(
        (r) => {
          setError(null);
          setItems((prev) => (after ? [...(prev ?? []), ...r.items] : r.items));
          setCursor(r.page.has_more ? r.page.next_cursor : undefined);
          setTruncated(r.records_truncated);
        },
        (e: unknown) => setError(e),
      );
  const runKey = JSON.stringify([ws, entity, query, filters, scope]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(), [runKey]);
  const set = (k: 'actor' | 'actor_type' | 'action', v: string) => {
    const next = { ...filters };
    if (v) next[k] = v;
    else delete next[k];
    setFilters(next);
  };
  return (
    <div className="activity-layout">
      <div className="activity-filters" role="group" aria-label="Filter activity">
        <SelectField
          id={`${id}-who`}
          label="By"
          value={filters.actor ?? ''}
          onChange={(v) => set('actor', v)}
          options={[
            { value: '', label: 'Anyone' },
            { value: 'me', label: 'Me' },
          ]}
        />
        <SelectField
          id={`${id}-type`}
          label="Actor type"
          value={filters.actor_type ?? ''}
          onChange={(v) => set('actor_type', v)}
          options={[
            { value: '', label: 'Any' },
            { value: 'human', label: 'People' },
            { value: 'agent', label: 'Agents' },
            { value: 'integration', label: 'Integrations' },
            { value: 'system', label: 'System' },
          ]}
        />
        <SelectField
          id={`${id}-action`}
          label="Action"
          value={filters.action ?? ''}
          onChange={(v) => set('action', v)}
          options={[
            { value: '', label: 'Any' },
            { value: entity, label: titleCase(`${entity} changes`) },
            { value: 'record', label: 'Lifecycle' },
            { value: 'access', label: 'Sharing and access' },
          ]}
        />
      </div>
      {error ? (
        <Banner tone="danger" title="Activity can't be shown">
          {describe(error)}
        </Banner>
      ) : null}
      {truncated ? (
        <p className="hint">
          Showing activity for the first records in this view. Narrow the view to see more.
        </p>
      ) : null}
      {items === null ? (
        <p role="status">Loading activity…</p>
      ) : items.length ? (
        <ol className="activity-feed">
          {items.map((e) => (
            <li key={e.key}>
              <p>
                <strong>{e.actor.name ?? titleCase(e.actor.type)}</strong> ·{' '}
                {titleCase(e.action.split('.').slice(1).join(' ') || e.action)} ·{' '}
                <OpenButton id={e.record.id} title={e.record.title} onOpen={onOpen} />
              </p>
              {e.changes.length ? (
                <ul className="hint">
                  {e.changes.slice(0, 5).map((c, i) => (
                    <li key={i}>
                      {titleCase(c.field.replace(/^fields\./, 'field '))}
                      {c.changed
                        ? ' changed'
                        : `: ${String(c.from ?? '—')} → ${String(c.to ?? '—')}`}
                    </li>
                  ))}
                </ul>
              ) : null}
              <time className="hint" dateTime={e.at}>
                {new Date(e.at).toLocaleString()}
              </time>
            </li>
          ))}
        </ol>
      ) : (
        <p className="hint">No activity for these records.</p>
      )}
      {cursor ? (
        <button type="button" className="button button-secondary" onClick={() => void load(cursor)}>
          Show older activity
        </button>
      ) : null}
    </div>
  );
}

export function TimesheetLayout({ ws, rows, query, scope, onOpen }: LayoutProps) {
  const [from, setFrom] = useState(() => weekStart(localToday()));
  const [data, setData] = useState<Awaited<ReturnType<typeof layouts.myTime>> | null>(null);
  const ids = rows.map((r) => r.id).slice(0, 200);
  useEffect(() => {
    let live = true;
    layouts.myTime(ws, { query, ids, from, days: 7, ...(scope.length ? { scope } : {}) }).then(
      (d) => live && setData(d),
      () => live && setData({ days: [], cells: [] }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, JSON.stringify(ids), JSON.stringify(query), from]);
  const cell = (task: string, d: string) =>
    data?.cells.find((c) => c.task === task && c.day === d)?.minutes ?? 0;
  const days = data?.days ?? [];
  return (
    <div className="timesheet-layout">
      <div className="actions" role="group" aria-label="Week">
        <button
          type="button"
          className="button button-secondary"
          onClick={() => setFrom(addDays(from, -7))}
        >
          Previous week
        </button>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => setFrom(weekStart(localToday()))}
        >
          This week
        </button>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => setFrom(addDays(from, 7))}
        >
          Next week
        </button>
        <Link className="button button-secondary" to={routeHref('time', { ws })}>
          Log time
        </Link>
      </div>
      <div className="view-results" role="region" aria-label="My time on these tasks" tabIndex={0}>
        <table className="view-table">
          <caption>My time, week of {fmtDay(from)}</caption>
          <thead>
            <tr>
              <th scope="col">Task</th>
              {days.map((d) => (
                <th key={d} scope="col">
                  {fmtDay(d)}
                </th>
              ))}
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const total = days.reduce((n, d) => n + cell(r.id, d), 0);
              return (
                <tr key={r.id} data-anchor-id={r.id}>
                  <th scope="row">
                    <OpenButton id={r.id} title={r.title} onOpen={onOpen} />
                  </th>
                  {days.map((d) => (
                    <td key={d}>
                      {cell(r.id, d) ? hours(cell(r.id, d)) : <span className="hint">—</span>}
                    </td>
                  ))}
                  <td>{total ? hours(total) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hint">Logging, submitting, and approving time stay on the Time page.</p>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// Detail panel (VIEW-023, RS-32): opens over the view without losing its state
// -------------------------------------------------------------------------------------------------

export function DetailPanel({
  ws,
  entity,
  id,
  onClose,
}: {
  ws: string;
  entity: Entity;
  id: string;
  onClose: () => void;
}) {
  const [rec, setRec] = useState<Record<string, unknown> | null>(null);
  const [failed, setFailed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);
  useEffect(() => {
    let live = true;
    (entity === 'task' ? tasks.get(ws, id) : projects.get(ws, id)).then(
      (r) => live && setRec(r as unknown as Record<string, unknown>),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [ws, id, entity]);
  useEffect(() => {
    if (rec || failed) heading.current?.focus();
  }, [rec, failed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const title = rec ? String(rec.title ?? rec.name ?? '') : failed ? 'Not available' : 'Loading…';
  const href =
    entity === 'task' ? routeHref('task', { ws, tsk: id }) : routeHref('project', { ws, prj: id });
  const status = rec?.status as { name?: string } | undefined;
  const brand = rec?.brand as { name?: string } | undefined;
  const rows: Array<[string, ReactNode]> = rec
    ? [
        ['Status', status?.name ?? ''],
        ['Priority', titleCase(String(rec.priority ?? ''))],
        ['Brand', brand?.name ?? ''],
        [
          entity === 'task' ? 'Due' : 'Target',
          String((entity === 'task' ? rec.due_date : rec.target_date) ?? 'None'),
        ],
        ['Deadline', String(rec.deadline_date ?? 'None')],
      ]
    : [];
  return (
    <aside className="detail-panel" aria-labelledby="detail-title">
      <div className="detail-panel-head">
        <h2 id="detail-title" ref={heading} tabIndex={-1}>
          {title}
        </h2>
        <button
          type="button"
          className="button button-secondary"
          onClick={onClose}
          aria-label="Close details"
        >
          Close
        </button>
      </div>
      {failed ? (
        <p>This isn’t available to you.</p>
      ) : rec ? (
        <>
          <dl className="detail-facts">
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <Link className="button button-primary" to={href}>
            Open full page
          </Link>
        </>
      ) : (
        <p role="status">Loading…</p>
      )}
    </aside>
  );
}

/** Opens the detail panel through the URL (`item=`), pushed so Back closes it (RS-21). */
export function useItemParam(): [string | null, (id: string | null) => void] {
  const { search, path, navigate, state } = useRouter();
  const item = search.get('item');
  const set = (id: string | null) => {
    const q = new URLSearchParams(window.location.search);
    if (id) q.set('item', id);
    else q.delete('item');
    const qs = q.toString();
    navigate(`${path}${qs ? `?${qs}` : ''}`, id ? { state } : { replace: true, state });
  };
  return [item && /^(tsk|prj)_[0-9A-HJKMNP-TV-Z]{26}$/.test(item) ? item : null, set];
}
