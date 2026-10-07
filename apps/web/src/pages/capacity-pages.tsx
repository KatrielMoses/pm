import { useState, type FormEvent } from 'react';
import { ApiError } from '../api.ts';
import {
  capacity,
  hours,
  WEEKDAY_NAMES,
  type Capacity,
  type CapacityProfile,
  type Conflict,
  type TimeOff,
} from '../capacity/client.ts';
import { useWorkspaceShell } from '../shell/workspace.tsx';
import { useStepUp } from '../stepup.tsx';
import { ResourceView, useResource } from '../tenancy/resource.tsx';
import { Announce, Banner } from '../ui/feedback.tsx';
import { Field, SelectField } from '../ui/form.tsx';
import { Page } from '../ui/layout.tsx';
import { views } from '../views/client.ts';

/**
 * Phase 3E capacity (0E Phase 3E note, ADR-0022): the person's working hours in their own zone,
 * weekly capacity, and time off; this week's availability against scheduled and estimated work by
 * day and brand (founder capacity across brands) with over/under allocation and cross-brand
 * conflicts; the team's allocation where the person may see it; and brand reservations and
 * holidays for those who manage them. Every figure is limited to what the person can read, and
 * nothing here moves work: over-allocation is a warning.
 */

const describe = (err: unknown, fallback = 'That did not work. Try again.') =>
  err instanceof ApiError
    ? err.code === 'offline' || err.code === 'network'
      ? "You're offline. Nothing was saved; try again when you're back."
      : err.code === 'conflict'
        ? 'Someone changed this first. Reload to see the latest, then try again.'
        : (err.issues[0]?.message ?? fallback)
    : fallback;

const localDay = (d = new Date()) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const shiftDay = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return localDay(d);
};
const mondayOf = (day: string) => {
  const wd = new Date(`${day}T12:00:00`).getDay() || 7;
  return shiftDay(day, 1 - wd);
};
const dayLabel = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
const STATE_TEXT = { over: 'Over', under: 'Under', ok: 'OK' } as const;
const KIND_TEXT: Record<TimeOff['kind'], string> = {
  vacation: 'Vacation',
  sick: 'Sick',
  personal: 'Personal',
  holiday: 'Holiday',
  unavailable: 'Unavailable',
};

const conflictText = (c: Conflict) =>
  c.kind === 'overlap'
    ? `${c.brands.join(' and ')} overlap for ${hours(c.minutes)} at ${new Date(c.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.`
    : `${c.brand} reserves ${hours(c.reserved_minutes)} but only ${hours(c.room_minutes)} is left after other brands.`;

export function CapacityPage({ ws }: { ws: string }) {
  const [week, setWeek] = useState(mondayOf(localDay()));
  const [nonce, setNonce] = useState(0);
  const [said, setSaid] = useState('');
  const changed = (msg: string) => {
    setSaid(msg);
    setNonce((n) => n + 1);
  };
  const profile = useResource(() => capacity.profile(ws), `capp:${ws}:${nonce}`);
  const mine = useResource(
    () => capacity.mine(ws, week, shiftDay(week, 6)),
    `capm:${ws}:${week}:${nonce}`,
  );
  return (
    <Page title="Capacity" wide>
      <p className="hint">
        Working hours, time off, and planned work for each brand. Over-allocation is a warning:
        nothing is moved for you.
      </p>
      <ResourceView resource={profile.state} onRetry={profile.retry} what="working hours">
        {(p) => <WorkingHours ws={ws} profile={p} onSaved={changed} />}
      </ResourceView>
      <section className="card" aria-labelledby="week-h">
        <h2 id="week-h">Week of {dayLabel(week)}</h2>
        <div className="actions-compact" role="group" aria-label="Week">
          <button
            type="button"
            className="button button-ghost"
            onClick={() => setWeek(shiftDay(week, -7))}
          >
            Previous week
          </button>
          <button
            type="button"
            className="button button-ghost"
            onClick={() => setWeek(mondayOf(localDay()))}
          >
            This week
          </button>
          <button
            type="button"
            className="button button-ghost"
            onClick={() => setWeek(shiftDay(week, 7))}
          >
            Next week
          </button>
        </div>
        <ResourceView resource={mine.state} onRetry={mine.retry} what="capacity">
          {(c) => <WeekCapacity c={c} />}
        </ResourceView>
      </section>
      <TimeOffSection ws={ws} nonce={nonce} onChanged={changed} />
      <TeamSection ws={ws} week={week} nonce={nonce} />
      <BrandSection ws={ws} nonce={nonce} onChanged={changed} />
      <Announce>{said}</Announce>
    </Page>
  );
}

