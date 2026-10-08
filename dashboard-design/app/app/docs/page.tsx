'use client';

/*
 * Docs (UX-PLAN.md, replaces Knowledge): doc tree grouped by brand on the left (search + type
 * filter), the open doc on the right with breadcrumb, owner, updated, status, approved-AI-source
 * toggle with a stale warning, body, linked records and a small versions list. One callout only:
 * docs that need review.
 */

import Link from 'next/link';
import { Fragment, useMemo, useState } from 'react';
import {
  ArrowUpRight, ChevronDown, ChevronRight, CircleCheck, FileCode, FilePlus, FileText, Gavel, Library, ListChecks, Megaphone, RotateCcw, Rocket,
  SearchX, Sparkles, TriangleAlert, Users,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { useApp } from '@/lib/app-state';
import { brandName, brands, type BrandId } from '@/lib/data';
import { byBrand, docs as seedDocs, personById, projectById, type Doc } from '@/lib/app-data';
import { BrandChip } from '@/components/brand';
import { Avatar, Badge, Button, Empty, PageHeader, SearchField, Segmented, StatusBadge, Toggle, ViewBar } from '@/components/paper/ui';
import { bodyFor, CITED, REVIEW, versionsFor, type Block, type Version } from './_lib/content';
import s from './docs.module.css';

type Status = Doc['status'];
type Tab = 'all' | 'review' | 'ai' | 'drafts';
type TypeFilter = 'all' | Doc['type'];
const TYPE_ICON = { Brief: Megaphone, SOP: ListChecks, Spec: FileCode, Decision: Gavel, Meeting: Users, 'Release notes': Rocket } as const;
const TYPES: Doc['type'][] = ['Brief', 'SOP', 'Spec', 'Decision', 'Meeting', 'Release notes'];
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export default function DocsPage() {
  const { brand } = useWorkspace();
  const { toast, openTask, tasks } = useApp();
  const [q, setQ] = useState('');
  const [type, setType] = useState<TypeFilter>('all');
  const [tab, setTab] = useState<Tab>('all');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [selId, setSelId] = useState('d2');
  const [over, setOver] = useState<Record<string, Partial<Doc> & { reviewed?: boolean }>>({});
  const [created, setCreated] = useState<Doc[]>([]);
  const [extra, setExtra] = useState<Record<string, Version[]>>({});
  const [restored, setRestored] = useState<Record<string, number>>({});

  const all = useMemo(() => byBrand([...created, ...seedDocs], brand).map((d) => ({ ...d, ...over[d.id] })), [brand, over, created]);
  const overdue = (d: Doc) => !!REVIEW[d.id]?.overdue && !over[d.id]?.reviewed;
  const needsReview = (d: Doc) => d.status !== 'Archived' && (d.status === 'Stale' || overdue(d));
  const staleAi = (d: Doc) => d.aiSource && needsReview(d);

  const inTab = (d: Doc) => tab === 'all' || (tab === 'review' ? needsReview(d) : tab === 'ai' ? d.aiSource : d.status === 'Draft');
  const visible = all.filter((d) => inTab(d) && (type === 'all' || d.type === type) && (!q || d.title.toLowerCase().includes(q.toLowerCase())));
  const sel = visible.find((d) => d.id === selId) ?? visible[0] ?? null;
  const review = all.filter(needsReview);
  const filtered = !!q || type !== 'all' || tab !== 'all';

  const patch = (id: string, x: Partial<Doc> & { reviewed?: boolean }) => setOver((o) => ({ ...o, [id]: { ...o[id], ...x } }));
  const clearFilters = () => { setQ(''); setType('all'); setTab('all'); };
  const newDoc = () => {
    const id = `new-${created.length + 1}`;
    const d: Doc = { id, brand, title: `Untitled doc ${created.length + 1}`, type: type === 'all' ? 'Brief' : type, status: 'Draft', owner: 'km', updated: 'now', aiSource: false, words: 0 };
    setCreated((c) => [d, ...c]);
    setQ(''); setTab('all'); setSelId(id);
    toast('Draft created from template');
  };
  const groups: { id: string; label: string; brand: BrandId | null }[] = [
    ...brands.filter((b) => !brand || b.id === brand).map((b) => ({ id: b.id, label: b.name, brand: b.id as BrandId | null })),
    { id: 'ws', label: 'Workspace', brand: null },
  ];
  const versions = sel ? [...(extra[sel.id] ?? []), ...versionsFor(sel)] : [];

  return (
    <>
      <PageHeader title="Docs" count={all.length} actions={<Button variant="dark" icon={<FilePlus size={15} />} onClick={newDoc}>New doc</Button>} />

      <ViewBar
        left={
          <Segmented<Tab> value={tab} onChange={setTab} options={[
            { id: 'all', label: 'All', count: all.length },
            { id: 'review', label: 'Needs review', count: review.length },
            { id: 'ai', label: 'AI sources', count: all.filter((d) => d.aiSource).length },
            { id: 'drafts', label: 'Drafts', count: all.filter((d) => d.status === 'Draft').length },
          ]} />
        }
        right={<span className={s.count}>{visible.length} of {all.length} docs</span>} />

      {review.length && tab !== 'review' ? (
        <section className={s.callout} role="status">
          <span className={s.cIcon}><TriangleAlert size={16} /></span>
          <b className={s.cTitle}>{review.length} {review.length === 1 ? 'doc needs' : 'docs need'} review</b>
          <span className={s.cBody}>
            {review.slice(0, 3).map((d) => (
              <button key={d.id} className={s.cChip} onClick={() => { clearFilters(); setSelId(d.id); }} title={`Open ${d.title}`}>
                {d.brand ? <BrandChip id={d.brand} size={18} /> : null}{d.title}{d.aiSource ? <em>AI source</em> : null}
              </button>
            ))}
          </span>
          <button className={s.cChip} onClick={() => setTab('review')}>Show all</button>
        </section>
      ) : null}

      <section className={s.main}>
        {/* ---------- tree ---------- */}
        <aside className={s.tree}>
          <SearchField placeholder="Search docs" value={q} onChange={setQ} />
          <label className={s.select}>
            <span className={s.selectLabel}>Type</span>
            <select value={type} onChange={(e) => setType(e.target.value as TypeFilter)} aria-label="Doc type">
              <option value="all">All types</option>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <ChevronDown size={14} />
          </label>

          {visible.length === 0 ? (
            <Empty icon={<SearchX size={18} />}>
              <span>No docs match{q ? ` “${q}”` : ' these filters'}.</span>
              <Button size="sm" variant="light" onClick={clearFilters}>Clear filters</Button>
            </Empty>
          ) : groups.map((g) => {
            const items = visible.filter((d) => d.brand === g.brand);
            if (!items.length) return null;
            const roots = items.filter((d) => !d.parent || !items.some((x) => x.id === d.parent));
            const isClosed = closed[g.id];
            return (
              <div key={g.id} className={s.group}>
                <button className={s.groupHead} onClick={() => setClosed((c) => ({ ...c, [g.id]: !c[g.id] }))} aria-expanded={!isClosed}>
                  {isClosed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  {g.brand ? <BrandChip id={g.brand} size={18} /> : <span className={s.wsIcon}><Library size={12} /></span>}
                  <span className={s.groupName}>{g.label}</span>
                  <em>{items.length}</em>
                </button>
                {!isClosed ? (
                  <div className={s.groupBody}>
                    {roots.map((d) => (
                      <Fragment key={d.id}>
                        <TreeItem d={d} on={sel?.id === d.id} warn={needsReview(d)} onClick={() => setSelId(d.id)} />
                        {items.filter((c) => c.parent === d.id).map((c) => (
                          <TreeItem key={c.id} d={c} nested on={sel?.id === c.id} warn={needsReview(c)} onClick={() => setSelId(c.id)} />
                        ))}
                      </Fragment>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </aside>

        {/* ---------- doc ---------- */}
        {sel ? (
          <article className={s.doc} key={sel.id}>
            <div className={s.docMain}>
              <nav className={s.crumbs} aria-label="Doc location">
                {sel.brand ? <BrandChip id={sel.brand} size={18} /> : <span className={s.wsIcon}><Library size={12} /></span>}
                <span>{sel.brand ? brandName(sel.brand) : 'Workspace'}</span>
                <span className={s.sep}>/</span>
                {sel.parent && all.some((d) => d.id === sel.parent) ? (
                  <>
                    <button onClick={() => setSelId(sel.parent!)}>{all.find((d) => d.id === sel.parent)?.title}</button>
                    <span className={s.sep}>/</span>
                  </>
                ) : null}
                <span>{sel.type}</span>
              </nav>
              <h2 className={s.title}>{sel.title}</h2>

              <div className={s.meta}>
                <span className={s.metaItem}><Avatar id={sel.owner} size={24} /><b>{personById(sel.owner)?.name}</b></span>
                <span className={s.metaItem}>Updated {sel.updated === 'now' ? 'just now' : `${sel.updated} ago`}</span>
                <span className={s.metaItem}>
                  Review by <b>{over[sel.id]?.reviewed ? '5 Nov' : REVIEW[sel.id]?.date ?? '—'}</b>
                  {overdue(sel) ? <Badge tone="red" dot>Overdue</Badge> : null}
                </span>
                <span className={s.metaItem}>{sel.words.toLocaleString('en-GB')} words</span>
              </div>

              <div className={s.controls}>
                <span className={s.ctl}>
                  <span className={s.ctlLabel}>Status</span>
                  <Segmented<Status> sub size="sm" value={sel.status} onChange={(v) => { patch(sel.id, { status: v }); toast(`Marked ${v.toLowerCase()}`); }}
                    options={(['Draft', 'Current', 'Stale', 'Archived'] as Status[]).map((x) => ({ id: x, label: x }))} />
                </span>
                <span className={cx(s.aiPill, sel.aiSource && s.aiOn)}>
                  <Sparkles size={14} />
                  <span>Approved AI source</span>
                  <Toggle label="Approved AI source" on={sel.aiSource} onChange={() => { patch(sel.id, { aiSource: !sel.aiSource }); toast(sel.aiSource ? 'Removed from AI context' : 'Approved for AI'); }} />
                </span>
              </div>

              {staleAi(sel) ? (
                <div className={s.warn} role="alert">
                  <span className={s.warnIcon}><TriangleAlert size={16} /></span>
                  <span className={s.warnText}>
                    <b>Agents are reading a stale doc</b>
                    <span>Cited {CITED[sel.id] ?? 0}× in the last 7 days. Review it or exclude it from AI context.</span>
                  </span>
                  <Button size="sm" variant="light" onClick={() => { patch(sel.id, { aiSource: false }); toast('Excluded from AI'); }}>Exclude</Button>
                  <Button size="sm" variant="dark" icon={<CircleCheck size={14} />} onClick={() => { patch(sel.id, { reviewed: true, status: 'Current' }); toast('Reviewed · next review 5 Nov'); }}>Mark reviewed</Button>
                </div>
              ) : null}

              <div className={s.prose}>
                {restored[sel.id] ? <div className={s.restoredNote}><RotateCcw size={13} /> Showing restored v{restored[sel.id]}</div> : null}
                {bodyFor(sel).map((b, i) => <BlockView key={i} b={b} />)}
              </div>

              <div className={s.links}>
                <span className={s.cap}>Linked</span>
                {sel.projectId && projectById(sel.projectId) ? (() => {
                  const pr = projectById(sel.projectId)!;
                  return (
                    <>
                      <Link href={`/app/projects/${pr.id}`} className={s.projLink}><BrandChip id={pr.brand} size={18} />{pr.name}<ArrowUpRight size={14} /></Link>
                      {tasks.filter((t) => t.projectId === pr.id).slice(0, 3).map((t) => (
                        <button key={t.id} className={s.taskLink} onClick={() => openTask(t.id)} title={`Open ${t.key}`}>
                          <span className={s.key}>{t.key}</span><span className={s.taskTitle}>{t.title}</span><StatusBadge status={t.status} />
                        </button>
                      ))}
                    </>
                  );
                })() : <span className={s.none}>Not linked to a project yet.</span>}
              </div>
            </div>

            {/* versions: a small side list */}
            <aside className={s.versions}>
              <span className={s.cap}>Versions · {versions.length}</span>
              {versions.map((v, i) => (
                <div key={`${v.v}-${v.note}-${i}`} className={i === 0 ? s.verOn : s.ver}>
                  <span className={s.verTop}><b>v{v.v}</b><span>{v.note}</span></span>
                  <span className={s.verMeta}>{personById(v.who)?.name.split(' ')[0]} · {v.when}</span>
                  {i === 0 ? <span className={s.verCurrent}>Current</span> : (
                    <button className={s.verRestore} onClick={() => {
                      const top = versions[0].v;
                      setExtra((x) => ({ ...x, [sel.id]: [{ v: top + 1, who: 'km', when: 'now', delta: 0, note: `Restored v${v.v}` }, ...(x[sel.id] ?? [])] }));
                      setRestored((r) => ({ ...r, [sel.id]: v.v }));
                      toast(`Restored v${v.v} as v${top + 1}`);
                    }}><RotateCcw size={12} />Restore</button>
                  )}
                </div>
              ))}
            </aside>
          </article>
        ) : (
          <div className={s.docEmpty}>
            <Empty icon={<FileText size={18} />}>
              <span>{filtered ? 'No doc matches these filters.' : 'No docs in this brand yet.'}</span>
              {filtered ? <Button size="sm" variant="light" onClick={clearFilters}>Clear filters</Button> : <Button size="sm" variant="dark" icon={<FilePlus size={14} />} onClick={newDoc}>New doc</Button>}
            </Empty>
          </div>
        )}
      </section>
    </>
  );
}

function TreeItem({ d, on, warn, nested, onClick }: { d: Doc; on: boolean; warn: boolean; nested?: boolean; onClick: () => void }) {
  const I = TYPE_ICON[d.type];
  return (
    <button className={cx(on ? s.itemOn : s.item, nested && s.nested, d.status === 'Archived' && s.archived)} onClick={onClick} title={`${d.title} · ${d.type} · ${d.status}${warn ? ' · needs review' : ''}`}>
      <I size={14} />
      <span className={s.itemTitle}>{d.title}</span>
      {d.aiSource ? <Sparkles size={12} className={s.itemAi} aria-label="AI source" /> : null}
      {warn ? <TriangleAlert size={13} className={s.itemWarn} aria-label="Needs review" /> : null}
    </button>
  );
}

function BlockView({ b }: { b: Block }) {
  switch (b.k) {
    case 'h': return <h3>{b.t}</h3>;
    case 'p': return <p>{b.t}</p>;
    case 'list': return <ul>{b.items.map((x) => <li key={x}>{x}</li>)}</ul>;
    case 'check': return <div className={s.checks}>{b.items.map(([x, done]) => <span key={x} className={done ? s.chkDone : s.chk}><i>{done ? '✓' : ''}</i>{x}</span>)}</div>;
    case 'code': return <pre className={s.code}>{b.t}</pre>;
    case 'quote': return <blockquote className={s.quote}>{b.t}</blockquote>;
    case 'table': return (
      <div className={s.tbl}>
        <table><thead><tr>{b.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{b.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c === 'Open' ? <Badge tone="red" dot>Open</Badge> : c === 'Fixed' ? <Badge tone="green" dot>Fixed</Badge> : c}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
}
