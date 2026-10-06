import { useMemo, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../api.ts';
import { Link } from '../router.tsx';
import { routeHref } from '../shell/registry.ts';
import { useStepUp } from '../stepup.tsx';
import { useResource } from '../tenancy/resource.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Announce, Banner } from '../ui/feedback.tsx';
import { Field, SelectField, TextAreaField } from '../ui/form.tsx';
import type { StatusView } from '../projects/client.ts';
import {
  fields as fieldsApi,
  fieldSets,
  transitions,
  type RecordField,
  type RecordFields,
} from './client.ts';

/**
 * Record-level workflow and field UI (0E Phase 2C note): the statuses a record may move to, the
 * transition dialog (required fields, confirmation, approvals), and the custom-fields section with
 * advanced fields under "More fields" (keyboard reachable, searchable, expanded on error).
 */

/** Statuses a plain status edit may choose now (no review, approval, or Complete needed). */
export function useStatusChoices(
  ws: string,
  rec: string,
  current: StatusView,
  version: number,
  kind: 'task' | 'project',
) {
  const r = useResource(() => transitions.options(ws, rec), `transitions:${ws}:${rec}:${version}`);
  return useMemo(() => {
    const list: Array<{ value: string; label: string }> = [
      { value: current.key, label: current.name },
    ];
    if (r.state.status !== 'ready') return list;
    for (const o of r.state.data.options)
      if (
        o.allowed &&
        o.confirmation === 'none' &&
        !o.approval.required &&
        !(kind === 'task' && o.after_category === 'done')
      )
        list.push({ value: o.status.key, label: o.status.name });
    return list;
  }, [r.state, current.key, current.name, kind]);
}

const CATEGORY_LABEL: Record<string, string> = {
  planned: 'Planned',
  active: 'Active',
  paused: 'Paused',
  done: 'Done',
  cancelled: 'Cancelled',
};

/** "Change status…": every status the workflow offers, with what each change needs. */
export function TransitionControl({
  ws,
  rec,
  version,
  onChanged,
}: {
  ws: string;
  rec: string;
  version: number;
  onChanged: () => void;
}) {
  const stepUp = useStepUp();
  const opts = useResource(
    () => transitions.options(ws, rec),
    `transitions:${ws}:${rec}:${version}:all`,
  );
  const [to, setTo] = useState('');
  const [open, setOpen] = useState(false);
  const [override, setOverride] = useState('');
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof transitions.preview>> | null>(
    null,
  );
  const [error, setError] = useState<unknown>(null);
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  if (opts.state.status !== 'ready' || !opts.state.data.options.length) return null;
  const data = opts.state.data;
  const review = async (target = to, reason = override) => {
    setError(null);
    try {
      setPreview(
        await transitions.preview(ws, rec, {
          to: target,
          ...(reason ? { override_reason: reason } : {}),
        }),
      );
      setOpen(true);
    } catch (e) {
      setError(e);
    }
  };
  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setSaid(message);
      setOpen(false);
      setPreview(null);
      onChanged();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'cancelled')) setError(e);
      // A stale preview: show the current requirements again.
      if (e instanceof ApiError && e.code === 'conflict') await review().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  const approved = preview?.approval_requests.find((a) => a.mine && a.state === 'approved');
  const pending = preview?.approval_requests.find((a) => a.mine && a.state === 'pending');
  return (
    <section className="card" aria-labelledby="tr-heading">
      <h2 id="tr-heading">Status</h2>
      <p>
        Current: <strong>{data.current.name}</strong>
        {data.workflow ? (
          <span className="hint"> · {data.workflow.name} workflow</span>
        ) : (
          <span className="hint"> · default workflow</span>
        )}
      </p>
      <form
        className="inline-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (to) void review();
        }}
      >
        <SelectField
          id="tr-to"
          label="Change status to"
          value={to}
          onChange={setTo}
          options={[
            { value: '', label: 'Choose a status' },
            ...data.options.map((o) => ({
              value: o.status.key,
              label: `${o.status.name} (${CATEGORY_LABEL[o.after_category]})${o.allowed ? '' : ' — not available now'}`,
            })),
          ]}
        />
        <button type="submit" className="button button-secondary" disabled={!to}>
          Review change…
        </button>
      </form>
      {error && !open ? (
        <Banner tone="danger" title="This change can't be made">
          {(error as ApiError).issues?.map((i) => i.message).join(' ') || 'Try again.'}
        </Banner>
      ) : null}
      <Announce>{said}</Announce>
      {open && preview ? (
        <Dialog title={`${preview.from.name} → ${preview.to.name}`} onClose={() => setOpen(false)}>
          <p>
            {CATEGORY_LABEL[preview.before_category]} → {CATEGORY_LABEL[preview.after_category]}
          </p>
          {preview.required_fields.length ? (
            <>
              <h3>Required fields</h3>
              <ul className="plain-list">
                {preview.required_fields.map((r) => (
                  <li key={r.pointer}>
                    {r.satisfied ? '✓' : '✗'} {r.label}
                    <span className="visually-hidden">
                      {r.satisfied ? ' (filled in)' : ' (missing)'}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {preview.issues.length ? (
            <Banner tone="warning" title="Not available yet">
              <ul>
                {preview.issues.map((i, n) => (
                  <li key={n}>{i.message}</li>
                ))}
              </ul>
            </Banner>
          ) : null}
          {preview.required_fields.some((r) => !r.satisfied && r.overridable) ? (
            <TextAreaField
              id="tr-override"
              label="Override reason (managers only)"
              value={override}
              onChange={setOverride}
              maxLength={500}
            />
          ) : null}
          {preview.warnings.length ? (
            <p className="hint">
              {preview.warnings.includes('criteria_incomplete')
                ? 'Some acceptance criteria are not met. '
                : ''}
              {preview.warnings.includes('incomplete_subtasks')
                ? 'Some subtasks are not finished.'
                : ''}
            </p>
          ) : null}
          {preview.approval.required ? (
            <p>
              This change needs approval (
              {preview.approval.policy === 'one_manager' ? 'one manager' : 'every named approver'}).
              {pending ? ' Your request is pending.' : approved ? ' Your request is approved.' : ''}
            </p>
          ) : null}
          {error ? (
            <Banner tone="danger" title="Not applied">
              {(error as ApiError).issues?.map((i) => i.message).join(' ') || 'Try again.'}
            </Banner>
          ) : null}
          <p className="actions">
            <button
              type="button"
              className="button button-secondary"
              autoFocus
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            {override && !preview.allowed ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => void review(to, override)}
              >
                Check with override
              </button>
            ) : null}
            {preview.allowed && preview.approval.required && !approved && !pending ? (
              <button
                type="button"
                className="button button-primary"
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      transitions.requestApproval(
                        ws,
                        rec,
                        { to, version: preview.record_version },
                        stepUp,
                      ),
                    'Approval requested.',
                  )
                }
              >
                Request approval
              </button>
            ) : null}
            {preview.allowed && (!preview.approval.required || approved) ? (
              <button
                type="button"
                className="button button-primary"
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      transitions.apply(
                        ws,
                        rec,
                        {
                          to,
                          version: preview.record_version,
                          preview_token: preview.preview_token,
                          ...(approved ? { approval: approved.id } : {}),
                          ...(override ? { override_reason: override } : {}),
                          confirm_incomplete_subtasks:
                            preview.warnings.includes('incomplete_subtasks'),
                        },
                        stepUp,
                      ),
                    `Status changed to ${preview.to.name}.`,
                  )
                }
              >
                {preview.confirmation === 'none' ? 'Apply' : 'Confirm and apply'}
              </button>
            ) : null}
          </p>
        </Dialog>
      ) : null}
    </section>
  );
}

