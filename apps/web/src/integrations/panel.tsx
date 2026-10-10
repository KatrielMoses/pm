import { useEffect, useState } from 'react';
import { api, ApiError, newIdempotencyKey } from '../api.ts';

export interface ConnectionView {
  id: string;
  display_name: string;
  provider: string;
  auth_kind: string;
  health: string;
  scopes: string[];
  owner: { id: string; name: string };
  last_success_at: string | null;
  credential_configured: boolean;
  provider_configured: boolean;
  last_error: string | null;
  retention_choice: string | null;
  version: number;
}

export interface ProviderView {
  id: string;
  label: string;
  configured: boolean;
  unavailable: string | null;
  scopes: string[];
}

const HEALTH: Record<string, string> = {
  connected: 'Connected',
  needs_reauthorization: 'Needs reauthorization',
  error: 'Error',
  disconnected: 'Disconnected',
  provider_unconfigured: 'Provider not configured',
  degraded: 'Degraded',
};

export function healthLabel(health: string): string {
  return HEALTH[health] ?? 'Unknown';
}

/** The connections a person may see. Credentials are never part of this view. */
export function ConnectionList({ connections }: { connections: ConnectionView[] }) {
  if (!connections.length) return <p>No connections yet.</p>;
  return (
    <ul>
      {connections.map((c) => (
        <li key={c.id}>
          <article aria-labelledby={`conn-${c.id}`}>
            <h2 id={`conn-${c.id}`}>{c.display_name}</h2>
            <p>
              Status: <strong>{healthLabel(c.health)}</strong>
              {c.provider_configured ? '' : ' (provider not configured)'}
            </p>
            <p>Owner: {c.owner.name}</p>
            <p>Scopes: {c.scopes.join(', ')}</p>
            <p>
              Last successful synchronization:{' '}
              {c.last_success_at ? new Date(c.last_success_at).toLocaleString() : 'Never'}
            </p>
            <p>Credential stored: {c.credential_configured ? 'yes' : 'no'}</p>
            {c.last_error ? <p>Last error: {c.last_error}</p> : null}
          </article>
        </li>
      ))}
    </ul>
  );
}

export function IntegrationsPanel({ ws }: { ws: string }) {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('Loopback');
  const [apiKey, setApiKey] = useState('');
  const [retention, setRetention] = useState<'retain' | 'remove'>('retain');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [prov, list] = await Promise.all([
      api<{ data: { providers: ProviderView[] } }>(
        'GET',
        `/v1/workspaces/${ws}/integrations/providers`,
      ),
      api<{ data: { connections: ConnectionView[] } }>(
        'GET',
        `/v1/workspaces/${ws}/integrations/connections`,
      ),
    ]);
    setProviders(prov.body.data.providers);
    setConnections(list.body.data.connections);
  };

  useEffect(() => {
    let gone = false;
    const t = setTimeout(() => {
      load().catch((e: unknown) => {
        if (!gone) setError(e instanceof ApiError ? e.message : 'Could not load connections.');
      });
    }, 0);
    return () => {
      gone = true;
      clearTimeout(t);
    };
    // load closes over ws, which is the effect's only input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  const post = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await api('POST', path, {
        body,
        headers: { 'idempotency-key': newIdempotencyKey() },
      });
      setApiKey('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  const loopback = providers.find((p) => p.id === 'loopback');

  return (
    <div>
      {error ? <p role="alert">{error}</p> : null}
      <section aria-labelledby="providers-heading">
        <h2 id="providers-heading">Providers</h2>
        <ul>
          {providers.map((p) => (
            <li key={p.id}>
              {p.label}: {p.configured ? 'configured' : 'not configured'}
              {p.unavailable ? `. ${p.unavailable}` : ''}
            </li>
          ))}
        </ul>
      </section>
      <ConnectionList connections={connections} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void post(`/v1/workspaces/${ws}/integrations/connections`, {
            provider: 'loopback',
            auth_kind: 'api_key',
            display_name: name,
            scopes: ['read', 'write'],
            api_key: apiKey,
          });
        }}
      >
        <h2>Connect with an API key</h2>
        {loopback && !loopback.configured ? (
          <p>The loopback provider is not configured in this environment.</p>
        ) : null}
        <p>
          <label htmlFor="conn-name">Name</label>
          <input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </p>
        <p>
          <label htmlFor="conn-key">API key</label>
          <input
            id="conn-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            required
          />
        </p>
        <p>The key is stored encrypted and is not shown again.</p>
        <button className="button button-primary" type="submit" disabled={busy}>
          Connect
        </button>
      </form>
      {connections
        .filter((c) => c.health !== 'disconnected')
        .map((c) => (
          <section key={c.id} aria-labelledby={`act-${c.id}`}>
            <h2 id={`act-${c.id}`}>Actions for {c.display_name}</h2>
            <p>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() =>
                  void post(`/v1/workspaces/${ws}/integrations/connections/${c.id}:test`, {})
                }
              >
                Test connection
              </button>
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void post(`/v1/workspaces/${ws}/integrations/connections/${c.id}:disconnect`, {
                  retention,
                });
              }}
            >
              <fieldset>
                <legend>When disconnecting</legend>
                <label>
                  <input
                    type="radio"
                    name={`ret-${c.id}`}
                    checked={retention === 'retain'}
                    onChange={() => setRetention('retain')}
                  />
                  Keep synchronized data
                </label>
                <label>
                  <input
                    type="radio"
                    name={`ret-${c.id}`}
                    checked={retention === 'remove'}
                    onChange={() => setRetention('remove')}
                  />
                  Remove synchronized data
                </label>
              </fieldset>
              <button className="button" type="submit" disabled={busy}>
                Disconnect
              </button>
            </form>
          </section>
        ))}
    </div>
  );
}
