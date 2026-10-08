'use client';

/*
 * Release tab (absorbs the old Releases page): readiness stats, checklist, test suites as a simple
 * pass/fail strip, defects (merged ≠ verified) and the go / no-go ink hero with a visible reason
 * when Go is locked. Empty state when the project has no release.
 */

import { useState } from 'react';
import { BadgeCheck, Check, GitMerge, Lock, RotateCcw, Rocket, X } from 'lucide-react';
import { useApp } from '@/lib/app-state';
import { personById } from '@/lib/app-data';
import { NOW, type Project } from '@/lib/data';
import { Avatar, Badge, Button, Card, Checkbox, Empty, Segmented, Stat, u, type Tone } from '@/components/paper/ui';
import { defectsByRelease, defectTask, isBlocker, releaseFor, suitesByRelease, type Defect } from '../_lib/release';
import s from './detail.module.css';

type Decision = { verdict: 'go' | 'nogo'; by: string; at: string };
const statusTone = { planning: 'neutral', testing: 'accent', ready: 'green', shipped: 'green' } as const;
const statusText = { planning: 'Planning', testing: 'Testing', ready: 'Ready', shipped: 'Shipped' } as const;
const sevTone: Record<Defect['severity'], Tone> = { S1: 'red', S2: 'amber', S3: 'neutral' };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function DefectStatus({ d }: { d: Defect }) {
  if (d.status === 'merged') return <Badge tone="blue"><GitMerge size={12} /> Merged · not verified</Badge>;
  if (d.status === 'verified') return <Badge tone="green"><BadgeCheck size={12} /> Verified</Badge>;
  if (d.status === 'fixing') return <Badge tone="accent" dot>Fixing</Badge>;
  if (d.status === 'deferred') return <Badge tone="outline">Deferred</Badge>;
  return <Badge tone="red" dot>Open</Badge>;
}

