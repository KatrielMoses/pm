import { routeHref } from './registry.ts';
import type { NavTarget } from './client.ts';

/** The page that opens a navigation target (only implemented record types are navigable). */
export function targetHref(ws: string, t: Pick<NavTarget, 'id' | 'type'>): string {
  switch (t.type) {
    case 'brand':
      return routeHref('brand', { ws, brand: t.id });
    case 'project':
      return routeHref('project', { ws, prj: t.id });
    case 'task':
      return routeHref('task', { ws, tsk: t.id });
    default:
      return routeHref('team', { ws, team: t.id });
  }
}

export const TARGET_TYPE_LABEL: Record<NavTarget['type'], string> = {
  brand: 'Brand',
  team: 'Team',
  project: 'Project',
  task: 'Task',
};
