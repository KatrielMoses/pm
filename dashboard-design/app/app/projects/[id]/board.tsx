'use client';

/* Kanban board for one project: HTML5 drag between status columns → updateTask + toast. Card → task drawer. */

import { useState, type CSSProperties, type DragEvent } from 'react';
import { ArrowDown, ChevronsLeftRight, Plus } from 'lucide-react';
import { useApp } from '@/lib/app-state';
import { STATUSES, type Status, type WorkItem } from '@/lib/app-data';
import { TaskChips, TaskDue, TaskTags } from './task-bits';
import { Avatar, Priority } from '@/components/paper/ui';
import s from './detail.module.css';

export const SC: Record<Status, string> = {
  backlog: 'var(--mute)', todo: 'var(--text)', doing: 'var(--k1)', review: 'var(--blue)', blocked: 'var(--red)', done: 'var(--green)',
};
export const statusLabel = (st: Status) => STATUSES.find((x) => x.id === st)!.label;
export const progressOf = (t: WorkItem) => (t.status === 'done' ? 100 : t.subtasks[1] ? Math.round((t.subtasks[0] / t.subtasks[1]) * 100) : 0);

const ORDER: Status[] = ['backlog', 'todo', 'doing', 'review', 'blocked', 'done'];

function KCard({ t, i, dragging, onStart, onEnd }: { t: WorkItem; i: number; dragging: boolean; onStart: (e: DragEvent, id: string) => void; onEnd: () => void }) {
  const { openTask } = useApp();
  return (
    <article
      draggable
      onDragStart={(e) => onStart(e, t.id)}
      onDragEnd={onEnd}
      onClick={() => openTask(t.id)}
      onKeyDown={(e) => { if (e.key === 'Enter') openTask(t.id); }}
      tabIndex={0}
      role="button"
      aria-label={`${t.key} ${t.title}`}
      className={`${s.kcard} ${dragging ? s.kcardDrag : ''}`}
      style={{ animationDelay: `${40 + i * 30}ms` }}
    >
      <div className={s.kTop}>
        <span className={s.kKey}>{t.key}</span>
        <TaskTags t={t} />
      </div>
      <h4 className={s.kTitle}>{t.title}</h4>
      <TaskChips t={t} />
      <div className={s.kFoot}>
        <Avatar id={t.assignee} size={24} />
        <TaskDue t={t} />
        <span className={s.kPri}><Priority p={t.priority} /></span>
      </div>
    </article>
  );
}

export function Board({ tasks }: { tasks: WorkItem[] }) {
  const { updateTask, toast, setCapture } = useApp();
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<Status | null>(null);
  const [backlog, setBacklog] = useState(false);

  const onStart = (e: DragEvent, id: string) => {
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
    setDrag(id);
  };
  const onEnd = () => { setDrag(null); setOver(null); };
  const onOver = (e: DragEvent, st: Status) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (over !== st) setOver(st);
  };
  const onLeave = (e: DragEvent<HTMLElement>, st: Status) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === st ? null : o));
  };
  const onDrop = (e: DragEvent, st: Status) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || drag;
    setOver(null); setDrag(null);
    const t = tasks.find((x) => x.id === id);
    if (!t || t.status === st) return;
    updateTask(t.id, { status: st });
    toast(`${t.key} → ${statusLabel(st)}`);
  };
  const dragTask = tasks.find((t) => t.id === drag);
  const cols = `${backlog ? 'minmax(220px, 1fr)' : '64px'} repeat(5, minmax(220px, 1fr))`;

  return (
    <div className={s.boardScroll}>
      <div className={s.board} style={{ gridTemplateColumns: cols }}>
        {ORDER.map((st, ci) => {
          const items = tasks.filter((t) => t.status === st);
          const isOver = over === st && dragTask && dragTask.status !== st;
          const colStyle = { ['--sc' as string]: SC[st] } as CSSProperties;
          const dnd = { onDragOver: (e: DragEvent) => onOver(e, st), onDragLeave: (e: DragEvent<HTMLElement>) => onLeave(e, st), onDrop: (e: DragEvent) => onDrop(e, st) };
          if (st === 'backlog' && !backlog) {
            return (
              <button key={st} className={`${s.colMini} ${isOver ? s.colOver : ''}`} style={colStyle} onClick={() => setBacklog(true)} {...dnd} aria-label={`Show backlog (${items.length})`} title="Show backlog">
                <ChevronsLeftRight size={15} />
                <span className={s.colCount}>{items.length}</span>
                <span className={s.colMiniLabel}>Backlog</span>
              </button>
            );
          }
          return (
            <section key={st} className={`${s.col} ${isOver ? s.colOver : ''}`} style={colStyle} {...dnd} aria-label={statusLabel(st)}>
              <header className={s.colHead}>
                <i className={s.colDot} />
                <span className={s.colName}>{statusLabel(st)}</span>
                <span className={s.colCount}>{items.length}</span>
                <span className={s.colTools}>
                  {st === 'backlog' ? (
                    <button className={s.colBtn} aria-label="Hide backlog" title="Hide backlog" onClick={() => setBacklog(false)}><ChevronsLeftRight size={14} /></button>
                  ) : null}
                  <button className={s.colBtn} aria-label={`Add task to ${statusLabel(st)}`} title="Add task" onClick={() => setCapture(true)}><Plus size={15} /></button>
                </span>
              </header>
              <div className={s.colBody}>
                {items.map((t, i) => <KCard key={t.id} t={t} i={i + ci} dragging={drag === t.id} onStart={onStart} onEnd={onEnd} />)}
                {isOver ? <div className={s.dropSlot}><ArrowDown size={14} /> Move to {statusLabel(st)}</div> : null}
                {!items.length && !isOver ? <div className={s.colEmpty}>Drop tasks here</div> : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
