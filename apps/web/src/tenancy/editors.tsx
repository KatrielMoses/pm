import { useId } from 'react';
import type { Priorities, WorkingHours } from './client.ts';
import { WEEKDAYS } from './client.ts';

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const HHMM_END = /^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$/;

/** Editor state: every weekday, open or closed, with ordered ranges (strings as typed). */
export interface HoursDraft {
  days: Array<{ weekday: number; open: boolean; ranges: Array<{ start: string; end: string }> }>;
}

export function hoursDraft(value: WorkingHours): HoursDraft {
  return {
    days: WEEKDAYS.map((_, i) => {
      const day = value.days.find((d) => d.weekday === i + 1);
      return {
        weekday: i + 1,
        open: Boolean(day && day.ranges.length),
        ranges:
          day && day.ranges.length
            ? day.ranges.map((r) => ({ ...r }))
            : [{ start: '09:00', end: '17:00' }],
      };
    }),
  };
}

export const rangeId = (weekday: number, index: number, part: 'start' | 'end') =>
  `hours-${weekday}-${index}-${part}`;

/** Client-side mirror of the server rules; the server validates again. Errors keyed by input ID. */
export function validateHours(draft: HoursDraft): {
  value: WorkingHours;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  const days: WorkingHours['days'] = [];
  for (const d of draft.days) {
    if (!d.open) continue;
    const ranges = d.ranges.map((r, i) => ({ ...r, i }));
    for (const r of ranges) {
      if (!HHMM.test(r.start))
        errors[rangeId(d.weekday, r.i, 'start')] = 'Use a 24-hour time like 09:00.';
      else if (!HHMM_END.test(r.end))
        errors[rangeId(d.weekday, r.i, 'end')] =
          'Use a 24-hour time like 17:30, or 24:00 for midnight.';
      else if (r.start >= r.end)
        errors[rangeId(d.weekday, r.i, 'end')] = 'The end time must be after the start time.';
    }
    const sorted = [...ranges].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    for (let k = 1; k < sorted.length; k++)
      if (
        sorted[k]!.start < sorted[k - 1]!.end &&
        !errors[rangeId(d.weekday, sorted[k]!.i, 'start')]
      )
        errors[rangeId(d.weekday, sorted[k]!.i, 'start')] =
          `This range overlaps another range on ${WEEKDAYS[d.weekday - 1]}.`;
    days.push({ weekday: d.weekday, ranges: sorted.map(({ start, end }) => ({ start, end })) });
  }
  return { value: { schema_version: 1, days }, errors };
}

/**
 * Working-hours editor (WSB-010): a fieldset per weekday, closed-day support, up to four ranges a
 * day, keyboard operable with native controls, and an explicit statement of the time zone.
 */
