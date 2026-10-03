import { useCallback, useEffect, useState } from 'react';
import { renderSVG } from 'uqr';
import { api, ApiError, protectedPost } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Link, useRouter } from '../router.tsx';
import { useStepUp } from '../stepup.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Announce, Banner, ProblemBanner } from '../ui/feedback.tsx';
import {
  ErrorSummary,
  Field,
  fieldErrorsFrom,
  PasswordField,
  SubmitButton,
  useSubmit,
} from '../ui/form.tsx';
import { Page } from '../ui/layout.tsx';

interface Session {
  id: string;
  device: string;
  created_at: string;
  last_seen_at: string;
  current: boolean;
  state: 'active' | 'revoked' | 'expired';
}

interface OAuthIdentity {
  id: string;
  provider: string;
  provider_email: string | null;
  linked_at: string;
}

const when = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );

export function AccountSecurityPage() {
  const { me, refresh } = useAuth();
  const { navigate } = useRouter();
  useEffect(() => {
    if (me === null) navigate('/sign-in', { replace: true });
  }, [me, navigate]);
  if (!me) return <Page title="Account security">{null}</Page>;
  return (
    <Page title="Account security" wide lead={`Signed in as ${me.email}`}>
      <p>
        <Link to="/onboarding">Back</Link>
      </p>
      <PasswordSection onChanged={() => void refresh()} />
      <TwoStepSection />
      <SessionsSection />
      <SignInMethodsSection />
    </Page>
  );
}

