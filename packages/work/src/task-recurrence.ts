import type { WorkspaceTransaction } from '@pm/db';
import { writeOutboxEvent } from '@pm/platform';
import type { Level } from '@pm/tenancy';
import { localToUtc, occurrences, parseRule, utcToLocal } from './recurrence.ts';
import { fmtTs } from './structures.ts';
import { instantiateTask, readTaskPackage, type TaskInstanceContext } from './task-package.ts';

type TaskSeriesRow = {
  id: string;
  public_id: string;
  brand_id: string;
  project_id: string | null;
  state: string;
  rrule: string;
  anchor_tz: string;
  dtstart_local: string | Date;
  generated_through: string | Date | null;
  template_payload: unknown;
  version: number | string;
};

/**
 * Generates task occurrences after the series cursor (ADR-0016 D1): at most `limit`, only those
 * due by `due` (null = the next one regardless of time). Each occurrence is an independent task
 * from the frozen snapshot, due on its occurrence's local date, with origin `recurring` and the
 * stable occurrence key; an already generated key is skipped (idempotent). The caller has checked
 * the acting principal's authority to create tasks in the series' brand and project for this run.
 * Advances `generated_through` and `next_due_at` in the same transaction.
 */
export async function generateTaskOccurrences(
  tx: WorkspaceTransaction,
  input: {
    series: TaskSeriesRow;
    limit: number;
    due: Date | null;
    maxItems: number;
    level: Level;
    context: TaskInstanceContext;
  },
): Promise<{ generated: Array<{ id: string; occurrence_key: string }>; more: boolean }> {
  const s = input.series;
  const rule = parseRule(s.rrule);
  const start = fmtTs(s.dtstart_local);
  const cursor = s.generated_through ? fmtTs(s.generated_through) : null;
  const through = input.due ? utcToLocal(input.due, s.anchor_tz) : null;
  const keys = occurrences(rule, start, cursor, input.limit + 1, through);
  const now = keys.slice(0, input.limit);
  const pkg = readTaskPackage(
    typeof s.template_payload === 'string' ? JSON.parse(s.template_payload) : s.template_payload,
    input.maxItems,
  );
  const generated: Array<{ id: string; occurrence_key: string }> = [];
  for (const key of now) {
    const exists = await tx.db
      .selectFrom('work.task')
      .select('id')
      .where('recurrence_series_id', '=', s.id)
      .where('occurrence_key', '=', key)
      .executeTakeFirst();
    if (exists) continue;
    const created = await instantiateTask(tx, input.context, {
      brandId: s.brand_id,
      projectId: s.project_id,
      pkg,
      overrides: { due_date: key.slice(0, 10) },
      origin: { kind: 'recurring', ref: { series: s.public_id, occurrence: key } },
      level: input.level,
      recurrence: { seriesId: s.id, occurrenceKey: key },
      itemsMax: input.maxItems,
    });
    await writeOutboxEvent(tx, {
      type: 'planning.occurrence.generated',
      aggregate: { type: 'planning.recurrence_series', id: s.id, sequence: Number(s.version) + 1 },
      data: { occurrence_key: key, record_id: created.id },
      actor: {
        type: input.context.exec.effectivePrincipal.type === 'member' ? 'human' : 'system',
        id: input.context.exec.effectivePrincipal.id,
      },
      context: input.context.exec,
      brandId: s.brand_id,
    });
    generated.push({ id: created.publicId, occurrence_key: key });
  }
  const last = now.at(-1) ?? cursor;
  const next = last ? occurrences(rule, start, last, 1)[0] : occurrences(rule, start, null, 1)[0];
  await tx.db
    .updateTable('planning.recurrence_series')
    .set({
      generated_through: last ? last.replace('T', ' ') : null,
      next_due_at: s.state === 'active' && next ? localToUtc(next, s.anchor_tz) : null,
      updated_at: new Date(),
      version: Number(s.version) + 1,
    })
    .where('id', '=', s.id)
    .execute();
  return { generated, more: keys.length > input.limit };
}
