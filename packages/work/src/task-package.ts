import { createHash } from 'node:crypto';
import { change, CommandContext, type AuditWriter, type CommandSource } from '@pm/audit';
import {
  newPublicId,
  newUuidV7,
  validateRichText,
  type ExecutionContext,
  type RichTextDoc,
} from '@pm/contracts';
import { evenRanks, rankBetween } from '@pm/contracts/shell';
import { sql, type TaskOriginKind, type WorkspaceTransaction } from '@pm/db';
import { writeOutboxEvent } from '@pm/platform';
import { invalid, issue, type Level, type Principal } from '@pm/tenancy';
import { normalizeLabel } from './task-validation.ts';
import { DESCRIPTION_TEXT_MAX } from './validation.ts';
import { fieldsForRecord, valuesOf, type ResolvedField } from './workflow/field-access.ts';
import { initialStatus, resolveWorkflow } from './workflow/statuses.ts';

/**
 * Task package, schema version 1 (0B ADR-24, ADR-0016 D1–D2). The one serialization of a task's
 * reusable content, used by task templates and recurring-task snapshots.
 *
 * Copied: the task's own planning fields, its checklist text (reset to not done), its own criteria,
 * label names (resolved in the destination brand), URL links, and custom field values the
 * serializer may read and edit (values without person or label references).
 *
 * Never copied: assignees, shares, history and audit, comments, relationships, links to other
 * records, approvals, completion facts, subtasks, recurrence identity, or hidden field values.
 */
export interface TaskPackage {
  schema_version: 1;
  kind: 'task';
  task: {
    title: string;
    description_rich: RichTextDoc | null;
    priority: string;
    estimate_minutes: number | null;
    expected_deliverable_type: string | null;
    expected_deliverable_detail: string | null;
    requires_acceptance: boolean;
  };
  checklist: string[];
  criteria: Array<{ kind: 'acceptance' | 'definition_of_done'; text: string; required: boolean }>;
  labels: string[];
  links: Array<{ url: string; title: string | null }>;
  fields: Array<{ definition: string; value: unknown }>;
}

/** What a task package never carries (reported to the person). */
export const TASK_NOT_COPIED = [
  'assignees',
  'shares',
  'history',
  'comments',
  'relationships',
  'record_links',
  'approvals',
  'completion',
  'subtasks',
] as const;

/** Content left out at serialization or application, by kind (never by value). */
export type TaskOmission =
  | (typeof TASK_NOT_COPIED)[number]
  | 'hidden_fields'
  | 'reference_fields'
  | 'unavailable_fields'
  | 'unavailable_labels';

/** Field types whose stored values carry no person, label, or record reference. */
const COPYABLE_FIELD_TYPES = new Set([
  'text',
  'number',
  'percentage',
  'currency',
  'date',
  'checkbox',
  'url',
  'email',
  'select',
]);

export function taskPackageItems(pkg: TaskPackage): number {
  return (
    1 +
    pkg.checklist.length +
    pkg.criteria.length +
    pkg.labels.length +
    pkg.links.length +
    pkg.fields.length
  );
}

