import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Link, takeFragmentToken, useRouter } from '../router.tsx';
import { useStepUp } from '../stepup.tsx';
import {
  collab,
  LEVEL_LABEL,
  pendingInvitation,
  ROLE_HELP,
  ROLE_LABEL,
  tenancy,
  type Change,
  type ExposureDiff,
  type Member,
  type RoleKey,
  type Team,
} from '../tenancy/client.ts';
import { LoadProblem, ResourceView, useResource } from '../tenancy/resource.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Announce, Banner } from '../ui/feedback.tsx';
import { ErrorSummary, Field, SelectField, SubmitButton } from '../ui/form.tsx';
import { Page } from '../ui/layout.tsx';
import { BrandMarker } from '../shell/brand-marker.tsx';
import { OtherIssues, SaveProblem, splitIssues, useSignedIn } from './workspace-pages.tsx';
import { FavoriteToggle } from './shell-pages.tsx';
import { useRecordVisit } from '../shell/workspace.tsx';

// -------------------------------------------------------------------------------------------
// Reviewed changes: preview (exposure summary) → confirm → apply (step-up handled by the client)
// -------------------------------------------------------------------------------------------

const CAP_LABEL: Record<string, string> = {
  configure: 'change workspace settings',
  create_brand: 'create brands',
  manage_people: 'manage people',
  invite_members: 'invite members',
  invite_guests: 'invite guests',
  manage_teams: 'manage teams',
  preview_access: 'preview access',
  configure_sharing: 'change sharing settings',
  transfer_ownership: 'transfer ownership',
  view_directory: 'see the people list',
};

/** Non-disclosing summary of what a change does, within scopes the reviewer manages. */
export function ExposureSummary({ diff }: { diff: ExposureDiff }) {
  const gained = Object.entries(diff.records_gained);
  const lost = Object.entries(diff.records_lost);
  const projects = diff.projects ?? [];
  const nothing =
    !diff.brands.length &&
    !projects.length &&
    !gained.length &&
    !lost.length &&
    !diff.capabilities_gained.length &&
    !diff.capabilities_lost.length;
  return (
    <div className="exposure">
      {diff.increases_access ? (
        <Banner tone="warning" title="This gives more access">
          Review what becomes visible before you confirm.
        </Banner>
      ) : null}
      {nothing ? <p>No visible change in the brands you manage.</p> : null}
      {diff.affected_members > 1 ? <p>Affects {diff.affected_members} people.</p> : null}
      {diff.brands.length ? (
        <ul aria-label="Brand access changes">
          {diff.brands.map((b) => (
            <li key={b.brand.id}>
              <strong>{b.brand.name}</strong>: {b.before ? LEVEL_LABEL[b.before] : 'no access'} →{' '}
              {b.after ? LEVEL_LABEL[b.after] : 'no access'}
            </li>
          ))}
        </ul>
      ) : null}
      {projects.length ? (
        <ul aria-label="Project access changes">
          {projects.map((x) => (
            <li key={x.project.id}>
              <strong>{x.project.name}</strong>: {x.before ? LEVEL_LABEL[x.before] : 'no access'} →{' '}
              {x.after ? LEVEL_LABEL[x.after] : 'no access'}
            </li>
          ))}
        </ul>
      ) : null}
      {gained.length ? (
        <p>
          Newly visible:{' '}
          {gained.map(([t, n]) => `${n} ${t.replace(/_/g, ' ')}${n === 1 ? '' : 's'}`).join(', ')}.
        </p>
      ) : null}
      {lost.length ? (
        <p>
          No longer visible:{' '}
          {lost.map(([t, n]) => `${n} ${t.replace(/_/g, ' ')}${n === 1 ? '' : 's'}`).join(', ')}.
        </p>
      ) : null}
      {diff.capabilities_gained.length ? (
        <p>Can now: {diff.capabilities_gained.map((c) => CAP_LABEL[c] ?? c).join(', ')}.</p>
      ) : null}
      {diff.capabilities_lost.length ? (
        <p>Can no longer: {diff.capabilities_lost.map((c) => CAP_LABEL[c] ?? c).join(', ')}.</p>
      ) : null}
    </div>
  );
}

/**
 * Runs a reviewed change: fetches the preview, shows the summary in a dialog, and applies with
 * the fingerprint. A stale preview (someone changed access meanwhile) asks to review again.
 */
