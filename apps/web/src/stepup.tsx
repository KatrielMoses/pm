import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, type StepUpChallenge, type StepUpResolver } from './api.ts';
import { Dialog } from './ui/dialog.tsx';
import { ProblemBanner } from './ui/feedback.tsx';
import { Field, PasswordField, SubmitButton, useSubmit } from './ui/form.tsx';

const StepUpContext = createContext<StepUpResolver | null>(null);

const METHOD_LABEL: Record<string, string> = {
  password: 'Password',
  totp: 'Authenticator app code',
  recovery_code: 'Recovery code',
};

/**
 * Step-up re-authentication (0D §11.2, 0E ST-33). The original form stays mounted underneath, so
 * its input is preserved; after verification the caller retries the same request automatically.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const [challenge, setChallenge] = useState<StepUpChallenge | null>(null);
  const pending = useRef<((token: string | null) => void) | null>(null);

  const resolve: StepUpResolver = useCallback(
    (ch) =>
      new Promise<string | null>((done) => {
        pending.current = done;
        setChallenge(ch);
      }),
    [],
  );

  const finish = (token: string | null) => {
    pending.current?.(token);
    pending.current = null;
    setChallenge(null);
  };

  return (
    <StepUpContext.Provider value={resolve}>
      {children}
      {challenge ? <StepUpDialog challenge={challenge} onDone={finish} /> : null}
    </StepUpContext.Provider>
  );
}

export function useStepUp(): StepUpResolver {
  const ctx = useContext(StepUpContext);
  if (!ctx) throw new Error('useStepUp outside StepUpProvider');
  return ctx;
}

function StepUpDialog({
  challenge,
  onDone,
}: {
  challenge: StepUpChallenge;
  onDone: (token: string | null) => void;
}) {
  const methods = challenge.methods.filter((m) => m !== 'webauthn');
  const [method, setMethod] = useState(methods[0] ?? 'password');
  const [proof, setProof] = useState('');
  const form = useSubmit(async () => {
    const r = await api<{ data: { token: string } }>(
      'POST',
      `/v1/auth/step-up/${challenge.id}:verify`,
      { body: { method, proof } },
    );
    onDone(r.body.data.token);
  });
  const cancel = () => {
    void api('POST', `/v1/auth/step-up/${challenge.id}:cancel`).catch(() => undefined);
    onDone(null);
  };
  const fieldError =
    form.error instanceof ApiError && form.error.code === 'validation_failed'
      ? (form.error.issues[0]?.message ?? 'Check this and try again.')
      : undefined;
  const [minutes] = useState(() =>
    Math.max(1, Math.round((new Date(challenge.expires_at).getTime() - Date.now()) / 60_000)),
  );
  return (
    <Dialog
      title="Confirm it's you"
      description={
        <p>
          For your security, confirm your identity to continue. This expires in about {minutes}{' '}
          minute{minutes === 1 ? '' : 's'}.
        </p>
      }
      onClose={cancel}
    >
      <form onSubmit={form.submit} noValidate>
        {methods.length > 1 ? (
          <fieldset className="choices">
            <legend>Confirm with</legend>
            {methods.map((m) => (
              <label key={m} className="choice">
                <input
                  type="radio"
                  name="step-up-method"
                  value={m}
                  checked={method === m}
                  onChange={() => {
                    setMethod(m);
                    setProof('');
                  }}
                />
                {METHOD_LABEL[m]}
              </label>
            ))}
          </fieldset>
        ) : null}
        {method === 'password' ? (
          <PasswordField
            id="step-up-proof"
            label="Password"
            autoComplete="current-password"
            value={proof}
            onChange={(e) => setProof(e.target.value)}
            error={fieldError}
            required
          />
        ) : (
          <Field
            id="step-up-proof"
            label={METHOD_LABEL[method]!}
            autoComplete="one-time-code"
            inputMode={method === 'totp' ? 'numeric' : 'text'}
            value={proof}
            onChange={(e) => setProof(e.target.value)}
            error={fieldError}
            hint={
              method === 'totp'
                ? 'The 6-digit code from your authenticator app.'
                : 'One of the codes you saved, like ABCD-EFGH-JKLM-NPQR.'
            }
            required
          />
        )}
        <ProblemBanner error={form.error} />
        <div className="actions">
          <button type="button" className="button button-secondary" onClick={cancel}>
            Cancel
          </button>
          <SubmitButton busy={form.submitting}>Confirm</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}
