'use client';

/* Settings › Account: AI & limits, Billing & usage, Notifications, Security, Import / export. Plain forms, bars only. */

import { useMemo, useState } from 'react';
import {
  ArrowRight, Bell, Bot, Check, Clock, Cpu, Download, FileSpreadsheet, FileUp, Globe, KeyRound, Laptop, LogOut, Mail, Monitor, Plus, RotateCcw,
  ScanLine, ShieldAlert, ShieldCheck, Smartphone, Sparkles, Undo2, Users,
} from 'lucide-react';
import { useApp } from '@/lib/app-state';
import { useWorkspace } from '@/lib/workspace';
import { brands, brandName, type BrandId } from '@/lib/data';
import { billing } from '@/lib/app-data';
import { BrandChip } from '@/components/brand';
import { Badge, Button, Checkbox, Segmented, Toggle, u } from '@/components/paper/ui';
import { Select } from './select';
import { Field, Group, Meter, Row, SectionHeader, x } from './parts';

/* =====================================================================
 * AI & limits
 * ===================================================================== */

const SPENT = 18.4;
const PROJECTED = 34.1;
const SHARE: Record<BrandId, number> = { op: 0.5, ma: 0.3, ax: 0.2 };
const SPENT_BY: Record<BrandId, number> = { op: 10.7, ma: 5.0, ax: 2.7 };
const usd = (v: number) => `$${v.toFixed(2)}`;

export function AiSection({ onGo }: { onGo: (id: string) => void }) {
  const { toast } = useApp();
  const { brand } = useWorkspace();
  const [cap, setCap] = useState(40);
  const [hard, setHard] = useState(true);
  const [prov, setProv] = useState({ anthropic: true, openrouter: true, openai: false, local: false });
  const [model, setModel] = useState('claude-sonnet-5-5');
  const [pol, setPol] = useState({ approved: true, redact: true, retention: true, external: true, web: false });
  const shown = brands.filter((b) => !brand || b.id === brand);
  const providers = [
    { id: 'anthropic' as const, name: 'Anthropic', sub: 'Workspace key', icon: <Sparkles size={15} /> },
    { id: 'openrouter' as const, name: 'OpenRouter', sub: 'Your key', icon: <Globe size={15} /> },
    { id: 'openai' as const, name: 'OpenAI', sub: 'No key set', icon: <Cpu size={15} /> },
    { id: 'local' as const, name: 'Local model', sub: 'Ollama on this machine', icon: <Laptop size={15} /> },
  ];

  return (
    <>
      <SectionHeader title="AI & limits" actions={<Button variant="dark" icon={<Check size={15} />} onClick={() => toast(`Saved · cap $${cap}${hard ? ', hard stop' : ''}`)}>Save changes</Button>} />
      <div className={x.body}>
        <Group title="Monthly AI cap" desc="Covers AI writing, briefings and every agent run.">
          <Meter label="Spent this month" used={SPENT} cap={cap} projected={PROJECTED} fmt={usd} />
          <div>
            <input type="range" min={10} max={200} step={5} value={cap} onChange={(e) => setCap(Number(e.target.value))} className={x.range} aria-label="Monthly cap in dollars" />
            <div className={x.scale}><span>$10</span><b>${cap} cap</b><span>$200</span></div>
          </div>
          <Row title="Hard stop at the cap" sub={hard ? 'AI pauses until next month or until you raise the cap' : 'You get an alert, AI keeps running'}>
            <Toggle label="Hard stop at cap" on={hard} onChange={() => setHard(!hard)} />
          </Row>
        </Group>

        <Group title="Allowance by brand" desc="Each brand gets a share of the cap.">
          <div className={x.meters}>
            {shown.map((b) => (
              <Meter key={b.id} label={<><BrandChip id={b.id} size={18} />{b.name}</>} used={SPENT_BY[b.id]} cap={Math.round(cap * SHARE[b.id] * 100) / 100} fmt={usd} />
            ))}
          </div>
          <div className={x.hint}><Bot size={15} /><span>Per-agent budgets are set on each agent.</span><Button size="sm" variant="light" onClick={() => onGo('agents')}>Open Agents</Button></div>
        </Group>

        <Group title="Providers" desc="Where AI requests go. The default model is used unless an agent sets its own."
          actions={<Select label="Default model" value={model} onChange={setModel} options={[{ id: 'claude-haiku-4-5', label: 'Haiku 4.5' }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, { id: 'claude-opus-5-5', label: 'Opus 5.5' }]} width={150} />}>
          <div>
            {providers.map((p) => (
              <Row key={p.id} icon={p.icon} title={p.name} sub={p.sub}>
                <Toggle label={p.name} on={prov[p.id]} onChange={() => setProv((m) => ({ ...m, [p.id]: !m[p.id] }))} />
              </Row>
            ))}
          </div>
        </Group>

        <Group title="Policies">
          <div>
            <Row title="Approved sources only" sub="AI only reads docs and data marked approved"><Toggle label="Approved sources only" on={pol.approved} onChange={() => setPol((p) => ({ ...p, approved: !p.approved }))} /></Row>
            <Row title="Redact secrets" sub="Keys and passwords are masked before any request"><Toggle label="Redact secrets" on={pol.redact} onChange={() => setPol((p) => ({ ...p, redact: !p.redact }))} /></Row>
            <Row title="Zero retention" sub="Providers may not store prompts"><Toggle label="Zero retention" on={pol.retention} onChange={() => setPol((p) => ({ ...p, retention: !p.retention }))} /></Row>
            <Row title="Approve external actions" sub="Anything leaving the workspace waits for a person"><Toggle label="Approve external actions" on={pol.external} onChange={() => setPol((p) => ({ ...p, external: !p.external }))} /></Row>
            <Row title="Web search" sub={pol.web ? 'On · results are cited' : 'Off'}><Toggle label="Web search" on={pol.web} onChange={() => setPol((p) => ({ ...p, web: !p.web }))} /></Row>
          </div>
        </Group>
      </div>
    </>
  );
}

