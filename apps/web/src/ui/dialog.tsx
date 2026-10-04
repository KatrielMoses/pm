import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Open dialogs, bottom to top. Only the top one is interactive; the ones beneath become inert. */
const stack: Array<(top: boolean) => void> = [];
const syncStack = () => stack.forEach((set, i) => set(i === stack.length - 1));

/** Whether any modal dialog is open (global shortcuts never act behind a modal; RS-12). */
export const isModalOpen = (): boolean => stack.length > 0;

/**
 * Modal dialog (0E DS dialog; ST-33 for destructive actions): labelled, focus trapped, Esc closes,
 * focus returns to the opener. `destructive` uses alertdialog with initial focus on Cancel.
 * Dialogs stack (e.g. step-up over a confirmation): the lower dialog stays mounted but inert.
 */
export function Dialog({
  title,
  description,
  children,
  onClose,
  destructive = false,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  destructive?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const [top, setTop] = useState(true);
  const isTop = useRef(true);
  useEffect(() => {
    const set = (value: boolean) => {
      isTop.current = value;
      setTop(value);
    };
    stack.push(set);
    syncStack();
    return () => {
      stack.splice(stack.indexOf(set), 1);
      syncStack();
    };
  }, []);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current!;
    const focusables = () =>
      [
        ...node.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => !el.hasAttribute('disabled'));
    const initial = destructive
      ? node.querySelector<HTMLElement>('[data-cancel]')
      : node.querySelector<HTMLElement>('input, [data-initial]');
    (initial ?? focusables()[0] ?? node).focus();
    const onKey = (e: KeyboardEvent) => {
      if (!isTop.current) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Tab') {
        const items = focusables();
        if (!items.length) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [destructive, onClose]);
  // Portalled to the document body so no sticky or positioned ancestor (the shell header) can
  // trap the scrim below other fixed shell surfaces.
  return createPortal(
    <div className="scrim" inert={!top}>
      <div
        ref={ref}
        className="dialog"
        role={destructive ? 'alertdialog' : 'dialog'}
        aria-modal={top}
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : undefined}
        tabIndex={-1}
      >
        <h2 id={`${id}-title`}>{title}</h2>
        {description ? (
          <div id={`${id}-desc`} className="dialog-desc">
            {description}
          </div>
        ) : null}
        {children}
      </div>
    </div>,
    document.body,
  );
}