const sha = (v: unknown) =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify(v ?? null))
    .digest('hex')}`;

/**
 * Serializes a task's reusable content for `p` (who has already been authorized to read the
 * task). Custom field values are included only where `p` may read and edit them.
 */
export async function serializeTask(
  tx: WorkspaceTransaction,
  p: Principal,
  task: { id: string; brandId: string; projectId: string | null; level: Level },
  maxItems: number,
): Promise<{ pkg: TaskPackage; omitted: TaskOmission[] }> {
  const t = await tx.db
    .selectFrom('work.task')
    .select([
      'title',
      'description_rich',
      'priority',
      'estimate_minutes',
      'expected_deliverable_type',
      'expected_deliverable_detail',
      'requires_acceptance',
    ])
    .where('id', '=', task.id)
    .executeTakeFirstOrThrow();
  const checklist = await tx.db
    .selectFrom('work.checklist_item')
    .select('text')
    .where('task_id', '=', task.id)
    .orderBy('rank')
    .orderBy('id')
    .execute();
  const criteria = await tx.db
    .selectFrom('work.criteria_item')
    .select(['kind', 'text', 'required'])
    .where('task_id', '=', task.id)
    .orderBy('kind')
    .orderBy('rank')
    .orderBy('id')
    .execute();
  const labels = await tx.db
    .selectFrom('work.task_label as tl')
    .innerJoin('work.label as l', 'l.id', 'tl.label_id')
    .select('l.name')
    .where('tl.task_id', '=', task.id)
    .where('l.state', '=', 'active')
    .orderBy('l.rank')
    .orderBy('l.id')
    .execute();
  const links = await tx.db
    .selectFrom('relations.record_link')
    .select(['target_kind', 'url', 'title'])
    .where('source_record_id', '=', task.id)
    .orderBy('rank')
    .orderBy('id')
    .execute();
  const omitted = new Set<TaskOmission>(TASK_NOT_COPIED);
  const resolved = await fieldsForRecord(
    tx,
    p,
    { id: task.id, kind: 'task', brandId: task.brandId, projectId: task.projectId },
    task.level,
  );
  const values = await valuesOf(tx, task.id);
  const fields: TaskPackage['fields'] = [];
  for (const f of resolved) {
    const v = values.get(f.def.id);
    if (!v || v.computed || f.def.field_type === 'formula' || f.def.state !== 'active') continue;
    if (!f.readable || !f.editable) {
      omitted.add('hidden_fields');
      continue;
    }
    if (!COPYABLE_FIELD_TYPES.has(f.def.field_type)) {
      omitted.add('reference_fields');
      continue;
    }
    fields.push({ definition: f.def.public_id, value: v.value });
  }
  const pkg: TaskPackage = {
    schema_version: 1,
    kind: 'task',
    task: {
      title: t.title,
      description_rich: (t.description_rich as RichTextDoc | null) ?? null,
      priority: t.priority,
      estimate_minutes: t.estimate_minutes,
      expected_deliverable_type: t.expected_deliverable_type,
      expected_deliverable_detail: t.expected_deliverable_detail,
      requires_acceptance: t.requires_acceptance,
    },
    checklist: checklist.map((c) => c.text),
    criteria: criteria.map((c) => ({
      kind: c.kind as 'acceptance' | 'definition_of_done',
      text: c.text,
      required: c.required,
    })),
    labels: labels.map((l) => l.name),
    links: links
      .filter((l) => l.target_kind === 'url' && l.url)
      .map((l) => ({ url: l.url!, title: l.title })),
    fields,
  };
  if (links.some((l) => l.target_kind !== 'url')) omitted.add('record_links');
  if (taskPackageItems(pkg) > maxItems)
    throw invalid(
      issue('/task', 'template_too_large', `A task template can hold at most ${maxItems} items.`),
    );
  return { pkg, omitted: [...omitted].sort() };
}

const str = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length >= 1 && v.length <= max;

/** Validates a stored task package (templates and snapshots are re-read defensively). */
export function readTaskPackage(raw: unknown, maxItems: number): TaskPackage {
  const bad = () =>
    invalid(issue('/template', 'template_invalid', "This template can't be used for a task."));
  if (typeof raw !== 'object' || raw === null) throw bad();
  const p = raw as Partial<TaskPackage>;
  if (p.schema_version !== 1 || p.kind !== 'task' || typeof p.task !== 'object' || !p.task)
    throw bad();
  if (!str(p.task.title, 300)) throw bad();
  if (p.task.description_rich !== null && p.task.description_rich !== undefined) {
    const r = validateRichText(p.task.description_rich, DESCRIPTION_TEXT_MAX);
    if (!r.ok) throw bad();
  }
  for (const k of ['checklist', 'criteria', 'labels', 'links', 'fields'] as const)
    if (!Array.isArray(p[k])) throw bad();
  if (!p.checklist!.every((c) => str(c, 500))) throw bad();
  if (
    !p.criteria!.every(
      (c) =>
        (c.kind === 'acceptance' || c.kind === 'definition_of_done') &&
        str(c.text, 500) &&
        typeof c.required === 'boolean',
    )
  )
    throw bad();
  if (!p.labels!.every((l) => str(l, 60))) throw bad();
  if (!p.links!.every((l) => str(l.url, 2000) && (l.title === null || str(l.title, 200))))
    throw bad();
  if (!p.fields!.every((f) => str(f.definition, 40))) throw bad();
  const pkg = p as TaskPackage;
  if (taskPackageItems(pkg) > maxItems) throw bad();
  return pkg;
}

export interface TaskInstanceContext {
  writer: AuditWriter;
  exec: ExecutionContext;
  source: CommandSource;
  /** The person the new task is created for (field edit authority is theirs). */
  principal: Principal;
}

export interface TaskInstanceInput {
  brandId: string;
  projectId: string | null;
  pkg: TaskPackage;
  overrides: { title?: string; due_date?: string | null };
  origin: { kind: TaskOriginKind; ref: Record<string, string | number> };
  /** The applying principal's level in the destination (for field edit policy). */
  level: Level;
  recurrence?: { seriesId: string; occurrenceKey: string } | null;
  itemsMax: number;
}

/**
 * Creates one task from a validated package in the caller's workspace transaction: envelope, typed
 * row (origin set once), checklist (reset), criteria, labels that exist in the destination brand,
 * URL links, and custom field values the principal may edit there. Returns what was copied and,
 * by kind, what was left out. Recurrence idempotency comes from the occurrence uniqueness.
 */
export async function instantiateTask(
  tx: WorkspaceTransaction,
  ctx: TaskInstanceContext,
  input: TaskInstanceInput,
): Promise<{
  id: string;
  publicId: string;
  copied: { checklist: number; criteria: number; labels: number; links: number; fields: number };
  omitted: TaskOmission[];
}> {
  const pkg = input.pkg;
  const cmd = CommandContext.fromExecution(ctx.exec, ctx.source, { brandId: input.brandId });
  const id = newUuidV7();
  const publicId = newPublicId('tsk');
  await tx.db
    .insertInto('core.record')
    .values({
      id,
      public_id: publicId,
      record_type: 'task',
      workspace_id: tx.workspaceId,
      brand_id: input.brandId,
      source_kind: ctx.source.kind,
      source_ref: null,
      created_by_actor_type: cmd.actor.type,
      created_by_actor_id: cmd.actor.id,
    })
    .execute();
  const initial = initialStatus(
    'task',
    await resolveWorkflow(tx, 'task', {
      workspaceId: tx.workspaceId,
      brandId: input.brandId,
      projectId: input.projectId,
    }),
  );
  const last = await tx.db
    .selectFrom('work.task')
    .select((eb) => eb.fn.max('rank').as('r'))
    .where('brand_id', '=', input.brandId)
    .where('parent_task_id', 'is', null)
    .$call((q) =>
      input.projectId
        ? q.where('project_id', '=', input.projectId)
        : q.where('project_id', 'is', null),
    )
    .executeTakeFirst();
  const rank = rankBetween((last?.r as string | null) ?? null, null) ?? evenRanks(1)[0]!;
  const title = input.overrides.title ?? pkg.task.title;
  const due = input.overrides.due_date ?? null;
  await tx.db
    .insertInto('work.task')
    .values({
      id,
      workspace_id: tx.workspaceId,
      brand_id: input.brandId,
      scope_key: input.brandId,
      project_id: input.projectId,
      parent_task_id: null,
      ancestor_ids: [],
      depth: 0,
      title,
      description_rich: pkg.task.description_rich
        ? JSON.stringify(pkg.task.description_rich)
        : null,
      status_id: initial.id,
      status_category: 'planned',
      priority: pkg.task.priority,
      due_date: due,
      estimate_minutes: pkg.task.estimate_minutes,
      expected_deliverable_type: pkg.task.expected_deliverable_type,
      expected_deliverable_detail: pkg.task.expected_deliverable_detail,
      requires_acceptance: pkg.task.requires_acceptance,
      rank,
      created_by_membership_id: ctx.principal.membershipId,
      origin_kind: input.origin.kind,
      origin_ref: JSON.stringify(input.origin.ref),
      recurrence_series_id: input.recurrence?.seriesId ?? null,
      occurrence_key: input.recurrence?.occurrenceKey ?? null,
    })
    .execute();
  const omitted = new Set<TaskOmission>(TASK_NOT_COPIED);
  const ranks = (n: number) => evenRanks(Math.max(n, 1));
  const checklistRanks = ranks(pkg.checklist.length);
  for (const [i, text] of pkg.checklist.entries())
    await tx.db
      .insertInto('work.checklist_item')
      .values({
        id: newUuidV7(),
        public_id: newPublicId('chk'),
        workspace_id: tx.workspaceId,
        brand_id: input.brandId,
        task_id: id,
        text,
        rank: checklistRanks[i]!,
      })
      .execute();
  const criteriaRanks = ranks(pkg.criteria.length);
  for (const [i, c] of pkg.criteria.entries())
    await tx.db
      .insertInto('work.criteria_item')
      .values({
        id: newUuidV7(),
        public_id: newPublicId('cri'),
        workspace_id: tx.workspaceId,
        brand_id: input.brandId,
        owner_kind: 'task',
        project_id: null,
        task_id: id,
        kind: c.kind,
        text: c.text,
        rank: criteriaRanks[i]!,
        required: c.required,
      })
      .execute();
  let labels = 0;
  if (pkg.labels.length) {
    const found = await tx.db
      .selectFrom('work.label')
      .select(['id', 'normalized_name'])
      .where('brand_id', '=', input.brandId)
      .where('state', '=', 'active')
      .where(
        'normalized_name',
        'in',
        pkg.labels.map((l) => normalizeLabel(l)),
      )
      .execute();
    const byName = new Map(found.map((l) => [l.normalized_name, l.id]));
    for (const name of pkg.labels) {
      const labelId = byName.get(normalizeLabel(name));
      if (!labelId) {
        omitted.add('unavailable_labels');
        continue;
      }
      await tx.db
        .insertInto('work.task_label')
        .values({
          workspace_id: tx.workspaceId,
          brand_id: input.brandId,
          task_id: id,
          label_id: labelId,
          added_by_membership_id: ctx.principal.membershipId,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      labels++;
    }
  }
  const linkRanks = ranks(pkg.links.length);
  for (const [i, l] of pkg.links.entries())
    await tx.db
      .insertInto('relations.record_link')
      .values({
        id: newUuidV7(),
        public_id: newPublicId('lnk'),
        workspace_id: tx.workspaceId,
        source_record_id: id,
        target_kind: 'url',
        url: l.url,
        target_record_id: null,
        title: l.title,
        rank: linkRanks[i]!,
        created_by_membership_id: ctx.principal.membershipId,
      })
      .execute();
  let fields = 0;
  if (pkg.fields.length) {
    const resolved = await fieldsForRecord(
      tx,
      ctx.principal,
      { id, kind: 'task', brandId: input.brandId, projectId: input.projectId },
      input.level,
    );
    const byPublic = new Map<string, ResolvedField>(resolved.map((f) => [f.def.public_id, f]));
    for (const fv of pkg.fields) {
      const f = byPublic.get(fv.definition);
      if (
        !f ||
        f.def.state !== 'active' ||
        !f.readable ||
        !f.editable ||
        !COPYABLE_FIELD_TYPES.has(f.def.field_type) ||
        !(await valueStillValid(tx, f, fv.value))
      ) {
        omitted.add('unavailable_fields');
        continue;
      }
      await tx.db
        .insertInto('workflow.field_value')
        .values({
          workspace_id: tx.workspaceId,
          brand_id: input.brandId,
          definition_id: f.def.id,
          record_id: id,
          value: JSON.stringify(fv.value),
          updated_by_membership_id: ctx.principal.membershipId,
        })
        .execute();
      fields++;
    }
  }
  await ctx.writer.write(tx, cmd, {
    action: 'task.created',
    target: { recordId: id, type: 'task', publicId },
    changes: [
      change.content('title', { hash: sha(title) }),
      change.plain('origin', null, input.origin.kind),
      ...Object.entries(input.origin.ref).map(([k, v]) => change.plain(`origin.${k}`, null, v)),
      change.plain('project', null, input.projectId ? 'set' : null),
      change.plain('due_date', null, due),
    ],
  });
  await writeOutboxEvent(tx, {
    type: 'work.task.created',
    aggregate: { type: 'work.task', id, sequence: 0 },
    data: {
      project_id: input.projectId,
      parent_task_id: null,
      status_id: initial.id,
      source_kind: ctx.source.kind,
    },
    actor: {
      type: ctx.exec.effectivePrincipal.type === 'member' ? 'human' : 'system',
      id: ctx.exec.effectivePrincipal.id,
    },
    context: ctx.exec,
    brandId: input.brandId,
  });
  return {
    id,
    publicId,
    copied: {
      checklist: pkg.checklist.length,
      criteria: pkg.criteria.length,
      labels,
      links: pkg.links.length,
      fields,
    },
    omitted: [...omitted].sort(),
  };
}

/** A select value must still name an active option; other copyable values are self-contained. */
async function valueStillValid(tx: WorkspaceTransaction, f: ResolvedField, value: unknown) {
  if (value === null || value === undefined) return false;
  if (f.def.field_type !== 'select') return true;
  if (typeof value !== 'string') return false;
  const o = await tx.db
    .selectFrom('workflow.field_option')
    .select('id')
    .where('definition_id', '=', f.def.id)
    .where('id', '=', value)
    .where('state', '=', 'active')
    .executeTakeFirst();
  return !!o;
}

/** Deterministic duplicate key and label matching: trimmed, single-spaced, lower case. */
export function normalizeTitle(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The SQL twin of {@link normalizeTitle} (matches the `task_duplicate_probe` index expression). */
export const normalizedTitleSql = sql<string>`lower(regexp_replace(t.title, '\\s+', ' ', 'g'))`;
