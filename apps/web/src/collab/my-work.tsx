import { useEffect, useState } from 'react';
import { Link } from '../router.tsx';
import { routeHref } from '../shell/registry.ts';
import { LoadProblem } from '../tenancy/resource.tsx';
import { collaboration, type FollowingRow, type MyReview } from './client.ts';
import { StateBadge } from './reviews.tsx';
import { day, explain, Problem, STATUS_CATEGORY_LABEL, type Explained } from './shared.tsx';

/** My Work → Following and Reviews (4A). Both are plain lists over the viewer's own rows. */

const recordHref = (ws: string, type: string, id: string) =>
  type === 'project'
    ? routeHref('project', { ws, prj: id })
    : type === 'document'
      ? routeHref('document', { ws, doc: id })
      : routeHref('task', { ws, tsk: id });

type Filter = 'all' | 'task' | 'project' | 'document';
const FILTERS: Array<[Filter, string]> = [
  ['all', 'All'],
  ['task', 'Tasks'],
  ['project', 'Projects'],
  ['document', 'Documents'],
];

/** The shared "first page, then Load more by cursor" state of both lists. */
function usePaged<T>(
  load: (
    cursor?: string,
  ) => Promise<{ data: T[]; page: { has_more: boolean; next_cursor?: string } }>,
  key: string,
) {
  const [entry, setEntry] = useState<{
    key: string;
    rows: T[];
    cursor: string | null;
    status: 'ready' | 'failed';
    error: unknown;
  } | null>(null);
  const [more, setMore] = useState<{ busy: boolean; e: Explained | null }>({
    busy: false,
    e: null,
  });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let active = true;
    load().then(
      (r) => {
        if (!active) return;
        setEntry({
          key,
          rows: r.data,
          cursor: r.page.has_more ? (r.page.next_cursor ?? null) : null,
          status: 'ready',
          error: null,
        });
        setMore({ busy: false, e: null });
      },
      (err: unknown) => {
        if (active) setEntry({ key, rows: [], cursor: null, status: 'failed', error: err });
      },
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);
  const current = entry?.key === key ? entry : null;
  const rows = current?.rows ?? [];
  const cursor = current?.cursor ?? null;
  const status = current?.status ?? 'loading';
  const error = current?.error ?? null;
  const loadMore = async () => {
    if (!cursor) return;
    setMore({ busy: true, e: null });
    try {
      const r = await load(cursor);
      setEntry((p) =>
        p && p.key === key
          ? {
              ...p,
              rows: [...p.rows, ...r.data],
              cursor: r.page.has_more ? (r.page.next_cursor ?? null) : null,
            }
          : p,
      );
      setMore({ busy: false, e: null });
    } catch (err) {
      setMore({ busy: false, e: { ...explain(err, 'loading more'), retryable: true } });
    }
  };
  return {
    rows,
    cursor,
    status,
    error,
    more,
    loadMore,
    retry: () => {
      setEntry(null);
      setNonce((n) => n + 1);
    },
  };
}

function LoadMore({
  cursor,
  more,
  onMore,
  what,
}: {
  cursor: string | null;
  more: { busy: boolean; e: Explained | null };
  onMore: () => void;
  what: string;
}) {
  return (
    <>
      <Problem problem={more.e} onRetry={onMore} busy={more.busy} />
      {cursor ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={more.busy}
          onClick={onMore}
        >
          {more.busy ? 'Loading…' : `Load more ${what}`}
        </button>
      ) : null}
    </>
  );
}

