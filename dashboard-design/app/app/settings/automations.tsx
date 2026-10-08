'use client';

/*
 * Settings › Automations: one list of rules and one plain When / If / Then editor for the selected
 * rule. A rule must be previewed (what it would have done in the last 7 days) before it can turn on.
 */

import { useMemo, useState } from 'react';
import { ArrowRight, Eye, Plus, RotateCcw, Save, ShieldCheck, TriangleAlert, Workflow, X, Zap } from 'lucide-react';
import { useApp } from '@/lib/app-state';
import { useWorkspace } from '@/lib/workspace';
import { automations as seed, billing, byBrand } from '@/lib/app-data';
import { BrandChip } from '@/components/brand';
import { Badge, Button, Segmented, Toggle, u } from '@/components/paper/ui';
import { Select } from './select';
import { ACTIONS, actionIcon, CONDITIONS, previewFor, runsFor, TEMPLATES, TRIGGERS, triggerIcon, type Flow } from './flow';
import { cx, Group, Meter, Row, SectionHeader, x } from './parts';

const initial = (): Flow[] => seed.map((a) => ({ ...a, conditions: [...a.conditions], actions: [...a.actions], logic: 'AND', previewed: a.on }));
const usage = billing.usage.find((m) => m.label === 'Automation runs')!;

