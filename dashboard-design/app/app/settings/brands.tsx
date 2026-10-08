'use client';

/*
 * Settings → Brands & identity kits: the product's signature feature. A brand's logo gives three
 * colours; deriveTheme turns them into readable accents; the live preview shows a mini Paper
 * dashboard themed with the result; "Apply to app" pushes the kit to the whole app.
 */

import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import {
  ArrowRight, Bot, CalendarDays, Check, CircleAlert, ImageUp, Inbox, Moon, Pipette, Plus, RotateCcw, ScanLine, Sparkles, Sun, Zap,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace';
import { useApp } from '@/lib/app-state';
import { brands, brandName, brandShort, type BrandId } from '@/lib/data';
import { BRAND_KITS, contrast, deriveTheme, themeVars, type Theme } from '@/lib/kits';
import { Badge, Button, Segmented, u } from '@/components/paper/ui';
import { extractColors } from './extract';
import { SAMPLE_LOGOS, SampleLogo, type Trio } from './samples';
import s from './settings.module.css';

type Logo = { kind: 'sample'; i: number } | { kind: 'file'; url: string; name: string } | null;
const ROLES = ['Primary', 'Secondary', 'Tertiary'];
const initialKits = () => Object.fromEntries(brands.map((b) => [b.id, [...BRAND_KITS[b.id].colors] as Trio])) as Record<BrandId, Trio>;
const same = (a: string[], b: string[]) => a.join().toLowerCase() === b.join().toLowerCase();

function LogoView({ logo, id, theme, size }: { logo: Logo; id: BrandId; theme: Theme; size: number }) {
  if (logo?.kind === 'sample') return <SampleLogo sample={SAMPLE_LOGOS[logo.i]} size={size} />;
  if (logo?.kind === 'file') {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logo.url} alt={logo.name} width={size} height={size} style={{ borderRadius: size * 0.28, objectFit: 'contain', background: 'var(--card)', flex: 'none' }} />;
  }
  return (
    <span className={s.chip} style={{ width: size, height: size, borderRadius: size * 0.28, fontSize: size * 0.36, background: theme.accent, color: theme.accentInk }}>
      {brandShort(id)}
    </span>
  );
}

