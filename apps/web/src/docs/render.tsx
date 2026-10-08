import { Fragment, useState, type ReactNode } from 'react';
import { Link } from '../router.tsx';
import type { Block, DocContent, References, Run } from './client.ts';
import { RESTRICTED_LABEL, plain, refKey } from './inline.ts';
import { TONE_LABEL } from './model.ts';

/**
 * Read-only rendering of a document (viewers without edit, an old version, an archived page).
 * Semantic and accessible: real headings, lists, tables with header cells, code with its language
 * named, callouts with a text label (never colour alone), and links with safe `rel`. A reference
 * the viewer can't read is a neutral "Restricted item" token: no title, type, icon, or identifier
 * (IA-46), and nothing from an unresolved reference reaches the page.
 */

const safeHref = (url: string): string | null =>
  /^(https:\/\/|http:\/\/|mailto:)/i.test(url) ? url : null;

export const REL = 'noopener noreferrer nofollow';

export function RestrictedToken() {
  return <span className="doc-restricted">{RESTRICTED_LABEL}</span>;
}

export function Runs({ runs, refs }: { runs: readonly Run[]; refs: References }) {
  return (
    <>
      {runs.map((r, i) => {
        if ('ref' in r) {
          const e = r.ref.kind === 'restricted' ? undefined : refs[refKey(r.ref.kind, r.ref.id)];
          if (!e) return <RestrictedToken key={i} />;
          return e.path ? (
            <Link key={i} className="mention" to={e.path}>
              {e.label}
            </Link>
          ) : (
            <span key={i} className="mention">
              {e.label}
            </span>
          );
        }
        let node: ReactNode = r.text;
        if (r.code) node = <code>{node}</code>;
        if (r.italic) node = <em>{node}</em>;
        if (r.bold) node = <strong>{node}</strong>;
        const href = r.link ? safeHref(r.link) : null;
        if (href)
          node = (
            <a href={href} target="_blank" rel={REL}>
              {node}
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          );
        return <Fragment key={i}>{node}</Fragment>;
      })}
    </>
  );
}

const HEADING = { 1: 'h2', 2: 'h3', 3: 'h4' } as const;

