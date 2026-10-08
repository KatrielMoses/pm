import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { collaboration, COMMENT_MAX_CHARS, type Candidate, type Mention } from './client.ts';

/**
 * A comment text box with an @mention picker (listbox pattern). Typing `@` and a few letters
 * searches the people (and teams and records) this record can name; Arrow keys move, Enter or Tab
 * chooses, Escape closes. Choosing inserts `@Name` into the text and records the target, so the
 * request names exactly who was picked. A mention whose `@Name` text is later deleted is dropped.
 * The text box stays a plain multi-line text box for assistive technology: the open list is
 * connected through aria-controls and aria-activedescendant and announced in a status line.
 */

const KIND_LABEL: Record<Candidate['kind'], string> = {
  member: 'Person',
  team: 'Team',
  record: 'Task or project',
};

interface Trigger {
  start: number;
  end: number;
  query: string;
}

const tkey = (t: Trigger) => `${t.start}:${t.query}`;

const detect = (text: string, caret: number): Trigger | null => {
  const m = /(^|\s)@([^\s@]{0,40})$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2]!.length - 1, end: caret, query: m[2]! } : null;
};

/** Mentions whose `@Name` text is still present, one per target. */
export function liveMentions(text: string, mentions: Mention[]): Mention[] {
  const seen = new Set<string>();
  return mentions.filter((m) => {
    const key = `${m.kind}:${m.id}`;
    if (seen.has(key) || !text.includes(`@${m.name}`)) return false;
    seen.add(key);
    return true;
  });
}

export function MentionField({
  id,
  label,
  hint,
  value,
  onChange,
  mentions,
  ws,
  rec,
  enabled,
  onSubmit,
  error,
  invalid,
  textareaRef,
  describedBy,
  initial,
  footer,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  value: string;
  onChange: (value: string, mentions?: Mention[]) => void;
  mentions: Mention[];
  ws: string;
  rec: string;
  /** False for people who may not name others (share-only guests, read-only): no picker at all. */
  enabled: boolean;
  /** Ctrl or Cmd + Enter. */
  onSubmit: () => void;
  error?: string | undefined;
  invalid?: boolean | undefined;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  describedBy?: string | undefined;
  initial?: boolean;
  footer?: ReactNode;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const ta = textareaRef ?? own;
  const listId = useId();
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [options, setOptions] = useState<Candidate[]>([]);
  const [settledFor, setSettled] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const caretAfter = useRef<number | null>(null);

  const update = (text: string, caret: number) => {
    const next = enabled ? detect(text, caret) : null;
    setTrigger((prev) =>
      prev?.start === next?.start && prev?.query === next?.query && prev?.end === next?.end
        ? prev
        : next,
    );
    if (!next) setDismissed(null);
  };

  useEffect(() => {
    if (!trigger || dismissed === tkey(trigger)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      collaboration.candidates(ws, rec, trigger.query, controller.signal).then(
        (list) => {
          if (controller.signal.aborted) return;
          setOptions(list);
          setFailed(false);
          setSettled(trigger.query);
          setActive(0);
        },
        () => {
          if (controller.signal.aborted) return;
          setOptions([]);
          setFailed(true);
          setSettled(trigger.query);
        },
      );
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trigger?.start, trigger?.query, dismissed, ws, rec]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (caretAfter.current !== null && ta.current) {
      ta.current.setSelectionRange(caretAfter.current, caretAfter.current);
      caretAfter.current = null;
    }
  });

  const settled = !!trigger && settledFor === trigger.query;
  const open = !!trigger && settled && dismissed !== tkey(trigger) && options.length > 0;
  const choose = (c: Candidate) => {
    if (!trigger) return;
    const insert = `@${c.name} `;
    const next = value.slice(0, trigger.start) + insert + value.slice(trigger.end);
    caretAfter.current = trigger.start + insert.length;
    onChange(next, [
      ...mentions.filter((m) => !(m.kind === c.kind && m.id === c.id)),
      { kind: c.kind, id: c.id, name: c.name },
    ]);
    setTrigger(null);
    setOptions([]);
    setSettled(null);
    ta.current?.focus();
  };

  const status = !trigger
    ? ''
    : open
      ? `${options.length} ${options.length === 1 ? 'suggestion' : 'suggestions'}. Use the up and down arrow keys, then Enter to choose. Escape closes the list.`
      : failed && settled
        ? "Couldn't load suggestions. You can keep typing without a mention."
        : settled && dismissed !== tkey(trigger)
          ? 'No one matches.'
          : '';

  const described = [hint ? `${id}-hint` : null, error ? `${id}-error` : null, describedBy]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={error || invalid ? 'field field-invalid' : 'field'}>
      <label htmlFor={id}>{label}</label>
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
      <textarea
        id={id}
        name={id}
        ref={ta}
        rows={4}
        data-initial={initial || undefined}
        value={value}
        aria-invalid={error || invalid ? true : undefined}
        aria-describedby={described || undefined}
        aria-autocomplete={enabled ? 'list' : undefined}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          update(e.target.value, e.target.selectionStart);
        }}
        onSelect={(e) => update(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => setDismissed(trigger ? tkey(trigger) : null)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            onSubmit();
            return;
          }
          if (!open) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setActive(
              (a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length,
            );
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            choose(options[active]!);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setDismissed(tkey(trigger!));
          }
        }}
      />
      {open ? (
        <ul role="listbox" id={listId} aria-label="Suggested mentions" className="mention-list">
          {options.map((o, i) => (
            <li
              key={`${o.kind}:${o.id}`}
              role="option"
              id={`${listId}-${i}`}
              aria-selected={i === active}
              className={i === active ? 'mention-option mention-option-active' : 'mention-option'}
              // Mouse down (not click) so the text box keeps focus and its caret.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(o);
              }}
            >
              <span>@{o.name}</span> <span className="hint">{KIND_LABEL[o.kind]}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="visually-hidden" role="status">
        {status}
      </p>
      {footer}
    </div>
  );
}

export const COUNT_LIMIT = COMMENT_MAX_CHARS;
