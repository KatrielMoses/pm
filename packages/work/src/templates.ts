import { validateRichText, type RichTextDoc } from '@pm/contracts';
import type { WorkspaceTransaction } from '@pm/db';
import { invalid, issue } from '@pm/tenancy';
import { DESCRIPTION_TEXT_MAX } from './validation.ts';

/**
 * Project template package, schema version 1 (0B ADR-21, OD-14). The only serialization of project
 * structure, used by "save as template", "create from template", duplicate, and recurrence
 * snapshots.
 *
 * Copied: the project's own planning fields, phases, milestones (with their phase), success and
 * definition-of-done criteria, and scope entries. Dates become day offsets from the project start
 * so each instance lands on its own calendar.
 *
 * Never copied: owners and collaborators (personal data and authority), shares, dependencies
 * (cross-record and possibly cross-brand references), updates, decisions, activity and audit,
 * recurrence identity, health, completion, intake provenance, and anything from a later module.
 */
export interface TemplatePackage {
  schema_version: 1;
  project: {
    name: string;
    /** Rich text version 1 (0D PL-23), or null. */
    description_rich: RichTextDoc | null;
    icon: string | null;
    color: string | null;
    priority: string;
    time_budget_minutes: number | null;
    duration_days: number | null;
  };
  phases: Array<{
    key: string;
    name: string;
    start_offset_days: number | null;
    end_offset_days: number | null;
  }>;
  milestones: Array<{ name: string; phase_key: string | null; due_offset_days: number | null }>;
  criteria: Array<{ kind: 'success' | 'definition_of_done'; text: string }>;
  scope_items: Array<{ kind: string; text: string }>;
}

export function itemCount(pkg: TemplatePackage): number {
  return (
    1 + pkg.phases.length + pkg.milestones.length + pkg.criteria.length + pkg.scope_items.length
  );
}

const days = (from: string | null, to: string | null): number | null =>
  from && to
    ? Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
    : null;

const addDays = (base: string | null, offset: number | null): string | null => {
  if (!base || offset === null) return null;
  const d = new Date(Date.parse(`${base}T00:00:00Z`) + offset * 86_400_000);
  return d.toISOString().slice(0, 10);
};

/** Serializes a project's own structure (the caller authorized reading the project). */
export async function serializeProject(
  tx: WorkspaceTransaction,
  projectId: string,
  maxItems: number,
): Promise<TemplatePackage> {
  const p = await tx.db
    .selectFrom('work.project')
    .select([
      'name',
      'description_rich',
      'icon',
      'color',
      'priority',
      'time_budget_minutes',
      'start_date',
      'target_date',
    ])
    .where('id', '=', projectId)
    .executeTakeFirstOrThrow();
  const phases = await tx.db
    .selectFrom('work.phase')
    .select(['id', 'name', 'start_date', 'end_date'])
    .where('project_id', '=', projectId)
    .where('lifecycle_state', '=', 'active')
    .orderBy('rank')
    .orderBy('id')
    .execute();
  const milestones = await tx.db
    .selectFrom('work.milestone')
    .select(['name', 'phase_id', 'due_date'])
    .where('project_id', '=', projectId)
    .where('lifecycle_state', '=', 'active')
    .orderBy('rank')
    .orderBy('id')
    .execute();
  const criteria = await tx.db
    .selectFrom('work.criteria_item')
    .select(['kind', 'text'])
    .where('project_id', '=', projectId)
    .orderBy('kind')
    .orderBy('rank')
    .orderBy('id')
    .execute();
  const scope = await tx.db
    .selectFrom('work.scope_item')
    .select(['kind', 'text'])
    .where('project_id', '=', projectId)
    .orderBy('kind')
    .orderBy('rank')
    .orderBy('id')
    .execute();
  const keyOf = new Map(phases.map((ph, i) => [ph.id, `p${i + 1}`]));
  const pkg: TemplatePackage = {
    schema_version: 1,
    project: {
      name: p.name,
      description_rich: (p.description_rich as RichTextDoc | null) ?? null,
      icon: p.icon,
      color: p.color,
      priority: p.priority,
      time_budget_minutes: p.time_budget_minutes,
      duration_days: days(p.start_date, p.target_date),
    },
    phases: phases.map((ph) => ({
      key: keyOf.get(ph.id)!,
      name: ph.name,
      start_offset_days: days(p.start_date, ph.start_date),
      end_offset_days: days(p.start_date, ph.end_date),
    })),
    milestones: milestones.map((m) => ({
      name: m.name,
      phase_key: m.phase_id ? (keyOf.get(m.phase_id) ?? null) : null,
      due_offset_days: days(p.start_date, m.due_date),
    })),
    // Project-owned items only (the query is by project_id), so kinds are success | definition_of_done.
    criteria: criteria.map((c) => ({
      kind: c.kind as 'success' | 'definition_of_done',
      text: c.text,
    })),
    scope_items: scope.map((s) => ({ kind: s.kind, text: s.text })),
  };
  if (itemCount(pkg) > maxItems)
    throw invalid(
      issue('/', 'template_too_large', `A template can hold at most ${maxItems} items.`),
    );
  return pkg;
}

/** Validates a stored package (schema version 1) before instantiating it. */
export function readPackage(raw: unknown, maxItems: number): TemplatePackage {
  const ok =
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { schema_version?: unknown }).schema_version === 1 &&
    Array.isArray((raw as TemplatePackage).phases) &&
    Array.isArray((raw as TemplatePackage).milestones) &&
    Array.isArray((raw as TemplatePackage).criteria) &&
    Array.isArray((raw as TemplatePackage).scope_items) &&
    typeof (raw as TemplatePackage).project === 'object' &&
    (raw as TemplatePackage).project !== null;
  const description = ok ? (raw as TemplatePackage).project.description_rich : null;
  const descriptionOk =
    description === null || validateRichText(description, DESCRIPTION_TEXT_MAX).ok;
  if (!ok || !descriptionOk || itemCount(raw as TemplatePackage) > maxItems)
    throw invalid(issue('/template', 'template_invalid', "This template can't be used."));
  return raw as TemplatePackage;
}

/** Dates for an instance starting on `start` (null: no dates are set). */
export function instanceDates(pkg: TemplatePackage, start: string | null) {
  return {
    start_date: start,
    target_date: addDays(start, pkg.project.duration_days),
    phase: (offset: number | null) => addDays(start, offset),
  };
}
