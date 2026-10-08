import { useMemo, useState, type FormEvent } from 'react';
import { ApiError } from '../api.ts';
import { projects } from '../projects/client.ts';
import { BrandMarker } from '../shell/brand-marker.tsx';
import { useStepUp } from '../stepup.tsx';
import { useResource } from '../tenancy/resource.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Banner } from '../ui/feedback.tsx';
import { ErrorSummary, Field, fieldErrorsFrom, SelectField, TextAreaField } from '../ui/form.tsx';
import { portfolios, type Portfolio } from './client.ts';
import { ConfirmDialog } from './dialogs.tsx';
import { useIdempotency, useMembers } from './hooks.ts';
import { TrashSection } from './trash.tsx';
import { ProblemLine, useExplain, type Explained } from './shared.tsx';

/**
 * Saved portfolios: a named, optionally brand-scoped set of projects (GOAL-007). Members the
 * person cannot read stay in the portfolio but are neither shown nor counted for them.
 */

export function PortfolioDialog({
  ws,
  existing,
  brands,
  onClose,
  onSaved,
  onReload,
}: {
  ws: string;
  /** Absent to create. */
  existing?: Portfolio;
  brands: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: (p: Portfolio) => void;
  /** Loads the latest saved portfolios (after a version conflict). */
  onReload: () => Promise<void>;
}) {
  const stepUp = useStepUp();
  const explainError = useExplain();
  const idem = useIdempotency();
  const { members } = useMembers(ws);
  const allProjects = useResource(
    () => projects.list(ws, { state: 'active' }),
    `pf-projects:${ws}`,
  );
  const [initial] = useState(existing);
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [brand, setBrand] = useState(
    existing?.scope.kind === 'brand' && existing.scope.brand.kind === 'brand'
      ? existing.scope.brand.id
      : '',
  );
  const [owner, setOwner] = useState(existing?.owner?.id ?? '');
  const [chosen, setChosen] = useState<Set<string>>(new Set(existing?.projects ?? []));
  const [filter, setFilter] = useState('');
  const [created, setCreated] = useState<Portfolio | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState(0);
  const [reloaded, setReloaded] = useState(false);
  const api = fieldErrorsFrom(error, {
    '/name': 'pf-name',
    '/description': 'pf-description',
    '/brand': 'pf-brand',
    '/owner': 'pf-owner',
  });
  const errors = { ...api, ...local };
  const stale = problem?.kind === 'stale';
  const scopedBrand = existing ? (existing.scope.kind === 'brand' ? brand : '') : brand;

  const choices = useMemo(
    () =>
      (allProjects.state.status === 'ready' ? allProjects.state.data.data : []).filter(
        (p) =>
          (!scopedBrand || (p.brand.kind === 'brand' && p.brand.id === scopedBrand)) &&
          p.name.toLowerCase().includes(filter.trim().toLowerCase()),
      ),
    [allProjects.state, scopedBrand, filter],
  );
  const toggle = (id: string) =>
    setChosen((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const found: Record<string, string> = {};
    if (!name.trim()) found['pf-name'] = 'Give the portfolio a name.';
    setLocal(found);
    setAttempt((a) => a + 1);
    if (Object.keys(found).length) return;
    setBusy(true);
    setError(null);
    setProblem(null);
    try {
      let current = existing ?? created;
      if (!current) {
        const body = {
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(brand ? { brand } : {}),
          ...(owner ? { owner } : {}),
        };
        current = await portfolios.create(ws, body, stepUp, { key: idem.keyFor(body) });
        idem.reset();
        setCreated(current);
      } else if (initial) {
        const patch: { name?: string; description?: string | null; owner?: string } = {};
        if (name.trim() !== initial.name) patch.name = name.trim();
        if (description.trim() !== (initial.description ?? ''))
          patch.description = description.trim() || null;
        if (owner && owner !== initial.owner?.id) patch.owner = owner;
        if (Object.keys(patch).length)
          current = await portfolios.update(ws, current.id, current.version, patch, stepUp);
      }
      const before = new Set(initial?.projects ?? []);
      const same = before.size === chosen.size && [...chosen].every((id) => before.has(id));
      if (!same)
        current = await portfolios.setProjects(
          ws,
          current.id,
          current.version,
          [...chosen],
          stepUp,
        );
      onSaved(current);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'cancelled') return;
      setError(err);
      setProblem(explainError(err, 'saving the portfolio'));
      setReloaded(false);
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    setBusy(true);
    try {
      await onReload();
      setProblem(null);
      setError(null);
      setReloaded(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={existing ? 'Edit portfolio' : 'Create portfolio'} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <ErrorSummary
          errors={errors}
          labels={{
            'pf-name': 'Name',
            'pf-description': 'Description',
            'pf-brand': 'Brand',
            'pf-owner': 'Owner',
          }}
          focusKey={attempt}
        />
        {created && !existing ? (
          <Banner tone="info" title="The portfolio was created">
            Saving the projects did not finish. Try again; nothing will be created twice.
          </Banner>
        ) : null}
        {stale ? (
          <Banner
            tone="warning"
            title="This portfolio changed while you were editing"
            action={
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() => void reload()}
              >
                Load latest version
              </button>
            }
          >
            Your edits are kept below. Load the latest version, then save again.
          </Banner>
        ) : reloaded ? (
          <Banner tone="info" title="Latest version loaded">
            Your edits are still here. Check them, then save again.
          </Banner>
        ) : null}
        <Field
          id="pf-name"
          label="Name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors['pf-name']}
          maxLength={200}
        />
        <TextAreaField
          id="pf-description"
          label="Description (optional)"
          value={description}
          onChange={setDescription}
          maxLength={2000}
          error={errors['pf-description']}
        />
        {existing ? (
          <p className="hint">
            Scope:{' '}
            {existing.scope.kind === 'brand' ? (
              <BrandMarker marker={existing.scope.brand} size={16} />
            ) : (
              'workspace-wide'
            )}
            . The scope cannot change after creation.
          </p>
        ) : (
          <SelectField
            id="pf-brand"
            label="Brand scope"
            hint="A brand portfolio holds only that brand's projects."
            value={brand}
            onChange={(v) => {
              setBrand(v);
              setChosen(new Set());
            }}
            error={errors['pf-brand']}
            options={[
              { value: '', label: 'Workspace-wide' },
              ...brands.map((b) => ({ value: b.id, label: b.name })),
            ]}
          />
        )}
        {members.length ? (
          <SelectField
            id="pf-owner"
            label="Owner"
            value={owner}
            onChange={setOwner}
            error={errors['pf-owner']}
            options={[
              { value: '', label: existing ? 'Keep the current owner' : 'Me' },
              ...members.map((m) => ({ value: m.id, label: m.you ? `${m.name} (you)` : m.name })),
            ]}
          />
        ) : null}
        <fieldset className="plain gl-members">
          <legend>Projects in this portfolio</legend>
          <p className="hint">
            You can add projects you can read. Members you cannot read are kept in the portfolio but
            are not shown or counted for you.
          </p>
          <Field
            id="pf-filter"
            label="Find a project"
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {allProjects.state.status === 'loading' ? <p role="status">Loading projects…</p> : null}
          <ul className="gl-checks">
            {choices.map((p) => (
              <li key={p.id}>
                <label className="choice">
                  <input type="checkbox" checked={chosen.has(p.id)} onChange={() => toggle(p.id)} />{' '}
                  {p.name}
                  {p.brand.kind === 'brand' ? (
                    <span className="hint"> ({p.brand.name})</span>
                  ) : null}
                </label>
              </li>
            ))}
          </ul>
          <p className="hint" role="status">
            {chosen.size} selected.
          </p>
        </fieldset>
        <ProblemLine
          problem={error && !Object.keys(api).length && !stale ? problem : null}
          busy={busy}
        />
        <p className="actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Saving…' : existing ? 'Save portfolio' : 'Create portfolio'}
          </button>
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
        </p>
      </form>
    </Dialog>
  );
}

export function PortfoliosManager({
  ws,
  brands,
  onOpen,
}: {
  ws: string;
  brands: Array<{ id: string; name: string }>;
  /** Show this portfolio's health. */
  onOpen: (id: string) => void;
}) {
  const stepUp = useStepUp();
  const explainError = useExplain();
  const [archived, setArchived] = useState(false);
  const list = useResource(() => portfolios.list(ws, archived), `pfs:${ws}:${archived}`);
  const [dialog, setDialog] = useState<
    { kind: 'create' } | { kind: 'edit'; id: string } | { kind: 'archive'; id: string } | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [said, setSaid] = useState('');
  const items = list.state.status === 'ready' ? list.state.data.data : [];
  const target = dialog && 'id' in dialog ? items.find((p) => p.id === dialog.id) : undefined;

  const lifecycle = async (p: Portfolio, verb: 'archive' | 'unarchive') => {
    setBusy(true);
    setProblem(null);
    setSaid('');
    try {
      await portfolios.verb(ws, p.id, verb, p.version, stepUp);
      setDialog(null);
      await list.refresh();
      setSaid(verb === 'archive' ? `Archived ${p.name}.` : `Restored ${p.name}.`);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled'))
        setProblem(explainError(err, 'changing the portfolio'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="card" aria-labelledby="pf-saved">
        <h2 id="pf-saved">Saved portfolios</h2>
        <p className="hint">
          A portfolio is a named set of projects. Its health view covers only the members you can
          read.
        </p>
        <div className="gl-toolbar">
          <button
            type="button"
            className="button button-primary"
            onClick={() => setDialog({ kind: 'create' })}
          >
            Create portfolio
          </button>
          <label className="choice">
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
            />{' '}
            Show archived portfolios
          </label>
        </div>
        <ProblemLine problem={problem} />
        <p className="announce" role="status">
          {said}
        </p>
        {list.state.status === 'loading' ? (
          <p className="loading" role="status">
            Loading portfolios…
          </p>
        ) : list.state.status === 'failed' ? (
          <Banner
            tone="danger"
            title="We couldn't load portfolios"
            action={
              <button type="button" className="button button-secondary" onClick={list.retry}>
                Try again
              </button>
            }
          >
            Try again in a moment.
          </Banner>
        ) : !items.length ? (
          <p className="empty-state">
            {archived ? 'No archived portfolios.' : 'No saved portfolios yet.'}
          </p>
        ) : (
          <ul className="gl-list">
            {items.map((p) => (
              <li key={p.id} className="gl-row">
                <h3 className="gl-row-title">{p.name}</h3>
                {p.description ? <p>{p.description}</p> : null}
                <p className="gl-meta">
                  {p.scope.kind === 'brand' ? (
                    <BrandMarker marker={p.scope.brand} size={16} />
                  ) : (
                    'Workspace-wide'
                  )}{' '}
                  · Owner: {p.owner?.name ?? 'No owner'} · {p.projects_count} project
                  {p.projects_count === 1 ? '' : 's'} you can read
                </p>
                <div className="actions-compact" role="group" aria-label={`Actions for ${p.name}`}>
                  {p.lifecycle_state === 'active' ? (
                    <button
                      type="button"
                      className="button button-secondary"
                      aria-label={`View health of ${p.name}`}
                      onClick={() => onOpen(p.id)}
                    >
                      View health
                    </button>
                  ) : null}
                  {p.capabilities.update ? (
                    <button
                      type="button"
                      className="button button-ghost"
                      aria-label={`Edit ${p.name}`}
                      onClick={() => setDialog({ kind: 'edit', id: p.id })}
                    >
                      Edit
                    </button>
                  ) : null}
                  {p.capabilities.archive && p.lifecycle_state === 'active' ? (
                    <button
                      type="button"
                      className="button button-ghost"
                      aria-label={`Archive ${p.name}`}
                      onClick={() => setDialog({ kind: 'archive', id: p.id })}
                    >
                      Archive
                    </button>
                  ) : null}
                  {p.capabilities.archive && p.lifecycle_state === 'archived' ? (
                    <button
                      type="button"
                      className="button button-ghost"
                      disabled={busy}
                      aria-label={`Restore ${p.name}`}
                      onClick={() => void lifecycle(p, 'unarchive')}
                    >
                      Restore
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {dialog?.kind === 'create' || (dialog?.kind === 'edit' && target) ? (
          <PortfolioDialog
            ws={ws}
            {...(dialog.kind === 'edit' ? { existing: target! } : {})}
            brands={brands}
            onClose={() => setDialog(null)}
            onReload={list.refresh}
            onSaved={(p) => {
              setDialog(null);
              void list.refresh().then(() => setSaid(`Saved ${p.name}.`));
            }}
          />
        ) : null}
        {dialog?.kind === 'archive' && target ? (
          <ConfirmDialog
            title="Archive this portfolio?"
            confirm="Archive portfolio"
            busy={busy}
            problem={problem}
            onClose={() => setDialog(null)}
            onConfirm={() => void lifecycle(target, 'archive')}
          >
            <p>“{target.name}” is read-only while archived. The projects in it are not affected.</p>
          </ConfirmDialog>
        ) : null}
      </section>
      <TrashSection ws={ws} kind="portfolio" onRestored={() => void list.refresh()} />
    </>
  );
}