/* =====================================================================
 * Billing & usage
 * ===================================================================== */

const PLANS = [
  { id: 'solo', name: 'Solo', price: 9, brands: 1, ai: 15 },
  { id: 'founder', name: 'Founder', price: 19, brands: 3, ai: 40 },
  { id: 'team', name: 'Team', price: 49, brands: 10, ai: 120 },
];
const PROJ: Record<string, number> = { 'AI spend': 34.1, 'Automation runs': 760, 'Agent runs': 312, Storage: 3.6 };

export function BillingSection() {
  const { toast } = useApp();
  const [cycle, setCycle] = useState<'monthly' | 'annual'>('monthly');
  const [plan, setPlan] = useState('founder');
  const cur = PLANS.find((p) => p.id === plan)!;
  const price = cycle === 'annual' ? cur.price * 10 : cur.price;

  return (
    <>
      <SectionHeader title="Billing & usage" actions={<Button variant="light" icon={<KeyRound size={15} />} onClick={() => toast('Payment portal opened (Dodo)')}>Payment method</Button>} />
      <div className={x.body}>
        <Group title="Plan" desc={`Renews ${billing.renews} · paid with Visa 4242 through Dodo Payments`}
          actions={<Segmented sub size="sm" value={cycle} onChange={setCycle} options={[{ id: 'monthly', label: 'Monthly' }, { id: 'annual', label: 'Annual · 2 months free' }]} />}>
          <div className={x.planNow}><b>{cur.name} · ${price}/{cycle === 'annual' ? 'yr' : 'mo'}</b><span>{cur.brands} brands · 1 seat · {billing.guests} guests · ${cur.ai} AI included</span></div>
          <div className={x.plans}>
            {PLANS.map((p) => (
              <button key={p.id} className={plan === p.id ? x.planOn : x.plan} aria-pressed={plan === p.id} onClick={() => {
                if (p.id === plan) return;
                const diff = ((p.price - cur.price) * 25) / 31;
                setPlan(p.id);
                toast(diff > 0 ? `${p.name} · $${diff.toFixed(2)} prorated today` : `${p.name} from 1 Nov`);
              }}>
                <span className={x.planTop}>{p.name}{plan === p.id ? <Badge tone="ink">Current</Badge> : null}</span>
                <span className={x.planAmt}>${p.price}<em>/mo</em></span>
                <span className={x.planLine}>{p.brands} brands · ${p.ai} AI a month</span>
              </button>
            ))}
          </div>
        </Group>

        <Group title="Usage this month" desc="Hatched area is the projection to month end.">
          <div className={x.meters}>
            {billing.usage.map((m) => (
              <Meter key={m.label} label={m.label} used={m.used} cap={m.cap} projected={PROJ[m.label]}
                fmt={(v) => (m.unit === '$' ? `$${v.toFixed(2)}` : m.unit ? `${v} ${m.unit}` : v.toLocaleString())} />
            ))}
          </div>
        </Group>

        <Group title="Invoices">
          <div>
            {billing.invoices.map((iv) => (
              <Row key={iv.id} icon={<FileSpreadsheet size={15} />} title={iv.id} sub={iv.date}>
                <span className={x.num}>${iv.amount.toFixed(2)}</span>
                <Badge tone="green" dot>{iv.status}</Badge>
                <Button size="sm" variant="light" icon={<Download size={13} />} onClick={() => toast(`${iv.id} downloaded`)}>PDF</Button>
              </Row>
            ))}
          </div>
        </Group>
      </div>
    </>
  );
}

