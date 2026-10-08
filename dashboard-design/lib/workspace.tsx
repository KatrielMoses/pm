'use client';

import { createContext, useContext, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { BRAND_KITS, deriveTheme, themeVars, type Kit, type Theme } from './kits';
import { summary, type BrandId, type Summary } from './data';

type Ctx = {
  brand: BrandId | null;
  setBrand: (b: BrandId | null) => void;
  /** A kit typed into the toolbar ("load my logo colours") overrides everything while set. */
  customKit: Kit | null;
  setCustomKit: (k: Kit | null) => void;
  houseKit: Kit;
  kit: Kit;
  theme: Theme;
  s: Summary;
};

const WorkspaceCtx = createContext<Ctx | null>(null);

export function useWorkspace() {
  const v = useContext(WorkspaceCtx);
  if (!v) throw new Error('useWorkspace outside <Workspace>');
  return v;
}

/**
 * Wraps one mockup. `house` is the design's own default palette, used for the all-brands view
 * (and as the product palette candidate for that design).
 */
export function Workspace({ house, children, className, style }: { house: Kit; children: ReactNode; className?: string; style?: CSSProperties }) {
  const [brand, setBrand] = useState<BrandId | null>(null);
  const [customKit, setCustomKit] = useState<Kit | null>(null);
  const kit = customKit ?? (brand ? BRAND_KITS[brand] : house);
  const theme = useMemo(() => deriveTheme(kit), [kit]);
  const s = useMemo(() => summary(brand), [brand]);
  const vars = themeVars(theme) as CSSProperties;
  return (
    <WorkspaceCtx.Provider value={{ brand, setBrand, customKit, setCustomKit, houseKit: house, kit, theme, s }}>
      <div className={className} style={{ ...vars, ...style }} data-kit={kit.name}>
        {children}
      </div>
    </WorkspaceCtx.Provider>
  );
}