// -----------------------------------------------------------------------------------------------
// Custom fields
// -----------------------------------------------------------------------------------------------

const display = (f: RecordField): string => {
  const v = f.value as unknown;
  if (f.error)
    return f.error === 'missing'
      ? 'Waiting for inputs'
      : `Can't calculate (${f.error.replace(/_/g, ' ')})`;
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('amount' in o) return `${o.amount as string} ${o.currency as string}`;
    return (o.name ?? o.label ?? '') as string;
  }
  if (f.field_type === 'percentage') return `${v as string}%`;
  return String(v);
};
const editValue = (f: RecordField): string => {
  const v = f.value as unknown;
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return ('amount' in o ? o.amount : o.id) as string;
  }
  return String(v);
};
const toInput = (f: RecordField, s: string): unknown => {
  if (s === '') return null;
  if (f.field_type === 'checkbox') return s === 'true';
  if (f.field_type === 'currency') return { amount: s };
  return s;
};

function FieldInput({
  f,
  value,
  onChange,
  error,
  people,
  labels,
}: {
  f: RecordField;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  people: Array<{ value: string; label: string }>;
  labels: Array<{ value: string; label: string }>;
}) {
  const id = `cf-${f.id}`;
  const label = `${f.name}${f.required ? ' (required)' : ''}`;
  const hint =
    f.description ??
    (f.field_type === 'currency'
      ? `Amount in ${(f.config.currency as string) ?? ''}`
      : f.field_type === 'percentage'
        ? 'Percent'
        : undefined);
  switch (f.field_type) {
    case 'checkbox':
      return (
        <SelectField
          id={id}
          label={label}
          hint={hint}
          error={error}
          value={value}
          onChange={onChange}
          options={[
            { value: '', label: 'Not set' },
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' },
          ]}
        />
      );
    case 'select':
      return (
        <SelectField
          id={id}
          label={label}
          hint={hint}
          error={error}
          value={value}
          onChange={onChange}
          options={[
            { value: '', label: 'Not set' },
            ...f.options
              .filter((o) => !o.archived || o.id === value)
              .map((o) => ({ value: o.id, label: o.label })),
          ]}
        />
      );
    case 'person':
      return (
        <SelectField
          id={id}
          label={label}
          hint={hint}
          error={error}
          value={value}
          onChange={onChange}
          options={[{ value: '', label: 'Nobody' }, ...people]}
        />
      );
    case 'label':
      return (
        <SelectField
          id={id}
          label={label}
          hint={hint}
          error={error}
          value={value}
          onChange={onChange}
          options={[{ value: '', label: 'None' }, ...labels]}
        />
      );
    case 'text':
      return f.config.multiline ? (
        <TextAreaField
          id={id}
          label={label}
          hint={hint}
          error={error}
          value={value}
          onChange={onChange}
          maxLength={(f.config.max_length as number) ?? 5000}
        />
      ) : (
        <Field
          id={id}
          label={label}
          hint={hint}
          error={error}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={(f.config.max_length as number) ?? 5000}
        />
      );
    default:
      return (
        <Field
          id={id}
          label={label}
          hint={hint}
          error={error}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          type={
            f.field_type === 'date'
              ? 'date'
              : f.field_type === 'url'
                ? 'url'
                : f.field_type === 'email'
                  ? 'email'
                  : 'text'
          }
          inputMode={
            ['number', 'currency', 'percentage'].includes(f.field_type) ? 'decimal' : undefined
          }
        />
      );
  }
}