/* =====================================================================
 * Notifications
 * ===================================================================== */

const EVENTS = ['Assignments', 'Mentions', 'Review requests', 'Approvals', 'Blockers', 'Due soon', 'Overdue', 'Integration failures', 'Automation failures', 'Agent failures', 'Spend limits', 'Permission changes'];
const CHANNELS = [
  { id: 'app', label: 'Inbox', icon: Bell },
  { id: 'email', label: 'Email', icon: Mail },
  { id: 'browser', label: 'Browser', icon: Monitor },
  { id: 'digest', label: 'Digest', icon: Clock },
] as const;
const seedMatrix = () => EVENTS.map((_, i) => [true, i % 3 !== 1, i < 5 || i > 8, i % 2 === 0]);
const HOURS = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);

export function NotificationsSection() {
  const { toast } = useApp();
  const { brand } = useWorkspace();
  const [m, setM] = useState<boolean[][]>(seedMatrix);
  const [quiet, setQuiet] = useState(true);
  const [qFrom, setQFrom] = useState('20:00');
  const [qTo, setQTo] = useState('08:00');
  const [weekend, setWeekend] = useState(true);
  const [digest, setDigest] = useState<'daily' | 'weekly'>('daily');
  const [muted, setMuted] = useState<Record<BrandId, boolean>>({ ma: false, ax: true, op: false });
  const flip = (r: number, c: number) => setM((v) => v.map((row, i) => (i === r ? row.map((on, j) => (j === c ? !on : on)) : row)));
  const col = (c: number) => setM((v) => { const allOn = v.every((r) => r[c]); return v.map((r) => r.map((on, j) => (j === c ? !allOn : on))); });
  const a = Number(qFrom.slice(0, 2));
  const b = Number(qTo.slice(0, 2));
  const isQuiet = (h: number) => (a <= b ? h >= a && h < b : h >= a || h < b);

  return (
    <>
      <SectionHeader title="Notifications" actions={<Button variant="light" icon={<RotateCcw size={15} />} onClick={() => { setM(seedMatrix); toast('Defaults restored'); }}>Restore defaults</Button>} />
      <div className={x.body}>
        <Group title="What reaches you, and where" desc="Click a channel name to switch the whole column.">
          <div className={x.nTable}>
            <span className={x.nHeadLabel}>Event</span>
            {CHANNELS.map((c, j) => <button key={c.id} className={x.nHead} onClick={() => col(j)} title={`Toggle all ${c.label}`}><c.icon size={14} />{c.label}</button>)}
            {EVENTS.map((e, i) => (
              <NotifRow key={e} label={e} values={m[i]} onFlip={(j) => flip(i, j)} />
            ))}
          </div>
        </Group>

        <Group title="Quiet hours" desc="Only urgent items reach you in this window." actions={<Toggle label="Quiet hours" on={quiet} onChange={() => setQuiet(!quiet)} />}>
          <div className={x.inline}>
            <Select size="md" label="Quiet from" value={qFrom} onChange={setQFrom} options={HOURS} width={110} disabled={!quiet} />
            <ArrowRight size={14} className={x.mute} />
            <Select size="md" label="Quiet until" value={qTo} onChange={setQTo} options={HOURS} width={110} disabled={!quiet} />
          </div>
          <div style={{ opacity: quiet ? 1 : 0.45, display: 'grid', gap: 6 }}>
            <div className={x.dayBar} aria-hidden>
              {HOURS.map((h, i) => <i key={h} className={isQuiet(i) ? x.dayQuiet : x.dayOn} />)}
              <span className={x.nowMark} style={{ left: `${((10 + 40 / 60) / 24) * 100}%` }} />
            </div>
            <div className={x.dayScale}><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
          </div>
          <Row title="Quiet all weekend"><Toggle label="Quiet all weekend" on={weekend} onChange={() => setWeekend(!weekend)} /></Row>
        </Group>

        <Group title="Digest" desc="One summary of everything you did not see." actions={<Segmented sub size="sm" value={digest} onChange={setDigest} options={[{ id: 'daily', label: 'Daily' }, { id: 'weekly', label: 'Weekly' }]} />}>
          <span className={x.mute} style={{ fontSize: 13 }}>{digest === 'daily' ? 'Every day at 08:00' : 'Mondays at 08:00'}</span>
        </Group>

        <Group title="Brands" desc="Mute a brand to stop all of its notifications.">
          <div>
            {brands.filter((y) => !brand || y.id === brand).map((y) => (
              <Row key={y.id} icon={<BrandChip id={y.id} size={24} />} title={y.name} sub={muted[y.id] ? 'Muted' : 'On'}>
                <Toggle label={`Notify for ${y.name}`} on={!muted[y.id]} onChange={() => setMuted((mm) => ({ ...mm, [y.id]: !mm[y.id] }))} />
              </Row>
            ))}
          </div>
        </Group>
      </div>
    </>
  );
}

