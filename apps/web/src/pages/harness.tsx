import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { Link } from '../router.tsx';
import { Announce, ProblemBanner } from '../ui/feedback.tsx';
import { Page } from '../ui/layout.tsx';
import {
  ChangeList,
  DeletedItem,
  PermissionUnavailable,
  PurgeConfirmDialog,
  RestoreConflict,
  TrashMetadata,
  type DisplayChange,
  type RestoreFailure,
} from '../ui/lifecycle.tsx';

/**
 * Component harness for the reusable audit and lifecycle states (Phase 1F). Rendered only when
 * the server reports the local/test-only harness flag; tenant pages that use these components
 * arrive with 1C/1D. Every value here is synthetic.
 */

const CHANGES: DisplayChange[] = [
  { field: 'title', label: 'Title', class: 'plain', old: 'Draft plan', new: 'Launch plan' },
  { field: 'due_date', label: 'Due date', class: 'plain', old: null, new: '12 Oct 2026' },
  { field: 'description', label: 'Description', class: 'content', versionLabel: 'version 4' },
  { field: 'api_key', label: 'API key', class: 'secret' },
  { field: 'connection', label: 'Connection', class: 'credential_ref' },
  { field: 'notes', label: 'Notes', redacted: true, reason: 'purge' },
  { field: 'budget', label: 'Budget', redacted: true, reason: 'policy' },
];

const RESTORE: RestoreFailure[] = [
  'container_trashed',
  'container_missing',
  'container_inactive',
  'brand_inactive',
  'recovery_expired',
  'concurrent_change',
];

const ALL_ROWS = Array.from({ length: 7 }, (_, i) => `Synthetic event ${i + 1}`);

function Paginated() {
  const [shown, setShown] = useState(3);
  return (
    <>
      <ul className="activity" aria-label="Synthetic events">
        {ALL_ROWS.slice(0, shown).map((r) => (
          <li key={r} className="activity-item">
            <p>{r}</p>
          </li>
        ))}
      </ul>
      {shown < ALL_ROWS.length ? (
        <div className="actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setShown((n) => n + 3)}
          >
            Show more
          </button>
        </div>
      ) : (
        <Announce>All events are shown.</Announce>
      )}
    </>
  );
}

function State({ title, children }: { title: string; children: React.ReactNode }) {
  const id = `state-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section className="card harness-state" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

export function LifecycleHarnessPage() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [purging, setPurging] = useState(false);
  const [purged, setPurged] = useState(false);
  useEffect(() => {
    api<{ data: { component_harness?: boolean } }>('GET', '/v1/auth/config')
      .then((r) => setEnabled(r.body.data.component_harness === true))
      .catch(() => setEnabled(false));
  }, []);
  if (enabled === null) return <Page title="Loading">{null}</Page>;
  if (!enabled)
    return (
      <Page title="Page not found">
        <p>
          <Link to="/">Go to the start page</Link>
        </p>
      </Page>
    );
  return (
    <Page
      title="Lifecycle components"
      wide
      lead="Synthetic states for the reusable audit and lifecycle components."
    >
      <State title="Audit change list">
        <ChangeList changes={CHANGES} />
      </State>
      <State title="No recorded changes">
        <ChangeList changes={[]} />
      </State>
      <State title="Deleted target">
        <p>
          Linked to <DeletedItem />
        </p>
      </State>
      <State title="Permission unavailable">
        <PermissionUnavailable what="this item" />
      </State>
      <State title="Trash metadata">
        <TrashMetadata
          deletedBy="A. Example"
          deletedAt="2026-10-01T09:30:00.000Z"
          itemCount={4}
          purgeEligibleAt={null}
        />
        <TrashMetadata
          deletedBy="B. Example"
          deletedAt="2026-10-01T09:30:00.000Z"
          itemCount={1}
          purgeEligibleAt="2026-11-01T09:30:00.000Z"
        />
      </State>
      <State title="Restore conflicts">
        {RESTORE.map((r) => (
          <RestoreConflict
            key={r}
            reason={r}
            onRestoreContainer={() => undefined}
            onReload={() => undefined}
          />
        ))}
      </State>
      <State title="Loading">
        <p role="status">Loading activity…</p>
      </State>
      <State title="Empty">
        <p>No activity yet.</p>
      </State>
      <State title="Error with retry">
        <ProblemBanner
          error={new ApiError({ code: 'internal_error', status: 500, message: '' })}
          onRetry={() => undefined}
        />
      </State>
      <State title="Offline with retry">
        <ProblemBanner
          error={new ApiError({ code: 'offline', status: 0, message: '' })}
          onRetry={() => undefined}
        />
      </State>
      <State title="Pagination">
        <Paginated />
      </State>
      <State title="Permanent deletion">
        {purged ? <Announce>Deleted permanently.</Announce> : null}
        <div className="actions">
          <button type="button" className="button button-danger" onClick={() => setPurging(true)}>
            Delete permanently…
          </button>
        </div>
        {purging ? (
          <PurgeConfirmDialog
            itemLabel="Synthetic project"
            itemCount={4}
            onCancel={() => setPurging(false)}
            onConfirm={() => {
              setPurging(false);
              setPurged(true);
            }}
          />
        ) : null}
      </State>
    </Page>
  );
}
