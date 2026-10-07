import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, newIdempotencyKey } from '../api.ts';
import { Link } from '../router.tsx';
import { routeHref } from '../shell/registry.ts';
import { useStepUp } from '../stepup.tsx';
import { Dialog } from '../ui/dialog.tsx';
import {
  collaboration,
  COMMENT_MAX_CHARS,
  REACTION_KEYS,
  type Comment,
  type Mention,
  type Revision,
  type Thread,
} from './client.ts';
import { liveMentions, MentionField } from './mention-field.tsx';
import {
  day,
  draftId,
  explain,
  Problem,
  REACTION_LABEL,
  useDraft,
  useOnline,
  when,
  type Explained,
} from './shared.tsx';

/**
 * Comments on a task or project (4A, COL-005 to COL-009): oldest first, flat threads, edit and
 * delete inside the author's window, an append-only history, eight reactions, and @mentions. Every
 * control comes from the capabilities the server returned, so what you see is what you may do.
 */

interface ThreadState {
  root: Comment;
  replies: Comment[];
  count: number;
  /** Cursor for the next page of replies; undefined once every reply is loaded. */
  next: string | null | undefined;
  loadedAll: boolean;
}

const fromThread = (t: Thread): ThreadState => {
  const { replies, reply_count, replies_more, ...root } = t;
  return {
    root,
    replies,
    count: reply_count,
    next: replies_more ? null : undefined,
    loadedAll: !replies_more,
  };
};

const authorName = (c: Comment) => c.author?.name ?? 'Someone who has left';

/** Text with its recorded mentions marked; records link only when the server returned them. */
export function CommentText({ ws, comment }: { ws: string; comment: Comment }) {
  const parts = useMemo(() => {
    const text = comment.text ?? '';
    if (!comment.mentions.length) return [text];
    const names = [...comment.mentions].sort((a, b) => b.name.length - a.name.length);
    const escaped = names.map((m) => m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`(@(?:${escaped.join('|')}))`, 'g');
    return text.split(re);
  }, [comment.text, comment.mentions]);
  const find = (token: string): Mention | undefined =>
    comment.mentions.find((m) => `@${m.name}` === token);
  return (
    <div className="comment-text">
      {parts.map((p, i) => {
        const m = i % 2 === 1 ? find(p) : undefined;
        if (!m) return <Fragment key={i}>{p}</Fragment>;
        if (m.kind === 'record')
          return (
            <Link
              key={i}
              className="mention"
              to={
                m.id.startsWith('prj_')
                  ? routeHref('project', { ws, prj: m.id })
                  : routeHref('task', { ws, tsk: m.id })
              }
            >
              {p}
            </Link>
          );
        return (
          <span key={i} className="mention">
            {p}
          </span>
        );
      })}
    </div>
  );
}

// -----------------------------------------------------------------------------------------------
// Composer
// -----------------------------------------------------------------------------------------------

interface Encoded {
  text: string;
  mentions: Mention[];
}
const decode = (raw: string): Encoded => {
  if (!raw) return { text: '', mentions: [] };
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && typeof (v as Encoded).text === 'string') {
      const m = (v as Encoded).mentions;
      return { text: (v as Encoded).text, mentions: Array.isArray(m) ? m : [] };
    }
  } catch {
    // an older plain-text draft
  }
  return { text: raw, mentions: [] };
};
const encode = (text: string, mentions: Mention[]) =>
  text.trim() === '' ? '' : JSON.stringify({ text, mentions });

