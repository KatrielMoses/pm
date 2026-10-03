import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Link, takeFragmentToken, useRouter } from '../router.tsx';
import { Banner, ProblemBanner } from '../ui/feedback.tsx';
import {
  ErrorSummary,
  Field,
  fieldErrorsFrom,
  PasswordField,
  SubmitButton,
  useSubmit,
} from '../ui/form.tsx';
import { Page } from '../ui/layout.tsx';

interface AuthConfig {
  terms_version: string;
  privacy_version: string;
  bot_protection: 'none' | 'test';
  oauth_providers: Array<{ id: string; name: string }>;
  password_min_length: number;
}

function useAuthConfig(): AuthConfig | undefined {
  const [cfg, setCfg] = useState<AuthConfig>();
  useEffect(() => {
    void api<{ data: AuthConfig }>('GET', '/v1/auth/config').then(
      (r) => setCfg(r.body.data),
      () => undefined,
    );
  }, []);
  return cfg;
}

/** Address being verified; kept in memory only (never in the URL or storage). */
let pendingEmail = '';

const OAUTH_ERRORS: Record<string, string> = {
  not_linked:
    "That sign-in method isn't linked to an account yet. Sign in with your password, then link it from Account security.",
  denied: 'Sign-in was cancelled at the provider.',
  replay: 'That sign-in link was already used. Start again.',
  state_expired: 'That sign-in took too long. Start again.',
  state_invalid: "We couldn't complete that sign-in. Start again.",
  nonce_mismatch: "We couldn't verify that sign-in. Start again.",
  exchange_failed: "The provider didn't confirm that sign-in. Start again.",
};

export function SignInPage() {
  const { navigate, search } = useRouter();
  const { refresh } = useAuth();
  const cfg = useAuthConfig();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const form = useSubmit(async () => {
    const r = await api<{ data: { state: string } }>('POST', '/v1/auth/sign-in', {
      body: { email, password },
    });
    if (r.body.data.state === 'mfa_required') return navigate('/sign-in/verify');
    const me = await refresh();
    navigate(me && !me.email_verified ? '/verify-email' : '/onboarding');
  });
  const errors = fieldErrorsFrom(form.error, { '/email': 'email', '/password': 'password' });
  const credentialError = form.error instanceof ApiError && form.error.code === 'unauthenticated';
  const oauthError = search.get('oauth_error');
  const startOAuth = async (provider: string) => {
    const r = await api<{ data: { url: string } }>('POST', `/v1/auth/oauth/${provider}:start`, {
      body: { intent: 'sign_in', return_to: '/onboarding' },
    });
    window.location.assign(r.body.data.url);
  };
  return (
    <Page title="Sign in">
      {oauthError ? (
        <Banner
          tone="danger"
          title={OAUTH_ERRORS[oauthError] ?? "We couldn't complete that sign-in."}
        />
      ) : null}
      {credentialError ? (
        <Banner tone="danger" title="The email or password is incorrect." />
      ) : (
        <ProblemBanner error={form.error} onRetry={() => void form.submit()} />
      )}
      <ErrorSummary
        errors={credentialError ? {} : errors}
        labels={{ email: 'Email', password: 'Password' }}
        focusKey={form.attempt}
      />
      <form onSubmit={form.submit} noValidate>
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
          required
        />
        <PasswordField
          id="password"
          label="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          required
        />
        <div className="actions">
          <SubmitButton busy={form.submitting}>Sign in</SubmitButton>
        </div>
      </form>
      <p>
        <Link to="/forgot-password">Forgot password?</Link>
      </p>
      {cfg?.oauth_providers.length ? (
        <section aria-labelledby="other-ways">
          <h2 id="other-ways">Other ways to sign in</h2>
          {cfg.oauth_providers.map((p) => (
            <button
              key={p.id}
              type="button"
              className="button button-secondary"
              onClick={() => void startOAuth(p.id)}
            >
              Continue with {p.name}
            </button>
          ))}
        </section>
      ) : null}
      <p>
        New here? <Link to="/register">Create an account</Link>
      </p>
    </Page>
  );
}