export function ReviewedChange({
  ws,
  change,
  title,
  confirmLabel,
  destructive = false,
  onDone,
  onCancel,
  apply,
}: {
  ws: string;
  change: Change;
  title: string;
  confirmLabel: string;
  destructive?: boolean;
  onDone: () => void;
  onCancel: () => void;
  apply?: (previewToken: string) => Promise<unknown>;
}) {
  const stepUp = useStepUp();
  const [preview, setPreview] = useState<{ diff: ExposureDiff; preview_token: string } | null>(
    null,
  );
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setError(null);
    setPreview(null);
    try {
      setPreview(await collab.preview(ws, change));
    } catch (err) {
      setError(err);
    }
  };
  useEffect(() => {
    void collab.preview(ws, change).then(setPreview, setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      if (apply) await apply(preview.preview_token);
      else await collab.apply(ws, change, preview.preview_token, stepUp);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'cancelled') return;
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const stale = error instanceof ApiError && error.issues.some((i) => i.code === 'preview_stale');
  return (
    <Dialog title={title} onClose={onCancel} destructive={destructive}>
      {preview ? (
        <ExposureSummary diff={preview.diff} />
      ) : !error ? (
        <p role="status">Checking what changes…</p>
      ) : null}
      {stale ? (
        <Banner
          tone="warning"
          title="Access changed since you reviewed it"
          action={
            <button type="button" className="button button-secondary" onClick={() => void load()}>
              Review again
            </button>
          }
        />
      ) : error ? (
        <SaveProblem error={error} />
      ) : null}
      <OtherIssues issues={splitIssues(error, {}).other} />
      <div className="actions">
        <button type="button" className="button button-secondary" data-cancel onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={destructive ? 'button button-danger' : 'button button-primary'}
          disabled={!preview || busy || stale}
          onClick={() => void confirm()}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

const roleOptions = (allowed: RoleKey[]) =>
  allowed.map((r) => ({ value: r, label: ROLE_LABEL[r] }));
/** Roles each role may grant (0C §3.1); the server enforces the same rule. */
const GRANTABLE: Record<string, RoleKey[]> = {
  owner: ['owner', 'administrator', 'member', 'limited_member', 'read_only'],
  administrator: ['administrator', 'member', 'limited_member', 'read_only'],
};

function useMe(ws: string, ready: boolean) {
  return useResource(
    async () => (await collab.people(ws)).find((m) => m.is_you) ?? null,
    ready ? `me:${ws}` : 'wait',
  );
}

// -------------------------------------------------------------------------------------------
// People
// -------------------------------------------------------------------------------------------

export function PeoplePage({ ws }: { ws: string }) {
  const ready = useSignedIn();
  const stepUp = useStepUp();
  const [query, setQuery] = useState('');
  const [said, setSaid] = useState('');
  const [problem, setProblem] = useState<unknown>(null);
  const data = useResource(
    async () => {
      const [context, people] = await Promise.all([tenancy.context(ws), collab.people(ws)]);
      const caps = context.workspace.capabilities as Record<string, boolean>;
      const canSeeInvites = caps.invite_members || caps.invite_guests || caps.manage_people;
      const [invitations, transfer] = await Promise.all([
        canSeeInvites ? collab.invitations(ws).catch(() => []) : Promise.resolve([]),
        collab.transfer(ws).catch(() => null),
      ]);
      return { caps, people, invitations, transfer, workspace: context.workspace };
    },
    ready ? `people:${ws}` : 'wait',
  );
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setProblem(null);
    try {
      await fn();
      setSaid(label);
      data.reload();
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled')) setProblem(err);
    }
  };
  return (
    <Page title="People" wide>
      <ResourceView resource={data.state} onRetry={data.retry} what="people list">
        {(d) => {
          const term = query.trim().toLowerCase();
          const shown = d.people.filter(
            (m) =>
              !term ||
              m.display_name.toLowerCase().includes(term) ||
              (m.email ?? '').toLowerCase().includes(term),
          );
          return (
            <>
              {said ? <Announce>{said}</Announce> : null}
              <SaveProblem error={problem} />
              {d.transfer && d.transfer.capabilities.accept ? (
                <TransferBanner ws={ws} transfer={d.transfer} onDone={() => data.reload()} />
              ) : null}
              <div className="section-head">
                <h2>Members and guests ({d.people.length})</h2>
                {d.caps.invite_members || d.caps.invite_guests ? (
                  <Link to={`/workspaces/${ws}/people/invite`} className="button button-primary">
                    Invite people
                  </Link>
                ) : null}
              </div>
              <Field
                id="people-search"
                label="Search people"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                hint="By name, or by email if you manage people."
              />
              {shown.length ? (
                <ul className="people-list">
                  {shown.map((m) => (
                    <PersonRow key={m.id} ws={ws} m={m} />
                  ))}
                </ul>
              ) : (
                <p className="empty">{term ? 'Nobody matches that search.' : 'No people yet.'}</p>
              )}
              {d.caps.invite_members || d.caps.invite_guests || d.caps.manage_people ? (
                <section aria-labelledby="inv-h">
                  <h2 id="inv-h">Invitations</h2>
                  {d.invitations.filter((i) => i.state === 'pending' || i.state === 'expired')
                    .length ? (
                    <ul className="people-list">
                      {d.invitations
                        .filter((i) => i.state === 'pending' || i.state === 'expired')
                        .map((i) => (
                          <li key={i.id} className="person card">
                            <div>
                              <strong>{i.email}</strong>
                              <p className="hint">
                                {i.kind === 'guest' ? 'Guest' : ROLE_LABEL[i.role ?? 'member']} ·{' '}
                                {i.state === 'expired'
                                  ? 'Expired'
                                  : `Expires ${new Date(i.expires_at).toLocaleDateString()}`}{' '}
                                · sent {i.send_count}×
                              </p>
                            </div>
                            <div className="actions actions-compact">
                              <button
                                type="button"
                                className="button button-secondary"
                                onClick={() =>
                                  void act(`Invitation to ${i.email} sent again.`, () =>
                                    collab.resend(ws, i.id, stepUp),
                                  )
                                }
                              >
                                Resend<span className="visually-hidden"> to {i.email}</span>
                              </button>
                              <button
                                type="button"
                                className="button button-ghost"
                                onClick={() =>
                                  void act(`Invitation to ${i.email} revoked.`, () =>
                                    collab.revokeInvitation(ws, i.id, stepUp),
                                  )
                                }
                              >
                                Revoke
                                <span className="visually-hidden"> invitation to {i.email}</span>
                              </button>
                            </div>
                          </li>
                        ))}
                    </ul>
                  ) : (
                    <p className="empty">No pending invitations.</p>
                  )}
                </section>
              ) : null}
            </>
          );
        }}
      </ResourceView>
    </Page>
  );
}

function PersonRow({ ws, m }: { ws: string; m: Member }) {
  const status = m.state === 'suspended' ? 'Suspended' : m.state === 'removed' ? 'Removed' : null;
  return (
    <li className="person card">
      <div>
        <strong>{m.display_name}</strong>
        {m.is_you ? <span className="hint"> (you)</span> : null}
        {m.email ? <p className="hint">{m.email}</p> : null}
        <p className="badges">
          <span className="badge badge-info">{m.role ? ROLE_LABEL[m.role] : '—'}</span>
          {status ? <span className="badge badge-warning">{status}</span> : null}
          {m.teams.map((t) => (
            <span key={t} className="badge">
              {t}
            </span>
          ))}
        </p>
      </div>
      <Link to={`/workspaces/${ws}/people/${m.id}`}>
        Access and actions<span className="visually-hidden"> for {m.display_name}</span>
      </Link>
    </li>
  );
}

function TransferBanner({
  ws,
  transfer,
  onDone,
}: {
  ws: string;
  transfer: { id: string; from: { display_name: string } };
  onDone: () => void;
}) {
  const stepUp = useStepUp();
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onDone();
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'cancelled')) setError(err);
    }
  };
  return (
    <>
      <Banner
        tone="info"
        title={`${transfer.from.display_name} wants to make you an owner of this workspace`}
        action={
          <div className="actions actions-compact">
            <button
              type="button"
              className="button button-primary"
              onClick={() => void run(() => collab.acceptTransfer(ws, transfer.id, stepUp))}
            >
              Accept ownership
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void run(() => collab.cancelTransfer(ws, transfer.id, stepUp))}
            >
              Decline
            </button>
          </div>
        }
      >
        Owners have full control, including transferring ownership. You'll be asked to confirm it's
        you.
      </Banner>
      <SaveProblem error={error} />
    </>
  );
}

