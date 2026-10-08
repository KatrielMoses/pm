import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppRoot } from '@/components/paper/AppRoot';
import './paper.css';

export const metadata: Metadata = { title: { default: 'Untitled', template: '%s · Untitled' } };

export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppRoot>{children}</AppRoot>;
}
