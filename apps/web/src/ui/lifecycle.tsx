import { useId, useState, type ReactNode } from 'react';
import { Dialog } from './dialog.tsx';
import { Banner } from './feedback.tsx';

/**
 * Reusable audit and lifecycle states (Phase 1F). Tenant routes that use them arrive with 1C/1D;
 * until then they are exercised through the component harness and component tests.
 */

const when = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );

/** An audit change entry as rendered for a viewer (values already filtered by field policy). */
export type DisplayChange =
  | {
      field: string;
      label: string;
      class: 'plain' | 'personal';
      old: string | null;
      new: string | null;
    }
  | { field: string; label: string; class: 'content'; versionLabel?: string }
  | { field: string; label: string; class: 'secret' | 'credential_ref' }
  | {
      field: string;
      label: string;
      redacted: true;
      reason: 'purge' | 'account_deletion' | 'privacy_request' | 'legal_request' | 'policy';
    };

const REDACTION_REASON: Record<string, string> = {
  purge: 'removed when the item was permanently deleted',
  account_deletion: 'removed when the person deleted their account',
  privacy_request: 'removed after a privacy request',
  legal_request: 'removed after a legal request',
  policy: 'hidden because you can’t view this field',
};

/** Marker for a value that is not shown, with the reason in text (never colour alone). */
export function RedactedValue({ reason }: { reason: keyof typeof REDACTION_REASON }) {
  return (
    <span className="redacted">
      <span aria-hidden="true">▒▒▒ </span>Redacted
      <span className="visually-hidden">: {REDACTION_REASON[reason]}</span>
      <span className="redacted-reason" aria-hidden="true">
        {' '}
        ({REDACTION_REASON[reason]})
      </span>
    </span>
  );
}

function Value({ v }: { v: string | null }) {
  return v === null || v === '' ? (
    <span className="value-empty">empty</span>
  ) : (
    <span className="value">{v}</span>
  );
}

