import type { NextConfig } from 'next';

/* Old prototype routes folded into the 6-item structure (UX-PLAN.md). */
const moved: [string, string][] = [
  ['/app/today', '/app?plan=1'],
  ['/app/my-work', '/app'],
  ['/app/calendar', '/app/plan?view=calendar'],
  ['/app/timeline', '/app/plan?view=timeline'],
  ['/app/workload', '/app/plan?view=workload'],
  ['/app/agents', '/app/inbox'],
  ['/app/releases', '/app/projects/p1?tab=release'],
  ['/app/reports', '/app/goals?tab=reports'],
  ['/app/knowledge', '/app/docs'],
  ['/app/automations', '/app/settings#automations'],
  ['/app/integrations', '/app/settings#integrations'],
];

const config: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  async redirects() {
    return [
      { source: '/', destination: '/app', permanent: false },
      ...moved.map(([source, destination]) => ({ source, destination, permanent: false })),
    ];
  },
};

export default config;
