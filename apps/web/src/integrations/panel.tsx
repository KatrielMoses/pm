import { useEffect, useState, type FormEvent } from 'react';
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

interface McpCapabilitiesView {
  protocol_version: string;
  registry_version: string;
  mcp_enabled: boolean;
  tools: Array<{ name: string; version: string }>;
  resources: Array<{ uri: string; name: string }>;
}

interface OAuthClientView {
  id: string;
  name: string;
  allowed_scopes: string[];
  redirect_uris: string[];
  consent: { scopes: string[]; state: 'active' | 'revoked' } | null;
}

const MCP_SCOPES = ['records:read', 'records:write', 'views:read'] as const;

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
  const [mcp, setMcp] = useState<McpCapabilitiesView | null>(null);
  const [oauthClients, setOauthClients] = useState<OAuthClientView[]>([]);
  const [canConfigureMcp, setCanConfigureMcp] = useState(false);
  const [clientName, setClientName] = useState('');
  const [redirectUri, setRedirectUri] = useState('https://');
  const [clientSecret, setClientSecret] = useState<{ id: string; value: string } | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [selectedScopes, setSelectedScopes] = useState<Record<string, string[]>>({});
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

    // MCP may be disabled or inaccessible in an otherwise healthy integrations environment.
    // Keep the established provider and connection UI usable when its optional discovery fails.
    const [capabilities, clients] = await Promise.allSettled([
      api<{ data: McpCapabilitiesView }>('GET', `/v1/workspaces/${ws}/mcp/capabilities`),
      api<{ data: { clients: OAuthClientView[]; can_configure: boolean } }>(
        'GET',
        `/v1/workspaces/${ws}/oauth-clients`,
      ),
    ]);
    if (capabilities.status === 'fulfilled') setMcp(capabilities.value.body.data);
    else setMcp(null);
    if (clients.status === 'fulfilled') {
      setOauthClients(clients.value.body.data.clients);
      setCanConfigureMcp(clients.value.body.data.can_configure);
    } else {
      setOauthClients([]);
      setCanConfigureMcp(false);
    }
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

  const createMcpClient = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setClientSecret(null);
    setAccessToken(null);
    try {
      const result = await api<{ data: { id: string; client_secret: string } }>(
        'POST',
        `/v1/workspaces/${ws}/oauth-clients`,
        {
          body: { name: clientName, redirect_uris: [redirectUri], scopes: ['records:read'] },
          headers: { 'idempotency-key': newIdempotencyKey() },
        },
      );
      setClientSecret({ id: result.body.data.id, value: result.body.data.client_secret });
      setClientName('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not register the MCP client.');
    } finally {
      setBusy(false);
    }
  };

  const grantConsent = async (client: OAuthClientView) => {
    const scopes = selectedScopes[client.id] ?? [];
    if (!scopes.length) return;
    await post(`/v1/workspaces/${ws}/oauth-clients/${client.id}/consent`, { scopes });
  };

  const revokeConsent = async (client: OAuthClientView) => {
    await post(`/v1/workspaces/${ws}/oauth-clients/${client.id}/consent/revoke`, {});
  };

  const revokeMcpClient = async (client: OAuthClientView) => {
    await post(`/v1/workspaces/${ws}/oauth-clients/${client.id}:revoke`, {});
  };

  const issueMcpToken = async () => {
    if (!clientSecret) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ access_token: string }>(
        'POST',
        `/v1/workspaces/${ws}/oauth-clients/${clientSecret.id}/token`,
        {
          body: { client_id: clientSecret.id, client_secret: clientSecret.value },
          headers: { 'idempotency-key': newIdempotencyKey() },
        },
      );
      setAccessToken(result.body.access_token);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not issue an access token.');
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
                  void post(`/v1/workspaces/${ws}/integrations/connections/${c.id}/test`, {})
                }
              >
                Test connection
              </button>
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void post(`/v1/workspaces/${ws}/integrations/connections/${c.id}/disconnect`, {
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
      <section aria-labelledby="mcp-heading">
        <h2 id="mcp-heading">MCP access</h2>
        <p>
          {mcp?.mcp_enabled
            ? `Available · protocol ${mcp.protocol_version} · registry ${mcp.registry_version}`
            : 'MCP access is not configured in this environment.'}
        </p>
        <p>
          Workspace endpoint: <code>/v1/workspaces/{ws}/mcp</code>
        </p>
        <p>
          Registered tools use this workspace’s current access policies. Each client receives only
          the scopes granted by a member and may be revoked from these settings.
        </p>
        {mcp?.tools.length ? (
          <ul aria-label="Available MCP tools">
            {mcp.tools.map((tool) => (
              <li key={tool.name}>
                {tool.name} · v{tool.version}
              </li>
            ))}
          </ul>
        ) : null}
        {mcp ? (
          <p>
            Help resource: <code>pm://workspace/mcp/help</code>
          </p>
        ) : null}
        {canConfigureMcp ? (
          <form onSubmit={(e) => void createMcpClient(e)}>
            <h3>Register a client</h3>
            <p>
              <label htmlFor="mcp-client-name">Client name</label>
              <input
                id="mcp-client-name"
                value={clientName}
                maxLength={80}
                onChange={(e) => setClientName(e.target.value)}
                required
              />
            </p>
            <p>
              <label htmlFor="mcp-redirect-uri">HTTPS redirect URI</label>
              <input
                id="mcp-redirect-uri"
                type="url"
                value={redirectUri}
                onChange={(e) => setRedirectUri(e.target.value)}
                required
              />
            </p>
            <p>
              New clients start with read-only task access. A member can grant additional scopes.
            </p>
            <button
              className="button button-primary"
              type="submit"
              disabled={busy || !clientName.trim()}
            >
              Register client
            </button>
          </form>
        ) : null}
        {clientSecret ? (
          <section aria-labelledby="mcp-secret-heading" aria-live="polite">
            <h3 id="mcp-secret-heading">Client secret · shown once</h3>
            <p>Save this secret in the client now. It cannot be viewed again.</p>
            <output>{clientSecret.value}</output>
            {oauthClients.find((client) => client.id === clientSecret.id)?.consent?.state ===
            'active' ? (
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => void issueMcpToken()}
              >
                Generate access token
              </button>
            ) : (
              <p>Grant this client consent below before generating an access token.</p>
            )}
            {accessToken ? (
              <p role="status">
                Access token · copy now: <output>{accessToken}</output>
              </p>
            ) : null}
          </section>
        ) : null}
        {oauthClients.length ? (
          <section aria-labelledby="mcp-clients-heading">
            <h3 id="mcp-clients-heading">Registered clients</h3>
            <ul>
              {oauthClients.map((client) => (
                <li key={client.id}>
                  <h4>{client.name}</h4>
                  <p>Allowed scopes: {client.allowed_scopes.join(', ')}</p>
                  <p>Consent: {client.consent?.state ?? 'not granted'}</p>
                  <fieldset>
                    <legend>Scopes to grant this client</legend>
                    {client.allowed_scopes
                      .filter((scope) => MCP_SCOPES.includes(scope as (typeof MCP_SCOPES)[number]))
                      .map((scope) => (
                        <label key={scope}>
                          <input
                            type="checkbox"
                            checked={(
                              selectedScopes[client.id] ??
                              client.consent?.scopes ??
                              []
                            ).includes(scope)}
                            onChange={(e) =>
                              setSelectedScopes((current) => {
                                const selected = new Set(
                                  current[client.id] ?? client.consent?.scopes ?? [],
                                );
                                if (e.target.checked) selected.add(scope);
                                else selected.delete(scope);
                                return { ...current, [client.id]: [...selected] };
                              })
                            }
                          />
                          {scope}
                        </label>
                      ))}
                  </fieldset>
                  <button
                    type="button"
                    className="button"
                    disabled={busy || !(selectedScopes[client.id] ?? []).length}
                    onClick={() => void grantConsent(client)}
                  >
                    Grant selected scopes
                  </button>
                  {client.consent?.state === 'active' ? (
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      onClick={() => void revokeConsent(client)}
                    >
                      Revoke my consent
                    </button>
                  ) : null}
                  {canConfigureMcp ? (
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      onClick={() => void revokeMcpClient(client)}
                    >
                      Revoke client for workspace
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </section>
    </div>
  );
}
