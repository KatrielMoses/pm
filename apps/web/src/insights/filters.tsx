import { useEffect, useState } from 'react';
import { useMembers } from '../goals/hooks.ts';
import { projects, type ProjectSummary } from '../projects/client.ts';
import { useWorkspaceShell } from '../shell/workspace.tsx';
import { Field, SelectField } from '../ui/form.tsx';
import {
  NO_FILTERS,
  RANGE_LABEL,
  STATUS_CATEGORY_LABEL,
  type Filters,
  type RangePreset,
} from './client.ts';

/**
 * Filters by date, brand, project, person, and status (RPT-018). A filter only ever narrows what
 * the viewer may already read; the options listed are only brands, projects, and people they can
 * see, and a widget a filter does not apply to says so itself.
 */

const customOf = (f: Filters) => (f.range && 'from' in f.range ? f.range : null);

export function FilterBar({
  ws,
  value,
  onChange,
  fixed,
}: {
  ws: string;
  value: Filters;
  onChange: (f: Filters) => void;
  /** Scopes the dashboard already carries are not offered again. */
  fixed?: { brand?: boolean; project?: boolean };
}) {
  const shell = useWorkspaceShell();
  const brands = shell?.context?.brands ?? [];
  const { members } = useMembers(ws);
  const [projectList, setProjectList] = useState<ProjectSummary[]>([]);
  useEffect(() => {
    let active = true;
    projects.list(ws).then(
      (l) => {
        if (active) setProjectList(l.data);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [ws]);
  const rangeMode = value.range ? ('preset' in value.range ? value.range.preset : 'custom') : '';
  const custom = customOf(value);
  const set = (patch: Partial<Filters>) => onChange({ ...value, ...patch });
  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  const active =
    !!value.range ||
    value.brands.length > 0 ||
    value.projects.length > 0 ||
    value.people.length > 0 ||
    value.statuses.length > 0;
  return (
    <form className="ins-filters" aria-label="Filters" onSubmit={(e) => e.preventDefault()}>
      <SelectField
        id="flt-range"
        label="Date range"
        value={rangeMode}
        onChange={(m) =>
          set({
            range:
              m === ''
                ? null
                : m === 'custom'
                  ? { from: custom?.from ?? '', to: custom?.to ?? '' }
                  : { preset: m as RangePreset },
          })
        }
        options={[
          { value: '', label: 'Each widget’s own default' },
          ...(Object.keys(RANGE_LABEL) as RangePreset[]).map((k) => ({
            value: k,
            label: RANGE_LABEL[k],
          })),
          { value: 'custom', label: 'Custom dates' },
        ]}
      />
      {rangeMode === 'custom' ? (
        <>
          <Field
            id="flt-from"
            label="From"
            type="date"
            value={custom?.from ?? ''}
            onChange={(e) => set({ range: { from: e.target.value, to: custom?.to ?? '' } })}
          />
          <Field
            id="flt-to"
            label="To"
            type="date"
            value={custom?.to ?? ''}
            onChange={(e) => set({ range: { from: custom?.from ?? '', to: e.target.value } })}
          />
        </>
      ) : null}
      {!fixed?.brand && brands.length > 1 ? (
        <SelectField
          id="flt-brand"
          label="Brand"
          value={value.brands[0] ?? ''}
          onChange={(b) => set({ brands: b ? [b] : [] })}
          options={[
            { value: '', label: 'All brands you can read' },
            ...brands.map((b) => ({ value: b.id, label: b.name })),
          ]}
        />
      ) : null}
      {!fixed?.project && projectList.length ? (
        <SelectField
          id="flt-project"
          label="Project"
          value={value.projects[0] ?? ''}
          onChange={(p) => set({ projects: p ? [p] : [] })}
          options={[
            { value: '', label: 'All projects you can read' },
            ...projectList.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
      ) : null}
      <SelectField
        id="flt-person"
        label="Person"
        value={value.people[0] ?? ''}
        onChange={(p) => set({ people: p ? [p] : [] })}
        options={[
          { value: '', label: 'Everyone' },
          { value: 'me', label: 'Me' },
          ...members.filter((m) => !m.you).map((m) => ({ value: m.id, label: m.name })),
        ]}
      />
      <fieldset className="plain ins-status">
        <legend>Status</legend>
        {Object.entries(STATUS_CATEGORY_LABEL).map(([k, label]) => (
          <label key={k} className="check">
            <input
              type="checkbox"
              checked={value.statuses.includes(k)}
              onChange={() => set({ statuses: toggle(value.statuses, k) })}
            />{' '}
            {label}
          </label>
        ))}
      </fieldset>
      {active ? (
        <p>
          <button
            type="button"
            className="button button-ghost"
            onClick={() => onChange(NO_FILTERS)}
          >
            Clear filters
          </button>
        </p>
      ) : null}
    </form>
  );
}
