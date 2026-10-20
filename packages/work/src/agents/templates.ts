import { PROFILE_SCHEMA_VERSION, type ProfileKind } from './config.ts';

/**
 * Phase 8B starter agent templates (AGT-008; 10B owns the later catalog). Each instantiates a
 * disabled draft with conservative tools and limits, approvals stricter than the accepted floor,
 * and an empty scope: a person must choose the brands, projects, records, or integrations it may
 * use (and a model or a connector) before it can be turned on. Nothing is copied from another
 * profile, and no credential, grant, or approval comes with a template.
 */
export interface AgentTemplate {
  key: string;
  name: string;
  purpose: string;
  kind: ProfileKind;
  /** Configuration a person still has to provide. */
  needs: Array<'scope' | 'model' | 'connector'>;
  draft: () => Record<string, unknown>;
}

const base = (
  kind: ProfileKind,
  instructions: string,
  tools: string[],
  policy: Record<string, string>,
) => ({
  schema_version: PROFILE_SCHEMA_VERSION,
  kind,
  instructions,
  model_key: null,
  limits: { max_runtime_minutes: 30, max_tool_calls: 50, max_artifacts: 5 },
  tools: tools.map((name) => ({ name, version: '1' })),
  scope: { brands: [], projects: [], records: [], integrations: [] },
  approval_policy: policy,
});

export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    key: 'development',
    name: 'Development agent',
    purpose:
      'Reads assigned engineering tasks, drafts implementation notes, and returns work as draft deliverables.',
    kind: 'external',
    needs: ['scope', 'connector'],
    draft: () =>
      base(
        'external',
        'Work only on the assigned task. Read the task and the context you were given, write notes as a draft document, and return changes as a draft deliverable for review. Never complete, approve, or accept anything.',
        ['pm.tasks.get', 'pm.documents.get', 'pm.documents.draft', 'pm.deliverables.draft_version'],
        { draft_content: 'review_required', attach_artifacts: 'review_required' },
      ),
  },
  {
    key: 'research',
    name: 'Research agent',
    purpose:
      'Reads the assigned task and its chosen context and drafts a research summary for review.',
    kind: 'internal',
    needs: ['scope', 'model'],
    draft: () =>
      base(
        'internal',
        'Summarize what the assigned task and its chosen context say, cite the records you used, and state what is unknown. Write a draft document only.',
        ['pm.tasks.get', 'pm.documents.get', 'pm.documents.draft'],
        { draft_content: 'review_required' },
      ),
  },
  {
    key: 'growth',
    name: 'Growth agent',
    purpose:
      'Drafts growth experiment plans and copy for review; never publishes or sends anything.',
    kind: 'internal',
    needs: ['scope', 'model'],
    draft: () =>
      base(
        'internal',
        'Draft experiment plans and copy as draft documents for a person to review. Do not publish, message, or spend; those are not available to you.',
        ['pm.tasks.get', 'pm.documents.draft'],
        { draft_content: 'review_required' },
      ),
  },
  {
    key: 'documentation',
    name: 'Documentation agent',
    purpose: 'Drafts and updates documentation as draft documents, linked to the assigned task.',
    kind: 'internal',
    needs: ['scope', 'model'],
    draft: () =>
      base(
        'internal',
        'Read the assigned task and the documents chosen as context, then write or revise documentation as a draft for review.',
        ['pm.tasks.get', 'pm.documents.get', 'pm.documents.draft'],
        { draft_content: 'review_required' },
      ),
  },
  {
    key: 'testing',
    name: 'Testing agent',
    purpose:
      'Plans tests for the assigned task and splits follow-up work into subtasks for review.',
    kind: 'external',
    needs: ['scope', 'connector'],
    draft: () =>
      base(
        'external',
        'Write a test plan as a draft document and propose follow-up work as subtasks of the assigned task. Running tests arrives with test management (9B).',
        ['pm.tasks.get', 'pm.documents.draft', 'pm.tasks.create_subtask'],
        { draft_content: 'review_required', create_subtasks: 'review_required' },
      ),
  },
];

export function agentTemplate(key: unknown): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((t) => t.key === key);
}