/** The custom-fields section of a record page. */
export function RecordFieldsSection({
  ws,
  rec,
  people = [],
  labels = [],
  onSaved,
}: {
  ws: string;
  rec: string;
  people?: Array<{ value: string; label: string }>;
  labels?: Array<{ value: string; label: string }>;
  onSaved?: () => void;
}) {
  const stepUp = useStepUp();
  const data = useResource(() => fieldsApi.record(ws, rec), `fields:${ws}:${rec}`);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [busy, setBusy] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  if (data.state.status !== 'ready') return null;
  const rf: RecordFields = data.state.data;
  if (!rf.fields.length && !rf.field_sets.length) return null;
  const valueFor = (f: RecordField) => draft[f.id] ?? editValue(f);
  const primary = rf.fields.filter((f) => f.presentation === 'primary');
  const advanced = rf.fields.filter((f) => f.presentation === 'advanced');
  const matches = (f: RecordField) =>
    !search || f.name.toLowerCase().includes(search.toLowerCase());
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const changes: Record<string, { base: unknown; value: unknown }> = {};
    for (const f of rf.fields)
      if (draft[f.id] !== undefined && draft[f.id] !== editValue(f)) {
        const base =
          f.value && typeof f.value === 'object'
            ? 'amount' in (f.value as object)
              ? {
                  minor: (f.value as { minor: string }).minor,
                  currency: (f.value as { currency: string }).currency,
                }
              : (f.value as { id: string }).id
            : f.value;
        changes[f.id] = { base, value: toInput(f, draft[f.id]!) };
      }
    if (!Object.keys(changes).length) return;
    setBusy(true);
    setErrors({});
    setProblem(null);
    try {
      await fieldsApi.setValues(ws, rec, rf.version, changes, stepUp);
      setDraft({});
      setSaid('Fields saved.');
      data.reload();
      onSaved?.();
    } catch (err) {
      if (err instanceof ApiError && err.issues.length) {
        const next: Record<string, string> = {};
        for (const i of err.issues) {
          const id = (i.pointer ?? '').split('/').pop()!;
          next[id] = i.message;
        }
        setErrors(next);
        // An error in an advanced field opens "More fields" and moves focus to it (WFL-013).
        const firstAdvanced = advanced.find((f) => next[f.id]);
        if (firstAdvanced) {
          setMore(true);
          setSearch('');
          setTimeout(() => document.getElementById(`cf-${firstAdvanced.id}`)?.focus(), 0);
        } else {
          const first = primary.find((f) => next[f.id]);
          if (first) setTimeout(() => document.getElementById(`cf-${first.id}`)?.focus(), 0);
        }
        if (!Object.keys(next).some((k) => rf.fields.some((f) => f.id === k)))
          setProblem(err.issues[0]!.message);
      } else if (err instanceof ApiError && err.code === 'conflict')
        setProblem(
          'These fields changed since you loaded them. Your edits are kept; reload to see the latest values.',
        );
      else if (!(err instanceof ApiError && err.code === 'cancelled'))
        setProblem('Not saved. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };
  const row = (f: RecordField) =>
    f.read_only ? (
      <div key={f.id} className="field">
        <p>
          <strong>{f.name}</strong>
          {f.field_type === 'formula' ? <span className="hint"> · calculated</span> : null}
          {f.archived ? <span className="hint"> · archived field</span> : null}
        </p>
        <p id={`cf-${f.id}`}>{display(f)}</p>
      </div>
    ) : (
      <FieldInput
        key={f.id}
        f={f}
        value={valueFor(f)}
        onChange={(v) => setDraft((d) => ({ ...d, [f.id]: v }))}
        error={errors[f.id]}
        people={people}
        labels={labels}
      />
    );
  const dirty = Object.keys(draft).some(
    (k) => draft[k] !== editValue(rf.fields.find((f) => f.id === k)!),
  );
  return (
    <section className="card" aria-labelledby="cf-heading">
      <h2 id="cf-heading">Custom fields</h2>
      <form onSubmit={(e) => void save(e)} noValidate>
        {primary.map(row)}
        {advanced.length ? (
          <div ref={moreRef}>
            <button
              type="button"
              className="button button-ghost"
              aria-expanded={more}
              aria-controls="cf-more"
              onClick={() => setMore((m) => !m)}
            >
              {more ? 'Fewer fields' : `More fields (${advanced.length})`}
            </button>
            <div id="cf-more">
              {more ? (
                <>
                  <Field
                    id="cf-search"
                    label="Find a field"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {advanced.filter(matches).map(row)}
                  {!advanced.some(matches) ? (
                    <p className="hint">No field matches “{search}”.</p>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        ) : null}
        {problem ? (
          <Banner tone="danger" title="Not saved">
            {problem}
          </Banner>
        ) : null}
        {rf.fields.some((f) => !f.read_only) ? (
          <p className="actions">
            <button type="submit" className="button button-primary" disabled={busy || !dirty}>
              Save fields
            </button>
          </p>
        ) : null}
      </form>
      <Announce>{said}</Announce>
      <FieldSetsOnRecord ws={ws} rec={rec} rf={rf} onChanged={() => data.reload()} />
    </section>
  );
}

function FieldSetsOnRecord({
  ws,
  rec,
  rf,
  onChanged,
}: {
  ws: string;
  rec: string;
  rf: RecordFields;
  onChanged: () => void;
}) {
  const stepUp = useStepUp();
  const [preview, setPreview] = useState<null | {
    set: string;
    name: string;
    p: Awaited<ReturnType<typeof fieldSets.preview>>;
  }>(null);
  const [error, setError] = useState<string | null>(null);
  if (!rf.field_sets.length) return null;
  return (
    <div>
      <h3>Field sets</h3>
      <ul className="plain-list">
        {rf.field_sets.map((s) => (
          <li key={s.id}>
            {s.name} <span className="hint">version {s.version}</span>
            {s.upgrade_available ? (
              <button
                type="button"
                className="button button-ghost"
                onClick={() =>
                  void fieldSets.preview(ws, rec, s.id).then(
                    (p) => setPreview({ set: s.id, name: s.name, p }),
                    () => setError('The upgrade preview failed.'),
                  )
                }
              >
                Review upgrade to version {s.current_version}
                <span className="visually-hidden"> of {s.name}</span>
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? <p className="field-error">{error}</p> : null}
      {preview ? (
        <Dialog title={`Upgrade ${preview.name}?`} onClose={() => setPreview(null)}>
          <p>
            Version {preview.p.from_version} → {preview.p.to_version}. Adds{' '}
            {preview.p.fields_added.length} and removes {preview.p.fields_removed.length} fields.
            {preview.p.values_hidden
              ? ` ${preview.p.values_hidden} values will stop showing; nothing is deleted.`
              : ''}
          </p>
          <p className="actions">
            <button
              type="button"
              className="button button-secondary"
              autoFocus
              onClick={() => setPreview(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-primary"
              onClick={() =>
                void fieldSets.apply(ws, rec, preview.set, rf.version, stepUp).then(
                  () => {
                    setPreview(null);
                    onChanged();
                  },
                  () => setError('The upgrade was not applied. Reload and try again.'),
                )
              }
            >
              Upgrade
            </button>
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

/** A link to a record from the approvals queue. */
export function RecordLink({
  ws,
  rec,
  children,
}: {
  ws: string;
  rec: { id: string; type: 'project' | 'task' };
  children: React.ReactNode;
}) {
  return (
    <Link
      to={
        rec.type === 'task'
          ? routeHref('task', { ws, tsk: rec.id })
          : routeHref('project', { ws, prj: rec.id })
      }
    >
      {children}
    </Link>
  );
}
