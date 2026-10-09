import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../api.ts';
import { useIdempotency, useMembers } from '../goals/hooks.ts';
import { ProblemLine, useExplain, type Explained } from '../goals/shared.tsx';
import { projects, type ProjectSummary } from '../projects/client.ts';
import { useWorkspaceShell } from '../shell/workspace.tsx';
import { useStepUp } from '../stepup.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Field, SelectField } from '../ui/form.tsx';
import {
  KIND_LABEL,
  reports,
  type DashboardCreate,
  type DashboardKind,
  type Report,
  type ReportCreate,
  type Run,
  type ScheduleInput,
  type Share,
  type WidgetInput,
} from './client.ts';

/** Dialogs for creating dashboards and reports and for scheduling, recipients, and sharing. */

const w = (id: string, metric: string, params: Record<string, unknown> = {}): WidgetInput => ({
  id,
  metric,
  params,
  size: 'medium',
});

/** Starting widgets: only metrics that exist today; the person edits them afterwards. */
export const STARTERS: Record<DashboardKind | 'report', WidgetInput[]> = {
  owner: [
    w('open', 'tasks.open', { group_by: 'brand' }),
    w('overdue', 'tasks.overdue'),
    w('projects', 'projects.active', { group_by: 'health' }),
    w('goals', 'goals.progress'),
  ],
  brand: [
    w('open', 'tasks.open', { group_by: 'project' }),
    w('overdue', 'tasks.overdue'),
    w('due', 'tasks.due_soon'),
    w('projects', 'projects.active', { group_by: 'health' }),
  ],
  project: [
    w('open', 'tasks.open'),
    w('overdue', 'tasks.overdue'),
    w('unassigned', 'tasks.unassigned'),
    w('milestones', 'milestones.upcoming'),
  ],
  release: [
    w('open', 'tasks.open', { group_by: 'status_category' }),
    w('overdue', 'tasks.overdue'),
    w('milestones', 'milestones.upcoming'),
    w('deliverables', 'deliverables.status'),
  ],
  personal: [
    w('mine', 'tasks.open'),
    w('due', 'tasks.due_soon'),
    w('overdue', 'tasks.overdue'),
    w('plan', 'planning.planned_vs_completed'),
  ],
  report: [
    w('open', 'tasks.open', { group_by: 'project' }),
    w('overdue', 'tasks.overdue'),
    w('done', 'tasks.completed'),
    w('time', 'time.by_project'),
  ],
};

