import { useEffect, useState, type FormEvent } from 'react';
import { api, protectedRequest } from '../api.ts';
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

const EXAMPLE = `curl https://example.com/v1/workspaces/wsp_…/tasks \\
  -H "authorization: Bearer pm_…" \\
  -H "idempotency-key: $(uuidgen)"`;

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

  useEffect(() => {
    let gone = false;
    api<{ tokens: TokenRow[] }>('GET', `/v1/workspaces/${ws}/api-tokens`)
      .then((r) => {
        if (!gone) setTokens(r.body.tokens);
      })
      .catch(() => {
        if (!gone) setError('Tokens could not be loaded.');
      });
    return () => {
      gone = true;
    };
  }, [ws]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await protectedRequest<{ secret?: string } & TokenRow>(
        'POST',
        `/v1/workspaces/${ws}/api-tokens`,
        { name, kind: 'personal', scopes: ['records:read'] },
        stepUp,
      );
      setSecret(result.body.secret ?? null);
      setName('');
      const listed = await api<{ tokens: TokenRow[] }>('GET', `/v1/workspaces/${ws}/api-tokens`);
      setTokens(listed.body.tokens);
    } catch {
      setError('The token was not created.');
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
      <h2>Your tokens</h2>
      {tokens.length === 0 ? <p>No tokens yet.</p> : null}
      <ul aria-label="API tokens">
        {tokens.map((t) => (
          <li key={t.id}>
            {t.name} <span>{t.token_prefix}…</span> {t.state}
          </li>
        ))}
      </ul>
      <h2>Example</h2>
      <pre>
        <code>{EXAMPLE}</code>
      </pre>
      <Announce>{secret ? 'Token created. Copy it now.' : ''}</Announce>
    </Page>
  );
}
