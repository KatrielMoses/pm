import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { ApiIssue } from '../api.ts';
import type { BlockType, CalloutTone, RefKind } from './client.ts';
import { documents, type Candidate } from './client.ts';
import { referenceToken, refKey } from './inline.ts';
import {
  BLOCK_LABEL,
  BLOCK_ORDER,
  TONE_LABEL,
  blankBlock,
  convert,
  newKey,
  type EditBlock,
} from './model.ts';

/**
 * The block editor (4C, ADR-0025 D2): an ordered list of blocks, each edited with native controls.
 * There is no rich-text engine: a block's text box holds the small inline syntax shown in the help
 * line. It is a controlled component; saving, drafts and conflicts live in session.tsx.
 */

export const INLINE_HELP =
  'Formatting: **bold**, *italic*, `code`, [text](https://address). Type @ to mention a person, team, task, project, or document.';

const RECORD_KIND: Record<string, RefKind> = { tsk: 'task', prj: 'project', doc: 'document' };

/** The reference a mention candidate stands for, or null when it can't be linked here. */
export function candidateRef(c: Candidate): { kind: RefKind; id: string; label: string } | null {
  if (c.kind === 'member') return { kind: 'member', id: c.id, label: `@${c.name}` };
  if (c.kind === 'team') return { kind: 'team', id: c.id, label: `@${c.name}` };
  const kind = RECORD_KIND[c.id.split('_')[0]!.toLowerCase()];
  return kind ? { kind, id: c.id, label: c.name } : null;
}

const KIND_NOUN: Record<string, string> = {
  member: 'Person',
  team: 'Team',
  task: 'Task',
  project: 'Project',
  document: 'Document',
};

interface Trigger {
  start: number;
  end: number;
  query: string;
}
const detect = (text: string, caret: number): Trigger | null => {
  const m = /(^|\s)@([^\s@]{0,40})$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2]!.length - 1, end: caret, query: m[2]! } : null;
};

/**
 * A text box for inline text with an @ picker (listbox pattern: Arrow keys move, Enter or Tab
 * chooses, Escape closes). Choosing writes the reference token into the text, so what is saved is
 * exactly what was picked.
 */
export function InlineTextarea({
  id,
  label,
  value,
  onChange,
  ws,
  doc,
  mentions,
  onLabel,
  rows,
  labelHidden = false,
  describedBy,
  invalid = false,
  onSubmit,
  readOnly = false,
  dataRole,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  ws: string;
  doc: string;
  /** False where the picker isn't offered (nothing to mention with). */
  mentions: boolean;
  onLabel: (key: string, label: string) => void;
  rows?: number;
  labelHidden?: boolean;
  describedBy?: string | undefined;
  invalid?: boolean;
  onSubmit?: () => void;
  readOnly?: boolean;
  dataRole?: string;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [options, setOptions] = useState<Array<{ c: Candidate; ref: NonNullable<ReturnType<typeof candidateRef>> }>>([]);
  const [settledFor, setSettled] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const caretAfter = useRef<number | null>(null);
  const tkey = (t: Trigger) => `${t.start}:${t.query}`;

  const update = (text: string, caret: number) => {
    const next = mentions && !readOnly ? detect(text, caret) : null;
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
      documents.candidates(ws, doc, trigger.query, controller.signal).then(
        (list) => {
          if (controller.signal.aborted) return;
          setOptions(
            list.flatMap((c) => {
              const ref = candidateRef(c);
              return ref ? [{ c, ref }] : [];
            }),
          );
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
  }, [trigger?.start, trigger?.query, dismissed, ws, doc]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (caretAfter.current !== null && ta.current) {
      ta.current.setSelectionRange(caretAfter.current, caretAfter.current);
      caretAfter.current = null;
    }
  });

  const settled = !!trigger && settledFor === trigger.query;
  const open = !!trigger && settled && dismissed !== tkey(trigger) && options.length > 0;
  const choose = (o: (typeof options)[number]) => {
    if (!trigger) return;
    const insert = `${referenceToken(o.ref.label, o.ref.kind, o.ref.id)} `;
    caretAfter.current = trigger.start + insert.length;
    onLabel(refKey(o.ref.kind, o.ref.id), o.ref.label);
    onChange(value.slice(0, trigger.start) + insert + value.slice(trigger.end));
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
  const lines = rows ?? Math.min(12, Math.max(2, value.split('\n').length + 1));
  return (
    <div className="field doc-inline">
      <label htmlFor={id} className={labelHidden ? 'visually-hidden' : undefined}>
        {label}
      </label>
      <textarea
        id={id}
        ref={ta}
        rows={lines}
        value={value}
        readOnly={readOnly}
        data-role={dataRole}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        aria-autocomplete={mentions ? 'list' : undefined}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          update(e.target.value, e.target.selectionStart);
        }}
        onSelect={(e) => update(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => setDismissed(trigger ? tkey(trigger) : null)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && onSubmit) {
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
              key={`${o.ref.kind}:${o.ref.id}`}
              role="option"
              id={`${listId}-${i}`}
              aria-selected={i === active}
              className={i === active ? 'mention-option mention-option-active' : 'mention-option'}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(o);
              }}
            >
              <span>{o.ref.kind === 'member' || o.ref.kind === 'team' ? o.ref.label : o.c.name}</span>{' '}
              <span className="hint">{KIND_NOUN[o.ref.kind]}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="visually-hidden" role="status">
        {status}
      </p>
    </div>
  );
}

