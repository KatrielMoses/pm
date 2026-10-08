import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from '../api.ts';
import { projects, type ProjectSummary } from '../projects/client.ts';
import { tasks, type TaskSummary } from '../tasks/client.ts';
import { useStepUp } from '../stepup.tsx';
import { tenancy } from '../tenancy/client.ts';
import { useResource } from '../tenancy/resource.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Banner } from '../ui/feedback.tsx';
import { ErrorSummary, Field, fieldErrorsFrom, SelectField, TextAreaField } from '../ui/form.tsx';
import {
  GOAL_STATUS_LABEL,
  GOAL_STATUSES,
  BASIS_LABEL,
  goals,
  type GoalBasis,
  type GoalCreate,
  type GoalDetail,
  type GoalPatch,
  type KeyResult,
  type Metric,
  type PeriodKind,
} from './client.ts';
import { useIdempotency, useMembers } from './hooks.ts';
import {
  fmtNumber,
  parseNumber,
  ProblemLine,
  RadioGroup,
  useExplain,
  type Explained,
} from './shared.tsx';

/** Dialogs for goals, key results, and links. Failed saves never clear what the person typed. */

const thisYear = () => new Date().getFullYear();

// ---- Measurement fields -----------------------------------------------------------------------

interface MetricState {
  unit: string;
  baseline: string;
  target: string;
  current: string;
}
const emptyMetric: MetricState = { unit: '', baseline: '', target: '', current: '' };
const metricState = (m: Metric): MetricState => ({
  unit: m.unit ?? '',
  baseline: fmtNumber(m.baseline).replace(/,/g, ''),
  target: fmtNumber(m.target).replace(/,/g, ''),
  current: fmtNumber(m.current).replace(/,/g, ''),
});

/** The measurement a form describes, or an error for the first field that is not a number. */
function metricBody(
  m: MetricState,
  withCurrent: boolean,
): { metric: Partial<Metric> | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const num = (text: string, field: string) => {
    const n = parseNumber(text);
    if (n === undefined) errors[field] = 'Use a number, like 12 or 0.5.';
    return n ?? null;
  };
  const baseline = num(m.baseline, 'metric-baseline');
  const target = num(m.target, 'metric-target');
  const current = withCurrent ? num(m.current, 'metric-current') : null;
  if ((baseline === null) !== (target === null) && !errors['metric-baseline'] && !errors['metric-target'])
    errors['metric-target'] = 'Give both a baseline and a target, or neither.';
  const unit = m.unit.trim();
  if (!unit && baseline === null && target === null && current === null)
    return { metric: null, errors };
  return {
    metric: {
      unit: unit || null,
      baseline,
      target,
      ...(withCurrent ? { current } : {}),
    },
    errors,
  };
}

function MetricFields({
  value,
  onChange,
  errors,
  withCurrent,
}: {
  value: MetricState;
  onChange: (m: MetricState) => void;
  errors: Record<string, string | undefined>;
  withCurrent: boolean;
}) {
  const set = (k: keyof MetricState) => (e: { target: { value: string } }) =>
    onChange({ ...value, [k]: e.target.value });
  return (
    <fieldset className="plain gl-metric">
      <legend>Measurement (optional)</legend>
      <p className="hint">
        With a baseline and a target, progress is how far the value has moved from the baseline
        toward the target. Without them, each check-in records a percentage.
      </p>
      <Field
        id="metric-unit"
        label="Unit (for example %, users, or £)"
        value={value.unit}
        onChange={set('unit')}
        error={errors['metric-unit']}
        maxLength={30}
      />
      <Field
        id="metric-baseline"
        label="Baseline"
        inputMode="decimal"
        value={value.baseline}
        onChange={set('baseline')}
        error={errors['metric-baseline']}
      />
      <Field
        id="metric-target"
        label="Target"
        inputMode="decimal"
        value={value.target}
        onChange={set('target')}
        error={errors['metric-target']}
      />
      {withCurrent ? (
        <Field
          id="metric-current"
          label="Starting value"
          inputMode="decimal"
          value={value.current}
          onChange={set('current')}
          error={errors['metric-current']}
        />
      ) : null}
    </fieldset>
  );
}