export function BrandsKits() {
  const { customKit, setCustomKit, brand } = useWorkspace();
  const { toast, mode } = useApp();
  const [sel, setSel] = useState<BrandId>(brand ?? 'op');
  const [kits, setKits] = useState<Record<BrandId, Trio>>(initialKits);
  const [logos, setLogos] = useState<Record<BrandId, Logo>>({ ma: null, ax: null, op: null });
  const [scan, setScan] = useState<'idle' | 'scanning' | 'done'>('idle');
  const [cursor, setCursor] = useState(0);
  const [drag, setDrag] = useState(false);
  const [pvMode, setPvMode] = useState<'light' | 'dark'>(mode);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  // follow the top-bar brand switcher
  useEffect(() => { if (brand) { setSel(brand); setScan('idle'); } }, [brand]);

  const colors = kits[sel];
  const theme = deriveTheme({ name: brandName(sel), colors });
  const vars = themeVars(theme) as CSSProperties;
  const live = !!customKit && same(customKit.colors, colors) && customKit.name === brandName(sel);
  const changed = !same(colors, BRAND_KITS[sel].colors) || logos[sel] !== null;
  const ratio = contrast(theme.accent, theme.accentInk);
  const fromLogo = (c: string) => colors.some((x) => x.toLowerCase() === c.toLowerCase());
  const derivedCount = [theme.accent2, theme.accent3].filter((c) => !fromLogo(c)).length;

  const pick = (id: BrandId) => { setSel(id); setScan(logos[id] ? 'done' : 'idle'); };

  const upload = () => {
    if (scan === 'scanning') return;
    const i = cursor % SAMPLE_LOGOS.length;
    const target = sel;
    setCursor((c) => c + 1);
    setLogos((l) => ({ ...l, [target]: { kind: 'sample', i } }));
    setScan('scanning');
    timer.current = setTimeout(() => {
      setKits((k) => ({ ...k, [target]: [...SAMPLE_LOGOS[i].colors] as Trio }));
      setScan('done');
    }, 1400);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const file = e.dataTransfer.files?.[0];
    if (!file || !file.type.startsWith('image/')) { upload(); return; }
    const url = URL.createObjectURL(file);
    const target = sel;
    setLogos((l) => ({ ...l, [target]: { kind: 'file', url, name: file.name } }));
    setScan('scanning');
    Promise.all([extractColors(url), new Promise((r) => setTimeout(r, 1100))])
      .then(([c]) => { setKits((k) => ({ ...k, [target]: c })); setScan('done'); })
      .catch(() => { setScan('idle'); toast('Could not read image', 'bad'); });
  };

  const setColor = (i: number, hex: string) => setKits((k) => {
    const next = [...k[sel]] as Trio;
    next[i] = hex.toUpperCase();
    return { ...k, [sel]: next };
  });

  const apply = () => { setCustomKit({ name: brandName(sel), colors: [...colors] as Trio }); toast(`${brandName(sel)} kit applied`); };
  const reset = () => {
    if (live || customKit) setCustomKit(null);
    setKits((k) => ({ ...k, [sel]: [...BRAND_KITS[sel].colors] as Trio }));
    setLogos((l) => ({ ...l, [sel]: null }));
    setScan('idle');
    toast('Kit reset');
  };

  const logo = logos[sel];
  const sample = logo?.kind === 'sample' ? SAMPLE_LOGOS[logo.i] : null;

  return (
    <div className={s.stack}>
      {/* brand strip */}
      <div className={s.brandStrip}>
        {brands.map((b, i) => {
          const t = deriveTheme({ name: b.name, colors: kits[b.id] });
          const on = sel === b.id;
          const isLive = !!customKit && customKit.name === b.name && same(customKit.colors, kits[b.id]);
          return (
            <button key={b.id} className={on ? s.brandOn : s.brandCard} onClick={() => pick(b.id)} style={{ animationDelay: `${i * 50}ms` }}>
              <LogoView logo={logos[b.id]} id={b.id} theme={t} size={44} />
              <span className={s.brandMeta}>
                <b>{b.name}</b>
                <span className={s.dots}>{kits[b.id].map((c, j) => <i key={j} style={{ background: c }} title={c} />)}</span>
              </span>
              {isLive ? <Badge tone="accent" dot>Live</Badge> : <Badge tone="green" dot>Active</Badge>}
            </button>
          );
        })}
        <button className={s.brandAdd} onClick={() => toast('Brand draft created')}><Plus size={16} /> Add brand</button>
      </div>

      <div className={s.kitGrid}>
        {/* editor */}
        <section className={u.card} style={{ animationDelay: '80ms' }}>
          <header className={u.cardHead}>
            <span className={u.cardTitle}><span className={u.iconDot}><ImageUp size={15} /></span>Logo</span>
            {scan === 'scanning' ? <Badge tone="accent" dot>Scanning</Badge> : scan === 'done' ? <Badge tone="green" dot>3 colours</Badge> : <Badge tone="outline">PNG · SVG</Badge>}
          </header>

          <div
            className={`${s.drop} ${drag ? s.dropOver : ''} ${scan === 'scanning' ? s.dropScan : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
            onClick={upload}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); upload(); } }}
            aria-label="Upload logo"
          >
            {logo ? (
              <div className={s.dropLogo}>
                <LogoView logo={logo} id={sel} theme={theme} size={84} />
                {scan === 'scanning' ? <span className={s.scanLine} /> : null}
              </div>
            ) : (
              <span className={s.dropIcon}><ImageUp size={22} /></span>
            )}
            <div className={s.dropText}>
              <b>{logo ? (logo.kind === 'sample' ? sample?.name : logo.name) : 'Drop logo'}</b>
              <span>{scan === 'scanning' ? 'Reading colours…' : logo ? 'Click to swap' : 'or click'}</span>
            </div>
            <Button variant="dark" size="sm" icon={scan === 'scanning' ? <ScanLine size={14} className="anim-pulse" /> : <ImageUp size={14} />}>
              {scan === 'scanning' ? 'Scanning' : 'Upload logo'}
            </Button>
          </div>

          <div className={s.swatches}>
            {colors.map((c, i) => (
              <label key={i} className={`${s.swatch} ${scan === 'scanning' ? s.swatchScan : ''}`} style={{ animationDelay: `${i * 90}ms` }}>
                <span className={s.swatchColor} style={{ background: c }}>
                  <Pipette size={14} className={s.swatchPip} style={{ color: deriveTheme({ name: '', colors: [c, c, c] }).accentInk }} />
                </span>
                <span className={s.swatchMeta}><b>{c.toUpperCase()}</b><span>{ROLES[i]}</span></span>
                <input type="color" value={c.length === 7 ? c.toLowerCase() : '#000000'} onChange={(e) => setColor(i, e.target.value)} aria-label={`${ROLES[i]} colour`} />
              </label>
            ))}
          </div>

          <div className={s.derive}>
            <span className={s.cap}>Theme</span>
            <div className={s.deriveRow}>
              {[
                { c: theme.accent, ink: theme.accentInk, l: 'Accent' },
                { c: theme.accent2, ink: theme.accent2Ink, l: '2nd' },
                { c: theme.accent3, ink: theme.accent3Ink, l: '3rd' },
              ].map((a, i) => (
                <div key={i} className={s.deriveChip}>
                  <span className={s.deriveSw} style={{ background: a.c, color: a.ink }}>Aa</span>
                  <span className={s.deriveMeta}>
                    <b>{a.l}</b>
                    {fromLogo(a.c) ? <span className={s.fromLogo}>Logo</span> : <span className={s.derived}><Sparkles size={10} /> Derived</span>}
                  </span>
                </div>
              ))}
            </div>
            <div className={s.deriveFoot}>
              {ratio >= 4.5 ? <Badge tone="green" dot>AA {ratio.toFixed(1)}</Badge> : ratio >= 3 ? <Badge tone="amber" dot>Large {ratio.toFixed(1)}</Badge> : <Badge tone="red" dot>Low {ratio.toFixed(1)}</Badge>}
              {derivedCount ? <Badge tone="outline">{derivedCount} derived</Badge> : <Badge tone="outline">All from logo</Badge>}
            </div>
          </div>

          <div className={s.kitActions}>
            <Button variant="ghost" icon={<RotateCcw size={15} />} onClick={reset} disabled={!changed && !customKit}>Reset</Button>
            <Button variant={live ? 'light' : 'accent'} icon={live ? <Check size={15} /> : <Zap size={15} />} onClick={apply} style={{ flex: 1 }}>
              {live ? 'Applied' : 'Apply to app'}
            </Button>
          </div>
        </section>

        {/* live preview */}
        <section className={u.card} style={{ animationDelay: '140ms' }}>
          <header className={u.cardHead}>
            <span className={u.cardTitle}><span className={s.liveDot}><i className="anim-ping" /><i /></span>Live preview</span>
            <Segmented size="sm" sub value={pvMode} onChange={setPvMode} options={[{ id: 'light', label: 'Light', icon: <Sun size={13} /> }, { id: 'dark', label: 'Dark', icon: <Moon size={13} /> }]} />
          </header>
          <KitPreview vars={vars} mode={pvMode} name={brandName(sel)} logo={<LogoView logo={logo} id={sel} theme={theme} size={26} />} scanning={scan === 'scanning'} />
          <div className={s.pvFoot}>
            <span className={s.flow}>
              <span className={s.dots}>{colors.map((c, j) => <i key={j} style={{ background: c }} />)}</span>
              <ArrowRight size={13} />
              <span className={s.dots}>{[theme.accent, theme.accent2, theme.accent3].map((c, j) => <i key={j} style={{ background: c }} />)}</span>
            </span>
            {live ? <Badge tone="accent" dot>Live in app</Badge> : customKit ? <Badge tone="amber" dot>{customKit.name} live</Badge> : <Badge tone="outline">Not applied</Badge>}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ---------- mini Paper dashboard themed by the draft kit ---------- */

const WEEK = [{ d: 'M', a: 5, p: 4.5 }, { d: 'T', a: 5, p: 6.5 }, { d: 'W', a: 6, p: 5 }, { d: 'T', a: 4, p: 5.5 }, { d: 'F', a: 6, p: 3 }];

function KitPreview({ vars, mode, name, logo, scanning }: { vars: CSSProperties; mode: 'light' | 'dark'; name: string; logo: ReactNode; scanning: boolean }) {
  return (
    <div className={`paper ${s.pv} ${scanning ? s.pvScan : ''}`} data-mode={mode} style={{ ...vars, minHeight: 0 }}>
      <div className={s.pvTop}>
        <span className={s.pvPill}>{logo}<b>{name}</b></span>
        <span className={s.pvSwitch}><i className={s.pvSwOn}>Brand</i><i>All</i></span>
        <span className={s.pvCapture}><Plus size={14} strokeWidth={2.6} /></span>
      </div>
      <div className={s.pvRow}>
        <div className={s.pvCard}>
          <span className={s.pvLabel}>Today <em><CalendarDays size={10} /> Tue</em></span>
          <span className={s.pvBig}>6.5h<small>/ 5h</small></span>
          <span className={s.pvOver}><CircleAlert size={10} /> 1.5h over</span>
          <span className={s.pvCapBar}><i style={{ width: '70%' }} /><i /></span>
          <span className={s.pvBtns}><i className={s.pvBtnDark}><Zap size={10} /> Rebalance</i><i className={s.pvBtnAcc}>Plan day</i></span>
        </div>
        <div className={s.pvHero}>
          <span className={s.pvLabel}>Needs you <em className={s.pvHeroIcon}><Inbox size={11} /></em></span>
          <span className={s.pvBig}>4</span>
          <span className={s.pvTags}><i>3 review</i><i className={s.pvBad}>1 failed</i></span>
        </div>
        <div className={s.pvCard}>
          <span className={s.pvLabel}>Week</span>
          <span className={s.pvWeek}>
            {WEEK.map((w, i) => (
              <span key={i} className={s.pvCol}>
                <span className={s.pvStack}>
                  {w.p > w.a ? <i className={s.pvSegOver} style={{ height: `${(w.p - w.a) * 9}px` }} /> : null}
                  <i className={i === 1 ? s.pvSegToday : s.pvSegIn} style={{ height: `${Math.min(w.p, w.a) * 9}px` }} />
                </span>
                <em className={i === 1 ? s.pvDayOn : undefined}>{w.d}</em>
              </span>
            ))}
          </span>
        </div>
      </div>
      <div className={s.pvRow2}>
        <div className={s.pvCard}>
          {[
            { t: 'Review PR #212', st: 'In progress', cls: s.pvStDoing, icon: <Bot size={10} /> },
            { t: 'Credits page copy', st: 'To do', cls: s.pvStTodo, icon: null },
            { t: 'Fix flaky heal', st: 'Done', cls: s.pvStDone, icon: null },
          ].map((r, i) => (
            <span key={i} className={s.pvTask}>
              <i className={i === 2 ? s.pvCbOn : s.pvCb}>{i === 2 ? <Check size={8} strokeWidth={3} /> : null}</i>
              <b className={i === 2 ? s.pvStruck : undefined}>{r.t}</b>{r.icon}
              <em className={r.cls}>{r.st}</em>
            </span>
          ))}
        </div>
        <div className={s.pvGoal}>
          <span className={s.pvLabel}>MRR <em>25%</em></span>
          <span className={s.pvBigSm}>$1,240</span>
          <span className={s.pvMeter}><i style={{ width: '25%' }} /></span>
        </div>
        <div className={s.pvCard}>
          <span className={s.pvLabel}>AI spend <em>46%</em></span>
          <span className={s.pvHatch}><i style={{ width: '46%' }} /></span>
          <span className={s.pvKits}><i style={{ background: 'var(--k1)' }} /><i style={{ background: 'var(--k2)' }} /><i style={{ background: 'var(--k3)' }} /></span>
        </div>
      </div>
    </div>
  );
}