export function FollowingTab({ ws }: { ws: string }) {
  const [filter, setFilter] = useState<Filter>('all');
  const list = usePaged<FollowingRow>(
    (cursor) =>
      collaboration.following(ws, {
        ...(filter === 'all' ? {} : { type: filter }),
        ...(cursor ? { cursor } : {}),
      }),
    `${ws}:${filter}`,
  );
  return (
    <section aria-labelledby="following-h" className="card">
      <h2 id="following-h">Following</h2>
      <div role="group" aria-label="Show" className="segments">
        {FILTERS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="button button-secondary segment"
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {list.status === 'loading' ? <p className="loading">Loading what you follow…</p> : null}
      {list.status === 'failed' ? (
        <LoadProblem error={list.error} onRetry={list.retry} what="list" />
      ) : null}
      {list.status === 'ready' && !list.rows.length ? (
        <p>
          {filter === 'all'
            ? "You aren't following anything yet. Open a task, project, or document and choose Follow to keep it here."
            : `You aren't following any ${filter === 'task' ? 'tasks' : filter === 'project' ? 'projects' : 'documents'} yet. Open one and choose Follow to keep it here.`}
        </p>
      ) : null}
      {list.rows.length ? (
        <ul className="plain-list record-rows" aria-label="Followed records">
          {list.rows.map((r) => (
            <li key={r.id} className="record-row follow-row">
              <Link className="record-link" to={recordHref(ws, r.type, r.id)}>
                {r.title}
              </Link>{' '}
              <span className="badge">
                {r.type === 'project' ? 'Project' : r.type === 'document' ? 'Document' : 'Task'}
              </span>
              {r.archived ? <span className="badge">Archived</span> : null}
              {r.brand ? <span className="badge">{r.brand.name}</span> : null}
              <span className="hint">
                {' '}
                {STATUS_CATEGORY_LABEL[r.status_category] ?? r.status_category}
                {r.due ? ` · Due ${r.due}` : ''} · Followed {day(r.followed_at)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <LoadMore
        cursor={list.cursor}
        more={list.more}
        onMore={() => void list.loadMore()}
        what="records"
      />
    </section>
  );
}

type Role = 'reviewer' | 'requester';

export function ReviewsTab({ ws }: { ws: string }) {
  const [role, setRole] = useState<Role>('reviewer');
  const [settled, setSettled] = useState(false);
  const state = settled ? 'settled' : 'open';
  const list = usePaged<MyReview>(
    (cursor) => collaboration.myReviews(ws, { role, state, ...(cursor ? { cursor } : {}) }),
    `${ws}:${role}:${state}`,
  );
  return (
    <section aria-labelledby="reviews-h" className="card">
      <h2 id="reviews-h">Reviews</h2>
      <div role="group" aria-label="Reviews to show" className="segments">
        {(
          [
            ['reviewer', 'To do'],
            ['requester', 'Asked by me'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="button button-secondary segment"
            aria-pressed={role === id}
            onClick={() => setRole(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <label className="choice">
        <input type="checkbox" checked={settled} onChange={(e) => setSettled(e.target.checked)} />
        Settled
      </label>
      {list.status === 'loading' ? <p className="loading">Loading reviews…</p> : null}
      {list.status === 'failed' ? (
        <LoadProblem error={list.error} onRetry={list.retry} what="list" />
      ) : null}
      {list.status === 'ready' && !list.rows.length ? (
        <p>
          {settled
            ? 'No settled reviews to show.'
            : role === 'reviewer'
              ? 'Nothing is waiting for your review. When someone asks you to review a task or project, it shows up here.'
              : "You haven't asked anyone to review something that is still open."}
        </p>
      ) : null}
      {list.rows.length ? (
        <ul className="plain-list record-rows" aria-label="Reviews">
          {list.rows.map((r) => (
            <li key={r.id} className="record-row review-row">
              <Link className="record-link" to={recordHref(ws, r.subject.type, r.subject.id)}>
                {r.subject.title}
              </Link>{' '}
              <span className="badge">{r.kind === 'approval' ? 'Approval' : 'Review'}</span>
              <StateBadge state={r.state} />
              {r.stale && r.state === 'requested' ? (
                <span className="badge badge-warning">
                  <span aria-hidden="true">! </span>Changed since asked
                </span>
              ) : null}
              <span className="hint">
                {' '}
                {role === 'reviewer'
                  ? r.requested_by
                    ? `Asked by ${r.requested_by.name}`
                    : 'Asked by someone who has left'
                  : 'Asked by you'}
                {' · '}
                {day(r.created_at)}
                {r.mine_decision
                  ? ` · You ${r.mine_decision === 'approved' ? 'approved' : r.mine_decision === 'rejected' ? 'rejected' : 'asked for changes'}`
                  : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <LoadMore
        cursor={list.cursor}
        more={list.more}
        onMore={() => void list.loadMore()}
        what="reviews"
      />
    </section>
  );
}