function WorkingHours({
  ws,
  profile,
  onSaved,
}: {
  ws: string;
  profile: CapacityProfile;
  onSaved: (msg: string) => void;
}) {
  const stepUp = useStepUp();
  const initial = WEEKDAY_NAMES.map((_, i) => {
    const w = profile.windows.find((x) => x.weekday === i + 1);
    return { on: !!w, start: w?.start ?? '09:00', end: w?.end ?? '17:00' };
  });
  const [days, setDays] = useState(initial);
  const [weekly, setWeekly] = useState(
    profile.weekly_capacity_minutes === null ? '' : String(profile.weekly_capacity_minutes / 60),
  );
  const [observe, setObserve] = useState(profile.observe_brand_holidays);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const extra =
    profile.windows.length >
    profile.windows.filter((w, i, a) => a.findIndex((x) => x.weekday === w.weekday) === i).length;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await capacity.setProfile(
        ws,
        profile.version,
        {
          windows: days.flatMap((d, i) =>
            d.on ? [{ weekday: i + 1, start: d.start, end: d.end }] : [],
          ),
          weekly_capacity_minutes: weekly.trim() === '' ? null : Math.round(Number(weekly) * 60),
          observe_brand_holidays: observe,
        },
        stepUp,
      );
      onSaved('Working hours saved.');
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="hours-h">
      <h2 id="hours-h">My working hours</h2>
      <p className="hint">
        In your zone ({profile.timezone}). {hours(profile.nominal_week_minutes)} a week
        {profile.weekly_capacity_minutes !== null
          ? `, counted as ${hours(profile.weekly_capacity_minutes)}`
          : ''}
        .
      </p>
      {extra ? (
        <Banner tone="info" title="Split days">
          Some days have more than one window; saving here keeps one window per day.
        </Banner>
      ) : null}
      {error ? (
        <Banner tone="danger" title="Not saved">
          {error}
        </Banner>
      ) : null}
      <form onSubmit={save}>
        <fieldset className="capacity-hours">
          <legend>Days and times</legend>
          {days.map((d, i) => (
            <div key={i} className="capacity-day">
              <label>
                <input
                  type="checkbox"
                  checked={d.on}
                  onChange={(e) =>
                    setDays(days.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))
                  }
                />{' '}
                {WEEKDAY_NAMES[i]}
              </label>
              <label>
                <span className="visually-hidden">{WEEKDAY_NAMES[i]} starts</span>
                <input
                  type="time"
                  value={d.start}
                  disabled={!d.on}
                  onChange={(e) =>
                    setDays(days.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))
                  }
                />
              </label>
              <span aria-hidden="true">–</span>
              <label>
                <span className="visually-hidden">{WEEKDAY_NAMES[i]} ends</span>
                <input
                  type="time"
                  value={d.end}
                  disabled={!d.on}
                  onChange={(e) =>
                    setDays(days.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))
                  }
                />
              </label>
            </div>
          ))}
        </fieldset>
        <Field
          id="cap-weekly"
          label="Weekly capacity in hours (optional)"
          hint="Leave empty to count every working hour. A lower number scales each day."
          inputMode="decimal"
          value={weekly}
          onChange={(e) => setWeekly(e.target.value)}
        />
        <label className="choice">
          <input type="checkbox" checked={observe} onChange={(e) => setObserve(e.target.checked)} />{' '}
          Take brand holidays off (for brands I am reserved for)
        </label>
        <div className="actions">
          <button type="submit" className="button button-primary" disabled={busy} aria-busy={busy}>
            Save working hours
          </button>
        </div>
      </form>
    </section>
  );
}