export function SignInVerifyPage() {
  const { navigate } = useRouter();
  const { refresh } = useAuth();
  const [method, setMethod] = useState<'totp' | 'recovery_code'>('totp');
  const [code, setCode] = useState('');
  const form = useSubmit(async () => {
    await api('POST', '/v1/auth/sign-in:mfa', { body: { method, code } });
    const me = await refresh();
    navigate(me && !me.email_verified ? '/verify-email' : '/onboarding');
  });
  const restart = form.error instanceof ApiError && form.error.code === 'unauthenticated';
  const errors = fieldErrorsFrom(form.error, { '/code': 'code' });
  const label = method === 'totp' ? 'Authenticator code' : 'Recovery code';
  return (
    <Page title="Two-step verification" lead="Enter a code to finish signing in.">
      {restart ? (
        <Banner
          tone="danger"
          title="Your sign-in expired."
          action={<Link to="/sign-in">Sign in again</Link>}
        >
          For your security, sign-in steps time out.
        </Banner>
      ) : (
        <ProblemBanner error={form.error} />
      )}
      <ErrorSummary errors={errors} labels={{ code: label }} focusKey={form.attempt} />
      <form onSubmit={form.submit} noValidate>
        <Field
          id="code"
          label={label}
          autoComplete="one-time-code"
          inputMode={method === 'totp' ? 'numeric' : 'text'}
          hint={
            method === 'totp'
              ? 'The 6-digit code from your authenticator app. Codes change every 30 seconds.'
              : 'One of the recovery codes you saved. Each works once.'
          }
          value={code}
          onChange={(e) => setCode(e.target.value)}
          error={errors.code}
          required
        />
        <div className="actions">
          <SubmitButton busy={form.submitting}>Verify</SubmitButton>
        </div>
      </form>
      <button
        type="button"
        className="button button-ghost"
        onClick={() => {
          setMethod((m) => (m === 'totp' ? 'recovery_code' : 'totp'));
          setCode('');
        }}
      >
        {method === 'totp' ? 'Use a recovery code instead' : 'Use an authenticator code instead'}
      </button>
    </Page>
  );
}

export function RegisterPage() {
  const { navigate } = useRouter();
  const cfg = useAuthConfig();
  const [values, setValues] = useState({ display_name: '', email: '', password: '' });
  const [accept, setAccept] = useState(false);
  const [human, setHuman] = useState(false);
  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [k]: e.target.value }));
  const form = useSubmit(async () => {
    await api('POST', '/v1/auth/register', {
      body: {
        ...values,
        locale: navigator.language?.toLowerCase().split('-')[0] ?? 'en',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        terms_version: accept ? cfg?.terms_version : undefined,
        privacy_version: accept ? cfg?.privacy_version : undefined,
        bot_proof: cfg?.bot_protection === 'test' ? (human ? 'test-pass' : '') : undefined,
      },
    });
    pendingEmail = values.email;
    navigate('/verify-email');
  });
  const errors = fieldErrorsFrom(form.error, {
    '/display_name': 'display_name',
    '/email': 'email',
    '/password': 'password',
    '/accept_terms': 'accept_terms',
    '/bot_proof': 'bot_proof',
  });
  return (
    <Page title="Create your account">
      <ProblemBanner error={form.error} onRetry={() => void form.submit()} />
      <ErrorSummary
        errors={errors}
        labels={{
          display_name: 'Name',
          email: 'Email',
          password: 'Password',
          accept_terms: 'Terms',
          bot_proof: 'Verification',
        }}
        focusKey={form.attempt}
      />
      <form onSubmit={form.submit} noValidate>
        <Field
          id="display_name"
          label="Name"
          autoComplete="name"
          value={values.display_name}
          onChange={set('display_name')}
          error={errors.display_name}
          required
        />
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          value={values.email}
          onChange={set('email')}
          error={errors.email}
          required
          hint="We'll send a link to confirm it."
        />
        <PasswordField
          id="password"
          label="Password"
          autoComplete="new-password"
          value={values.password}
          onChange={set('password')}
          error={errors.password}
          required
          hint={`Use at least ${cfg?.password_min_length ?? 12} characters. A few unrelated words make a strong, memorable password.`}
        />
        <div className={errors.accept_terms ? 'field field-invalid' : 'field'}>
          {errors.accept_terms ? (
            <p className="field-error" id="accept_terms-error">
              <span aria-hidden="true">! </span>
              {errors.accept_terms}
            </p>
          ) : null}
          <label className="choice">
            <input
              id="accept_terms"
              type="checkbox"
              checked={accept}
              onChange={(e) => setAccept(e.target.checked)}
              aria-invalid={errors.accept_terms ? true : undefined}
              aria-describedby={errors.accept_terms ? 'accept_terms-error' : undefined}
            />
            I accept the terms of service and privacy notice
          </label>
        </div>
        {cfg?.bot_protection === 'test' ? (
          <div className={errors.bot_proof ? 'field field-invalid' : 'field'}>
            <label className="choice">
              <input
                id="bot_proof"
                type="checkbox"
                checked={human}
                onChange={(e) => setHuman(e.target.checked)}
                aria-invalid={errors.bot_proof ? true : undefined}
              />
              I'm a person (test verification step)
            </label>
          </div>
        ) : null}
        <div className="actions">
          <SubmitButton busy={form.submitting}>Create account</SubmitButton>
        </div>
      </form>
      <p>
        Already have an account? <Link to="/sign-in">Sign in</Link>
      </p>
    </Page>
  );
}

