import { richTextFromPlain, validateRichText, type RichTextDoc } from '@pm/contracts/rich-text';
import { Issues } from '@pm/tenancy';
import { isObject, isPublic } from '../validation.ts';
import {
  REACTIONS,
  REVIEW_KINDS,
  REVIEW_OUTCOMES,
  REVIEW_RULES,
  mentionKey,
  type Reaction,
  type ReviewKind,
  type ReviewOutcome,
  type ReviewRule,
} from './semantics.ts';

/**
 * Phase 4A inputs (ADR-0023). Every parser refuses unknown fields, reports pointer-precise safe
 * issues, and never echoes input. Nothing here consults the database or authorization.
 */

const unknownFields = (b: Record<string, unknown>, allowed: readonly string[], issues: Issues) => {
  for (const k of Object.keys(b))
    if (!allowed.includes(k))
      issues.add(`/${k}`, 'unsupported_field', 'This field is not supported.');
};

export type MentionKind = 'member' | 'team' | 'record';
export interface MentionInput {
  kind: MentionKind;
  id: string;
}

export interface CommentInput {
  doc: RichTextDoc;
  text: string;
  mentions: MentionInput[];
}

/** The comment body: a rich-text version 1 document, or plain `text` (one paragraph per line). */
function parseBody(b: Record<string, unknown>, max: number, issues: Issues) {
  if (b.body !== undefined && b.text !== undefined) {
    issues.add('/text', 'conflicting', 'Send the comment as either body or text.');
    return null;
  }
  const raw =
    b.body !== undefined
      ? b.body
      : typeof b.text === 'string'
        ? (richTextFromPlain(b.text) ?? undefined)
        : b.text;
  if (raw === undefined || raw === null) {
    issues.add(b.body !== undefined ? '/body' : '/text', 'required', 'Write a comment.');
    return null;
  }
  const r = validateRichText(raw, max);
  if (!r.ok) {
    issues.add(`${b.body !== undefined ? '/body' : '/text'}${r.path}`, r.code, r.message);
    return null;
  }
  return { doc: r.doc, text: r.text };
}

function parseMentions(v: unknown, max: number, issues: Issues): MentionInput[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    issues.add('/mentions', 'invalid_type', 'Mentions are a list.');
    return [];
  }
  if (v.length > max) {
    issues.add('/mentions', 'too_many', `Mention at most ${max} people, teams, or records.`);
    return [];
  }
  const out: MentionInput[] = [];
  const seen = new Set<string>();
  for (const [i, m] of v.entries()) {
    const at = `/mentions/${i}`;
    if (!isObject(m)) {
      issues.add(at, 'invalid_type', 'Choose who or what to mention.');
      continue;
    }
    unknownFields(m, ['kind', 'id'], issues);
    const kind = m.kind;
    const id = m.id;
    const ok =
      (kind === 'member' && isPublic(id, 'mem')) ||
      (kind === 'team' && isPublic(id, 'team')) ||
      (kind === 'record' && (isPublic(id, 'tsk') || isPublic(id, 'prj') || isPublic(id, 'doc')));
    if (!ok) {
      issues.add(at, 'invalid_reference', 'Choose who or what to mention.');
      continue;
    }
    const entry = { kind: kind as MentionKind, id: id as string };
    if (seen.has(mentionKey(entry))) continue;
    seen.add(mentionKey(entry));
    out.push(entry);
  }
  return out;
}

export function parseCommentCreate(
  body: unknown,
  bounds: { bodyMax: number; mentionsMax: number },
): CommentInput & { replyTo: string | null } {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send a comment.');
  unknownFields(b, ['body', 'text', 'mentions', 'reply_to'], issues);
  const parsed = parseBody(b, bounds.bodyMax, issues);
  const mentions = parseMentions(b.mentions, bounds.mentionsMax, issues);
  let replyTo: string | null = null;
  if (b.reply_to !== undefined && b.reply_to !== null) {
    if (isPublic(b.reply_to, 'cmt')) replyTo = b.reply_to;
    else issues.add('/reply_to', 'invalid_reference', 'Choose the comment to reply to.');
  }
  issues.throwIfAny();
  return { ...parsed!, mentions, replyTo };
}

export function parseCommentEdit(
  body: unknown,
  bounds: { bodyMax: number; mentionsMax: number },
): CommentInput & { version: number | undefined } {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send the edited comment.');
  unknownFields(b, ['body', 'text', 'mentions', 'version'], issues);
  const parsed = parseBody(b, bounds.bodyMax, issues);
  const mentions = parseMentions(b.mentions, bounds.mentionsMax, issues);
  let version: number | undefined;
  if (b.version !== undefined) {
    if (typeof b.version === 'number' && Number.isInteger(b.version) && b.version >= 0)
      version = b.version;
    else issues.add('/version', 'invalid_number', 'Send the version you loaded.');
  }
  issues.throwIfAny();
  return { ...parsed!, mentions, version };
}

export function parseReaction(key: unknown): Reaction | null {
  return typeof key === 'string' && (REACTIONS as readonly string[]).includes(key)
    ? (key as Reaction)
    : null;
}

