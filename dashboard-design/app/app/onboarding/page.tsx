'use client';

/*
 * Onboarding: a guided setup stepper (workspace → brands → first project → connect → template)
 * with skip on every step, an ink "first value" checklist, and a colourful template picker with
 * a preview and component selection (pick cards after 4b333485 / b10f7c56, drawn in Paper).
 */

import Link from 'next/link';
import { useState } from 'react';
import {
  ArrowLeft, ArrowRight, Bug, CalendarDays, Check, FileText, FolderKanban, GitBranch, LayoutTemplate, Megaphone, Palette, Plug, Plus, Rocket,
  ShieldCheck, Sparkles, Trash, Workflow, Bot, ListChecks,
} from 'lucide-react';
import { useApp } from '@/lib/app-state';
import { useWorkspace } from '@/lib/workspace';
import { brands, type BrandId } from '@/lib/data';
import { templates } from '@/lib/app-data';
import { BrandChip, LogoMark } from '@/components/brand';
import { CountUp, Ring } from '@/components/charts';
import { Badge, Button, Checkbox, PageHead, Segmented, u } from '@/components/paper/ui';
import { Select } from '../settings/select';
import s from './onboarding.module.css';

type StepId = 'workspace' | 'brands' | 'project' | 'connect' | 'template';
type State = 'todo' | 'done' | 'skipped';
const STEPS: { id: StepId; label: string; icon: typeof Plug; optional?: boolean }[] = [
  { id: 'workspace', label: 'Workspace', icon: LayoutTemplate },
  { id: 'brands', label: 'Brands', icon: Palette },
  { id: 'project', label: 'First project', icon: FolderKanban },
  { id: 'connect', label: 'Connect', icon: Plug, optional: true },
  { id: 'template', label: 'Template', icon: Sparkles, optional: true },
];

const TPL_LOOK: Record<string, { tone: string; icon: typeof Plug }> = {
  tp1: { tone: s.tBlue, icon: Rocket }, tp2: { tone: s.tRed, icon: Bug }, tp3: { tone: s.tGreen, icon: ShieldCheck },
  tp4: { tone: s.tAmber, icon: Megaphone }, tp5: { tone: s.tAccent, icon: ListChecks }, tp6: { tone: s.tGrey, icon: Rocket },
};
const TPL_PARTS: Record<string, { id: string; label: string; n: number; icon: typeof Plug }[]> = {
  tp1: [{ id: 'proj', label: 'Project', n: 1, icon: FolderKanban }, { id: 'tasks', label: 'Tasks', n: 18, icon: ListChecks }, { id: 'docs', label: 'Docs', n: 3, icon: FileText }, { id: 'auto', label: 'Automations', n: 2, icon: Workflow }],
  tp2: [{ id: 'flow', label: 'Workflow', n: 1, icon: Workflow }, { id: 'auto', label: 'Automations', n: 3, icon: Workflow }, { id: 'docs', label: 'SOP', n: 1, icon: FileText }],
  tp3: [{ id: 'proj', label: 'Project', n: 1, icon: FolderKanban }, { id: 'tasks', label: 'Tasks', n: 12, icon: ListChecks }, { id: 'agent', label: 'Agent', n: 1, icon: Bot }, { id: 'docs', label: 'Docs', n: 2, icon: FileText }],
  tp4: [{ id: 'proj', label: 'Project', n: 1, icon: FolderKanban }, { id: 'tasks', label: 'Tasks', n: 8, icon: ListChecks }, { id: 'docs', label: 'Brief', n: 1, icon: FileText }],
  tp5: [{ id: 'docs', label: 'Doc', n: 1, icon: FileText }, { id: 'auto', label: 'Reminder', n: 1, icon: Workflow }],
  tp6: [{ id: 'proj', label: 'Project', n: 1, icon: FolderKanban }, { id: 'tasks', label: 'Tasks', n: 26, icon: ListChecks }, { id: 'docs', label: 'Docs', n: 4, icon: FileText }, { id: 'auto', label: 'Automations', n: 2, icon: Workflow }],
};
const TPL_SAMPLE: Record<string, string[]> = {
  tp1: ['Freeze scope', 'Run regression suite', 'Release notes', 'Go / no-go'],
  tp2: ['Reproduce', 'Assign severity', 'Fix + PR', 'Verify on staging'],
  tp3: ['Threat model', 'Run scanner', 'Triage findings', 'Retest fixes'],
  tp4: ['Hypothesis', 'Variant copy', 'Ship to 20%', 'Read result'],
  tp5: ['Wins', 'Misses', 'Next week', 'Capacity check'],
  tp6: ['Landing page', 'Launch post', 'Email list', 'Day-1 support'],
};
const MILESTONES = ['Workspace created', 'First brand', 'First project', 'First task', 'Tool connected', 'Template installed'];