export function VerifyEmailPage() {
  const { me } = useAuth();
  const [email, setEmail] = useState(pendingEmail || me?.email || '');
  const form = useSubmit(() => api('POST', '/v1/auth/email:resend', { body: { email } }));
  const errors = fieldErrorsFrom(form.error, { '/email': 'email' });
  return (
    <Page
      title="Check your email"
      lead="We sent a link to confirm your email address. It works once and expires after a while."
    >
      {form.status === 'done' ? (
        <Banner tone="success" title="If that address needs confirming, we've sent a new link." />
      ) : null}
      <ProblemBanner error={form.error} onRetry={() => void form.submit()} />
      <h2>Didn't get it?</h2>
      <p>Check your spam folder. You can ask for a new link; we only send one every minute.</p>
      <form onSubmit={form.submit} noValidate>
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
          required
        />
        <div className="actions">
          <SubmitButton busy={form.submitting}>Send a new link</SubmitButton>
        </div>
      </form>
      <p>
        <Link to="/sign-in">Back to sign in</Link>
      </p>
    </Page>
  );
}

export function VerifyConfirmPage() {
  const { me, refresh } = useAuth();
  const [token] = useState(() => takeFragmentToken());
  const [state, setState] = useState<
    'verifying' | 'verified' | 'token_expired' | 'token_used' | 'token_invalid' | 'error'
  >(token ? 'verifying' : 'token_invalid');
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!token) return;
    api('POST', '/v1/auth/email:verify', { body: { token } }).then(
      () => {
        setState('verified');
        void refresh();
      },
      (err: unknown) => {
        const code = err instanceof ApiError ? err.issues[0]?.code : undefined;
        if (code === 'token_expired' || code === 'token_used' || code === 'token_invalid')
          setState(code);
        else {
          setError(err);
          setState('error');
        }
      },
    );
  }, [refresh, token]);
  const titles = {
    verifying: 'Confirming your email…',
    verified: 'Email confirmed',
    token_expired: 'This link has expired',
    token_used: 'This link was already used',
    token_invalid: "This link isn't valid",
    error: "We couldn't confirm your email",
  };
  return (
    <Page title={titles[state]}>
      {state === 'verifying' ? <p role="status">Please wait.</p> : null}
      {state === 'verified' ? (
        <>
          <Banner tone="success" title="Your email address is confirmed." />
          <p>
            {me ? (
              <Link to="/onboarding">Continue</Link>
            ) : (
              <Link to="/sign-in">Sign in to continue</Link>
            )}
          </p>
        </>
      ) : null}
      {state === 'token_used' ? (
        <p>
          Your email may already be confirmed. <Link to="/sign-in">Sign in</Link>
        </p>
      ) : null}
      {state === 'token_expired' || state === 'token_invalid' ? (
        <p>
          <Link to="/verify-email">Request a new link</Link>
        </p>
      ) : null}
      {state === 'error' ? (
        <ProblemBanner error={error} onRetry={() => window.location.reload()} />
      ) : null}
    </Page>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const form = useSubmit(() => api('POST', '/v1/auth/password:forgot', { body: { email } }));
  const errors = fieldErrorsFrom(form.error, { '/email': 'email' });
  return (
    <Page
      title="Reset your password"
      lead="Enter your email and we'll send a link to choose a new password."
    >
      {form.status === 'done' ? (
        <Banner tone="success" title="Check your email">
          If an account uses that address, a reset link is on its way. It works once and expires
          soon.
        </Banner>
      ) : null}
      <ProblemBanner error={form.error} onRetry={() => void form.submit()} />
      <ErrorSummary errors={errors} labels={{ email: 'Email' }} focusKey={form.attempt} />
      <form onSubmit={form.submit} noValidate>
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
          required
        />
        <div className="actions">
          <SubmitButton busy={form.submitting}>Send reset link</SubmitButton>
        </div>
      </form>
      <p>
        <Link to="/sign-in">Back to sign in</Link>
      </p>
    </Page>
  );
}

