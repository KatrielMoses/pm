import { sql } from '@pm/db';
import {
  brandMarker,
  compileVisibility,
  type NavigationTargetAdapter,
  type NavTarget,
} from '@pm/tenancy';

/**
 * Projects as navigation targets (favorites, recents, palette, breadcrumbs; 0C AZ-20/21): resolved
 * through the one visibility predicate, so an unreadable project is simply absent.
 */
export function projectTargets(arrayMax: number): NavigationTargetAdapter {
  const select = async (
    tx: Parameters<NavigationTargetAdapter['resolve']>[0],
    p: Parameters<NavigationTargetAdapter['resolve']>[1],
    filter: { ids?: readonly string[]; term?: string; limit: number },
  ): Promise<NavTarget[] & { ids?: string[] }> => {
    const vis = await compileVisibility(tx, p, { need: 'view', includeArchived: true, arrayMax });
    let q = tx.db
      .selectFrom('core.record as r')
      .innerJoin('work.project as w', (j) =>
        j.onRef('w.workspace_id', '=', 'r.workspace_id').onRef('w.id', '=', 'r.id'),
      )
      .innerJoin('tenancy.brand as b', 'b.id', 'w.brand_id')
      .innerJoin('core.record as br', 'br.id', 'b.id')
      .select([
        'w.id',
        'r.public_id',
        'w.name',
        'r.lifecycle_state',
        'br.public_id as brand_public_id',
        'b.name as brand_name',
        'b.short_name',
        'b.color',
        'b.icon',
        'b.lifecycle_state as brand_state',
      ])
      .where('r.record_type', '=', 'project')
      .where(vis.where('r', { project: sql`w.id` }));
    if (filter.ids) q = q.where('w.id', 'in', [...filter.ids]);
    if (filter.term) {
      const like = `%${filter.term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      q = q.where('w.name', 'ilike', like).where('r.lifecycle_state', '=', 'active');
    }
    const rows = await q
      .orderBy(sql`lower(w.name)`)
      .orderBy('w.id')
      .limit(filter.limit)
      .execute();
    const out = rows.map((r) =>
      Object.assign(
        {
          id: r.public_id,
          type: 'project' as const,
          label: r.name,
          brand: brandMarker({
            public_id: r.brand_public_id,
            name: r.brand_name,
            short_name: r.short_name,
            color: r.color,
            icon: r.icon,
            lifecycle_state: r.brand_state,
          }),
          lifecycle_state: r.lifecycle_state as 'active' | 'archived',
        },
        { _id: r.id },
      ),
    );
    return out as NavTarget[];
  };
  return {
    recordType: 'project',
    async resolve(tx, p, ids) {
      const out = new Map<string, NavTarget>();
      if (!ids.length) return out;
      for (const t of await select(tx, p, { ids, limit: ids.length }))
        out.set((t as NavTarget & { _id: string })._id, stripId(t));
      return out;
    },
    async search(tx, p, term, limit) {
      return (await select(tx, p, { term, limit })).map(stripId);
    },
  };
}

function stripId(t: NavTarget): NavTarget {
  const { _id: _ignored, ...rest } = t as NavTarget & { _id?: string };
  return rest;
}

/** Tasks as navigation targets (favorites, recents, palette; AZ-22), through the one predicate. */
export function taskTargets(arrayMax: number): NavigationTargetAdapter {
  const select = async (
    tx: Parameters<NavigationTargetAdapter['resolve']>[0],
    p: Parameters<NavigationTargetAdapter['resolve']>[1],
    filter: { ids?: readonly string[]; term?: string; limit: number },
  ): Promise<NavTarget[]> => {
    const vis = await compileVisibility(tx, p, { need: 'view', includeArchived: true, arrayMax });
    let q = tx.db
      .selectFrom('core.record as r')
      .innerJoin('work.task as t', (j) =>
        j.onRef('t.workspace_id', '=', 'r.workspace_id').onRef('t.id', '=', 'r.id'),
      )
      .innerJoin('tenancy.brand as b', 'b.id', 't.brand_id')
      .innerJoin('core.record as br', 'br.id', 'b.id')
      .select([
        't.id',
        'r.public_id',
        't.title',
        'r.lifecycle_state',
        'br.public_id as brand_public_id',
        'b.name as brand_name',
        'b.short_name',
        'b.color',
        'b.icon',
        'b.lifecycle_state as brand_state',
      ])
      .where('r.record_type', '=', 'task')
      .where(vis.where('r', { project: sql`t.project_id` }));
    if (filter.ids) q = q.where('t.id', 'in', [...filter.ids]);
    if (filter.term) {
      const like = `%${filter.term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      q = q.where('t.title', 'ilike', like).where('r.lifecycle_state', '=', 'active');
    }
    const rows = await q
      .orderBy(sql`lower(t.title)`)
      .orderBy('t.id')
      .limit(filter.limit)
      .execute();
    return rows.map((r) =>
      Object.assign(
        {
          id: r.public_id,
          type: 'task' as const,
          label: r.title,
          brand: brandMarker({
            public_id: r.brand_public_id,
            name: r.brand_name,
            short_name: r.short_name,
            color: r.color,
            icon: r.icon,
            lifecycle_state: r.brand_state,
          }),
          lifecycle_state: r.lifecycle_state as 'active' | 'archived',
        },
        { _id: r.id },
      ),
    ) as NavTarget[];
  };
  return {
    recordType: 'task',
    async resolve(tx, p, ids) {
      const out = new Map<string, NavTarget>();
      if (!ids.length) return out;
      for (const t of await select(tx, p, { ids, limit: ids.length }))
        out.set((t as NavTarget & { _id: string })._id, stripId(t));
      return out;
    },
    async search(tx, p, term, limit) {
      return (await select(tx, p, { term, limit })).map(stripId);
    },
  };
}