export default function OnboardingPage() {
  const { toast } = useApp();
  const { brand } = useWorkspace();
  const [cur, setCur] = useState(0);
  const [state, setState] = useState<Record<StepId, State>>({ workspace: 'done', brands: 'todo', project: 'todo', connect: 'todo', template: 'todo' });
  const [ws, setWs] = useState('Lavelle Labs');
  const [tz, setTz] = useState('Europe/London');
  const [use, setUse] = useState<'solo' | 'team'>('solo');
  const [extraBrand, setExtraBrand] = useState('');
  const [added, setAdded] = useState<string[]>([]);
  const [proj, setProj] = useState('Q4 launch');
  const [projBrand, setProjBrand] = useState<BrandId>(brand ?? 'op');
  const [due, setDue] = useState('30 Oct');
  const [task, setTask] = useState('Draft launch checklist');
  const [conn, setConn] = useState({ gh: false, gc: false });
  const [tpl, setTpl] = useState('tp1');
  const [parts, setParts] = useState<Record<string, boolean>>({});
  const [sample, setSample] = useState(true);

  const step = STEPS[cur];
  const doneCount = STEPS.filter((x) => state[x.id] !== 'todo').length;
  const allDone = doneCount === STEPS.length;
  const mark = (id: StepId, v: State, msg?: string) => {
    setState((x) => ({ ...x, [id]: v }));
    if (msg) toast(msg);
    const next = STEPS.findIndex((x, i) => i > cur && state[x.id] === 'todo');
    if (next >= 0) setCur(next);
  };
  const milestones = [
    true, state.brands === 'done' || added.length > 0, state.project === 'done', state.project === 'done',
    conn.gh || conn.gc, state.template === 'done',
  ];
  const mDone = milestones.filter(Boolean).length;
  const partOn = (id: string) => parts[`${tpl}:${id}`] ?? true;
  const t = templates.find((x) => x.id === tpl)!;

  return (
    <>
      <PageHead title="Set up" count={`${doneCount} / ${STEPS.length}`}>
        <Button variant="text" onClick={() => { setState({ workspace: 'done', brands: state.brands === 'todo' ? 'skipped' : state.brands, project: state.project === 'todo' ? 'skipped' : state.project, connect: state.connect === 'todo' ? 'skipped' : state.connect, template: state.template === 'todo' ? 'skipped' : state.template }); toast('Setup skipped · resume any time'); }}>Skip all</Button>
        <Link href="/app"><Button variant="dark" icon={<ArrowRight size={15} />}>Go to Home</Button></Link>
      </PageHead>

      {/* stepper */}
      <nav className={s.stepper} aria-label="Setup steps">
        {STEPS.map((x, i) => {
          const st = state[x.id];
          return (
            <button key={x.id} className={`${s.step} ${i === cur ? s.stepOn : ''}`} onClick={() => setCur(i)} aria-current={i === cur ? 'step' : undefined}>
              <span className={`${s.stepNum} ${st === 'done' ? s.numDone : st === 'skipped' ? s.numSkip : i === cur ? s.numCur : ''}`}>
                {st === 'done' ? <Check size={13} strokeWidth={3} /> : i + 1}
              </span>
              <span className={s.stepText}><b>{x.label}</b><em>{st === 'done' ? 'Done' : st === 'skipped' ? 'Skipped' : x.optional ? 'Optional' : 'Required'}</em></span>
              {i < STEPS.length - 1 ? <span className={`${s.stepLine} ${st !== 'todo' ? s.lineDone : ''}`} /> : null}
            </button>
          );
        })}
      </nav>

      <div className={s.layout}>
        <section className={s.card} key={step.id}>
          <header className={s.head}>
            <span className={s.headIcon}><step.icon size={18} /></span>
            <span className={s.headText}><span className={s.cap}>Step {cur + 1}</span><h2>{step.label}</h2></span>
            {state[step.id] === 'done' ? <Badge tone="green" dot>Done</Badge> : state[step.id] === 'skipped' ? <Badge tone="neutral">Skipped</Badge> : null}
          </header>

          {step.id === 'workspace' ? (
            <div className={s.body}>
              <div className={s.wsRow}>
                <LogoMark size={64} radius={20} bg="var(--ink)" fg="var(--ink-text)" />
                <label className={s.field}><span>Name</span><input className={u.input} value={ws} onChange={(e) => setWs(e.target.value)} /></label>
              </div>
              <div className={s.fields}>
                <label className={s.field}><span>Timezone</span><Select size="md" label="Timezone" value={tz} onChange={setTz} options={['Europe/London', 'UTC', 'America/New_York', 'Asia/Kolkata']} /></label>
                <div className={s.field}><span>Working</span><Segmented sub value={use} onChange={setUse} options={[{ id: 'solo', label: 'Solo founder' }, { id: 'team', label: 'With a team' }]} /></div>
              </div>
            </div>
          ) : null}

          {step.id === 'brands' ? (
            <div className={s.body}>
              <div className={s.brandList}>
                {brands.map((b) => (
                  <span key={b.id} className={s.brandRow}><BrandChip id={b.id} size={34} /><b>{b.name}</b><Badge tone="green" dot>Kit ready</Badge></span>
                ))}
                {added.map((n) => (
                  <span key={n} className={s.brandRow}><span className={s.newChip}>{n.slice(0, 2).toUpperCase()}</span><b>{n}</b><Badge tone="outline">No logo</Badge></span>
                ))}
              </div>
              <div className={s.addRow}>
                <input className={u.input} placeholder="Brand name" value={extraBrand} onChange={(e) => setExtraBrand(e.target.value)} aria-label="New brand name"
                  onKeyDown={(e) => { if (e.key === 'Enter' && extraBrand.trim()) { setAdded((a) => [...a, extraBrand.trim()]); setExtraBrand(''); } }} />
                <Button variant="light" icon={<Plus size={15} />} onClick={() => { if (extraBrand.trim()) { setAdded((a) => [...a, extraBrand.trim()]); setExtraBrand(''); toast('Brand added'); } }}>Add</Button>
                <Link href="/app/settings#brands"><Button variant="ghost" icon={<Palette size={15} />}>Logo & kit</Button></Link>
              </div>
            </div>
          ) : null}

          {step.id === 'project' ? (
            <div className={s.body}>
              <div className={s.fields}>
                <label className={s.field}><span>Project</span><input className={u.input} value={proj} onChange={(e) => setProj(e.target.value)} /></label>
                <label className={s.field}><span>Brand</span><Select size="md" label="Brand" value={projBrand} onChange={setProjBrand} options={brands.map((b) => ({ id: b.id, label: b.name }))} /></label>
                <label className={s.field}><span>Due</span><Select size="md" label="Due" value={due} onChange={setDue} options={['16 Oct', '30 Oct', '13 Nov', '30 Nov']} /></label>
                <label className={s.field}><span>First task</span><input className={u.input} value={task} onChange={(e) => setTask(e.target.value)} /></label>
              </div>
              <div className={s.projPreview}>
                <BrandChip id={projBrand} size={30} />
                <span className={s.headText}><b>{proj || 'Untitled'}</b><em>Due {due} · 1 task</em></span>
                <Badge tone="green" dot>On track</Badge>
              </div>
            </div>
          ) : null}

          {step.id === 'connect' ? (
            <div className={s.connGrid}>
              {([
                { id: 'gh' as const, name: 'GitHub', icon: GitBranch, what: 'PRs → tasks' },
                { id: 'gc' as const, name: 'Google Calendar', icon: CalendarDays, what: 'Meetings + focus' },
              ]).map((c) => (
                <div key={c.id} className={conn[c.id] ? s.connOn : s.conn}>
                  <span className={s.connIcon}><c.icon size={20} /></span>
                  <b>{c.name}</b>
                  <em>{c.what}</em>
                  {conn[c.id] ? <Badge tone="green" dot>Connected</Badge> : (
                    <Button size="sm" variant="dark" icon={<Plug size={14} />} onClick={() => { setConn((x) => ({ ...x, [c.id]: true })); toast(`${c.name} connected`); }}>Connect</Button>
                  )}
                </div>
              ))}
            </div>
          ) : null}

          {step.id === 'template' ? (
            <div className={s.body}>
              <div className={s.picks}>
                {templates.map((x, i) => {
                  const look = TPL_LOOK[x.id];
                  return (
                    <button key={x.id} className={`${s.pick} ${look.tone} ${tpl === x.id ? s.pickOn : ''}`} onClick={() => setTpl(x.id)} style={{ animationDelay: `${i * 40}ms` }}>
                      <span className={s.pickTop}>
                        <span className={s.pickIcon}><look.icon size={18} /></span>
                        {tpl === x.id ? <span className={s.pickCheck}><Check size={13} strokeWidth={3} /></span> : <span className={s.pickUses}>{x.uses} uses</span>}
                      </span>
                      <b>{x.name}</b>
                      <span className={s.pickFoot}><em>{x.kind}</em><span>{x.items} items</span></span>
                    </button>
                  );
                })}
              </div>
              <div className={s.preview}>
                <div className={s.pvCol}>
                  <span className={s.cap}>Install</span>
                  {TPL_PARTS[tpl].map((p) => (
                    <span key={p.id} className={s.part} onClick={() => setParts((x) => ({ ...x, [`${tpl}:${p.id}`]: !partOn(p.id) }))}>
                      <Checkbox on={partOn(p.id)} onChange={() => setParts((x) => ({ ...x, [`${tpl}:${p.id}`]: !partOn(p.id) }))} label={p.label} />
                      <p.icon size={14} /><span>{p.label}</span><em>{p.n}</em>
                    </span>
                  ))}
                </div>
                <div className={s.pvCol}>
                  <span className={s.cap}>Preview · {t.name}</span>
                  <div className={s.pvTasks}>
                    {TPL_SAMPLE[tpl].map((x, i) => (
                      <span key={x} className={s.pvTask}><i>{i + 1}</i>{x}<Badge tone={i === 0 ? 'accent' : 'neutral'} dot={i === 0}>{i === 0 ? 'In progress' : 'To do'}</Badge></span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <footer className={s.foot}>
            <Button variant="ghost" icon={<ArrowLeft size={15} />} disabled={cur === 0} onClick={() => setCur((c) => Math.max(0, c - 1))}>Back</Button>
            <span className={s.footRight}>
              {step.id !== 'workspace' ? <Button variant="text" onClick={() => mark(step.id, 'skipped', `${step.label} skipped`)}>Skip</Button> : null}
              {step.id === 'workspace' ? <Button variant="dark" icon={<ArrowRight size={15} />} onClick={() => mark('workspace', 'done', 'Workspace saved')}>Continue</Button> : null}
              {step.id === 'brands' ? <Button variant="dark" icon={<ArrowRight size={15} />} onClick={() => mark('brands', 'done', `${brands.length + added.length} brands ready`)}>Continue</Button> : null}
              {step.id === 'project' ? <Button variant="dark" icon={<Plus size={15} />} onClick={() => mark('project', 'done', `${proj || 'Project'} created with 1 task`)}>Create project</Button> : null}
              {step.id === 'connect' ? <Button variant="dark" icon={<ArrowRight size={15} />} onClick={() => mark('connect', conn.gh || conn.gc ? 'done' : 'skipped', conn.gh || conn.gc ? 'Connections saved' : 'Connect later')}>Continue</Button> : null}
              {step.id === 'template' ? (
                <Button variant="accent" icon={<Sparkles size={15} />} onClick={() => {
                  const n = TPL_PARTS[tpl].filter((p) => partOn(p.id)).reduce((a, p) => a + p.n, 0);
                  mark('template', 'done', `${t.name} installed · ${n} items`);
                }}>Install</Button>
              ) : null}
            </span>
          </footer>
        </section>

        {/* the one ink hero: first-value checklist */}
        <aside className={s.hero}>
          <div className={s.heroHead}><span>First value</span><span className={s.heroIcon}><Rocket size={15} /></span></div>
          <div className={s.heroTop}>
            <Ring value={mDone / MILESTONES.length} size={92} stroke={10} color="var(--k1)" track="color-mix(in srgb, var(--ink-text) 16%, transparent)">
              <span className={s.ringNum}><CountUp value={Math.round((mDone / MILESTONES.length) * 100)} suffix="%" /></span>
            </Ring>
            <span className={s.heroBig}>{mDone}<em>/ {MILESTONES.length}</em></span>
          </div>
          <div className={s.miles}>
            {MILESTONES.map((m, i) => (
              <span key={m} className={milestones[i] ? s.mileDone : s.mile}><i>{milestones[i] ? <Check size={11} strokeWidth={3} /> : null}</i>{m}</span>
            ))}
          </div>
          {allDone ? <Link href="/app" className={s.heroLink}><Button variant="accent" icon={<ArrowRight size={15} />} style={{ width: '100%' }}>Open workspace</Button></Link> : null}
          <div className={s.sample}>
            <span><b>Sample data</b><em>{sample ? '42 records' : 'Removed'}</em></span>
            {sample ? <Button size="sm" variant="light" icon={<Trash size={13} />} onClick={() => { setSample(false); toast('Sample data removed'); }}>Remove</Button> : <Badge tone="green" dot>Clean</Badge>}
          </div>
        </aside>
      </div>
    </>
  );
}

