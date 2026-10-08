'use client';

/*
 * Project detail: PageHeader (Projects / Brand › name + health › "+ Task"), then one ViewBar:
 * tabs Overview · Tasks · Release · Docs · Activity on the left; on Tasks the right side holds the
 * layout switch (List · Board · Timeline, same data), assignee filter, search and count.
 * ?tab=release|tasks… and ?view=board|timeline… deep-link (used by old /releases and /timeline URLs).
 */

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, FolderSearch, GanttChart, List, Plus, SearchX, SquareKanban } from 'lucide-react';
import { useApp } from '@/lib/app-state';
import { docs, personById, projectById } from '@/lib/app-data';
import { brandName } from '@/lib/data';
import { Button, Empty, HealthBadge, PageHeader, SearchField, Segmented, ViewBar } from '@/components/paper/ui';
import { metaFor, teamOf } from '../_lib/meta';
import { releaseFor } from '../_lib/release';
import { Board } from './board';
import { ActivityTab, DocsTab, ListView, Overview, TaskTimeline } from './tabs';
import { ReleaseTab } from './release';
import s from './detail.module.css';

type Tab = 'overview' | 'tasks' | 'release' | 'docs' | 'activity';
type Layout = 'list' | 'board' | 'timeline';
const TABS: Tab[] = ['overview', 'tasks', 'release', 'docs', 'activity'];
const LAYOUTS: Layout[] = ['list', 'board', 'timeline'];

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const p = projectById(id);
  const { tasks: all, setCapture } = useApp();
  const [tab, setTabState] = useState<Tab>('overview');
  const [layout, setLayoutState] = useState<Layout>('list');
  const [q, setQ] = useState('');
  const [who, setWho] = useState('');

  // Deep links: read ?tab= and ?view= once, then keep the URL in sync (no Suspense needed).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const t = sp.get('tab') as Tab | null;
    const v = sp.get('view') as Layout | null;
    if (v && LAYOUTS.includes(v)) { setLayoutState(v); setTabState('tasks'); }
    if (t && TABS.includes(t)) setTabState(t);
  }, []);
  const sync = (t: Tab, v: Layout) => {
    const sp = new URLSearchParams(window.location.search);
    sp.set('tab', t);
    if (t === 'tasks') sp.set('view', v); else sp.delete('view');
    window.history.replaceState(null, '', `${window.location.pathname}?${sp.toString()}`);
  };
  const setTab = (t: Tab) => { setTabState(t); sync(t, layout); };
  const setLayout = (v: Layout) => { setLayoutState(v); sync('tasks', v); };

  const tasks = useMemo(() => all.filter((t) => t.projectId === id), [all, id]);

  if (!p) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Projects', href: '/app/projects' }]} title="Project not found" />
        <Empty icon={<FolderSearch size={22} />}>
          <span>There is no project with the id “{id}”. It may have been deleted or the link is wrong.</span>
          <Link href="/app/projects"><Button size="sm" variant="dark" icon={<ArrowLeft size={14} />}>All projects</Button></Link>
        </Empty>
      </>
    );
  }

  const m = metaFor(p.id);
  const team = teamOf(tasks);
  const filtered = tasks.filter((t) => (!who || t.assignee === who) && (!q || `${t.key} ${t.title} ${t.labels.join(' ')}`.toLowerCase().includes(q.toLowerCase())));
  const docCount = docs.filter((d) => d.projectId === p.id).length;
  const rel = releaseFor(p.id);
  const filtering = !!who || !!q;

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Projects', href: '/app/projects' }, { label: brandName(p.brand) }]}
        title={<span className={s.title}>{p.name}<HealthBadge health={p.health} /></span>}
        actions={<Button variant="dark" size="lg" icon={<Plus size={16} />} onClick={() => setCapture(true)}>Task</Button>}
      />

      <ViewBar
        left={
          <Segmented<Tab>
            value={tab} onChange={setTab}
            options={[
              { id: 'overview', label: 'Overview' },
              { id: 'tasks', label: 'Tasks', count: tasks.length },
              { id: 'release', label: rel ? `Release ${rel.version}` : 'Release' },
              { id: 'docs', label: 'Docs', count: docCount },
              { id: 'activity', label: 'Activity' },
            ]}
          />
        }
        right={tab === 'tasks' ? (
          <>
            <Segmented<Layout>
              sub size="sm" value={layout} onChange={setLayout}
              options={[
                { id: 'list', label: 'List', icon: <List size={14} /> },
                { id: 'board', label: 'Board', icon: <SquareKanban size={14} /> },
                { id: 'timeline', label: 'Timeline', icon: <GanttChart size={14} /> },
              ]}
            />
            <label className={s.selectWrap}>
              <span className={s.srOnly}>Assignee</span>
              <select className={s.select} value={who} onChange={(e) => setWho(e.target.value)} aria-label="Filter by assignee">
                <option value="">Everyone</option>
                {team.map((pid) => <option key={pid} value={pid}>{personById(pid)?.name ?? pid}</option>)}
              </select>
            </label>
            <SearchField placeholder="Filter tasks" value={q} onChange={setQ} width={200} />
            <span className={s.count}>{filtered.length} of {tasks.length}</span>
          </>
        ) : null}
      />

      {tab === 'overview' ? <Overview key={p.id} p={p} m={m} tasks={tasks} goTasks={() => setTab('tasks')} /> : null}

      {tab === 'tasks' ? (
        !tasks.length ? (
          <Empty icon={<Plus size={20} />}>
            <span>This project has no tasks yet.</span>
            <Button size="sm" variant="dark" icon={<Plus size={14} />} onClick={() => setCapture(true)}>Add a task</Button>
          </Empty>
        ) : !filtered.length && filtering ? (
          <Empty icon={<SearchX size={20} />}>
            <span>No tasks match these filters.</span>
            <Button size="sm" onClick={() => { setWho(''); setQ(''); }}>Clear filters</Button>
          </Empty>
        ) : layout === 'list' ? <ListView tasks={filtered} />
          : layout === 'board' ? <Board tasks={filtered} />
            : <TaskTimeline p={p} m={m} tasks={filtered} />
      ) : null}

      {tab === 'release' ? <ReleaseTab key={p.id} project={p} /> : null}
      {tab === 'docs' ? <DocsTab p={p} /> : null}
      {tab === 'activity' ? <ActivityTab tasks={tasks} /> : null}
    </>
  );
}