const METRIC_POINTERS = {
  '/metric': 'metric-target',
  '/metric/unit': 'metric-unit',
  '/metric/baseline': 'metric-baseline',
  '/metric/target': 'metric-target',
  '/metric/current': 'metric-current',
};
const METRIC_LABELS = {
  'metric-unit': 'Unit',
  'metric-baseline': 'Baseline',
  'metric-target': 'Target',
  'metric-current': 'Starting value',
};

// ---- Period fields ----------------------------------------------------------------------------

interface PeriodState {
  kind: PeriodKind;
  year: string;
  index: string;
  start: string;
  end: string;
}

function periodBody(p: PeriodState): GoalCreate['period'] | null {
  if (p.kind === 'custom') return p.start && p.end ? { kind: 'custom', start: p.start, end: p.end } : null;
  const year = Number(p.year);
  if (!Number.isInteger(year)) return null;
  if (p.kind === 'year') return { kind: 'year', year };
  return { kind: p.kind, year, index: Number(p.index) };
}

function PeriodFields({
  value,
  onChange,
  errors,
}: {
  value: PeriodState;
  onChange: (p: PeriodState) => void;
  errors: Record<string, string | undefined>;
}) {
  return (
    <fieldset className="plain gl-period">
      <legend>Period</legend>
      <RadioGroup
        legend="Length"
        value={value.kind}
        onChange={(kind) => onChange({ ...value, kind, index: kind === 'half' ? '1' : value.index })}
        options={[
          { value: 'quarter', label: 'Quarter' },
          { value: 'half', label: 'Half year' },
          { value: 'year', label: 'Year' },
          { value: 'custom', label: 'Custom dates' },
        ]}
      />
      {value.kind === 'custom' ? (
        <>
          <Field
            id="period-start"
            label="First day"
            type="date"
            value={value.start}
            onChange={(e) => onChange({ ...value, start: e.target.value })}
            error={errors['period-start']}
          />
          <Field
            id="period-end"
            label="Last day"
            type="date"
            value={value.end}
            onChange={(e) => onChange({ ...value, end: e.target.value })}
            error={errors['period-end']}
          />
        </>
      ) : (
        <>
          <Field
            id="period-year"
            label="Year"
            inputMode="numeric"
            value={value.year}
            onChange={(e) => onChange({ ...value, year: e.target.value })}
            error={errors['period-year']}
          />
          {value.kind !== 'year' ? (
            <SelectField
              id="period-index"
              label={value.kind === 'quarter' ? 'Quarter' : 'Half'}
              value={value.index}
              onChange={(index) => onChange({ ...value, index })}
              options={
                value.kind === 'quarter'
                  ? [1, 2, 3, 4].map((n) => ({ value: String(n), label: `Q${n}` }))
                  : [1, 2].map((n) => ({ value: String(n), label: `H${n}` }))
              }
            />
          ) : null}
        </>
      )}
    </fieldset>
  );
}

const PERIOD_POINTERS = {
  '/period': 'period-year',
  '/period/kind': 'period-year',
  '/period/year': 'period-year',
  '/period/start': 'period-start',
  '/period/end': 'period-end',
};

const periodState = (g: GoalDetail): PeriodState => ({
  kind: g.period.kind,
  year: g.period.start.slice(0, 4),
  index:
    g.period.kind === 'quarter'
      ? String(Math.floor((Number(g.period.start.slice(5, 7)) - 1) / 3) + 1)
      : g.period.kind === 'half'
        ? Number(g.period.start.slice(5, 7)) <= 6
          ? '1'
          : '2'
        : '1',
  start: g.period.start,
  end: g.period.end,
});

