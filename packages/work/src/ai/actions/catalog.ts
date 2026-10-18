import type { ProposalOp } from '@pm/db';
import type { SourceKind } from '../retrieval/types.ts';

/**
 * Phase 7C action catalog (ADR-0041 C1). Every AI drafting or analysis feature is one registered,
 * versioned action with declared inputs, required context, permitted source kinds, bounds, output
 * contract, proposal operations, and visible limitations. The action key is chosen by the person
 * and fixed by the server; free text can never switch the action, widen scope, or add a capability.
 * Analysis actions return a validated typed result (`analysis.v1`); drafting actions return a 7D
 * change proposal (`change_proposal.v1`) restricted to the action's operations. 7F adds capture
 * interpretation (`interpretation.v1`): field spans in the person's own text, checked by the server.
 */
export type ActionKind = 'analysis' | 'proposal' | 'interpretation';

/** Context an action needs before anything is sent; missing context refuses with a question. */
export type ActionNeed = 'brief_or_goal' | 'project_or_task' | 'task_or_document' | 'tasks';

export interface AiActionDef {
  key: string;
  version: number;
  label: string;
  kind: ActionKind;
  requirements: readonly string[];
  /** The instruction or brief field: its label and whether it is required. */
  input: { label: string; required: boolean; max: number };
  needs: ActionNeed | null;
  sourceKinds: readonly SourceKind[];
  /** Analysis item kinds the action may return. */
  itemKinds?: readonly string[];
  /** Whether an analysis action returns one editable draft text (status update, release notes). */
  draft?: boolean;
  /** Deterministic server rules that add labelled findings. */
  rules?: 'work_analysis' | 'next_action';
  /** Proposal operations a drafting action may propose. */
  ops?: readonly ProposalOp[];
  /** Whether server-issued label and member choices are offered. */
  choices?: boolean;
  maxOutputTokens: number;
  /** Action-specific instructions (data only; the shared contract template precedes them). */
  instructions: readonly string[];
  limitations: readonly string[];
}

export const actionId = (a: Pick<AiActionDef, 'key' | 'version'>) => `${a.key}.v${a.version}`;

const ALL_SOURCES: readonly SourceKind[] = [
  'task',
  'project',
  'document',
  'comment',
  'activity',
  'goal',
  'meeting',
];
const GENERATED =
  'Generated text is a suggestion: it is not a fact, evidence of completion, or a business result.';
const LEXICAL =
  'Sources are found by keyword search and your choices; relevant records can be missed.';