function WeekCapacity({ c }: { c: Capacity }) {
  return (
    <>
      <p>
        {hours(c.totals.available_minutes)} available · {hours(c.totals.scheduled_minutes)}{' '}
        scheduled · {hours(c.totals.estimated_minutes)} estimated ·{' '}
        <strong>
          {c.totals.state === 'over'
            ? `${hours(c.totals.over)} over`
            : c.totals.state === 'under'
              ? `${hours(c.totals.under)} free`
              : 'within capacity'}
        </strong>
      </p>
      {c.conflicts.length ? (
        <Banner
          tone="warning"
          title={`${c.conflicts.length} conflict${c.conflicts.length === 1 ? '' : 's'}`}
        >
          <ul>
            {c.conflicts.map((x, i) => (
              <li key={i}>{conflictText(x)}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      <div className="table-scroll" role="region" aria-label="Capacity by day" tabIndex={0}>
        <table className="table">
          <caption className="visually-hidden">Capacity by day</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Available</th>
              <th scope="col">Scheduled</th>
              <th scope="col">Estimated</th>
              <th scope="col">Allocation</th>
            </tr>
          </thead>
          <tbody>
            {c.days.map((d) => (
              <tr key={d.day}>
                <th scope="row">{dayLabel(d.day)}</th>
                <td>
                  {hours(d.available_minutes)}
                  {d.holiday ? ' (holiday)' : d.unavailable_minutes ? ' (time off)' : ''}
                </td>
                <td>{hours(d.scheduled_minutes)}</td>
                <td>
                  {hours(d.estimated_minutes)}
                  {d.unestimated_tasks ? ` + ${d.unestimated_tasks} unestimated` : ''}
                </td>
                <td>
                  {STATE_TEXT[d.state]}
                  {d.over ? ` by ${hours(d.over)}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>By brand</h3>
      {c.brands.length ? (
        <div className="table-scroll" role="region" aria-label="Capacity by brand" tabIndex={0}>
          <table className="table">
            <caption className="visually-hidden">Capacity by brand</caption>
            <thead>
              <tr>
                <th scope="col">Brand</th>
                <th scope="col">Reserved</th>
                <th scope="col">Scheduled</th>
                <th scope="col">Estimated</th>
              </tr>
            </thead>
            <tbody>
              {c.brands.map((b) => (
                <tr key={b.brand.id}>
                  <th scope="row">{b.brand.name}</th>
                  <td>{b.reserved_minutes ? hours(b.reserved_minutes) : '—'}</td>
                  <td>
                    {hours(b.scheduled_minutes)}
                    {b.over_reservation_minutes
                      ? ` (${hours(b.over_reservation_minutes)} over)`
                      : ''}
                  </td>
                  <td>{hours(b.estimated_minutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty">No brand work or reservations this week.</p>
      )}
    </>
  );
}

function TimeOffSection({
  ws,
  nonce,
  onChanged,
}: {
  ws: string;
  nonce: number;
  onChanged: (msg: string) => void;
}) {
  const stepUp = useStepUp();
  const list = useResource(() => capacity.timeOff(ws), `capt:${ws}:${nonce}`);
  const [kind, setKind] = useState<TimeOff['kind']>('vacation');
  const [first, setFirst] = useState(localDay());
  const [last, setLast] = useState(localDay());
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await capacity.addTimeOff(
        ws,
        {
          kind,
          all_day: true,
          starts_on: first,
          ends_on: last,
          ...(label.trim() ? { label } : {}),
        },
        stepUp,
      );
      setLabel('');
      onChanged('Time off added.');
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="off-h">
      <h2 id="off-h">My time off</h2>
      <p className="hint">Only you see the kind and note; others see unavailable time.</p>
      <ResourceView resource={list.state} onRetry={list.retry} what="time off">
        {(items) =>
          items.length ? (
            <ul className="capacity-list">
              {items.map((t) => (
                <li key={t.id}>
                  {KIND_TEXT[t.kind]}:{' '}
                  {t.all_day
                    ? t.starts_on === t.ends_on
                      ? dayLabel(t.starts_on!)
                      : `${dayLabel(t.starts_on!)} – ${dayLabel(t.ends_on!)}`
                    : `${new Date(t.starts_at!).toLocaleString()} – ${new Date(t.ends_at!).toLocaleString()}`}
                  {t.label ? ` · ${t.label}` : ''}{' '}
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={async () => {
                      try {
                        await capacity.removeTimeOff(ws, t.id, t.version, stepUp);
                        onChanged('Time off removed.');
                      } catch (err) {
                        setError(describe(err));
                      }
                    }}
                  >
                    Remove<span className="visually-hidden"> {KIND_TEXT[t.kind]} time off</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No time off in the coming weeks.</p>
          )
        }
      </ResourceView>
      {error ? (
        <Banner tone="danger" title="Not changed">
          {error}
        </Banner>
      ) : null}
      <form onSubmit={add} aria-label="Add time off">
        <SelectField
          id="off-kind"
          label="Kind"
          value={kind}
          onChange={(v) => setKind(v as TimeOff['kind'])}
          options={Object.entries(KIND_TEXT).map(([value, l]) => ({ value, label: l }))}
        />
        <Field
          id="off-first"
          label="First day"
          type="date"
          value={first}
          required
          onChange={(e) => {
            setFirst(e.target.value);
            if (last < e.target.value) setLast(e.target.value);
          }}
        />
        <Field
          id="off-last"
          label="Last day"
          type="date"
          value={last}
          required
          onChange={(e) => setLast(e.target.value)}
        />
        <Field
          id="off-label"
          label="Note (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <div className="actions">
          <button
            type="submit"
            className="button button-secondary"
            disabled={busy}
            aria-busy={busy}
          >
            Add time off
          </button>
        </div>
      </form>
    </section>
  );
}

function TeamSection({ ws, week, nonce }: { ws: string; week: string; nonce: number }) {
  const team = useResource(
    () =>
      capacity.team(ws, week, shiftDay(week, 6)).catch((err: unknown) => {
        // No capacity.view anywhere: the section is simply absent.
        if (err instanceof ApiError && (err.code === 'forbidden' || err.code === 'not_found'))
          return null;
        throw err;
      }),
    `capteam:${ws}:${week}:${nonce}`,
  );
  if (team.state.status === 'ready' && team.state.data === null) return null;
  return (
    <section className="card" aria-labelledby="team-h">
      <h2 id="team-h">Team allocation</h2>
      <ResourceView resource={team.state} onRetry={team.retry} what="team capacity">
        {(t) =>
          t && t.people.length ? (
            <div className="table-scroll" role="region" aria-label="Team allocation" tabIndex={0}>
              <table className="table">
                <caption className="visually-hidden">Team allocation this week</caption>
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    <th scope="col">Available</th>
                    <th scope="col">Planned</th>
                    <th scope="col">Allocation</th>
                    <th scope="col">Conflicts</th>
                  </tr>
                </thead>
                <tbody>
                  {t.people.map((p) => (
                    <tr key={p.member.id}>
                      <th scope="row">{p.member.name}</th>
                      <td>{hours(p.totals.available_minutes)}</td>
                      <td>{hours(p.totals.planned)}</td>
                      <td>
                        {STATE_TEXT[p.totals.state]}
                        {p.totals.over ? ` by ${hours(p.totals.over)}` : ''}
                      </td>
                      <td>{p.conflicts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty">Nobody is reserved in brands you plan for.</p>
          )
        }
      </ResourceView>
    </section>
  );
}

function BrandSection({
  ws,
  nonce,
  onChanged,
}: {
  ws: string;
  nonce: number;
  onChanged: (msg: string) => void;
}) {
  const stepUp = useStepUp();
  const shell = useWorkspaceShell();
  const brands = shell?.context?.brands ?? [];
  const [picked, setBrand] = useState('');
  // The first readable brand until one is chosen (derived, not stored).
  const brand = brands.some((b) => b.id === picked) ? picked : (brands[0]?.id ?? '');
  const reservations = useResource(() => capacity.reservations(ws), `capr:${ws}:${nonce}`);
  // People are chosen by name (the workspace's assignable people), never by typing a member ID.
  const people = useResource(() => views.options(ws, 'task', 'assignee'), `cap-people:${ws}`);
  const holidays = useResource(
    () =>
      brand ? capacity.holidays(ws, brand) : Promise.resolve({ data: [], can_configure: false }),
    brand ? `caph:${ws}:${brand}:${nonce}` : 'wait',
  );
  const [error, setError] = useState('');
  const [hDay, setHDay] = useState(localDay());
  const [hName, setHName] = useState('');
  const [rMember, setRMember] = useState('');
  const [rHours, setRHours] = useState('');
  const [rFrom, setRFrom] = useState(mondayOf(localDay()));
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setError('');
    try {
      await fn();
      onChanged(msg);
    } catch (err) {
      setError(describe(err));
    }
  };
  if (!brands.length) return null;
  return (
    <section className="card" aria-labelledby="brand-h">
      <h2 id="brand-h">Brand reservations and holidays</h2>
      <SelectField
        id="cap-brand"
        label="Brand"
        value={brand}
        onChange={setBrand}
        options={brands.map((b) => ({ value: b.id, label: b.name }))}
      />
      {error ? (
        <Banner tone="danger" title="Not changed">
          {error}
        </Banner>
      ) : null}
      <h3>Reservations</h3>
      <ResourceView resource={reservations.state} onRetry={reservations.retry} what="reservations">
        {(list) => {
          const here = list.filter((r) => r.brand.id === brand);
          return here.length ? (
            <ul className="capacity-list">
              {here.map((r) => (
                <li key={r.id}>
                  {r.member.name}: {hours(r.minutes_per_week)} a week from{' '}
                  {dayLabel(r.effective_from)}
                  {r.effective_to ? ` to ${dayLabel(r.effective_to)}` : ''}{' '}
                  <button
                    type="button"
                    className="button button-ghost"
                    onClick={() =>
                      run(
                        () => capacity.unreserve(ws, r.id, r.version, stepUp),
                        'Reservation removed.',
                      )
                    }
                  >
                    Remove<span className="visually-hidden"> reservation for {r.member.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No reservations you can see in this brand.</p>
          );
        }}
      </ResourceView>
      <form
        aria-label="Reserve time"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () =>
              capacity.reserve(
                ws,
                {
                  brand,
                  member: rMember,
                  minutes_per_week: Math.round(Number(rHours) * 60),
                  effective_from: rFrom,
                },
                stepUp,
              ),
            'Reservation saved.',
          );
        }}
      >
        <SelectField
          id="rsv-member"
          label="Person"
          value={rMember}
          required
          onChange={setRMember}
          options={[
            { value: '', label: 'Choose a person' },
            ...(people.state.status === 'ready' ? people.state.data : []),
          ]}
        />
        <Field
          id="rsv-hours"
          label="Hours a week"
          inputMode="decimal"
          value={rHours}
          required
          onChange={(e) => setRHours(e.target.value)}
        />
        <Field
          id="rsv-from"
          label="From"
          type="date"
          value={rFrom}
          required
          onChange={(e) => setRFrom(e.target.value)}
        />
        <div className="actions">
          <button type="submit" className="button button-secondary">
            Reserve time
          </button>
        </div>
      </form>
      <h3>Holidays</h3>
      <ResourceView resource={holidays.state} onRetry={holidays.retry} what="holidays">
        {(h) => (
          <>
            {h.data.length ? (
              <ul className="capacity-list">
                {h.data.map((x) => (
                  <li key={x.id}>
                    {dayLabel(x.day)}: {x.name}{' '}
                    {h.can_configure ? (
                      <button
                        type="button"
                        className="button button-ghost"
                        onClick={() =>
                          run(
                            () => capacity.removeHoliday(ws, brand, x.id, stepUp),
                            'Holiday removed.',
                          )
                        }
                      >
                        Remove<span className="visually-hidden"> {x.name}</span>
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">No holidays in this brand.</p>
            )}
            {h.can_configure ? (
              <form
                aria-label="Add holiday"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(
                    () => capacity.addHoliday(ws, brand, { day: hDay, name: hName }, stepUp),
                    'Holiday added.',
                  ).then(() => setHName(''));
                }}
              >
                <Field
                  id="hol-day"
                  label="Day"
                  type="date"
                  value={hDay}
                  required
                  onChange={(e) => setHDay(e.target.value)}
                />
                <Field
                  id="hol-name"
                  label="Holiday name"
                  value={hName}
                  required
                  onChange={(e) => setHName(e.target.value)}
                />
                <div className="actions">
                  <button type="submit" className="button button-secondary">
                    Add holiday
                  </button>
                </div>
              </form>
            ) : null}
          </>
        )}
      </ResourceView>
    </section>
  );
}
