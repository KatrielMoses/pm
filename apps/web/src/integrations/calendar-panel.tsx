import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, newIdempotencyKey } from '../api.ts';
import {
  calendars,
  errorText,
  rangeText,
  type CalendarConflictView,
  type CalendarSourceView,
  type ConflictResolution,
  type SyncRunView,
} from './calendar-client.ts';
import type { ConnectionView, ProviderView } from './panel.tsx';

/**
 * Google Calendar settings (6C, ADR-0037): connect through the provider's consent screen, then,
 * for the person's own connection, choose calendars and their direction, see recent
 * synchronization, and settle schedule conflicts. Every section exposes `aria-busy` while a
 * request is in flight and ends in a settled message (role="status") or an error (role="alert").
 */

type Brand = { id: string; name: string };

/** Navigation away to the provider; a seam so tests can observe it. */
export const browser = {
  assign: (url: string) => window.location.assign(url),
};

const OUTCOME: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'Google Calendar is connected. Choose the calendars to include.' },
  denied: { ok: false, text: 'Google Calendar was not connected: access was declined.' },
  invalid: {
    ok: false,
    text: 'Google Calendar was not connected: the authorization could not be used. Try again.',
  },
  unavailable: {
    ok: false,
    text: 'Google Calendar was not connected: Google could not be reached. Try again later.',
  },
  scope_declined: {
    ok: false,
    text: 'Google Calendar was not connected: calendar access was not granted. Reauthorize and allow calendar access.',
  },
  not_found: {
    ok: false,
    text: 'Google Calendar was not connected: that connection no longer exists or is not yours.',
  },
};

const RUN_STATE: Record<string, string> = {
  pending: 'Waiting',
  running: 'Running',
  succeeded: 'Succeeded',
  partial: 'Partly finished',
  failed: 'Failed',
  dead: 'Stopped after retries',
  skipped: 'Skipped',
};

const HEALTH: Record<string, string> = {
  connected: 'Connected',
  needs_reauthorization: 'Needs reauthorization',
  error: 'Error',
  disconnected: 'Disconnected',
  provider_unconfigured: 'Provider not configured',
  degraded: 'Degraded',
};

const describe = (err: unknown, fallback = 'That did not work. Try again.') =>
  err instanceof ApiError
    ? err.code === 'offline' || err.code === 'network'
      ? "You're offline. Nothing changed; try again when you're back."
      : (err.issues[0]?.message ?? err.message)
    : fallback;

/** Reads (and removes from the address) the outcome the OAuth callback redirected back with. */
export function useCalendarOutcome(): { ok: boolean; text: string } | null {
  const [outcome] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('calendar');
    if (!code) return null;
    return OUTCOME[code] ?? OUTCOME.invalid!;
  });
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('calendar')) return;
    url.searchParams.delete('calendar');
    url.searchParams.delete('connection');
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, []);
  return outcome;
}

/** Starts or renews an authorization: the provider's consent screen, or the local test double. */
async function authorize(
  ws: string,
  path: string,
  body: Record<string, unknown>,
): Promise<'navigating' | 'completed'> {
  const r = await api<{
    data: { id: string; authorization_url?: string; authorization_code?: string };
  }>('POST', path, { body, headers: { 'idempotency-key': newIdempotencyKey() } });
  const url = r.body.data.authorization_url;
  if (url) {
    browser.assign(url);
    return 'navigating';
  }
  // The local test double has no consent screen: it hands back a code that finishes at once.
  const code = r.body.data.authorization_code;
  if (code)
    await api(
      'POST',
      `/v1/workspaces/${ws}/integrations/connections/${r.body.data.id}/oauth/complete`,
      {
        body: { code },
        headers: { 'idempotency-key': newIdempotencyKey() },
      },
    );
  return 'completed';
}