export const AI_ACTIONS: readonly AiActionDef[] = [
  {
    key: 'interpret_capture',
    version: 1,
    label: 'Interpret a capture',
    kind: 'interpretation',
    requirements: ['CAP-005', 'CAP-003', 'CAP-009'],
    input: { label: 'Capture text', required: true, max: 2000 },
    needs: null,
    sourceKinds: [],
    maxOutputTokens: 512,
    instructions: [
      'The title is the words that describe the work itself. Dates, priority, duration, recurrence, labels, project, brand, and owner are marked only when the note states them.',
    ],
    limitations: [
      'Field spans are suggestions: the server checks each against your text and derives every value itself.',
      'Names resolve only among what you can read now; dates use your time zone and today.',
      'Nothing is saved until you save it to your Inbox.',
    ],
  },
  {
    key: 'summarize',
    version: 1,
    label: 'Summarize',
    kind: 'analysis',
    requirements: ['AI-012', 'AI-001', 'AI-002', 'AI-003', 'AI-004'],
    input: { label: 'What to focus on (optional)', required: false, max: 2000 },
    needs: null,
    sourceKinds: ALL_SOURCES,
    itemKinds: ['summary'],
    maxOutputTokens: 1024,
    instructions: [
      'Summarize the sources. Each item is one point of kind "summary" citing the sources it comes from.',
    ],
    limitations: [
      GENERATED,
      LEXICAL,
      'Meetings are your own calendar events: title and time only.',
    ],
  },
  {
    key: 'extract',
    version: 1,
    label: 'Extract decisions, actions, and risks',
    kind: 'analysis',
    requirements: ['AI-013'],
    input: { label: 'What to look for (optional)', required: false, max: 2000 },
    needs: null,
    sourceKinds: ALL_SOURCES,
    itemKinds: ['decision', 'action_item', 'risk', 'blocker', 'assumption', 'open_question'],
    maxOutputTokens: 1024,
    instructions: [
      'Extract items of kind decision, action_item, risk, blocker, assumption, or open_question.',
      'An extracted item is a candidate interpretation of the cited text, not a recorded decision or task.',
    ],
    limitations: [
      GENERATED,
      'Extracted items are candidates: nothing is recorded until you create it yourself.',
    ],
  },
  {
    key: 'analyze_work',
    version: 1,
    label: 'Find duplicate, stale, ambiguous, or conflicting work',
    kind: 'analysis',
    requirements: ['AI-019'],
    input: { label: 'What to check (optional)', required: false, max: 2000 },
    needs: 'tasks',
    sourceKinds: ['task', 'project', 'document', 'comment'],
    itemKinds: ['duplicate', 'stale', 'ambiguous', 'conflict'],
    rules: 'work_analysis',
    maxOutputTokens: 1024,
    instructions: [
      'Report possible duplicate, stale, ambiguous, or conflicting work among the sources, each citing every source involved and explaining why.',
      'A finding is a suggestion to review, never a merge, a status change, or a diagnosis.',
    ],
    limitations: [
      'Rule findings come from the records (overdue dates, identical titles, impossible dates); generated findings are suggestions.',
      'Only work you can read now is considered.',
    ],
  },
  {
    key: 'recommend_next',
    version: 1,
    label: 'Recommend the next action',
    kind: 'analysis',
    requirements: ['AI-020', 'AI-022'],
    input: { label: 'Your goal for today (optional)', required: false, max: 2000 },
    needs: 'tasks',
    sourceKinds: ['task', 'project', 'document', 'comment', 'goal'],
    itemKinds: ['recommendation'],
    rules: 'next_action',
    maxOutputTokens: 1024,
    instructions: [
      'Recommend next actions, each of kind "recommendation", citing the linked records and giving the reasoning.',
    ],
    limitations: [
      'Rule recommendations name the configured rule (overdue, due soon); generated recommendations are suggestions.',
      'Capacity-based postponement is not part of this action.',
    ],
  },
  {
    key: 'draft_status_update',
    version: 1,
    label: 'Draft a status update',
    kind: 'analysis',
    requirements: ['AI-016'],
    input: { label: 'Audience or emphasis (optional)', required: false, max: 2000 },
    needs: null,
    sourceKinds: ['task', 'project', 'document', 'comment', 'activity', 'goal'],
    itemKinds: ['highlight', 'risk'],
    draft: true,
    maxOutputTokens: 1536,
    instructions: [
      'Write a status update as "draft" (plain text) and list its key points as items of kind highlight or risk, each citing sources.',
      'Never state completion, results, or dates the sources do not contain.',
    ],
    limitations: [GENERATED, 'The draft is text to copy and edit; it is not posted anywhere.'],
  },
  {
    key: 'draft_release_notes',
    version: 1,
    label: 'Draft release notes',
    kind: 'analysis',
    requirements: ['AI-016'],
    input: { label: 'Release name or audience (optional)', required: false, max: 2000 },
    needs: null,
    sourceKinds: ['task', 'project', 'document', 'comment'],
    itemKinds: ['change'],
    draft: true,
    maxOutputTokens: 1536,
    instructions: [
      'Write release-note text as "draft" (plain text) and list each change as an item of kind change citing its sources.',
      'Readiness, acceptance, and shipping cannot be inferred from the sources: do not claim them.',
    ],
    limitations: [
      GENERATED,
      'Draft text only: nothing is published and release readiness is not assessed.',
    ],
  },
  {
    key: 'draft_project',
    version: 1,
    label: 'Draft a project plan',
    kind: 'proposal',
    requirements: ['AI-014', 'PRJ-016', 'AI-015'],
    input: { label: 'Extra guidance (optional)', required: false, max: 2000 },
    needs: 'brief_or_goal',
    sourceKinds: ALL_SOURCES,
    ops: [
      'project.create',
      'task.create',
      'milestone.create',
      'relation.add',
      'criterion.add',
      'task.assign',
      'label.add',
    ],
    choices: true,
    maxOutputTokens: 2048,
    instructions: [
      'Draft one new project (project.create with brand "scope") with its tasks, subtasks, milestones, dependencies (relation.add kind blocks), estimates (estimate_minutes), and acceptance criteria (criterion.add).',
      'Use only offered choices (L…, M…) for labels and assignees, and only when the brief or sources support them.',
      'If the brief lacks something essential (the goal, the scope, or a date the plan depends on), ask questions instead of inventing it, and list assumptions you make.',
      'Never propose a task as already done.',
    ],
    limitations: [
      'Every change is a proposal you review, edit, select, approve, and apply yourself.',
      'Estimates and dates are suggestions in minutes and workspace dates.',
    ],
  },
  {
    key: 'draft_tasks',
    version: 1,
    label: 'Draft tasks, milestones, and dependencies',
    kind: 'proposal',
    requirements: ['AI-015'],
    input: { label: 'What to plan', required: true, max: 4000 },
    needs: 'project_or_task',
    sourceKinds: ALL_SOURCES,
    ops: [
      'task.create',
      'task.update',
      'milestone.create',
      'relation.add',
      'criterion.add',
      'task.assign',
      'label.add',
    ],
    choices: true,
    maxOutputTokens: 2048,
    instructions: [
      'Draft tasks or subtasks under the scope project or task, with milestones, dependencies, estimates (estimate_minutes), and acceptance criteria (criterion.add).',
      'Use only offered choices (L…, M…) for labels and assignees.',
    ],
    limitations: ['Every change is a proposal you review and apply yourself.'],
  },
  {
    key: 'rewrite',
    version: 1,
    label: 'Rewrite a description or document',
    kind: 'proposal',
    requirements: ['AI-017'],
    input: { label: 'How to improve it', required: true, max: 2000 },
    needs: 'task_or_document',
    sourceKinds: ['task', 'document', 'project', 'comment'],
    ops: ['task.update', 'document.replace'],
    maxOutputTokens: 2048,
    instructions: [
      'Rewrite the description of a task source (task.update description) or the text of a document source (document.replace text). Keep its meaning and every fact it states.',
    ],
    limitations: [
      'A document rewrite replaces its text as a new version after you apply it; review removed text before applying.',
    ],
  },
  {
    key: 'categorize',
    version: 1,
    label: 'Categorize, label, assign, and prioritize',
    kind: 'proposal',
    requirements: ['AI-018'],
    input: { label: 'Guidance (optional)', required: false, max: 2000 },
    needs: 'tasks',
    sourceKinds: ['task', 'project', 'document', 'comment'],
    ops: ['task.update', 'label.add', 'task.assign'],
    choices: true,
    maxOutputTokens: 1536,
    instructions: [
      'Propose priorities (task.update priority), labels (label.add with an offered L… choice), and assignees (task.assign with offered M… choices) for task sources.',
    ],
    limitations: [
      'Only existing labels and members you may assign are offered; nothing new is created.',
    ],
  },
];

export const ACTION_BY_ID: ReadonlyMap<string, AiActionDef> = new Map(
  AI_ACTIONS.map((a) => [actionId(a), a]),
);

/** The catalog as shown to clients (no templates beyond the declared contract). */
export function actionView(a: AiActionDef) {
  return {
    id: actionId(a),
    label: a.label,
    kind: a.kind,
    requirements: a.requirements,
    input: a.input,
    needs: a.needs,
    source_kinds: a.sourceKinds,
    item_kinds: a.itemKinds ?? [],
    draft: !!a.draft,
    rules: a.rules ?? null,
    operations: a.ops ?? [],
    choices: !!a.choices,
    max_output_tokens: a.maxOutputTokens,
    limitations: a.limitations,
  };
}
