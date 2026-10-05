import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, type ApiIssue } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Link, useLeaveGuard, useRouter } from '../router.tsx';
import { useStepUp } from '../stepup.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Announce, Banner, ProblemBanner } from '../ui/feedback.tsx';
import {
  ErrorSummary,
  Field,
  SelectField,
  SubmitButton,
  TextAreaField,
  type FieldErrors,
} from '../ui/form.tsx';
import { Page } from '../ui/layout.tsx';
import {
  BRAND_ICONS,
  browserDefaults,
  currencies,
  ICON_GLYPH,
  mergeRequest,
  OPERATIONAL_STATUSES,
  pendingInvitation,
  tenancy,
  timeZones,
  WEEKDAYS,
  type Brand,
  type BrandSettings,
  type CalendarSettings,
  type OperationalStatus,
  type Priorities,
  type Workspace,
} from '../tenancy/client.ts';
import {
  hoursDraft,
  PrioritiesEditor,
  validateHours,
  validatePriorities,
  WorkingHoursEditor,
  type HoursDraft,
} from '../tenancy/editors.tsx';
import { LoadProblem, ResourceView, useResource } from '../tenancy/resource.tsx';
import { BrandAccessPanel } from './people-pages.tsx';
import { FavoriteToggle } from './shell-pages.tsx';
import { summaryMarker } from '../shell/brand-marker.tsx';
import { useRecordVisit, useWorkspaceShell } from '../shell/workspace.tsx';

// -------------------------------------------------------------------------------------------
// Shared pieces
// -------------------------------------------------------------------------------------------

/** Redirects signed-out visitors; renders nothing until the session is known. */
export function useSignedIn(): boolean {
  const { me } = useAuth();
  const { navigate } = useRouter();
  useEffect(() => {
    if (me === null) navigate('/sign-in', { replace: true });
  }, [me, navigate]);
  return Boolean(me);
}

/** Labels for every 0B operational status; the type makes a missing value a compile error. */
const STATUS_LABEL: Record<OperationalStatus, string> = {
  operating: 'Operating',
  paused: 'Paused',
  planned: 'Planned',
};

export function BrandMark({ brand }: { brand: Pick<Brand, 'color' | 'icon'> }) {
  return (
    <span className="brand-mark" style={{ backgroundColor: brand.color }} aria-hidden="true">
      {ICON_GLYPH[brand.icon] ?? '●'}
    </span>
  );
}

/** Splits API issues into per-field messages (by pointer) and the rest (shown as a banner). */
export function splitIssues(
  error: unknown,
  pointers: Record<string, string>,
): { fields: FieldErrors; other: ApiIssue[] } {
  const fields: FieldErrors = {};
  const other: ApiIssue[] = [];
  if (!(error instanceof ApiError) || error.code !== 'validation_failed') return { fields, other };
  for (const i of error.issues) {
    // Exact pointer, else the nearest registered parent (e.g. a rich-text field's inner path).
    const key = i.pointer
      ? i.pointer in pointers
        ? i.pointer
        : Object.keys(pointers)
            .filter((k) => i.pointer!.startsWith(`${k}/`))
            .sort((a, b) => b.length - a.length)[0]
      : undefined;
    const f = key ? pointers[key] : undefined;
    if (f) {
      if (!fields[f]) fields[f] = i.message;
    } else other.push(i);
  }
  return { fields, other };
}

export function OtherIssues({ issues }: { issues: ApiIssue[] }) {
  if (!issues.length) return null;
  return (
    <Banner tone="danger" title="Some changes couldn't be saved">
      <ul>
        {issues.map((i, n) => (
          <li key={n}>{i.message}</li>
        ))}
      </ul>
    </Banner>
  );
}

/** Explains failures that are not field validation: conflict, offline, not found, forbidden. */
export function SaveProblem({
  error,
  onKeepMine,
  onUseLatest,
  onRetry,
}: {
  error: unknown;
  onKeepMine?: () => void;
  onUseLatest?: () => void;
  onRetry?: () => void;
}) {
  if (!(error instanceof ApiError)) return error ? <ProblemBanner error={error} /> : null;
  if (error.code === 'cancelled') return null;
  if (error.code === 'validation_failed') return null;
  if (error.code === 'conflict' && error.conflict)
    return (
      <Banner
        tone="warning"
        title="This was changed by someone else while you were editing"
        action={
          <div className="actions actions-compact">
            {onKeepMine ? (
              <button type="button" className="button button-secondary" onClick={onKeepMine}>
                Keep my changes
              </button>
            ) : null}
            {onUseLatest ? (
              <button type="button" className="button button-secondary" onClick={onUseLatest}>
                Use the latest version
              </button>
            ) : null}
          </div>
        }
      >
        {error.conflict.fields?.length ? (
          <ul>
            {error.conflict.fields.map((f) => (
              <li key={f.field}>
                {f.field.replace(/_/g, ' ')} is now{' '}
                {f.theirs_readable && (f.theirs === null || typeof f.theirs !== 'object')
                  ? `“${String(f.theirs ?? 'empty')}”`
                  : 'different'}
                .
              </li>
            ))}
          </ul>
        ) : (
          <p>
            Your changes are still here. Choose whether to keep them or load the latest version.
          </p>
        )}
      </Banner>
    );
  if (error.code === 'conflict')
    return (
      <Banner tone="warning" title="This can't be changed right now">
        {error.issues[0]?.message ?? 'Reload the page and try again.'}
      </Banner>
    );
  if (error.code === 'not_found')
    return (
      <Banner tone="warning" title="This isn't available anymore">
        It may have been removed, or your access changed.
      </Banner>
    );
  if (error.code === 'forbidden')
    return (
      <Banner tone="warning" title="You don't have permission to do this">
        Ask a workspace owner if you need access.
      </Banner>
    );
  return <ProblemBanner error={error} {...(onRetry ? { onRetry } : {})} />;
}

