'use client';

/*
 * Small, dependency-free chart primitives. Colours are plain CSS strings so designs pass
 * kit variables ('var(--k1)') or their own neutrals. All motion is CSS (see globals.css) and is
 * switched off under prefers-reduced-motion.
 */

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';

type Common = { className?: string; style?: CSSProperties };

/* ---------- animated number ---------- */

export function CountUp({ value, decimals = 0, prefix = '', suffix = '', duration = 900 }: { value: number; decimals?: number; prefix?: string; suffix?: string; duration?: number }) {
  const [v, setV] = useState(value);
  const from = useRef(0);
  useEffect(() => {
    const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || document.visibilityState !== 'visible') { setV(value); from.current = value; return; }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      const e = 1 - Math.pow(1 - k, 3);
      setV(a + (value - a) * e);
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    // rAF is paused in hidden tabs; never leave a stale number on screen.
    const settle = setTimeout(() => { cancelAnimationFrame(raf); setV(value); from.current = value; }, duration + 150);
    return () => { cancelAnimationFrame(raf); clearTimeout(settle); };
  }, [value, duration]);
  const txt = v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return <span className="tnum">{prefix}{txt}{suffix}</span>;
}

/* ---------- vertical bars ---------- */

export function Bars({
  values, max, highlight, color = 'currentColor', highlightColor, track, height = 120, gap = 6, radius = 6,
  labels, labelColor, striped, showValue, className, style, minBar = 4, barWidth,
}: Common & {
  values: number[]; max?: number; highlight?: number; color?: string; highlightColor?: string; track?: string;
  height?: number; gap?: number; radius?: number; labels?: string[]; labelColor?: string; striped?: boolean;
  showValue?: (v: number, i: number) => ReactNode; minBar?: number; barWidth?: number;
}) {
  const m = max ?? Math.max(...values, 1);
  return (
    <div className={className} style={{ ...style }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap, height }}>
        {values.map((v, i) => {
          const h = Math.max(minBar, (v / m) * height);
          const hi = highlight === i;
          return (
            <div key={i} style={{ flex: barWidth ? `0 0 ${barWidth}px` : 1, height: '100%', display: 'flex', alignItems: 'flex-end', position: 'relative', background: track, borderRadius: radius }}>
              {showValue && hi ? <div style={{ position: 'absolute', bottom: h + 8, left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap' }}>{showValue(v, i)}</div> : null}
              <div
                className="anim-grow-y"
                style={{
                  width: '100%', height: h, borderRadius: radius, animationDelay: `${i * 40}ms`,
                  background: hi ? (highlightColor ?? color) : color,
                  backgroundImage: striped && !hi ? 'repeating-linear-gradient(135deg, rgba(255,255,255,.14) 0 4px, transparent 4px 9px)' : undefined,
                }}
              />
            </div>
          );
        })}
      </div>
      {labels ? (
        <div style={{ display: 'flex', gap, marginTop: 8 }}>
          {labels.map((l, i) => (
            <div key={i} style={{ flex: barWidth ? `0 0 ${barWidth}px` : 1, textAlign: 'center', fontSize: 11, color: labelColor, fontWeight: highlight === i ? 600 : 400, opacity: highlight === i ? 1 : 0.7 }}>{l}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- line / area ---------- */

function path(values: number[], w: number, h: number, smooth: boolean, max?: number, min?: number) {
  const hi = max ?? Math.max(...values);
  const lo = min ?? Math.min(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - ((v - lo) / span) * (h - 6) - 3] as const);
  if (!smooth) return { d: pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '), pts };
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const cx = (x0 + x1) / 2;
    d += ` C${cx.toFixed(1)},${y0.toFixed(1)} ${cx.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return { d, pts };
}

export function Spark({
  values, width = 240, height = 64, color = 'currentColor', fill, strokeWidth = 2, smooth = true, dot = true,
  max, min, className, style, dotFill,
}: Common & { values: number[]; width?: number; height?: number; color?: string; fill?: string; strokeWidth?: number; smooth?: boolean; dot?: boolean; max?: number; min?: number; dotFill?: string }) {
  const { d, pts } = path(values, width, height, smooth, max, min);
  const last = pts[pts.length - 1];
  const id = `g${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none" className={className} style={{ overflow: 'visible', ...style }}>
      {fill ? (
        <>
          <defs>
            <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={fill} stopOpacity="0.45" />
              <stop offset="1" stopColor={fill} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${d} L${width},${height} L0,${height} Z`} fill={`url(#${id})`} className="anim-fade" />
        </>
      ) : null}
      <path d={d} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" vectorEffect="non-scaling-stroke" pathLength={1} className="anim-draw" />
      {dot ? <circle cx={last[0]} cy={last[1]} r={4} fill={dotFill ?? color} stroke={color} strokeWidth={2} className="anim-pop" /> : null}
    </svg>
  );
}

/* ---------- ring / donut ---------- */

export function Ring({
  value, size = 120, stroke = 12, color = 'currentColor', track = 'rgba(127,127,127,.18)', children, className, style, round = true, segments,
}: Common & { value: number; size?: number; stroke?: number; color?: string; track?: string; children?: ReactNode; round?: boolean; segments?: { value: number; color: string }[] }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className={className} style={{ position: 'relative', width: size, height: size, ...style }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        {segments
          ? segments.map((sg, i) => {
              const len = sg.value * c;
              const el = (
                <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={sg.color} strokeWidth={stroke}
                  strokeDasharray={`${Math.max(0, len - (segments.length > 1 ? 3 : 0))} ${c}`} strokeDashoffset={-acc} className="anim-ring" />
              );
              acc += len;
              return el;
            })
          : (
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap={round ? 'round' : 'butt'}
              strokeDasharray={`${Math.min(1, Math.max(0, value)) * c} ${c}`} className="anim-ring" />
          )}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>{children}</div>
    </div>
  );
}

/* ---------- tick gauge (semi-circle of segments) ---------- */

export function Gauge({
  value, size = 200, ticks = 28, color = 'currentColor', track = 'rgba(127,127,127,.25)', tickLength = 18, tickWidth = 6, children, className, style, colorEnd,
}: Common & { value: number; size?: number; ticks?: number; color?: string; colorEnd?: string; track?: string; tickLength?: number; tickWidth?: number; children?: ReactNode }) {
  const r = size / 2 - 4;
  const lit = Math.round(value * ticks);
  return (
    <div className={className} style={{ position: 'relative', width: size, height: size / 2 + 12, ...style }}>
      <svg width={size} height={size / 2 + 12} viewBox={`0 0 ${size} ${size / 2 + 12}`}>
        {Array.from({ length: ticks }, (_, i) => {
          const a = Math.PI + (i / (ticks - 1)) * Math.PI;
          // Rounded so server and browser trig agree (hydration).
          const q = (v: number) => Math.round(v * 100) / 100;
          const x1 = q(size / 2 + Math.cos(a) * r), y1 = q(size / 2 + Math.sin(a) * r + 4);
          const x2 = q(size / 2 + Math.cos(a) * (r - tickLength)), y2 = q(size / 2 + Math.sin(a) * (r - tickLength) + 4);
          const on = i < lit;
          return (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={tickWidth} strokeLinecap="round"
              stroke={on ? (colorEnd && i > ticks * 0.66 ? colorEnd : color) : track} className="anim-fade" style={{ animationDelay: `${i * 18}ms` }} />
          );
        })}
      </svg>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, textAlign: 'center' }}>{children}</div>
    </div>
  );
}

/* ---------- heatmap ---------- */

export function Heat({ grid, color = 'currentColor', empty = 'rgba(127,127,127,.12)', cell = 14, gap = 4, radius = 4, max, rowLabels, labelColor, className, style }: Common & {
  grid: number[][]; color?: string; empty?: string; cell?: number | string; gap?: number; radius?: number; max?: number; rowLabels?: string[]; labelColor?: string;
}) {
  const m = max ?? Math.max(...grid.flat(), 1);
  return (
    <div className={className} style={{ display: 'grid', gap, ...style }}>
      {grid.map((row, r) => (
        <div key={r} style={{ display: 'flex', gap, alignItems: 'center' }}>
          {rowLabels ? <span style={{ width: 28, fontSize: 11, color: labelColor, opacity: 0.7 }}>{rowLabels[r]}</span> : null}
          {row.map((v, c) => (
            <div key={c} className="anim-fade" style={{
              flex: typeof cell === 'string' ? 1 : `0 0 ${cell}px`, height: typeof cell === 'string' ? cell : cell, borderRadius: radius,
              background: v === 0 ? empty : `color-mix(in srgb, ${color} ${Math.round(25 + (v / m) * 75)}%, transparent)`,
              animationDelay: `${(r + c) * 12}ms`,
            }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ---------- dots progress ---------- */

export function Dots({ value, total, color = 'currentColor', track = 'rgba(127,127,127,.22)', size = 10, gap = 4, className, style }: Common & { value: number; total: number; color?: string; track?: string; size?: number; gap?: number }) {
  return (
    <div className={className} style={{ display: 'flex', gap, flexWrap: 'wrap', ...style }}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className="anim-pop" style={{ width: size, height: size, borderRadius: 999, background: i < value ? color : track, animationDelay: `${i * 25}ms` }} />
      ))}
    </div>
  );
}

/* ---------- linear meter ---------- */

export function Meter({ value, max = 1, color = 'currentColor', track = 'rgba(127,127,127,.18)', height = 8, radius = 999, striped, over, overColor, className, style }: Common & {
  value: number; max?: number; color?: string; track?: string; height?: number; radius?: number; striped?: boolean; over?: number; overColor?: string;
}) {
  const total = Math.max(max, value + (over ?? 0));
  const w = (Math.min(value, max) / total) * 100;
  const o = over ? (over / total) * 100 : 0;
  return (
    <div className={className} style={{ height, borderRadius: radius, background: track, overflow: 'hidden', display: 'flex', ...style }}>
      <div className="anim-grow-x" style={{ width: `${w}%`, background: color, borderRadius: radius, backgroundImage: striped ? 'repeating-linear-gradient(135deg, rgba(255,255,255,.22) 0 4px, transparent 4px 9px)' : undefined }} />
      {o ? <div className="anim-grow-x" style={{ width: `${o}%`, marginLeft: 2, borderRadius: radius, background: overColor ?? color, backgroundImage: 'repeating-linear-gradient(135deg, rgba(255,255,255,.35) 0 3px, transparent 3px 7px)', animationDelay: '300ms' }} /> : null}
    </div>
  );
}

/* ---------- stacked bar ---------- */

export function Stack({ parts, height = 10, gap = 3, radius = 999, className, style }: Common & { parts: { value: number; color: string; label?: string }[]; height?: number; gap?: number; radius?: number }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div className={className} style={{ display: 'flex', gap, height, ...style }}>
      {parts.map((p, i) => (
        <div key={i} title={p.label} className="anim-grow-x" style={{ flex: `${p.value / total} 1 0`, background: p.color, borderRadius: radius, animationDelay: `${i * 80}ms` }} />
      ))}
    </div>
  );
}

/* ---------- ticks bar (many thin bars, e.g. "barcode" density) ---------- */

export function Ticks({ values, color = 'currentColor', dim = 'rgba(127,127,127,.3)', height = 48, gap = 2, highlightFrom = 0, highlightTo = Infinity, className, style }: Common & {
  values: number[]; color?: string; dim?: string; height?: number; gap?: number; highlightFrom?: number; highlightTo?: number;
}) {
  const m = Math.max(...values, 1);
  return (
    <div className={className} style={{ display: 'flex', alignItems: 'flex-end', gap, height, ...style }}>
      {values.map((v, i) => (
        <div key={i} className="anim-grow-y" style={{ flex: 1, height: `${Math.max(6, (v / m) * 100)}%`, borderRadius: 2, background: i >= highlightFrom && i <= highlightTo ? color : dim, animationDelay: `${i * 8}ms` }} />
      ))}
    </div>
  );
}

/** Deterministic pseudo-random series for decorative density charts. */
export function series(n: number, seed = 1, base = 40, amp = 30) {
  let x = seed;
  return Array.from({ length: n }, (_, i) => {
    x = (x * 9301 + 49297) % 233280;
    const r = x / 233280;
    return Math.round(base + Math.sin(i / 3 + seed) * amp * 0.6 + r * amp);
  });
}
