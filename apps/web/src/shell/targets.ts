import { routeHref } from './registry.ts';
import type { NavTarget } from './client.ts';

/** The page that opens a navigation target (only implemented record types are navigable). */
export function targetHref(ws: string, t: Pick<NavTarget, 'id' | 'type'>): string {
  return t.type === 'brand'
    ? routeHref('brand', { ws, brand: t.id })
    : routeHref('team', { ws, team: t.id });
}

export const TARGET_TYPE_LABEL: Record<NavTarget['type'], string> = {
  brand: 'Brand',
  team: 'Team',
};
