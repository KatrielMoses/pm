'use client';

/*
 * Plan (UX-PLAN.md): one page for Calendar, Timeline and Workload. The view lives in the URL
 * (?view=calendar|timeline|workload) so the old /app/calendar, /app/timeline and /app/workload
 * links can redirect here. Each view renders the standard PageHeader + ViewBar with the shared
 * switcher on the left.
 */

import { Suspense } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CalendarDays, GanttChart, Users } from 'lucide-react';
import { Segmented } from '@/components/paper/ui';
import { CalendarView } from './_views/CalendarView';
import { TimelineView } from './_views/TimelineView';
import { WorkloadView } from './_views/WorkloadView';
import type { PlanView } from './_views/shared';

const VIEWS: PlanView[] = ['calendar', 'timeline', 'workload'];

function PlanPage() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const raw = params.get('view');
  const view: PlanView = VIEWS.includes(raw as PlanView) ? (raw as PlanView) : 'calendar';
  const go = (v: PlanView) => router.replace(v === 'calendar' ? path : `${path}?view=${v}`, { scroll: false });

  const switcher = (
    <Segmented<PlanView> value={view} onChange={go} options={[
      { id: 'calendar', label: 'Calendar', icon: <CalendarDays size={15} /> },
      { id: 'timeline', label: 'Timeline', icon: <GanttChart size={15} /> },
      { id: 'workload', label: 'Workload', icon: <Users size={15} /> },
    ]} />
  );

  if (view === 'timeline') return <TimelineView switcher={switcher} />;
  if (view === 'workload') return <WorkloadView switcher={switcher} />;
  return <CalendarView switcher={switcher} />;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <PlanPage />
    </Suspense>
  );
}