export function ReleaseTab({ project }: { project: Project }) {
  const rel = releaseFor(project.id);
  const { toast, openTask } = useApp();
  const [checks, setChecks] = useState<boolean[]>(() => rel?.checklist.map((c) => c.done) ?? []);
  const [defects, setDefects] = useState<Defect[]>(() => (rel ? defectsByRelease[rel.id] ?? [] : []));
  const [decision, setDecision] = useState<Decision | undefined>(() => (rel?.status === 'shipped' ? { verdict: 'go', by: 'km', at: rel.decision } : undefined));
  const [defView, setDefView] = useState<'all' | 'blocking'>('all');

  if (!rel) {
    return (
      <Empty icon={<Rocket size={20} />}>
        <span>{project.name} has no release planned. A release tracks test results, defects and the go / no-go decision.</span>
        <Button size="sm" variant="dark" icon={<Rocket size={14} />} onClick={() => toast('Release drafted')}>Plan a release</Button>
      </Empty>
    );
  }

  const approvalIdx = rel.checklist.findIndex((c) => c.label === 'Approval');
  const stepDone = (i: number) => (i === approvalIdx ? decision?.verdict === 'go' : checks[i]);
  const openChecks = rel.checklist.filter((_, i) => i !== approvalIdx && !checks[i]);
  const blockers = defects.filter(isBlocker);
  const canGo = openChecks.length === 0 && blockers.length === 0;
  const reason = [openChecks.length ? `${plural(openChecks.length, 'check')} open` : '', blockers.length ? plural(blockers.length, 'blocking defect') : ''].filter(Boolean).join(' · ');
  const passRate = Math.round((rel.passed / rel.tests) * 1000) / 10;
  const decisionIn = Number(rel.decision.match(/\d+/)?.[0] ?? NOW.day) - NOW.day;
  const doneCount = rel.checklist.filter((_, i) => stepDone(i)).length;
  const suites = suitesByRelease[rel.id] ?? [];
  const defRows = defects.filter((d) => defView === 'all' || isBlocker(d));
  const locked = !!decision;

  const toggleCheck = (i: number) => {
    if (i === approvalIdx) { toast('Approval is set by the Go decision', 'bad'); return; }
    if (locked) { toast('Decision recorded · undo to edit', 'bad'); return; }
    setChecks((c) => c.map((v, j) => (j === i ? !v : v)));
  };
  const setDefect = (id: string, status: Defect['status']) => {
    setDefects((all) => all.map((d) => (d.id === id ? { ...d, status } : d)));
    toast(status === 'verified' ? `${id} verified` : `${id} deferred to the next release`);
  };
  const decide = (verdict: Decision['verdict']) => {
    setDecision({ verdict, by: 'km', at: `${NOW.weekday} ${NOW.day} Oct · ${NOW.time}` });
    toast(verdict === 'go' ? `${rel.name} · Go recorded` : `${rel.name} · No-go recorded`, verdict === 'go' ? 'ok' : 'bad');
  };

  return (
    <>
      <div className={s.relHead}>
        <b>{rel.name}</b>
        <Badge tone={statusTone[rel.status]} dot>{statusText[rel.status]}</Badge>
        <span className={s.mute}>{rel.scope} items in scope · {rel.excluded} excluded</span>
      </div>

      <section className={s.stats}>
        <Stat label="Tests passing" value={`${passRate}%`} sub={`${rel.passed} of ${rel.tests} · ${rel.failed} failing · ${rel.flaky} flaky`} tone={rel.failed ? 'amber' : 'green'} />
        <Stat label="Blocking defects" value={blockers.length} sub={blockers.length ? 'S1/S2 not yet verified' : 'None blocking'} tone={blockers.length ? 'red' : 'green'}
          onClick={() => setDefView('blocking')} />
        <Stat label="Checklist" value={`${doneCount} / ${rel.checklist.length}`} sub={openChecks.length ? `${openChecks.map((c) => c.label).join(', ')} open` : 'Checks met'} />
        <Stat label="Decision" value={rel.decision} sub={rel.status === 'shipped' ? 'Shipped' : decisionIn > 0 ? `In ${plural(decisionIn, 'day')}` : decisionIn === 0 ? 'Today' : 'Overdue'} tone={rel.status !== 'shipped' && decisionIn <= 2 ? 'amber' : undefined} />
      </section>

      <div className={s.relGrid}>
        <div className={s.col2}>
          <Card title="Checklist" actions={<span className={s.cardCount}>{doneCount}/{rel.checklist.length}</span>}>
            <div className={s.rows}>
              {rel.checklist.map((c, i) => (
                <label key={c.label} className={s.checkRow}>
                  {i === approvalIdx
                    ? <span className={stepDone(i) ? s.lockOn : s.lock} title="Set by the Go decision">{stepDone(i) ? <Check size={12} strokeWidth={3} /> : <Lock size={11} />}</span>
                    : <Checkbox on={!!checks[i]} label={c.label} onChange={() => toggleCheck(i)} />}
                  <span className={stepDone(i) ? s.struck : s.rowText}>{c.label}</span>
                  {i === approvalIdx ? <span className={s.mute}>Set by Go</span> : null}
                  <Avatar id={c.owner} size={22} />
                </label>
              ))}
            </div>
          </Card>

          <Card title="Test suites" actions={<span className={s.legend}><i className={s.cPass} />Pass<i className={s.cFail} />Fail<i className={s.cFlaky} />Flaky</span>}>
            <div className={s.suiteHead}><span>Suite</span><span>Last 10 runs, oldest → latest</span><span>Pass</span><span>Failing</span></div>
            <div className={s.rows}>
              {suites.map((x) => (
                <div key={x.name} className={s.suiteRow}>
                  <span className={s.rowText}>{x.name}</span>
                  <span className={s.strip} aria-label={`${x.name} last 10 runs`}>
                    {x.history.map((h, i) => <i key={i} className={h === 1 ? s.cPass : h === 2 ? s.cFlaky : s.cFail} title={`Run ${i + 1}: ${h === 1 ? 'pass' : h === 2 ? 'flaky' : 'fail'}`} />)}
                  </span>
                  <b className={s.mono}>{Math.round((x.pass / x.total) * 100)}%</b>
                  <span>{x.fail ? <Badge tone="red">{x.fail} failing</Badge> : x.flaky ? <Badge tone="amber">{x.flaky} flaky</Badge> : <Badge tone="green">Green</Badge>}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Defects"
            actions={<Segmented sub size="sm" value={defView} onChange={setDefView} options={[{ id: 'all', label: 'All', count: defects.length }, { id: 'blocking', label: 'Blocking', count: blockers.length }]} />}>
            <p className={s.note}>A merged fix still blocks until someone verifies it on staging.</p>
            {defRows.length === 0 ? <Empty icon={<Check size={18} />}>No blocking defects. Go is not held up by defects.</Empty> : (
              <div className={u.tableWrap}>
                <table className={u.table}>
                  <thead><tr><th>ID</th><th>Defect</th><th>Severity</th><th>Status</th><th>Owner</th><th /></tr></thead>
                  <tbody>
                    {defRows.map((d) => (
                      <tr key={d.id} onClick={() => (defectTask[d.id] ? openTask(defectTask[d.id]) : toast(`${d.id} · ${d.env} · repro ${d.repro}`))}>
                        <td className={s.mono}>{d.id}</td>
                        <td className={s.rowText}>{d.title}</td>
                        <td><Badge tone={sevTone[d.severity]}>{d.severity}</Badge></td>
                        <td><DefectStatus d={d} /></td>
                        <td><Avatar id={d.owner} size={24} /></td>
                        <td onClick={(e) => e.stopPropagation()} style={{ textAlign: 'right' }}>
                          {d.status === 'merged' ? <Button size="sm" variant="dark" icon={<BadgeCheck size={13} />} onClick={() => setDefect(d.id, 'verified')}>Verify</Button>
                            : d.status === 'open' || d.status === 'fixing' ? <Button size="sm" onClick={() => setDefect(d.id, 'deferred')}>Defer</Button>
                              : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <section className={s.goHero} aria-label="Go / no-go">
          <div className={s.heroHead}><span className={s.heroIcon}><Rocket size={14} /></span> Go / no-go · {rel.version}</div>
          <ul className={s.reqs}>
            {rel.checklist.map((c, i) => (i === approvalIdx ? null : (
              <li key={c.label} className={checks[i] ? s.reqOk : s.reqNo}><span>{checks[i] ? <Check size={12} strokeWidth={3} /> : null}</span>{c.label}</li>
            )))}
            <li className={blockers.length ? s.reqNo : s.reqOk}><span>{blockers.length ? null : <Check size={12} strokeWidth={3} />}</span>{blockers.length ? plural(blockers.length, 'blocking defect') : 'No blocking defects'}</li>
          </ul>
          {decision ? (
            <div className={s.decidedBox}>
              <span className={decision.verdict === 'go' ? s.verdictGo : s.verdictNo}>{decision.verdict === 'go' ? <Check size={16} strokeWidth={3} /> : <X size={16} strokeWidth={3} />}{decision.verdict === 'go' ? 'Go' : 'No-go'}</span>
              <span className={s.approver}><Avatar id={decision.by} size={24} /><span><b>{personById(decision.by)?.name}</b><small>{decision.at}</small></span></span>
              {rel.status !== 'shipped' ? <Button size="sm" variant="light" icon={<RotateCcw size={13} />} onClick={() => { setDecision(undefined); toast('Decision cleared'); }}>Undo</Button> : null}
            </div>
          ) : (
            <>
              <div className={s.heroBtns}>
                <Button variant="light" icon={<X size={15} />} onClick={() => decide('nogo')}>No-go</Button>
                <Button variant="accent" icon={<Check size={15} strokeWidth={2.8} />} disabled={!canGo} onClick={() => decide('go')} title={canGo ? 'Record Go' : `Go is locked: ${reason}`}>Go</Button>
              </div>
              <p className={s.reason}>{canGo ? 'All checks met. Go is available.' : <><Lock size={13} /> Go is locked: {reason}.</>}</p>
            </>
          )}
        </section>
      </div>
    </>
  );
}
