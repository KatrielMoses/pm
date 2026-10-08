'use client';

/*
 * Settings › Agents: agent profiles (model, tools, approval policy, budget). Agents are assignees;
 * their finished work arrives in Inbox › Reviews, so this page is setup only.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronRight, Inbox, Plus } from 'lucide-react';
import { useApp } from '@/lib/app-state';
import { useWorkspace } from '@/lib/workspace';
import { brands, type BrandId } from '@/lib/data';
import { agents as seed, type AgentProfile } from '@/lib/app-data';
import { BrandChip } from '@/components/brand';
import { Avatar, Badge, Button, Segmented, Toggle } from '@/components/paper/ui';
import { Select } from './select';
import { cx, Field, Group, SectionHeader, x } from './parts';

const MODELS = [
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 · fast, cheapest' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 · balanced' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5 · hardest work' },
];
const TOOLS = ['GitHub', 'Tests', 'MCP', 'Optestra', 'Web', 'Docs'];
const APPROVAL: { id: AgentProfile['approval']; label: string; help: string }[] = [
  { id: 'always', label: 'Approve everything', help: 'You approve every deliverable before it lands' },
  { id: 'external', label: 'Approve external', help: 'Only actions outside the workspace (PRs, publishing, email) wait for you' },
  { id: 'none', label: 'Automatic', help: 'Runs and applies changes on its own; you can still review in Inbox' },
];
const approvalShort = { always: 'Approve everything', external: 'Approve external', none: 'Automatic' } as const;
const money = (n: number) => `$${n.toFixed(2)}`;

type Draft = AgentProfile & { on: boolean };

export function AgentsSection() {
  const router = useRouter();
  const { toast } = useApp();
  const { brand } = useWorkspace();
  const [list, setList] = useState<Draft[]>(() => seed.map((a) => ({ ...a, tools: [...a.tools], brands: [...a.brands], on: true })));
  const [open, setOpen] = useState<string | null>('ag-dev');
  const [draft, setDraft] = useState<Draft | null>(() => ({ ...seed[0], tools: [...seed[0].tools], brands: [...seed[0].brands], on: true }));

  const shown = list.filter((a) => !brand || a.brands.includes(brand));
  const totalBudget = shown.reduce((n, a) => n + a.budget, 0);
  const totalSpent = shown.reduce((n, a) => n + a.spent, 0);

  const expand = (a: Draft) => {
    if (open === a.id) { setOpen(null); setDraft(null); return; }
    setOpen(a.id);
    setDraft({ ...a, tools: [...a.tools], brands: [...a.brands] });
  };
  const save = () => {
    if (!draft) return;
    setList((l) => l.map((a) => (a.id === draft.id ? draft : a)));
    toast(`${draft.name} saved`);
    setOpen(null); setDraft(null);
  };
  const toggleIn = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((y) => y !== v) : [...arr, v]);
  const create = () => {
    const a: Draft = { id: `ag-new${list.length}`, name: 'New agent', purpose: 'Describe what it does', brands: brand ? [brand] : ['op'], model: 'claude-haiku-4-5', tools: ['Docs'], approval: 'always', budget: 5, spent: 0, runs7d: 0, success: 0, on: false };
    setList((l) => [a, ...l]);
    setOpen(a.id); setDraft(a);
    toast('Draft agent added · paused until saved');
  };

  return (
    <>
      <SectionHeader title="Agents" actions={<Button variant="dark" icon={<Plus size={15} />} onClick={create}>New agent</Button>} />
      <div className={x.body}>
        <div className={x.hint}>
          <Inbox size={15} />
          <span>Assign tasks to an agent like a teammate. Finished work, failures and approvals arrive in <b>Inbox › Reviews</b>.</span>
          <Button size="sm" variant="light" onClick={() => router.push('/app/inbox')}>Open Inbox</Button>
        </div>

        <Group title="Agent profiles" desc={`${shown.length} agents · ${money(totalSpent)} of ${money(totalBudget)} monthly budget used`} flush>
          {shown.map((a) => {
            const isOpen = open === a.id && draft;
            const hot = a.spent / a.budget > 0.8;
            return (
              <div key={a.id} className={cx(x.item, isOpen && x.itemOn, !a.on && x.itemOff)}>
                <div className={x.inline} style={{ width: '100%', flexWrap: 'nowrap' }}>
                  <button className={x.itemHead} onClick={() => expand(a)} aria-expanded={!!isOpen}>
                    {a.id.startsWith('ag-new') ? <span className={x.rowIcon}><Plus size={15} /></span> : <Avatar id={a.id} size={34} />}
                    <span className={x.itemMain}>
                      <b>{a.name}</b>
                      <span>{a.brands.map((b) => <BrandChip key={b} id={b} size={14} />)}{a.purpose} · {MODELS.find((m) => m.id === a.model)?.label.split(' ·')[0] ?? a.model} · {approvalShort[a.approval]}</span>
                    </span>
                    <span className={x.itemBudget}>
                      <span><b>{money(a.spent)}</b>of ${a.budget}</span>
                      <span className={x.meterBar} style={{ height: 6 }}><i className={hot ? x.meterHot : x.meterUsed} style={{ width: `${Math.min(100, (a.spent / a.budget) * 100)}%` }} /></span>
                    </span>
                    <span className={x.itemSide}>
                      {a.runs7d ? <span className={x.num}>{a.runs7d} runs · <span className={a.success < 80 ? x.badText : undefined}>{a.success}%</span></span> : <Badge tone="outline">New</Badge>}
                      <ChevronRight size={16} className={cx(x.chev, isOpen && x.chevOpen)} />
                    </span>
                  </button>
                  <span style={{ paddingRight: 14 }}>
                    <Toggle on={a.on} label={`${a.name} enabled`} onChange={() => { setList((l) => l.map((y) => (y.id === a.id ? { ...y, on: !y.on } : y))); toast(`${a.name} ${a.on ? 'paused' : 'enabled'}`); }} />
                  </span>
                </div>

                {isOpen && draft ? (
                  <div className={x.editor}>
                    <div className={x.fields}>
                      <Field label="Name"><input className={x.input} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
                      <Field label="Purpose"><input className={x.input} value={draft.purpose} onChange={(e) => setDraft({ ...draft, purpose: e.target.value })} /></Field>
                      <Field label="Model"><Select size="md" label="Model" value={draft.model} onChange={(v) => setDraft({ ...draft, model: v })} options={MODELS} /></Field>
                      <Field label="Monthly budget (USD)">
                        <input className={x.input} type="number" min={1} max={500} value={draft.budget} onChange={(e) => setDraft({ ...draft, budget: Math.max(1, Number(e.target.value) || 1) })} />
                      </Field>
                      <Field label="Approval policy" wide group>
                        <Segmented<AgentProfile['approval']> sub size="sm" value={draft.approval} onChange={(v) => setDraft({ ...draft, approval: v })} options={APPROVAL.map((p) => ({ id: p.id, label: p.label }))} />
                        <span className={x.mute} style={{ fontWeight: 500 }}>{APPROVAL.find((p) => p.id === draft.approval)?.help}</span>
                      </Field>
                      <Field label="Tools it may use" wide group>
                        <span className={x.checkGrid}>
                          {TOOLS.map((t) => {
                            const on = draft.tools.includes(t);
                            return <button key={t} type="button" className={on ? x.checkPillOn : x.checkPill} aria-pressed={on} onClick={() => setDraft({ ...draft, tools: toggleIn(draft.tools, t) })}><i>{on ? <Check size={11} strokeWidth={3} /> : null}</i>{t}</button>;
                          })}
                        </span>
                      </Field>
                      <Field label="Brands it works for" wide group>
                        <span className={x.checkGrid}>
                          {brands.map((b) => {
                            const on = draft.brands.includes(b.id);
                            return (
                              <button key={b.id} type="button" className={on ? x.checkPillOn : x.checkPill} aria-pressed={on}
                                onClick={() => setDraft({ ...draft, brands: toggleIn<BrandId>(draft.brands, b.id) })}>
                                <BrandChip id={b.id} size={16} />{b.name}
                              </button>
                            );
                          })}
                        </span>
                      </Field>
                    </div>
                    <div className={x.editorFoot}>
                      <Button size="sm" variant="text" onClick={() => { setOpen(null); setDraft(null); }}>Cancel</Button>
                      <Button size="sm" variant="dark" icon={<Check size={14} />} disabled={!draft.brands.length || !draft.name.trim()} onClick={save}>Save agent</Button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
          {shown.length === 0 ? (
            <div className={x.hint} style={{ margin: 8 }}>No agents work for this brand yet.<Button size="sm" variant="light" icon={<Plus size={14} />} onClick={create}>New agent</Button></div>
          ) : null}
        </Group>
      </div>
    </>
  );
}
