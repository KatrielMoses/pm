'use client';

/* Projects: one list of projects with health. Health tabs left; List / Cards + search right. Row → project. */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { FolderPlus, LayoutGrid, List, Plus, SearchX } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { personById } from '@/lib/app-data';
import { brandName, type Health, type Project } from '@/lib/data';
import { BrandChip } from '@/components/brand';
import { Avatar, Button, Empty, HealthBadge, PageHeader, SearchField, Segmented, Thin, ViewBar, u } from '@/components/paper/ui';
import { metaFor } from './_lib/meta';
import { CreateProject } from './create';
import s from './projects.module.css';

type HF = 'all' | Health;
type Layout = 'list' | 'cards';
const healthRank: Record<Health, number> = { off: 0, risk: 1, on: 2 };

export default function Projects() {
  const { s: d, brand } = useWorkspace();
  const router = useRouter();
  const [hf, setHf] = useState<HF>('all');
  const [layout, setLayout] = useState<Layout>('list');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);

  const base = d.projects;
  const rows = useMemo(
    () => base
      .filter((p) => (hf === 'all' || p.health === hf) && (!q || `${p.name} ${brandName(p.brand)}`.toLowerCase().includes(q.toLowerCase())))
      .sort((a, b) => healthRank[a.health] - healthRank[b.health] || a.dueDays - b.dueDays),
    [base, hf, q],
  );
  const filtered = hf !== 'all' || q !== '';
  const open = (id: string) => router.push(`/app/projects/${id}`);

  return (
    <>
      <PageHeader
        title="Projects"
        count={base.length}
        actions={<Button variant="dark" size="lg" icon={<Plus size={16} />} onClick={() => setCreating(true)}>New project</Button>}
      />

      <ViewBar
        left={
          <Segmented<HF>
            value={hf} onChange={setHf}
            options={[
              { id: 'all', label: 'All', count: base.length },
              { id: 'on', label: 'On track', count: d.health.on },
              { id: 'risk', label: 'At risk', count: d.health.risk },
              { id: 'off', label: 'Off track', count: d.health.off },
            ]}
          />
        }
        right={
          <>
            <Segmented<Layout>
              sub size="sm" value={layout} onChange={setLayout}
              options={[{ id: 'list', label: 'List', icon: <List size={14} /> }, { id: 'cards', label: 'Cards', icon: <LayoutGrid size={14} /> }]}
            />
            <SearchField placeholder="Search projects" value={q} onChange={setQ} width={220} />
          </>
        }
      />

      {!rows.length ? (
        filtered ? (
          <Empty icon={<SearchX size={20} />}>
            <span>No projects match these filters.</span>
            <Button size="sm" onClick={() => { setHf('all'); setQ(''); }}>Clear filters</Button>
          </Empty>
        ) : (
          <Empty icon={<FolderPlus size={20} />}>
            <span>{brand ? `${brandName(brand)} has no projects yet.` : 'No projects yet.'} Projects group tasks, docs and releases.</span>
            <Button size="sm" variant="dark" icon={<Plus size={14} />} onClick={() => setCreating(true)}>New project</Button>
          </Empty>
        )
      ) : layout === 'list' ? (
        <div className={s.tableCard}>
          <table className={u.table}>
            <thead>
              <tr>
                <th style={{ width: 120 }}>Health</th>
                <th>Project</th>
                <th style={{ width: 200 }}>Progress</th>
                <th>Due</th>
                <th>Open / blocked</th>
                <th>Owner</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} onClick={() => open(p.id)} onKeyDown={(e) => { if (e.key === 'Enter') open(p.id); }} tabIndex={0} aria-label={`Open ${p.name}`}>
                  <td><HealthBadge health={p.health} /></td>
                  <td>
                    <span className={s.name}>
                      <BrandChip id={p.brand} size={24} />
                      <Link href={`/app/projects/${p.id}`} onClick={(e) => e.stopPropagation()}>{p.name}</Link>
                      <span className={s.brand}>{brandName(p.brand)}</span>
                    </span>
                  </td>
                  <td><Progress value={p.progress} /></td>
                  <td><Due p={p} /></td>
                  <td><OpenBlocked p={p} /></td>
                  <td><Owner id={metaFor(p.id).owner} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={s.grid}>
          {rows.map((p, i) => (
            <Link key={p.id} href={`/app/projects/${p.id}`} className={s.card} style={{ animationDelay: `${i * 40}ms` }}>
              <span className={s.cardTop}>
                <BrandChip id={p.brand} size={28} />
                <span className={s.brand}>{brandName(p.brand)}</span>
                <span className={s.push}><HealthBadge health={p.health} /></span>
              </span>
              <span className={s.cardName}>{p.name}</span>
              <Progress value={p.progress} />
              <span className={s.cardFacts}>
                <span><em>Due</em><Due p={p} /></span>
                <span><em>Open / blocked</em><OpenBlocked p={p} /></span>
                <span className={s.push}><Owner id={metaFor(p.id).owner} /></span>
              </span>
            </Link>
          ))}
        </div>
      )}

      {creating ? <CreateProject brand={brand} onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function Progress({ value }: { value: number }) {
  return (
    <span className={s.prog}>
      <span className={s.progBar}><Thin value={value} height={6} /></span>
      <b>{value}%</b>
    </span>
  );
}

function Due({ p }: { p: Project }) {
  return <span className={p.dueDays <= 3 ? s.soon : s.num}>{p.due}{p.dueDays <= 3 ? ` · ${p.dueDays}d` : ''}</span>;
}

function OpenBlocked({ p }: { p: Project }) {
  return (
    <span className={s.num}>
      {p.open}
      <span className={s.sep}>/</span>
      <span className={p.blocked ? s.bad : undefined}>{p.blocked}</span>
    </span>
  );
}

function Owner({ id }: { id: string }) {
  const o = personById(id);
  return <span className={s.owner}><Avatar id={id} size={24} />{o?.name.split(' ')[0]}</span>;
}