/** A menu button with a list of block kinds (menu pattern: arrows, Home/End, Enter, Escape). */
function AddMenu({
  label,
  onPick,
  describedBy,
}: {
  label: string;
  onPick: (t: BlockType) => void;
  describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const key = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else if (e.key === 'Tab') setOpen(false);
  };
  return (
    <div className="doc-add">
      <button
        type="button"
        ref={button}
        className="button button-secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-describedby={describedBy}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {label}
      </button>
      {open ? (
        <ul role="menu" id={id} ref={list} aria-label={label} className="doc-menu" onKeyDown={key}>
          {BLOCK_ORDER.map((t) => (
            <li key={t} role="none">
              <button
                type="button"
                role="menuitem"
                className="doc-menu-item"
                onClick={() => {
                  setOpen(false);
                  onPick(t);
                }}
              >
                {BLOCK_LABEL[t]}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const ISSUE_COPY: Record<string, string> = {
  too_long: 'This is too long. Shorten it.',
  too_many: 'There are too many here. Remove some.',
  invalid_url: "That address isn't valid. Use a full https:// address.",
  unsupported_embed: "That can't be embedded. Files can't be embedded yet; use an https address.",
  duplicate_block_id: 'Two blocks share an identifier. Reload the document.',
  ragged_table: 'Every table row needs the same number of cells.',
};

export function IssueList({ issues, id }: { issues: ApiIssue[]; id: string }) {
  if (!issues.length) return null;
  return (
    <ul className="doc-issues" id={id} role="alert">
      {issues.map((i, n) => (
        <li key={n} className="field-error">
          <span aria-hidden="true">! </span>
          {ISSUE_COPY[i.code] ?? i.message}
          {ISSUE_COPY[i.code] && i.message && i.message !== ISSUE_COPY[i.code] ? ` ${i.message}` : ''}
        </li>
      ))}
    </ul>
  );
}

interface BlockProps {
  ws: string;
  doc: string;
  block: EditBlock;
  index: number;
  count: number;
  idBase: string;
  issues: ApiIssue[];
  single: boolean;
  actions: Actions;
}

interface Actions {
  change: (b: EditBlock) => void;
  move: (key: string, dir: -1 | 1) => void;
  remove: (key: string) => void;
  addBelow: (key: string, t: BlockType) => void;
  label: (key: string, label: string) => void;
  submit: () => void;
}

/** Re-renders only the block that changed (long documents stay responsive while typing). */
const BlockCard = memo(BlockCardView, (a, b) =>
  a.block === b.block &&
  a.index === b.index &&
  a.count === b.count &&
  a.idBase === b.idBase &&
  a.single === b.single &&
  a.ws === b.ws &&
  a.doc === b.doc &&
  a.issues === b.issues &&
  a.actions === b.actions,
);

function BlockCardView(rawProps: BlockProps) {
  const a = rawProps.actions;
  const p = {
    ...rawProps,
    onChange: a.change,
    onMove: (d: -1 | 1) => a.move(rawProps.block.key, d),
    onDelete: () => a.remove(rawProps.block.key),
    onAddBelow: (t: BlockType) => a.addBelow(rawProps.block.key, t),
    onLabel: a.label,
    onSubmit: a.submit,
  };
  const { block: b, idBase } = p;
  const bid = `${idBase}-${b.key}`;
  const issueId = `${bid}-issues`;
  const nameId = `${bid}-name`;
  const set = (patch: Partial<EditBlock>) => p.onChange({ ...b, ...patch } as EditBlock);
  const inlineProps = {
    ws: p.ws,
    doc: p.doc,
    mentions: true,
    onLabel: p.onLabel,
    onSubmit: p.onSubmit,
    describedBy: [`${idBase}-help`, p.issues.length ? issueId : null].filter(Boolean).join(' '),
    invalid: p.issues.length > 0,
  };
  const name = `${BLOCK_LABEL[b.type]}`;
  return (
    <li className="doc-block" data-block-key={b.key} data-block-type={b.type}>
      <div role="group" aria-labelledby={nameId} className="doc-block-box">
        <div className="doc-block-head">
          <p className="doc-block-name" id={nameId}>
            {p.single ? name : `Block ${p.index + 1} of ${p.count}: ${name}`}
          </p>
          {p.single ? null : (
            <div className="doc-block-tools">
              <button
                type="button"
                className="button button-ghost"
                data-role="up"
                disabled={p.index === 0}
                onClick={() => p.onMove(-1)}
              >
                Move up{' '}<span className="visually-hidden">block {p.index + 1}</span>
              </button>
              <button
                type="button"
                className="button button-ghost"
                data-role="down"
                disabled={p.index === p.count - 1}
                onClick={() => p.onMove(1)}
              >
                Move down{' '}<span className="visually-hidden">block {p.index + 1}</span>
              </button>
              {b.type === 'paragraph' ? (
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => p.onChange(convert(b, 'heading'))}
                >
                  Make heading{' '}<span className="visually-hidden">block {p.index + 1}</span>
                </button>
              ) : null}
              {b.type === 'heading' ? (
                <button
                  type="button"
                  className="button button-ghost"
                  onClick={() => p.onChange(convert(b, 'paragraph'))}
                >
                  Make paragraph{' '}<span className="visually-hidden">block {p.index + 1}</span>
                </button>
              ) : null}
              <button type="button" className="button button-ghost" data-role="delete" onClick={p.onDelete}>
                Delete{' '}<span className="visually-hidden">block {p.index + 1}</span>
              </button>
            </div>
          )}
        </div>
        {b.type === 'paragraph' || b.type === 'quote' ? (
          <InlineTextarea
            id={`${bid}-text`}
            label={`${name} text`}
            labelHidden
            value={b.text}
            onChange={(text) => set({ text })}
            dataRole="primary"
            {...inlineProps}
          />
        ) : null}
        {b.type === 'heading' ? (
          <>
            <div className="field doc-inline-small">
              <label htmlFor={`${bid}-level`}>Heading level</label>
              <select
                id={`${bid}-level`}
                value={b.level}
                onChange={(e) => set({ level: Number(e.target.value) as 1 | 2 | 3 })}
              >
                <option value={1}>Level 1 (largest)</option>
                <option value={2}>Level 2</option>
                <option value={3}>Level 3</option>
              </select>
            </div>
            <InlineTextarea
              id={`${bid}-text`}
              label="Heading text"
              labelHidden
              rows={1}
              value={b.text}
              onChange={(text) => set({ text })}
              dataRole="primary"
              {...inlineProps}
            />
          </>
        ) : null}
        {b.type === 'callout' ? (
          <>
            <div className="field doc-inline-small">
              <label htmlFor={`${bid}-tone`}>Callout style</label>
              <select
                id={`${bid}-tone`}
                value={b.tone}
                onChange={(e) => set({ tone: e.target.value as CalloutTone })}
              >
                {(Object.keys(TONE_LABEL) as CalloutTone[]).map((t) => (
                  <option key={t} value={t}>
                    {TONE_LABEL[t]}
                  </option>
                ))}
              </select>
            </div>
            <InlineTextarea
              id={`${bid}-text`}
              label="Callout text"
              labelHidden
              value={b.text}
              onChange={(text) => set({ text })}
              dataRole="primary"
              {...inlineProps}
            />
          </>
        ) : null}
        {b.type === 'bulleted_list' || b.type === 'numbered_list' ? (
          <InlineTextarea
            id={`${bid}-text`}
            label={`${name}: one item per line`}
            value={b.text}
            onChange={(text) => set({ text })}
            dataRole="primary"
            {...inlineProps}
          />
        ) : null}
        {b.type === 'checklist' ? (
          <ChecklistEditor block={b} bid={bid} onChange={p.onChange} />
        ) : null}
        {b.type === 'code' ? (
          <>
            <div className="field doc-inline-small">
              <label htmlFor={`${bid}-lang`}>Language (optional)</label>
              <input
                id={`${bid}-lang`}
                value={b.language}
                maxLength={40}
                autoComplete="off"
                onChange={(e) => set({ language: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor={`${bid}-code`}>Code</label>
              <textarea
                id={`${bid}-code`}
                className="doc-code-input"
                rows={Math.min(16, Math.max(4, b.text.split('\n').length + 1))}
                value={b.text}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                data-role="primary"
                aria-describedby={p.issues.length ? issueId : undefined}
                aria-invalid={p.issues.length ? true : undefined}
                onChange={(e) => set({ text: e.target.value })}
              />
            </div>
          </>
        ) : null}
        {b.type === 'table' ? <TableEditor block={b} onChange={p.onChange} issueId={p.issues.length ? issueId : undefined} /> : null}
        {b.type === 'divider' ? (
          <p className="hint" data-role="primary" tabIndex={-1}>
            A dividing line. It has nothing to edit.
          </p>
        ) : null}
        {b.type === 'embed' ? (
          <div className="doc-embed-form">
            <div className="field doc-inline-small">
              <label htmlFor={`${bid}-kind`}>Kind</label>
              <select
                id={`${bid}-kind`}
                value={b.kind}
                data-role="primary"
                onChange={(e) => set({ kind: e.target.value as 'image' | 'video' | 'link' })}
              >
                <option value="link">Link</option>
                <option value="image">Image (by address)</option>
                <option value="video">Video (by address)</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${bid}-url`}>Address (https://…)</label>
              <input
                id={`${bid}-url`}
                type="url"
                inputMode="url"
                value={b.url}
                autoComplete="off"
                aria-describedby={p.issues.length ? issueId : undefined}
                aria-invalid={p.issues.length ? true : undefined}
                onChange={(e) => set({ url: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor={`${bid}-title`}>Title (optional)</label>
              <input
                id={`${bid}-title`}
                value={b.title}
                maxLength={200}
                onChange={(e) => set({ title: e.target.value })}
              />
            </div>
            {b.kind !== 'link' ? (
              <div className="field">
                <label htmlFor={`${bid}-alt`}>
                  {b.kind === 'image' ? 'Describe the image' : 'Describe the video'}
                </label>
                <p className="hint" id={`${bid}-alt-hint`}>
                  Say what it shows, for people who can't see it. Leave empty only if it adds
                  nothing.
                </p>
                <input
                  id={`${bid}-alt`}
                  value={b.alt}
                  maxLength={500}
                  aria-describedby={`${bid}-alt-hint`}
                  onChange={(e) => set({ alt: e.target.value })}
                />
              </div>
            ) : null}
            <p className="hint">
              It shows as a link card; nothing is loaded from that address. Files can't be embedded
              yet.
            </p>
          </div>
        ) : null}
        <IssueList issues={p.issues} id={issueId} />
        {p.single ? null : <AddMenu label="Add block below" onPick={p.onAddBelow} describedBy={nameId} />}
      </div>
    </li>
  );
}

function ChecklistEditor({
  block,
  bid,
  onChange,
}: {
  block: Extract<EditBlock, { type: 'checklist' }>;
  bid: string;
  onChange: (b: EditBlock) => void;
}) {
  const focusItem = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (focusItem.current) {
      document.getElementById(`${bid}-i-${focusItem.current}`)?.focus();
      focusItem.current = null;
    }
  });
  const setItems = (items: typeof block.items) => onChange({ ...block, items });
  return (
    <div className="doc-checklist">
      <p className="hint" id={`${bid}-chk-help`}>
        One line per item. Press Enter in an item to add the next one.
      </p>
      <ul className="plain-list">
        {block.items.map((it, n) => (
          <li key={it.key} className="doc-check-row">
            <input
              type="checkbox"
              checked={it.checked}
              aria-label={`Item ${n + 1} done`}
              onChange={(e) =>
                setItems(block.items.map((x) => (x.key === it.key ? { ...x, checked: e.target.checked } : x)))
              }
            />
            <input
              id={`${bid}-i-${it.key}`}
              className="doc-check-text"
              value={it.text}
              aria-label={`Item ${n + 1} text`}
              aria-describedby={`${bid}-chk-help`}
              data-role={n === 0 ? 'primary' : undefined}
              autoComplete="off"
              onChange={(e) =>
                setItems(block.items.map((x) => (x.key === it.key ? { ...x, text: e.target.value } : x)))
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const k = newKey();
                  focusItem.current = k;
                  const at = block.items.findIndex((x) => x.key === it.key);
                  const next = [...block.items];
                  next.splice(at + 1, 0, { key: k, text: '', checked: false });
                  setItems(next);
                }
              }}
            />
            <button
              type="button"
              className="button button-ghost"
              disabled={block.items.length <= 1}
              onClick={() => {
                const rest = block.items.filter((x) => x.key !== it.key);
                focusItem.current = (rest[Math.max(0, n - 1)] ?? rest[0])?.key ?? null;
                setItems(rest);
              }}
            >
              Remove{' '}<span className="visually-hidden">item {n + 1}</span>
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="button button-secondary"
        onClick={() => {
          const k = newKey();
          focusItem.current = k;
          setItems([...block.items, { key: k, text: '', checked: false }]);
        }}
      >
        Add item
      </button>
    </div>
  );
}

function TableEditor({
  block,
  onChange,
  issueId,
}: {
  block: Extract<EditBlock, { type: 'table' }>;
  onChange: (b: EditBlock) => void;
  issueId: string | undefined;
}) {
  const cols = block.rows[0]?.length ?? 1;
  const cell = (r: number, c: number, v: string) =>
    onChange({ ...block, rows: block.rows.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : row)) });
  return (
    <div className="doc-table-editor">
      <label className="choice">
        <input
          type="checkbox"
          checked={block.header}
          onChange={(e) => onChange({ ...block, header: e.target.checked })}
        />
        The first row is a header
      </label>
      <div className="doc-table-scroll">
        <table className="doc-table-grid" aria-describedby={issueId}>
          <caption className="visually-hidden">Table cells. Each cell is a text box.</caption>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r}>
                {row.map((v, c) => (
                  <td key={c}>
                    <input
                      value={v}
                      aria-label={
                        block.header && r === 0 ? `Header, column ${c + 1}` : `Row ${r + 1}, column ${c + 1}`
                      }
                      data-role={r === 0 && c === 0 ? 'primary' : undefined}
                      autoComplete="off"
                      onChange={(e) => cell(r, c, e.target.value)}
                    />
                  </td>
                ))}
                <td>
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={block.rows.length <= 1}
                    onClick={() => onChange({ ...block, rows: block.rows.filter((_x, i) => i !== r) })}
                  >
                    Remove{' '}<span className="visually-hidden">row {r + 1}</span>
                  </button>
                </td>
              </tr>
            ))}
            <tr>
              {Array.from({ length: cols }, (_x, c) => (
                <td key={c}>
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={cols <= 1}
                    onClick={() => onChange({ ...block, rows: block.rows.map((row) => row.filter((_y, j) => j !== c)) })}
                  >
                    Remove{' '}<span className="visually-hidden">column {c + 1}</span>
                  </button>
                </td>
              ))}
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <div className="actions">
        <button
          type="button"
          className="button button-secondary"
          onClick={() => onChange({ ...block, rows: [...block.rows, Array.from({ length: cols }, () => '')] })}
        >
          Add row
        </button>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => onChange({ ...block, rows: block.rows.map((row) => [...row, '']) })}
        >
          Add column
        </button>
      </div>
    </div>
  );
}

export interface BlockEditorProps {
  ws: string;
  doc: string;
  blocks: EditBlock[];
  onChange: (next: EditBlock[]) => void;
  issues?: Map<number, ApiIssue[]>;
  onLabel: (key: string, label: string) => void;
  onSubmit: () => void;
  /** One block only: no moving, adding, or deleting (a suggestion edits a single block). */
  single?: boolean;
  idBase?: string;
}

/** A polite line telling what just happened to the blocks (add, move, delete). */
const EMPTY: ApiIssue[] = [];

export function BlockEditor(p: BlockEditorProps) {
  const auto = useId();
  const idBase = p.idBase ?? `blk${auto.replace(/:/g, '')}`;
  const [said, setSaid] = useState('');
  const [undo, setUndo] = useState<{ block: EditBlock; index: number } | null>(null);
  const focusReq = useRef<{ key: string; role: string } | null>(null);
  const addButton = useRef<HTMLDivElement>(null);
  const issues = p.issues ?? new Map<number, ApiIssue[]>();
  const [limit, setLimit] = useState(200);

  useLayoutEffect(() => {
    const req = focusReq.current;
    if (!req) return;
    focusReq.current = null;
    const root = document.querySelector<HTMLElement>(`[data-block-key="${req.key}"]`);
    const target =
      root?.querySelector<HTMLElement>(`[data-role="${req.role}"]:not([disabled])`) ??
      root?.querySelector<HTMLElement>('[data-role="primary"]') ??
      root?.querySelector<HTMLElement>('button:not([disabled]), input, textarea, select');
    target?.focus();
  });

  const live = useRef(p);
  useEffect(() => {
    live.current = p;
  });
  const actions = useMemo<Actions>(() => {
    const cur = () => live.current;
    const indexOf = (key: string) => cur().blocks.findIndex((b) => b.key === key);
    const insertAt = (at: number, type: BlockType) => {
      const nb = blankBlock(type);
      const next = [...cur().blocks];
      next.splice(at, 0, nb);
      focusReq.current = { key: nb.key, role: 'primary' };
      setUndo(null);
      setSaid(`Added ${BLOCK_LABEL[type]} as block ${at + 1} of ${next.length}.`);
      setLimit((l) => Math.max(l, at + 1));
      cur().onChange(next);
    };
    return {
      change: (nb) => cur().onChange(cur().blocks.map((x) => (x.key === nb.key ? nb : x))),
      label: (k, l) => cur().onLabel(k, l),
      submit: () => cur().onSubmit(),
      addBelow: (key, t) => insertAt(indexOf(key) + 1, t),
      move: (key, dir) => {
        const i = indexOf(key);
        const j = i + dir;
        const blocks = cur().blocks;
        if (i < 0 || j < 0 || j >= blocks.length) return;
        const next = [...blocks];
        [next[i], next[j]] = [next[j]!, next[i]!];
        // Focus stays on the control that was used, unless it can't move that way any more.
        const stays = dir === -1 ? j > 0 : j < next.length - 1;
        focusReq.current = {
          key,
          role: stays ? (dir === -1 ? 'up' : 'down') : dir === -1 ? 'down' : 'up',
        };
        setUndo(null);
        setSaid(`Moved ${BLOCK_LABEL[next[j]!.type]} to position ${j + 1} of ${next.length}.`);
        cur().onChange(next);
      },
      remove: (key) => {
        const i = indexOf(key);
        if (i < 0) return;
        const gone = cur().blocks[i]!;
        const next = cur().blocks.filter((_b, n) => n !== i);
        const neighbour = next[Math.min(i, next.length - 1)];
        focusReq.current = neighbour ? { key: neighbour.key, role: 'delete' } : null;
        setUndo({ block: gone, index: i });
        setSaid(`Deleted block ${i + 1}, ${BLOCK_LABEL[gone.type]}. You can undo this.`);
        cur().onChange(next);
        if (!neighbour) addButton.current?.querySelector('button')?.focus();
      },
    };
  }, []);
  const insertEnd = (t: BlockType) => {
    const nb = blankBlock(t);
    focusReq.current = { key: nb.key, role: 'primary' };
    setUndo(null);
    setSaid(`Added ${BLOCK_LABEL[t]} as block ${p.blocks.length + 1} of ${p.blocks.length + 1}.`);
    setLimit((l) => Math.max(l, p.blocks.length + 1));
    p.onChange([...p.blocks, nb]);
  };
  const undoDelete = () => {
    if (!undo) return;
    const next = [...p.blocks];
    next.splice(Math.min(undo.index, next.length), 0, undo.block);
    focusReq.current = { key: undo.block.key, role: 'primary' };
    setSaid(`Restored block ${undo.index + 1}, ${BLOCK_LABEL[undo.block.type]}.`);
    setLimit((l) => Math.max(l, undo.index + 1));
    setUndo(null);
    p.onChange(next);
  };
  const shown = p.blocks.slice(0, limit);

  return (
    <div className="doc-editor">
      <p className="hint" id={`${idBase}-help`}>
        {INLINE_HELP}
      </p>
      {p.blocks.length === 0 ? (
        <p className="empty doc-empty">This page has no content yet. Add a block to start.</p>
      ) : null}
      <ol className="doc-blocks" aria-label="Document blocks">
        {shown.map((b, i) => (
          <BlockCard
            key={b.key}
            ws={p.ws}
            doc={p.doc}
            block={b}
            index={i}
            count={p.blocks.length}
            idBase={idBase}
            issues={issues.get(i) ?? EMPTY}
            single={!!p.single}
            actions={actions}
          />
        ))}
      </ol>
      {p.blocks.length > limit ? (
        <p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setLimit((l) => l + 200)}
          >
            Show {Math.min(200, p.blocks.length - limit)} more blocks ({p.blocks.length - limit} not shown)
          </button>
        </p>
      ) : null}
      {undo ? (
        <div className="doc-undo" role="status">
          <span>
            Deleted block {undo.index + 1} ({BLOCK_LABEL[undo.block.type]}).
          </span>{' '}
          <button type="button" className="button button-secondary" onClick={undoDelete}>
            Undo delete
          </button>
        </div>
      ) : null}
      {p.single ? null : (
        <div ref={addButton}>
          <AddMenu label="Add block" onPick={insertEnd} />
        </div>
      )}
      <p className="visually-hidden" role="status" aria-live="polite">
        {said}
      </p>
    </div>
  );
}