function PasswordSection({ onChanged }: { onChanged: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const form = useSubmit(async () => {
    await api('POST', '/v1/auth/password:change', {
      body: { current_password: current, new_password: next },
    });
    setCurrent('');
    setNext('');
    onChanged();
  });
  const errors = fieldErrorsFrom(form.error, {
    '/current_password': 'current_password',
    '/new_password': 'new_password',
  });
  return (
    <section className="card" aria-labelledby="password-heading">
      <h2 id="password-heading">Password</h2>
      {form.status === 'done' ? (
        <Announce>Password changed. Your other sessions were signed out.</Announce>
      ) : null}
      <ProblemBanner error={form.error} />
      <ErrorSummary
        errors={errors}
        labels={{ current_password: 'Current password', new_password: 'New password' }}
        focusKey={form.attempt}
      />
      <form onSubmit={form.submit} noValidate>
        <PasswordField
          id="current_password"
          label="Current password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          error={errors.current_password}
          required
        />
        <PasswordField
          id="new_password"
          label="New password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          error={errors.new_password}
          hint="At least 12 characters. Changing it signs out your other sessions."
          required
        />
        <div className="actions">
          <SubmitButton busy={form.submitting}>Change password</SubmitButton>
        </div>
      </form>
    </section>
  );
}

function TwoStepSection() {
  const { me, refresh } = useAuth();
  const stepUp = useStepUp();
  const [enrollment, setEnrollment] = useState<{ id: string; secret: string; uri: string } | null>(
    null,
  );
  const [codes, setCodes] = useState<string[] | null>(null);
  const [confirming, setConfirming] = useState<'disable' | 'regenerate' | null>(null);
  const [code, setCode] = useState('');
  const [replayed, setReplayed] = useState(false);

  const start = useSubmit(async () => {
    const r = await protectedPost<{
      data: { id: string; secret: string; otpauth_uri: string } | { status: string };
    }>('/v1/auth/mfa/totp:enroll', {}, stepUp);
    const d = r.body.data;
    if ('secret' in d) setEnrollment({ id: d.id, secret: d.secret, uri: d.otpauth_uri });
    else setReplayed(true);
  });
  const confirm = useSubmit(async () => {
    const r = await protectedPost<{ data: { codes: string[] } }>(
      '/v1/auth/mfa/totp:confirm',
      { factor: enrollment!.id, code },
      stepUp,
    );
    setEnrollment(null);
    setCode('');
    setCodes(r.body.data.codes);
    await refresh();
  });
  const action = useSubmit(async () => {
    if (confirming === 'disable') {
      await protectedPost('/v1/auth/mfa/totp:disable', {}, stepUp);
      setConfirming(null);
      await refresh();
    } else if (confirming === 'regenerate') {
      const r = await protectedPost<{ data: { codes?: string[] } }>(
        '/v1/auth/mfa/recovery-codes:regenerate',
        {},
        stepUp,
      );
      setConfirming(null);
      if (r.body.data.codes) setCodes(r.body.data.codes);
      await refresh();
    }
  });
  const cancelled = (e: unknown) => e instanceof ApiError && e.code === 'cancelled';
  const confirmErrors = fieldErrorsFrom(confirm.error, { '/code': 'totp_code' });

  if (codes) return <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />;
  return (
    <section className="card" aria-labelledby="mfa-heading">
      <h2 id="mfa-heading">Two-step verification</h2>
      {me?.mfa.totp ? (
        <>
          <p>
            <span className="badge badge-success">
              <span aria-hidden="true">✓ </span>On
            </span>{' '}
            You'll enter a code from your authenticator app when you sign in. Recovery codes left:{' '}
            {me.mfa.recovery_codes_remaining}.
          </p>
          <div className="actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setConfirming('regenerate')}
            >
              Create new recovery codes
            </button>
            <button
              type="button"
              className="button button-danger"
              onClick={() => setConfirming('disable')}
            >
              Turn off two-step verification
            </button>
          </div>
        </>
      ) : enrollment ? (
        <div className="enroll">
          <ol>
            <li>Open your authenticator app and scan this code, or enter the setup key.</li>
            <li>Enter the 6-digit code the app shows.</li>
          </ol>
          <div
            className="qr"
            role="img"
            aria-label="QR code for your authenticator app"
            dangerouslySetInnerHTML={{ __html: renderSVG(enrollment.uri, { border: 2 }) }}
          />
          <p>
            Setup key:{' '}
            <code className="secret">{enrollment.secret.match(/.{1,4}/g)!.join(' ')}</code>
          </p>
          <ProblemBanner error={confirm.error} />
          <ErrorSummary
            errors={confirmErrors}
            labels={{ totp_code: 'Code' }}
            focusKey={confirm.attempt}
          />
          <form onSubmit={confirm.submit} noValidate>
            <Field
              id="totp_code"
              label="Code from your app"
              autoComplete="one-time-code"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              error={confirmErrors.totp_code}
              required
            />
            <div className="actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setEnrollment(null)}
              >
                Cancel
              </button>
              <SubmitButton busy={confirm.submitting}>Turn on</SubmitButton>
            </div>
          </form>
        </div>
      ) : (
        <>
          <p>
            <span className="badge">Off</span> Add a second step to sign-in with an authenticator
            app.
          </p>
          {replayed ? (
            <Banner
              tone="info"
              title="Setup was already started. Start again to see a new setup key."
            />
          ) : null}
          {cancelled(start.error) ? null : <ProblemBanner error={start.error} />}
          <button
            type="button"
            className="button button-primary"
            onClick={() => void start.submit()}
            disabled={start.submitting}
          >
            Set up two-step verification
          </button>
        </>
      )}
      {confirming ? (
        <Dialog
          destructive={confirming === 'disable'}
          title={
            confirming === 'disable'
              ? 'Turn off two-step verification?'
              : 'Create new recovery codes?'
          }
          description={
            confirming === 'disable' ? (
              <p>
                Signing in will need only your password. Your recovery codes stop working. You'll
                confirm it's you first.
              </p>
            ) : (
              <p>
                Your current recovery codes stop working immediately. You'll confirm it's you first.
              </p>
            )
          }
          onClose={() => setConfirming(null)}
        >
          {cancelled(action.error) ? null : <ProblemBanner error={action.error} />}
          <div className="actions">
            <button
              type="button"
              className="button button-secondary"
              data-cancel
              onClick={() => setConfirming(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={
                confirming === 'disable' ? 'button button-danger' : 'button button-primary'
              }
              disabled={action.submitting}
              onClick={() => void action.submit()}
            >
              {confirming === 'disable' ? 'Turn off' : 'Create new codes'}
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}

/** Shown once (never stored in the browser, logs, or analytics). The user confirms they saved them. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = `PM recovery codes (each works once)\n\n${codes.join('\n')}\n`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pm-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section className="card recovery" aria-labelledby="codes-heading">
      <h2 id="codes-heading">Save your recovery codes</h2>
      <Banner tone="warning" title="These codes are shown only once.">
        Use one if you can't get a code from your app. Store them somewhere safe, like a password
        manager.
      </Banner>
      <ul className="codes" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ul>
      <div className="actions">
        <button
          type="button"
          className="button button-secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => setCopied(true));
          }}
        >
          Copy
        </button>
        <button type="button" className="button button-secondary" onClick={download}>
          Download
        </button>
        <button type="button" className="button button-secondary" onClick={() => window.print()}>
          Print
        </button>
      </div>
      {copied ? <Announce>Codes copied.</Announce> : null}
      <label className="choice">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I've saved these codes somewhere safe
      </label>
      <div className="actions">
        <button type="button" className="button button-primary" disabled={!saved} onClick={onDone}>
          Done
        </button>
      </div>
    </section>
  );
}

function SessionsSection() {
  const { navigate } = useRouter();
  const { signOut } = useAuth();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState<
    { kind: 'one'; session: Session } | { kind: 'others' } | { kind: 'all' } | null
  >(null);
  const load = useCallback(async () => {
    try {
      setSessions((await api<{ data: Session[] }>('GET', '/v1/auth/sessions')).body.data);
      setLoadError(null);
    } catch (e) {
      setLoadError(e);
    }
  }, []);
  useEffect(() => {
    let active = true;
    api<{ data: Session[] }>('GET', '/v1/auth/sessions').then(
      (r) => active && setSessions(r.body.data),
      (e: unknown) => active && setLoadError(e),
    );
    return () => {
      active = false;
    };
  }, []);
  const action = useSubmit(async () => {
    if (!confirm) return;
    if (confirm.kind === 'one') await api('POST', `/v1/auth/sessions/${confirm.session.id}:revoke`);
    if (confirm.kind === 'others') await api('POST', '/v1/auth/sessions:revoke-others');
    if (confirm.kind === 'all') {
      await api('POST', '/v1/auth/sessions:revoke-all');
      setConfirm(null);
      await signOut();
      navigate('/sign-in');
      return;
    }
    setConfirm(null);
    await load();
  });
  const active = sessions?.filter((s) => s.state === 'active') ?? [];
  return (
    <section className="card" aria-labelledby="sessions-heading">
      <h2 id="sessions-heading">Where you're signed in</h2>
      {loadError ? <ProblemBanner error={loadError} onRetry={() => void load()} /> : null}
      {sessions === null && !loadError ? <p role="status">Loading sessions…</p> : null}
      {sessions ? (
        <ul className="sessions">
          {sessions.map((s) => (
            <li key={s.id} className="session">
              <div>
                <p className="session-device">
                  {s.device}
                  {s.current ? (
                    <span className="badge badge-info">
                      <span aria-hidden="true">● </span>This device
                    </span>
                  ) : null}
                  {s.state !== 'active' ? (
                    <span className="badge">
                      {s.state === 'revoked' ? 'Signed out' : 'Expired'}
                    </span>
                  ) : null}
                </p>
                <p className="hint">
                  Signed in {when(s.created_at)} · Last active {when(s.last_seen_at)}
                </p>
              </div>
              {s.state === 'active' && !s.current ? (
                <button
                  type="button"
                  className="button button-secondary"
                  aria-label={`Sign out ${s.device}, signed in ${when(s.created_at)}`}
                  onClick={() => setConfirm({ kind: 'one', session: s })}
                >
                  Sign out
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="actions">
        {active.length > 1 ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setConfirm({ kind: 'others' })}
          >
            Sign out of all other sessions
          </button>
        ) : null}
        <button
          type="button"
          className="button button-danger"
          onClick={() => setConfirm({ kind: 'all' })}
        >
          Sign out everywhere
        </button>
      </div>
      {confirm ? (
        <Dialog
          destructive={confirm.kind === 'all'}
          title={
            confirm.kind === 'one'
              ? `Sign out ${confirm.session.device}?`
              : confirm.kind === 'others'
                ? 'Sign out of all other sessions?'
                : 'Sign out everywhere?'
          }
          description={
            <p>
              {confirm.kind === 'one'
                ? 'That device will need to sign in again.'
                : confirm.kind === 'others'
                  ? `${active.length - 1} other session${active.length - 1 === 1 ? '' : 's'} will need to sign in again. This device stays signed in.`
                  : 'Every session, including this one, will be signed out.'}
            </p>
          }
          onClose={() => setConfirm(null)}
        >
          <ProblemBanner error={action.error} />
          <div className="actions">
            <button
              type="button"
              className="button button-secondary"
              data-cancel
              onClick={() => setConfirm(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger"
              data-initial
              disabled={action.submitting}
              onClick={() => void action.submit()}
            >
              {confirm.kind === 'all' ? 'Sign out everywhere' : 'Sign out'}
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}

function SignInMethodsSection() {
  const { search } = useRouter();
  const [identities, setIdentities] = useState<OAuthIdentity[] | null>(null);
  const [providers, setProviders] = useState<Array<{ id: string; name: string }>>([]);
  const [unlinking, setUnlinking] = useState<OAuthIdentity | null>(null);
  const load = useCallback(async () => {
    setIdentities(
      (await api<{ data: OAuthIdentity[] }>('GET', '/v1/auth/oauth/identities')).body.data,
    );
  }, []);
  useEffect(() => {
    void api<{ data: OAuthIdentity[] }>('GET', '/v1/auth/oauth/identities').then(
      (r) => setIdentities(r.body.data),
      () => undefined,
    );
    void api<{ data: { oauth_providers: Array<{ id: string; name: string }> } }>(
      'GET',
      '/v1/auth/config',
    ).then(
      (r) => setProviders(r.body.data.oauth_providers),
      () => undefined,
    );
  }, []);
  const link = useSubmit(async () => {
    const provider = providers[0]!;
    const r = await api<{ data: { url: string } }>('POST', `/v1/auth/oauth/${provider.id}:start`, {
      body: { intent: 'link', return_to: '/account/security' },
    });
    window.location.assign(r.body.data.url);
  });
  const unlink = useSubmit(async () => {
    await api('POST', `/v1/auth/oauth/identities/${unlinking!.id}:unlink`);
    setUnlinking(null);
    await load();
  });
  const oauthError = search.get('oauth_error');
  return (
    <section className="card" aria-labelledby="methods-heading">
      <h2 id="methods-heading">Sign-in methods</h2>
      {search.get('linked') ? <Banner tone="success" title="Sign-in method linked." /> : null}
      {oauthError === 'link_collision' ? (
        <Banner tone="danger" title="That sign-in is already linked to a different account." />
      ) : oauthError ? (
        <Banner tone="danger" title="We couldn't link that sign-in method. Try again." />
      ) : null}
      <p>Password: set</p>
      {identities?.length ? (
        <ul className="sessions">
          {identities.map((i) => (
            <li key={i.id} className="session">
              <div>
                <p className="session-device">
                  {i.provider === 'local' ? 'Local test provider' : i.provider}
                </p>
                <p className="hint">Linked {when(i.linked_at)}</p>
              </div>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setUnlinking(i)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <ProblemBanner error={link.error} />
      {providers.length ? (
        <button
          type="button"
          className="button button-secondary"
          onClick={() => void link.submit()}
          disabled={link.submitting}
        >
          Link {providers[0]!.name}
        </button>
      ) : null}
      {unlinking ? (
        <Dialog
          destructive
          title="Remove this sign-in method?"
          description={
            <p>You won't be able to sign in with it anymore. Your password still works.</p>
          }
          onClose={() => setUnlinking(null)}
        >
          <ProblemBanner error={unlink.error} />
          <div className="actions">
            <button
              type="button"
              className="button button-secondary"
              data-cancel
              onClick={() => setUnlinking(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger"
              disabled={unlink.submitting}
              onClick={() => void unlink.submit()}
            >
              Remove
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
