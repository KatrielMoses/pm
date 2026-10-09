import { Issues, text as plainField } from '@pm/tenancy';
import { isObject, isPublic } from '../validation.ts';
import {
  CONFIDENCES,
  GOAL_BASES,
  GOAL_STATUSES,
  PERIOD_KINDS,
  goalPeriodOf,
  type ConfidenceKey,
  type GoalBasisKey,
  type GoalStatusKey,
  type Period,
} from './semantics.ts';

/**
 * Phase 5B inputs (ADR-0029). Every parser refuses unknown fields, reports pointer-precise safe
 * issues, and never echoes input. Nothing here consults the database or authorization.
 */

const unknownFields = (b: Record<string, unknown>, allowed: readonly string[], issues: Issues) => {
  for (const k of Object.keys(b))
    if (!allowed.includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
};

const ref = (
  b: Record<string, unknown>,
  key: string,
  prefix: string,
  issues: Issues,
): string | null | undefined => {
  const v = b[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!isPublic(v, prefix)) {
    issues.add(`/${key}`, 'invalid_reference', 'Choose from the list.');
    return undefined;
  }
  return v;
};

/** A finite decimal within the stored bound (a measurement, not currency). */
const number = (v: unknown, pointer: string, issues: Issues): number | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e12) {
    issues.add(pointer, 'invalid_number', 'Use a number no larger than one trillion.');
    return undefined;
  }
  // Four decimal places are stored; more would silently round.
  if (Math.abs(Math.round(v * 10_000) / 10_000 - v) > 1e-9) {
    issues.add(pointer, 'too_precise', 'Use at most four decimal places.');
    return undefined;
  }
  return Math.round(v * 10_000) / 10_000;
};

const unit = (v: unknown, pointer: string, issues: Issues) =>
  plainField(v, pointer, issues, { max: 30, required: false, label: 'The unit' });

const title = (v: unknown, issues: Issues, required: boolean) =>
  plainField(v, '/title', issues, { max: 200, required, label: 'The title' });

const version = (b: Record<string, unknown>, issues: Issues): number | undefined => {
  const v = b.version;
  if (v === undefined) return undefined;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  issues.add('/version', 'invalid_number', 'Send the version you loaded.');
  return undefined;
};

/** Parts of a period as the API takes them: `{kind, year, index}` or `{kind: 'custom', start, end}`. */
function period(v: unknown, issues: Issues): Period | undefined {
  if (!isObject(v)) {
    issues.add('/period', 'required', 'Choose the goal period.');
    return undefined;
  }
  unknownFields(
    Object.fromEntries(Object.entries(v).map(([k, x]) => [`period/${k}`, x])),
    ['period/kind', 'period/year', 'period/index', 'period/start', 'period/end'],
    issues,
  );
  if (!(PERIOD_KINDS as readonly unknown[]).includes(v.kind)) {
    issues.add('/period/kind', 'invalid_option', 'Choose a quarter, half, year, or custom period.');
    return undefined;
  }
  const p = goalPeriodOf({
    kind: v.kind,
    year: v.year,
    index: v.index,
    start: v.start,
    end: v.end,
  });
  if (!p) {
    issues.add(
      '/period',
      'invalid_period',
      'That is not a valid period. Check the dates or the quarter.',
    );
    return undefined;
  }
  return p;
}

export interface Metric {
  unit: string | null;
  baseline: number | null;
  target: number | null;
  current: number | null;
}

/**
 * A measurement definition: a target needs its baseline, and the two differ. `current` is only a
 * starting value; later values arrive through check-ins.
 */
function metric(v: unknown, issues: Issues): Metric | undefined {
  if (v === undefined) return undefined;
  if (v === null) return { unit: null, baseline: null, target: null, current: null };
  if (!isObject(v)) {
    issues.add('/metric', 'invalid_type', 'Describe the measurement.');
    return undefined;
  }
  unknownFields(
    Object.fromEntries(Object.entries(v).map(([k, x]) => [`metric/${k}`, x])),
    ['metric/unit', 'metric/baseline', 'metric/target', 'metric/current'],
    issues,
  );
  const m: Metric = {
    unit: unit(v.unit, '/metric/unit', issues) ?? null,
    baseline: number(v.baseline, '/metric/baseline', issues) ?? null,
    target: number(v.target, '/metric/target', issues) ?? null,
    current: number(v.current, '/metric/current', issues) ?? null,
  };
  if ((m.target === null) !== (m.baseline === null))
    issues.add('/metric', 'incomplete', 'Give both a baseline and a target, or neither.');
  else if (m.target !== null && m.baseline === m.target)
    issues.add('/metric/target', 'invalid_number', 'The target must differ from the baseline.');
  if (m.target === null && m.current !== null)
    issues.add(
      '/metric/current',
      'conflicting',
      'A current value needs a target to measure against.',
    );
  return m;
}

