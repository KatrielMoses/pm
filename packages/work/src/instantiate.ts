import { change, CommandContext, type AuditWriter, type CommandSource } from '@pm/audit';
import { newPublicId, newUuidV7, type ExecutionContext } from '@pm/contracts';
import { evenRanks } from '@pm/contracts/shell';
import type { WorkspaceTransaction } from '@pm/db';
import { writeOutboxEvent } from '@pm/platform';
import { invalid, issue } from '@pm/tenancy';
import { instanceDates, itemCount, type TemplatePackage } from './templates.ts';
import { createHash } from 'node:crypto';

const STATUS_PLANNED = '01920000-0000-7000-8000-000000000001';

export interface InstantiateContext {
  writer: AuditWriter;
  exec: ExecutionContext;
  source: CommandSource;
  /** The accountable owner and manager of the new project (an active internal member). */
  ownerMembershipId: string;
  /** Writes the explicit project manage grant (direct for API commands, definer for the worker). */
  grantManager(tx: WorkspaceTransaction, projectId: string, membershipId: string): Promise<void>;
}

export interface InstantiateInput {
  brandId: string;
  parent: { id: string; ancestorIds: readonly string[]; depth: number } | null;
  depthMax: number;
  maxItems: number;
  pkg: TemplatePackage;
  overrides: { name?: string; start_date?: string | null };
  rank: string;
  recurrence?: { seriesId: string; occurrenceKey: string } | null;
  templateVersionId?: string | null;
}

export interface Copied {
  phases: number;
  milestones: number;
  criteria: number;
  scope_items: number;
}

/** What instantiation never copies (reported to the person, 0B ADR-21). */
export const NOT_COPIED = [
  'owners_and_collaborators',
  'shares',
  'dependencies',
  'updates',
  'decisions',
  'activity_and_audit',
  'health_and_completion',
  'recurrence',
] as const;