export function Composer({
  ws,
  rec,
  draftKey,
  label,
  submitLabel,
  replyTo,
  canMention,
  onPosted,
  onCancel,
  focusOnMount = false,
  focusToken,
}: {
  ws: string;
  rec: string;
  draftKey: string;
  label: string;
  submitLabel: string;
  replyTo?: string;
  canMention: boolean;
  onPosted: (c: Comment) => void;
  onCancel?: () => void;
  focusOnMount?: boolean;
  /** Changing this moves focus into the text box (the Reply buttons). */
  focusToken?: unknown;
}) {
  const stepUp = useStepUp();
  const online = useOnline();
  const draft = useDraft(draftKey);
  const { text, mentions } = useMemo(() => decode(draft.text), [draft.text]);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [empty, setEmpty] = useState(false);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  // One key per unsent comment: a retry after a dropped connection replays instead of posting twice.
  const attempt = useRef<{ key: string; sig: string } | null>(null);
  const id = `${draftKey.replace(/[^a-z0-9]/g, '-')}-text`;
  const over = [...text].length > COMMENT_MAX_CHARS;

  useEffect(() => {
    if (focusOnMount) field.current?.focus();
  }, [focusOnMount]);
  useEffect(() => {
    if (focusToken !== undefined) field.current?.focus();
  }, [focusToken]);

  const setText = (next: string, nextMentions?: Mention[]) => {
    setEmpty(false);
    setProblem(null);
    draft.set(encode(next, nextMentions ?? mentions));
  };

  const send = async () => {
    if (busy) return;
    if (!text.trim()) {
      setEmpty(true);
      field.current?.focus();
      return;
    }
    if (over) return;
    const chosen = liveMentions(text, mentions);
    const body = {
      text,
      mentions: chosen.map(({ kind, id: mid }) => ({ kind, id: mid })),
      ...(replyTo ? { reply_to: replyTo } : {}),
    };
    const sig = JSON.stringify(body);
    if (attempt.current?.sig !== sig) attempt.current = { key: newIdempotencyKey(), sig };
    setBusy(true);
    setProblem(null);
    try {
      const posted = await collaboration.post(ws, rec, body, stepUp, attempt.current.key);
      attempt.current = null;
      draft.discard();
      onPosted(posted);
    } catch (err) {
      const e = explain(err, 'posting');
      // A refusal is final for this request; only an unknown outcome keeps the key.
      if (!e.retryable) attempt.current = null;
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="comment-composer"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <MentionField
        id={id}
        label={label}
        value={text}
        onChange={setText}
        mentions={mentions}
        ws={ws}
        rec={rec}
        enabled={canMention}
        onSubmit={() => void send()}
        error={empty ? 'Write something before posting.' : undefined}
        invalid={over}
        textareaRef={field}
        describedBy={`${id}-count`}
        hint={
          canMention
            ? 'Type @ to mention someone. Press Ctrl+Enter (Cmd+Enter on a Mac) to post.'
            : 'Press Ctrl+Enter (Cmd+Enter on a Mac) to post.'
        }
      />
      <p className={over ? 'collab-count collab-count-over' : 'collab-count'} id={`${id}-count`}>
        {[...text].length.toLocaleString()} of {COMMENT_MAX_CHARS.toLocaleString()} characters
        {over ? ' — too long. Shorten it to post.' : ''}
      </p>
      {draft.restored && text ? (
        <p className="hint">Restored your unsent draft from this device.</p>
      ) : null}
      {!online ? (
        <p className="collab-offline" role="status">
          <span aria-hidden="true">! </span>You're offline. Your draft is saved on this device. Post
          it when you're back online.
        </p>
      ) : null}
      <Problem problem={problem} onRetry={() => void send()} busy={busy} />
      <div className="actions">
        <button type="submit" className="button button-primary" disabled={busy || over}>
          {busy ? 'Posting…' : submitLabel}
        </button>
        {onCancel ? (
          <button type="button" className="button button-secondary" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

// -----------------------------------------------------------------------------------------------
// One comment
// -----------------------------------------------------------------------------------------------

function EditForm({
  ws,
  rec,
  comment,
  canMention,
  onSaved,
  onCancel,
}: {
  ws: string;
  rec: string;
  comment: Comment;
  canMention: boolean;
  onSaved: (c: Comment) => void;
  onCancel: () => void;
}) {
  const stepUp = useStepUp();
  const [text, setText] = useState(comment.text ?? '');
  const [mentions, setMentions] = useState<Mention[]>(comment.mentions);
  const [version, setVersion] = useState(comment.version);
  const [newer, setNewer] = useState<Comment | null>(null);
  const [problem, setProblem] = useState<Explained | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const over = [...text].length > COMMENT_MAX_CHARS;
  useEffect(() => field.current?.focus(), []);

  const save = async () => {
    if (busy || over) return;
    if (!text.trim()) {
      setProblem({
        message: 'Write something, or delete the comment instead.',
        kind: 'rejected',
        retryable: false,
      });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const chosen = liveMentions(text, mentions);
      onSaved(
        await collaboration.edit(
          ws,
          comment.id,
          version,
          { text, mentions: chosen.map(({ kind, id }) => ({ kind, id })) },
          stepUp,
        ),
      );
    } catch (err) {
      const e = explain(err, 'saving');
      if (e.kind === 'stale') {
        // 409: someone (usually you, in another tab) changed it. Show what is there now and keep
        // the text being written; saving again deliberately replaces the newer text.
        try {
          const latest = await collaboration.comment(ws, comment.id);
          if (latest.deleted) onSaved(latest);
          else {
            setNewer(latest);
            setVersion(latest.version);
            setProblem({
              message:
                'This comment changed since you started editing. The current text is shown below, and your edit is kept here.',
              kind: 'stale',
              retryable: false,
            });
          }
        } catch (inner) {
          setProblem(explain(inner, 'loading the current text'));
        }
      } else if (e.kind === 'deleted') {
        try {
          onSaved(await collaboration.comment(ws, comment.id));
        } catch {
          setProblem(e);
        }
      } else setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="comment-edit"
      aria-label="Edit comment"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <MentionField
        id={`edit-${comment.id}`}
        label="Edit your comment"
        value={text}
        onChange={(v, m) => {
          setText(v);
          if (m) setMentions(m);
          setProblem(null);
        }}
        mentions={mentions}
        ws={ws}
        rec={rec}
        enabled={canMention}
        onSubmit={() => void save()}
        invalid={over}
        textareaRef={field}
        describedBy={`edit-${comment.id}-count`}
      />
      <p
        className={over ? 'collab-count collab-count-over' : 'collab-count'}
        id={`edit-${comment.id}-count`}
      >
        {[...text].length.toLocaleString()} of {COMMENT_MAX_CHARS.toLocaleString()} characters
      </p>
      <Problem problem={problem} onRetry={() => void save()} busy={busy} />
      {newer ? (
        <blockquote className="comment-newer">
          <p className="hint">Current text</p>
          <div className="comment-text">{newer.text}</div>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              setText(newer.text ?? '');
              setMentions(newer.mentions);
              setNewer(null);
              setProblem(null);
            }}
          >
            Use the current text
          </button>
        </blockquote>
      ) : null}
      <div className="actions">
        <button type="submit" className="button button-primary" disabled={busy || over}>
          {busy ? 'Saving…' : newer ? 'Save my edit anyway' : 'Save changes'}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function DeleteDialog({
  ws,
  comment,
  onClose,
  onDeleted,
}: {
  ws: string;
  comment: Comment;
  onClose: () => void;
  onDeleted: (c: Comment) => void;
}) {
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  const own = comment.capabilities.edit;
  const go = async () => {
    setBusy(true);
    setProblem(null);
    try {
      onDeleted(await collaboration.remove(ws, comment.id, stepUp));
    } catch (err) {
      setProblem(explain(err, 'deleting'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Delete this comment?"
      description={
        own
          ? 'The text is removed for everyone. Replies stay, with a note that this comment was deleted. The earlier text is kept in the history that only you and moderators can read. This cannot be undone.'
          : "This removes someone else's comment as a moderator. Replies stay, with a note that a moderator removed it. The author and moderators can still read the earlier text in its history. This cannot be undone."
      }
      destructive
      onClose={onClose}
    >
      <Problem problem={problem} onRetry={() => void go()} busy={busy} />
      <div className="actions">
        <button
          type="button"
          className="button button-secondary"
          data-cancel
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="button button-danger"
          onClick={() => void go()}
          disabled={busy}
        >
          {busy ? 'Deleting…' : 'Delete comment'}
        </button>
      </div>
    </Dialog>
  );
}

function History({ ws, comment }: { ws: string; comment: Comment }) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; rows: Revision[] }
    | { status: 'failed'; e: Explained }
  >({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let active = true;
    collaboration.revisions(ws, comment.id).then(
      (rows) => active && setState({ status: 'ready', rows }),
      (err: unknown) => active && setState({ status: 'failed', e: explain(err, 'loading') }),
    );
    return () => {
      active = false;
    };
  }, [ws, comment.id, comment.version, nonce]);
  if (state.status === 'loading') return <p className="loading">Loading history…</p>;
  if (state.status === 'failed')
    return (
      <Problem
        problem={{ ...state.e, retryable: true }}
        onRetry={() => {
          setState({ status: 'loading' });
          setNonce((n) => n + 1);
        }}
      />
    );
  if (!state.rows.length)
    return <p className="hint">No earlier versions. This comment has not been edited.</p>;
  return (
    <ol className="comment-history" aria-label="Earlier versions">
      {state.rows.map((r) => (
        <li key={r.revision}>
          <p className="hint">
            {r.kind === 'deleted' ? 'Text before it was deleted' : 'Earlier text'} · {when(r.at)}
            {r.actor ? ` · by ${r.actor.name}` : ''}
          </p>
          <div className="comment-text">{r.text ?? ''}</div>
        </li>
      ))}
    </ol>
  );
}

function Reactions({
  ws,
  comment,
  onChanged,
}: {
  ws: string;
  comment: Comment;
  onChanged: (c: Comment) => void;
}) {
  const stepUp = useStepUp();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<Explained | null>(null);
  const toggle = async (key: (typeof REACTION_KEYS)[number], on: boolean) => {
    if (busy) return;
    setBusy(key);
    setProblem(null);
    try {
      onChanged(await collaboration.react(ws, comment.id, key, on, stepUp));
    } catch (err) {
      setProblem(explain(err, 'reacting'));
    } finally {
      setBusy(null);
    }
  };
  const row = new Map(comment.reactions.map((r) => [r.reaction, r]));
  const canReact = comment.capabilities.react;
  // Read-only people see the reactions that exist, without buttons.
  if (!canReact && !comment.reactions.length) return null;
  return (
    <div className="reactions-wrap">
      <div role="group" aria-label="Reactions" className="reactions">
        {REACTION_KEYS.filter((k) => canReact || row.has(k)).map((k) => {
          const r = row.get(k);
          const count = r?.count ?? 0;
          const mine = !!r?.mine;
          const { glyph, name } = REACTION_LABEL[k];
          return (
            <button
              key={k}
              type="button"
              className="reaction"
              aria-pressed={mine}
              aria-label={`${name}${count ? `, ${count}` : ''}`}
              disabled={!canReact}
              aria-busy={busy === k || undefined}
              onClick={() => void toggle(k, !mine)}
            >
              <span aria-hidden="true">{glyph}</span>
              {count ? <span className="reaction-count">{count}</span> : null}
            </button>
          );
        })}
      </div>
      <Problem problem={problem} />
    </div>
  );
}

function CommentItem({
  ws,
  rec,
  comment,
  canMention,
  onChanged,
  onReply,
  isReply,
}: {
  ws: string;
  rec: string;
  comment: Comment;
  canMention: boolean;
  onChanged: (c: Comment) => void;
  onReply: (c: Comment) => void;
  isReply: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [history, setHistory] = useState(false);
  const caps = comment.capabilities;
  const headId = `c-${comment.id}`;
  return (
    <article
      className={isReply ? 'comment comment-reply' : 'comment'}
      aria-labelledby={headId}
      id={`comment-${comment.id}`}
    >
      <header className="comment-head" id={headId}>
        <strong>{authorName(comment)}</strong>{' '}
        <span className="hint">
          <time dateTime={comment.created_at}>{when(comment.created_at)}</time>
          {comment.edited_at && !comment.deleted ? ` · Edited ${day(comment.edited_at)}` : ''}
        </span>
      </header>
      {comment.deleted ? (
        <p className="comment-tombstone">
          <span aria-hidden="true">⌀ </span>
          {comment.deleted_by === 'moderator'
            ? 'This comment was removed by a moderator.'
            : 'This comment was deleted.'}
        </p>
      ) : editing ? (
        <EditForm
          ws={ws}
          rec={rec}
          comment={comment}
          canMention={canMention}
          onSaved={(c) => {
            setEditing(false);
            onChanged(c);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <CommentText ws={ws} comment={comment} />
      )}
      {!comment.deleted ? <Reactions ws={ws} comment={comment} onChanged={onChanged} /> : null}
      {!editing ? (
        <div className="comment-actions" role="group" aria-label="Comment actions">
          {caps.reply ? (
            <button
              type="button"
              className="button button-ghost"
              id={`reply-btn-${comment.id}`}
              onClick={() => onReply(comment)}
            >
              Reply<span className="visually-hidden"> to {authorName(comment)}</span>
            </button>
          ) : null}
          {caps.edit && !comment.deleted ? (
            <button type="button" className="button button-ghost" onClick={() => setEditing(true)}>
              Edit<span className="visually-hidden"> comment by {authorName(comment)}</span>
            </button>
          ) : null}
          {caps.delete && !comment.deleted ? (
            <button type="button" className="button button-ghost" onClick={() => setDeleting(true)}>
              Delete<span className="visually-hidden"> comment by {authorName(comment)}</span>
            </button>
          ) : null}
          {caps.history ? (
            <button
              type="button"
              className="button button-ghost"
              aria-expanded={history}
              onClick={() => setHistory((h) => !h)}
            >
              {history ? 'Hide history' : 'History'}
              <span className="visually-hidden"> of comment by {authorName(comment)}</span>
            </button>
          ) : null}
        </div>
      ) : null}
      {history && caps.history ? <History ws={ws} comment={comment} /> : null}
      {deleting ? (
        <DeleteDialog
          ws={ws}
          comment={comment}
          onClose={() => setDeleting(false)}
          onDeleted={(c) => {
            setDeleting(false);
            onChanged(c);
          }}
        />
      ) : null}
    </article>
  );
}

// -----------------------------------------------------------------------------------------------
// The panel
// -----------------------------------------------------------------------------------------------

export function CommentsPanel({
  ws,
  rec,
  canComment,
  archived,
  canMention,
  noun,
}: {
  ws: string;
  rec: string;
  /** `summary.capabilities.comment`. */
  canComment: boolean;
  archived: boolean;
  canMention: boolean;
  noun: 'task' | 'project';
}) {
  const [threads, setThreads] = useState<ThreadState[]>([]);
  const [load, setLoad] = useState<
    { status: 'loading' } | { status: 'ready' } | { status: 'failed'; e: Explained }
  >({ status: 'loading' });
  const [more, setMore] = useState<{ next: string | null; busy: boolean; e: Explained | null }>({
    next: null,
    busy: false,
    e: null,
  });
  const [nonce, setNonce] = useState(0);
  const [target, setTarget] = useState<{ thread: string; to: Comment; token: number } | null>(null);
  const [said, setSaid] = useState('');

  useEffect(() => {
    let active = true;
    collaboration.comments(ws, rec).then(
      (r) => {
        if (!active) return;
        setThreads(r.data.map(fromThread));
        setMore({
          next: r.page.has_more ? (r.page.next_cursor ?? null) : null,
          busy: false,
          e: null,
        });
        setLoad({ status: 'ready' });
      },
      (err: unknown) => active && setLoad({ status: 'failed', e: explain(err, 'loading') }),
    );
    return () => {
      active = false;
    };
  }, [ws, rec, nonce]);

  const loadMore = async () => {
    if (!more.next || more.busy) return;
    setMore((m) => ({ ...m, busy: true, e: null }));
    try {
      const r = await collaboration.comments(ws, rec, { cursor: more.next });
      setThreads((prev) => {
        const have = new Set(prev.map((t) => t.root.id));
        return [...prev, ...r.data.map(fromThread).filter((t) => !have.has(t.root.id))];
      });
      setMore({
        next: r.page.has_more ? (r.page.next_cursor ?? null) : null,
        busy: false,
        e: null,
      });
    } catch (err) {
      setMore((m) => ({ ...m, busy: false, e: explain(err, 'loading more') }));
    }
  };

  const replace = (c: Comment) =>
    setThreads((prev) =>
      prev.map((t) =>
        t.root.id === c.id
          ? { ...t, root: c }
          : { ...t, replies: t.replies.map((r) => (r.id === c.id ? c : r)) },
      ),
    );

  const posted = (c: Comment) => {
    if (c.thread === null) {
      setThreads((prev) =>
        prev.some((t) => t.root.id === c.id)
          ? prev
          : [...prev, { root: c, replies: [], count: 0, next: undefined, loadedAll: true }],
      );
      setSaid('Comment posted.');
      return;
    }
    setThreads((prev) =>
      prev.map((t) =>
        t.root.id === c.thread
          ? {
              ...t,
              count: t.count + 1,
              replies:
                t.loadedAll && !t.replies.some((r) => r.id === c.id)
                  ? [...t.replies, c]
                  : t.replies,
            }
          : t,
      ),
    );
    setTarget(null);
    setSaid('Reply posted.');
    requestAnimationFrame(() =>
      document.getElementById(`reply-btn-${c.in_reply_to ?? c.thread}`)?.focus(),
    );
  };

  const showReplies = async (root: string) => {
    const t = threads.find((x) => x.root.id === root);
    if (!t) return;
    const r = await collaboration.replies(
      ws,
      root,
      t.loadedAll ? undefined : (t.next ?? undefined),
    );
    setThreads((prev) =>
      prev.map((x) => {
        if (x.root.id !== root) return x;
        const have = new Set(x.replies.map((c) => c.id));
        const merged = [...x.replies, ...r.data.filter((c) => !have.has(c.id))];
        return {
          ...x,
          replies: merged,
          count: Math.max(x.count, merged.length),
          next: r.page.has_more ? (r.page.next_cursor ?? null) : undefined,
          loadedAll: !r.page.has_more,
        };
      }),
    );
  };

  return (
    <section className="card collab-card" aria-labelledby={`comments-h-${rec}`}>
      <h2 id={`comments-h-${rec}`}>Comments</h2>
      {canComment ? (
        <Composer
          ws={ws}
          rec={rec}
          draftKey={draftId('comment', rec)}
          label="Add a comment"
          submitLabel="Post comment"
          canMention={canMention}
          onPosted={posted}
        />
      ) : (
        <p className="hint" id={`no-compose-${rec}`}>
          {archived
            ? `This ${noun} is archived, so comments are read-only. Restore it to add a comment.`
            : `You can read comments on this ${noun}, but you can't add them. Ask someone with comment access if you need to say something.`}
        </p>
      )}
      <p className="visually-hidden" role="status">
        {said}
      </p>
      {load.status === 'loading' ? <p className="loading">Loading comments…</p> : null}
      {load.status === 'failed' ? (
        <Problem
          problem={{ ...load.e, retryable: load.e.kind !== 'gone' }}
          onRetry={() => {
            setLoad({ status: 'loading' });
            setNonce((n) => n + 1);
          }}
        />
      ) : null}
      {load.status === 'ready' && !threads.length ? (
        <p className="hint">No comments yet.{canComment ? ' Start the conversation above.' : ''}</p>
      ) : null}
      {threads.length ? (
        <ol className="comment-list" aria-label="Comments">
          {threads.map((t) => {
            const hidden = t.count - t.replies.length;
            return (
              <li key={t.root.id}>
                <CommentItem
                  ws={ws}
                  rec={rec}
                  comment={t.root}
                  canMention={canMention}
                  onChanged={replace}
                  onReply={(c) => setTarget({ thread: t.root.id, to: c, token: Date.now() })}
                  isReply={false}
                />
                {t.replies.length || hidden > 0 || target?.thread === t.root.id ? (
                  <div className="comment-replies">
                    {t.replies.length ? (
                      <ol className="reply-list" aria-label={`Replies to ${authorName(t.root)}`}>
                        {t.replies.map((r) => (
                          <li key={r.id}>
                            <CommentItem
                              ws={ws}
                              rec={rec}
                              comment={r}
                              canMention={canMention}
                              onChanged={replace}
                              onReply={(c) =>
                                setTarget({ thread: t.root.id, to: c, token: Date.now() })
                              }
                              isReply
                            />
                          </li>
                        ))}
                      </ol>
                    ) : null}
                    {hidden > 0 ? (
                      <ShowMore
                        label={`Show ${hidden} more ${hidden === 1 ? 'reply' : 'replies'}`}
                        onClick={() => showReplies(t.root.id)}
                      />
                    ) : null}
                    {target?.thread === t.root.id ? (
                      <Composer
                        ws={ws}
                        rec={rec}
                        draftKey={draftId('reply', t.root.id)}
                        label={`Reply to ${authorName(target.to)}`}
                        submitLabel="Post reply"
                        replyTo={target.to.id}
                        canMention={canMention}
                        onPosted={posted}
                        onCancel={() => setTarget(null)}
                        focusOnMount
                        focusToken={target.token}
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      {more.e ? (
        <Problem problem={{ ...more.e, retryable: true }} onRetry={() => void loadMore()} />
      ) : null}
      {more.next ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={more.busy}
          onClick={() => void loadMore()}
        >
          {more.busy ? 'Loading…' : 'Load more comments'}
        </button>
      ) : null}
    </section>
  );
}

function ShowMore({ label, onClick }: { label: string; onClick: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Explained | null>(null);
  return (
    <>
      <button
        type="button"
        className="button button-ghost"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setProblem(null);
          onClick()
            .catch((err: unknown) => setProblem(explain(err, 'loading replies')))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Loading…' : label}
      </button>
      <Problem problem={problem} />
    </>
  );
}

export { ApiError };
