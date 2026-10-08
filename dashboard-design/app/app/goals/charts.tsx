'use client';

/*
 * Bars and lines only (UX-PLAN rule 10). Small, axis-labelled, token-coloured charts for Goals and
 * Reports. Every chart shows a y-axis with 3 ticks, x labels and a legend when it has >1 series.
 */

import type { ReactNode } from 'react';
import s from './goals.module.css';

export type Series = { label: string; values: number[]; color: string; dashed?: boolean };

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
};

function Axis({ max, fmt }: { max: number; fmt: (v: number) => string }) {
  return (
    <div className={s.axis} aria-hidden>
      {[1, 0.5, 0].map((k) => <span key={k} style={{ bottom: `${k * 100}%` }}>{fmt(max * k)}</span>)}
    </div>
  );
}

function Grid() {
  return <div className={s.grid} aria-hidden>{[1, 0.5, 0].map((k) => <i key={k} style={{ bottom: `${k * 100}%` }} />)}</div>;
}

export function Legend({ series }: { series: Pick<Series, 'label' | 'color' | 'dashed'>[] }) {
  return (
    <span className={s.legend}>
      {series.map((x) => <span key={x.label}><i style={{ background: x.color, opacity: x.dashed ? 0.6 : 1 }} />{x.label}</span>)}
    </span>
  );
}

/** Vertical bars; several series render as grouped bars. */
export function ColumnChart({ series, labels, height = 180, fmt = (v) => `${Math.round(v)}`, onBar }: {
  series: Series[]; labels: string[]; height?: number; fmt?: (v: number) => string; onBar?: (i: number) => void;
}) {
  const max = niceMax(Math.max(...series.flatMap((x) => x.values), 1));
  const n = labels.length;
  const last = n - 1;
  return (
    <div className={s.chartBox}>
      <div className={s.plot} style={{ height }}>
        <Axis max={max} fmt={fmt} />
        <div className={s.plotArea}>
          <Grid />
          <div className={s.cols}>
            {labels.map((l, i) => (
              <button key={l + i} type="button" className={s.colGroup} onClick={onBar ? () => onBar(i) : undefined} tabIndex={onBar ? 0 : -1}
                title={`${l}: ${series.map((x) => `${x.label} ${fmt(x.values[i])}`).join(' · ')}`} style={{ cursor: onBar ? 'pointer' : 'default' }}>
                {series.map((x) => (
                  <span key={x.label} className={`${s.bar} anim-grow-y`} style={{ height: `${(x.values[i] / max) * 100}%`, background: x.color, opacity: i === last || series.length > 1 ? 1 : 0.55, animationDelay: `${i * 25}ms` }}>
                    {i === last && series.length === 1 ? <em className={s.barVal}>{fmt(x.values[i])}</em> : null}
                  </span>
                ))}
              </button>
            ))}
          </div>
        </div>
      </div>
      <XLabels labels={labels} />
    </div>
  );
}

/** Lines over the same x axis; the last point of the first series is labelled. */
export function LineChart({ series, labels, height = 180, fmt = (v) => `${v}`, min = 0 }: {
  series: Series[]; labels: string[]; height?: number; fmt?: (v: number) => string; min?: number;
}) {
  const max = niceMax(Math.max(...series.flatMap((x) => x.values), 1));
  const W = 100;
  const x = (i: number, len: number) => (len <= 1 ? W / 2 : (i / (len - 1)) * W);
  const y = (v: number) => 100 - ((v - min) / (max - min || 1)) * 100;
  const head = series[0];
  const lv = head.values[head.values.length - 1];
  return (
    <div className={s.chartBox}>
      <div className={s.plot} style={{ height }}>
        <Axis max={max} fmt={fmt} />
        <div className={s.plotArea}>
          <Grid />
          <svg className={s.lineSvg} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            {series.map((sr) => (
              <polyline key={sr.label} fill="none" stroke={sr.color} strokeWidth={sr.dashed ? 1.6 : 2.4} strokeDasharray={sr.dashed ? '5 4' : undefined}
                vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" pathLength={1} className={sr.dashed ? undefined : 'anim-draw'}
                points={sr.values.map((v, i) => `${x(i, sr.values.length)},${y(v)}`).join(' ')} />
            ))}
          </svg>
          <span className={s.lastDot} style={{ left: `${x(head.values.length - 1, head.values.length)}%`, bottom: `${100 - y(lv)}%`, background: head.color }} />
          <em className={s.lastVal} style={{ bottom: `${100 - y(lv)}%` }}>{fmt(lv)}</em>
        </div>
      </div>
      <XLabels labels={labels} />
    </div>
  );
}

function XLabels({ labels }: { labels: string[] }) {
  const step = labels.length > 8 ? 2 : 1;
  return (
    <div className={s.xLabels}>
      {labels.map((l, i) => <span key={l + i} className={i === labels.length - 1 ? s.xNow : undefined}>{i % step === (labels.length - 1) % step ? l : ''}</span>)}
    </div>
  );
}

/** A chart card: plain-language title, freshness, the chart and one click-through. */
export function ChartCard({ title, question, fresh, legend, action, children }: {
  title: string; question?: string; fresh: string; legend?: ReactNode; action?: ReactNode; children: ReactNode;
}) {
  return (
    <section className={s.chartCard}>
      <header className={s.chartHead}>
        <div>
          <h3>{title}</h3>
          {question ? <p>{question}</p> : null}
        </div>
        {legend}
      </header>
      {children}
      <footer className={s.chartFoot}>
        <span>{fresh}</span>
        {action}
      </footer>
    </section>
  );
}
