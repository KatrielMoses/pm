import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { PUBLIC_CONFIG } from '@pm/config/public';
import { Link, useRouter } from '../router.tsx';
import { Breadcrumbs, type Crumb } from '../shell/breadcrumbs.tsx';
import { useShellFrame } from '../shell/frame.ts';
import { documentTitle, matchRoute } from '../shell/registry.ts';
import { OfflineBanner } from './feedback.tsx';

/**
 * ST-41: anything on a page that finds its subject missing or not authorized switches the whole
 * page to the one canonical not-available state (same heading, copy, and title in every case).
 */
/** The path whose heading last received navigation focus (one per arrival). */
let lastFocusedPath: string | null = null;

const NotAvailableContext = createContext<(() => void) | null>(null);

export function useMarkNotAvailable(): (() => void) | null {
  return useContext(NotAvailableContext);
}

/** The canonical copy (no record title, type, brand, owner, or workspace hint). */
export function NotAvailableBody({ home }: { home?: string }) {
  return (
    <>
      <p>
        It may have been moved or deleted, or you may not have access. Check the link, or ask the
        person who shared it.
      </p>
      <p className="actions">
        <Link to={home ?? '/workspaces'} className="button button-primary">
          Go to Home
        </Link>
      </p>
    </>
  );
}

/**
 * Page frame: one `main`, one `h1` that receives focus on navigation (screen readers announce the
 * new page), and a document title `{record} · {section} · {product}` (IA-14). Inside the
 * application shell the shell owns the header, navigation, skip links, and offline banner; outside
 * it (signed-out pages) this renders the minimal shell.
 */
export function Page({
  title,
  children,
  wide = false,
  lead,
  record,
  breadcrumbs,
  actions,
  section: sectionOverride,
}: {
  title: string;
  children: ReactNode;
  wide?: boolean;
  lead?: ReactNode;
  /** The record this page shows; brand names are never put in the document title (UXD-07). */
  record?: { title: string; isBrand?: boolean } | null;
  breadcrumbs?: Crumb[];
  /** Context-bar actions (favorite, overflow). */
  actions?: ReactNode;
  /** Overrides the registry section in the document title (ST-41 uses "Not available"). */
  section?: string;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const frame = useShellFrame();
  const { path } = useRouter();
  const [notAvailableAt, setNotAvailableAt] = useState<string | null>(null);
  const notAvailable = notAvailableAt === path;
  const mark = useMemo(() => () => setNotAvailableAt(path), [path]);
  const section = notAvailable
    ? 'Not available'
    : (sectionOverride ?? matchRoute(path)?.def.section ?? title);
  const shownTitle = notAvailable ? "This page isn't available" : title;
  const docTitle = notAvailable
    ? documentTitle(PUBLIC_CONFIG.appName, section, null)
    : record !== undefined
      ? documentTitle(PUBLIC_CONFIG.appName, section, record)
      : documentTitle(PUBLIC_CONFIG.appName, section, title === section ? null : { title });
  useEffect(() => {
    document.title = docTitle;
  }, [docTitle]);
  // Focus moves to the heading when the person arrives at a new page (screen readers announce
  // it), not when a loaded page's title fills in, so focus they already moved (a skip link, a
  // field) is never taken back. If the previously focused heading unmounted, focus is restored.
  useEffect(() => {
    const lost = !document.activeElement || document.activeElement === document.body;
    if (lastFocusedPath !== path || lost) {
      lastFocusedPath = path;
      heading.current?.focus();
    }
  }, [path]);
  const body = (
    <main id="main" className={wide ? 'page page-wide' : 'page'} tabIndex={-1}>
      {breadcrumbs && !notAvailable ? <Breadcrumbs trail={breadcrumbs} /> : null}
      <div className={actions && !notAvailable ? 'page-head' : undefined}>
        <h1 ref={heading} tabIndex={-1}>
          {shownTitle}
        </h1>
        {actions && !notAvailable ? <div className="page-actions">{actions}</div> : null}
      </div>
      {lead && !notAvailable ? <p className="lead">{lead}</p> : null}
      {notAvailable ? (
        <NotAvailableBody />
      ) : (
        <NotAvailableContext.Provider value={mark}>{children}</NotAvailableContext.Provider>
      )}
    </main>
  );
  if (frame) return body;
  return (
    <div className="frame">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="frame-header">
        <Link to="/" className="brand">
          {PUBLIC_CONFIG.appName}
        </Link>
      </header>
      <OfflineBanner />
      {body}
    </div>
  );
}
