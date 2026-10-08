'use client';

/*
 * Settings (UX-PLAN.md): a grouped settings list on the left and one section on the right. Every
 * section starts with Settings / Section crumbs and keeps to plain forms and lists. Agents,
 * Automations and Integrations moved in here from their own pages. Deep links: /app/settings#agents.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowLeftRight, Bell, Bot, Building, CreditCard, Palette, Plug, ShieldCheck, Sparkles, Users, Workflow,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { integrations, people } from '@/lib/app-data';
import { BrandsKits } from './brands';
import { GeneralSection, MembersSection } from './workspace';
import { AgentsSection } from './agents';
import { AutomationsSection } from './automations';
import { IntegrationsSection } from './integrations';
import { AiSection, BillingSection, ImportSection, NotificationsSection, SecuritySection } from './account';
import { SectionHeader, x } from './parts';

type Id = 'general' | 'brands' | 'members' | 'agents' | 'automations' | 'integrations' | 'ai' | 'billing' | 'notifications' | 'security' | 'import';
type Item = { id: Id; label: string; icon: typeof Bell };

const GROUPS: { label: string; items: Item[] }[] = [
  { label: 'Workspace', items: [
    { id: 'general', label: 'General', icon: Building },
    { id: 'brands', label: 'Brands & identity kits', icon: Palette },
    { id: 'members', label: 'Members & roles', icon: Users },
  ] },
  { label: 'Work', items: [
    { id: 'agents', label: 'Agents', icon: Bot },
    { id: 'automations', label: 'Automations', icon: Workflow },
    { id: 'integrations', label: 'Integrations', icon: Plug },
  ] },
  { label: 'Account', items: [
    { id: 'ai', label: 'AI & limits', icon: Sparkles },
    { id: 'billing', label: 'Billing & usage', icon: CreditCard },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'security', label: 'Security', icon: ShieldCheck },
    { id: 'import', label: 'Import / export', icon: ArrowLeftRight },
  ] },
];
const IDS = GROUPS.flatMap((g) => g.items.map((i) => i.id));
const ALIAS: Record<string, Id> = { workspace: 'general' };
const fromHash = (): Id | null => {
  const h = window.location.hash.slice(1);
  const id = (ALIAS[h] ?? h) as Id;
  return IDS.includes(id) ? id : null;
};

const memberCount = people.filter((p) => p.kind === 'human').length;
const failingIntegrations = integrations.filter((i) => i.status === 'warning').length;

export default function SettingsPage() {
  const { customKit } = useWorkspace();
  const [id, setId] = useState<Id>('brands');

  // deep links (/app/settings#agents) on load and when another page links in
  useEffect(() => {
    const sync = () => { const h = fromHash(); if (h) setId(h); };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  const go = (next: string) => {
    if (!IDS.includes(next as Id)) return;
    setId(next as Id);
    window.history.replaceState(null, '', `#${next}`);
    window.scrollTo({ top: 0 });
  };

  const extra = (i: Id): ReactNode => {
    if (i === 'brands' && customKit) return <i className={x.navLive} title="A custom kit is live" />;
    if (i === 'members') return <em className={x.navCount}>{memberCount}</em>;
    if (i === 'integrations' && failingIntegrations) return <em className={x.navAlert} title="Needs attention">{failingIntegrations}</em>;
    return null;
  };

  return (
    <div className={x.layout}>
      <nav className={x.nav} aria-label="Settings">
        {GROUPS.map((g) => (
          <div key={g.label} className={x.navGroup}>
            <span className={x.navCap}>{g.label}</span>
            {g.items.map((it) => (
              <button key={it.id} className={id === it.id ? x.navOn : x.navItem} aria-current={id === it.id ? 'page' : undefined} onClick={() => go(it.id)}>
                <it.icon size={16} />
                <span>{it.label}</span>
                {extra(it.id)}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className={x.content} key={id}>
        {id === 'general' ? <GeneralSection /> : null}
        {id === 'brands' ? (
          <>
            <SectionHeader title="Brands & identity kits" />
            <p className={x.mute} style={{ margin: '-6px 0 0', fontSize: 13.5 }}>Upload a logo and each brand gets readable accents across the app. Pick a brand, check the preview, then apply.</p>
            <BrandsKits />
          </>
        ) : null}
        {id === 'members' ? <MembersSection onGo={go} /> : null}
        {id === 'agents' ? <AgentsSection /> : null}
        {id === 'automations' ? <AutomationsSection /> : null}
        {id === 'integrations' ? <IntegrationsSection /> : null}
        {id === 'ai' ? <AiSection onGo={go} /> : null}
        {id === 'billing' ? <BillingSection /> : null}
        {id === 'notifications' ? <NotificationsSection /> : null}
        {id === 'security' ? <SecuritySection /> : null}
        {id === 'import' ? <ImportSection /> : null}
      </div>
    </div>
  );
}
