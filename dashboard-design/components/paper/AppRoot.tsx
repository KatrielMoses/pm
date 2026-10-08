'use client';

import type { ReactNode } from 'react';
import { Workspace } from '@/lib/workspace';
import { AppProvider } from '@/lib/app-state';
import type { Kit } from '@/lib/kits';
import { Shell } from './Shell';

/** Locked product palette (Round 1, mockup 02 "Paper"); brands override it with their identity kits. */
export const PAPER_KIT: Kit = { name: 'Paper', colors: ['#FF5F1F', '#FFFFFF', '#141414'] };

export function AppRoot({ children }: { children: ReactNode }) {
  return (
    <Workspace house={PAPER_KIT}>
      <AppProvider>
        <Shell>{children}</Shell>
      </AppProvider>
    </Workspace>
  );
}