export interface ReviewRequestInput {
  reviewers: string[];
  rule: ReviewRule;
  kind: ReviewKind;
  message: string | null;
  /** The subject version the requester looked at (checked against the current version). */
  subjectVersion: number | undefined;
}

export function parseReviewRequest(body: unknown, reviewersMax: number): ReviewRequestInput {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send a review request.');
  unknownFields(b, ['reviewers', 'rule', 'kind', 'message', 'subject_version'], issues);
  let reviewers: string[] = [];
  if (!Array.isArray(b.reviewers) || !b.reviewers.length)
    issues.add('/reviewers', 'required', 'Choose at least one reviewer.');
  else if (b.reviewers.length > reviewersMax)
    issues.add('/reviewers', 'too_many', `Choose at most ${reviewersMax} reviewers.`);
  else {
    reviewers = [...new Set(b.reviewers.map(String))];
    for (const [i, r] of b.reviewers.entries())
      if (!isPublic(r, 'mem'))
        issues.add(`/reviewers/${i}`, 'invalid_reference', 'Choose a member to review.');
  }
  const rule = b.rule === undefined ? 'any' : b.rule;
  if (!(REVIEW_RULES as readonly unknown[]).includes(rule))
    issues.add('/rule', 'invalid_option', 'Choose any reviewer or all reviewers.');
  const kind = b.kind === undefined ? 'review' : b.kind;
  if (!(REVIEW_KINDS as readonly unknown[]).includes(kind))
    issues.add('/kind', 'invalid_option', 'Choose a review or an approval.');
  const message = note(b.message, '/message', issues);
  let subjectVersion: number | undefined;
  if (b.subject_version !== undefined) {
    if (
      typeof b.subject_version === 'number' &&
      Number.isInteger(b.subject_version) &&
      b.subject_version >= 0
    )
      subjectVersion = b.subject_version;
    else issues.add('/subject_version', 'invalid_number', 'Send the version you reviewed.');
  }
  issues.throwIfAny();
  return {
    reviewers,
    rule: rule as ReviewRule,
    kind: kind as ReviewKind,
    message,
    subjectVersion,
  };
}

/** A short note: trimmed, 1–2000 characters, no control characters; null clears it. */
function note(v: unknown, pointer: string, issues: Issues, max = 2000): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') {
    issues.add(pointer, 'invalid_type', 'Write the note as text.');
    return null;
  }
  const t = v.trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t)) {
    issues.add(pointer, 'invalid_characters', "This text contains characters we can't save.");
    return null;
  }
  if (!t) return null;
  if ([...t].length > max) {
    issues.add(pointer, 'too_long', `This note can be at most ${max} characters.`);
    return null;
  }
  return t;
}

export interface DecisionInput {
  outcome: ReviewOutcome;
  note: string | null;
  subjectVersion: number;
}

export function parseDecision(body: unknown): DecisionInput {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Send a decision.');
  unknownFields(b, ['outcome', 'note', 'subject_version'], issues);
  if (!(REVIEW_OUTCOMES as readonly unknown[]).includes(b.outcome))
    issues.add('/outcome', 'invalid_option', 'Approve, request changes, or reject.');
  const n = note(b.note, '/note', issues);
  let subjectVersion = 0;
  if (
    typeof b.subject_version === 'number' &&
    Number.isInteger(b.subject_version) &&
    b.subject_version >= 0
  )
    subjectVersion = b.subject_version;
  else issues.add('/subject_version', 'required', 'Send the version you reviewed.');
  issues.throwIfAny();
  return { outcome: b.outcome as ReviewOutcome, note: n, subjectVersion };
}

export function parseWithdraw(body: unknown): { reason: string | null } {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  unknownFields(b, ['note'], issues);
  const n = note(b.note, '/note', issues, 500);
  issues.throwIfAny();
  return { reason: n };
}

export function parseRefresh(body: unknown, reviewersMax: number): ReviewRequestInput | null {
  if (body === undefined || body === null || (isObject(body) && !Object.keys(body).length))
    return null;
  return parseReviewRequest(body, reviewersMax);
}

export interface DelegateInput {
  to: string;
  note: string | null;
}

export function parseDelegate(body: unknown): DelegateInput {
  const issues = new Issues();
  const b = isObject(body) ? body : {};
  if (!isObject(body)) issues.add('/', 'invalid_type', 'Choose who takes this over.');
  unknownFields(b, ['to', 'note'], issues);
  if (!isPublic(b.to, 'mem'))
    issues.add('/to', 'invalid_reference', 'Choose an active member to take this over.');
  const n = note(b.note, '/note', issues, 500);
  issues.throwIfAny();
  return { to: b.to as string, note: n };
}

/** `GET` list options shared by the collaboration reads (limit and an opaque cursor). */
export function parseCursorQuery(
  q: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> {
  const issues = new Issues();
  unknownFields(q, ['limit', 'cursor', ...allowed], issues);
  issues.throwIfAny();
  return q;
}
