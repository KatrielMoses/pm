import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { fontVars } from './fonts';
import './globals.css';

export const metadata: Metadata = { title: 'Dashboard mockups', description: 'Round 1 dashboard directions' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={fontVars}>
      <body>{children}</body>
    </html>
  );
}
