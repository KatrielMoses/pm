import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, newIdempotencyKey, protectedRequest } from '../api.ts';
import { useStepUp } from '../stepup.tsx';
import { Announce, Banner } from '../ui/feedback.tsx';
import { ErrorSummary, Field, SubmitButton } from '../ui/form.tsx';
import { Page } from '../ui/layout.tsx';

interface TokenRow {
  id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  state: string;
  secret?: string;
}

interface SubscriptionRow {
  id: string;
  destination_url: string;
  event_types: string[];
  state: string;
  consecutive_failures?: number;
}

interface DeliveryRow {
  id: string;
  event_type: string;
  state: string;
  attempt: number;
  response_status: number | null;
  created_at: string;
}

/** Public webhook event names (v1), as the API accepts them. */
const WEBHOOK_EVENTS = [
  'task.created',
  'task.updated',
  'task.status_changed',
  'task.completed',
  'task.assigned',
  'project.created',
  'project.status_changed',
  'comment.created',
  'review.requested',
  'review.decided',
  'deliverable.submitted',
  'record.archived',
  'record.trashed',
  'record.restored',
  'operation.finished',
  'agent_run.output_returned',
  'test_result.recorded',
  'defect.verified',
  'release.decided',
  'deployment.recorded',
] as const;

const SUB_STATE: Record<string, string> = {
  active: 'Active',
  disabled_endpoint: 'Paused after repeated failures',
  suspended: 'Suspended',
};

const DELIVERY_STATE: Record<string, string> = {
  pending: 'Waiting to send',
  retry_scheduled: 'Retry scheduled',
  unknown: 'Outcome unknown, retrying',
  delivered: 'Delivered',
  failed: 'Failed',
  dead: 'Failed',
};

const statusClass = (status: number | null) =>
  status === null ? 'No response' : `${Math.floor(status / 100)}xx`;

const EXAMPLE = `curl https://example.com/v1/workspaces/wsp_…/tasks \\
  -H "authorization: Bearer pm_…" \\
  -H "idempotency-key: $(uuidgen)"`;

const describe = (err: unknown, fallback: string) =>
  err instanceof ApiError
    ? err.code === 'cancelled'
      ? 'Cancelled.'
      : (err.issues[0]?.message ?? err.message)
    : fallback;

/**
 * API tokens, webhook endpoints, and the versioned examples (INT-017, INT-019, ADM-007).
 * The secret is shown once, in this response, and is not stored in the page after dismissal.
 */
