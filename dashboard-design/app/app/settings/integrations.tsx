'use client';

/*
 * Settings › Integrations: connections as one list (test, reauthorize, disconnect with keep/remove
 * data), webhook deliveries with retry, and API tokens with rotate / revoke.
 */

import { useState } from 'react';
import {
  Braces, CalendarDays, Check, CircleAlert, Copy, FileSpreadsheet, FlaskConical, GitBranch, Hash, KeyRound, Loader, Plug, Plus, RefreshCw, RotateCcw, Unplug, Webhook, Zap,
} from 'lucide-react';
import { useApp } from '@/lib/app-state';
import { useWorkspace } from '@/lib/workspace';
import { apiTokens, byBrand, integrations as seed, webhookDeliveries } from '@/lib/app-data';
import { BrandChip } from '@/components/brand';
import { Badge, Button, Segmented, type Tone } from '@/components/paper/ui';
import { cx, Group, SectionHeader, x } from './parts';

type Status = 'connected' | 'warning' | 'idle' | 'off';
type Conn = { id: string; name: string; status: Status; scope: string; owner: string; sync: string; brand: (typeof seed)[number]['brand']; events: number };
const ICON = { gh: GitBranch, gc: CalendarDays, tr: FlaskConical, wh: Webhook, mcp: Braces, csv: FileSpreadsheet, sl: Hash } as const;
const KIND: Record<string, string> = { gh: 'OAuth', gc: 'OAuth', tr: 'API key', wh: 'Signed webhooks', mcp: 'Token', csv: 'Manual upload', sl: 'OAuth' };
const STATUS: Record<Status, { tone: Tone; label: string }> = {
  connected: { tone: 'green', label: 'Connected' }, warning: { tone: 'red', label: 'Failing' }, idle: { tone: 'neutral', label: 'Idle' }, off: { tone: 'outline', label: 'Not connected' },
};
const syncText = (v: string) => (v === '—' ? 'Never synced' : v === 'live' ? 'Live' : v === 'now' ? 'Synced just now' : `Synced ${v} ago`);