export interface GoalCreate {
  title: string;
  description: string | null;
  brand: string | null;
  project: string | null;
  owner: string | null;
  status: 'draft' | 'active';
  period: Period;
  basis: GoalBasisKey;
  metric: Metric;
}

export function parseGoalCreate(body: unknown): GoalCreate {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the goal.');
  unknownFields(
    b,
    ['title', 'description', 'brand', 'project', 'owner', 'status', 'period', 'basis', 'metric'],
    issues,
  );
  const t = title(b.title, issues, true);
  const description =
    plainField(b.description, '/description', issues, {
      max: 4000,
      required: false,
      label: 'The description',
    }) ?? null;
  const brand = ref(b, 'brand', 'br', issues) ?? null;
  const project = ref(b, 'project', 'prj', issues) ?? null;
  const owner = ref(b, 'owner', 'mem', issues) ?? null;
  if (brand && project)
    issues.add(
      '/project',
      'conflicting',
      "Leave out the brand: a project goal lives in its project's brand.",
    );
  const status = b.status ?? 'active';
  if (status !== 'draft' && status !== 'active')
    issues.add('/status', 'invalid_option', 'A new goal is a draft or active.');
  const p = period(b.period, issues);
  const basis = b.basis ?? 'manual';
  if (!(GOAL_BASES as readonly unknown[]).includes(basis))
    issues.add('/basis', 'invalid_option', 'Choose how progress is measured.');
  const m = metric(b.metric, issues) ?? { unit: null, baseline: null, target: null, current: null };
  if (basis !== 'manual' && (m.target !== null || m.unit !== null))
    issues.add(
      '/metric',
      'conflicting',
      'Progress from key results or linked work is derived; leave out the measurement.',
    );
  issues.throwIfAny();
  return {
    title: t!,
    description,
    brand,
    project,
    owner,
    status: status as 'draft' | 'active',
    period: p!,
    basis: basis as GoalBasisKey,
    metric: m,
  };
}

export interface GoalUpdate {
  version: number | undefined;
  title?: string;
  description?: string | null;
  owner?: string;
  status?: GoalStatusKey;
  period?: Period;
  basis?: GoalBasisKey;
  metric?: Metric;
}

export function parseGoalUpdate(body: unknown): GoalUpdate {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the changes.');
  unknownFields(
    b,
    ['version', 'title', 'description', 'owner', 'status', 'period', 'basis', 'metric'],
    issues,
  );
  const out: GoalUpdate = { version: version(b, issues) };
  if (b.title !== undefined) {
    const t = title(b.title, issues, true);
    if (t) out.title = t;
  }
  if (b.description !== undefined)
    out.description =
      plainField(b.description, '/description', issues, {
        max: 4000,
        required: false,
        label: 'The description',
      }) ?? null;
  if (b.owner !== undefined) {
    const o = ref(b, 'owner', 'mem', issues);
    if (o) out.owner = o;
    else if (o === null) issues.add('/owner', 'required', 'A goal needs an owner.');
  }
  if (b.status !== undefined) {
    if (!(GOAL_STATUSES as readonly unknown[]).includes(b.status))
      issues.add('/status', 'invalid_option', 'Choose a status from the list.');
    else out.status = b.status as GoalStatusKey;
  }
  if (b.period !== undefined) {
    const p = period(b.period, issues);
    if (p) out.period = p;
  }
  if (b.basis !== undefined) {
    if (!(GOAL_BASES as readonly unknown[]).includes(b.basis))
      issues.add('/basis', 'invalid_option', 'Choose how progress is measured.');
    else out.basis = b.basis as GoalBasisKey;
  }
  if (b.metric !== undefined) {
    const m = metric(b.metric, issues);
    if (m) out.metric = m;
  }
  if (!Object.keys(out).some((k) => k !== 'version'))
    issues.add('/', 'empty', 'Send at least one change.');
  issues.throwIfAny();
  return out;
}