export function BlockView({ block, refs, id }: { block: Block; refs: References; id: string }) {
  switch (block.type) {
    case 'paragraph':
      return (
        <p className="doc-p">
          <Runs runs={block.runs} refs={refs} />
        </p>
      );
    case 'heading': {
      const H = HEADING[block.level];
      return (
        <H className="doc-h">
          <Runs runs={block.runs} refs={refs} />
        </H>
      );
    }
    case 'quote':
      return (
        <blockquote className="doc-quote">
          <p>
            <Runs runs={block.runs} refs={refs} />
          </p>
        </blockquote>
      );
    case 'callout':
      return (
        <aside className={`doc-callout doc-callout-${block.tone}`} aria-labelledby={`${id}-tone`}>
          <p className="doc-callout-label" id={`${id}-tone`}>
            {TONE_LABEL[block.tone]}
          </p>
          <p>
            <Runs runs={block.runs} refs={refs} />
          </p>
        </aside>
      );
    case 'bulleted_list':
      return (
        <ul className="doc-list">
          {block.items.map((it, i) => (
            <li key={i}>
              <Runs runs={it} refs={refs} />
            </li>
          ))}
        </ul>
      );
    case 'numbered_list':
      return (
        <ol className="doc-list">
          {block.items.map((it, i) => (
            <li key={i}>
              <Runs runs={it} refs={refs} />
            </li>
          ))}
        </ol>
      );
    case 'checklist':
      return (
        <ul className="doc-checklist-view plain-list">
          {block.items.map((it, i) => (
            <li key={i} className="doc-check-view">
              <span
                role="checkbox"
                aria-checked={it.checked}
                aria-readonly="true"
                aria-labelledby={`${id}-c${i}`}
                className="doc-checkbox"
              >
                <span aria-hidden="true">{it.checked ? '☑' : '☐'}</span>
              </span>{' '}
              <span id={`${id}-c${i}`} className={it.checked ? 'doc-done' : undefined}>
                <Runs runs={it.runs} refs={refs} />
              </span>
              <span className="visually-hidden">{it.checked ? ' (done)' : ' (not done)'}</span>
            </li>
          ))}
        </ul>
      );
    case 'code':
      return (
        <figure className="doc-code">
          <figcaption>{block.language ? `Code (${block.language})` : 'Code'}</figcaption>
          <pre tabIndex={0}>
            <code>{block.text}</code>
          </pre>
        </figure>
      );
    case 'table':
      return (
        <div className="doc-table-scroll" role="region" aria-label="Table" tabIndex={0}>
          <table className="doc-table">
            {block.header && block.rows[0] ? (
              <thead>
                <tr>
                  {block.rows[0].map((c, i) => (
                    <th key={i} scope="col">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
            ) : null}
            <tbody>
              {(block.header ? block.rows.slice(1) : block.rows).map((row, r) => (
                <tr key={r}>
                  {row.map((c, i) => (
                    <td key={i}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'divider':
      return <hr className="doc-hr" />;
    case 'embed': {
      const href = safeHref(block.url);
      const kind = { image: 'Image link', video: 'Video link', link: 'Link' }[block.kind];
      return (
        <div className="doc-embed">
          <p className="doc-embed-kind">{kind}</p>
          <p className="doc-embed-title">
            {href ? (
              <a href={href} target="_blank" rel={REL}>
                {block.title || block.url}
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
            ) : (
              block.title || block.url
            )}
          </p>
          {block.title ? <p className="hint doc-embed-url">{block.url}</p> : null}
          {block.alt ? <p className="hint">Description: {block.alt}</p> : null}
          <p className="hint">Shown as a link. Nothing is loaded from that address.</p>
        </div>
      );
    }
  }
}

/** A readable summary of one block for a list (a suggestion's current and proposed text). */
export function blockSummary(b: Block, refs: References): string {
  switch (b.type) {
    case 'paragraph':
    case 'quote':
    case 'heading':
    case 'callout':
      return plain(b.runs, refs);
    case 'bulleted_list':
    case 'numbered_list':
      return b.items.map((i) => plain(i, refs)).join('; ');
    case 'checklist':
      return b.items.map((i) => `${i.checked ? '[x]' : '[ ]'} ${plain(i.runs, refs)}`).join('; ');
    case 'code':
      return b.text;
    case 'table':
      return b.rows.map((r) => r.join(' | ')).join('; ');
    case 'divider':
      return '(dividing line)';
    case 'embed':
      return `${b.title ?? b.kind} ${b.url}`;
  }
}

const SHOW_STEP = 150;

export function DocView({
  content,
  refs,
  idBase = 'dv',
  suggest,
  label = 'Document content',
}: {
  content: DocContent;
  refs: References;
  idBase?: string;
  /** "Suggest a change" for people who may comment but not edit. */
  suggest?: (block: Block, index: number) => void;
  label?: string;
}) {
  const [limit, setLimit] = useState(SHOW_STEP);
  const blocks = content.blocks;
  if (blocks.length === 0)
    return <p className="empty doc-empty">This page has no content yet.</p>;
  return (
    <div className="doc-view" role="region" aria-label={label}>
      {blocks.slice(0, limit).map((b, i) => (
        <div key={b.id ?? i} className="doc-view-block" data-block-id={b.id}>
          <BlockView block={b} refs={refs} id={`${idBase}-${i}`} />
          {suggest && b.id && b.type !== 'divider' ? (
            <button
              type="button"
              className="button button-ghost doc-suggest"
              onClick={() => suggest(b, i)}
            >
              Suggest a change{' '}<span className="visually-hidden">to block {i + 1}</span>
            </button>
          ) : null}
        </div>
      ))}
      {blocks.length > limit ? (
        <p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setLimit((l) => l + SHOW_STEP)}
          >
            Show more ({blocks.length - limit} blocks not shown)
          </button>
        </p>
      ) : null}
    </div>
  );
}