const hash = (v: unknown) =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify(v ?? null))
    .digest('hex')}`;

/**
 * Creates one project and its copied structure from a validated template package, in the
 * caller's workspace transaction. The project's envelope, typed row, structure rows, manager grant,
 * audit event, and outbox events commit together. Idempotency for recurrence comes from the
 * `(recurrence_series_id, occurrence_key)` uniqueness (a duplicate raises 23505 for the caller).
 */
export async function instantiatePackage(
  tx: WorkspaceTransaction,
  ctx: InstantiateContext,
  input: InstantiateInput,
): Promise<{ id: string; publicId: string; copied: Copied }> {
  const pkg = input.pkg;
  if (itemCount(pkg) > input.maxItems)
    throw invalid(
      issue(
        '/template',
        'template_too_large',
        `A template can hold at most ${input.maxItems} items.`,
      ),
    );
  const depth = input.parent ? input.parent.depth + 1 : 0;
  if (depth > input.depthMax)
    throw invalid(
      issue(
        '/parent',
        'depth_exceeded',
        `Projects can be nested at most ${input.depthMax} levels deep.`,
      ),
    );
  const cmd = CommandContext.fromExecution(ctx.exec, ctx.source, { brandId: input.brandId });
  const id = newUuidV7();
  const publicId = newPublicId('prj');
  const dates = instanceDates(pkg, input.overrides.start_date ?? null);
  await tx.db
    .insertInto('core.record')
    .values({
      id,
      public_id: publicId,
      record_type: 'project',
      workspace_id: tx.workspaceId,
      brand_id: input.brandId,
      source_kind: ctx.source.kind,
      source_ref: null,
      created_by_actor_type: cmd.actor.type,
      created_by_actor_id: cmd.actor.id,
    })
    .execute();
  await tx.db
    .insertInto('work.project')
    .values({
      id,
      workspace_id: tx.workspaceId,
      brand_id: input.brandId,
      scope_key: input.brandId,
      parent_project_id: input.parent?.id ?? null,
      ancestor_ids: input.parent ? [...input.parent.ancestorIds, input.parent.id] : [],
      depth,
      name: input.overrides.name ?? pkg.project.name,
      description_rich: pkg.project.description_rich
        ? JSON.stringify(pkg.project.description_rich)
        : null,
      icon: pkg.project.icon,
      color: pkg.project.color,
      status_id: STATUS_PLANNED,
      priority: pkg.project.priority as never,
      start_date: dates.start_date,
      target_date: dates.target_date,
      owner_membership_id: ctx.ownerMembershipId,
      time_budget_minutes: pkg.project.time_budget_minutes,
      rank: input.rank,
      recurrence_series_id: input.recurrence?.seriesId ?? null,
      occurrence_key: input.recurrence?.occurrenceKey ?? null,
      created_by_membership_id: ctx.ownerMembershipId,
    })
    .execute();
  await ctx.grantManager(tx, id, ctx.ownerMembershipId);

  // Phases first (milestones reference them by package key).
  const phaseIds = new Map<string, string>();
  const phaseRanks = evenRanks(pkg.phases.length);
  for (const [i, ph] of pkg.phases.entries()) {
    const pid = newUuidV7();
    phaseIds.set(ph.key, pid);
    await tx.db
      .insertInto('core.record')
      .values({
        id: pid,
        public_id: newPublicId('phs'),
        record_type: 'phase',
        workspace_id: tx.workspaceId,
        brand_id: input.brandId,
        source_kind: ctx.source.kind,
        source_ref: null,
        created_by_actor_type: cmd.actor.type,
        created_by_actor_id: cmd.actor.id,
      })
      .execute();
    await tx.db
      .insertInto('work.phase')
      .values({
        id: pid,
        workspace_id: tx.workspaceId,
        brand_id: input.brandId,
        scope_key: input.brandId,
        project_id: id,
        name: ph.name,
        rank: phaseRanks[i]!,
        start_date: dates.phase(ph.start_offset_days),
        end_date: dates.phase(ph.end_offset_days),
      })
      .execute();
  }
  const milestoneRanks = evenRanks(pkg.milestones.length);
  for (const [i, m] of pkg.milestones.entries()) {
    const mid = newUuidV7();
    await tx.db
      .insertInto('core.record')
      .values({
        id: mid,
        public_id: newPublicId('ms'),
        record_type: 'milestone',
        workspace_id: tx.workspaceId,
        brand_id: input.brandId,
        source_kind: ctx.source.kind,
        source_ref: null,
        created_by_actor_type: cmd.actor.type,
        created_by_actor_id: cmd.actor.id,
      })
      .execute();
    await tx.db
      .insertInto('work.milestone')
      .values({
        id: mid,
        workspace_id: tx.workspaceId,
        brand_id: input.brandId,
        scope_key: input.brandId,
        project_id: id,
        phase_id: m.phase_key ? (phaseIds.get(m.phase_key) ?? null) : null,
        name: m.name,
        rank: milestoneRanks[i]!,
        due_date: dates.phase(m.due_offset_days),
      })
      .execute();
  }
  const criteriaRanks = evenRanks(pkg.criteria.length);
  for (const [i, c] of pkg.criteria.entries())
    await tx.db
      .insertInto('work.criteria_item')
      .values({
        id: newUuidV7(),
        public_id: newPublicId('cri'),
        workspace_id: tx.workspaceId,
        brand_id: input.brandId,
        project_id: id,
        kind: c.kind,
        text: c.text,
        rank: criteriaRanks[i]!,
      })
      .execute();
  const scopeRanks = evenRanks(pkg.scope_items.length);
  for (const [i, s] of pkg.scope_items.entries())
    await tx.db
      .insertInto('work.scope_item')
      .values({
        id: newUuidV7(),
        public_id: newPublicId('sco'),
        workspace_id: tx.workspaceId,
        brand_id: input.brandId,
        project_id: id,
        kind: s.kind as never,
        text: s.text,
        rank: scopeRanks[i]!,
      })
      .execute();
  const copied: Copied = {
    phases: pkg.phases.length,
    milestones: pkg.milestones.length,
    criteria: pkg.criteria.length,
    scope_items: pkg.scope_items.length,
  };
  await ctx.writer.write(tx, cmd, {
    action: 'project.created',
    target: { recordId: id, type: 'project', publicId },
    changes: [
      change.content('name', { hash: hash(input.overrides.name ?? pkg.project.name) }),
      change.plain('status', null, 'planned'),
      change.plain('source', null, ctx.source.kind),
      change.plain('copied_phases', null, copied.phases),
      change.plain('copied_milestones', null, copied.milestones),
      change.plain('copied_criteria', null, copied.criteria),
      change.plain('copied_scope_items', null, copied.scope_items),
      ...(input.recurrence
        ? [change.plain('occurrence_key', null, input.recurrence.occurrenceKey)]
        : []),
    ],
  });
  const actor = ctx.exec.effectivePrincipal;
  await writeOutboxEvent(tx, {
    type: 'work.project.created',
    aggregate: { type: 'work.project', id, sequence: 0 },
    data: { parent_project_id: input.parent?.id ?? null, status_id: STATUS_PLANNED },
    actor: { type: actor.type === 'member' ? 'human' : 'system', id: actor.id },
    context: ctx.exec,
    brandId: input.brandId,
  });
  if (input.templateVersionId)
    await writeOutboxEvent(tx, {
      type: 'templates.template.applied',
      aggregate: { type: 'templates.template', id: input.templateVersionId, sequence: 0 },
      data: { template_version_id: input.templateVersionId, record_id: id },
      actor: { type: actor.type === 'member' ? 'human' : 'system', id: actor.id },
      context: ctx.exec,
      brandId: input.brandId,
    });
  return { id, publicId, copied };
}