function NotifRow({ label, values, onFlip }: { label: string; values: boolean[]; onFlip: (j: number) => void }) {
  const off = values.every((v) => !v);
  return (
    <>
      <span className={x.nLabel}>{label}{off ? <Badge tone="neutral">Muted</Badge> : null}</span>
      {values.map((v, j) => (
        <span key={j} className={x.nCell}><Checkbox on={v} onChange={() => onFlip(j)} label={`${label} by ${CHANNELS[j].label}`} /></span>
      ))}
    </>
  );
}

/* =====================================================================
 * Security
 * ===================================================================== */

const SESSIONS = [
  { id: 's1', device: 'MacBook Pro', app: 'Chrome', where: 'London', last: 'Now', icon: Laptop, current: true },
  { id: 's2', device: 'iPhone 17', app: 'Safari', where: 'London', last: '2h ago', icon: Smartphone },
  { id: 's3', device: 'Windows PC', app: 'Edge', where: 'Berlin', last: '3d ago', icon: Monitor, flag: true },
  { id: 's4', device: 'CLI', app: 'API token', where: 'GitHub Actions', last: '12m ago', icon: KeyRound },
];
const LOG = [
  { t: '09:12', text: 'Sign-in from a new location (Berlin)', tone: 'amber' as const, icon: ShieldAlert },
  { t: 'Yesterday', text: 'API token rotated', tone: 'neutral' as const, icon: KeyRound },
  { t: '2 Oct', text: 'Lea Novak changed to Guest', tone: 'neutral' as const, icon: Users },
  { t: '28 Sep', text: 'Workspace export downloaded', tone: 'neutral' as const, icon: Download },
  { t: '21 Sep', text: 'Passkey added', tone: 'green' as const, icon: ShieldCheck },
];

