import { createHash } from 'node:crypto';

/**
 * The versioned metric definitions (5C, ADR-0030). A definition is the contract between a number
 * and the person reading it: what is counted, over which records, in whose time zone, how fresh,
 * what is missing, who may see it, and where it drills to. A definition is immutable once
 * released: changing what a number means is a new version (the old one stays computable and its
 * pinned digest in the tests must not change), never an edit. Dashboards, exports, and goals
 * consume these through the one metric service, never their own arithmetic.
 */

export const METRIC_IDS = [
  'project.completion',
  'project.health',
  'work.attention',
  'work.planned_vs_completed',
  'work.created_vs_completed',
  'work.cycle_time',
  'work.time_in_status',
  'work.age',
  'work.workload',
  'time.planned_vs_actual',
  'cost.time_budget',
  'cost.spend',
  'deliverable.acceptance',
  'quality.tests',
  'data.freshness',
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

export type MetricScopeKind = 'workspace' | 'brand' | 'project';
export type MetricUnit = 'percent' | 'count' | 'seconds' | 'minutes' | 'category' | 'state';

/** What an incomplete or estimated result can say, so a quiet number is never mistaken for a full one. */
export interface IncompleteCode {
  code: string;
  meaning: string;
}

export interface MetricDefinition {
  id: MetricId;
  version: number;
  name: string;
  summary: string;
  unit: MetricUnit;
  scopes: readonly MetricScopeKind[];
  /** `window`: a local-date window is used; `none`: the metric is a snapshot of now. */
  window: 'window' | 'none';
  /** Whether `as_of` is honoured: a past instant reproduces the figure from recorded history. */
  historical: boolean;
  numerator: string;
  denominator: string | null;
  /** The records the figure is computed from (record kinds, never table names). */
  sources: readonly string[];
  timezone: 'workspace' | 'none';
  /** How current the inputs are: `live` reads the records directly; `ledger` also reads the status history. */
  freshness: 'live' | 'ledger' | 'mixed';
  rollup: { kind: 'ratio_of_sums' | 'sum' | 'pooled_distribution' | 'none'; note: string };
  incomplete: readonly IncompleteCode[];
  authorization: string;
  drill: ReadonlyArray<{ role: string; label: string; records: 'task' | 'project' | 'deliverable' }>;
  /** What the figure does not claim (RPT-025): activity is never presented as a business outcome. */
  doesNotClaim: string;
  /** Whether the source exists yet; an unavailable metric returns that state and never a guess. */
  availability: { state: 'available' } | { state: 'source_unavailable'; phase: string; reason: string };
  changelog: string;
}

const READ_RULE =
  'Computed only from records the viewer can read at the time of the request. A record the viewer cannot read adds to no count, label, ranking, freshness, or timing.';

const BASE = {
  scopes: ['workspace', 'brand', 'project'] as const,
  authorization: READ_RULE,
  availability: { state: 'available' } as const,
};

const STATUS_HISTORY: IncompleteCode = {
  code: 'history_unavailable',
  meaning:
    'Some tasks were finished before status history was recorded, so the time they spent earlier is unknown and they are left out.',
};

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    ...BASE,
    id: 'project.completion',
    version: 1,
    name: 'Completion (by task count)',
    summary: 'The share of tasks that are done.',
    unit: 'percent',
    window: 'none',
    historical: true,
    numerator: 'Leaf tasks that are done.',
    denominator: 'Leaf tasks that are not cancelled (paused tasks count).',
    sources: ['task'],
    timezone: 'none',
    freshness: 'live',
    rollup: {
      kind: 'ratio_of_sums',
      note: 'Across projects, brands, or the workspace: all done leaf tasks over all counted leaf tasks, never an average of percentages. A project scope includes its sub-projects.',
    },
    incomplete: [
      { code: 'no_tasks', meaning: 'There are no countable tasks, so there is no percentage.' },
      {
        code: 'current_structure',
        meaning:
          'For a past instant the task status is as it was, but which tasks are leaves is as it is now.',
      },
    ],
    drill: [
      { role: 'numerator', label: 'Done tasks', records: 'task' },
      { role: 'denominator', label: 'Counted tasks', records: 'task' },
    ],
    doesNotClaim:
      'Measures tasks finished, not value delivered or a project being complete; a project is complete only when its own status says so.',
    changelog: 'The OD-13 basis, as 2A and 5B ship it: whole percent, leaf tasks, no weighting.',
  },
  {
    ...BASE,
    id: 'project.completion',
    version: 2,
    name: 'Completion (weighted by estimate)',
    summary: 'The share of estimated work that is done, weighted by each task’s estimate.',
    unit: 'percent',
    window: 'none',
    historical: true,
    numerator: 'Estimate minutes of leaf tasks that are done.',
    denominator: 'Estimate minutes of leaf tasks that are not cancelled.',
    sources: ['task'],
    timezone: 'none',
    freshness: 'live',
    rollup: {
      kind: 'ratio_of_sums',
      note: 'Estimate minutes are added across the scope before dividing, so a large task weighs more than a small one. A task without an estimate carries no weight and is counted and named, never given a guessed one.',
    },
    incomplete: [
      {
        code: 'unestimated_tasks',
        meaning: 'Some counted tasks have no estimate and carry no weight; the figure covers only the estimated work.',
      },
      { code: 'no_estimates', meaning: 'No counted task has an estimate, so there is no weighted figure.' },
      { code: 'no_tasks', meaning: 'There are no countable tasks.' },
      {
        code: 'current_structure',
        meaning:
          'For a past instant the task status is as it was, but estimates and which tasks are leaves are as they are now.',
      },
    ],
    drill: [
      { role: 'numerator', label: 'Done tasks with an estimate', records: 'task' },
      { role: 'denominator', label: 'Estimated tasks', records: 'task' },
      { role: 'unestimated', label: 'Counted tasks without an estimate', records: 'task' },
    ],
    doesNotClaim:
      'Estimates are a plan, not effort spent; this is not progress toward an outcome, and it differs from the count basis by design.',
    changelog:
      'New basis for OD-13: estimate-weighted. Version 1 stays the default and what goals and portfolios show.',
  },
  {
    ...BASE,
    id: 'project.health',
    version: 1,
    name: 'Project health',
    summary: 'A rule-based condition of each project, with the reasons.',
    unit: 'category',
    window: 'none',
    historical: false,
    numerator: 'Projects in each health class.',
    denominator: 'Projects in scope the viewer can read.',
    sources: ['project', 'task', 'time_entry'],
    timezone: 'workspace',
    freshness: 'live',
    rollup: {
      kind: 'sum',
      note: 'Health is judged per project and the classes are counted; a rolled-up health is the count of projects in each class, never one blended class. Sub-projects are separate projects.',
    },
    incomplete: [
      { code: 'no_dates', meaning: 'The project has no start, target, or deadline date.' },
      { code: 'no_tasks', meaning: 'The project has no countable tasks.' },
      { code: 'no_time_budget', meaning: 'The project has no time budget.' },
      { code: 'paused', meaning: 'The project is paused and is judged against its dates only.' },
      { code: 'not_started', meaning: 'The project is planned and is judged against its dates only.' },
      { code: 'cancelled', meaning: 'The project is cancelled.' },
      { code: 'truncated', meaning: 'More projects matched than one request evaluates; narrow the scope.' },
    ],
    drill: [
      { role: 'on_track', label: 'On track', records: 'project' },
      { role: 'at_risk', label: 'At risk', records: 'project' },
      { role: 'off_track', label: 'Off track', records: 'project' },
      { role: 'complete', label: 'Complete', records: 'project' },
      { role: 'unknown', label: 'Not enough information', records: 'project' },
    ],
    doesNotClaim:
      'Health is inferred from dates, task status, blockers, and time against the budget; it never replaces the declared health, and it says nothing about business results.',
    changelog: 'The 5B portfolio rules, unchanged (thresholds in the ADR).',
  },
  {
    ...BASE,
    id: 'work.attention',
    version: 1,
    name: 'Work needing attention',
    summary: 'Open tasks that are overdue, due soon, blocked, stale, or without an owner.',
    unit: 'count',
    window: 'none',
    historical: false,
    numerator: 'Open tasks with each signal (a task can have several).',
    denominator: 'Open tasks (not done, not cancelled).',
    sources: ['task', 'relationship', 'assignment'],
    timezone: 'workspace',
    freshness: 'live',
    rollup: { kind: 'sum', note: 'Counts add across brands and projects; the signals overlap, so they are not added to each other.' },
    incomplete: [
      {
        code: 'owner_unknown',
        meaning: 'Who owns a task is not shown to every viewer, so the unassigned count is not given to them.',
      },
    ],
    drill: [
      { role: 'open', label: 'Open tasks', records: 'task' },
      { role: 'overdue', label: 'Overdue', records: 'task' },
      { role: 'due_soon', label: 'Due in the next 7 days', records: 'task' },
      { role: 'blocked', label: 'Blocked by an open task', records: 'task' },
      { role: 'stale', label: 'Stale', records: 'task' },
      { role: 'unassigned', label: 'Without an owner', records: 'task' },
    ],
    doesNotClaim: 'These are signals to look at, not judgements that a task or a person is failing.',
    changelog:
      'Overdue as in 5B; blocked and stale as the 2D task signals (OD-17); due soon is the next 7 local days.',
  },
  {
    ...BASE,
    id: 'work.planned_vs_completed',
    version: 1,
    name: 'Planned versus completed',
    summary: 'Of the tasks due in a window, how many are done.',
    unit: 'count',
    window: 'window',
    historical: false,
    numerator: 'Planned tasks that are done.',
    denominator: 'Tasks due in the window that are not cancelled.',
    sources: ['task'],
    timezone: 'workspace',
    freshness: 'live',
    rollup: { kind: 'ratio_of_sums', note: 'Done and planned counts are added across the scope before dividing.' },
    incomplete: [
      {
        code: 'undated_tasks',
        meaning: 'Open tasks with no due date or deadline cannot be planned into a window and are counted separately.',
      },
    ],
    drill: [
      { role: 'planned', label: 'Planned (due in the window)', records: 'task' },
      { role: 'completed', label: 'Completed', records: 'task' },
      { role: 'completed_late', label: 'Completed after the window', records: 'task' },
      { role: 'not_completed', label: 'Not completed', records: 'task' },
    ],
    doesNotClaim: 'A due date is a plan; a missed one is not a failure of the work or the person.',
    changelog: 'First version.',
  },
  {
    ...BASE,
    id: 'work.created_vs_completed',
    version: 1,
    name: 'Created versus completed',
    summary: 'Tasks created and tasks completed, per local day.',
    unit: 'count',
    window: 'window',
    historical: true,
    numerator: 'Tasks completed (entered a done status) in the window.',
    denominator: 'Tasks created in the window.',
    sources: ['task', 'status history'],
    timezone: 'workspace',
    freshness: 'ledger',
    rollup: { kind: 'sum', note: 'Daily counts add across the scope and the window; a completion is each entry into a done status, so a reopened task finished again counts again.' },
    incomplete: [
      {
        code: 'assumed_history',
        meaning: 'Some completions in the window come from tasks whose earlier history was not recorded; their completion time is known, not their earlier path.',
      },
    ],
    drill: [
      { role: 'created', label: 'Created', records: 'task' },
      { role: 'completed', label: 'Completed', records: 'task' },
    ],
    doesNotClaim: 'Throughput is a count of tasks, not of effort or value; a task is as large as its author made it.',
    changelog: 'First version.',
  },
  {
    ...BASE,
    id: 'work.cycle_time',
    version: 1,
    name: 'Cycle time',
    summary: 'How long finished tasks took from first being worked on to done.',
    unit: 'seconds',
    window: 'window',
    historical: true,
    numerator: 'Completions in the window with a recorded start: time from first entering an active status to entering done.',
    denominator: null,
    sources: ['status history'],
    timezone: 'workspace',
    freshness: 'ledger',
    rollup: { kind: 'pooled_distribution', note: 'The completions of every task in scope are pooled and the median and 85th percentile taken over the pool; medians of groups are never averaged.' },
    incomplete: [
      STATUS_HISTORY,
      { code: 'no_start', meaning: 'Some tasks were finished without ever being active, so they have no start and are left out.' },
      { code: 'small_sample', meaning: 'Fewer completions than the small-sample threshold; the figure is shown but is not stable.' },
    ],
    drill: [
      { role: 'included', label: 'Completions measured', records: 'task' },
      { role: 'excluded', label: 'Completions left out', records: 'task' },
    ],
    doesNotClaim: 'Elapsed time is not effort (a task can wait); it is not a measure of a person’s speed.',
    changelog: 'First version.',
  },
  {
    ...BASE,
    id: 'work.time_in_status',
    version: 1,
    name: 'Time in status',
    summary: 'How long tasks spent in each status category.',
    unit: 'seconds',
    window: 'window',
    historical: true,
    numerator: 'Seconds spent in each status category inside the window (the part of each span that overlaps it).',
    denominator: null,
    sources: ['status history'],
    timezone: 'workspace',
    freshness: 'ledger',
    rollup: { kind: 'sum', note: 'Seconds add across tasks; shares are of the total seconds counted.' },
    incomplete: [STATUS_HISTORY],
    drill: [
      { role: 'planned', label: 'Tasks that spent time planned', records: 'task' },
      { role: 'active', label: 'Tasks that spent time active', records: 'task' },
      { role: 'paused', label: 'Tasks that spent time paused', records: 'task' },
      { role: 'done', label: 'Tasks that spent time done', records: 'task' },
      { role: 'cancelled', label: 'Tasks that spent time cancelled', records: 'task' },
    ],
    doesNotClaim: 'Time in a status is elapsed time, not work done in it.',
    changelog: 'First version.',
  },
  {
    ...BASE,
    id: 'work.age',
    version: 1,
    name: 'Task age',
    summary: 'How long open tasks have existed.',
    unit: 'count',
    window: 'none',
    historical: true,
    numerator: 'Open tasks in each age band (age is whole 24-hour periods since creation).',
    denominator: 'Open tasks.',
    sources: ['task', 'status history'],
    timezone: 'none',
    freshness: 'mixed',
    rollup: { kind: 'pooled_distribution', note: 'Band counts add; the median and 85th percentile are taken over all open tasks pooled.' },
    incomplete: [
      { code: 'assumed_history', meaning: 'For a past instant, some tasks’ status then is assumed because their history was not recorded.' },
    ],
    drill: [
      { role: 'open', label: 'Open tasks', records: 'task' },
      { role: 'band_0_7', label: '0 to 7 days', records: 'task' },
      { role: 'band_8_14', label: '8 to 14 days', records: 'task' },
      { role: 'band_15_30', label: '15 to 30 days', records: 'task' },
      { role: 'band_31_60', label: '31 to 60 days', records: 'task' },
      { role: 'band_61_plus', label: 'Over 60 days', records: 'task' },
    ],
    doesNotClaim: 'An old task is not necessarily neglected; age says when it was created, not whether it matters.',
    changelog: 'First version.',
  },
  {
    ...BASE,
    id: 'work.workload',
    version: 1,
    name: 'Workload',
    summary: 'Open work and remaining estimate per assigned person.',
    unit: 'minutes',
    window: 'none',
    historical: false,
    numerator: 'Remaining estimate minutes of each person’s open tasks (the task’s remaining estimate, else its estimate less time logged).',
    denominator: null,
    sources: ['task', 'assignment', 'time_entry'],
    timezone: 'none',
    freshness: 'live',
    rollup: { kind: 'sum', note: 'A task with several assignees counts for each; person totals therefore do not add to the scope total, which counts each task once.' },
    incomplete: [
      { code: 'unestimated_tasks', meaning: 'Some open tasks have no estimate and add no minutes; they are counted.' },
      { code: 'people_hidden', meaning: 'People are named only for viewers who may see members.' },
    ],
    drill: [{ role: 'open', label: 'Open tasks', records: 'task' }],
    doesNotClaim: 'Workload from estimates is not capacity (3E) and says nothing about whether the person is over- or under-used.',
    changelog: 'First version.',
  },
  {
    ...BASE,
    id: 'time.planned_vs_actual',
    version: 1,
    name: 'Planned versus actual time',
    summary: 'For tasks finished in a window, the estimate against the time logged.',
    unit: 'minutes',
    window: 'window',
    historical: true,
    numerator: 'Stopped time logged on the tasks (all time, over entries the viewer may read).',
    denominator: 'Estimate minutes of the same tasks.',
    sources: ['task', 'time_entry', 'status history'],
    timezone: 'workspace',
    freshness: 'ledger',
    rollup: { kind: 'ratio_of_sums', note: 'Logged and estimate minutes are added across the scope before comparing.' },
    incomplete: [
      { code: 'unestimated_tasks', meaning: 'Tasks finished in the window with no estimate are counted and not compared.' },
      { code: 'no_time_logged', meaning: 'Some estimated tasks have no time logged, so the actual is a floor.' },
    ],
    drill: [
      { role: 'compared', label: 'Tasks compared', records: 'task' },
      { role: 'unestimated', label: 'Finished without an estimate', records: 'task' },
    ],
    doesNotClaim: 'Over or under the estimate is not good or bad in itself; unlogged work is invisible here.',
    changelog: 'First version.',
  },
  {
    ...BASE,
    id: 'cost.time_budget',
    version: 1,
    name: 'Time budget use',
    summary: 'Time logged against each project’s time budget.',
    unit: 'percent',
    window: 'none',
    historical: false,
    numerator: 'Stopped time logged on the project and its tasks.',
    denominator: 'The project’s time budget in minutes.',
    sources: ['project', 'time_entry'],
    timezone: 'none',
    freshness: 'live',
    rollup: { kind: 'ratio_of_sums', note: 'Logged and budget minutes are added over the projects that have a budget; projects without one are counted and left out.' },
    incomplete: [
      { code: 'no_time_budget', meaning: 'Projects with no time budget are left out and counted.' },
      { code: 'truncated', meaning: 'More projects matched than one request evaluates; narrow the scope.' },
    ],
    drill: [
      { role: 'over_budget', label: 'Over budget', records: 'project' },
      { role: 'within_budget', label: 'Within budget', records: 'project' },
      { role: 'no_budget', label: 'No time budget', records: 'project' },
    ],
    doesNotClaim: 'Time is the only cost measured here; money spend and AI cost are not tracked yet (see cost.spend).',
    changelog: 'First version.',
  },
  {
    ...BASE,
    id: 'cost.spend',
    version: 1,
    name: 'Money and AI spend',
    summary: 'Money spent and AI usage cost against budgets.',
    unit: 'count',
    window: 'none',
    historical: false,
    numerator: 'Not available.',
    denominator: null,
    sources: [],
    timezone: 'none',
    freshness: 'live',
    rollup: { kind: 'none', note: 'Not available.' },
    incomplete: [{ code: 'source_not_available', meaning: 'Spend and AI usage are not recorded yet.' }],
    drill: [],
    doesNotClaim: 'No figure is estimated or inferred from other activity.',
    availability: {
      state: 'source_unavailable',
      phase: '7A',
      reason: 'Money spend and AI usage are recorded from Phase 7A; until then there is no figure.',
    },
    changelog: 'Definition reserved; the source arrives in 7A.',
  },
  {
    ...BASE,
    id: 'deliverable.acceptance',
    version: 1,
    name: 'Deliverable acceptance',
    summary: 'Deliverables by review state, and the share accepted of those submitted.',
    unit: 'count',
    window: 'none',
    historical: false,
    numerator: 'Deliverables that are accepted.',
    denominator: 'Submitted deliverables: ready for review, changes requested, accepted, or rejected (drafts are not submitted).',
    sources: ['deliverable', 'task'],
    timezone: 'none',
    freshness: 'live',
    rollup: { kind: 'ratio_of_sums', note: 'State counts add across the scope before the share is taken.' },
    incomplete: [{ code: 'drafts_excluded', meaning: 'Drafts are counted separately and are not in the share.' }],
    drill: [
      { role: 'draft', label: 'Drafts', records: 'deliverable' },
      { role: 'ready_for_review', label: 'Ready for review', records: 'deliverable' },
      { role: 'changes_requested', label: 'Changes requested', records: 'deliverable' },
      { role: 'accepted', label: 'Accepted', records: 'deliverable' },
      { role: 'rejected', label: 'Rejected', records: 'deliverable' },
    ],
    doesNotClaim: 'Acceptance records a reviewer’s decision on a deliverable, not that it achieved a business goal.',
    changelog: 'First version.',
  },
  {
    ...BASE,
    id: 'quality.tests',
    version: 1,
    name: 'Test results',
    summary: 'Pass rate, flaky tests, open defects, and release blockers.',
    unit: 'count',
    window: 'none',
    historical: false,
    numerator: 'Not available.',
    denominator: null,
    sources: [],
    timezone: 'none',
    freshness: 'live',
    rollup: { kind: 'none', note: 'Not available.' },
    incomplete: [{ code: 'source_not_available', meaning: 'Test runs and defects are not recorded yet.' }],
    drill: [],
    doesNotClaim: 'No figure is estimated or inferred from other activity.',
    availability: {
      state: 'source_unavailable',
      phase: '9B',
      reason: 'Test runs, defects, and release blockers are recorded from Phase 9B; until then there is no figure.',
    },
    changelog: 'Definition reserved; the source arrives in 9B.',
  },
  {
    ...BASE,
    id: 'data.freshness',
    version: 1,
    name: 'Data freshness',
    summary: 'How current each derived source is, for the records the viewer can read.',
    unit: 'state',
    window: 'none',
    historical: false,
    numerator: 'Records of the viewer’s still waiting on, or failed in, each derived source.',
    denominator: null,
    sources: ['search index', 'status history', 'goal recalculation'],
    timezone: 'none',
    freshness: 'live',
    rollup: { kind: 'sum', note: 'Pending and failed counts add across sources only as a state; the overall state is the worst source state.' },
    incomplete: [{ code: 'catching_up', meaning: 'A source has work waiting; its figures may lag the records.' }],
    drill: [],
    doesNotClaim: 'Freshness describes when derived data was last brought up to date, not whether its content is right.',
    changelog: 'First version.',
  },
];

export function definitionDigest(def: MetricDefinition): string {
  return createHash('sha256').update(JSON.stringify(def)).digest('hex');
}

export function currentVersion(id: MetricId): number {
  // `project.completion` stays on the count basis until a later decision changes the default.
  if (id === 'project.completion') return 1;
  return Math.max(...METRIC_DEFINITIONS.filter((d) => d.id === id).map((d) => d.version));
}

export function findDefinition(id: string, version?: number): MetricDefinition | undefined {
  const v = version ?? (METRIC_IDS.includes(id as MetricId) ? currentVersion(id as MetricId) : 0);
  return METRIC_DEFINITIONS.find((d) => d.id === id && d.version === v);
}

export function isMetricId(v: unknown): v is MetricId {
  return typeof v === 'string' && (METRIC_IDS as readonly string[]).includes(v);
}
