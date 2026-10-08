import { describe, expect, it } from 'vitest';
import {
  asText,
  canSubmit,
  cleanExternalUrl,
  cleanFileName,
  inlineType,
  lineDiff,
  linkName,
  permanentKey,
  previewKind,
  quarantineKey,
  stateAfterReview,
  uploadTypeProblem,
} from '../../src/files/semantics.ts';

/** ADR-0025 F3, F5, F6, F8: type allow-list, inline rules, names and links, keys, diffs, states. */
describe('file semantics (4E)', () => {
  it('accepts allow-listed types only when the extension agrees', () => {
    expect(uploadTypeProblem('photo.png', 'image/png')).toBeNull();
    expect(uploadTypeProblem('Photo.JPEG', 'image/jpeg')).toBeNull();
    expect(uploadTypeProblem('notes.ts', 'text/plain; charset=utf-8')).toBeNull();
    expect(uploadTypeProblem('run.exe', 'application/x-msdownload')).toBe('unsupported_type');
    expect(uploadTypeProblem('invoice.pdf.exe', 'application/pdf')).toBe('type_mismatch');
    expect(uploadTypeProblem('noext', 'text/plain')).toBe('type_mismatch');
  });

  it('previews inline only what renders without running content', () => {
    expect(inlineType('image/png')).toBe('image/png');
    expect(inlineType('application/pdf')).toBe('application/pdf');
    expect(inlineType('text/markdown')).toBe('text/plain; charset=utf-8');
    expect(inlineType('application/json')).toBe('text/plain; charset=utf-8');
    for (const t of ['image/svg+xml', 'text/html', 'application/zip', 'video/quicktime', null])
      expect(inlineType(t)).toBeNull();
    expect(previewKind('video/mp4')).toBe('video');
    expect(previewKind('image/svg+xml')).toBe('none');
  });

  it('cleans names and refuses path tricks', () => {
    expect(cleanFileName('  report.pdf ')).toBe('report.pdf');
    expect(cleanFileName('../../etc/passwd')).toBe('....etcpasswd');
    expect(cleanFileName('a\u0000b\nc.txt')).toBe('abc.txt');
    expect(cleanFileName('..')).toBeNull();
    expect(cleanFileName('x'.repeat(256))).toBeNull();
    expect(cleanFileName(42)).toBeNull();
  });

  it('accepts http(s) links without credentials only, and names them', () => {
    expect(cleanExternalUrl('https://example.com/a b')).toBe('https://example.com/a%20b');
    for (const bad of [
      'javascript:alert(1)',
      'ftp://x/y',
      'https://u:p@example.com/',
      'data:text/html,x',
      'not a url',
    ])
      expect(cleanExternalUrl(bad)).toBeNull();
    expect(linkName('https://example.com/specs/final%20v2.pdf')).toBe('final v2.pdf');
    expect(linkName('https://example.com/')).toBe('example.com');
  });

  it('keeps identifiers out of object keys', () => {
    const q = quarantineKey('ab'.repeat(32));
    expect(q).toMatch(/^q\.[0-9a-f]{64}$/);
    expect(permanentKey(q)).toBe(`o.${'ab'.repeat(32)}`);
  });

  it('diffs bounded text line by line and refuses oversized input', () => {
    expect(lineDiff('a\nb', 'a\nc')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'remove', text: 'b' },
      { op: 'add', text: 'c' },
    ]);
    expect(lineDiff('x\n'.repeat(10), 'y', 5)).toBeNull();
    expect(asText(new Uint8Array([104, 105]))).toBe('hi');
    expect(asText(new Uint8Array([0, 1]))).toBeNull();
    expect(asText(new Uint8Array([0xff, 0xfe]))).toBeNull();
  });

  it('maps 4A outcomes to deliverable states; accepted is final', () => {
    expect(stateAfterReview('approved')).toBe('accepted');
    expect(stateAfterReview('changes_requested')).toBe('changes_requested');
    expect(stateAfterReview('rejected')).toBe('rejected');
    expect(stateAfterReview('withdrawn')).toBe('draft');
    expect(canSubmit('accepted')).toBe(false);
    expect(canSubmit('rejected')).toBe(true);
  });
});