// -------------------------------------------------------------------------------------------
// Invite
// -------------------------------------------------------------------------------------------

const INVITE_POINTERS: Record<string, string> = {
  '/email': 'invite-email',
  '/role': 'invite-role',
  '/kind': 'invite-kind',
  '/records': 'invite-records',
};
const INVITE_LABELS: Record<string, string> = {
  'invite-email': 'Email',
  'invite-role': 'Role',
  'invite-kind': 'Invite as',
  'invite-records': 'Shared items',
};

export function InvitePage({ ws }: { ws: string }) {
  const ready = useSignedIn();
  const { navigate } = useRouter();
  const stepUp = useStepUp();
  const data = useResource(
    async () => {
      const [context, me, brands, shareable] = await Promise.all([
        tenancy.context(ws),
        collab.people(ws).then((p) => p.find((m) => m.is_you) ?? null),
        tenancy.listBrands(ws, 'active'),
        collab.shared(ws).catch(() => []),
      ]);
      return {
        caps: context.workspace.capabilities as Record<string, boolean>,
        me,
        brands: brands.data,
        shareable,
      };
    },
    ready ? `invite:${ws}` : 'wait',
  );
  const [email, setEmail] = useState('');
  const [kind, setKind] = useState<'member' | 'guest'>('member');
  const [role, setRole] = useState<RoleKey>('member');
  const [brandLevels, setBrandLevels] = useState<Record<string, string>>({});
  const [records, setRecords] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  return (
    <Page title="Invite people" wide>
      <ResourceView resource={data.state} onRetry={data.retry} what="invitation form">
        {(d) => {
          const allowedRoles = GRANTABLE[d.me?.role ?? ''] ?? [];
          const canMember = d.caps.invite_members && allowedRoles.length > 0;
          const canGuest = d.caps.invite_guests;
          const effectiveKind = canMember ? kind : 'guest';
          const submit = async (e: FormEvent) => {
            e.preventDefault();
            if (busy) return;
            setAttempt((a) => a + 1);
            setBusy(true);
            setError(null);
            try {
              const body =
                effectiveKind === 'member'
                  ? {
                      email,
                      kind: 'member',
                      role,
                      brands: Object.entries(brandLevels)
                        .filter(([, l]) => l)
                        .map(([brand, level]) => ({ brand, level })),
                    }
                  : {
                      email,
                      kind: 'guest',
                      records: records.map((record) => ({ record, level: 'read' })),
                    };
              await collab.invite(ws, body, stepUp);
              navigate(`/workspaces/${ws}/people`);
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          };
          const { fields, other } = splitIssues(error, INVITE_POINTERS);
          if (!canMember && !canGuest)
            return <Banner tone="warning" title="You don't have permission to invite people" />;
          return (
            <form onSubmit={submit} noValidate>
              <ErrorSummary errors={fields} labels={INVITE_LABELS} focusKey={attempt} />
              <Field
                id="invite-email"
                label="Email"
                type="email"
                autoComplete="off"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                error={fields['invite-email']}
                hint="We'll email an invitation link. It works once and expires."
              />
              {canMember && canGuest ? (
                <fieldset className="choices" id="invite-kind" tabIndex={-1}>
                  <legend>Invite as</legend>
                  <label className="choice">
                    <input
                      type="radio"
                      name="kind"
                      checked={kind === 'member'}
                      onChange={() => setKind('member')}
                    />
                    A member of the workspace
                  </label>
                  <label className="choice">
                    <input
                      type="radio"
                      name="kind"
                      checked={kind === 'guest'}
                      onChange={() => setKind('guest')}
                    />
                    A guest who sees only specific items
                  </label>
                </fieldset>
              ) : null}
              {effectiveKind === 'member' ? (
                <>
                  <SelectField
                    id="invite-role"
                    label="Role"
                    value={role}
                    onChange={(v) => setRole(v as RoleKey)}
                    options={roleOptions(allowedRoles)}
                    hint={ROLE_HELP[role]}
                    error={fields['invite-role']}
                  />
                  <fieldset className="plain">
                    <legend className="field-legend">Brand access (optional)</legend>
                    <p className="hint">
                      Owners and administrators already see every non-sensitive brand. Give others
                      access to specific brands here.
                    </p>
                    {d.brands.map((b) => (
                      <SelectField
                        key={b.id}
                        id={`invite-brand-${b.id}`}
                        label={b.name + (b.is_sensitive ? ' (sensitive)' : '')}
                        value={brandLevels[b.id] ?? ''}
                        onChange={(v) => setBrandLevels((x) => ({ ...x, [b.id]: v }))}
                        options={[
                          { value: '', label: 'No access' },
                          ...['view', 'comment', 'edit', 'manage'].map((l) => ({
                            value: l,
                            label: LEVEL_LABEL[l]!,
                          })),
                        ]}
                      />
                    ))}
                  </fieldset>
                </>
              ) : (
                <fieldset className="plain" id="invite-records" tabIndex={-1}>
                  <legend className="field-legend">Shared items</legend>
                  <p className="hint">
                    Guests see only the items you choose here — no people list, brands, or anything
                    else. They can't share onward.
                  </p>
                  {fields['invite-records'] ? (
                    <p className="field-error">{fields['invite-records']}</p>
                  ) : null}
                  {d.shareable.length ? (
                    d.shareable.map((r) => (
                      <label key={r.id} className="choice">
                        <input
                          type="checkbox"
                          checked={records.includes(r.id)}
                          onChange={(e) =>
                            setRecords((x) =>
                              e.target.checked ? [...x, r.id] : x.filter((y) => y !== r.id),
                            )
                          }
                        />
                        {r.type.replace(/_/g, ' ')} {r.id.slice(-6)}
                        <span className="hint">
                          {' · '}
                          <BrandMarker marker={r.brand} size={16} />
                        </span>
                      </label>
                    ))
                  ) : (
                    <Banner tone="info" title="Nothing can be shared with guests yet">
                      Guests are invited from a specific item, such as a project or task. Once those
                      exist, open the item and share it with the guest's email.
                    </Banner>
                  )}
                </fieldset>
              )}
              <OtherIssues issues={other} />
              <SaveProblem error={error} />
              <div className="actions">
                <SubmitButton busy={busy}>Send invitation</SubmitButton>
                <Link to={`/workspaces/${ws}/people`}>Cancel</Link>
              </div>
            </form>
          );
        }}
      </ResourceView>
    </Page>
  );
}

// -------------------------------------------------------------------------------------------
// One person: effective access (preview) and actions
// -------------------------------------------------------------------------------------------

export function MemberPage({ ws, member }: { ws: string; member: string }) {
  const ready = useSignedIn();
  const stepUp = useStepUp();
  const { navigate } = useRouter();
  const me = useMe(ws, ready);
  const data = useResource(
    () => collab.explanation(ws, member),
    ready ? `member:${ws}:${member}` : 'wait',
  );
  const [dialog, setDialog] = useState<null | 'role' | 'suspend' | 'remove'>(null);
  const [role, setRole] = useState<RoleKey | ''>('');
  const [said, setSaid] = useState('');
  const [problem, setProblem] = useState<unknown>(null);
  const title = data.state.status === 'ready' ? data.state.data.member.display_name : 'Person';
  return (
    <Page
      title={title}
      wide
      record={data.state.status === 'ready' ? { title } : null}
      breadcrumbs={[
        { label: 'Workspace', marker: { kind: 'workspace' } },
        { label: 'People', to: `/workspaces/${ws}/people` },
        { label: title },
      ]}
    >
      <ResourceView resource={data.state} onRetry={data.retry} what="person">
        {(d) => {
          const m = d.member;
          const e = d.explanation;
          const grantable =
            GRANTABLE[me.state.status === 'ready' ? (me.state.data?.role ?? '') : ''] ?? [];
          return (
            <>
              {said ? <Announce>{said}</Announce> : null}
              <SaveProblem error={problem} />
              <section className="card" aria-labelledby="role-h">
                <h2 id="role-h">Role</h2>
                <p>
                  <strong>{m.role ? ROLE_LABEL[m.role] : '—'}</strong>
                  {m.state !== 'active' ? (
                    <span className="badge badge-warning"> {m.state}</span>
                  ) : null}
                </p>
                <p className="hint">{m.role ? ROLE_HELP[m.role] : ''}</p>
                {e.role_cap ? (
                  <p className="hint">
                    Access is capped at {LEVEL_LABEL[e.role_cap]?.toLowerCase()} everywhere.
                  </p>
                ) : null}
                {m.capabilities.change_role ? (
                  <div className="grant-form">
                    <SelectField
                      id="new-role"
                      label="Change role to"
                      value={role}
                      onChange={(v) => setRole(v as RoleKey | '')}
                      options={[
                        { value: '', label: 'Choose a role' },
                        ...roleOptions(grantable.filter((r) => r !== m.role)),
                      ]}
                    />
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => setDialog('role')}
                      disabled={!role}
                    >
                      Review role change…
                    </button>
                  </div>
                ) : null}
                <div className="actions">
                  {m.capabilities.suspend ? (
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => setDialog('suspend')}
                    >
                      Suspend…
                    </button>
                  ) : null}
                  {m.capabilities.reactivate ? (
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() =>
                        void collab.reactivate(ws, m.id, stepUp).then(
                          () => {
                            setSaid(`${m.display_name} was reactivated.`);
                            data.reload();
                          },
                          (err) =>
                            !(err instanceof ApiError && err.code === 'cancelled') &&
                            setProblem(err),
                        )
                      }
                    >
                      Reactivate
                    </button>
                  ) : null}
                  {m.capabilities.remove ? (
                    <button
                      type="button"
                      className="button button-danger"
                      onClick={() => setDialog('remove')}
                    >
                      Remove from workspace…
                    </button>
                  ) : null}
                </div>
              </section>
              <section className="card" aria-labelledby="access-h">
                <h2 id="access-h">Effective access</h2>
                <p className="hint">Only brands you can manage are shown here.</p>
                {e.brands.length ? (
                  <table className="access-table">
                    <caption className="visually-hidden">Brand access for {m.display_name}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Brand</th>
                        <th scope="col">Access</th>
                        <th scope="col">Why</th>
                      </tr>
                    </thead>
                    <tbody>
                      {e.brands.map((b) => (
                        <tr key={b.brand.id}>
                          <th scope="row">
                            {b.brand.name}
                            {b.brand.is_sensitive ? (
                              <span className="badge badge-danger"> Sensitive</span>
                            ) : null}
                          </th>
                          <td>{b.level ? LEVEL_LABEL[b.level] : 'No access'}</td>
                          <td>
                            {b.sources.length
                              ? b.sources
                                  .map((s) =>
                                    s.via === 'implicit'
                                      ? 'Role (automatic)'
                                      : `${s.via === 'team' ? `Team ${s.team ?? ''}` : 'Direct grant'} (${LEVEL_LABEL[s.level]?.toLowerCase()}${s.expires_at ? `, until ${new Date(s.expires_at).toLocaleDateString()}` : ''})`,
                                  )
                                  .join('; ')
                              : b.brand.is_sensitive
                                ? 'Sensitive: needs an explicit grant'
                                : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="empty">No brands you manage.</p>
                )}
                {d.shares.length ? (
                  <>
                    <h3>Shared items</h3>
                    <ul>
                      {d.shares.map((s) => (
                        <li key={s.record.id}>
                          {s.record.type.replace(/_/g, ' ')} · {s.level}
                          {s.expires_at
                            ? ` · until ${new Date(s.expires_at).toLocaleDateString()}`
                            : ''}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </section>
              {dialog === 'role' ? (
                <ReviewedChange
                  ws={ws}
                  change={{ kind: 'role', member: m.id, role: role as RoleKey }}
                  title={`Change ${m.display_name}'s role to ${role ? ROLE_LABEL[role] : ''}?`}
                  confirmLabel="Change role"
                  onCancel={() => setDialog(null)}
                  onDone={() => {
                    setDialog(null);
                    setSaid(`${m.display_name} is now ${role ? ROLE_LABEL[role] : ''}.`);
                    data.reload();
                  }}
                />
              ) : null}
              {dialog === 'suspend' ? (
                <ReviewedChange
                  ws={ws}
                  change={{ kind: 'suspend', member: m.id }}
                  title={`Suspend ${m.display_name}?`}
                  confirmLabel="Suspend"
                  destructive
                  onCancel={() => setDialog(null)}
                  onDone={() => {
                    setDialog(null);
                    setSaid(
                      `${m.display_name} was suspended. They lose access on their next request.`,
                    );
                    data.reload();
                  }}
                />
              ) : null}
              {dialog === 'remove' ? (
                <RemoveDialog
                  ws={ws}
                  m={m}
                  onCancel={() => setDialog(null)}
                  onDone={() => navigate(`/workspaces/${ws}/people`)}
                />
              ) : null}
            </>
          );
        }}
      </ResourceView>
    </Page>
  );
}

function RemoveDialog({
  ws,
  m,
  onCancel,
  onDone,
}: {
  ws: string;
  m: Member;
  onCancel: () => void;
  onDone: () => void;
}) {
  const plan = useResource(async () => {
    const [items, people] = await Promise.all([
      collab.departurePlan(ws, m.id),
      collab.people(ws, { state: 'active' }),
    ]);
    return { items, people: people.filter((p) => p.kind === 'member' && p.id !== m.id) };
  }, `plan:${m.id}`);
  const [to, setTo] = useState('');
  if (plan.state.status !== 'ready')
    return (
      <Dialog title={`Remove ${m.display_name}?`} onClose={onCancel} destructive>
        {plan.state.status === 'failed' ? (
          <LoadProblem error={plan.state.error} onRetry={plan.retry} what="ownership plan" />
        ) : (
          <p role="status">Checking what they own…</p>
        )}
        <div className="actions">
          <button type="button" className="button button-secondary" data-cancel onClick={onCancel}>
            Cancel
          </button>
        </div>
      </Dialog>
    );
  const items = plan.state.data.items;
  return (
    <RemoveWrapper
      blocking={items.some((i) => i.requiresAssignee && i.owned > 0)}
      owned={items.filter((i) => i.owned > 0)}
      assignees={plan.state.data.people}
      to={to}
      setTo={setTo}
      ws={ws}
      m={m}
      onCancel={onCancel}
      onDone={onDone}
    />
  );
}

function RemoveWrapper({
  blocking,
  owned,
  assignees,
  to,
  setTo,
  ws,
  m,
  onCancel,
  onDone,
}: {
  blocking: boolean;
  owned: Array<{ hook: string; owned: number; requiresAssignee: boolean }>;
  assignees: Member[];
  to: string;
  setTo: (v: string) => void;
  ws: string;
  m: Member;
  onCancel: () => void;
  onDone: () => void;
}) {
  const stepUp = useStepUp();
  const [confirmed, setConfirmed] = useState(false);
  if (!confirmed)
    return (
      <Dialog title={`Remove ${m.display_name}?`} onClose={onCancel} destructive>
        <ul>
          <li>They lose access immediately and are signed out everywhere.</li>
          <li>
            Their queued work stops. Items already sent outside the workspace can't be recalled.
          </li>
          <li>Their history stays, shown as a former member.</li>
          {owned.map((o) => (
            <li key={o.hook}>
              {o.owned} {o.hook.replace(/_/g, ' ')}
              {o.requiresAssignee ? ' need a new owner' : ' will be closed'}
            </li>
          ))}
        </ul>
        {blocking ? (
          <SelectField
            id="reassign-to"
            label="New owner for their items"
            required
            value={to}
            onChange={setTo}
            options={[
              { value: '', label: 'Choose a person' },
              ...assignees.map((a) => ({ value: a.id, label: a.display_name })),
            ]}
          />
        ) : null}
        <div className="actions">
          <button type="button" className="button button-secondary" data-cancel onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-danger"
            disabled={blocking && !to}
            onClick={() => setConfirmed(true)}
          >
            Continue
          </button>
        </div>
      </Dialog>
    );
  return (
    <ReviewedChange
      ws={ws}
      change={{ kind: 'remove', member: m.id }}
      title={`Confirm removing ${m.display_name}`}
      confirmLabel="Remove from workspace"
      destructive
      onCancel={onCancel}
      onDone={onDone}
      apply={(token) => collab.remove(ws, m.id, token, to || null, stepUp)}
    />
  );
}

// -------------------------------------------------------------------------------------------
// Brand access panel (used in brand settings)
// -------------------------------------------------------------------------------------------

export function BrandAccessPanel({ ws, brand }: { ws: string; brand: string }) {
  const data = useResource(async () => {
    const [access, people, teams] = await Promise.all([
      collab.brandAccess(ws, brand),
      collab.people(ws, { state: 'active' }),
      collab.teams(ws),
    ]);
    return { access, people: people.filter((p) => p.kind === 'member'), teams };
  }, `brand-access:${ws}:${brand}`);
  const [principal, setPrincipal] = useState('');
  const [level, setLevel] = useState('view');
  const [dialog, setDialog] = useState<Change | null>(null);
  const [said, setSaid] = useState('');
  return (
    <section aria-labelledby="brand-access-h" className="card">
      <h2 id="brand-access-h">Who has access</h2>
      <ResourceView resource={data.state} onRetry={data.retry} what="brand access">
        {(d) => (
          <>
            {said ? <Announce>{said}</Announce> : null}
            <p className="hint">
              {d.access.implicit === 'none'
                ? 'Sensitive brand: only the people and teams listed here can see it. Owners and administrators have no automatic access.'
                : 'Owners and administrators see this brand automatically. Others need access here.'}
            </p>
            {d.access.grants.length ? (
              <ul className="people-list">
                {d.access.grants.map((g) => (
                  <li key={`${g.principal.type}:${g.principal.id}`} className="person">
                    <span>
                      <strong>{g.principal.name}</strong>{' '}
                      {g.principal.type === 'team' ? '(team)' : ''} · {LEVEL_LABEL[g.level]}
                      {g.expires_at
                        ? ` · until ${new Date(g.expires_at).toLocaleDateString()}`
                        : ''}
                    </span>
                    <button
                      type="button"
                      className="button button-ghost"
                      onClick={() =>
                        setDialog({ kind: 'brand_revoke', brand, principal: g.principal.id })
                      }
                    >
                      Remove access<span className="visually-hidden"> for {g.principal.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">No one has been given access directly.</p>
            )}
            <div className="grant-form">
              <SelectField
                id="grant-principal"
                label="Give access to"
                value={principal}
                onChange={setPrincipal}
                options={[
                  { value: '', label: 'Choose a person or team' },
                  ...d.people.map((p) => ({ value: p.id, label: p.display_name })),
                  ...d.teams.map((t) => ({ value: t.id, label: `${t.name} (team)` })),
                ]}
              />
              <SelectField
                id="grant-level"
                label="Access level"
                value={level}
                onChange={setLevel}
                options={['view', 'comment', 'edit', 'manage'].map((l) => ({
                  value: l,
                  label: LEVEL_LABEL[l]!,
                }))}
              />
              <button
                type="button"
                className="button button-secondary"
                disabled={!principal}
                onClick={() =>
                  setDialog({ kind: 'brand_grant', brand, principal, level, expires_at: null })
                }
              >
                Review access…
              </button>
            </div>
            {dialog ? (
              <ReviewedChange
                ws={ws}
                change={dialog}
                title={
                  dialog.kind === 'brand_grant' ? 'Give brand access?' : 'Remove brand access?'
                }
                confirmLabel={dialog.kind === 'brand_grant' ? 'Give access' : 'Remove access'}
                destructive={dialog.kind === 'brand_revoke'}
                onCancel={() => setDialog(null)}
                onDone={() => {
                  setSaid(dialog.kind === 'brand_grant' ? 'Access given.' : 'Access removed.');
                  setDialog(null);
                  setPrincipal('');
                  data.reload();
                }}
              />
            ) : null}
          </>
        )}
      </ResourceView>
    </section>
  );
}

// -------------------------------------------------------------------------------------------
// Teams
// -------------------------------------------------------------------------------------------

export function TeamsPage({ ws }: { ws: string }) {
  const ready = useSignedIn();
  const stepUp = useStepUp();
  const data = useResource(
    async () => ({ active: await collab.teams(ws), archived: await collab.teams(ws, 'archived') }),
    ready ? `teams:${ws}` : 'wait',
  );
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await collab.createTeam(ws, { name }, stepUp);
      setSaid(`Team ${t.name} was created.`);
      setName('');
      data.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const { fields } = splitIssues(error, { '/name': 'team-name' });
  return (
    <Page title="Teams" wide>
      <p className="lead">
        Teams group people. Giving a team brand access gives it to everyone in the team.
      </p>
      <ResourceView resource={data.state} onRetry={data.retry} what="teams">
        {(d) => (
          <>
            {said ? <Announce>{said}</Announce> : null}
            {d.active.length ? (
              <ul className="people-list">
                {d.active.map((t) => (
                  <TeamRow key={t.id} ws={ws} t={t} />
                ))}
              </ul>
            ) : (
              <p className="empty">No teams yet.</p>
            )}
            {d.active[0]?.capabilities.manage !== false ? (
              <form onSubmit={create} noValidate className="card">
                <h2>Create a team</h2>
                <Field
                  id="team-name"
                  label="Team name"
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  error={fields['team-name']}
                />
                <SaveProblem error={error} />
                <div className="actions">
                  <SubmitButton busy={busy}>Create team</SubmitButton>
                </div>
              </form>
            ) : null}
            {d.archived.length ? (
              <section aria-labelledby="archived-teams-h">
                <h2 id="archived-teams-h">Archived teams ({d.archived.length})</h2>
                <ul className="people-list">
                  {d.archived.map((t) => (
                    <TeamRow key={t.id} ws={ws} t={t} />
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </ResourceView>
    </Page>
  );
}

function TeamRow({ ws, t }: { ws: string; t: Team }) {
  return (
    <li className="person card">
      <div>
        <strong>{t.name}</strong>
        <p className="hint">
          {t.members.length} {t.members.length === 1 ? 'person' : 'people'}
          {t.brand_access.length
            ? ` · access to ${t.brand_access.map((b) => b.brand.name).join(', ')}`
            : ''}
          {t.lifecycle_state === 'archived' ? ' · archived' : ''}
        </p>
      </div>
      <Link to={`/workspaces/${ws}/teams/${t.id}`}>
        Manage<span className="visually-hidden"> team {t.name}</span>
      </Link>
    </li>
  );
}

export function TeamPage({ ws, team }: { ws: string; team: string }) {
  const ready = useSignedIn();
  const stepUp = useStepUp();
  const data = useResource(
    async () => {
      const [t, people] = await Promise.all([
        collab.team(ws, team),
        collab.people(ws, { state: 'active' }),
      ]);
      return { t, people: people.filter((p) => p.kind === 'member') };
    },
    ready ? `team:${ws}:${team}` : 'wait',
  );
  const [add, setAdd] = useState('');
  const [dialog, setDialog] = useState<Change | null>(null);
  const [said, setSaid] = useState('');
  const [problem, setProblem] = useState<unknown>(null);
  const loaded = data.state.status === 'ready' ? data.state.data.t : null;
  const title = loaded ? `Team ${loaded.name}` : 'Team';
  // A successful authorized render counts as a visit (NAV-007); archived teams are not navigable.
  useRecordVisit(loaded && loaded.lifecycle_state === 'active' ? loaded.id : null);
  return (
    <Page
      title={title}
      wide
      record={loaded ? { title: loaded.name } : null}
      breadcrumbs={[
        { label: 'Workspace', marker: { kind: 'workspace' } },
        { label: 'Teams', to: `/workspaces/${ws}/teams` },
        { label: loaded?.name ?? 'Team' },
      ]}
      actions={
        loaded && loaded.lifecycle_state === 'active' ? (
          <FavoriteToggle target={loaded.id} label={loaded.name} />
        ) : undefined
      }
    >
      <ResourceView resource={data.state} onRetry={data.retry} what="team">
        {(d) => {
          const inTeam = new Set(d.t.members.map((m) => m.id));
          const archived = d.t.lifecycle_state === 'archived';
          return (
            <>
              {said ? <Announce>{said}</Announce> : null}
              <SaveProblem error={problem} />
              {archived ? (
                <Banner tone="warning" title="This team is archived">
                  Archived teams give nobody access.
                </Banner>
              ) : null}
              <section className="card" aria-labelledby="members-h">
                <h2 id="members-h">Members ({d.t.members.length})</h2>
                {d.t.members.length ? (
                  <ul className="people-list">
                    {d.t.members.map((m) => (
                      <li key={m.id} className="person">
                        <span>{m.display_name}</span>
                        {d.t.capabilities.manage && !archived ? (
                          <button
                            type="button"
                            className="button button-ghost"
                            onClick={() =>
                              setDialog({ kind: 'team_remove', team: d.t.id, member: m.id })
                            }
                          >
                            Remove
                            <span className="visually-hidden"> {m.display_name} from the team</span>
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="empty">Nobody in this team yet.</p>
                )}
                {d.t.capabilities.manage && !archived ? (
                  <div className="grant-form">
                    <SelectField
                      id="team-add"
                      label="Add a person"
                      value={add}
                      onChange={setAdd}
                      options={[
                        { value: '', label: 'Choose a person' },
                        ...d.people
                          .filter((p) => !inTeam.has(p.id))
                          .map((p) => ({ value: p.id, label: p.display_name })),
                      ]}
                    />
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={!add}
                      onClick={() => setDialog({ kind: 'team_add', team: d.t.id, member: add })}
                    >
                      Review adding…
                    </button>
                  </div>
                ) : null}
              </section>
              <section className="card" aria-labelledby="team-brands-h">
                <h2 id="team-brands-h">Brand access</h2>
                {d.t.brand_access.length ? (
                  <ul>
                    {d.t.brand_access.map((b) => (
                      <li key={b.brand.id}>
                        {b.brand.name} · {LEVEL_LABEL[b.level]}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="empty">
                    This team has no brand access. Give access from a brand's settings.
                  </p>
                )}
              </section>
              {d.t.capabilities.manage ? (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() =>
                    void collab.archiveTeam(ws, d.t.id, !archived, stepUp).then(
                      () => {
                        setSaid(archived ? 'Team restored.' : 'Team archived.');
                        data.reload();
                      },
                      (err) =>
                        !(err instanceof ApiError && err.code === 'cancelled') && setProblem(err),
                    )
                  }
                >
                  {archived ? 'Restore team' : 'Archive team'}
                </button>
              ) : null}
              {dialog ? (
                <ReviewedChange
                  ws={ws}
                  change={dialog}
                  title={dialog.kind === 'team_add' ? 'Add to team?' : 'Remove from team?'}
                  confirmLabel={dialog.kind === 'team_add' ? 'Add to team' : 'Remove from team'}
                  destructive={dialog.kind === 'team_remove'}
                  onCancel={() => setDialog(null)}
                  onDone={() => {
                    setSaid(
                      dialog.kind === 'team_add' ? 'Added to the team.' : 'Removed from the team.',
                    );
                    setDialog(null);
                    setAdd('');
                    data.reload();
                  }}
                />
              ) : null}
            </>
          );
        }}
      </ResourceView>
    </Page>
  );
}

// -------------------------------------------------------------------------------------------
// Sharing, guests, and ownership (workspace policy, transfer, leave)
// -------------------------------------------------------------------------------------------

const POLICY_COPY: Array<{ field: string; label: string; hint: string }> = [
  {
    field: 'guest_invitations_enabled',
    label: 'Allow guest invitations',
    hint: 'Guests see only specific items shared with them.',
  },
  {
    field: 'members_invite_guests',
    label: 'Members can invite guests',
    hint: 'Otherwise only owners and administrators can.',
  },
  {
    field: 'cross_brand_sharing_enabled',
    label: 'Allow sharing items across brands',
    hint: 'Share an item from one brand with another brand or its people.',
  },
  {
    field: 'comment_on_archived',
    label: 'Allow comments on archived items',
    hint: 'Archived items stay read-only otherwise.',
  },
];

export function AccessSettingsPage({ ws }: { ws: string }) {
  const ready = useSignedIn();
  const stepUp = useStepUp();
  const { navigate } = useRouter();
  const data = useResource(
    async () => {
      const [settings, people, transfer, context] = await Promise.all([
        collab.policy(ws),
        collab.people(ws, { state: 'active' }),
        collab.transfer(ws).catch(() => null),
        tenancy.context(ws),
      ]);
      return {
        settings,
        people,
        transfer,
        caps: context.workspace.capabilities as Record<string, boolean>,
      };
    },
    ready ? `access-settings:${ws}` : 'wait',
  );
  const [pending, setPending] = useState<{ field: string; value: boolean } | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [said, setSaid] = useState('');
  const [to, setTo] = useState('');
  const [demote, setDemote] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const save = async (field: string, value: unknown, confirm: boolean) => {
    setProblem(null);
    try {
      await collab.updatePolicy(ws, { [field]: value }, confirm, stepUp);
      setSaid('Setting saved.');
      setPending(null);
      data.reload();
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.issues.some((i) => i.code === 'exposure_confirmation_required') &&
        typeof value === 'boolean'
      ) {
        setPending({ field, value });
        return;
      }
      if (!(err instanceof ApiError && err.code === 'cancelled')) setProblem(err);
    }
  };
  return (
    <Page title="Sharing and ownership" wide>
      <ResourceView resource={data.state} onRetry={data.retry} what="sharing settings">
        {(d) => {
          const me = d.people.find((p) => p.is_you);
          return (
            <>
              {said ? <Announce>{said}</Announce> : null}
              <SaveProblem error={problem} />
              <section className="card" aria-labelledby="sharing-h">
                <h2 id="sharing-h">Sharing and guests</h2>
                {POLICY_COPY.map((c) => {
                  const s = d.settings[c.field];
                  if (!s) return null;
                  return (
                    <label key={c.field} className="choice choice-block">
                      <input
                        type="checkbox"
                        checked={s.value === true}
                        disabled={!s.editable}
                        onChange={(e) => void save(c.field, e.target.checked, false)}
                      />
                      <span>
                        {c.label}
                        <span className="hint block">{c.hint}</span>
                      </span>
                    </label>
                  );
                })}
                <p className="hint">Public links are not available.</p>
              </section>
              {d.caps.transfer_ownership ? (
                <section className="card" aria-labelledby="transfer-h">
                  <h2 id="transfer-h">Transfer ownership</h2>
                  {d.transfer ? (
                    <Banner
                      tone="info"
                      title={`Waiting for ${d.transfer.to.display_name} to accept`}
                      action={
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() =>
                            void collab
                              .cancelTransfer(ws, d.transfer!.id, stepUp)
                              .then(() => data.reload(), setProblem)
                          }
                        >
                          Cancel transfer
                        </button>
                      }
                    >
                      Expires {new Date(d.transfer.expires_at).toLocaleDateString()}.
                    </Banner>
                  ) : (
                    <>
                      <SelectField
                        id="transfer-to"
                        label="New owner"
                        value={to}
                        onChange={setTo}
                        options={[
                          { value: '', label: 'Choose a person' },
                          ...d.people
                            .filter((p) => p.kind === 'member' && !p.is_you && p.role !== 'owner')
                            .map((p) => ({ value: p.id, label: p.display_name })),
                        ]}
                        hint="They must accept, and confirm it's them. You'll confirm it's you first."
                      />
                      <label className="choice">
                        <input
                          type="checkbox"
                          checked={demote}
                          onChange={(e) => setDemote(e.target.checked)}
                        />
                        Make me an administrator after they accept
                      </label>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={!to}
                        onClick={() =>
                          void collab.requestTransfer(ws, to, demote, stepUp).then(
                            () => {
                              setSaid('Ownership transfer requested.');
                              data.reload();
                            },
                            (err) =>
                              !(err instanceof ApiError && err.code === 'cancelled') &&
                              setProblem(err),
                          )
                        }
                      >
                        Request transfer
                      </button>
                    </>
                  )}
                </section>
              ) : null}
              <section className="card" aria-labelledby="leave-h">
                <h2 id="leave-h">Leave workspace</h2>
                {me?.role === 'owner' && d.people.filter((p) => p.role === 'owner').length < 2 ? (
                  <p>You're the only owner. Transfer ownership before you can leave.</p>
                ) : (
                  <button
                    type="button"
                    className="button button-danger"
                    onClick={() => setLeaving(true)}
                  >
                    Leave workspace…
                  </button>
                )}
              </section>
              {pending ? (
                <Dialog
                  title="This gives people more access"
                  onClose={() => setPending(null)}
                  destructive
                >
                  <p>
                    {POLICY_COPY.find((c) => c.field === pending.field)?.label}: people will be able
                    to do more than before.
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      data-cancel
                      onClick={() => setPending(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="button button-primary"
                      onClick={() => void save(pending.field, pending.value, true)}
                    >
                      Turn on
                    </button>
                  </div>
                </Dialog>
              ) : null}
              {leaving ? (
                <Dialog title="Leave this workspace?" onClose={() => setLeaving(false)} destructive>
                  <p>
                    You'll lose access immediately and be signed out. Someone will need to invite
                    you again to return.
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      data-cancel
                      onClick={() => setLeaving(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="button button-danger"
                      onClick={() =>
                        void collab.leave(ws, null, stepUp).then(
                          () => navigate('/sign-in'),
                          (err) => {
                            setLeaving(false);
                            setProblem(err);
                          },
                        )
                      }
                    >
                      Leave workspace
                    </button>
                  </div>
                </Dialog>
              ) : null}
            </>
          );
        }}
      </ResourceView>
    </Page>
  );
}

// -------------------------------------------------------------------------------------------
// Invitation acceptance (recipient)
// -------------------------------------------------------------------------------------------

export function AcceptInvitationPage() {
  const { me } = useAuth();
  const { navigate } = useRouter();
  const stepUp = useStepUp();
  const [token] = useState(() => {
    const t = takeFragmentToken();
    if (t) pendingInvitation.set(t);
    return t ?? pendingInvitation.get();
  });
  const info = useResource(
    async () =>
      token
        ? collab.inspect(token)
        : Promise.reject(new ApiError({ code: 'not_found', status: 404, message: '' })),
    me ? `inspect:${token ?? 'none'}` : 'wait',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (me === undefined) return <Page title="Loading">{null}</Page>;
  if (me === null)
    return (
      <Page
        title="You've been invited"
        lead="Sign in or create an account with the email address the invitation was sent to."
      >
        <div className="actions">
          <Link to="/sign-in" className="button button-primary">
            Sign in
          </Link>
          <Link to="/register" className="button button-secondary">
            Create an account
          </Link>
        </div>
        <p className="hint">We'll bring you back to the invitation afterwards.</p>
      </Page>
    );
  const accept = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const r = await collab.accept(token, stepUp);
      pendingInvitation.clear();
      navigate(`/workspaces/${r.workspace.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title="Join a workspace">
      {!me.email_verified ? (
        <Banner
          tone="warning"
          title="Confirm your email address first"
          action={<Link to="/verify-email">Resend the link</Link>}
        >
          Invitations can only be accepted with a confirmed email address.
        </Banner>
      ) : null}
      {info.state.status === 'loading' ? <p role="status">Checking your invitation…</p> : null}
      {info.state.status === 'failed' ? (
        <Banner
          tone="warning"
          title="This invitation isn't available"
          action={<Link to="/onboarding">Go to your workspaces</Link>}
        >
          It may have expired, been used, or been revoked. Ask the person who invited you to send a
          new one.
        </Banner>
      ) : null}
      {info.state.status === 'ready' && info.state.data.status === 'email_mismatch' ? (
        <Banner tone="warning" title="This invitation was sent to a different email address">
          Sign out, then sign in or create an account with the address the invitation was sent to.
        </Banner>
      ) : null}
      {info.state.status === 'ready' && info.state.data.status === 'ready' ? (
        <section aria-labelledby="inv-detail-h" className="card">
          <h2 id="inv-detail-h">{info.state.data.workspace_name}</h2>
          <p>
            {info.state.data.inviter} invited you as{' '}
            <strong>
              {info.state.data.kind === 'guest'
                ? 'a guest'
                : ROLE_LABEL[info.state.data.role ?? 'member']}
            </strong>
            .
          </p>
          <p className="hint">
            {info.state.data.kind === 'guest'
              ? ROLE_HELP.guest
              : ROLE_HELP[info.state.data.role ?? 'member']}
          </p>
          <SaveProblem error={error} />
          <div className="actions">
            <button
              type="button"
              className="button button-primary"
              disabled={busy || !me.email_verified}
              onClick={() => void accept()}
            >
              {busy ? 'Working…' : 'Accept invitation'}
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                pendingInvitation.clear();
                navigate('/onboarding');
              }}
            >
              Not now
            </button>
          </div>
        </section>
      ) : null}
    </Page>
  );
}
