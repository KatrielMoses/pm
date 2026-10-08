'use client';

/* 18 Sage Triage: sage canvas, folder tabs with counts, triage cards with Accept, toast. */

import { useEffect, useMemo, useState } from 'react';
import {
  Bell, Bot, Check, CheckCircle2, ChevronsUpDown, CircleDollarSign, CircleHelp, Clock3, Flag, FolderKanban, Gauge, Home,
  Inbox, Info, Layers, Moon, PlusSquare, Rocket, Settings, ShieldAlert, TriangleAlert, Users,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { brandName, brands, fmtH, USER, type BrandId } from '@/lib/data';
import { BrandChip, LogoMark } from '@/components/brand';
import { CountUp, Meter, Ring } from '@/components/charts';
import s from './styles.module.css';

type Kind = 'review' | 'failed' | 'decision';
type Prio = 'High' | 'Medium' | 'Low';
type Item = {
  id: string; brand: BrandId; kind: Kind; title: string; prio: Prio;
  boxes: { icon: typeof Bot; label: string; value: string }[];
  action: string; done: string;
};
type Tab = 'all' | Kind;

const tabs: { id: Tab; label: string; icon: typeof Bot }[] = [
  { id: 'all', label: 'All', icon: Layers },
  { id: 'review', label: 'Review', icon: Inbox },
  { id: 'failed', label: 'Failed', icon: ShieldAlert },
  { id: 'decision', label: 'Decisions', icon: Rocket },
];
const heading: Record<Tab, string> = { all: 'Needs you', review: 'Review', failed: 'Failed runs', decision: 'Decisions' };

export default function Design() {
  const { s: d, brand, setBrand } = useWorkspace();
  const [tab, setTab] = useState<Tab>('all');
  const [gone, setGone] = useState<string[]>([]);
  const [toast, setToast] = useState<{ n: number; word: string; title: string } | null>(null);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    if (d.release) {
      const rate = ((d.release.passed / d.release.tests) * 100).toFixed(1);
      list.push({
        id: 'rel', brand: d.release.brand, kind: 'decision', title: `${d.release.version} go / no-go`, prio: 'High',
        boxes: [{ icon: Gauge, label: 'Pass rate', value: `${rate}%` }, { icon: TriangleAlert, label: 'Blockers', value: String(d.release.blockers) }],
        action: 'Approve', done: 'Approved',
      });
    }
    d.runs.filter((r) => r.state === 'failed').forEach((r) => list.push({
      id: r.id, brand: r.brand, kind: 'failed', title: r.task, prio: 'High',
      boxes: [{ icon: Bot, label: 'Agent', value: r.agent }, { icon: Clock3, label: 'Ran', value: `${r.mins} min` }],
      action: 'Retry', done: 'Retry queued',
    }));
    d.runs.filter((r) => r.state === 'review').forEach((r) => list.push({
      id: r.id, brand: r.brand, kind: 'review', title: r.task, prio: r.cost >= 1 ? 'High' : r.cost >= 0.5 ? 'Medium' : 'Low',
      boxes: [{ icon: Bot, label: 'Agent', value: r.agent }, { icon: CircleDollarSign, label: 'Cost', value: `$${r.cost.toFixed(2)}` }],
      action: 'Accept', done: 'Accepted',
    }));
    return list;
  }, [d]);

  const open = items.filter((i) => !gone.includes(i.id));
  const count = (t: Tab) => open.filter((i) => t === 'all' || i.kind === t).length;
  const shown = open.filter((i) => tab === 'all' || i.kind === tab);
  const cleared = items.length - open.length;

  const act = (i: Item) => {
    setGone((g) => [...g, i.id]);
    setToast((t) => ({ n: (t?.n ?? 0) + 1, word: i.done, title: i.title }));
  };

  const running = d.runs.filter((r) => r.state === 'running' || r.state === 'queued');

  return (
    <div className={s.root}>
      <div className={s.frame}>
        <aside className={s.rail}>
          <LogoMark size={40} radius={999} bg="#2b2b29" fg="#fff" />
          <nav className={s.railNav}>
            {[Home, Inbox, FolderKanban, Bot, Users].map((I, i) => (
              <a key={i} className={i === 1 ? s.railOn : s.railItem}><I size={18} /></a>
            ))}
          </nav>
          <div className={s.railBottom}>
            <a className={s.railItem}><Moon size={18} /></a>
            <a className={s.railItem}><Settings size={18} /></a>
          </div>
        </aside>

        <div className={s.body}>
          <header className={s.head}>
            <h1>Triage</h1>
            <div className={s.headRight}>
              <div className={s.switcher}>
                <button className={s.swBtn} onClick={() => setMenu((m) => !m)}>
                  {brand ? <BrandChip id={brand} size={30} radius={9} /> : <span className={s.allMark}><Layers size={15} /></span>}
                  <span className={s.swText}><small>Workspace</small><b>{brand ? brandName(brand) : 'All brands'}</b></span>
                  <ChevronsUpDown size={15} className={s.mute} />
                </button>
                {menu ? (
                  <>
                    <div className={s.scrim} onClick={() => setMenu(false)} />
                    <div className={s.menu}>
                      {[{ id: null as BrandId | null, name: 'All brands' }, ...brands.map((b) => ({ id: b.id as BrandId | null, name: b.name }))].map((b, i) => (
                        <button key={b.name} className={s.menuItem} onClick={() => { setBrand(b.id); setMenu(false); }}>
                          {b.id ? <BrandChip id={b.id} size={28} radius={8} /> : <span className={s.allMark}><Layers size={14} /></span>}
                          <span>{b.name}</span>
                          {brand === b.id ? <span className={s.check}><Check size={11} strokeWidth={3} /></span> : <kbd>⌘ {i}</kbd>}
                        </button>
                      ))}
                      <div className={s.menuSep} />
                      <button className={`${s.menuItem} ${s.mute}`}><span className={s.addMark}><PlusSquare size={16} /></span><span>Add brand</span></button>
                    </div>
                  </>
                ) : null}
              </div>
              <button className={s.iconBtn} aria-label="Help"><CircleHelp size={17} /></button>
              <button className={s.iconBtn} aria-label="Alerts"><Bell size={17} /></button>
              <span className={s.user}><span className={s.avatar}>{USER.initials}</span>{USER.name}</span>
            </div>
          </header>

          <div className={s.work}>
            <div className={s.triage}>
              <div className={s.tabRow}>
                {tabs.map((t) => {
                  const n = count(t.id);
                  return (
                    <button key={t.id} className={tab === t.id ? s.tabOn : s.tab} onClick={() => setTab(t.id)}>
                      <span className={s.tabIcon}><t.icon size={15} /></span>
                      {t.label}
                      <em className={t.id === 'failed' && n > 0 ? s.countBad : s.count}>{n}</em>
                    </button>
                  );
                })}
                {toast ? (
                  <div key={toast.n} className={s.toast}>
                    <span className={s.toastIcon}><CheckCircle2 size={18} /></span>
                    <span><b>{toast.word}</b><small>{toast.title}</small></span>
                  </div>
                ) : null}
              </div>

              <section className={`${s.panel} ${tab === 'all' ? s.flush : ''}`}>
                <h2>{heading[tab]} <span>{shown.length}</span></h2>
                {shown.length ? (
                  <div className={s.cards}>
                    {shown.map((i, n) => (
                      <article key={i.id} className={`${s.card} ${i.kind === 'failed' ? s.cardBad : ''}`} style={{ animationDelay: `${n * 60}ms` }}>
                        <div className={s.cardTop}>
                          <span className={s.brand}><BrandChip id={i.brand} size={24} radius={7} />{brandName(i.brand)}</span>
                          <span className={s['p' + i.prio]}><Flag size={11} />{i.prio}</span>
                        </div>
                        <div className={s.boxes}>
                          {i.boxes.map((b) => (
                            <div key={b.label} className={s.box}>
                              <span><b.icon size={13} />{b.label}</span>
                              <b>{b.value}</b>
                            </div>
                          ))}
                        </div>
                        <h3 className={s.title}>
                          {i.kind === 'failed' ? <span className={s.kindBad}>Failed</span> : i.kind === 'decision' ? <span className={s.kindDec}>Decision</span> : null}
                          {i.title}
                        </h3>
                        <div className={s.actions}>
                          <button className={s.view}><Info size={15} /> View</button>
                          <button className={s.accept} onClick={() => act(i)}><CheckCircle2 size={15} /> {i.action}</button>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className={s.empty}>
                    <span className={s.emptyIcon}><Check size={28} strokeWidth={2.5} /></span>
                    <b>All clear</b>
                  </div>
                )}
              </section>
            </div>

            <aside className={s.side}>
              <div className={`${s.hero} anim-fade-up`}>
                <div className={s.heroTop}><span>Open</span><Inbox size={16} /></div>
                <div className={s.heroMain}>
                  <b className={s.heroNum}><CountUp value={open.length} /></b>
                  <Ring value={items.length ? cleared / items.length : 1} size={78} stroke={8} color="var(--k1-ink)" track="color-mix(in srgb, var(--k1-ink) 18%, transparent)">
                    <span className={s.ringTxt}>{cleared}/{items.length}</span>
                  </Ring>
                </div>
                <div className={s.heroPills}>
                  <span>{count('review')} review</span>
                  <span className={count('failed') ? s.heroBad : ''}>{count('failed')} failed</span>
                  <span>{count('decision')} decision</span>
                </div>
              </div>

              <div className={`${s.mini} anim-fade-up`} style={{ animationDelay: '80ms' }}>
                <div className={s.miniHead}><span><Clock3 size={15} /> Today</span>{d.over > 0 ? <em className={s.overPill}>+{fmtH(d.over)} over</em> : <em className={s.okPill}>Fits</em>}</div>
                <div className={s.miniNum}><CountUp value={d.committed} decimals={1} suffix="h" /><span>/ {fmtH(d.available)}</span></div>
                <Meter value={d.available} max={d.available} over={d.over} color="#2b2b29" overColor="#E5484D" track="#e6e9dc" height={10} />
                <div className={s.miniFoot}><span>{d.todayDone}/{d.today.length} done</span><span>{d.active} projects</span></div>
              </div>

              <div className={`${s.mini} anim-fade-up`} style={{ animationDelay: '160ms' }}>
                <div className={s.miniHead}><span><Bot size={15} /> Agents</span><em className={s.livePill}><i className="anim-pulse" />{d.running} live</em></div>
                <ul className={s.runs}>
                  {running.length ? running.map((r) => (
                    <li key={r.id}>
                      <BrandChip id={r.brand} size={22} radius={6} />
                      <span>{r.task}</span>
                      <em className={r.state === 'running' ? s.stRun : s.stQ}>{r.state === 'running' ? `${r.mins}m` : 'Queued'}</em>
                    </li>
                  )) : <li className={s.mute}>Idle</li>}
                </ul>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
