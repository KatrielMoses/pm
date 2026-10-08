'use client';

/* Settings › Workspace: General and Members & roles. Brands & identity kits lives in brands.tsx. */

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Bot, Check, CircleAlert, Globe, Monitor, Moon, Sun, Trash, UserPlus } from 'lucide-react';
import { useApp } from '@/lib/app-state';
import { useWorkspace } from '@/lib/workspace';
import { brands, type BrandId } from '@/lib/data';
import { people, type Person } from '@/lib/app-data';
import { BrandChip, LogoMark } from '@/components/brand';
import { Avatar, Badge, Button, Segmented, Toggle, u } from '@/components/paper/ui';
import { Select } from './select';
import { Field, Group, Row, SectionHeader, x } from './parts';

/* =====================================================================
 * General
 * ===================================================================== */

export function GeneralSection() {
  const { toast, mode, setMode, density, setDensity } = useApp();
  const [name, setName] = useState('Lavelle Labs');
  const [tz, setTz] = useState('Europe/London');
  const [locale, setLocale] = useState('English (UK)');
  const [cur, setCur] = useState('USD');
  const [week, setWeek] = useState<'mon' | 'sun'>('mon');
  const [from, setFrom] = useState('09:00');
  const [to, setTo] = useState('18:00');
  const [defs, setDefs] = useState({ allHome: true, share: false, sample: true, brief: true });
  const [owner, setOwner] = useState('dp');
  const [confirm, setConfirm] = useState(false);
  const [sys, setSys] = useState(false);
  const hours = ['07:00', '08:00', '09:00', '10:00', '17:00', '18:00', '19:00', '20:00'];

  // "System" follows the OS colour scheme while selected
  useEffect(() => {
    if (!sys) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setMode(mq.matches ? 'dark' : 'light');
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [sys, setMode]);

  return (
    <>
      <SectionHeader title="General" actions={<Button variant="dark" icon={<Check size={15} />} onClick={() => toast('Workspace saved')}>Save changes</Button>} />
      <div className={x.body}>
        <Group title="Workspace" desc="Name, region and working hours used for plans and due dates.">
          <div className={x.profile}>
            <LogoMark size={56} radius={18} bg="var(--ink)" fg="var(--ink-text)" />
            <div className={x.grow}><Field label="Name"><input className={x.input} value={name} onChange={(e) => setName(e.target.value)} /></Field></div>
            <Button size="sm" variant="light" onClick={() => toast('Logo updated')}>Change logo</Button>
          </div>
          <div className={x.fields}>
            <Field label="Workspace URL" wide><span className={x.url}><Globe size={14} /> app.untitled.dev/<b>{name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}</b></span></Field>
            <Field label="Timezone"><Select size="md" label="Timezone" value={tz} onChange={setTz} options={['Europe/London', 'UTC', 'America/New_York', 'Asia/Kolkata']} /></Field>
            <Field label="Locale"><Select size="md" label="Locale" value={locale} onChange={setLocale} options={['English (UK)', 'English (US)', 'Deutsch', 'Français']} /></Field>
            <Field label="Currency"><Select size="md" label="Currency" value={cur} onChange={setCur} options={['USD', 'GBP', 'EUR']} /></Field>
            <Field label="Week starts on" group>
              <Segmented sub size="sm" value={week} onChange={setWeek} options={[{ id: 'mon', label: 'Monday' }, { id: 'sun', label: 'Sunday' }]} />
            </Field>
            <Field label="Working hours" wide group>
              <span className={x.inline}><Select size="md" label="From" value={from} onChange={setFrom} options={hours} width={120} /><ArrowRight size={14} className={x.mute} /><Select size="md" label="To" value={to} onChange={setTo} options={hours} width={120} /></span>
            </Field>
          </div>
        </Group>

        <Group title="Appearance" desc="Only changes how the app looks for you.">
          <Row title="Theme">
            <Segmented<'light' | 'dark' | 'system'> sub size="sm" value={sys ? 'system' : mode} onChange={(v) => { if (v === 'system') { setSys(true); return; } setSys(false); setMode(v); }} options={[
              { id: 'light', label: 'Light', icon: <Sun size={13} /> },
              { id: 'dark', label: 'Dark', icon: <Moon size={13} /> },
              { id: 'system', label: 'System', icon: <Monitor size={13} /> },
            ]} />
          </Row>
          <Row title="Compact density" sub="Smaller text and tighter rows">
            <Toggle label="Compact density" on={density === 'compact'} onChange={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')} />
          </Row>
        </Group>

        <Group title="Defaults">
          <Row title="Home shows all brands" sub="Otherwise Home opens on the last brand you used">
            <Toggle label="Home shows all brands" on={defs.allHome} onChange={() => setDefs((d) => ({ ...d, allHome: !d.allHome }))} />
          </Row>
          <Row title="Cross-brand sharing" sub={defs.share ? 'Members can see work across brands they belong to' : 'Each brand is isolated'}>
            <Toggle label="Cross-brand sharing" on={defs.share} onChange={() => setDefs((d) => ({ ...d, share: !d.share }))} />
          </Row>
          <Row title="Daily briefing" sub="Sent at 08:00 in app and by email">
            <Toggle label="Daily briefing" on={defs.brief} onChange={() => setDefs((d) => ({ ...d, brief: !d.brief }))} />
          </Row>
          <Row title="Sample data" sub={defs.sample ? '42 sample records' : 'Removed'}>
            {defs.sample ? <Button size="sm" variant="light" onClick={() => { setDefs((d) => ({ ...d, sample: false })); toast('Sample data removed'); }}>Remove</Button> : <Badge tone="green" dot>Clean</Badge>}
          </Row>
        </Group>

        <Group title="Ownership and deletion">
          <Row title="Transfer ownership" sub="The new owner must accept">
            <Select label="New owner" value={owner} onChange={setOwner} options={people.filter((p) => p.kind === 'human' && p.id !== 'km').map((p) => ({ id: p.id, label: p.name }))} width={140} />
            <Button size="sm" variant="light" onClick={() => toast('Transfer request sent')}>Transfer</Button>
          </Row>
          <Row title="Delete workspace" sub="Recoverable for 30 days. Export first.">
            {confirm ? (
              <>
                <Button size="sm" variant="text" onClick={() => setConfirm(false)}>Cancel</Button>
                <Button size="sm" variant="danger" onClick={() => { setConfirm(false); toast('Deletion scheduled', 'bad'); }}>Delete for good</Button>
              </>
            ) : <Button size="sm" variant="light" icon={<Trash size={14} />} onClick={() => setConfirm(true)}>Delete</Button>}
          </Row>
        </Group>
      </div>
    </>
  );
}

/* =====================================================================
 * Members & roles
 * ===================================================================== */

type Role = 'Owner' | 'Admin' | 'Member' | 'Limited' | 'Guest' | 'Read-only';
const ROLE_RANK: Record<Role, number> = { 'Read-only': 1, Guest: 0, Limited: 2, Member: 3, Admin: 4, Owner: 5 };
const HUMAN_ROLES: Role[] = ['Admin', 'Member', 'Limited', 'Guest', 'Read-only'];
const RES = ['Projects', 'Tasks', 'Docs', 'Goals', 'Integrations', 'Billing', 'Members'] as const;
const ACT = ['View', 'Edit', 'Delete', 'Export', 'Approve', 'Config'] as const;
type Lvl = 0 | 1 | 2;
const work = (r: Lvl[]) => ({ Projects: r, Tasks: r, Docs: r, Goals: r });
const CAPS: Record<Role, Record<(typeof RES)[number], Lvl[]>> = {
  Owner: { ...work([2, 2, 2, 2, 2, 2]), Integrations: [2, 2, 2, 2, 2, 2], Billing: [2, 2, 2, 2, 2, 2], Members: [2, 2, 2, 2, 2, 2] },
  Admin: { ...work([2, 2, 2, 2, 2, 2]), Integrations: [2, 2, 2, 2, 2, 2], Billing: [2, 0, 0, 2, 0, 0], Members: [2, 2, 1, 2, 2, 2] },
  Member: { ...work([2, 2, 1, 2, 1, 0]), Integrations: [2, 0, 0, 0, 0, 0], Billing: [0, 0, 0, 0, 0, 0], Members: [2, 0, 0, 0, 0, 0] },
  Limited: { Projects: [1, 0, 0, 0, 0, 0], Tasks: [1, 1, 0, 0, 0, 0], Docs: [1, 1, 0, 0, 0, 0], Goals: [1, 0, 0, 0, 0, 0], Integrations: [0, 0, 0, 0, 0, 0], Billing: [0, 0, 0, 0, 0, 0], Members: [1, 0, 0, 0, 0, 0] },
  Guest: { Projects: [1, 0, 0, 0, 0, 0], Tasks: [1, 1, 0, 0, 0, 0], Docs: [1, 0, 0, 0, 0, 0], Goals: [0, 0, 0, 0, 0, 0], Integrations: [0, 0, 0, 0, 0, 0], Billing: [0, 0, 0, 0, 0, 0], Members: [0, 0, 0, 0, 0, 0] },
  'Read-only': { ...work([2, 0, 0, 0, 0, 0]), Integrations: [2, 0, 0, 0, 0, 0], Billing: [0, 0, 0, 0, 0, 0], Members: [2, 0, 0, 0, 0, 0] },
};
const SEED_ROLES: Record<string, Role> = { km: 'Owner', dp: 'Admin', ar: 'Member', ln: 'Guest' };
const LAST: Record<string, string> = { km: 'Now', dp: '12m ago', ar: '3h ago', ln: '2d ago' };
const MFA: Record<string, boolean> = { km: true, dp: true, ar: false, ln: false };

export function MembersSection({ onGo }: { onGo: (id: string) => void }) {
  const { toast } = useApp();
  const { brand } = useWorkspace();
  const [roles, setRoles] = useState<Record<string, Role>>(SEED_ROLES);
  const [sel, setSel] = useState('dp');
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('Member');
  const inviteRef = useRef<HTMLInputElement>(null);
  const humans = people.filter((p) => p.kind === 'human' && (!brand || p.brands.includes(brand)));
  const agentCount = people.filter((p) => p.kind === 'agent' && (!brand || p.brands.includes(brand))).length;
  const person = humans.find((p) => p.id === sel) ?? humans[0];
  const roleOf = (p: Person): Role => roles[p.id] ?? 'Member';
  const role = person ? roleOf(person) : 'Member';
  const exposed = person ? ROLE_RANK[role] - ROLE_RANK[SEED_ROLES[person.id] ?? 'Member'] : 0;
  const brandAccess = (id: BrandId): 'Full' | 'Shared' | 'None' => {
    if (!person) return 'None';
    if (role === 'Owner' || role === 'Admin') return 'Full';
    if (!person.brands.includes(id)) return 'None';
    return role === 'Guest' || role === 'Limited' ? 'Shared' : 'Full';
  };
  const invite = () => {
    if (!email.trim()) { toast('Add an email first', 'bad'); inviteRef.current?.focus(); return; }
    toast(`Invite sent to ${email} · ${inviteRole}`);
    setEmail('');
  };

  return (
    <>
      <SectionHeader title="Members & roles" actions={<Button variant="dark" icon={<UserPlus size={15} />} onClick={() => inviteRef.current?.focus()}>Invite member</Button>} />
      <div className={x.body}>
        <Group title="Invite" desc="Invites expire after 7 days. Guests only see the brands you share with them.">
          <div className={x.invite}>
            <input ref={inviteRef} className={x.input} placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Invite email"
              onKeyDown={(e) => { if (e.key === 'Enter') invite(); }} />
            <Select size="md" label="Invite role" value={inviteRole} onChange={setInviteRole} options={HUMAN_ROLES} width={140} />
            <Button variant="light" onClick={invite}>Send invite</Button>
          </div>
        </Group>

        <Group title="Members" desc="Pick a member to see what their role allows." flush>
          <div className={u.tableWrap} style={{ margin: '0 12px 8px' }}>
            <table className={u.table}>
              <thead><tr><th>Member</th><th>Role</th><th>Brands</th><th>Security</th><th>Last active</th></tr></thead>
              <tbody>
                {humans.map((p) => {
                  const r = roleOf(p);
                  return (
                    <tr key={p.id} className={person?.id === p.id ? u.rowOn : undefined} onClick={() => setSel(p.id)}>
                      <td><span className={x.who}><Avatar id={p.id} size={30} /><span><b>{p.name}</b><em>{p.role}</em></span></span></td>
                      <td>{r === 'Owner' ? <Badge tone="ink">Owner</Badge>
                        : <Select label={`${p.name} role`} value={r} width={124} onChange={(v) => { setRoles((m) => ({ ...m, [p.id]: v })); setSel(p.id); }} options={HUMAN_ROLES} />}</td>
                      <td><span className={x.chips}>{p.brands.map((b) => <BrandChip key={b} id={b} size={20} />)}</span></td>
                      <td>{MFA[p.id] ? <Badge tone="green" dot>2FA on</Badge> : <Badge tone="amber" dot>No 2FA</Badge>}</td>
                      <td className={x.num}>{LAST[p.id]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className={x.hint} style={{ margin: '0 12px 8px' }}>
            <Bot size={15} /><span><b>{agentCount} agents</b> have scoped access set per agent.</span>
            <Button size="sm" variant="light" onClick={() => onGo('agents')}>Open Agents</Button>
          </div>
        </Group>

        {person ? (
          <Group title={`What ${person.name} can do`} desc={`Effective permissions for the ${role} role.`}
            actions={exposed > 0 ? <Badge tone="amber" dot>+{exposed * 7} records visible</Badge> : exposed < 0 ? <Badge tone="green" dot>{Math.abs(exposed) * 7} records hidden</Badge> : null}>
            <div className={x.access}>
              {brands.map((b) => {
                const a = brandAccess(b.id);
                return <span key={b.id} className={x.accessItem}><BrandChip id={b.id} size={20} />{b.name}<Badge tone={a === 'Full' ? 'green' : a === 'Shared' ? 'amber' : 'outline'}>{a}</Badge></span>;
              })}
            </div>
            <div className={x.matrix}>
              <span />
              {ACT.map((a) => <span key={a} className={x.mxHead}>{a}</span>)}
              {RES.map((r) => (
                <MatrixRow key={r} label={r} levels={CAPS[role][r]} />
              ))}
            </div>
            <div className={x.legend}>
              <span><i className={x.mxFull} />Full</span><span><i className={x.mxPart} />Own or shared only</span><span><i className={x.mxNone} />None</span>
            </div>
            {exposed > 0 ? <span className={x.warnText} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}><CircleAlert size={14} />Raising this role exposes more records. Check before saving.</span> : null}
          </Group>
        ) : null}
      </div>
    </>
  );
}

function MatrixRow({ label, levels }: { label: string; levels: Lvl[] }) {
  return (
    <>
      <span className={x.mxLabel}>{label}</span>
      {levels.map((l, i) => (
        <span key={i} className={x.mxCell} title={`${label} · ${ACT[i]}: ${l === 2 ? 'Full' : l === 1 ? 'Own or shared' : 'None'}`}>
          <i className={l === 2 ? x.mxFull : l === 1 ? x.mxPart : x.mxNone}>{l === 2 ? <Check size={11} strokeWidth={3.2} /> : null}</i>
        </span>
      ))}
    </>
  );
}