function useScopeOptions(ws: string) {
  const shell = useWorkspaceShell();
  const brands = shell?.context?.brands ?? [];
  const [list, setList] = useState<ProjectSummary[]>([]);
  useEffect(() => {
    let active = true;
    projects.list(ws).then(
      (l) => active && setList(l.data),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [ws]);
  return { brands, projects: list };
}

function useSave<T>(onDone: (r: T) => void) {
  const explainError = useExplain();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const run = async (fn: () => Promise<T>, what: string) => {
    setBusy(true);
    setProblem(null);
    try {
      onDone(await fn());
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled'))
        setProblem(explainError(err, what));
    } finally {
      setBusy(false);
    }
  };
  return { busy, problem, run };
}

function Actions({ onClose, busy, label }: { onClose: () => void; busy: boolean; label: string }) {
  return (
    <p className="actions">
      <button type="button" className="button button-secondary" onClick={onClose}>
        Cancel
      </button>
      <button type="submit" className="button button-primary" disabled={busy}>
        {busy ? 'Saving…' : label}
      </button>
    </p>
  );
}

export function CreateDashboardDialog({
  ws,
  onCreate,
  onClose,
}: {
  ws: string;
  onCreate: (body: DashboardCreate, key: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const scope = useScopeOptions(ws);
  const idem = useIdempotency();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<DashboardKind>('personal');
  const [brand, setBrand] = useState('');
  const [project, setProject] = useState('');
  const [starter, setStarter] = useState(true);
  const [error, setError] = useState('');
  const { busy, problem, run } = useSave<unknown>(onClose);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setError('Give the dashboard a title.');
    if ((kind === 'brand' || kind === 'release') && !brand) return setError('Choose a brand.');
    if (kind === 'project' && !project) return setError('Choose a project.');
    setError('');
    const body: DashboardCreate = {
      title: title.trim(),
      kind,
      ...(kind === 'brand' || kind === 'release' ? { brand } : {}),
      ...(kind === 'project' ? { project } : {}),
      ...(starter ? { layout: { widgets: STARTERS[kind] } } : {}),
    };
    void run(() => onCreate(body, idem.keyFor(body)), 'creating the dashboard');
  };
  return (
    <Dialog title="New dashboard" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <Field
          id="dash-title"
          label="Title"
          value={title}
          maxLength={200}
          error={error && !title.trim() ? error : undefined}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <SelectField
          id="dash-kind"
          label="Kind"
          value={kind}
          onChange={(k) => setKind(k as DashboardKind)}
          options={(Object.keys(KIND_LABEL) as DashboardKind[]).map((k) => ({
            value: k,
            label: KIND_LABEL[k],
          }))}
        />
        {kind === 'brand' || kind === 'release' ? (
          <SelectField
            id="dash-brand"
            label="Brand"
            value={brand}
            onChange={setBrand}
            options={[
              { value: '', label: 'Choose a brand…' },
              ...scope.brands.map((b) => ({ value: b.id, label: b.name })),
            ]}
          />
        ) : null}
        {kind === 'project' ? (
          <SelectField
            id="dash-project"
            label="Project"
            value={project}
            onChange={setProject}
            options={[
              { value: '', label: 'Choose a project…' },
              ...scope.projects.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        ) : null}
        <label className="check">
          <input type="checkbox" checked={starter} onChange={(e) => setStarter(e.target.checked)} />{' '}
          Start with suggested widgets
        </label>
        {error && title.trim() ? (
          <p role="alert" className="field-error">
            {error}
          </p>
        ) : null}
        <ProblemLine problem={problem} busy={busy} />
        <Actions onClose={onClose} busy={busy} label="Create dashboard" />
      </form>
    </Dialog>
  );
}

export function CreateReportDialog({
  ws,
  onCreate,
  onClose,
}: {
  ws: string;
  onCreate: (body: ReportCreate, key: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const scope = useScopeOptions(ws);
  const idem = useIdempotency();
  const [title, setTitle] = useState('');
  const [where, setWhere] = useState<'workspace' | 'brand' | 'project'>('workspace');
  const [brand, setBrand] = useState('');
  const [project, setProject] = useState('');
  const [error, setError] = useState('');
  const { busy, problem, run } = useSave<unknown>(onClose);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setError('Give the report a title.');
    if (where === 'brand' && !brand) return setError('Choose a brand.');
    if (where === 'project' && !project) return setError('Choose a project.');
    setError('');
    const body: ReportCreate = {
      title: title.trim(),
      ...(where === 'brand' ? { brand } : {}),
      ...(where === 'project' ? { project } : {}),
      layout: { widgets: STARTERS.report },
    };
    void run(() => onCreate(body, idem.keyFor(body)), 'creating the report');
  };
  return (
    <Dialog title="New report" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <Field
          id="rep-title"
          label="Title"
          value={title}
          maxLength={200}
          error={error && !title.trim() ? error : undefined}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <SelectField
          id="rep-where"
          label="Covers"
          value={where}
          onChange={(v) => setWhere(v as typeof where)}
          options={[
            { value: 'workspace', label: 'Every brand I can read' },
            { value: 'brand', label: 'One brand' },
            { value: 'project', label: 'One project' },
          ]}
        />
        {where === 'brand' ? (
          <SelectField
            id="rep-brand"
            label="Brand"
            value={brand}
            onChange={setBrand}
            options={[
              { value: '', label: 'Choose a brand…' },
              ...scope.brands.map((b) => ({ value: b.id, label: b.name })),
            ]}
          />
        ) : null}
        {where === 'project' ? (
          <SelectField
            id="rep-project"
            label="Project"
            value={project}
            onChange={setProject}
            options={[
              { value: '', label: 'Choose a project…' },
              ...scope.projects.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        ) : null}
        {error && title.trim() ? (
          <p role="alert" className="field-error">
            {error}
          </p>
        ) : null}
        <ProblemLine problem={problem} busy={busy} />
        <Actions onClose={onClose} busy={busy} label="Create report" />
      </form>
    </Dialog>
  );
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function ScheduleDialog({
  ws,
  report,
  onSaved,
  onClose,
}: {
  ws: string;
  report: Report;
  onSaved: (r: Report) => void;
  onClose: () => void;
}) {
  const stepUp = useStepUp();
  const idem = useIdempotency();
  const s = report.schedule;
  const [on, setOn] = useState(!!s);
  const [frequency, setFrequency] = useState<ScheduleInput['frequency']>(s?.frequency ?? 'weekly');
  const [weekday, setWeekday] = useState(String(s?.weekday ?? 1));
  const [monthday, setMonthday] = useState(String(s?.monthday ?? 1));
  const [time, setTime] = useState(
    s
      ? `${String(Math.floor(s.minute / 60)).padStart(2, '0')}:${String(s.minute % 60).padStart(2, '0')}`
      : '08:00',
  );
  const [timezone, setTimezone] = useState(
    s?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const { busy, problem, run } = useSave<Report>((r) => {
    onSaved(r);
    onClose();
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input: ScheduleInput | null = on
      ? {
          frequency,
          time,
          timezone,
          ...(frequency === 'weekly' ? { weekday: Number(weekday) } : {}),
          ...(frequency === 'monthly' ? { monthday: Number(monthday) } : {}),
        }
      : null;
    void run(
      () =>
        reports.setSchedule(ws, report.id, report.version, input, stepUp, {
          key: idem.keyFor(input),
        }),
      'saving the schedule',
    );
  };
  return (
    <Dialog title="Schedule delivery" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <p className="hint">
          Each recipient gets the report as they can see it when it is sent, by email, with a link
          back here. Whoever saves a schedule is accountable for it: if they lose the authority to
          schedule it, or leave, it stops until someone resumes it.
        </p>
        <label className="check">
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Send this
          report on a schedule
        </label>
        {on ? (
          <>
            <SelectField
              id="sch-freq"
              label="How often"
              value={frequency}
              onChange={(v) => setFrequency(v as typeof frequency)}
              options={[
                { value: 'daily', label: 'Every day' },
                { value: 'weekly', label: 'Every week' },
                { value: 'monthly', label: 'Every month' },
              ]}
            />
            {frequency === 'weekly' ? (
              <SelectField
                id="sch-weekday"
                label="On"
                value={weekday}
                onChange={setWeekday}
                options={WEEKDAYS.map((d, i) => ({ value: String(i + 1), label: d }))}
              />
            ) : null}
            {frequency === 'monthly' ? (
              <SelectField
                id="sch-monthday"
                label="On day"
                hint="Days 1 to 28, so every month has one."
                value={monthday}
                onChange={setMonthday}
                options={Array.from({ length: 28 }, (_, i) => ({
                  value: String(i + 1),
                  label: String(i + 1),
                }))}
              />
            ) : null}
            <Field
              id="sch-time"
              label="At (local time)"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
            <Field
              id="sch-zone"
              label="Time zone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              hint="An IANA name, like Europe/Berlin."
            />
          </>
        ) : null}
        <ProblemLine problem={problem} busy={busy} />
        <Actions onClose={onClose} busy={busy} label="Save schedule" />
      </form>
    </Dialog>
  );
}

export function RecipientsDialog({
  ws,
  report,
  onSaved,
  onClose,
}: {
  ws: string;
  report: Report;
  onSaved: (r: Report) => void;
  onClose: () => void;
}) {
  const stepUp = useStepUp();
  const idem = useIdempotency();
  const { members, loaded } = useMembers(ws);
  const [chosen, setChosen] = useState<string[] | null>(null);
  useEffect(() => {
    let active = true;
    reports.recipients(ws, report.id).then(
      (r) => active && setChosen(r.map((p) => p.id)),
      () => active && setChosen([]),
    );
    return () => {
      active = false;
    };
  }, [ws, report.id]);
  const { busy, problem, run } = useSave<Report>((r) => {
    onSaved(r);
    onClose();
  });
  const toggle = (id: string) =>
    setChosen((c) =>
      (c ?? []).includes(id) ? (c ?? []).filter((x) => x !== id) : [...(c ?? []), id],
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const list = chosen ?? [];
    void run(
      () =>
        reports.setRecipients(ws, report.id, report.version, list, stepUp, {
          key: idem.keyFor(list),
        }),
      'saving the recipients',
    );
  };
  return (
    <Dialog title="Recipients" onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <p className="hint">Only people who can read this report can receive it.</p>
        {chosen === null || !loaded ? (
          <p role="status">Loading…</p>
        ) : (
          <fieldset className="plain">
            <legend>Send to</legend>
            {members.map((m) => (
              <label key={m.id} className="check">
                <input
                  type="checkbox"
                  checked={chosen.includes(m.id)}
                  onChange={() => toggle(m.id)}
                />{' '}
                {m.name}
                {m.you ? ' (you)' : ''}
              </label>
            ))}
          </fieldset>
        )}
        <ProblemLine problem={problem} busy={busy} />
        <Actions onClose={onClose} busy={busy} label="Save recipients" />
      </form>
    </Dialog>
  );
}

export function ShareDialog({
  ws,
  report,
  onChanged,
  onClose,
}: {
  ws: string;
  report: Report;
  onChanged: () => void;
  onClose: () => void;
}) {
  const stepUp = useStepUp();
  const idem = useIdempotency();
  const explainError = useExplain();
  const { members } = useMembers(ws);
  const [shares, setShares] = useState<Share[] | null>(null);
  const [grantee, setGrantee] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [said, setSaid] = useState('');
  const load = () =>
    reports
      .shares(ws, report.id)
      .then(setShares, (err) => setProblem(explainError(err, 'loading the shares')));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, report.id]);
  const act = async (fn: () => Promise<void>, what: string) => {
    setBusy(true);
    setProblem(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled'))
        setProblem(explainError(err, what));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Share this report" onClose={onClose}>
      <p className="hint">
        A share lets someone open and run this saved report. It gives them no data: they see only
        what they can already read, within this report&apos;s scope. You can revoke it at any time.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!grantee) return;
          void act(async () => {
            const body = { grantee };
            await reports.share(ws, report.id, body, stepUp, { key: idem.keyFor(body) });
            idem.reset();
            setGrantee('');
            setSaid('Shared.');
          }, 'sharing the report');
        }}
      >
        <SelectField
          id="shr-who"
          label="Share with"
          value={grantee}
          onChange={setGrantee}
          options={[
            { value: '', label: 'Choose a person…' },
            ...members.map((m) => ({ value: m.id, label: m.name })),
          ]}
        />
        <p>
          <button type="submit" className="button button-primary" disabled={busy || !grantee}>
            Share
          </button>
        </p>
      </form>
      {shares === null ? (
        <p role="status">Loading…</p>
      ) : shares.length ? (
        <ul className="gl-list" aria-label="People this report is shared with">
          {shares.map((s) => (
            <li key={s.id} className="gl-row">
              <span>{s.grantee?.name ?? 'Member'}</span>
              <button
                type="button"
                className="button button-danger"
                disabled={busy}
                aria-label={`Revoke the share with ${s.grantee?.name ?? 'this person'}`}
                onClick={() =>
                  void act(async () => {
                    await reports.unshare(ws, report.id, s.id, stepUp);
                    setSaid('Share revoked.');
                  }, 'revoking the share')
                }
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">Not shared with anyone.</p>
      )}
      <ProblemLine problem={problem} busy={busy} />
      <p className="announce" role="status">
        {said}
      </p>
      <p className="actions">
        <button type="button" className="button button-primary" onClick={onClose}>
          Done
        </button>
      </p>
    </Dialog>
  );
}

const RUN_TEXT: Record<Run['state'], string> = {
  pending: 'Waiting to send',
  delivered: 'Delivered',
  empty: 'Nothing to send',
  skipped: 'Not sent',
  failed: 'Failed',
};
const DETAIL_TEXT: Record<string, string> = {
  no_access: 'the recipient can no longer read the report',
  nothing_visible: 'nothing in it was visible to the recipient',
  recipient_unavailable: 'the recipient is no longer available',
  provider_unconfigured: 'email delivery is not set up',
  provider_rejected: 'the mail provider refused the message',
  attempts_spent: 'delivery kept failing',
  superseded: 'a newer occurrence replaced it',
};

export function RunsDialog({
  ws,
  report,
  onClose,
}: {
  ws: string;
  report: Report;
  onClose: () => void;
}): ReactNode {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    reports.runs(ws, report.id).then(
      (r) => active && setRuns(r),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, [ws, report.id]);
  return (
    <Dialog title="Delivery history" onClose={onClose}>
      {failed ? (
        <p role="alert">Couldn&apos;t load the delivery history.</p>
      ) : runs === null ? (
        <p role="status">Loading…</p>
      ) : runs.length ? (
        <div className="ins-table-wrap" tabIndex={0} role="region" aria-label="Delivery history">
          <table className="ins-table">
            <caption className="visually-hidden">Delivery history</caption>
            <thead>
              <tr>
                <th scope="col">Scheduled for</th>
                <th scope="col">Result</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td data-label="Scheduled for">
                    {r.occurrence_at ? new Date(r.occurrence_at).toLocaleString() : '—'}
                  </td>
                  <td data-label="Result">{RUN_TEXT[r.state]}</td>
                  <td data-label="Note">
                    {r.detail
                      ? (DETAIL_TEXT[r.detail] ?? r.detail)
                      : r.incomplete
                        ? 'Some data was incomplete'
                        : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="hint">Nothing has been sent yet.</p>
      )}
      <p className="actions">
        <button type="button" className="button button-primary" onClick={onClose}>
          Close
        </button>
      </p>
    </Dialog>
  );
}
