import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { ApiError } from '../api.ts';

export type FieldErrors = Record<string, string>;

/** Maps API issues (JSON pointers) to field names; unknown pointers stay in the summary only. */
export function fieldErrorsFrom(error: unknown, fields: Record<string, string>): FieldErrors {
  if (!(error instanceof ApiError)) return {};
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const field = issue.pointer ? fields[issue.pointer] : undefined;
    if (field && !out[field]) out[field] = issue.message;
  }
  return out;
}

/**
 * Error summary (0E A11Y-FM-03): a labelled region of links to each invalid field. It receives
 * focus after a failed submit and is announced.
 */
export function ErrorSummary({
  errors,
  labels,
  focusKey,
}: {
  errors: FieldErrors;
  labels: Record<string, string>;
  focusKey: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const entries = Object.entries(errors);
  useEffect(() => {
    if (entries.length) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);
  if (!entries.length) return null;
  return (
    <div
      className="error-summary"
      role="alert"
      aria-labelledby="error-summary-title"
      tabIndex={-1}
      ref={ref}
    >
      <h2 id="error-summary-title">
        There {entries.length === 1 ? 'is a problem' : `are ${entries.length} problems`}
      </h2>
      <ul>
        {entries.map(([field, message]) => (
          <li key={field}>
            <a
              href={`#${field}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(field)?.focus();
              }}
            >
              {labels[field] ?? field}: {message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
}

/** Labelled input (0E A11Y-FM-01..04): visible label, hint, required marker, linked error. */
export function Field({ id, label, hint, error, required, ...input }: FieldProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={error ? 'field field-invalid' : 'field'}>
      <label htmlFor={id}>
        {label}
        {required ? <span className="required"> (required)</span> : null}
      </label>
      {hint ? (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={errorId}>
          <span aria-hidden="true">! </span>
          {error}
        </p>
      ) : null}
      <input
        id={id}
        name={id}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        aria-describedby={describedBy}
        required={required}
        {...input}
      />
    </div>
  );
}

/**
 * Password input with a show/hide toggle and a Caps Lock hint. Paste and password managers work
 * (0E A11Y-FM-05): nothing intercepts input events.
 */
export function PasswordField(
  props: FieldProps & { autoComplete: 'current-password' | 'new-password' },
) {
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  const toggleId = useId();
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) =>
    setCaps(e.getModifierState?.('CapsLock') ?? false);
  return (
    <div className="password-field">
      <Field
        {...props}
        type={shown ? 'text' : 'password'}
        onKeyUp={onKey}
        onKeyDown={onKey}
        spellCheck={false}
        autoCapitalize="none"
      />
      <button
        type="button"
        id={toggleId}
        className="button button-ghost password-toggle"
        aria-pressed={shown}
        aria-controls={props.id}
        onClick={() => setShown((s) => !s)}
      >
        {shown ? 'Hide password' : 'Show password'}
      </button>
      {caps ? (
        <p className="hint caps-lock" role="status">
          Caps Lock is on.
        </p>
      ) : null}
    </div>
  );
}

/** Submit-state helper: never clears input on failure (0E ST-02); prevents double submission. */
export function useSubmit<T>(action: () => Promise<T>) {
  const [state, setState] = useState<{
    status: 'idle' | 'submitting' | 'done' | 'failed';
    error: unknown;
    attempt: number;
  }>({ status: 'idle', error: null, attempt: 0 });
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (state.status === 'submitting') return undefined;
    setState((s) => ({ ...s, status: 'submitting', error: null }));
    try {
      const result = await action();
      setState((s) => ({ status: 'done', error: null, attempt: s.attempt + 1 }));
      return result;
    } catch (error) {
      setState((s) => ({ status: 'failed', error, attempt: s.attempt + 1 }));
      return undefined;
    }
  };
  return { ...state, submitting: state.status === 'submitting', submit };
}

export function SubmitButton({
  busy,
  children,
  tone = 'primary',
}: {
  busy: boolean;
  children: ReactNode;
  tone?: 'primary' | 'danger';
}) {
  return (
    <button
      type="submit"
      className={`button button-${tone}`}
      aria-disabled={busy || undefined}
      disabled={busy}
    >
      {busy ? 'Working…' : children}
    </button>
  );
}

function described(id: string, hint: unknown, error: string | undefined): string | undefined {
  return (
    [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') ||
    undefined
  );
}

function FieldFrame({
  id,
  label,
  hint,
  error,
  required,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  required?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <div className={error ? 'field field-invalid' : 'field'}>
      <label htmlFor={id}>
        {label}
        {required ? <span className="required"> (required)</span> : null}
      </label>
      {hint ? (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${id}-error`}>
          <span aria-hidden="true">! </span>
          {error}
        </p>
      ) : null}
      {children}
    </div>
  );
}

/** Labelled native select (keyboard and screen-reader behaviour come from the platform). */
export function SelectField({
  id,
  label,
  hint,
  error,
  required,
  value,
  onChange,
  options,
  disabled,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  required?: boolean;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error} required={required}>
      <select
        id={id}
        name={id}
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={described(id, hint, error)}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldFrame>
  );
}

export function TextAreaField({
  id,
  label,
  hint,
  error,
  value,
  onChange,
  maxLength,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}) {
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error}>
      <textarea
        id={id}
        name={id}
        rows={4}
        value={value}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={described(id, hint, error)}
        onChange={(e) => onChange(e.target.value)}
      />
    </FieldFrame>
  );
}