export interface KeyResultCreate {
  title: string;
  owner: string | null;
  basis: 'manual' | 'linked_work';
  metric: Metric;
}

const krBasis = (v: unknown, issues: Issues): 'manual' | 'linked_work' | undefined => {
  if (v === undefined) return undefined;
  if (v === 'manual' || v === 'linked_work') return v;
  issues.add('/basis', 'invalid_option', 'A key result is measured by hand or by linked work.');
  return undefined;
};

export function parseKeyResultCreate(body: unknown): KeyResultCreate {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the key result.');
  unknownFields(b, ['title', 'owner', 'basis', 'metric'], issues);
  const t = title(b.title, issues, true);
  const owner = ref(b, 'owner', 'mem', issues) ?? null;
  const basis = krBasis(b.basis, issues) ?? 'manual';
  const m = metric(b.metric, issues) ?? { unit: null, baseline: null, target: null, current: null };
  if (basis === 'linked_work' && (m.target !== null || m.unit !== null))
    issues.add(
      '/metric',
      'conflicting',
      'A key result measured by linked work is derived; leave out the measurement.',
    );
  issues.throwIfAny();
  return { title: t!, owner, basis, metric: m };
}

export interface KeyResultUpdate {
  version: number | undefined;
  title?: string;
  owner?: string;
  basis?: 'manual' | 'linked_work';
  metric?: Metric;
  after?: string | null;
}

export function parseKeyResultUpdate(body: unknown): KeyResultUpdate {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the changes.');
  unknownFields(b, ['version', 'title', 'owner', 'basis', 'metric', 'after'], issues);
  const out: KeyResultUpdate = { version: version(b, issues) };
  if (b.title !== undefined) {
    const t = title(b.title, issues, true);
    if (t) out.title = t;
  }
  if (b.owner !== undefined) {
    const o = ref(b, 'owner', 'mem', issues);
    if (o) out.owner = o;
    else if (o === null) issues.add('/owner', 'required', 'A key result needs an owner.');
  }
  const basis = krBasis(b.basis, issues);
  if (basis) out.basis = basis;
  if (b.metric !== undefined) {
    const m = metric(b.metric, issues);
    if (m) out.metric = m;
  }
  if (b.after !== undefined) {
    const a = ref(b, 'after', 'kr', issues);
    if (a !== undefined) out.after = a;
  }
  if (!Object.keys(out).some((k) => k !== 'version'))
    issues.add('/', 'empty', 'Send at least one change.');
  issues.throwIfAny();
  return out;
}

export interface CheckinInput {
  keyResult: string | null;
  value: number | null;
  percent: number | null;
  confidence: ConfidenceKey | null;
  note: string | null;
}

export function parseCheckin(body: unknown): CheckinInput {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the check-in.');
  unknownFields(b, ['key_result', 'value', 'percent', 'confidence', 'note'], issues);
  const keyResult = ref(b, 'key_result', 'kr', issues) ?? null;
  const value = number(b.value, '/value', issues) ?? null;
  let percent: number | null = null;
  if (b.percent !== undefined && b.percent !== null) {
    if (
      typeof b.percent !== 'number' ||
      !Number.isFinite(b.percent) ||
      b.percent < 0 ||
      b.percent > 100
    )
      issues.add('/percent', 'invalid_number', 'Use a percentage from 0 to 100.');
    else percent = Math.round(b.percent * 100) / 100;
  }
  if (value !== null && percent !== null)
    issues.add('/percent', 'conflicting', 'Send a value or a percentage, not both.');
  const confidence = b.confidence ?? null;
  if (confidence !== null && !(CONFIDENCES as readonly unknown[]).includes(confidence))
    issues.add('/confidence', 'invalid_option', 'Choose on track, at risk, or off track.');
  const note =
    plainField(b.note, '/note', issues, { max: 2000, required: false, label: 'The note' }) ?? null;
  if (
    value === null &&
    percent === null &&
    confidence === null &&
    note === null &&
    !issues.list.length
  )
    issues.add('/', 'empty', 'Add a value, a percentage, a confidence, or a note.');
  issues.throwIfAny();
  return { keyResult, value, percent, confidence: confidence as ConfidenceKey | null, note };
}

