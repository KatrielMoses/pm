/**
 * Keyboard shortcut model (RS-12, A11Y-KB-06/07). Pure functions so the key map, matching, and the
 * conflict rules are unit-tested; the React provider (commands.tsx) owns the single listener.
 *
 * Notation: chords joined by `+` (`Mod+Shift+B`), sequences separated by a space (`G H`). `Mod`
 * is Command on Apple platforms and Control elsewhere.
 */

export type ShortcutLayer = 'global' | 'view' | 'record' | 'editor';

export interface ShortcutBinding {
  id: string;
  keys: string;
  layer: ShortcutLayer;
}

export interface Chord {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/** Apple platforms label Mod as ⌘; the check uses platform hints, never width or user agent class. */
export function isApplePlatform(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = nav.userAgentData?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(p);
}

export function parseChord(text: string): Chord {
  const parts = text.split('+');
  const key = parts.pop()!;
  const set = new Set(parts.map((p) => p.toLowerCase()));
  return {
    mod: set.has('mod'),
    shift: set.has('shift'),
    alt: set.has('alt'),
    key: key.length === 1 ? key.toLowerCase() : key,
  };
}

export function parseKeys(keys: string): Chord[] {
  return keys.trim().split(/\s+/).map(parseChord);
}

/** A binding is "single-key" when no chord uses Mod or Alt (letters, punctuation, sequences). */
export function isSingleKey(keys: string): boolean {
  return parseKeys(keys).every((c) => !c.mod && !c.alt);
}

const KEY_NAMES: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Escape: 'Esc',
  Enter: 'Enter',
};

/** Visible label for menus, the palette, and the reference: `⌘K` / `Ctrl+K`, `G then H`. */
export function shortcutLabel(keys: string, apple = isApplePlatform()): string {
  return parseKeys(keys)
    .map((c) => {
      const k = KEY_NAMES[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key);
      const parts = [
        c.mod ? (apple ? '⌘' : 'Ctrl') : '',
        c.alt ? (apple ? '⌥' : 'Alt') : '',
        c.shift ? (apple ? '⇧' : 'Shift') : '',
        k,
      ].filter(Boolean);
      return parts.join(apple ? '' : '+');
    })
    .join(' then ');
}

/** Normalizes a keyboard event to a chord (Shift is implied by punctuation such as `?`). */
export function eventChord(e: KeyboardEvent, apple = isApplePlatform()): Chord {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const punctuation = e.key.length === 1 && !/[a-z0-9]/i.test(e.key);
  return {
    mod: apple ? e.metaKey : e.ctrlKey,
    shift: punctuation ? false : e.shiftKey,
    alt: e.altKey,
    key,
  };
}

export function chordEquals(a: Chord, b: Chord): boolean {
  return a.mod === b.mod && a.shift === b.shift && a.alt === b.alt && a.key === b.key;
}

/** Focus is in something the user types into: single keys never fire there (KB-07 rule 1). */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(
      type,
    );
  }
  return target.closest('[role="textbox"], [role="combobox"], [contenteditable="true"]') !== null;
}

/**
 * Browser, operating-system, and assistive-technology combinations the product never takes
 * (A11Y-KB-07 rules 2 and 3). Function keys are left to the browser entirely.
 */
const RESERVED_MOD_KEYS = ['l', 't', 'w', 'n', 'q', 'r', 'p', 'f', '+', '-', '=', '0', 'Tab'];
const RESERVED_MOD_SHIFT_KEYS = ['n', 't'];

export function reservedReason(c: Chord): string | null {
  if (/^F\d{1,2}$/.test(c.key)) return 'function keys belong to the browser';
  if (c.key === 'Insert' || c.key === 'CapsLock') return 'screen reader modifier';
  if (c.mod && c.alt) return 'Ctrl+Option belongs to VoiceOver';
  if (c.alt && (c.key === 'ArrowLeft' || c.key === 'ArrowRight' || c.key === 'F4'))
    return 'browser history or window control';
  if (c.mod && !c.shift && !c.alt && RESERVED_MOD_KEYS.includes(c.key))
    return 'browser or operating-system shortcut';
  if (c.mod && c.shift && RESERVED_MOD_SHIFT_KEYS.includes(c.key))
    return 'browser or operating-system shortcut';
  if (!c.mod && !c.alt && c.key === 'Tab') return 'focus navigation';
  return null;
}

export interface ShortcutConflict {
  ids: string[];
  keys: string;
  reason: string;
}

/**
 * Conflict rules: no reserved combination; no two bindings with the same keys (in any layers, so a
 * key never means two things); and no single key that is also the first key of a sequence.
 */
export function validateShortcuts(bindings: readonly ShortcutBinding[]): ShortcutConflict[] {
  const out: ShortcutConflict[] = [];
  const canonical = (keys: string) =>
    parseKeys(keys)
      .map((c) => `${c.mod ? 'M' : ''}${c.shift ? 'S' : ''}${c.alt ? 'A' : ''}:${c.key}`)
      .join(' ');
  const seen = new Map<string, ShortcutBinding>();
  for (const b of bindings) {
    for (const c of parseKeys(b.keys)) {
      const reason = reservedReason(c);
      if (reason) out.push({ ids: [b.id], keys: b.keys, reason });
    }
    const k = canonical(b.keys);
    const prior = seen.get(k);
    if (prior) out.push({ ids: [prior.id, b.id], keys: b.keys, reason: 'same keys bound twice' });
    else seen.set(k, b);
  }
  const singles = bindings.filter((b) => parseKeys(b.keys).length === 1);
  for (const s of bindings.filter((b) => parseKeys(b.keys).length > 1)) {
    const first = canonical(s.keys).split(' ')[0];
    for (const x of singles)
      if (canonical(x.keys) === first)
        out.push({ ids: [x.id, s.id], keys: x.keys, reason: 'single key is a sequence prefix' });
  }
  return out;
}