export function IntegrationsSection() {
  const { brand } = useWorkspace();
  const { toast } = useApp();
  const [conns, setConns] = useState<Conn[]>(() => seed.map((c) => ({ ...c, status: c.status as Status })));
  const [busy, setBusy] = useState<Record<string, 'test' | 'reauth' | null>>({});
  const [confirm, setConfirm] = useState<string | null>(null);
  const [keep, setKeep] = useState<'keep' | 'remove'>('keep');
  const [conflict, setConflict] = useState(true);
  const [deliveries, setDeliveries] = useState(webhookDeliveries.map((d) => ({ ...d, retried: false })));
  const [retrying, setRetrying] = useState<string | null>(null);
  const [tokens, setTokens] = useState(apiTokens.map((t) => ({ ...t })));
  const [revoke, setRevoke] = useState<string | null>(null);

  const scoped = byBrand(conns, brand);
  const failing = deliveries.filter((d) => d.code >= 400 && !d.retried).length;

  const set = (id: string, p: Partial<Conn>) => setConns((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const run = (c: Conn, kind: 'test' | 'reauth') => {
    setBusy((b) => ({ ...b, [c.id]: kind }));
    setTimeout(() => {
      setBusy((b) => ({ ...b, [c.id]: null }));
      if (kind === 'reauth') { set(c.id, { sync: 'now' }); toast(`${c.name} reauthorized`); return; }
      if (c.id === 'wh' && failing > 0) { toast('2 of 3 endpoints OK · api.mailaccess.io returns 500', 'bad'); return; }
      set(c.id, { sync: 'now' });
      toast(`${c.name} OK · ${120 + (c.events % 200)}ms`);
    }, 1000);
  };
  const retry = (id: string) => {
    setRetrying(id);
    setTimeout(() => {
      setRetrying(null);
      setDeliveries((ds) => ds.map((d) => (d.id === id ? { ...d, retried: true } : d)));
      const left = deliveries.filter((d) => d.code >= 400 && !d.retried && d.id !== id).length;
      if (!left) set('wh', { status: 'connected', sync: 'now' });
      toast(left ? 'Delivered · 200' : 'Delivered · webhooks healthy');
    }, 900);
  };

  return (
    <>
      <SectionHeader title="Integrations" actions={<Button variant="dark" icon={<Plus size={15} />} onClick={() => toast('Request sent · we reply within 2 days')}>Request integration</Button>} />
      <div className={x.body}>
        <Group title="Connections" desc="What the workspace talks to. Test checks the connection without changing data." flush>
          {scoped.map((c) => {
            const I = ICON[c.id as keyof typeof ICON] ?? Plug;
            const st = STATUS[c.status];
            const b = busy[c.id];
            const off = c.status === 'off';
            return (
              <div key={c.id} className={cx(x.item, off && x.itemOff)}>
                <div className={x.itemHead} style={{ cursor: 'default' }}>
                  <span className={x.rowIcon}><I size={16} /></span>
                  <span className={x.itemMain}>
                    <b>{c.name}</b>
                    <span>{c.brand ? <BrandChip id={c.brand} size={14} /> : null}{KIND[c.id]} · {c.scope === '—' ? 'No access yet' : c.scope} · {syncText(c.sync)}</span>
                  </span>
                  <span className={x.itemSide}>
                    <Badge tone={st.tone} dot>{st.label}</Badge>
                    {off ? (
                      <Button size="sm" variant="dark" icon={<Plug size={14} />} onClick={() => { set(c.id, { status: 'connected', owner: 'km', sync: 'now', scope: c.id === 'sl' ? '2 channels' : c.scope }); toast(`${c.name} connected`); }}>Connect</Button>
                    ) : (
                      <>
                        <Button size="sm" variant="light" icon={b === 'test' ? <Loader size={14} className="anim-spin" /> : <Zap size={14} />} onClick={() => run(c, 'test')} disabled={!!b}>Test</Button>
                        <Button size="sm" variant="light" icon={b === 'reauth' ? <Loader size={14} className="anim-spin" /> : <RefreshCw size={14} />} onClick={() => run(c, 'reauth')} disabled={!!b}>Reauthorize</Button>
                        <Button size="sm" variant="text" icon={<Unplug size={14} />} onClick={() => { setConfirm(c.id); setKeep('keep'); }}>Disconnect</Button>
                      </>
                    )}
                  </span>
                </div>
                {c.status === 'warning' ? (
                  <div className={x.connWarn}><CircleAlert size={14} />{failing} failed deliveries. Retry them in Webhook deliveries below.</div>
                ) : null}
                {c.id === 'gc' && conflict && !off ? (
                  <div className={x.connNote}><CircleAlert size={14} />1 event changed in both places
                    <Button size="sm" variant="light" onClick={() => { setConflict(false); toast('Kept the app version · calendar updated'); }}>Keep app version</Button>
                  </div>
                ) : null}
                {confirm === c.id ? (
                  <div className={x.confirm}>
                    <b>Disconnect {c.name}?</b>
                    <Segmented<'keep' | 'remove'> sub size="sm" value={keep} onChange={setKeep} options={[{ id: 'keep', label: 'Keep synced data' }, { id: 'remove', label: `Remove ${c.events.toLocaleString()} records` }]} />
                    <span className={x.inline}>
                      <Button size="sm" variant="text" onClick={() => setConfirm(null)}>Cancel</Button>
                      <Button size="sm" variant="danger" icon={<Unplug size={14} />} onClick={() => {
                        set(c.id, { status: 'off', sync: '—', owner: '—' });
                        setConfirm(null);
                        toast(`${c.name} disconnected · ${keep === 'keep' ? 'data kept' : `${c.events.toLocaleString()} records removed`}`);
                      }}>Disconnect</Button>
                    </span>
                  </div>
                ) : null}
              </div>
            );
          })}
        </Group>

        <Group title="Webhook deliveries" desc="Signed with HMAC. Failed deliveries retry after 1, 5 and 30 minutes." flush>
          <div style={{ padding: '0 4px' }}>
            {deliveries.map((d) => {
              const bad = d.code >= 400 && !d.retried;
              return (
                <div key={d.id} className={x.runRow} style={{ gridTemplateColumns: '60px minmax(0, 1fr) 64px 52px 92px' }}>
                  <span><Badge tone={bad ? 'red' : 'green'} dot>{d.retried ? 200 : d.code}</Badge></span>
                  <span><b>{d.event}</b><em style={{ color: 'var(--mute)' }}>{d.url}</em></span>
                  <span className={x.num}>{d.retried ? '141ms' : d.ms >= 1000 ? `${(d.ms / 1000).toFixed(1)}s` : `${d.ms}ms`}</span>
                  <span className={x.num}>{d.retried ? 'now' : d.t}</span>
                  <span>
                    {bad ? (
                      <Button size="sm" variant="light" icon={retrying === d.id ? <Loader size={13} className="anim-spin" /> : <RotateCcw size={13} />} disabled={retrying === d.id} onClick={() => retry(d.id)}>Retry</Button>
                    ) : d.retried ? <Badge tone="blue" dot>Retried</Badge> : <span className={x.okText}><Check size={14} />OK</span>}
                  </span>
                </div>
              );
            })}
          </div>
        </Group>

        <Group title="API tokens" desc="600 requests a minute per token. Tokens are shown once when created."
          actions={<Button size="sm" variant="light" icon={<Plus size={13} />} onClick={() => {
            setTokens((ts) => [...ts, { id: `tk${ts.length + 1}`, name: 'New token', scopes: ['tasks:read'], created: '6 Oct', last: 'never', prefix: `pm_live_${(4096 + ts.length * 977).toString(16)}` }]);
            toast('Token created · copy it now, it is shown once');
          }}>New token</Button>}>
          {tokens.length === 0 ? <div className={x.hint}>No tokens. Create one to use the API or CI.</div> : tokens.map((t) => (
            <div key={t.id} className={x.row}>
              <span className={x.rowIcon}><KeyRound size={15} /></span>
              <span className={x.rowText}>
                <b>{t.name}</b>
                <span className={x.inline}>
                  <code className={x.code}>{t.prefix}••••</code>
                  <Button size="sm" variant="text" icon={<Copy size={13} />} onClick={() => toast('Prefix copied')}>Copy</Button>
                  {t.scopes.map((sc) => <span key={sc} className={cx(x.tag, sc.endsWith('write') && x.scopeW)}>{sc}</span>)}
                  <span>{t.last === 'never' ? 'Never used' : `Used ${t.last} ago`}</span>
                </span>
              </span>
              <span className={x.rowEnd}>
                {revoke === t.id ? (
                  <>
                    <Button size="sm" variant="text" onClick={() => setRevoke(null)}>Cancel</Button>
                    <Button size="sm" variant="danger" onClick={() => { setTokens((ts) => ts.filter((y) => y.id !== t.id)); setRevoke(null); toast(`${t.name} revoked`); }}>Revoke now</Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" variant="light" icon={<RefreshCw size={13} />} onClick={() => {
                      setTokens((ts) => ts.map((y) => (y.id === t.id ? { ...y, prefix: `pm_live_${((parseInt(y.prefix.slice(-4), 16) * 7) % 65535).toString(16).padStart(4, '0')}`, last: 'never', created: '6 Oct' } : y)));
                      toast(`${t.name} rotated · old key works for 24h`);
                    }}>Rotate</Button>
                    <Button size="sm" variant="text" onClick={() => setRevoke(t.id)}>Revoke</Button>
                  </>
                )}
              </span>
            </div>
          ))}
        </Group>
      </div>
    </>
  );
}