export function WorkingHoursEditor({
  draft,
  onChange,
  timezone,
  errors,
}: {
  draft: HoursDraft;
  onChange: (next: HoursDraft) => void;
  timezone: string;
  errors: Record<string, string>;
}) {
  const update = (
    weekday: number,
    fn: (d: HoursDraft['days'][number]) => HoursDraft['days'][number],
  ) => onChange({ days: draft.days.map((d) => (d.weekday === weekday ? fn(d) : d)) });
  return (
    <div className="hours">
      <p className="hint">
        Times are local to this brand's time zone, <strong>{timezone}</strong>, and use the 24-hour
        clock. Use 24:00 for midnight at the end of a day. Changing the brand's time zone keeps
        these local times.
      </p>
      {draft.days.map((d) => {
        const day = WEEKDAYS[d.weekday - 1]!;
        return (
          <fieldset key={d.weekday} className="hours-day">
            <legend>{day}</legend>
            <label className="choice">
              <input
                type="checkbox"
                checked={d.open}
                onChange={(e) => update(d.weekday, (x) => ({ ...x, open: e.target.checked }))}
              />
              Open on {day}
            </label>
            {d.open ? (
              <ol className="hours-ranges" aria-label={`${day} time ranges`}>
                {d.ranges.map((r, i) => (
                  <li key={i} className="hours-range">
                    {(['start', 'end'] as const).map((part) => {
                      const id = rangeId(d.weekday, i, part);
                      const err = errors[id];
                      return (
                        <div key={part} className={err ? 'field field-invalid' : 'field'}>
                          <label htmlFor={id}>
                            {part === 'start' ? 'From' : 'To'}{' '}
                            <span className="visually-hidden">
                              ({day}, range {i + 1})
                            </span>
                          </label>
                          {err ? (
                            <p className="field-error" id={`${id}-error`}>
                              <span aria-hidden="true">! </span>
                              {err}
                            </p>
                          ) : null}
                          <input
                            id={id}
                            inputMode="numeric"
                            autoComplete="off"
                            placeholder="HH:MM"
                            size={6}
                            value={r[part]}
                            aria-invalid={err ? true : undefined}
                            aria-describedby={err ? `${id}-error` : undefined}
                            onChange={(e) =>
                              update(d.weekday, (x) => ({
                                ...x,
                                ranges: x.ranges.map((y, j) =>
                                  j === i ? { ...y, [part]: e.target.value } : y,
                                ),
                              }))
                            }
                          />
                        </div>
                      );
                    })}
                    {d.ranges.length > 1 ? (
                      <button
                        type="button"
                        className="button button-ghost"
                        onClick={() =>
                          update(d.weekday, (x) => ({
                            ...x,
                            ranges: x.ranges.filter((_, j) => j !== i),
                          }))
                        }
                      >
                        Remove range {i + 1} <span className="visually-hidden">on {day}</span>
                      </button>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="hint">Closed</p>
            )}
            {d.open && d.ranges.length < 4 ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() =>
                  update(d.weekday, (x) => ({
                    ...x,
                    ranges: [...x.ranges, { start: '', end: '' }],
                  }))
                }
              >
                Add a time range <span className="visually-hidden">on {day}</span>
              </button>
            ) : null}
          </fieldset>
        );
      })}
    </div>
  );
}

export const priorityId = (i: number) => `priority-${i}-text`;

export function validatePriorities(value: Priorities): Record<string, string> {
  const errors: Record<string, string> = {};
  value.entries.forEach((e, i) => {
    const t = e.text.trim();
    if (!t) errors[priorityId(i)] = 'Enter some text, or remove this entry.';
    else if ([...t].length > 280) errors[priorityId(i)] = 'Use at most 280 characters.';
  });
  return errors;
}

/**
 * Bounded goals/priorities list (WSB-011 foundation): at most 10 short entries, reorderable by
 * keyboard. These are planning notes for the brand; goal tracking is a later phase.
 */
export function PrioritiesEditor({
  value,
  onChange,
  errors,
}: {
  value: Priorities;
  onChange: (next: Priorities) => void;
  errors: Record<string, string>;
}) {
  const listId = useId();
  const set = (entries: Priorities['entries']) => onChange({ schema_version: 1, entries });
  const move = (i: number, by: number) => {
    const next = [...value.entries];
    const [item] = next.splice(i, 1);
    next.splice(i + by, 0, item!);
    set(next);
  };
  return (
    <div className="priorities">
      <p className="hint" id={`${listId}-hint`}>
        Short notes about what matters most for this brand, in order. Up to 10. They don't track
        progress; goal tracking arrives in a later release.
      </p>
      {value.entries.length ? (
        <ol className="priority-list" aria-describedby={`${listId}-hint`}>
          {value.entries.map((e, i) => {
            const id = priorityId(i);
            const err = errors[id];
            return (
              <li key={i} className="priority">
                <div className="field">
                  <label htmlFor={`priority-${i}-kind`}>Type of entry {i + 1}</label>
                  <select
                    id={`priority-${i}-kind`}
                    value={e.kind}
                    onChange={(ev) =>
                      set(
                        value.entries.map((x, j) =>
                          j === i ? { ...x, kind: ev.target.value as 'goal' | 'priority' } : x,
                        ),
                      )
                    }
                  >
                    <option value="priority">Priority</option>
                    <option value="goal">Goal</option>
                  </select>
                </div>
                <div className={err ? 'field field-invalid' : 'field'}>
                  <label htmlFor={id}>Entry {i + 1}</label>
                  {err ? (
                    <p className="field-error" id={`${id}-error`}>
                      <span aria-hidden="true">! </span>
                      {err}
                    </p>
                  ) : null}
                  <input
                    id={id}
                    value={e.text}
                    maxLength={280}
                    aria-invalid={err ? true : undefined}
                    aria-describedby={err ? `${id}-error` : undefined}
                    onChange={(ev) =>
                      set(
                        value.entries.map((x, j) =>
                          j === i ? { ...x, text: ev.target.value } : x,
                        ),
                      )
                    }
                  />
                </div>
                <div className="actions actions-compact">
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    Move up <span className="visually-hidden">entry {i + 1}</span>
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={i === value.entries.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    Move down <span className="visually-hidden">entry {i + 1}</span>
                  </button>
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={() => set(value.entries.filter((_, j) => j !== i))}
                  >
                    Remove <span className="visually-hidden">entry {i + 1}</span>
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="empty">No goals or priorities yet.</p>
      )}
      <p className="hint">{value.entries.length} of 10 used.</p>
      {value.entries.length < 10 ? (
        <button
          type="button"
          className="button button-secondary"
          onClick={() => set([...value.entries, { kind: 'priority', text: '' }])}
        >
          Add an entry
        </button>
      ) : null}
    </div>
  );
}
