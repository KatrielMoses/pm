import { useEffect, useRef, type ReactNode } from 'react';
import { PUBLIC_CONFIG } from '@pm/config/public';
import { Link } from '../router.tsx';
import { OfflineBanner } from './feedback.tsx';

/**
 * Page frame: one `main`, one `h1` that receives focus on navigation (screen readers announce the
 * new page), and a unique document title (0E A11Y-SR).
 */
export function Page({
  title,
  children,
  wide = false,
  lead,
}: {
  title: string;
  children: ReactNode;
  wide?: boolean;
  lead?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${title} · ${PUBLIC_CONFIG.appName}`;
    heading.current?.focus();
  }, [title]);
  return (
    <div className="frame">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="frame-header">
        <Link to="/" className="brand">
          {PUBLIC_CONFIG.appName}
        </Link>
      </header>
      <OfflineBanner />
      <main id="main" className={wide ? 'page page-wide' : 'page'}>
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        {lead ? <p className="lead">{lead}</p> : null}
        {children}
      </main>
    </div>
  );
}