function localeOptions(current: string): Array<{ value: string; label: string }> {
  const base = [
    'en',
    'en-GB',
    'en-US',
    'en-IN',
    'de-DE',
    'es-ES',
    'fr-FR',
    'it-IT',
    'ja-JP',
    'nl-NL',
    'pt-BR',
    'pt-PT',
  ];
  const all = [...new Set([current, ...base])].filter(Boolean);
  let names: Intl.DisplayNames | undefined;
  try {
    names = new Intl.DisplayNames(['en'], { type: 'language' });
  } catch {
    names = undefined;
  }
  return all.map((v) => ({ value: v, label: `${names?.of(v) ?? v} (${v})` }));
}

const tzOptions = (current: string) =>
  [...new Set([current, ...timeZones()])].map((z) => ({ value: z, label: z.replace(/_/g, ' ') }));
const currencyOptions = (current: string) =>
  [...new Set([current, ...currencies()])].sort().map((c) => ({ value: c, label: c }));
const weekOptions = WEEKDAYS.map((d, i) => ({ value: String(i + 1), label: d }));

// -------------------------------------------------------------------------------------------
// Onboarding: create workspace (accounts with no membership)
// -------------------------------------------------------------------------------------------

const WS_POINTERS: Record<string, string> = {
  '/name': 'ws-name',
  '/timezone': 'ws-timezone',
  '/locale': 'ws-locale',
  '/currency': 'ws-currency',
  '/week_start': 'ws-week-start',
};
const WS_LABELS: Record<string, string> = {
  'ws-name': 'Workspace name',
  'ws-timezone': 'Time zone',
  'ws-locale': 'Language and region',
  'ws-currency': 'Currency',
  'ws-week-start': 'Week starts on',
};

