import { useMemo, useState } from 'react';
import { ApiError } from '../api.ts';
import { ProblemLine, useExplain, type Explained } from '../goals/shared.tsx';
import { useResource, ResourceView } from '../tenancy/resource.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Field, SelectField } from '../ui/form.tsx';
import {
  insights,
  type CatalogMetric,
  type WidgetInput,
  type WidgetMeta,
  type WidgetSize,
} from './client.ts';

/**
 * The widget editor (RPT-017). Order is the dashboard's order, which is also the order a narrow
 * screen stacks the widgets in, so reordering is by buttons (keyboard and screen reader friendly)
 * rather than by dragging. Metrics that are not available yet are listed with the reason.
 */

const GROUPS: Record<string, Array<{ value: string; label: string }>> = {
  task: [
    { value: 'none', label: 'One figure' },
    { value: 'project', label: 'By project' },
    { value: 'brand', label: 'By brand' },
    { value: 'assignee', label: 'By assignee' },
    { value: 'priority', label: 'By priority' },
    { value: 'status_category', label: 'By status category' },
  ],
  project: [
    { value: 'none', label: 'One figure' },
    { value: 'health', label: 'By health' },
    { value: 'brand', label: 'By brand' },
    { value: 'owner', label: 'By owner' },
  ],
};
const groupsFor = (key: string) =>
  key.startsWith('tasks.') ? GROUPS.task! : key.startsWith('projects.') ? GROUPS.project! : null;

const newId = (taken: Set<string>) => {
  for (let i = 1; i < 1000; i++) if (!taken.has(`w${i}`)) return `w${i}`;
  return `w${Date.now()}`;
};

export function toInput(w: WidgetMeta): WidgetInput {
  return { id: w.id, metric: w.metric, title: w.title, size: w.size, params: w.params };
}

export function LayoutEditor({
  ws,
  widgets,
  guest,
  max,
  onSave,
  onClose,
}: {
  ws: string;
  widgets: WidgetMeta[];
  guest?: boolean;
  max: number;
  onSave: (next: WidgetInput[]) => Promise<void>;
  onClose: () => void;
}) {
  const explainError = useExplain();
  const catalog = useResource(() => insights.catalog(ws), `catalog:${ws}`);
  const [list, setList] = useState<WidgetInput[]>(widgets.map(toInput));
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [said, setSaid] = useState('');
  const byKey = useMemo(
    () =>
      new Map(
        catalog.state.status === 'ready'
          ? catalog.state.data.metrics.map((m) => [m.key, m] as const)
          : [],
      ),
    [catalog.state],
  );
  const label = (w: WidgetInput) => w.title || byKey.get(w.metric)?.label || w.metric;
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setList(next);
    setSaid(`${label(next[j]!)} moved to position ${j + 1} of ${next.length}.`);
  };
  const remove = (i: number) => {
    setSaid(`${label(list[i]!)} removed.`);
    setList(list.filter((_, k) => k !== i));
  };
  const patch = (i: number, p: Partial<WidgetInput>) =>
    setList(list.map((w, k) => (k === i ? { ...w, ...p } : w)));
  const add = (m: CatalogMetric) => {
    const taken = new Set(list.map((w) => w.id));
    const groups = groupsFor(m.key);
    setList([
      ...list,
      {
        id: newId(taken),
        metric: m.key,
        title: m.label,
        size: 'medium',
        params: groups ? { group_by: m.key === 'projects.active' ? 'health' : 'none' } : {},
      },
    ]);
    setSaid(`${m.label} added.`);
    setPick('');
  };
  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await onSave(list);
      onClose();
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled'))
        setProblem(explainError(err, 'saving the widgets'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Edit widgets" onClose={onClose}>
      <p className="hint">
        The order here is the order on the page, and the order they stack in on a narrow screen.
      </p>
      {list.length ? (
        <ol className="ins-editor-list" aria-label="Widgets">
          {list.map((w, i) => {
            const groups = groupsFor(w.metric);
            return (
              <li key={w.id} className="ins-editor-row">
                <div className="ins-editor-head">
                  <strong>{label(w)}</strong>
                  <span
                    className="actions-compact"
                    role="group"
                    aria-label={`Actions for ${label(w)}`}
                  >
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={i === 0}
                      aria-label={`Move ${label(w)} up`}
                      onClick={() => move(i, -1)}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={i === list.length - 1}
                      aria-label={`Move ${label(w)} down`}
                      onClick={() => move(i, 1)}
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      className="button button-danger"
                      aria-label={`Remove ${label(w)}`}
                      onClick={() => remove(i)}
                    >
                      Remove
                    </button>
                  </span>
                </div>
                <Field
                  id={`wt-${w.id}`}
                  label="Title"
                  value={w.title ?? ''}
                  maxLength={80}
                  onChange={(e) => patch(i, { title: e.target.value })}
                />
                <SelectField
                  id={`ws-${w.id}`}
                  label="Size"
                  value={w.size ?? 'medium'}
                  onChange={(s) => patch(i, { size: s as WidgetSize })}
                  options={[
                    { value: 'small', label: 'Small' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'large', label: 'Large' },
                  ]}
                />
                {groups ? (
                  <SelectField
                    id={`wg-${w.id}`}
                    label="Group by"
                    value={String(w.params?.group_by ?? 'none')}
                    onChange={(g) => patch(i, { params: { ...w.params, group_by: g } })}
                    options={groups}
                  />
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="hint">No widgets yet. Add one below.</p>
      )}
      <ResourceView resource={catalog.state} onRetry={catalog.retry} what="the metric catalog">
        {(cat) => (
          <>
            <SelectField
              id="add-metric"
              label="Add a widget"
              value={pick}
              disabled={list.length >= max}
              hint={list.length >= max ? `At most ${max} widgets.` : undefined}
              onChange={(k) => {
                setPick(k);
                const m = byKey.get(k);
                if (m) add(m);
              }}
              options={[
                { value: '', label: 'Choose a metric…' },
                ...cat.metrics.map((m) => ({ value: m.key, label: m.label })),
              ]}
            />
            {!guest && cat.not_available.length ? (
              <details className="ins-na-list">
                <summary>Not available yet</summary>
                <ul>
                  {cat.not_available.map((m) => (
                    <li key={m.key}>
                      <strong>{m.label}</strong> ({m.requirement}): {m.reason}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        )}
      </ResourceView>
      <ProblemLine problem={problem} busy={busy} />
      <p className="announce" role="status">
        {said}
      </p>
      <p className="actions">
        <button type="button" className="button button-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save widgets'}
        </button>
      </p>
    </Dialog>
  );
}