export function GoogleCalendarSection({
  ws,
  provider,
  connections,
  brands,
  onChanged,
}: {
  ws: string;
  provider: ProviderView | undefined;
  connections: ConnectionView[];
  brands: Brand[];
  onChanged: () => Promise<void>;
}) {
  const outcome = useCalendarOutcome();
  const [name, setName] = useState('Google Calendar');
  const [twoWay, setTwoWay] = useState(false);
  const [brand, setBrand] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');
  const mine = connections.filter(
    (c) => c.provider === 'google_calendar' && c.health !== 'disconnected',
  );

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setSaid('');
    setError('');
    try {
      const result = await authorize(ws, `/v1/workspaces/${ws}/integrations/connections`, {
        provider: 'google_calendar',
        auth_kind: 'oauth',
        display_name: name.trim(),
        scopes: twoWay ? ['calendar.read', 'calendar.write'] : ['calendar.read'],
        ...(brand ? { brand } : {}),
      });
      if (result === 'navigating') {
        // The page is leaving for Google; the section stays busy until it does.
        setSaid('Opening Google to authorize…');
        return;
      }
      await onChanged();
      setSaid('Google Calendar test double connected. It is not a real Google account.');
      setBusy(false);
    } catch (err) {
      setError(describe(err));
      setBusy(false);
    }
  };

  return (
    <section
      className="card calendar-settings"
      aria-labelledby="gcal-heading"
      aria-busy={busy ? 'true' : 'false'}
    >
      <h2 id="gcal-heading">Google Calendar</h2>
      {outcome ? (
        outcome.ok ? (
          <p role="status" className="calendar-outcome">
            {outcome.text}
          </p>
        ) : (
          <p role="alert" className="calendar-outcome field-error">
            {outcome.text}
          </p>
        )
      ) : null}
      {provider && !provider.configured ? (
        <p>{provider.unavailable ?? 'Google Calendar is not configured in this environment.'}</p>
      ) : provider ? (
        <form
          className="portability-controls"
          aria-label="Connect Google Calendar"
          onSubmit={(e) => void connect(e)}
        >
          <p className="hint">
            You sign in with Google and choose what to allow. Your events stay private to you; other
            people only see busy time where you plan work.
          </p>
          <label htmlFor="gcal-name">Connection name</label>
          <input
            id="gcal-name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <label className="choice">
            <input type="checkbox" checked={twoWay} onChange={(e) => setTwoWay(e.target.checked)} />{' '}
            Allow moving events (two-way)
          </label>
          {brands.length ? (
            <>
              <label htmlFor="gcal-brand">Brand</label>
              <select id="gcal-brand" value={brand} onChange={(e) => setBrand(e.target.value)}>
                <option value="">Workspace (no brand)</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <button className="button button-primary" type="submit" disabled={busy || !name.trim()}>
            Connect Google Calendar
          </button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="field-error">
          {error}
        </p>
      ) : null}
      <p role="status" className="announce">
        {said}
      </p>
      {mine.map((c) => (
        <CalendarConnectionCard
          key={c.id}
          ws={ws}
          connection={c}
          brands={brands}
          onChanged={onChanged}
          announce={setSaid}
        />
      ))}
    </section>
  );
}

type Draft = Record<string, { selected: boolean; direction: 'read' | 'two_way'; brand: string }>;

const draftOf = (rows: CalendarSourceView[]): Draft =>
  Object.fromEntries(
    rows.map((r) => [
      r.id,
      { selected: r.selected, direction: r.direction, brand: r.brand?.id ?? '' },
    ]),
  );

function CalendarConnectionCard({
  ws,
  connection: c,
  brands,
  onChanged,
  announce,
}: {
  ws: string;
  connection: ConnectionView;
  brands: Brand[];
  onChanged: () => Promise<void>;
  announce: (message: string) => void;
}) {
  // undefined: still loading; null: another member's connection (calendars answered 404).
  const [sources, setSources] = useState<CalendarSourceView[] | null | undefined>(undefined);
  const [draft, setDraft] = useState<Draft>({});
  const [runs, setRuns] = useState<SyncRunView[]>([]);
  const [conflicts, setConflicts] = useState<CalendarConflictView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');
  const [retention, setRetention] = useState<'retain' | 'remove'>('retain');

  const refresh = useCallback(async () => {
    const rows = await calendars.sources(ws, c.id);
    setSources(rows);
    if (rows) {
      setDraft(draftOf(rows));
      const [r, k] = await Promise.all([
        calendars.runs(ws, c.id).catch(() => [] as SyncRunView[]),
        calendars.conflicts(ws).catch(() => [] as CalendarConflictView[]),
      ]);
      setRuns(r.slice(0, 5));
      setConflicts(k.filter((x) => x.connection === c.id));
    }
  }, [ws, c.id]);

  useEffect(() => {
    let gone = false;
    // Deferred like the panel's own load, so the first render is never followed by a sync update.
    const t = setTimeout(() => {
      refresh()
        .catch((err: unknown) => {
          if (!gone) setError(describe(err, 'Calendars could not be loaded.'));
        })
        .finally(() => {
          if (!gone) setLoaded(true);
        });
    }, 0);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [refresh]);

  const act = async (fn: () => Promise<string | void>, done: string) => {
    if (busy) return;
    setBusy(true);
    setSaid('');
    setError('');
    try {
      const message = await fn();
      if (message === 'navigating') {
        setSaid('Opening Google to authorize…');
        return;
      }
      await refresh().catch(() => undefined);
      await onChanged().catch(() => undefined);
      setSaid(message || done);
    } catch (err) {
      setError(describe(err));
      await refresh().catch(() => undefined);
    }
    setBusy(false);
  };

  const resolve = (k: CalendarConflictView, resolution: ConflictResolution) =>
    act(
      () => calendars.resolve(ws, c.id, k.id, resolution),
      resolution === 'kept_local'
        ? `Kept your plan for ${k.event.title}. The calendar will be updated.`
        : resolution === 'kept_remote'
          ? `Moved your block to the calendar's time for ${k.event.title}.`
          : `Unlinked ${k.event.title} from your block.`,
    );

  const owner = sources !== null;
  const mode =
    c.provider_mode === 'live'
      ? 'Live'
      : c.provider_mode === 'test_double'
        ? 'Test double — not a real Google account'
        : 'Unknown';
  const lastError = errorText(c.last_error);
  const twoWay = c.scopes.includes('calendar.write');

  return (
    <section
      className="calendar-connection"
      aria-labelledby={`gcal-${c.id}`}
      aria-busy={busy || !loaded ? 'true' : 'false'}
      data-connection={c.id}
    >
      <h3 id={`gcal-${c.id}`}>{c.display_name}</h3>
      <dl className="facts calendar-facts">
        <div>
          <dt>Mode</dt>
          <dd>{mode}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{HEALTH[c.health] ?? 'Unknown'}</dd>
        </div>
        <div>
          <dt>Access</dt>
          <dd>{twoWay ? 'Read and move events' : 'Read only'}</dd>
        </div>
        <div>
          <dt>Last sync</dt>
          <dd>{c.last_success_at ? new Date(c.last_success_at).toLocaleString() : 'Never'}</dd>
        </div>
        {lastError ? (
          <div>
            <dt>Last error</dt>
            <dd>{lastError}</dd>
          </div>
        ) : null}
      </dl>
      {loaded && !owner ? (
        <p className="hint">
          This calendar belongs to {c.owner.name}. Only they can choose its calendars and settle its
          conflicts.
        </p>
      ) : null}
      {owner && loaded ? (
        <div className="actions-compact calendar-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const run = await calendars.sync(ws, c.id);
                const problem = errorText(run.error_code ?? null);
                return problem
                  ? `Synchronization did not finish. ${problem}`
                  : `Synchronized: ${run.read_count ?? 0} read, ${run.write_count ?? 0} written, ${run.conflict_count ?? 0} conflicts.`;
              }, 'Synchronized.')
            }
          >
            Sync now<span className="visually-hidden"> {c.display_name}</span>
          </button>
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() =>
              void act(
                () =>
                  authorize(
                    ws,
                    `/v1/workspaces/${ws}/integrations/connections/${c.id}/reauthorize`,
                    {
                      provider: 'google_calendar',
                      auth_kind: 'oauth',
                      display_name: c.display_name,
                      scopes: twoWay ? ['calendar.read', 'calendar.write'] : ['calendar.read'],
                    },
                  ).then((r) => (r === 'navigating' ? 'navigating' : 'Reauthorized.')),
                'Reauthorized.',
              )
            }
          >
            Reauthorize<span className="visually-hidden"> {c.display_name}</span>
          </button>
        </div>
      ) : null}
      {owner && sources ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const rows = await calendars.saveSources(
                ws,
                c.id,
                sources.map((s) => ({
                  id: s.id,
                  selected: draft[s.id]?.selected ?? s.selected,
                  direction: draft[s.id]?.direction ?? s.direction,
                  brand: (draft[s.id]?.brand ?? s.brand?.id ?? '') || null,
                })),
              );
              setSources(rows);
              setDraft(draftOf(rows));
            }, 'Calendars saved.');
          }}
        >
          <fieldset className="calendar-sources">
            <legend>Calendars</legend>
            {sources.length ? (
              <ul className="today-list">
                {sources.map((s) => {
                  const d = draft[s.id] ?? {
                    selected: s.selected,
                    direction: s.direction,
                    brand: s.brand?.id ?? '',
                  };
                  const set = (patch: Partial<Draft[string]>) =>
                    setDraft((x) => ({ ...x, [s.id]: { ...d, ...patch } }));
                  return (
                    <li key={s.id} className="today-item calendar-source" data-calendar={s.id}>
                      <span className="today-item-main">
                        <strong>{s.label}</strong>
                        {s.primary ? <span className="badge">Primary</span> : null}
                        {s.last_synced_at ? (
                          <span className="hint">
                            {' '}
                            · last synchronized {new Date(s.last_synced_at).toLocaleString()}
                          </span>
                        ) : null}
                      </span>
                      <label className="choice">
                        <input
                          type="checkbox"
                          checked={d.selected}
                          onChange={(e) => set({ selected: e.target.checked })}
                        />{' '}
                        Include<span className="visually-hidden"> {s.label}</span>
                      </label>
                      <span className="calendar-source-field">
                        <label htmlFor={`dir-${s.id}`}>
                          Direction<span className="visually-hidden"> for {s.label}</span>
                        </label>
                        <select
                          id={`dir-${s.id}`}
                          value={d.direction}
                          onChange={(e) =>
                            set({ direction: e.target.value === 'two_way' ? 'two_way' : 'read' })
                          }
                        >
                          <option value="read">Read only</option>
                          <option value="two_way" disabled={!s.two_way_available}>
                            Two-way
                          </option>
                        </select>
                      </span>
                      {brands.length ? (
                        <span className="calendar-source-field">
                          <label htmlFor={`brand-${s.id}`}>
                            Brand<span className="visually-hidden"> for {s.label}</span>
                          </label>
                          <select
                            id={`brand-${s.id}`}
                            value={d.brand}
                            onChange={(e) => set({ brand: e.target.value })}
                          >
                            <option value="">No brand</option>
                            {brands.map((b) => (
                              <option key={b.id} value={b.id}>
                                {b.name}
                              </option>
                            ))}
                          </select>
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="hint">No calendars are listed for this connection yet.</p>
            )}
          </fieldset>
          {sources.some((s) => !s.two_way_available) ? (
            <p className="hint">
              Two-way needs a calendar you can edit and a connection allowed to move events.
            </p>
          ) : null}
          {sources.length ? (
            <button className="button button-secondary" type="submit" disabled={busy}>
              Save calendars
            </button>
          ) : null}
        </form>
      ) : null}
      {owner && loaded ? (
        <>
          <h4 id={`runs-${c.id}`}>Recent synchronization</h4>
          {runs.length ? (
            <ul className="today-list" aria-labelledby={`runs-${c.id}`}>
              {runs.map((r, i) => (
                <li key={`${r.started_at ?? ''}-${i}`} className="today-item">
                  <span className="today-item-main">
                    <strong>{RUN_STATE[r.state] ?? r.state}</strong>
                    {r.started_at ? ` · ${new Date(r.started_at).toLocaleString()}` : ''} ·{' '}
                    {r.read_count} read, {r.write_count} written, {r.conflict_count} conflicts
                    {errorText(r.error_code) ? ` · ${errorText(r.error_code)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No synchronization yet.</p>
          )}
          <h4 id={`conflicts-${c.id}`}>Conflicts</h4>
          {conflicts.length ? (
            <ul className="today-list" aria-labelledby={`conflicts-${c.id}`}>
              {conflicts.map((k) => (
                <li key={k.id} className="today-item calendar-conflict" data-conflict={k.id}>
                  <span className="today-item-main">
                    <strong>{k.event.title}</strong>
                    {k.calendar ? <span className="hint"> · {k.calendar}</span> : null}
                    <br />
                    Calendar time: {rangeText(k.event)}
                    <br />
                    {k.block ? `Your block: ${rangeText(k.block)}` : 'No block is linked now.'}
                  </span>
                  <span className="actions-compact">
                    {k.can_keep_local ? (
                      <button
                        type="button"
                        className="button button-ghost"
                        disabled={busy}
                        onClick={() => void resolve(k, 'kept_local')}
                      >
                        Keep my plan<span className="visually-hidden"> for {k.event.title}</span>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="button button-ghost"
                      disabled={busy}
                      onClick={() => void resolve(k, 'kept_remote')}
                    >
                      Use the calendar's time
                      <span className="visually-hidden"> for {k.event.title}</span>
                    </button>
                    <button
                      type="button"
                      className="button button-ghost"
                      disabled={busy}
                      onClick={() => void resolve(k, 'dismissed')}
                    >
                      Unlink<span className="visually-hidden"> {k.event.title}</span>
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No conflicts.</p>
          )}
        </>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const done =
            retention === 'retain'
              ? `${c.display_name} disconnected. Synchronized events were kept.`
              : `${c.display_name} disconnected. Synchronized events were removed.`;
          void act(async () => {
            await api('POST', `/v1/workspaces/${ws}/integrations/connections/${c.id}/disconnect`, {
              body: { retention },
              headers: { 'idempotency-key': newIdempotencyKey() },
            });
            // This card leaves once the list reloads, so the section announces the result.
            announce(done);
          }, done);
        }}
      >
        <fieldset>
          <legend>When disconnecting</legend>
          <label className="choice">
            <input
              type="radio"
              name={`gcal-ret-${c.id}`}
              checked={retention === 'retain'}
              onChange={() => setRetention('retain')}
            />{' '}
            Keep synchronized events
          </label>
          <label className="choice">
            <input
              type="radio"
              name={`gcal-ret-${c.id}`}
              checked={retention === 'remove'}
              onChange={() => setRetention('remove')}
            />{' '}
            Remove synchronized events
          </label>
        </fieldset>
        <button className="button" type="submit" disabled={busy}>
          Disconnect<span className="visually-hidden"> {c.display_name}</span>
        </button>
      </form>
      {error ? (
        <p role="alert" className="field-error">
          {error}
        </p>
      ) : null}
      <p role="status" className="announce">
        {said}
      </p>
    </section>
  );
}