export function AutomationsSection() {
  const { brand } = useWorkspace();
  const { toast } = useApp();
  const [flows, setFlows] = useState<Flow[]>(initial);
  const [selId, setSelId] = useState('au1');
  const [preview, setPreview] = useState(false);
  const [opts, setOpts] = useState<Record<string, { loop: boolean; retry: boolean; runAs: string }>>({});
  const [retried, setRetried] = useState<Record<string, boolean>>({});

  const list = byBrand(flows, brand);
  const sel = list.find((f) => f.id === selId) ?? list[0];
  const o = sel ? opts[sel.id] ?? { loop: true, retry: true, runAs: 'Automation bot' } : null;
  const runs = useMemo(() => (sel ? runsFor(sel) : []), [sel]);
  const pv = sel ? previewFor(sel) : null;

  const update = (id: string, p: Partial<Flow>) => setFlows((fs) => fs.map((f) => (f.id === id ? { ...f, ...p } : f)));
  const select = (id: string) => { setSelId(id); setPreview(false); };
  const toggle = (f: Flow) => {
    if (f.on) { update(f.id, { on: false }); toast(`${f.name} paused`); return; }
    if (!f.previewed) { select(f.id); setPreview(true); toast('Preview it once before turning it on'); return; }
    update(f.id, { on: true });
    toast(`${f.name} on`);
  };
  const create = (t?: (typeof TEMPLATES)[number]) => {
    const id = `new${flows.length + 1}`;
    const f: Flow = {
      id, brand, name: t?.name ?? 'Untitled automation', trigger: t?.trigger ?? 'Status changed', conditions: t ? [...t.conditions] : [],
      logic: 'AND', actions: t ? [...t.actions] : ['Notify owner'], on: false, runs: 0, fails: 0, last: '—', series: [0, 0, 0, 0, 0, 0, 0, 0, 0], previewed: false, draft: true,
    };
    setFlows((fs) => [f, ...fs]);
    select(id);
    toast(t ? `${t.name} added as a draft` : 'Draft created');
  };

  return (
    <>
      <SectionHeader title="Automations" actions={<Button variant="dark" icon={<Plus size={15} />} onClick={() => create()}>New automation</Button>} />
      <div className={x.body}>
        <Group title="Rules" desc="When something happens, check conditions, then act. Pick a rule to edit it." flush>
          <div style={{ padding: '4px 12px 10px' }}>
            <Meter label="Runs this month" used={usage.used} cap={usage.cap} fmt={(v) => v.toLocaleString()} />
          </div>
          {list.map((f) => {
            const TI = triggerIcon(f.trigger);
            return (
              <div key={f.id} className={cx(x.item, sel?.id === f.id && x.itemOn, !f.on && x.itemOff)}>
                <div className={x.inline} style={{ width: '100%', flexWrap: 'nowrap' }}>
                  <button className={x.itemHead} onClick={() => select(f.id)} aria-pressed={sel?.id === f.id}>
                    <span className={x.rowIcon}><TI size={15} /></span>
                    <span className={x.itemMain}>
                      <b>{f.name}</b>
                      <span>{f.brand ? <BrandChip id={f.brand} size={14} /> : null}{f.trigger}<ArrowRight size={12} />{f.actions.join(', ')}</span>
                    </span>
                    <span className={x.itemSide}>
                      {f.draft ? <Badge tone="outline">Draft</Badge> : f.fails ? <Badge tone="red" dot>{f.fails} failed</Badge> : <span className={x.num}>{f.runs} runs</span>}
                    </span>
                  </button>
                  <span style={{ paddingRight: 14 }}><Toggle label={`${f.name} on`} on={f.on} onChange={() => toggle(f)} /></span>
                </div>
              </div>
            );
          })}
          {list.length === 0 ? <div className={x.hint} style={{ margin: 8 }}>No automations for this brand yet. Start from a template below.</div> : null}
          <div className={x.templates} style={{ padding: '10px 12px 6px' }}>
            <span className={x.tplLabel}>Start from a template</span>
            {TEMPLATES.map((t) => <Button key={t.name} size="sm" variant="light" icon={<Plus size={13} />} onClick={() => create(t)}>{t.name}</Button>)}
          </div>
        </Group>

        {sel && o && pv ? (
          <Group key={sel.id} title={<span className={x.inline}>{sel.brand ? <BrandChip id={sel.brand} size={20} /> : <Workflow size={16} />}{sel.name}</span>}
            desc={sel.on ? 'On · changes apply to new events' : sel.draft ? 'Draft · preview, then turn it on' : 'Paused'}
            actions={
              <>
                <Button size="sm" variant="light" icon={<Eye size={14} />} onClick={() => setPreview(!preview)}>{preview ? 'Hide preview' : 'Preview'}</Button>
                <Button size="sm" variant="dark" icon={<Save size={14} />} onClick={() => { update(sel.id, { draft: false }); toast('Saved'); }}>Save</Button>
              </>
            }>
            <div className={x.builder}>
              <div className={x.stage}>
                <span className={x.stageCap}><i>1</i>Name</span>
                <div className={x.stageBody}><input className={x.input} value={sel.name} onChange={(e) => update(sel.id, { name: e.target.value })} aria-label="Automation name" /></div>
              </div>
              <div className={x.stage}>
                <span className={x.stageCap}><i>2</i>When</span>
                <div className={x.stageBody}>
                  <Select size="md" label="Trigger" value={sel.trigger} onChange={(v) => update(sel.id, { trigger: v, previewed: false })} options={TRIGGERS} width={240} />
                </div>
              </div>
              <div className={x.stage}>
                <span className={x.stageCap}><i>3</i>If</span>
                <div className={x.stageBody}>
                  {sel.conditions.length === 0 ? <span className={x.mute} style={{ fontSize: 13 }}>Always</span> : null}
                  {sel.conditions.map((c, i) => (
                    <span key={c} className={x.inline}>
                      {i > 0 ? <span className={x.joiner}>{sel.logic}</span> : null}
                      <span className={x.token}>{c}<button aria-label={`Remove ${c}`} onClick={() => update(sel.id, { conditions: sel.conditions.filter((y) => y !== c), previewed: false })}><X size={13} /></button></span>
                    </span>
                  ))}
                  <AddSelect label="Add condition" options={CONDITIONS.filter((c) => !sel.conditions.includes(c))} onAdd={(v) => update(sel.id, { conditions: [...sel.conditions, v], previewed: false })} />
                  {sel.conditions.length > 1 ? (
                    <Segmented<'AND' | 'OR'> sub size="sm" value={sel.logic} onChange={(v) => update(sel.id, { logic: v, previewed: false })} options={[{ id: 'AND', label: 'All match' }, { id: 'OR', label: 'Any match' }]} />
                  ) : null}
                </div>
              </div>
              <div className={x.stage}>
                <span className={x.stageCap}><i>4</i>Then</span>
                <div className={x.stageBody}>
                  {sel.actions.map((a, i) => {
                    const AI = actionIcon(a);
                    return (
                      <span key={`${a}-${i}`} className={x.token}>
                        <em>{i + 1}</em><AI size={14} />{a}
                        <button aria-label={`Remove ${a}`} onClick={() => update(sel.id, { actions: sel.actions.filter((_, j) => j !== i), previewed: false })}><X size={13} /></button>
                      </span>
                    );
                  })}
                  <AddSelect label="Add action" options={ACTIONS} onAdd={(v) => update(sel.id, { actions: [...sel.actions, v], previewed: false })} />
                </div>
              </div>
            </div>

            {preview ? (
              <div className={x.preview}>
                <div className={x.previewHead}>
                  <span>In the last 7 days this would have run {pv.hits} times</span>
                  <Button size="sm" variant="accent" icon={<Zap size={14} />} disabled={pv.loop && !o.loop} onClick={() => {
                    update(sel.id, { on: true, previewed: true, draft: false });
                    setPreview(false);
                    toast(`${sel.name} on`);
                  }}>{sel.on ? 'Keep on' : 'Turn on'}</Button>
                </div>
                <div className={x.effects}>
                  {pv.effects.map((e, i) => {
                    const AI = actionIcon(e.a);
                    return <span key={`${e.a}-${i}`} className={x.effect}><AI size={14} /><em><b>{e.a}</b> · {e.sample}</em><span /><b>{e.n ? `×${e.n}` : '—'}</b></span>;
                  })}
                  {pv.effects.length === 0 ? <span className={x.mute}>No actions yet</span> : null}
                </div>
                <div className={x.inline}>
                  {pv.loop ? <Badge tone="red" dot>Could loop</Badge> : <Badge tone="green" dot>No loops</Badge>}
                  {usage.used + pv.monthly > usage.cap ? <Badge tone="red" dot>Over monthly limit</Badge> : <Badge tone="green" dot>About {pv.monthly} runs a month</Badge>}
                  {sel.conditions.length === 0 ? <Badge tone="amber" dot>Runs on every event</Badge> : null}
                </div>
              </div>
            ) : null}

            <div>
              <Row icon={<ShieldCheck size={15} />} title="Loop guard" sub="Stops after the same record fires 3 times in an hour">
                <Toggle label="Loop guard" on={o.loop} onChange={() => setOpts((m) => ({ ...m, [sel.id]: { ...o, loop: !o.loop } }))} />
              </Row>
              {!o.loop ? <span className={x.warnText} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, paddingBottom: 6 }}><TriangleAlert size={14} />Loop guard is off</span> : null}
              <Row icon={<RotateCcw size={15} />} title="Retry failed steps" sub="3 tries with backoff">
                <Toggle label="Retry failed steps" on={o.retry} onChange={() => setOpts((m) => ({ ...m, [sel.id]: { ...o, retry: !o.retry } }))} />
              </Row>
              <Row icon={<Zap size={15} />} title="Run as" sub="Whose permissions the actions use">
                <Select label="Run as" value={o.runAs} onChange={(v) => setOpts((m) => ({ ...m, [sel.id]: { ...o, runAs: v } }))} options={['Automation bot', 'Katriel']} width={150} />
              </Row>
            </div>
          </Group>
        ) : null}

        {sel ? (
          <Group title="Recent runs" desc={runs.length ? `Last ${runs.length} runs of ${sel.name}` : undefined}>
            {runs.length ? (
              <div>
                {runs.map((r) => {
                  const status = retried[r.id] ? 'retried' : r.status;
                  return (
                    <div key={r.id} className={x.runRow}>
                      <span className={x.num}>{r.t}</span>
                      <span><b>{r.event}</b>{status === 'failed' || status === 'skipped' ? <em style={status === 'skipped' ? { color: 'var(--mute)' } : undefined}>{r.error}</em> : null}</span>
                      <span>{status === 'ok' ? <Badge tone="green" dot>Done</Badge> : status === 'retried' ? <Badge tone="blue" dot>Retried</Badge> : status === 'skipped' ? <Badge tone="neutral" dot>Skipped</Badge> : <Badge tone="red" dot>Failed</Badge>}</span>
                      <span className={x.num}>{r.ms >= 1000 ? `${(r.ms / 1000).toFixed(1)}s` : `${r.ms}ms`}</span>
                      <span>{status === 'failed' ? <Button size="sm" variant="light" icon={<RotateCcw size={13} />} onClick={() => { setRetried((m) => ({ ...m, [r.id]: true })); toast('Retried · all steps done'); }}>Retry</Button> : null}</span>
                    </div>
                  );
                })}
              </div>
            ) : <div className={x.hint}>No runs yet. Runs appear here once the rule is on and its trigger fires.</div>}
          </Group>
        ) : null}
      </div>
    </>
  );
}

/** "+ Add …" as a light pill wrapping a native select, so it is keyboard- and screen-reader-friendly. */
function AddSelect({ label, options, onAdd }: { label: string; options: string[]; onAdd: (v: string) => void }) {
  if (!options.length) return null;
  return (
    <label style={{ position: 'relative', display: 'inline-flex' }}>
      <span className={`${u.btn} ${u.s_sm} ${u.v_light}`} aria-hidden><Plus size={13} />{label}</span>
      <select value="" aria-label={label} onChange={(e) => { if (e.target.value) onAdd(e.target.value); }}
        style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%' }}>
        <option value="" />
        {options.map((o) => <option key={o}>{o}</option>)}
      </select>
    </label>
  );
}
