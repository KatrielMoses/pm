import type { Freshness, IncompleteReason, MetricValue } from './client.ts';

/** Words for what is missing (RPT-023): a quiet figure is never mistaken for a complete one. */
export const INCOMPLETE_TEXT: Record<IncompleteReason, string> = {
  count_capped: 'The count stopped at its limit; the true number is higher.',
  groups_truncated: 'Some groups are not shown.',
  rows_truncated: 'Only the first rows are shown.',
  estimates_missing: 'Some items have no estimate and are not counted.',
  no_measurement: 'Some items have no measurement yet.',
  source_stale: 'The source has not updated recently.',
};

const exact = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** The figure as shown (compact above 10,000) and the exact figure for tooltips and screen readers. */
export function formatValue(
  unit: MetricValue['unit'],
  value: number | null,
): { short: string; exact: string } {
  if (value === null) return { short: '—', exact: 'No value' };
  if (unit === 'seconds') {
    const h = value / 3600;
    return { short: `${exact.format(h)} h`, exact: `${exact.format(h)} hours` };
  }
  if (unit === 'minutes') {
    const h = value / 60;
    return { short: `${exact.format(h)} h`, exact: `${exact.format(h)} hours` };
  }
  if (unit === 'percent')
    return { short: `${exact.format(value)}%`, exact: `${exact.format(value)} percent` };
  return {
    short: Math.abs(value) >= 10_000 ? compact.format(value) : exact.format(value),
    exact: exact.format(value),
  };
}

export function freshnessText(f: Freshness): string {
  const at = new Date(f.as_of);
  const time = Number.isNaN(at.getTime())
    ? f.as_of
    : at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (f.basis === 'live') return `Computed from current records at ${time}`;
  const src = f.source_as_of ? new Date(f.source_as_of).toLocaleString() : 'an unknown time';
  return f.stale ? `Data as of ${src} (out of date)` : `Data as of ${src}`;
}

export const FILTER_NAME = {
  range: 'date range',
  brands: 'brand filter',
  projects: 'project filter',
  people: 'person filter',
  statuses: 'status filter',
} as const;