/** Audit change list: what changed, from what to what, per field class. */
export function ChangeList({ changes }: { changes: readonly DisplayChange[] }) {
  if (!changes.length)
    return <p className="hint">No field changes were recorded for this event.</p>;
  return (
    <dl className="change-list">
      {changes.map((c) => (
        <div key={c.field} className="change">
          <dt>{c.label}</dt>
          <dd>
            {'redacted' in c ? (
              <RedactedValue reason={c.reason} />
            ) : c.class === 'plain' || c.class === 'personal' ? (
              <>
                <Value v={c.old} /> <span aria-hidden="true">→</span>
                <span className="visually-hidden"> changed to </span> <Value v={c.new} />
              </>
            ) : c.class === 'content' ? (
              <>Content changed{c.versionLabel ? ` (${c.versionLabel})` : ''}</>
            ) : c.class === 'secret' ? (
              <>Changed (the value is never shown)</>
            ) : (
              <>Connection changed</>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A reference to something the viewer cannot see: purged, in trash, never existed, or not
 * readable. One representation for all, so it reveals nothing (ST-41).
 */
export function DeletedItem() {
  return (
    <span className="deleted-item">
      <span aria-hidden="true">⊘ </span>Deleted item
    </span>
  );
}

/** "Permission unavailable": the viewer may not open this, without saying whether it exists. */
export function PermissionUnavailable({ what = 'this' }: { what?: string }) {
  return (
    <Banner tone="info" title={`You can’t view ${what}`}>
      Ask a workspace owner or administrator if you need access.
    </Banner>
  );
}

/** Trash entry metadata: who deleted it, when, how many items, and when it can be purged. */
export function TrashMetadata({
  deletedBy,
  deletedAt,
  itemCount,
  purgeEligibleAt,
}: {
  deletedBy: string;
  deletedAt: string;
  itemCount: number;
  /** null while the recovery period is undecided: no date is shown or implied. */
  purgeEligibleAt: string | null;
}) {
  return (
    <p className="trash-meta">
      Deleted by {deletedBy} on {when(deletedAt)} · {itemCount} item{itemCount === 1 ? '' : 's'} ·{' '}
      {purgeEligibleAt
        ? `Can be restored until ${when(purgeEligibleAt)}`
        : 'Can be restored until you delete it permanently'}
    </p>
  );
}

export type RestoreFailure =
  | 'container_trashed'
  | 'container_missing'
  | 'container_inactive'
  | 'brand_inactive'
  | 'recovery_expired'
  | 'concurrent_change'
  | 'not_restorable';

const RESTORE_MESSAGES: Record<RestoreFailure, { title: string; body: string }> = {
  container_trashed: {
    title: 'Its location is in trash',
    body: 'Restore the item it was in first, then try again.',
  },
  container_missing: {
    title: 'Its location no longer exists',
    body: 'The item it was in was permanently deleted.',
  },
  container_inactive: {
    title: 'Its location is archived',
    body: 'Restore the archived item it was in first.',
  },
  brand_inactive: {
    title: 'Its brand is archived',
    body: 'Restore the brand before restoring items into it.',
  },
  recovery_expired: {
    title: 'This can no longer be restored',
    body: 'Its recovery period has ended.',
  },
  concurrent_change: {
    title: 'Something changed meanwhile',
    body: 'Reload to see the current state, then try again.',
  },
  not_restorable: {
    title: 'This can’t be restored',
    body: 'It’s being permanently deleted or was already restored.',
  },
};

/** Restore conflicts with what happened and what to do next (0E ST-03, ST-46). */
export function RestoreConflict({
  reason,
  onRestoreContainer,
  onReload,
}: {
  reason: RestoreFailure;
  onRestoreContainer?: () => void;
  onReload?: () => void;
}) {
  const m = RESTORE_MESSAGES[reason];
  const action =
    reason === 'container_trashed' && onRestoreContainer ? (
      <button type="button" className="button button-secondary" onClick={onRestoreContainer}>
        Restore its location
      </button>
    ) : reason === 'concurrent_change' && onReload ? (
      <button type="button" className="button button-secondary" onClick={onReload}>
        Reload
      </button>
    ) : undefined;
  return (
    <Banner tone="warning" title={m.title} action={action}>
      {m.body}
    </Banner>
  );
}

/**
 * Irreversible permanent deletion (0A §1 rule 1, 0E destructive conventions): states that it
 * cannot be undone, discloses backup residuals, and requires typing a confirmation word.
 */
export function PurgeConfirmDialog({
  itemLabel,
  itemCount,
  busy,
  onConfirm,
  onCancel,
}: {
  itemLabel: string;
  itemCount: number;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactNode {
  const [typed, setTyped] = useState('');
  const id = useId();
  const ok = typed.trim() === 'DELETE';
  return (
    <Dialog
      destructive
      title={`Delete “${itemLabel}” permanently?`}
      description={
        <>
          <p>
            This deletes {itemCount} item{itemCount === 1 ? '' : 's'} for good. It can’t be undone,
            and links to
            {itemCount === 1 ? ' it' : ' them'} will show “Deleted item”.
          </p>
          <p>Copies may remain in backups until those backups expire.</p>
        </>
      }
      onClose={onCancel}
    >
      <div className="field">
        <label htmlFor={`${id}-confirm`}>
          Type DELETE to confirm <span className="visually-hidden">(required)</span>
        </label>
        <input
          id={`${id}-confirm`}
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          aria-describedby={`${id}-hint`}
        />
        <p id={`${id}-hint`} className="hint">
          Letters must match exactly.
        </p>
      </div>
      <div className="actions">
        <button type="button" className="button button-secondary" data-cancel onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="button button-danger"
          disabled={!ok || busy}
          onClick={onConfirm}
        >
          {busy ? 'Deleting…' : 'Delete permanently'}
        </button>
      </div>
    </Dialog>
  );
}