/** Banner shown on a version conflict: the typed text stays, and the way forward is one button. */
function ConflictNotice({
  what,
  reloaded,
  busy,
  onReload,
}: {
  what: string;
  reloaded: boolean;
  busy: boolean;
  onReload: () => void;
}) {
  if (reloaded)
    return (
      <Banner tone="info" title="Latest version loaded">
        Your edits are still here. Check them, then save again to apply them to the latest version of{' '}
        {what}.
      </Banner>
    );
  return (
    <Banner
      tone="warning"
      title={`This ${what} changed while you were editing`}
      action={
        <button type="button" className="button button-secondary" onClick={onReload} disabled={busy}>
          Load latest version
        </button>
      }
    >
      Your edits are kept below. Load the latest version, then save again.
    </Banner>
  );
}

// ---- Create a goal ----------------------------------------------------------------------------

type ScopeChoice = 'workspace' | 'brand' | 'project';

export function CreateGoalDialog({
  ws,
  onClose,
  onCreated,
  fixedProject,
}: {
  ws: string;
  onClose: () => void;
  onCreated: (goal: GoalDetail) => void;
  /** A goal started from a project: scope and brand are fixed. */
  fixedProject?: { id: string; name: string };
}) {
  const stepUp = useStepUp();
  const explainError = useExplain();
  const idem = useIdempotency();
  const { members } = useMembers(ws);
  const brands = useResource(() => tenancy.listBrands(ws, 'active'), `goal-brands:${ws}`);
  const projectList = useResource(
    () => projects.list(ws, { state: 'active' }),
    fixedProject ? 'wait' : `goal-projects:${ws}`,
  );
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<ScopeChoice>(fixedProject ? 'project' : 'workspace');
  const [brand, setBrand] = useState('');
  const [project, setProject] = useState(fixedProject?.id ?? '');
  const now = new Date();
  const [period, setPeriod] = useState<PeriodState>({
    kind: 'quarter',
    year: String(thisYear()),
    index: String(Math.floor(now.getMonth() / 3) + 1),
    start: '',
    end: '',
  });
  const [basis, setBasis] = useState<GoalBasis>('manual');
  const [metric, setMetric] = useState<MetricState>(emptyMetric);
  const [owner, setOwner] = useState('');
  const [status, setStatus] = useState<'active' | 'draft'>('active');
  const [error, setError] = useState<unknown>(null);
  const [problem, setProblem] = useState<ReturnType<typeof explainError> | null>(null);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const api = fieldErrorsFrom(error, {
    '/title': 'goal-title',
    '/description': 'goal-description',
    '/brand': 'goal-brand',
    '/project': 'goal-project',
    '/owner': 'goal-owner',
    '/basis': 'goal-basis',
    ...PERIOD_POINTERS,
    ...METRIC_POINTERS,
  });
  const errors = { ...api, ...local };

  const creatable = brands.state.status === 'ready' ? brands.state.data.data : [];
  const projectsOf =
    projectList.state.status === 'ready' ? projectList.state.data.data : ([] as ProjectSummary[]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const found: Record<string, string> = {};
    if (!title.trim()) found['goal-title'] = 'Give the goal a title.';
    if (scope === 'brand' && !brand) found['goal-brand'] = 'Choose which brand this goal belongs to.';
    if (scope === 'project' && !project) found['goal-project'] = 'Choose the project.';
    const p = periodBody(period);
    if (!p) found[period.kind === 'custom' ? 'period-start' : 'period-year'] = 'Choose the period.';
    const m = basis === 'manual' ? metricBody(metric, true) : { metric: null, errors: {} };
    Object.assign(found, m.errors);
    setLocal(found);
    setAttempt((a) => a + 1);
    if (Object.keys(found).length) return;
    const body: GoalCreate = {
      title: title.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(scope === 'brand' ? { brand } : {}),
      ...(scope === 'project' ? { project } : {}),
      ...(owner ? { owner } : {}),
      status,
      period: p!,
      basis,
      ...(m.metric ? { metric: m.metric } : {}),
    };
    setBusy(true);
    setError(null);
    setProblem(null);
    try {
      const created = await goals.create(ws, body, stepUp, { key: idem.keyFor(body) });
      idem.reset();
      onCreated(created);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'cancelled') return;
      setError(err);
      setProblem(explainError(err, 'creating the goal'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Create goal" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <ErrorSummary
          errors={errors}
          labels={{
            'goal-title': 'Title',
            'goal-description': 'Description',
            'goal-brand': 'Brand',
            'goal-project': 'Project',
            'goal-owner': 'Owner',
            'period-year': 'Period',
            'period-start': 'First day',
            'period-end': 'Last day',
            ...METRIC_LABELS,
          }}
          focusKey={attempt}
        />
        <Field
          id="goal-title"
          label="Title"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          error={errors['goal-title']}
          maxLength={200}
        />
        <TextAreaField
          id="goal-description"
          label="Description (optional)"
          value={description}
          onChange={setDescription}
          maxLength={4000}
          error={errors['goal-description']}
        />
        {fixedProject ? (
          <p>
            Scope: project <strong>{fixedProject.name}</strong>
          </p>
        ) : (
          <>
            <RadioGroup
              legend="Scope"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'workspace', label: 'Workspace-wide' },
                { value: 'brand', label: 'One brand' },
                { value: 'project', label: 'One project' },
              ]}
            />
            {scope === 'brand' ? (
              <SelectField
                id="goal-brand"
                label="Brand"
                hint="Choose which brand this goal belongs to. It is never chosen for you."
                required
                value={brand}
                onChange={setBrand}
                error={errors['goal-brand']}
                options={[
                  { value: '', label: 'Choose a brand' },
                  ...creatable.map((b) => ({ value: b.id, label: b.name })),
                ]}
              />
            ) : null}
            {scope === 'project' ? (
              <SelectField
                id="goal-project"
                label="Project"
                hint="The goal lives in the project's brand."
                required
                value={project}
                onChange={setProject}
                error={errors['goal-project']}
                options={[
                  { value: '', label: 'Choose a project' },
                  ...projectsOf.map((p) => ({
                    value: p.id,
                    label: `${p.name}${p.brand.kind === 'brand' ? ` (${p.brand.name})` : ''}`,
                  })),
                ]}
              />
            ) : null}
          </>
        )}
        <PeriodFields value={period} onChange={setPeriod} errors={errors} />
        <RadioGroup
          legend="How is progress measured?"
          value={basis}
          onChange={setBasis}
          options={(Object.keys(BASIS_LABEL) as GoalBasis[]).map((b) => ({
            value: b,
            label: BASIS_LABEL[b],
          }))}
        />
        {basis === 'manual' ? (
          <MetricFields value={metric} onChange={setMetric} errors={errors} withCurrent />
        ) : (
          <p className="hint">
            {basis === 'key_results'
              ? 'Progress is the average of the key results you add after creating the goal.'
              : 'Progress is the completion of the projects and tasks you link, counting only work each viewer can read.'}
          </p>
        )}
        {members.length ? (
          <SelectField
            id="goal-owner"
            label="Owner"
            value={owner}
            onChange={setOwner}
            error={errors['goal-owner']}
            options={[
              { value: '', label: 'Me' },
              ...members.filter((m) => !m.you).map((m) => ({ value: m.id, label: m.name })),
            ]}
          />
        ) : null}
        <RadioGroup
          legend="Start as"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'draft', label: 'Draft (not yet committed)' },
          ]}
        />
        <ProblemLine
          problem={error && !Object.keys(api).length ? problem : null}
          busy={busy}
          onRetry={() => void submit({ preventDefault: () => undefined } as FormEvent)}
        />
        <p className="actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create goal'}
          </button>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
        </p>
      </form>
    </Dialog>
  );
}