export function SecuritySection() {
  const { toast } = useApp();
  const [sessions, setSessions] = useState(SESSIONS);
  const [ret, setRet] = useState({ activity: '1 year', ai: '90 days', deleted: '30 days', runs: '180 days' });

  return (
    <>
      <SectionHeader title="Security" actions={<Button variant="dark" icon={<Plus size={15} />} onClick={() => toast('Passkey prompt opened')}>Add passkey</Button>} />
      <div className={x.body}>
        <Group title="Two-factor sign-in" actions={<Badge tone="green" dot>On</Badge>}>
          <div>
            <Row icon={<ShieldCheck size={15} />} title="Authenticator app" sub="Primary method"><Badge tone="neutral">Primary</Badge></Row>
            <Row icon={<Laptop size={15} />} title="Passkey · Mac" sub="Added 21 Sep" />
            <Row icon={<Smartphone size={15} />} title="Passkey · iPhone" sub="Added 21 Sep" />
            <Row icon={<KeyRound size={15} />} title="Recovery codes" sub="8 of 10 left">
              <Button size="sm" variant="light" onClick={() => toast('New recovery codes generated')}>Regenerate</Button>
            </Row>
          </div>
        </Group>

        <Group title="Signed-in devices" actions={<Button size="sm" variant="light" icon={<LogOut size={13} />} disabled={sessions.length <= 1}
          onClick={() => { setSessions((ss) => ss.filter((y) => y.current)); toast('Other devices signed out'); }}>Sign out others</Button>}>
          <div>
            {sessions.map((y) => (
              <Row key={y.id} icon={<y.icon size={16} />} title={`${y.device} · ${y.app}`} sub={`${y.where} · ${y.last}`}>
                {y.current ? <Badge tone="accent" dot>This device</Badge> : (
                  <>
                    {y.flag ? <Badge tone="amber" dot>New location</Badge> : null}
                    <Button size="sm" variant="light" onClick={() => { setSessions((ss) => ss.filter((z) => z.id !== y.id)); toast(`${y.device} signed out`); }}>Sign out</Button>
                  </>
                )}
              </Row>
            ))}
          </div>
        </Group>

        <Group title="Security log">
          <div>
            {LOG.map((l) => (
              <Row key={l.text} icon={<l.icon size={14} />} title={l.text}>
                {l.tone === 'amber' ? <Badge tone="amber" dot>Review</Badge> : null}
                <span className={x.num}>{l.t}</span>
              </Row>
            ))}
          </div>
        </Group>

        <Group title="Data retention" desc="How long records are kept before they are deleted for good.">
          <div>
            <Row title="Activity log"><Select label="Activity log" value={ret.activity} onChange={(v) => setRet((r) => ({ ...r, activity: v }))} options={['90 days', '1 year', '3 years', 'Forever']} width={130} /></Row>
            <Row title="AI history"><Select label="AI history" value={ret.ai} onChange={(v) => setRet((r) => ({ ...r, ai: v }))} options={['30 days', '90 days', '1 year']} width={130} /></Row>
            <Row title="Agent runs"><Select label="Agent runs" value={ret.runs} onChange={(v) => setRet((r) => ({ ...r, runs: v }))} options={['90 days', '180 days', '1 year']} width={130} /></Row>
            <Row title="Deleted items"><Select label="Deleted items" value={ret.deleted} onChange={(v) => setRet((r) => ({ ...r, deleted: v }))} options={['7 days', '30 days', '90 days']} width={130} /></Row>
          </div>
        </Group>
      </div>
    </>
  );
}

