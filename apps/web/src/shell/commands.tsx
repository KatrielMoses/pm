import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { SHELL_COMMAND_IDS, type ShellCommandId } from '@pm/contracts/shell';
import { useRouter } from '../router.tsx';
import { isModalOpen } from '../ui/dialog.tsx';
import { usePreferences } from './preferences.tsx';
import {
  chordEquals,
  eventChord,
  isEditable,
  isSingleKey,
  parseKeys,
  type Chord,
  type ShortcutLayer,
} from './shortcuts.ts';
import { countCommand } from './telemetry.ts';

/**
 * The extensible command registry (NAV-009, NAV-010). Each command has a stable id, label,
 * category, optional shortcut and layer, and one execution mode: a real link (`href`, Go to) or
 * an action (`run`). Commands are registered only when the principal may use them, so the
 * palette, shortcuts, menus, and the reference never show unavailable ones (absent, not
 * disabled). Consequential commands navigate to their normal form; nothing applies changes here.
 */
export interface Command {
  id: string;
  label: string;
  group: 'Actions' | 'Go to';
  keywords?: string;
  shortcut?: string;
  layer?: ShortcutLayer;
  /** Go to: a real URL (opens in a new tab with modified clicks in the palette). */
  href?: string;
  run?: () => void;
  /** Inner layers: active only while focus is inside this element (inner context wins). */
  within?: RefObject<HTMLElement | null>;
}

interface CommandState {
  commands: Command[];
  register: (owner: symbol, list: Command[]) => void;
  unregister: (owner: symbol) => void;
  paletteOpen: boolean;
  openPalette: (mode?: 'all' | 'actions') => void;
  closePalette: () => void;
  paletteMode: 'all' | 'actions';
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  execute: (c: Command, trigger: 'palette' | 'shortcut') => void;
}

const CommandContext = createContext<CommandState | null>(null);
const SEQUENCE_MS = 1500;
const TELEMETRY_IDS: ReadonlySet<string> = new Set(SHELL_COMMAND_IDS);

export function CommandProvider({ children }: { children: ReactNode }) {
  const { navigate } = useRouter();
  const { singleKeyShortcuts } = usePreferences();
  const [owners, setOwners] = useState<ReadonlyMap<symbol, Command[]>>(() => new Map());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<'all' | 'actions'>('all');
  const [helpOpen, setHelpOpen] = useState(false);

  const register = useCallback((owner: symbol, list: Command[]) => {
    setOwners((m) => new Map(m).set(owner, list));
  }, []);
  const unregister = useCallback((owner: symbol) => {
    setOwners((m) => {
      const next = new Map(m);
      next.delete(owner);
      return next;
    });
  }, []);

  const commands = useMemo(() => {
    const seen = new Map<string, Command>();
    for (const list of owners.values()) for (const c of list) seen.set(c.id, c);
    return [...seen.values()];
  }, [owners]);

  const execute = useCallback(
    (c: Command, trigger: 'palette' | 'shortcut') => {
      if (TELEMETRY_IDS.has(c.id)) countCommand(c.id as ShellCommandId, trigger);
      if (c.run) c.run();
      else if (c.href) navigate(c.href);
    },
    [navigate],
  );

  // One listener for the whole app, removed on unmount; it never acts behind a modal dialog.
  const latest = useRef({ commands, singleKeyShortcuts, paletteOpen, execute });
  useEffect(() => {
    latest.current = { commands, singleKeyShortcuts, paletteOpen, execute };
  }, [commands, singleKeyShortcuts, paletteOpen, execute]);
  useEffect(() => {
    let pending: { chord: Chord; at: number } | null = null;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.repeat) return;
      if (['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) return;
      const { commands: list, singleKeyShortcuts: singles, paletteOpen: open } = latest.current;
      const chord = eventChord(e);
      // The palette shortcut works everywhere, including editors (IA-11), but never over another
      // modal; inside the open palette it closes it.
      const palette = list.find((c) => c.id === 'palette.open' && c.shortcut);
      if (palette && chordEquals(parseKeys(palette.shortcut!)[0]!, chord)) {
        if (isModalOpen() && !open) return;
        e.preventDefault();
        if (open) setPaletteOpen(false);
        else {
          setPaletteMode('all');
          setPaletteOpen(true);
          if (TELEMETRY_IDS.has('palette.open')) countCommand('palette.open', 'shortcut');
        }
        return;
      }
      if (isModalOpen() || open) return;
      const editable = isEditable(e.target);
      const active = document.activeElement;
      const usable = list.filter((c) => {
        if (!c.shortcut || c.id === 'palette.open') return false;
        if (isSingleKey(c.shortcut) && (!singles || editable)) return false;
        if (c.layer && c.layer !== 'global')
          return Boolean(c.within?.current && active && c.within.current.contains(active));
        return true;
      });
      // Inner layers first (focus inside them wins over global).
      usable.sort((a, b) => Number(Boolean(b.within)) - Number(Boolean(a.within)));
      const now = Date.now();
      if (pending && now - pending.at <= SEQUENCE_MS) {
        const first = pending.chord;
        pending = null;
        const hit = usable.find((c) => {
          const seq = parseKeys(c.shortcut!);
          return seq.length === 2 && chordEquals(seq[0]!, first) && chordEquals(seq[1]!, chord);
        });
        if (hit) {
          e.preventDefault();
          latest.current.execute(hit, 'shortcut');
          return;
        }
      }
      pending = null;
      const single = usable.find((c) => {
        const seq = parseKeys(c.shortcut!);
        return seq.length === 1 && chordEquals(seq[0]!, chord);
      });
      if (single) {
        e.preventDefault();
        latest.current.execute(single, 'shortcut');
        return;
      }
      if (
        usable.some(
          (c) =>
            parseKeys(c.shortcut!).length === 2 && chordEquals(parseKeys(c.shortcut!)[0]!, chord),
        )
      )
        pending = { chord, at: now };
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const value = useMemo<CommandState>(
    () => ({
      commands,
      register,
      unregister,
      paletteOpen,
      paletteMode,
      openPalette: (mode = 'all') => {
        setPaletteMode(mode);
        setPaletteOpen(true);
      },
      closePalette: () => setPaletteOpen(false),
      helpOpen,
      setHelpOpen,
      execute,
    }),
    [commands, register, unregister, paletteOpen, paletteMode, helpOpen, execute],
  );
  return <CommandContext.Provider value={value}>{children}</CommandContext.Provider>;
}

export function useCommands(): CommandState {
  const ctx = useContext(CommandContext);
  if (!ctx) throw new Error('useCommands outside CommandProvider');
  return ctx;
}

/** Registers commands for as long as the calling component is mounted. */
export function useRegisterCommands(list: Command[]): void {
  const { register, unregister } = useCommands();
  const owner = useRef(Symbol('commands'));
  const key = list.map((c) => `${c.id}|${c.label}|${c.href ?? ''}|${c.shortcut ?? ''}`).join('\n');
  const latest = useRef(list);
  useEffect(() => {
    latest.current = list;
  });
  useEffect(() => {
    const o = owner.current;
    // Wrap `run` so registrations always call the latest closure.
    register(
      o,
      latest.current.map((c) => ({
        ...c,
        ...(c.run ? { run: () => latest.current.find((x) => x.id === c.id)?.run?.() } : {}),
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    const o = owner.current;
    return () => unregister(o);
  }, [unregister]);
}