export function ApiAccessPage({ ws }: { ws: string }) {
  const stepUp = useStepUp();
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');

  const listTokens = useCallback(
    async () =>
      (await api<{ data: { tokens: TokenRow[] } }>('GET', `/v1/workspaces/${ws}/api-tokens`)).body
        .data.tokens,
    [ws],
  );

  useEffect(() => {
    let gone = false;
    listTokens()
      .then((rows) => {
        if (!gone) setTokens(rows);
      })
      .catch(() => {
        if (!gone) setError('Tokens could not be loaded.');
      });
    return () => {
      gone = true;
    };
  }, [listTokens]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaid('');
    try {
      const result = await protectedRequest<{ data: TokenRow }>(
        'POST',
        `/v1/workspaces/${ws}/api-tokens`,
        { name, kind: 'personal', scopes: ['records:read'] },
        stepUp,
      );
      setSecret(result.body.data.secret ?? null);
      setName('');
      setSaid('Token created. Copy it now.');
      setTokens(await listTokens());
    } catch {
      setError('The token was not created.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (t: TokenRow) => {
    setBusy(true);
    setError(null);
    setSaid('');
    try {
      await protectedRequest('POST', `/v1/workspaces/${ws}/api-tokens/${t.id}:revoke`, {}, stepUp);
      setSaid(`${t.name} revoked. It no longer works.`);
      setTokens(await listTokens());
    } catch (err) {
      setError(describe(err, 'The token was not revoked.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="API and webhooks" wide>
      <p>
        Tokens act as you, only within the scopes you choose. A token is shown once. Requests still
        follow the same access rules as the app.
      </p>
      {error ? (
        <Banner tone="danger" title="Something went wrong">
          {error}
        </Banner>
      ) : null}
      {secret ? (
        <Banner tone="warning" title="Copy this token now">
          <p>
            <code data-testid="new-token">{secret}</code>
          </p>
          <button type="button" onClick={() => setSecret(null)}>
            I have copied it
          </button>
        </Banner>
      ) : null}
      <section aria-labelledby="tokens-heading" aria-busy={busy ? 'true' : 'false'}>
        <form onSubmit={create} aria-labelledby="new-token-heading">
          <h2 id="new-token-heading">New personal token</h2>
          <ErrorSummary errors={{}} labels={{}} focusKey={0} />
          <Field
            id="token-name"
            label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <SubmitButton busy={busy}>Create token</SubmitButton>
        </form>
        <h2 id="tokens-heading">Your tokens</h2>
        {tokens.length === 0 ? <p>No tokens yet.</p> : null}
        <ul aria-label="API tokens" className="today-list">
          {tokens.map((t) => (
            <li key={t.id} className="today-item" data-token={t.id}>
              <span className="today-item-main">
                {t.name} <span>{t.token_prefix}…</span> {t.state}
              </span>
              {t.state === 'active' ? (
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={busy}
                  onClick={() => void revoke(t)}
                >
                  Revoke<span className="visually-hidden"> {t.name}</span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
      <WebhooksSection ws={ws} />
      <h2>Example</h2>
      <pre>
        <code>{EXAMPLE}</code>
      </pre>
      <Announce>{said}</Announce>
    </Page>
  );
}

/**
 * Webhook endpoints (INT-014, INT-015): public HTTPS destinations, the public event names they
 * receive, a signing secret shown once, test sends, and recent deliveries with replay.
 */
function WebhooksSection({ ws }: { ws: string }) {
  const [subs, setSubs] = useState<SubscriptionRow[] | null>(null);
  const [url, setUrl] = useState('https://');
  const [events, setEvents] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, DeliveryRow[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const base = `/v1/workspaces/${ws}`;

  const listSubs = useCallback(
    async () =>
      (
        await api<{ data: { subscriptions: SubscriptionRow[] } }>(
          'GET',
          `${base}/webhook-subscriptions`,
        )
      ).body.data.subscriptions,
    [base],
  );

  useEffect(() => {
    let gone = false;
    listSubs()
      .then((rows) => {
        if (!gone) setSubs(rows);
      })
      .catch((err: unknown) => {
        if (gone) return;
        setSubs([]);
        if (err instanceof ApiError && err.code === 'forbidden') setForbidden(true);
        else setError('Webhooks could not be loaded.');
      });
    return () => {
      gone = true;
    };
  }, [listSubs]);

  const run = async (fn: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setSaid('');
    try {
      setSaid(await fn());
    } catch (err) {
      setError(describe(err, 'That did not work. Try again.'));
    } finally {
      setBusy(false);
    }
  };
  const post = <T,>(path: string, body: unknown = {}) =>
    api<T>('POST', path, { body, headers: { 'idempotency-key': newIdempotencyKey() } });
  const loadDeliveries = async (sub: string) => {
    const r = await api<{ data: { deliveries: DeliveryRow[] } }>(
      'GET',
      `${base}/webhook-subscriptions/${sub}/deliveries`,
    );
    setDeliveries((d) => ({ ...d, [sub]: r.body.data.deliveries.slice(0, 20) }));
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await post<{ data: { secret?: string } }>(`${base}/webhook-subscriptions`, {
        destination_url: url.trim(),
        event_types: events,
      });
      setSecret(r.body.data.secret ?? null);
      setUrl('https://');
      setEvents([]);
      setSubs(await listSubs());
      return 'Endpoint added. Copy its signing secret now.';
    });
  };

  return (
    <section
      aria-labelledby="webhooks-heading"
      className="webhook-settings"
      aria-busy={busy || subs === null ? 'true' : 'false'}
    >
      <h2 id="webhooks-heading">Webhooks</h2>
      <p>
        Endpoints receive signed HTTPS requests for the public events you choose. Payloads carry
        identifiers and categories only, never record content.
      </p>
      {error ? (
        <p role="alert" className="field-error">
          {error}
        </p>
      ) : null}
      {secret ? (
        <Banner tone="warning" title="Copy this signing secret now">
          <p>
            <code data-testid="webhook-secret">{secret}</code>
          </p>
          <p>It is not shown again. Use it to verify the webhook-signature header.</p>
          <button type="button" onClick={() => setSecret(null)}>
            I have copied it
          </button>
        </Banner>
      ) : null}
      {forbidden ? <p>You do not have permission to manage webhooks in this workspace.</p> : null}
      <form
        className="portability-controls"
        aria-labelledby="new-webhook-heading"
        onSubmit={create}
        hidden={forbidden}
      >
        <h3 id="new-webhook-heading">Add an endpoint</h3>
        <label htmlFor="webhook-url">HTTPS endpoint URL</label>
        <input
          id="webhook-url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
        <fieldset className="webhook-events">
          <legend>Events to send</legend>
          {WEBHOOK_EVENTS.map((name) => (
            <label key={name} className="choice">
              <input
                type="checkbox"
                checked={events.includes(name)}
                onChange={(e) =>
                  setEvents((x) => (e.target.checked ? [...x, name] : x.filter((y) => y !== name)))
                }
              />{' '}
              {name}
            </label>
          ))}
        </fieldset>
        <button
          className="button button-primary"
          type="submit"
          disabled={busy || !events.length || !url.startsWith('https://')}
        >
          Add endpoint
        </button>
      </form>
      <h3 id="webhook-list-heading" hidden={forbidden}>
        Endpoints
      </h3>
      {subs && !subs.length && !forbidden ? <p>No endpoints yet.</p> : null}
      <ul aria-labelledby="webhook-list-heading" className="today-list">
        {(subs ?? []).map((s) => (
          <li key={s.id} className="webhook-endpoint" data-subscription={s.id}>
            <p className="today-item-main">
              <strong>{s.destination_url}</strong> · {SUB_STATE[s.state] ?? s.state}
              {s.consecutive_failures ? ` · ${s.consecutive_failures} failures in a row` : ''}
            </p>
            <p className="hint">Events: {s.event_types.join(', ')}</p>
            <div className="actions-compact">
              <button
                type="button"
                className="button button-ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await post(`${base}/webhook-subscriptions/${s.id}:test`);
                    await loadDeliveries(s.id);
                    return 'Test event queued. Its delivery appears below.';
                  })
                }
              >
                Send test event<span className="visually-hidden"> to {s.destination_url}</span>
              </button>
              <button
                type="button"
                className="button button-ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const r = await post<{ data: { secret?: string } }>(
                      `${base}/webhook-subscriptions/${s.id}:rotate-secret`,
                    );
                    setSecret(r.body.data.secret ?? null);
                    return 'Signing secret rotated. The previous secret keeps working for a short overlap.';
                  })
                }
              >
                Rotate signing secret
                <span className="visually-hidden"> for {s.destination_url}</span>
              </button>
              <button
                type="button"
                className="button button-ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await loadDeliveries(s.id);
                    return 'Deliveries loaded.';
                  })
                }
              >
                Show deliveries<span className="visually-hidden"> for {s.destination_url}</span>
              </button>
            </div>
            {deliveries[s.id] ? (
              deliveries[s.id]!.length ? (
                <div
                  className="webhook-deliveries-wrap"
                  role="region"
                  aria-label={`Deliveries to ${s.destination_url}`}
                  tabIndex={0}
                >
                  <table className="webhook-deliveries">
                    <caption>Recent deliveries to {s.destination_url}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Event</th>
                        <th scope="col">State</th>
                        <th scope="col">Attempts</th>
                        <th scope="col">Response</th>
                        <th scope="col">
                          <span className="visually-hidden">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {deliveries[s.id]!.map((d) => (
                        <tr key={d.id} data-delivery={d.id}>
                          <td>{d.event_type}</td>
                          <td>{DELIVERY_STATE[d.state] ?? d.state}</td>
                          <td>{d.attempt}</td>
                          <td>{statusClass(d.response_status)}</td>
                          <td>
                            {d.state === 'failed' || d.state === 'dead' ? (
                              <button
                                type="button"
                                className="button button-ghost"
                                disabled={busy}
                                onClick={() =>
                                  void run(async () => {
                                    await post(`${base}/webhook-deliveries/${d.id}:replay`);
                                    await loadDeliveries(s.id);
                                    return 'Delivery queued again.';
                                  })
                                }
                              >
                                Replay<span className="visually-hidden"> {d.event_type}</span>
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="hint">No deliveries yet.</p>
              )
            ) : null}
          </li>
        ))}
      </ul>
      <p role="status" className="announce">
        {said}
      </p>
    </section>
  );
}