/* =====================================================================
 * Import / export
 * ===================================================================== */

const FIELDS = ['Title', 'Status', 'Assignee', 'Due date', 'Project', 'Labels', 'Estimate', 'Description', 'External ID', 'Skip'] as const;
type FieldId = (typeof FIELDS)[number];
const COLUMNS: { src: string; sample: string; to: FieldId; errors?: number }[] = [
  { src: 'Task name', sample: 'Fix login redirect', to: 'Title' },
  { src: 'State', sample: 'In Progress', to: 'Status' },
  { src: 'Owner email', sample: 'dev@lavelle.dev', to: 'Assignee' },
  { src: 'Deadline', sample: '31/02/2026', to: 'Due date', errors: 2 },
  { src: 'List', sample: 'Android runner', to: 'Project' },
  { src: 'Tags', sample: 'bug, android', to: 'Labels' },
  { src: 'Hours', sample: '1.5', to: 'Estimate' },
  { src: 'Legacy ID', sample: 'TR-4471', to: 'External ID' },
];
const TOTAL_ROWS = 148;

export function ImportSection() {
  const { toast } = useApp();
  const [source, setSource] = useState<'csv' | 'linear' | 'jira' | 'asana'>('csv');
  const [stage, setStage] = useState<'empty' | 'parsing' | 'mapped'>('empty');
  const [map, setMap] = useState<Record<string, FieldId>>(() => Object.fromEntries(COLUMNS.map((c) => [c.src, c.to])));
  const [target, setTarget] = useState<BrandId>('op');
  const [scope, setScope] = useState({ tasks: true, docs: true, comments: true, activity: false, ai: false, time: true });
  const [fmt, setFmt] = useState<'csv' | 'json' | 'md'>('csv');
  const [history, setHistory] = useState([
    { id: 'h1', name: 'trello-board.csv', rows: 62, when: '2 Oct', state: 'done' as 'done' | 'rolled' },
    { id: 'h2', name: 'clients.csv', rows: 18, when: '14 Sep', state: 'done' as 'done' | 'rolled' },
  ]);
  const errors = useMemo(() => COLUMNS.reduce((n, c) => n + (map[c.src] !== 'Skip' && map[c.src] === c.to && c.errors ? c.errors : 0), 0), [map]);
  const ready = TOTAL_ROWS - errors;
  const load = () => { setStage('parsing'); setTimeout(() => setStage('mapped'), 900); };
  const sets = Object.values(scope).filter(Boolean).length;

  return (
    <>
      <SectionHeader title="Import / export" actions={<Button variant="dark" icon={<Download size={15} />} disabled={!sets} onClick={() => toast(`Export ready · ${sets} sets · ${fmt.toUpperCase()}`)}>Export data</Button>} />
      <div className={x.body}>
        <Group title="Import" desc="Bring tasks in from a file or another tool. Nothing is saved until you press Import."
          actions={<Segmented sub size="sm" value={source} onChange={(v) => { setSource(v); if (v !== 'csv') toast('Coming after launch'); }} options={[
            { id: 'csv', label: 'CSV' }, { id: 'linear', label: 'Linear' }, { id: 'jira', label: 'Jira' }, { id: 'asana', label: 'Asana' },
          ]} />}>
          {stage !== 'mapped' ? (
            <button className={x.drop} onClick={load} disabled={stage === 'parsing'}>
              <span className={x.dropIcon}>{stage === 'parsing' ? <ScanLine size={22} className="anim-pulse" /> : <FileUp size={22} />}</span>
              <span><b>{stage === 'parsing' ? 'Reading tasks-export.csv…' : 'Drop a CSV or click to choose'}</b>{stage === 'parsing' ? `${TOTAL_ROWS} rows` : 'Columns are matched to fields automatically'}</span>
            </button>
          ) : (
            <>
              <Row icon={<FileSpreadsheet size={16} />} title="tasks-export.csv" sub={`${TOTAL_ROWS} rows · 8 columns`}>
                <span className={x.mute} style={{ fontSize: 13, fontWeight: 600 }}>Into</span>
                <Select label="Target brand" value={target} onChange={setTarget} options={brands.map((b) => ({ id: b.id, label: b.name }))} width={140} />
                <Button size="sm" variant="text" onClick={() => setStage('empty')}>Replace file</Button>
              </Row>
              <div className={u.tableWrap}>
                <table className={u.table}>
                  <thead><tr><th>Column</th><th>Sample</th><th>Maps to</th><th>Check</th></tr></thead>
                  <tbody>
                    {COLUMNS.map((c) => {
                      const to = map[c.src];
                      const err = to === c.to && c.errors && to !== 'Skip';
                      return (
                        <tr key={c.src} style={{ cursor: 'default' }}>
                          <td><b>{c.src}</b></td>
                          <td className={x.mute}>{c.sample}</td>
                          <td><Select label={`${c.src} maps to`} value={to} onChange={(v) => setMap((mm) => ({ ...mm, [c.src]: v }))} options={[...FIELDS]} width={150} /></td>
                          <td>{to === 'Skip' ? <Badge tone="outline">Skipped</Badge> : err ? <Badge tone="red" dot>{c.errors} bad rows</Badge> : <Badge tone="green" dot>OK</Badge>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className={x.importFoot}>
                <span className={x.inline}>
                  <b>{ready} ready</b>
                  {errors ? <span className={x.badText}>{errors} errors in rows 41 and 97</span> : <span className={x.okText}><Check size={13} />No errors</span>}
                </span>
                <span className={x.inline}>
                  <Button size="sm" variant="light" onClick={() => toast('Mapping saved')}>Save mapping</Button>
                  <Button size="sm" variant="dark" icon={<FileUp size={14} />} onClick={() => {
                    setHistory((h) => [{ id: `h${h.length + 1}`, name: 'tasks-export.csv', rows: ready, when: 'Now', state: 'done' }, ...h]);
                    setStage('empty');
                    toast(`${ready} tasks imported into ${brandName(target)}`);
                  }}>Import {ready} tasks</Button>
                </span>
              </div>
            </>
          )}
        </Group>

        <Group title="Export" desc="Download a copy of your workspace.">
          <div className={x.checkGrid}>
            {([['tasks', 'Tasks'], ['docs', 'Docs'], ['comments', 'Comments'], ['activity', 'Activity'], ['ai', 'AI history'], ['time', 'Time']] as const).map(([k, l]) => (
              <button key={k} type="button" className={scope[k] ? x.checkPillOn : x.checkPill} aria-pressed={scope[k]} onClick={() => setScope((s) => ({ ...s, [k]: !s[k] }))}>
                <i>{scope[k] ? <Check size={11} strokeWidth={3} /> : null}</i>{l}
              </button>
            ))}
          </div>
          <Field label="Format" group>
            <Segmented sub size="sm" value={fmt} onChange={setFmt} options={[{ id: 'csv', label: 'CSV' }, { id: 'json', label: 'JSON' }, { id: 'md', label: 'Markdown' }]} />
          </Field>
        </Group>

        <Group title="Import history" desc="Undo removes everything that import created.">
          <div>
            {history.map((h) => (
              <Row key={h.id} icon={<FileSpreadsheet size={15} />} title={h.name} sub={`${h.rows} rows · ${h.when}`}>
                {h.state === 'done' ? (
                  <Button size="sm" variant="light" icon={<Undo2 size={13} />} onClick={() => { setHistory((hs) => hs.map((y) => (y.id === h.id ? { ...y, state: 'rolled' } : y))); toast(`${h.name} rolled back`); }}>Undo import</Button>
                ) : <Badge tone="neutral">Rolled back</Badge>}
              </Row>
            ))}
          </div>
        </Group>
      </div>
    </>
  );
}