export function ResetPasswordPage() {
  const [token] = useState(() => takeFragmentToken());
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const form = useSubmit(async () => {
    if (password !== confirm) {
      setMismatch(true);
      throw new ApiError({
        code: 'validation_failed',
        status: 422,
        message: '',
        issues: [{ pointer: '/confirm', code: 'mismatch', message: "The passwords don't match." }],
      });
    }
    setMismatch(false);
    return api('POST', '/v1/auth/password:reset', { body: { token, password } });
  });
  const errors = fieldErrorsFrom(form.error, { '/password': 'password', '/confirm': 'confirm' });
  const tokenProblem =
    form.error instanceof ApiError
      ? form.error.issues.find((i) => i.pointer === '/token')
      : undefined;
  if (!token && form.status === 'idle') {
    return (
      <Page title="This link isn't valid">
        <p>
          <Link to="/forgot-password">Request a new reset link</Link>
        </p>
      </Page>
    );
  }
  if (form.status === 'done') {
    return (
      <Page title="Password changed">
        <Banner
          tone="success"
          title="Your password was changed and you were signed out everywhere."
        />
        <p>
          <Link to="/sign-in">Sign in with your new password</Link>
        </p>
      </Page>
    );
  }
  return (
    <Page title="Choose a new password">
      {tokenProblem ? (
        <Banner
          tone="danger"
          title={tokenProblem.message}
          action={<Link to="/forgot-password">Request a new link</Link>}
        />
      ) : (
        <ProblemBanner error={form.error} onRetry={() => void form.submit()} />
      )}
      <ErrorSummary
        errors={errors}
        labels={{ password: 'New password', confirm: 'Confirm new password' }}
        focusKey={form.attempt}
      />
      <form onSubmit={form.submit} noValidate>
        <PasswordField
          id="password"
          label="New password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          hint="Use at least 12 characters. Resetting signs you out everywhere."
          required
        />
        <PasswordField
          id="confirm"
          label="Confirm new password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={mismatch ? errors.confirm : undefined}
          required
        />
        <div className="actions">
          <SubmitButton busy={form.submitting}>Change password</SubmitButton>
        </div>
      </form>
    </Page>
  );
}

export function OnboardingPage() {
  const { me, signOut } = useAuth();
  const { navigate } = useRouter();
  useEffect(() => {
    if (me === null) navigate('/sign-in', { replace: true });
  }, [me, navigate]);
  if (!me) return <Page title="Loading">{null}</Page>;
  return (
    <Page title={`Welcome, ${me.display_name}`} lead="Your account is ready.">
      {!me.email_verified ? (
        <Banner
          tone="warning"
          title="Confirm your email address"
          action={<Link to="/verify-email">Resend the link</Link>}
        >
          Some features need a confirmed email.
        </Banner>
      ) : null}
      <section aria-labelledby="next">
        <h2 id="next">Next: set up your workspace</h2>
        <p>Workspace setup arrives in the next release. Nothing else to do here yet.</p>
      </section>
      <p>
        <Link to="/account/security">Account security</Link>
      </p>
      <button
        type="button"
        className="button button-secondary"
        onClick={() => {
          void signOut().then(() => navigate('/sign-in'));
        }}
      >
        Sign out
      </button>
    </Page>
  );
}
