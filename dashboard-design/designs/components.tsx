'use client';

import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';

/* Each design is code-split so one broken mockup never takes the others down. */
export const designComponents: Record<number, ComponentType> = {
  1: dynamic(() => import('./d01')),
  2: dynamic(() => import('./d02')),
  3: dynamic(() => import('./d03')),
  4: dynamic(() => import('./d04')),
  5: dynamic(() => import('./d05')),
  6: dynamic(() => import('./d06')),
  7: dynamic(() => import('./d07')),
  8: dynamic(() => import('./d08')),
  9: dynamic(() => import('./d09')),
  10: dynamic(() => import('./d10')),
  11: dynamic(() => import('./d11')),
  12: dynamic(() => import('./d12')),
  13: dynamic(() => import('./d13')),
  14: dynamic(() => import('./d14')),
  15: dynamic(() => import('./d15')),
  16: dynamic(() => import('./d16')),
  17: dynamic(() => import('./d17')),
  18: dynamic(() => import('./d18')),
  19: dynamic(() => import('./d19')),
  20: dynamic(() => import('./d20')),
};