// ---- Edit a goal ------------------------------------------------------------------------------

export function EditGoalDialog({
  ws,
  goal,
  onClose,
  onSaved,
  onReload,
}: {
  ws: string;
  /** The latest loaded goal; replaced when the person loads the latest version. */
  goal: GoalDetail;
  onClose: () => void;
  onSaved: (g: GoalDetail) => void;
  onReload: () => Promise<void>;
}) {
  const stepUp = useStepUp();
  const explainError = useExplain();
  const { members } = useMembers(ws);
  const [initial] = useState(goal);
  const [title, setTitle] = useState(goal.title);
  const [description, setDescription] = useState(goal.description ?? '');
  const [owner, setOwner] = useState(goal.owner?.id ?? '');
  const [status, setStatus] = useState(goal.status);
  const [period, setPeriod] = useState(periodState(goal));
  const [metric, setMetric] = useState(metricState(goal.metric));
  const [error, setError] = useState<unknown>(null);
  const [problem, setProblem] = useState<ReturnType<typeof explainError> | null>(null);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [reloaded, setReloaded] = useState(false);
  const api = fieldErrorsFrom(error, {
    '/title': 'goal-title',
    '/description': 'goal-description',
    '/owner': 'goal-owner',
    ...PERIOD_POINTERS,
    ...METRIC_POINTERS,
  });
  const errors = { ...api, ...local };
  const stale = problem?.kind === 'stale';
  const statusOptions = GOAL_STATUSES.filter((s) => s !== 'draft' || goal.status === 'draft');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const found: Record<string, string> = {};
    if (!title.trim()) found['goal-title'] = 'Give the goal a title.';
    const p = periodBody(period);
    if (!p) found[period.kind === 'custom' ? 'period-start' : 'period-year'] = 'Choose the period.';
    const m = goal.basis === 'manual' ? metricBody(metric, true) : { metric: null, errors: {} };
    Object.assign(found, m.errors);
    setLocal(found);
    setAttempt((a) => a + 1);
    if (Object.keys(found).length) return;
    // Only what this person changed is sent, so edits made by someone else in other fields survive.
    const patch: GoalPatch = {};
    if (title.trim() !== initial.title) patch.title = title.trim();
    if (description.trim() !== (initial.description ?? '')) patch.description = description.trim() || null;
    if (owner && owner !== initial.owner?.id) patch.owner = owner;
    if (status !== initial.status) patch.status = status;
    if (JSON.stringify(period) !== JSON.stringify(periodState(initial))) patch.period = p!;
    if (goal.basis === 'manual' && JSON.stringify(metric) !== JSON.stringify(metricState(initial.metric)))
      patch.metric = m.metric ?? { unit: null, baseline: null, target: null, current: null };
    if (!Object.keys(patch).length) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    setProblem(null);
    try {
      onSaved(await goals.update(ws, goal.id, goal.version, patch, stepUp));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'cancelled') return;
      setError(err);
      setProblem(explainError(err, 'saving the goal'));
      setReloaded(false);
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    setBusy(true);
    try {
      await onReload();
      setProblem(null);
      setError(null);
      setReloaded(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Edit goal" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <ErrorSummary
          errors={errors}
          labels={{
            'goal-title': 'Title',
            'goal-description': 'Description',
            'goal-owner': 'Owner',
            'period-year': 'Period',
            'period-start': 'First day',
            'period-end': 'Last day',
            ...METRIC_LABELS,
          }}
          focusKey={attempt}
        />
        {stale || reloaded ? (
          <ConflictNotice what="goal" reloaded={reloaded && !stale} busy={busy} onReload={() => void reload()} />
        ) : null}
        <Field
          id="goal-title"
          label="Title"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          error={errors['goal-title']}
          maxLength={200}
        />
        <TextAreaField
          id="goal-description"
          label="Description"
          value={description}
          onChange={setDescription}
          maxLength={4000}
          error={errors['goal-description']}
        />
        <SelectField
          id="goal-status"
          label="Status"
          hint="A goal that has left draft cannot return to it."
          value={status}
          onChange={(v) => setStatus(v as GoalDetail['status'])}
          options={statusOptions.map((s) => ({ value: s, label: GOAL_STATUS_LABEL[s] }))}
        />
        {members.length ? (
          <SelectField
            id="goal-owner"
            label="Owner"
            value={owner}
            onChange={setOwner}
            error={errors['goal-owner']}
            options={[
              ...(goal.owner ? [] : [{ value: '', label: 'No owner' }]),
              ...members.map((m) => ({ value: m.id, label: m.you ? `${m.name} (you)` : m.name })),
            ]}
          />
        ) : null}
        <PeriodFields value={period} onChange={setPeriod} errors={errors} />
        {goal.basis === 'manual' ? (
          <MetricFields value={metric} onChange={setMetric} errors={errors} withCurrent />
        ) : null}
        <ProblemLine problem={error && !Object.keys(api).length && !stale ? problem : null} busy={busy} />
        <p className="actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
        </p>
      </form>
    </Dialog>
  );
}

// ---- Key results ------------------------------------------------------------------------------

export function KeyResultDialog({
  ws,
  goal,
  krId,
  onClose,
  onSaved,
  onReload,
}: {
  ws: string;
  goal: GoalDetail;
  /** Absent to add a key result. */
  krId?: string;
  onClose: () => void;
  onSaved: () => void;
  onReload: () => Promise<void>;
}) {
  const stepUp = useStepUp();
  const explainError = useExplain();
  const idem = useIdempotency();
  const { members } = useMembers(ws);
  const existing: KeyResult | undefined = krId ? goal.key_results.find((k) => k.id === krId) : undefined;
  const [initial] = useState(existing);
  const [title, setTitle] = useState(existing?.title ?? '');
  const [basis, setBasis] = useState<'manual' | 'linked_work'>(existing?.basis ?? 'manual');
  const [owner, setOwner] = useState(existing?.owner?.id ?? '');
  const [metric, setMetric] = useState(existing ? metricState(existing.metric) : emptyMetric);
  const [error, setError] = useState<unknown>(null);
  const [problem, setProblem] = useState<ReturnType<typeof explainError> | null>(null);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [reloaded, setReloaded] = useState(false);
  const api = fieldErrorsFrom(error, {
    '/title': 'kr-title',
    '/owner': 'kr-owner',
    '/basis': 'kr-basis',
    ...METRIC_POINTERS,
  });
  const errors = { ...api, ...local };
  const stale = problem?.kind === 'stale';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const found: Record<string, string> = {};
    if (!title.trim()) found['kr-title'] = 'Give the key result a title.';
    const m = basis === 'manual' ? metricBody(metric, !existing) : { metric: null, errors: {} };
    Object.assign(found, m.errors);
    setLocal(found);
    setAttempt((a) => a + 1);
    if (Object.keys(found).length) return;
    setBusy(true);
    setError(null);
    setProblem(null);
    try {
      if (existing && initial) {
        const patch: Parameters<typeof goals.updateKeyResult>[4] = {};
        if (title.trim() !== initial.title) patch.title = title.trim();
        if (owner && owner !== initial.owner?.id) patch.owner = owner;
        if (basis !== initial.basis) patch.basis = basis;
        if (
          JSON.stringify(metric) !== JSON.stringify(metricState(initial.metric)) ||
          basis !== initial.basis
        )
          patch.metric = m.metric ?? { unit: null, baseline: null, target: null, current: null };
        if (Object.keys(patch).length)
          await goals.updateKeyResult(ws, goal.id, existing.id, existing.version, patch, stepUp);
      } else {
        const body = {
          title: title.trim(),
          basis,
          ...(owner ? { owner } : {}),
          ...(m.metric ? { metric: m.metric } : {}),
        };
        await goals.createKeyResult(ws, goal.id, body, stepUp, { key: idem.keyFor(body) });
        idem.reset();
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'cancelled') return;
      setError(err);
      setProblem(explainError(err, 'saving the key result'));
      setReloaded(false);
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    setBusy(true);
    try {
      await onReload();
      setProblem(null);
      setError(null);
      setReloaded(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={existing ? 'Edit key result' : 'Add key result'} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <ErrorSummary
          errors={errors}
          labels={{ 'kr-title': 'Title', 'kr-owner': 'Owner', ...METRIC_LABELS }}
          focusKey={attempt}
        />
        {stale || reloaded ? (
          <ConflictNotice what="key result" reloaded={reloaded && !stale} busy={busy} onReload={() => void reload()} />
        ) : null}
        <Field
          id="kr-title"
          label="Title"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          error={errors['kr-title']}
          maxLength={200}
        />
        <RadioGroup
          legend="How is it measured?"
          value={basis}
          onChange={setBasis}
          options={[
            { value: 'manual', label: 'Updated by hand' },
            { value: 'linked_work', label: 'Completion of linked work' },
          ]}
        />
        {basis === 'manual' ? (
          <MetricFields value={metric} onChange={setMetric} errors={errors} withCurrent={!existing} />
        ) : (
          <p className="hint">
            Progress is the completion of the projects and tasks linked to this key result, counting
            only work each viewer can read.
          </p>
        )}
        {members.length ? (
          <SelectField
            id="kr-owner"
            label="Owner"
            value={owner}
            onChange={setOwner}
            error={errors['kr-owner']}
            options={[
              { value: '', label: existing ? 'Keep the current owner' : 'Me' },
              ...members.map((m) => ({ value: m.id, label: m.you ? `${m.name} (you)` : m.name })),
            ]}
          />
        ) : null}
        <ProblemLine problem={error && !Object.keys(api).length && !stale ? problem : null} busy={busy} />
        <p className="actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Saving…' : existing ? 'Save changes' : 'Add key result'}
          </button>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
        </p>
      </form>
    </Dialog>
  );
}

// ---- Links ------------------------------------------------------------------------------------

/**
 * Adds a project or task link. The pickers list only what this person can read now (the same lists
 * the rest of the product uses), narrowed to what the goal's scope allows.
 */
export function LinkDialog({
  ws,
  goal,
  onClose,
  onLinked,
}: {
  ws: string;
  goal: GoalDetail;
  onClose: () => void;
  onLinked: () => void;
}) {
  const stepUp = useStepUp();
  const explainError = useExplain();
  const scopedProject = goal.scope.kind === 'project' ? (goal.scope.project?.id ?? '') : '';
  const projectList = useResource(
    () => projects.list(ws, { state: 'active' }),
    scopedProject ? 'wait' : `link-projects:${ws}`,
  );
  const [project, setProject] = useState(scopedProject);
  const [kind, setKind] = useState<'project' | 'task'>(scopedProject ? 'task' : 'project');
  const [task, setTask] = useState('');
  const [filter, setFilter] = useState('');
  const [kr, setKr] = useState('');
  const taskList = useResource(
    () => tasks.list(ws, { project, limit: '200' }),
    kind === 'task' && project ? `link-tasks:${ws}:${project}` : 'wait',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [problem, setProblem] = useState<ReturnType<typeof explainError> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [local, setLocal] = useState<Record<string, string>>({});
  const api = fieldErrorsFrom(error, { '/target': 'link-project', '/key_result': 'link-kr' });
  const errors = { ...api, ...local };

  const brandId = goal.scope.kind === 'workspace' ? null : goal.scope.brand.kind === 'brand' ? goal.scope.brand.id : null;
  const choices = (projectList.state.status === 'ready' ? projectList.state.data.data : []).filter(
    (p) => !brandId || (p.brand.kind === 'brand' && p.brand.id === brandId),
  );
  const taskChoices: TaskSummary[] = useMemo(
    () =>
      (taskList.state.status === 'ready' ? taskList.state.data.data : []).filter((t) =>
        t.title.toLowerCase().includes(filter.trim().toLowerCase()),
      ),
    [taskList.state, filter],
  );
  const krOptions = goal.key_results.filter((k) => k.basis === 'linked_work');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const target = kind === 'project' ? project : task;
    const found: Record<string, string> = {};
    if (!target) found['link-project'] = kind === 'project' ? 'Choose a project.' : 'Choose a task.';
    setLocal(found);
    setAttempt((a) => a + 1);
    if (Object.keys(found).length) return;
    setBusy(true);
    setError(null);
    setProblem(null);
    try {
      await goals.addLink(ws, goal.id, { target, ...(kr ? { key_result: kr } : {}) }, stepUp);
      onLinked();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'cancelled') return;
      setError(err);
      setProblem(explainError(err, 'adding the link'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Link work" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <ErrorSummary
          errors={errors}
          labels={{ 'link-project': 'Work to link', 'link-kr': 'Key result' }}
          focusKey={attempt}
        />
        <p className="hint">
          You can link projects and tasks you can read.
          {goal.scope.kind === 'project'
            ? " A project goal links tasks of its own project."
            : goal.scope.kind === 'brand'
              ? ' A brand goal links work in its own brand.'
              : ''}
        </p>
        {scopedProject ? null : (
          <RadioGroup
            legend="Link a"
            value={kind}
            onChange={(k) => {
              setKind(k);
              setTask('');
            }}
            options={[
              { value: 'project', label: 'Whole project' },
              { value: 'task', label: 'Task in a project' },
            ]}
          />
        )}
        {scopedProject ? null : (
          <SelectField
            id="link-project"
            label="Project"
            required
            value={project}
            onChange={(v) => {
              setProject(v);
              setTask('');
            }}
            error={kind === 'project' ? errors['link-project'] : undefined}
            options={[
              { value: '', label: 'Choose a project' },
              ...choices.map((p) => ({
                value: p.id,
                label: `${p.name}${p.brand.kind === 'brand' ? ` (${p.brand.name})` : ''}`,
              })),
            ]}
          />
        )}
        {kind === 'task' && project ? (
          <>
            <Field
              id="link-filter"
              label="Find a task"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <SelectField
              id="link-task"
              label="Task"
              required
              value={task}
              onChange={setTask}
              error={errors['link-project']}
              options={[
                {
                  value: '',
                  label:
                    taskList.state.status === 'loading' ? 'Loading tasks…' : 'Choose a task',
                },
                ...taskChoices.map((t) => ({ value: t.id, label: t.title })),
              ]}
            />
          </>
        ) : null}
        {krOptions.length ? (
          <SelectField
            id="link-kr"
            label="Link to"
            value={kr}
            onChange={setKr}
            error={errors['link-kr']}
            options={[
              { value: '', label: 'The goal itself' },
              ...krOptions.map((k) => ({ value: k.id, label: `Key result: ${k.title}` })),
            ]}
          />
        ) : null}
        <ProblemLine problem={error && !Object.keys(api).length ? problem : null} busy={busy} />
        <p className="actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Linking…' : 'Link work'}
          </button>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
        </p>
      </form>
    </Dialog>
  );
}

// ---- Confirmations ----------------------------------------------------------------------------

export function ConfirmDialog({
  title,
  confirm,
  children,
  busy,
  onConfirm,
  onClose,
  problem,
}: {
  title: string;
  confirm: string;
  children: ReactNode;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
  problem?: Explained | null;
}) {
  return (
    <Dialog title={title} destructive onClose={onClose}>
      {children}
      <ProblemLine problem={problem ?? null} busy={busy} />
      <p className="actions">
        <button type="button" className="button button-secondary" data-cancel onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="button button-danger" disabled={busy} onClick={onConfirm}>
          {busy ? 'Working…' : confirm}
        </button>
      </p>
    </Dialog>
  );
}