export function parseGoalLink(body: unknown): { target: string; keyResult: string | null } {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the link.');
  unknownFields(b, ['target', 'key_result'], issues);
  const target = b.target;
  if (!isPublic(target, 'prj') && !isPublic(target, 'tsk'))
    issues.add('/target', 'invalid_reference', 'Choose a project or a task.');
  const keyResult = ref(b, 'key_result', 'kr', issues) ?? null;
  issues.throwIfAny();
  return { target: target as string, keyResult };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface GoalListQuery {
  brand: string | 'workspace' | null;
  project: string | null;
  statuses: GoalStatusKey[] | null;
  owner: string | 'me' | null;
  basis: GoalBasisKey | null;
  confidence: ConfidenceKey | 'none' | null;
  update: 'never' | 'fresh' | 'stale' | null;
  period: 'current' | 'upcoming' | 'ended' | null;
  from: string | null;
  to: string | null;
  q: string | null;
  /** Show archived goals instead of active ones. */
  archived: boolean;
  limit: number | null;
  cursor: string | null;
}

export function parseGoalList(q: Record<string, unknown>, limitMax: number): GoalListQuery {
  const issues = new Issues();
  const str = (k: string) => (typeof q[k] === 'string' && q[k] !== '' ? (q[k] as string) : null);
  const brandRaw = str('brand');
  if (brandRaw && brandRaw !== 'workspace' && !isPublic(brandRaw, 'br'))
    issues.add('/brand', 'invalid_reference', 'Choose a brand, or "workspace".');
  const project = str('project');
  if (project && !isPublic(project, 'prj'))
    issues.add('/project', 'invalid_reference', 'Choose a project.');
  let statuses: GoalStatusKey[] | null = null;
  const sRaw = str('status');
  if (sRaw) {
    const parts = sRaw.split(',');
    if (
      parts.length > GOAL_STATUSES.length ||
      parts.some((s) => !(GOAL_STATUSES as readonly string[]).includes(s))
    )
      issues.add('/status', 'invalid_option', 'Choose statuses from the list.');
    else statuses = [...new Set(parts)] as GoalStatusKey[];
  }
  const owner = str('owner');
  if (owner && owner !== 'me' && !isPublic(owner, 'mem'))
    issues.add('/owner', 'invalid_reference', 'Choose a person.');
  const basis = str('basis');
  if (basis && !(GOAL_BASES as readonly string[]).includes(basis))
    issues.add('/basis', 'invalid_option', 'Choose a basis from the list.');
  const confidence = str('confidence');
  if (
    confidence &&
    confidence !== 'none' &&
    !(CONFIDENCES as readonly string[]).includes(confidence)
  )
    issues.add('/confidence', 'invalid_option', 'Choose a confidence from the list.');
  const update = str('update');
  if (update && !['never', 'fresh', 'stale'].includes(update))
    issues.add('/update', 'invalid_option', 'Choose never, fresh, or stale.');
  const period = str('period');
  if (period && !['current', 'upcoming', 'ended'].includes(period))
    issues.add('/period', 'invalid_option', 'Choose current, upcoming, or ended.');
  const from = str('from');
  const to = str('to');
  for (const [k, v] of [
    ['from', from],
    ['to', to],
  ] as const)
    if (v && (!DAY.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))))
      issues.add(`/${k}`, 'invalid_date', 'Use a date like 2026-10-04.');
  const search = str('q');
  if (search && [...search].length > 100)
    issues.add('/q', 'too_long', 'Search for at most 100 characters.');
  let limit: number | null = null;
  if (q.limit !== undefined) {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1 || n > limitMax)
      issues.add('/limit', 'invalid_number', `Use a page size from 1 to ${limitMax}.`);
    else limit = n;
  }
  issues.throwIfAny();
  return {
    brand: brandRaw as GoalListQuery['brand'],
    project,
    statuses,
    owner: owner as GoalListQuery['owner'],
    basis: basis as GoalBasisKey | null,
    confidence: confidence as GoalListQuery['confidence'],
    update: update as GoalListQuery['update'],
    period: period as GoalListQuery['period'],
    from,
    to,
    q: search,
    archived: q.archived === 'true',
    limit,
    cursor: str('cursor'),
  };
}