export function OnboardingPage() {
  const { me, signOut } = useAuth();
  const ready = useSignedIn();
  const { navigate } = useRouter();
  const list = useResource(() => tenancy.listWorkspaces(), ready ? 'ws' : 'wait');
  useEffect(() => {
    // An invitation opened before signing in resumes here (token kept in session storage only).
    if (ready && pendingInvitation.get()) {
      navigate('/invitations/accept', { replace: true });
      return;
    }
    if (list.state.status === 'ready' && list.state.data.length) {
      const target = list.state.data.find((w) => w.selected) ?? list.state.data[0]!;
      navigate(`/workspaces/${target.id}`, { replace: true });
    }
  }, [list.state, navigate, ready]);
  if (!me || !ready) return <Page title="Loading">{null}</Page>;
  const hasNone = list.state.status === 'ready' && !list.state.data.length;
  return (
    <Page title={`Welcome, ${me.display_name}`} lead="Create a workspace to get started.">
      {list.state.status === 'failed' ? (
        <LoadProblem error={list.state.error} onRetry={list.retry} what="workspace list" />
      ) : null}
      {list.state.status === 'loading' ? (
        <p className="loading" role="status">
          Loading your workspaces…
        </p>
      ) : null}
      {hasNone ? (
        me.email_verified ? (
          <CreateWorkspaceForm onCreated={(id) => navigate(`/workspaces/${id}/first-brand`)} />
        ) : (
          <Banner
            tone="warning"
            title="Confirm your email address"
            action={<Link to="/verify-email">Resend the link</Link>}
          >
            You need a confirmed email address to create a workspace.
          </Banner>
        )
      ) : null}
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

function CreateWorkspaceForm({ onCreated }: { onCreated: (publicId: string) => void }) {
  const stepUp = useStepUp();
  const [defaults] = useState(() => browserDefaults());
  const [name, setName] = useState('');
  const [tz, setTz] = useState(defaults.timezone);
  const [loc, setLoc] = useState(defaults.locale);
  const [cur, setCur] = useState(defaults.currency);
  const [week, setWeek] = useState(String(defaults.week_start));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setAttempt((a) => a + 1);
    if (!name.trim()) {
      setError(
        new ApiError({
          code: 'validation_failed',
          status: 422,
          message: '',
          issues: [{ pointer: '/name', code: 'required', message: 'Enter a workspace name.' }],
        }),
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const ws = await tenancy.createWorkspace(
        { name, timezone: tz, locale: loc, currency: cur, week_start: Number(week) },
        stepUp,
      );
      onCreated(ws.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const { fields, other } = splitIssues(error, WS_POINTERS);
  return (
    <section aria-labelledby="create-ws">
      <h2 id="create-ws">Create your workspace</h2>
      <p className="hint">
        A workspace holds your brands. You'll be its owner. These defaults come from your browser;
        change them if they're wrong. You can edit them later in workspace settings.
      </p>
      <form onSubmit={submit} noValidate>
        <ErrorSummary errors={fields} labels={WS_LABELS} focusKey={attempt} />
        <Field
          id="ws-name"
          label="Workspace name"
          required
          value={name}
          maxLength={80}
          autoComplete="organization"
          onChange={(e) => setName(e.target.value)}
          error={fields['ws-name']}
          hint="For example, your company name."
        />
        <SelectField
          id="ws-timezone"
          label="Time zone"
          value={tz}
          onChange={setTz}
          options={tzOptions(tz)}
          error={fields['ws-timezone']}
        />
        <SelectField
          id="ws-locale"
          label="Language and region"
          value={loc}
          onChange={setLoc}
          options={localeOptions(loc)}
          error={fields['ws-locale']}
          hint="Used for dates and numbers."
        />
        <SelectField
          id="ws-currency"
          label="Currency"
          value={cur}
          onChange={setCur}
          options={currencyOptions(cur)}
          error={fields['ws-currency']}
        />
        <SelectField
          id="ws-week-start"
          label="Week starts on"
          value={week}
          onChange={setWeek}
          options={weekOptions}
          error={fields['ws-week-start']}
        />
        <OtherIssues issues={other} />
        <SaveProblem error={error} onRetry={() => setError(null)} />
        <div className="actions">
          <SubmitButton busy={busy}>Create workspace</SubmitButton>
        </div>
      </form>
    </section>
  );
}

// -------------------------------------------------------------------------------------------
// Workspace list (select workspace)
// -------------------------------------------------------------------------------------------

export function WorkspacesPage() {
  const ready = useSignedIn();
  const list = useResource(() => tenancy.listWorkspaces(), ready ? 'ws' : 'wait');
  return (
    <Page title="Your workspaces">
      <ResourceView resource={list.state} onRetry={list.retry} what="workspace list">
        {(rows) =>
          rows.length ? (
            <ul className="workspace-list">
              {rows.map((w) => (
                <li key={w.id}>
                  <Link to={`/workspaces/${w.id}`} aria-current={w.selected ? 'true' : undefined}>
                    {w.name}
                  </Link>
                  {w.selected ? <span className="badge badge-info">Last used</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">
              You don't belong to a workspace yet. <Link to="/onboarding">Create one</Link>.
            </p>
          )
        }
      </ResourceView>
      <p>
        <Link to="/account/security">Account security</Link>
      </p>
    </Page>
  );
}

// -------------------------------------------------------------------------------------------
// Brand creation (first brand and additional brands)
// -------------------------------------------------------------------------------------------

const BRAND_POINTERS: Record<string, string> = {
  '/name': 'brand-name',
  '/short_name': 'brand-short-name',
  '/color': 'brand-color',
  '/icon': 'brand-icon',
  '/description': 'brand-description',
  '/operational_status': 'brand-status',
  '/timezone': 'brand-timezone',
  '/notification_content_mode': 'brand-notify',
};
const BRAND_LABELS: Record<string, string> = {
  'brand-name': 'Brand name',
  'brand-short-name': 'Short name',
  'brand-color': 'Color',
  'brand-icon': 'Icon',
  'brand-description': 'Description',
  'brand-status': 'Status',
  'brand-timezone': 'Time zone',
  'brand-notify': 'Notification content',
};

export interface BrandIdentity {
  name: string;
  short_name: string | null;
  color: string;
  icon: string;
  description: string | null;
  operational_status: string;
  timezone: string;
  notification_content_mode: string;
}

function BrandIdentityFields({
  value,
  onChange,
  errors,
  disabled = false,
}: {
  value: BrandIdentity;
  onChange: (next: BrandIdentity) => void;
  errors: FieldErrors;
  disabled?: boolean;
}) {
  const set = <K extends keyof BrandIdentity>(k: K, v: BrandIdentity[K]) =>
    onChange({ ...value, [k]: v });
  return (
    <fieldset className="plain" disabled={disabled}>
      <legend className="visually-hidden">Brand identity</legend>
      <Field
        id="brand-name"
        label="Brand name"
        required
        maxLength={80}
        value={value.name}
        onChange={(e) => set('name', e.target.value)}
        error={errors['brand-name']}
        hint="Must be different from your other brands in this workspace."
      />
      <Field
        id="brand-short-name"
        label="Short name"
        maxLength={12}
        value={value.short_name ?? ''}
        onChange={(e) => set('short_name', e.target.value || null)}
        error={errors['brand-short-name']}
        hint="Optional, up to 12 characters. Used where space is tight."
      />
      <Field
        id="brand-color"
        label="Color"
        value={value.color}
        onChange={(e) => set('color', e.target.value)}
        error={errors['brand-color']}
        hint="A hex color like #336699. Always shown with the brand's name and icon, never on its own."
      />
      <fieldset
        className={
          errors['brand-icon'] ? 'choices icon-choices field-invalid' : 'choices icon-choices'
        }
        id="brand-icon"
        tabIndex={-1}
      >
        <legend>Icon</legend>
        {errors['brand-icon'] ? <p className="field-error">{errors['brand-icon']}</p> : null}
        {BRAND_ICONS.map((icon) => (
          <label key={icon} className="choice icon-choice">
            <input
              type="radio"
              name="brand-icon"
              value={icon}
              checked={value.icon === icon}
              onChange={() => set('icon', icon)}
            />
            <span aria-hidden="true" className="icon-glyph">
              {ICON_GLYPH[icon]}
            </span>
            {icon.charAt(0).toUpperCase() + icon.slice(1)}
          </label>
        ))}
      </fieldset>
      <TextAreaField
        id="brand-description"
        label="Description"
        maxLength={2000}
        value={value.description ?? ''}
        onChange={(v) => set('description', v || null)}
        error={errors['brand-description']}
        hint="Optional, plain text, up to 2,000 characters."
      />
      <SelectField
        id="brand-status"
        label="Status"
        value={value.operational_status}
        onChange={(v) => set('operational_status', v)}
        options={OPERATIONAL_STATUSES.map((v) => ({ value: v, label: STATUS_LABEL[v] }))}
        error={errors['brand-status']}
        hint="Business status only. Archiving is separate and hides the brand."
      />
      <SelectField
        id="brand-timezone"
        label="Time zone"
        value={value.timezone}
        onChange={(v) => set('timezone', v)}
        options={tzOptions(value.timezone)}
        error={errors['brand-timezone']}
        hint="Working hours for this brand use this time zone."
      />
      <SelectField
        id="brand-notify"
        label="Notification content"
        value={value.notification_content_mode}
        onChange={(v) => set('notification_content_mode', v)}
        options={[
          { value: 'standard', label: 'Standard: include titles in notifications' },
          { value: 'minimal', label: 'Minimal: leave out titles and content' },
        ]}
        error={errors['brand-notify']}
      />
    </fieldset>
  );
}

function CreateBrandForm({
  workspaceId,
  defaultTimezone,
  onCreated,
  cancel,
}: {
  workspaceId: string;
  defaultTimezone: string;
  onCreated: (b: Brand) => void;
  cancel: ReactNode;
}) {
  const stepUp = useStepUp();
  const [value, setValue] = useState<BrandIdentity>({
    name: '',
    short_name: null,
    color: '#336699',
    icon: 'circle',
    description: null,
    operational_status: 'operating',
    timezone: defaultTimezone,
    notification_content_mode: 'standard',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setAttempt((a) => a + 1);
    if (!value.name.trim()) {
      setError(
        new ApiError({
          code: 'validation_failed',
          status: 422,
          message: '',
          issues: [{ pointer: '/name', code: 'required', message: 'Enter a brand name.' }],
        }),
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onCreated(await tenancy.createBrand(workspaceId, value, stepUp));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const { fields, other } = splitIssues(error, BRAND_POINTERS);
  return (
    <form onSubmit={submit} noValidate>
      <ErrorSummary errors={fields} labels={BRAND_LABELS} focusKey={attempt} />
      <BrandPreview value={value} />
      <BrandIdentityFields value={value} onChange={setValue} errors={fields} />
      <OtherIssues issues={other} />
      <SaveProblem error={error} />
      <div className="actions">
        <SubmitButton busy={busy}>Create brand</SubmitButton>
        {cancel}
      </div>
    </form>
  );
}

function BrandPreview({
  value,
}: {
  value: Pick<BrandIdentity, 'name' | 'short_name' | 'color' | 'icon'>;
}) {
  return (
    <div className="brand-preview" aria-label="Preview" role="group">
      <BrandMark brand={value} />
      <span>
        <strong>{value.name.trim() || 'Brand name'}</strong>
        {value.short_name ? <span className="hint"> · {value.short_name}</span> : null}
      </span>
    </div>
  );
}

function useWorkspace(workspaceId: string, ready: boolean) {
  return useResource(() => tenancy.getWorkspace(workspaceId), ready ? `w:${workspaceId}` : 'wait');
}

export function FirstBrandPage({ ws }: { ws: string }) {
  const ready = useSignedIn();
  const { navigate } = useRouter();
  const workspace = useWorkspace(ws, ready);
  return (
    <Page
      title="Add your first brand"
      lead="A brand is a business or product line inside your workspace. You can add more later."
      wide
    >
      <ResourceView resource={workspace.state} onRetry={workspace.retry} what="workspace">
        {(w) => (
          <CreateBrandForm
            workspaceId={w.id}
            defaultTimezone={w.timezone}
            onCreated={(b) => {
              void tenancy
                .select(w.id, { scope: 'brand', brand_id: b.id })
                .finally(() => navigate(`/workspaces/${w.id}?created=${encodeURIComponent(b.id)}`));
            }}
            cancel={<Link to={`/workspaces/${w.id}`}>Skip for now</Link>}
          />
        )}
      </ResourceView>
    </Page>
  );
}

export function NewBrandPage({ ws }: { ws: string }) {
  const ready = useSignedIn();
  const { navigate } = useRouter();
  const workspace = useWorkspace(ws, ready);
  return (
    <Page title="Add a brand" wide>
      <ResourceView resource={workspace.state} onRetry={workspace.retry} what="workspace">
        {(w) =>
          w.capabilities.create_brand ? (
            <CreateBrandForm
              workspaceId={w.id}
              defaultTimezone={w.timezone}
              onCreated={(b) => navigate(`/workspaces/${w.id}?created=${encodeURIComponent(b.id)}`)}
              cancel={<Link to={`/workspaces/${w.id}`}>Cancel</Link>}
            />
          ) : (
            <Banner tone="warning" title="You don't have permission to add brands">
              Ask a workspace owner to add it for you.
            </Banner>
          )
        }
      </ResourceView>
    </Page>
  );
}

// -------------------------------------------------------------------------------------------
// Workspace settings
// -------------------------------------------------------------------------------------------

type WorkspaceForm = Pick<Workspace, 'name' | 'timezone' | 'locale' | 'currency' | 'week_start'>;
const WS_PATCH_POINTERS: Record<string, string> = Object.fromEntries(
  Object.entries({
    name: 'ws-name',
    timezone: 'ws-timezone',
    locale: 'ws-locale',
    currency: 'ws-currency',
    week_start: 'ws-week-start',
  }).map(([f, id]) => [`/changes/${f}/value`, id]),
);

export function WorkspaceSettingsPage({ ws }: { ws: string }) {
  const ready = useSignedIn();
  const workspace = useWorkspace(ws, ready);
  return (
    <Page title="Workspace settings" wide>
      <ResourceView resource={workspace.state} onRetry={workspace.retry} what="workspace">
        {(w) => <WorkspaceSettingsForm workspace={w} onSaved={workspace.set} />}
      </ResourceView>
      <p>
        <Link to={`/workspaces/${ws}/settings/access`}>Sharing, guests, and ownership</Link>
      </p>
    </Page>
  );
}

const pickWs = (w: Workspace): WorkspaceForm => ({
  name: w.name,
  timezone: w.timezone,
  locale: w.locale,
  currency: w.currency,
  week_start: w.week_start,
});

function WorkspaceSettingsForm({
  workspace,
  onSaved,
}: {
  workspace: Workspace;
  onSaved: (w: Workspace) => void;
}) {
  const stepUp = useStepUp();
  const [base, setBase] = useState(workspace);
  const [draft, setDraft] = useState<WorkspaceForm>(() => pickWs(workspace));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const set = <K extends keyof WorkspaceForm>(k: K, v: WorkspaceForm[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const canEdit = base.capabilities.configure;
  // RS-25: settings edits are not draftable; leaving with unsaved changes asks first.
  useLeaveGuard(
    canEdit && Object.keys(mergeRequest(base.version, pickWs(base), draft).changes).length > 0,
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setAttempt((a) => a + 1);
    const req = mergeRequest(base.version, pickWs(base), draft);
    if (!Object.keys(req.changes).length) {
      setSaved((s) => s + 1);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await tenancy.updateWorkspace(base.id, req, stepUp);
      setBase(next);
      setDraft(pickWs(next));
      onSaved(next);
      setSaved((s) => s + 1);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  // Re-reading the latest version keeps the form busy, so a save cannot go out against the
  // version that just conflicted.
  const refresh = async (keepMine: boolean) => {
    setError(null);
    setBusy(true);
    try {
      const latest = await tenancy.getWorkspace(base.id);
      setBase(latest);
      if (!keepMine) setDraft(pickWs(latest));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const { fields, other } = splitIssues(error, WS_PATCH_POINTERS);
  return (
    <form onSubmit={submit} noValidate>
      {!canEdit ? (
        <Banner
          tone="info"
          title="Only workspace owners and administrators can change these settings"
        />
      ) : null}
      <ErrorSummary errors={fields} labels={WS_LABELS} focusKey={attempt} />
      <fieldset className="plain" disabled={!canEdit}>
        <legend className="visually-hidden">Workspace defaults</legend>
        <Field
          id="ws-name"
          label="Workspace name"
          required
          maxLength={80}
          value={draft.name}
          onChange={(e) => set('name', e.target.value)}
          error={fields['ws-name']}
        />
        <SelectField
          id="ws-timezone"
          label="Time zone"
          value={draft.timezone}
          onChange={(v) => set('timezone', v)}
          options={tzOptions(draft.timezone)}
          error={fields['ws-timezone']}
          hint="The default for new brands."
        />
        <SelectField
          id="ws-locale"
          label="Language and region"
          value={draft.locale}
          onChange={(v) => set('locale', v)}
          options={localeOptions(draft.locale)}
          error={fields['ws-locale']}
        />
        <SelectField
          id="ws-currency"
          label="Currency"
          value={draft.currency}
          onChange={(v) => set('currency', v)}
          options={currencyOptions(draft.currency)}
          error={fields['ws-currency']}
        />
        <SelectField
          id="ws-week-start"
          label="Week starts on"
          value={String(draft.week_start)}
          onChange={(v) => set('week_start', Number(v))}
          options={weekOptions}
          error={fields['ws-week-start']}
        />
      </fieldset>
      <section aria-labelledby="logo-h">
        <h2 id="logo-h">Logo</h2>
        <p className="hint">Logo upload arrives with file storage in a later release.</p>
      </section>
      <OtherIssues issues={other} />
      <SaveProblem
        error={error}
        onKeepMine={() => void refresh(true)}
        onUseLatest={() => void refresh(false)}
      />
      {saved && !error ? <Announce key={saved}>Workspace settings saved.</Announce> : null}
      {canEdit ? (
        <div className="actions">
          <SubmitButton busy={busy}>Save workspace settings</SubmitButton>
        </div>
      ) : null}
    </form>
  );
}

// -------------------------------------------------------------------------------------------
// Brand settings: identity, working hours, priorities, sensitivity, archive/restore
// -------------------------------------------------------------------------------------------

const identityOf = (b: Brand): BrandIdentity => ({
  name: b.name,
  short_name: b.short_name,
  color: b.color,
  icon: b.icon,
  description: b.description,
  operational_status: b.operational_status,
  timezone: b.timezone,
  notification_content_mode: b.notification_content_mode,
});
const BRAND_PATCH_POINTERS: Record<string, string> = Object.fromEntries(
  Object.entries(BRAND_POINTERS).map(([p, id]) => [`/changes${p}/value`, id]),
);

export function BrandSettingsPage({ ws, brand }: { ws: string; brand: string }) {
  const ready = useSignedIn();
  const shellState = useWorkspaceShell();
  const data = useResource(
    async () => {
      const [b, s] = await Promise.all([
        tenancy.getBrand(ws, brand),
        tenancy.getSettings(ws, brand),
      ]);
      return { brand: b, settings: s };
    },
    ready ? `brand:${ws}:${brand}` : 'wait',
  );
  const loaded = data.state.status === 'ready' ? data.state.data.brand : null;
  // A successful authorized render counts as a visit (NAV-007); opening a brand outside the
  // current scope moves the shell scope to it (IA-25).
  useRecordVisit(loaded?.id ?? null);
  const enter = shellState?.enterRecordBrand;
  useEffect(() => {
    if (loaded && loaded.lifecycle_state === 'active') enter?.(loaded.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded?.id, shellState?.context !== null]);
  const title = loaded ? `${loaded.name} settings` : 'Brand settings';
  return (
    <Page
      title={title}
      wide
      record={loaded ? { title: loaded.name, isBrand: true } : null}
      breadcrumbs={
        loaded
          ? [
              {
                label: loaded.name,
                marker: summaryMarker(loaded, loaded.lifecycle_state === 'archived'),
              },
              { label: 'Settings' },
            ]
          : undefined
      }
      actions={loaded ? <FavoriteToggle target={loaded.id} label={loaded.name} /> : undefined}
    >
      <ResourceView resource={data.state} onRetry={data.retry} what="brand">
        {(d) => (
          <BrandSettingsBody
            ws={ws}
            brand={d.brand}
            settings={d.settings}
            onBrand={(b) => data.set({ ...d, brand: b })}
            onSettings={(s) => data.set({ ...d, settings: s })}
            reload={data.reload}
          />
        )}
      </ResourceView>
    </Page>
  );
}

function BrandSettingsBody({
  ws,
  brand,
  settings,
  onBrand,
  onSettings,
  reload,
}: {
  ws: string;
  brand: Brand;
  settings: BrandSettings;
  onBrand: (b: Brand) => void;
  onSettings: (s: BrandSettings) => void;
  reload: () => void;
}) {
  const archived = brand.lifecycle_state === 'archived';
  const editable = !archived && brand.capabilities.configure;
  return (
    <>
      <div className="brand-preview">
        <BrandMark brand={brand} />
        <span className="badges">
          {archived ? (
            <span className="badge badge-warning">Archived</span>
          ) : (
            <span className="badge badge-info">{STATUS_LABEL[brand.operational_status]}</span>
          )}
          {brand.is_sensitive ? <span className="badge badge-danger">Sensitive</span> : null}
        </span>
      </div>
      {archived ? (
        <ArchivedNotice ws={ws} brand={brand} onRestored={onBrand} />
      ) : !brand.capabilities.configure ? (
        <Banner tone="info" title="You can view this brand but not change it" />
      ) : null}
      <IdentitySection ws={ws} brand={brand} editable={editable} onSaved={onBrand} />
      <HoursSection
        ws={ws}
        brand={brand}
        settings={settings}
        editable={editable}
        onSaved={onSettings}
      />
      <CalendarSection
        ws={ws}
        brand={brand}
        settings={settings}
        editable={editable}
        onSaved={onSettings}
      />
      <PrioritiesSection
        ws={ws}
        brand={brand}
        settings={settings}
        editable={editable}
        onSaved={onSettings}
      />
      {!archived && brand.capabilities.mark_sensitive ? (
        <SensitivitySection ws={ws} brand={brand} onSaved={onBrand} />
      ) : null}
      {!archived && brand.capabilities.grant_access ? (
        <BrandAccessPanel ws={ws} brand={brand.id} />
      ) : null}
      {!archived && brand.capabilities.archive ? (
        <ArchiveSection ws={ws} brand={brand} onArchived={onBrand} reload={reload} />
      ) : null}
    </>
  );
}

function IdentitySection({
  ws,
  brand,
  editable,
  onSaved,
}: {
  ws: string;
  brand: Brand;
  editable: boolean;
  onSaved: (b: Brand) => void;
}) {
  const stepUp = useStepUp();
  // The page's brand is the merge base: lifecycle and sensitivity changes elsewhere on the page
  // advance it, and the user's draft is kept.
  const base = brand;
  const [draft, setDraft] = useState(() => identityOf(brand));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setAttempt((a) => a + 1);
    const req = mergeRequest(
      base.version,
      identityOf(base) as unknown as Record<string, unknown>,
      draft as unknown as Record<string, unknown>,
    );
    if (!Object.keys(req.changes).length) {
      setSaved((n) => n + 1);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await tenancy.updateBrand(ws, base.id, req, stepUp);
      setDraft(identityOf(next));
      onSaved(next);
      setSaved((n) => n + 1);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const refresh = async (keepMine: boolean) => {
    setError(null);
    setBusy(true);
    try {
      const latest = await tenancy.getBrand(ws, base.id);
      onSaved(latest);
      if (!keepMine) setDraft(identityOf(latest));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const { fields, other } = splitIssues(error, BRAND_PATCH_POINTERS);
  return (
    <section aria-labelledby="identity-h" className="card">
      <h2 id="identity-h">Identity</h2>
      <form onSubmit={submit} noValidate>
        <ErrorSummary errors={fields} labels={BRAND_LABELS} focusKey={attempt} />
        <BrandPreview value={draft} />
        <BrandIdentityFields
          value={draft}
          onChange={setDraft}
          errors={fields}
          disabled={!editable}
        />
        <OtherIssues issues={other} />
        <SaveProblem
          error={error}
          onKeepMine={() => void refresh(true)}
          onUseLatest={() => void refresh(false)}
        />
        {saved && !error ? <Announce key={saved}>Brand identity saved.</Announce> : null}
        {editable ? (
          <div className="actions">
            <SubmitButton busy={busy}>Save identity</SubmitButton>
          </div>
        ) : null}
      </form>
    </section>
  );
}

/**
 * Brand settings share one row version (0D §4.1 whole-record). The page's settings object is the
 * single source of that version, so saving one section advances the other; a stale save offers
 * keep-mine (adopt the latest version, keep the draft) or use-latest.
 */
function useSettingsSave(
  ws: string,
  brand: Brand,
  settings: BrandSettings,
  onSaved: (s: BrandSettings) => void,
) {
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(0);
  const save = async (ns: 'working-hours' | 'calendar' | 'priorities', body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const next = await tenancy.putSettings(ws, brand.id, ns, body, settings.version, stepUp);
      onSaved(next);
      setSaved((n) => n + 1);
      return next;
    } catch (err) {
      setError(err);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const latest = async () => {
    setError(null);
    setBusy(true);
    try {
      const next = await tenancy.getSettings(ws, brand.id);
      onSaved(next);
      return next;
    } catch (err) {
      setError(err);
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, saved, save, latest, setError };
}

function HoursSection({
  ws,
  brand,
  settings,
  editable,
  onSaved,
}: {
  ws: string;
  brand: Brand;
  settings: BrandSettings;
  editable: boolean;
  onSaved: (s: BrandSettings) => void;
}) {
  const [draft, setDraft] = useState<HoursDraft>(() => hoursDraft(settings.working_hours));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState(0);
  const s = useSettingsSave(ws, brand, settings, onSaved);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (s.busy) return;
    setAttempt((a) => a + 1);
    const { value, errors: errs } = validateHours(draft);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const next = await s.save('working-hours', value);
    if (next) setDraft(hoursDraft(next.working_hours));
  };
  const labels = Object.fromEntries(
    Object.keys(errors).map((id) => {
      const [, wd, i, part] = id.split('-');
      return [
        id,
        `${WEEKDAYS[Number(wd) - 1]}, range ${Number(i) + 1}, ${part === 'start' ? 'from' : 'to'}`,
      ];
    }),
  );
  return (
    <section aria-labelledby="hours-h" className="card">
      <h2 id="hours-h">Working hours</h2>
      <form onSubmit={submit} noValidate>
        <ErrorSummary errors={errors} labels={labels} focusKey={attempt} />
        <fieldset className="plain" disabled={!editable}>
          <legend className="visually-hidden">Working hours by day</legend>
          <WorkingHoursEditor
            draft={draft}
            onChange={setDraft}
            timezone={brand.timezone}
            errors={errors}
          />
        </fieldset>
        <OtherIssues issues={splitIssues(s.error, {}).other} />
        <SaveProblem
          error={s.error}
          onKeepMine={() => void s.latest()}
          onUseLatest={() =>
            void s.latest().then((n) => n && setDraft(hoursDraft(n.working_hours)))
          }
        />
        {s.saved && !s.error ? <Announce key={s.saved}>Working hours saved.</Announce> : null}
        {editable ? (
          <div className="actions">
            <SubmitButton busy={s.busy}>Save working hours</SubmitButton>
          </div>
        ) : null}
      </form>
    </section>
  );
}

function CalendarSection({
  ws,
  brand,
  settings,
  editable,
  onSaved,
}: {
  ws: string;
  brand: Brand;
  settings: BrandSettings;
  editable: boolean;
  onSaved: (s: BrandSettings) => void;
}) {
  const [draft, setDraft] = useState<CalendarSettings>(settings.calendar);
  const [labelError, setLabelError] = useState<string | undefined>();
  const s = useSettingsSave(ws, brand, settings, onSaved);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (s.busy) return;
    const label = draft.label?.trim() ? draft.label.trim() : null;
    if (label && [...label].length > 80) {
      setLabelError('Use at most 80 characters.');
      return;
    }
    setLabelError(undefined);
    const next = await s.save('calendar', { ...draft, label });
    if (next) setDraft(next.calendar);
  };
  return (
    <section aria-labelledby="calendar-h" className="card">
      <h2 id="calendar-h">Calendar</h2>
      <p className="hint">
        How this brand's calendar views start. Connected calendars, holidays, and time off arrive in
        later releases.
      </p>
      <form onSubmit={submit} noValidate>
        <fieldset className="plain" disabled={!editable}>
          <legend className="visually-hidden">Calendar defaults</legend>
          <SelectField
            id="cal-week-start"
            label="Week starts on"
            value={draft.week_start === null ? '' : String(draft.week_start)}
            onChange={(v) => setDraft({ ...draft, week_start: v ? Number(v) : null })}
            options={[{ value: '', label: 'Same as the workspace' }, ...weekOptions]}
          />
          <SelectField
            id="cal-view"
            label="Default view"
            value={draft.default_view}
            onChange={(v) =>
              setDraft({ ...draft, default_view: v as CalendarSettings['default_view'] })
            }
            options={[
              { value: 'week', label: 'Week' },
              { value: 'month', label: 'Month' },
              { value: 'agenda', label: 'Agenda' },
            ]}
          />
          <label className="choice">
            <input
              type="checkbox"
              checked={draft.show_weekends}
              onChange={(e) => setDraft({ ...draft, show_weekends: e.target.checked })}
            />
            Show weekends
          </label>
          <Field
            id="cal-label"
            label="Calendar name"
            maxLength={80}
            value={draft.label ?? ''}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            error={labelError}
            hint="Optional, for example “Shop hours”."
          />
        </fieldset>
        <OtherIssues issues={splitIssues(s.error, {}).other} />
        <SaveProblem
          error={s.error}
          onKeepMine={() => void s.latest()}
          onUseLatest={() => void s.latest().then((n) => n && setDraft(n.calendar))}
        />
        {s.saved && !s.error ? <Announce key={s.saved}>Calendar settings saved.</Announce> : null}
        {editable ? (
          <div className="actions">
            <SubmitButton busy={s.busy}>Save calendar settings</SubmitButton>
          </div>
        ) : null}
      </form>
    </section>
  );
}

function PrioritiesSection({
  ws,
  brand,
  settings,
  editable,
  onSaved,
}: {
  ws: string;
  brand: Brand;
  settings: BrandSettings;
  editable: boolean;
  onSaved: (s: BrandSettings) => void;
}) {
  const [draft, setDraft] = useState<Priorities>(settings.priorities);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState(0);
  const s = useSettingsSave(ws, brand, settings, onSaved);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (s.busy) return;
    setAttempt((a) => a + 1);
    const errs = validatePriorities(draft);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const next = await s.save('priorities', {
      schema_version: 1,
      entries: draft.entries.map((x) => ({ kind: x.kind, text: x.text.trim() })),
    });
    if (next) setDraft(next.priorities);
  };
  const labels = Object.fromEntries(
    Object.keys(errors).map((id) => [id, `Entry ${Number(id.split('-')[1]) + 1}`]),
  );
  return (
    <section aria-labelledby="priorities-h" className="card">
      <h2 id="priorities-h">Goals and priorities</h2>
      <form onSubmit={submit} noValidate>
        <ErrorSummary errors={errors} labels={labels} focusKey={attempt} />
        <fieldset className="plain" disabled={!editable}>
          <legend className="visually-hidden">Goals and priorities list</legend>
          <PrioritiesEditor value={draft} onChange={setDraft} errors={errors} />
        </fieldset>
        <OtherIssues issues={splitIssues(s.error, {}).other} />
        <SaveProblem
          error={s.error}
          onKeepMine={() => void s.latest()}
          onUseLatest={() => void s.latest().then((n) => n && setDraft(n.priorities))}
        />
        {s.saved && !s.error ? (
          <Announce key={s.saved}>Goals and priorities saved.</Announce>
        ) : null}
        {editable ? (
          <div className="actions">
            <SubmitButton busy={s.busy}>Save goals and priorities</SubmitButton>
          </div>
        ) : null}
      </form>
    </section>
  );
}

function SensitivitySection({
  ws,
  brand,
  onSaved,
}: {
  ws: string;
  brand: Brand;
  onSaved: (b: Brand) => void;
}) {
  const stepUp = useStepUp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [said, setSaid] = useState('');
  const opener = useRef<HTMLButtonElement>(null);
  const target = !brand.is_sensitive;
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await tenancy.setSensitivity(ws, brand.id, target, brand.version, stepUp);
      setOpen(false);
      onSaved(next);
      setSaid(target ? `${brand.name} is now sensitive.` : `${brand.name} is no longer sensitive.`);
    } catch (err) {
      setError(err);
      if (err instanceof ApiError && err.code === 'cancelled') setError(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="sensitive-h" className="card">
      <h2 id="sensitive-h">Sensitive brand</h2>
      <p>
        {brand.is_sensitive
          ? 'This brand is sensitive. Only people with an explicit grant can see it; workspace owners and administrators have no automatic access.'
          : 'Not sensitive. Workspace owners and administrators can see and manage this brand automatically.'}
      </p>
      {said ? <Announce>{said}</Announce> : null}
      {!open ? <SaveProblem error={error} /> : null}
      <button
        ref={opener}
        type="button"
        className="button button-secondary"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {brand.is_sensitive ? 'Remove sensitive marking…' : 'Mark as sensitive…'}
      </button>
      {open ? (
        <Dialog
          title={
            target
              ? `Mark ${brand.name} as sensitive?`
              : `Remove the sensitive marking from ${brand.name}?`
          }
          description={
            target ? (
              <ul>
                <li>
                  Workspace owners and administrators lose automatic access. Only people with an
                  explicit grant can find or open it.
                </li>
                <li>You keep access: you'll get an explicit manage grant for this brand.</li>
                <li>It won't appear in anyone else's brand list, all-brands view, or counts.</li>
                <li>You'll be asked to confirm it's you.</li>
              </ul>
            ) : (
              <ul>
                <li>Workspace owners and administrators will regain automatic access.</li>
                <li>You'll be asked to confirm it's you.</li>
              </ul>
            )
          }
          onClose={() => setOpen(false)}
          destructive
        >
          <SaveProblem error={error} />
          <div className="actions">
            <button
              type="button"
              className="button button-secondary"
              data-cancel
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger"
              disabled={busy}
              onClick={() => void confirm()}
            >
              {busy ? 'Working…' : target ? 'Mark as sensitive' : 'Remove sensitive marking'}
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}

function ArchiveSection({
  ws,
  brand,
  onArchived,
  reload,
}: {
  ws: string;
  brand: Brand;
  onArchived: (b: Brand) => void;
  reload: () => void;
}) {
  const stepUp = useStepUp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const archive = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await tenancy.archive(ws, brand.id, brand.version, stepUp);
      setOpen(false);
      onArchived(next);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="archive-h" className="card">
      <h2 id="archive-h">Archive</h2>
      <p>
        Archiving hides this brand from the brand switcher and the all-brands view. Nothing is
        deleted, and you can restore it later.
      </p>
      <button
        type="button"
        className="button button-secondary"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Archive brand…
      </button>
      {open ? (
        <Dialog
          title={`Archive ${brand.name}?`}
          description={
            <ul>
              <li>
                It disappears from the brand switcher, the all-brands view, and active brand lists.
              </li>
              <li>Its settings and history are kept. It becomes read-only until restored.</li>
              <li>You can restore it at any time from Archived brands.</li>
            </ul>
          }
          onClose={() => setOpen(false)}
          destructive
        >
          <SaveProblem
            error={error}
            onUseLatest={() => {
              setOpen(false);
              reload();
            }}
          />
          <div className="actions">
            <button
              type="button"
              className="button button-secondary"
              data-cancel
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger"
              disabled={busy}
              onClick={() => void archive()}
            >
              {busy ? 'Working…' : 'Archive brand'}
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}

function ArchivedNotice({
  ws,
  brand,
  onRestored,
}: {
  ws: string;
  brand: Brand;
  onRestored: (b: Brand) => void;
}) {
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      onRestored(await tenancy.restore(ws, brand.id, brand.version, stepUp));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Banner
        tone="warning"
        title="This brand is archived"
        action={
          brand.capabilities.restore ? (
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => void restore()}
            >
              {busy ? 'Working…' : 'Restore brand'}
            </button>
          ) : undefined
        }
      >
        It's read-only and hidden from the brand switcher. Restore it to make changes.
      </Banner>
      <SaveProblem error={error} />
    </>
  );
}
