import { parseCapture, type ParseToken } from './parser.ts';
import type { InterpretationField } from '../ai/actions/interpretation.ts';

/**
 * Phase 7F (ADR-0043 D2): derives a value from one interpreted span with deterministic rules. The
 * model only says which words name which field; this module decides what they mean, in the
 * person's local `today`, with the same rules as the capture parser plus a few plain-language
 * forms ("an hour", "high priority"). Ambiguous dates keep their options; anything the rules do
 * not understand stays unknown (never guessed, never zero). Names are resolved elsewhere, through
 * current authorized lookups.
 */
export type DerivedSpan =
  | { status: 'resolved'; value: unknown; rule: string }
  | { status: 'ambiguous'; options: Array<{ value: unknown; label: string }>; rule: string }
  | { status: 'unknown'; rule: string };

const NAME_FIELDS: readonly InterpretationField[] = ['label', 'project', 'brand', 'owner'];
export const isNameField = (f: InterpretationField) => NAME_FIELDS.includes(f);

const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  half: 0.5,
};

/** Plain-language durations: "an hour", "half an hour", "45 minutes", "2 hours", "a day". */
function plainDuration(span: string): number | null {
  const s = span.toLowerCase().replace(/^(about|around|roughly|~)\s+/, '');
  if (/^half an? hour$/.test(s)) return 30;
  const m = /^(\d{1,3}(?:\.\d{1,2})?|an?|one|two|three|four|five|six)\s+(minutes?|mins?|hours?|hrs?|days?)$/.exec(
    s,
  );
  if (!m) return null;
  const n = /^\d/.test(m[1]!) ? Number(m[1]) : WORD_NUMBERS[m[1]!]!;
  const unit = m[2]!.charAt(0);
  const minutes = Math.round(unit === 'm' ? n : unit === 'h' ? n * 60 : n * 480);
  return minutes > 0 ? minutes : null;
}

/** Plain-language priority words. */
function plainPriority(span: string): string | null {
  const s = span.toLowerCase();
  if (/\b(urgent|asap|critical)\b/.test(s)) return 'urgent';
  if (/\bhigh\b/.test(s) || /\bimportant\b/.test(s)) return 'high';
  if (/\b(medium|normal)\b/.test(s)) return 'medium';
  if (/\blow\b/.test(s)) return 'low';
  return null;
}

const firstOf = (tokens: ParseToken[], fields: string[]) =>
  tokens.find((t) => fields.includes(t.field));

/** The value an interpreted span names, or why it has none. */
export function deriveSpan(
  field: InterpretationField,
  span: string,
  today: string,
  tokensMax: number,
): DerivedSpan {
  // Spans are parsed alone: their words cannot borrow meaning from the rest of the note.
  const parsed = parseCapture(span, { today, tokensMax });
  switch (field) {
    case 'due_date':
    case 'deadline': {
      const t = firstOf(parsed.tokens, ['due_date', 'deadline']);
      if (!t) return { status: 'unknown', rule: 'ai:date_not_understood' };
      return t.options
        ? { status: 'ambiguous', options: t.options, rule: `ai:${t.rule}` }
        : { status: 'resolved', value: t.value, rule: `ai:${t.rule}` };
    }
    case 'priority': {
      const t = firstOf(parsed.tokens, ['priority']);
      const v = (t?.value as string | undefined) ?? plainPriority(span);
      return v
        ? { status: 'resolved', value: v, rule: t ? `ai:${t.rule}` : 'ai:priority word' }
        : { status: 'unknown', rule: 'ai:priority_not_understood' };
    }
    case 'estimate_minutes': {
      const t = firstOf(parsed.tokens, ['estimate_minutes']);
      const v = (t?.value as number | undefined) ?? plainDuration(span);
      return v
        ? { status: 'resolved', value: v, rule: t ? `ai:${t.rule}` : 'ai:plain duration' }
        : { status: 'unknown', rule: 'ai:duration_not_understood' };
    }
    case 'recurrence': {
      const t = firstOf(parsed.tokens, ['recurrence']);
      return t
        ? { status: 'resolved', value: t.value, rule: `ai:${t.rule}` }
        : { status: 'unknown', rule: 'ai:recurrence_not_understood' };
    }
    case 'title':
      return { status: 'resolved', value: span.replace(/\s+/g, ' ').trim(), rule: 'ai:title' };
    default:
      // Names are resolved by the caller among what the person can read.
      return { status: 'unknown', rule: 'ai:name' };
  }
}

/** The bare name in a name span (without `#`, `+`, `@`, or `brand:` and surrounding quotes). */
export function nameOf(span: string): string {
  return span
    .trim()
    .replace(/^(brand:|[#+@])/i, '')
    .replace(/^"(.*)"$/, '$1')
    .trim();
}