export interface PortfolioInput {
  name?: string;
  description?: string | null;
  brand?: string | null;
  owner?: string;
  version: number | undefined;
}

export function parsePortfolio(body: unknown, create: boolean): PortfolioInput {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the portfolio.');
  unknownFields(
    b,
    create
      ? ['name', 'description', 'brand', 'owner']
      : ['version', 'name', 'description', 'owner'],
    issues,
  );
  const out: PortfolioInput = { version: create ? undefined : version(b, issues) };
  if (create || b.name !== undefined) {
    const n = plainField(b.name, '/name', issues, { max: 200, required: true, label: 'The name' });
    if (n) out.name = n;
  }
  if (b.description !== undefined)
    out.description =
      plainField(b.description, '/description', issues, {
        max: 2000,
        required: false,
        label: 'The description',
      }) ?? null;
  if (create) {
    const brand = ref(b, 'brand', 'br', issues);
    if (brand !== undefined) out.brand = brand;
  }
  if (b.owner !== undefined) {
    const o = ref(b, 'owner', 'mem', issues);
    if (o) out.owner = o;
    else if (o === null) issues.add('/owner', 'required', 'A portfolio needs an owner.');
  }
  if (!create && !Object.keys(out).some((k) => k !== 'version'))
    issues.add('/', 'empty', 'Send at least one change.');
  issues.throwIfAny();
  return out;
}

export function parsePortfolioMembers(
  body: unknown,
  max: number,
): { projects: string[]; version: number | undefined } {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the projects.');
  unknownFields(b, ['projects', 'version'], issues);
  const v = version(b, issues);
  let projects: string[] = [];
  if (!Array.isArray(b.projects)) issues.add('/projects', 'required', 'List the projects.');
  else if (b.projects.length > max)
    issues.add('/projects', 'too_many', `A portfolio holds at most ${max} projects.`);
  else {
    b.projects.forEach((p, i) => {
      if (!isPublic(p, 'prj'))
        issues.add(`/projects/${i}`, 'invalid_reference', 'Choose a project.');
    });
    projects = [...new Set(b.projects as string[])];
  }
  issues.throwIfAny();
  return { projects, version: v };
}

export interface OverviewQuery {
  portfolio: string | null;
  brand: string | null;
  statuses: string[] | null;
  health: string[] | null;
  owner: string | 'me' | null;
  limit: number | null;
  cursor: string | null;
}

const PROJECT_CATEGORIES = ['planned', 'active', 'paused', 'done', 'cancelled'];
const HEALTHS = ['on_track', 'at_risk', 'off_track', 'complete', 'unknown'];

export function parseOverview(q: Record<string, unknown>, limitMax: number): OverviewQuery {
  const issues = new Issues();
  const str = (k: string) => (typeof q[k] === 'string' && q[k] !== '' ? (q[k] as string) : null);
  const portfolio = str('portfolio');
  if (portfolio && !isPublic(portfolio, 'pf'))
    issues.add('/portfolio', 'invalid_reference', 'Choose a portfolio.');
  const brand = str('brand');
  if (brand && !isPublic(brand, 'br')) issues.add('/brand', 'invalid_reference', 'Choose a brand.');
  const list = (k: string, allowed: string[]) => {
    const raw = str(k);
    if (!raw) return null;
    const parts = raw.split(',');
    if (parts.length > allowed.length || parts.some((x) => !allowed.includes(x))) {
      issues.add(`/${k}`, 'invalid_option', 'Choose values from the list.');
      return null;
    }
    return [...new Set(parts)];
  };
  const statuses = list('status', PROJECT_CATEGORIES);
  const health = list('health', HEALTHS);
  const owner = str('owner');
  if (owner && owner !== 'me' && !isPublic(owner, 'mem'))
    issues.add('/owner', 'invalid_reference', 'Choose a person.');
  let limit: number | null = null;
  if (q.limit !== undefined) {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1 || n > limitMax)
      issues.add('/limit', 'invalid_number', `Use a page size from 1 to ${limitMax}.`);
    else limit = n;
  }
  issues.throwIfAny();
  return {
    portfolio,
    brand,
    statuses,
    health,
    owner: owner as OverviewQuery['owner'],
    limit,
    cursor: str('cursor'),
  };
}
