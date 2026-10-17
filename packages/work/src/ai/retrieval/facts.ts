import type { ManifestEntry } from './types.ts';

/**
 * Server-grounded facts and deterministic calculations (ADR-0039 R7; AI-009, AI-010). These come
 * from canonical fields of the included sources, never from generated text, and always win over
 * a generated claim about status, completion, dates, or amounts.
 */

export interface ServerFact {
  handle: string;
  label: string;
  value: string;
}

export interface Calculation {
  key: 'tasks_by_status' | 'tasks_overdue' | 'tasks_done';
  label: string;
  value: string;
  basis: string;
}

const date = (v: string | null | undefined) => (v ? v.slice(0, 10) : null);

export function serverFacts(entries: readonly ManifestEntry[]): ServerFact[] {
  const out: ServerFact[] = [];
  for (const e of entries) {
    if (!e.included || !e.handle) continue;
    const f = e.facts;
    if (f.status) out.push({ handle: e.handle, label: 'Status', value: f.status.name });
    if (e.kind === 'task') {
      if (f.dueDate) out.push({ handle: e.handle, label: 'Due', value: date(f.dueDate)! });
      if (f.completedAt)
        out.push({ handle: e.handle, label: 'Completed', value: date(f.completedAt)! });
    }
    if (e.kind === 'project') {
      if (f.startDate) out.push({ handle: e.handle, label: 'Starts', value: date(f.startDate)! });
      if (f.targetDate) out.push({ handle: e.handle, label: 'Target', value: date(f.targetDate)! });
    }
    if (e.kind === 'document') {
      out.push({
        handle: e.handle,
        label: 'AI source approval',
        value: f.approvedVersion ? `Approved (version ${f.approvedVersion})` : 'Not approved',
      });
      if (f.reviewDueOn) out.push({ handle: e.handle, label: 'Review due', value: f.reviewDueOn });
    }
  }
  return out;
}

/** Counts over the included tasks only (readable sources); never over hidden or excluded work. */
export function calculations(entries: readonly ManifestEntry[], today: string): Calculation[] {
  const tasks = entries.filter((e) => e.included && e.kind === 'task' && e.facts.status);
  if (!tasks.length) return [];
  const basis = `Counted by the server from ${tasks.length} task${tasks.length === 1 ? '' : 's'} in this context.`;
  const byName = new Map<string, number>();
  for (const t of tasks) {
    const n = t.facts.status!.name;
    byName.set(n, (byName.get(n) ?? 0) + 1);
  }
  const done = tasks.filter((t) => t.facts.status!.category === 'done').length;
  const overdue = tasks.filter((t) => {
    const due = date(t.facts.dueDate);
    const c = t.facts.status!.category;
    return due !== null && due < today && c !== 'done' && c !== 'cancelled';
  }).length;
  return [
    {
      key: 'tasks_by_status',
      label: 'Tasks by status',
      value: [...byName.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, n]) => `${n} ${name}`)
        .join(', '),
      basis,
    },
    { key: 'tasks_done', label: 'Tasks done', value: `${done} of ${tasks.length}`, basis },
    {
      key: 'tasks_overdue',
      label: 'Tasks overdue',
      value: String(overdue),
      basis: `${basis} Overdue means due before ${today} and not done or cancelled.`,
    },
  ];
}
