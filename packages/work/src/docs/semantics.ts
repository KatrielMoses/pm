import type { DocContent, Block, Run } from './content.ts';

/**
 * Document semantics (ADR-0025): types and their placement, states, the review date, built-in
 * typed starters, and the rules for staleness and tree moves. Pure: no database, no authorization.
 */

export const DOC_TYPES = [
  'page',
  'brand_brief',
  'project_brief',
  'sop',
  'specification',
  'meeting_notes',
  'decision',
  'release_notes',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_TYPE_LABEL: Record<DocType, string> = {
  page: 'Page',
  brand_brief: 'Brand brief',
  project_brief: 'Project brief',
  sop: 'SOP',
  specification: 'Specification',
  meeting_notes: 'Meeting notes',
  decision: 'Decision',
  release_notes: 'Release notes',
};

export const DOC_STATES = ['draft', 'current', 'stale'] as const;
export type DocState = (typeof DOC_STATES)[number];

export type AttachmentKind = 'workspace' | 'brand' | 'project' | 'task';

/** Where each type may live; null means anywhere a page may. */
export function placementError(
  type: DocType,
  where: { brand: boolean; project: boolean; task: boolean; parent: boolean },
): { pointer: string; code: string; message: string } | null {
  if (type === 'brand_brief' && (!where.brand || where.project || where.task || where.parent))
    return {
      pointer: '/type',
      code: 'invalid_placement',
      message: 'A brand brief belongs to a brand, not to a project, task, or page.',
    };
  if (type === 'project_brief' && !where.project)
    return {
      pointer: '/type',
      code: 'invalid_placement',
      message: 'A project brief belongs to a project.',
    };
  return null;
}

/** `current` past its review date is stale: nothing claims to be current when it is overdue. */
export function effectiveState(state: DocState, reviewDueOn: string | null, today: string): DocState {
  return state === 'current' && reviewDueOn !== null && reviewDueOn < today ? 'stale' : state;
}

export const reviewOverdue = (reviewDueOn: string | null, today: string) =>
  reviewDueOn !== null && reviewDueOn < today;

/** The calendar date `days` after `from` (both `YYYY-MM-DD`). */
export function addDays(from: string, days: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const isDate = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/** Whether moving `id` under `newParent` would put a page inside its own subtree. */
export function createsCycle(id: string, newParentAncestors: readonly string[], newParent: string): boolean {
  return newParent === id || newParentAncestors.includes(id);
}

// -------------------------------------------------------------------------------------------
// Built-in typed starters (ADR-0025 D7). A template is a versioned constant, never a catalog.
// -------------------------------------------------------------------------------------------

const t = (text: string): Run[] => [{ text }];
const h = (id: string, level: 1 | 2 | 3, text: string): Block => ({ id, type: 'heading', level, runs: t(text) });
const p = (id: string, text: string): Block => ({ id, type: 'paragraph', runs: t(text) });
const list = (id: string, items: string[]): Block => ({ id, type: 'bulleted_list', items: items.map(t) });
const check = (id: string, items: string[]): Block => ({
  id,
  type: 'checklist',
  items: items.map((s) => ({ runs: t(s), checked: false })),
});

export const TEMPLATE_VERSIONS: Record<DocType, number> = {
  page: 1,
  brand_brief: 1,
  project_brief: 1,
  sop: 1,
  specification: 1,
  meeting_notes: 1,
  decision: 1,
  release_notes: 1,
};

/** The key recorded on a document's first version when it was started from a typed starter. */
export const templateKey = (type: DocType) => `${type}@${TEMPLATE_VERSIONS[type]}`;

const STARTERS: Record<DocType, Block[]> = {
  page: [],
  brand_brief: [
    h('tpl_audience', 2, 'Audience'),
    p('tpl_audience_p', 'Who this brand serves, and what they need.'),
    h('tpl_voice', 2, 'Voice and tone'),
    list('tpl_voice_l', ['How we sound', 'Words we use', 'Words we avoid']),
    h('tpl_positioning', 2, 'Positioning'),
    p('tpl_positioning_p', 'What makes this brand different.'),
    h('tpl_goals', 2, 'Goals'),
    list('tpl_goals_l', ['Goal one', 'Goal two']),
  ],
  project_brief: [
    h('tpl_summary', 2, 'Summary'),
    p('tpl_summary_p', 'What this project is and why it matters.'),
    h('tpl_outcomes', 2, 'Outcomes'),
    list('tpl_outcomes_l', ['What will be true when it is done']),
    h('tpl_scope', 2, 'Scope'),
    list('tpl_scope_l', ['In scope', 'Out of scope']),
    h('tpl_risks', 2, 'Risks and open questions'),
    list('tpl_risks_l', ['Risk or question']),
  ],
  sop: [
    h('tpl_purpose', 2, 'Purpose'),
    p('tpl_purpose_p', 'What this procedure is for and when to use it.'),
    h('tpl_before', 2, 'Before you start'),
    check('tpl_before_c', ['Access you need', 'Information to have ready']),
    h('tpl_steps', 2, 'Steps'),
    { id: 'tpl_steps_l', type: 'numbered_list', items: [t('First step'), t('Second step')] },
    h('tpl_check', 2, 'How to check it worked'),
    p('tpl_check_p', 'What done looks like.'),
  ],
  specification: [
    h('tpl_problem', 2, 'Problem'),
    p('tpl_problem_p', 'What needs solving, and for whom.'),
    h('tpl_requirements', 2, 'Requirements'),
    check('tpl_requirements_c', ['Requirement']),
    h('tpl_design', 2, 'Design'),
    p('tpl_design_p', 'How it will work.'),
    h('tpl_questions', 2, 'Open questions'),
    list('tpl_questions_l', ['Question']),
  ],
  meeting_notes: [
    h('tpl_attendees', 2, 'Attendees'),
    list('tpl_attendees_l', ['Name']),
    h('tpl_agenda', 2, 'Agenda'),
    list('tpl_agenda_l', ['Topic']),
    h('tpl_notes', 2, 'Notes'),
    p('tpl_notes_p', ''),
    h('tpl_actions', 2, 'Action items'),
    check('tpl_actions_c', ['Who does what by when']),
  ],
  decision: [
    h('tpl_context', 2, 'Context'),
    p('tpl_context_p', 'What led to this decision.'),
    h('tpl_decision', 2, 'Decision'),
    p('tpl_decision_p', 'What was decided.'),
    h('tpl_options', 2, 'Options considered'),
    list('tpl_options_l', ['Option and why it was not chosen']),
    h('tpl_consequences', 2, 'Consequences'),
    p('tpl_consequences_p', 'What changes because of it.'),
  ],
  release_notes: [
    h('tpl_highlights', 2, 'Highlights'),
    list('tpl_highlights_l', ['What is new']),
    h('tpl_fixes', 2, 'Fixes'),
    list('tpl_fixes_l', ['What was fixed']),
    h('tpl_known', 2, 'Known issues'),
    list('tpl_known_l', ['What to watch for']),
  ],
};

/** The starter content for a type: an empty paragraph for a blank page. */
export function starterContent(type: DocType): DocContent {
  const blocks = STARTERS[type];
  return {
    v: 2,
    blocks: blocks.length
      ? blocks.filter((b) => !(b.type === 'paragraph' && b.runs.every((r) => !r.text)))
      : [],
  };
}

/** A starter's title when the author gives none. */
export const defaultTitle = (type: DocType) => (type === 'page' ? 'Untitled page' : `New ${DOC_TYPE_LABEL[type].toLowerCase()}`);
