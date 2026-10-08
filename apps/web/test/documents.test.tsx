import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { collaboration } from '../src/collab/client.ts';
import { FollowingTab } from '../src/collab/my-work.tsx';
import { recordPath } from '../src/notify/bell.tsx';
import { ROUTE_COMPONENTS } from '../src/app-routes.tsx';
import {
  documents,
  type Block,
  type Doc,
  type DocSummary,
  type DocVersion,
  type Suggestion,
} from '../src/docs/client.ts';
import { applyReview, buildReview } from '../src/docs/merge.ts';
import { MentionedInDocuments, SuggestionsPanel, VersionHistory } from '../src/docs/panels.tsx';
import { DocView } from '../src/docs/render.tsx';
import { DocumentsSection } from '../src/docs/sections.tsx';
import { DocumentEditor, draftKeyFor } from '../src/docs/session.tsx';
import { DetailsCard, DocumentPage, Subpages } from '../src/pages/document-pages.tsx';
import { KnowledgePage } from '../src/pages/knowledge-pages.tsx';
import { Router } from '../src/router.tsx';
import { matchRoute, routeHref } from '../src/shell/registry.ts';
import { StepUpProvider } from '../src/stepup.tsx';
import { collab as people } from '../src/tenancy/client.ts';

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

const WS = 'ws_A';
const wrap = (ui: React.ReactNode) =>
  render(
    <Router>
      <StepUpProvider>{ui}</StepUpProvider>
    </Router>,
  );
const err = (
  code: string,
  status: number,
  extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {},
) => new ApiError({ code, status, message: code, ...extra });
const page = <T,>(data: T[], more?: string) => ({
  data,
  page: { limit: 25, has_more: !!more, ...(more ? { next_cursor: more } : {}) },
});

const para = (id: string | undefined, text: string): Block => ({
  ...(id ? { id } : {}),
  type: 'paragraph',
  runs: [{ text }],
});
const ALL = {
  edit: true,
  comment: true,
  suggest: true,
  follow: true,
  assign_owner: true,
  create_page: true,
  move: true,
  archive: true,
  trash: true,
  share: false,
  export: true,
  request_review: true,
  approve_source: true,
};
const NONE = Object.fromEntries(Object.keys(ALL).map((k) => [k, false])) as typeof ALL;

const doc = (over: Partial<Doc> = {}): Doc => ({
  id: 'doc_1',
  type: 'document',
  title: 'Launch plan',
  doc_type: 'page',
  doc_type_label: 'Page',
  state: 'current',
  effective_state: 'current',
  review_due_on: null,
  review_overdue: false,
  owner: { id: 'mem_1', name: 'Ada Owner', type: 'member' },
  created_by: { id: 'mem_1', name: 'Ada Owner' },
  updated_by: { id: 'mem_1', name: 'Ada Owner' },
  brand: { kind: 'workspace' },
  scope: 'workspace',
  attachment: { kind: 'workspace', id: null, title: null },
  parent: null,
  ancestors: [],
  depth: 0,
  children_count: 0,
  lifecycle_state: 'active',
  archived: false,
  version: 3,
  content_version: 5,
  content_hash: 'h',
  size_bytes: 10,
  content: { v: 2, blocks: [para('blk_one', 'First'), para('blk_two', 'Second')] },
  references: {},
  links: [],
  links_restricted: 0,
  ai_source: { approved: false, version: null, at: null, by: null },
  created_at: '2026-10-01T10:00:00.000Z',
  updated_at: '2026-10-02T10:00:00.000Z',
  capabilities: { ...ALL },
  ...over,
});
const summary = (id: string, title: string, over: Partial<DocSummary> = {}): DocSummary => ({
  id,
  type: 'document',
  title,
  doc_type: 'page',
  doc_type_label: 'Page',
  state: 'current',
  effective_state: 'current',
  review_due_on: null,
  review_overdue: false,
  owner: { id: 'mem_1', name: 'Ada Owner', type: 'member' },
  brand: { kind: 'workspace' },
  scope: 'workspace',
  attachment: { kind: 'workspace', id: null, title: null },
  parent_id: null,
  depth: 0,
  has_children: false,
  content_version: 1,
  archived: false,
  updated_at: '2026-10-02T10:00:00.000Z',
  ...over,
});

const editor = (d: Doc = doc(), onSaved = vi.fn(), onDirty = vi.fn()) =>
  wrap(<DocumentEditor ws={WS} doc={d} onSaved={onSaved} onDirty={onDirty} />);
const texts = () =>
  screen.getAllByLabelText('Paragraph text').map((t) => (t as HTMLTextAreaElement).value);
const status = () => document.getElementById('doc-save-state')?.textContent ?? '';

// -----------------------------------------------------------------------------------------------

describe('routes', () => {
  it('the document page and Knowledge are canonical routes', () => {
    expect(matchRoute('/workspaces/ws_A/documents/doc_B')).toMatchObject({
      def: { id: 'document' },
      params: { ws: 'ws_A', doc: 'doc_B' },
    });
    expect(routeHref('document', { ws: 'ws_A', doc: 'doc_B' })).toBe(
      '/workspaces/ws_A/documents/doc_B',
    );
    expect(matchRoute('/workspaces/ws_A/knowledge')?.def.id).toBe('knowledge');
  });
});

describe('read-only rendering', () => {
  const refs = {
    'task:tsk_1': {
      kind: 'task' as const,
      id: 'tsk_1',
      label: 'Ship it',
      path: '/workspaces/ws_A/tasks/tsk_1',
    },
  };
  const blocks: Block[] = [
    { id: 'b1', type: 'heading', level: 1, runs: [{ text: 'Title' }] },
    {
      id: 'b2',
      type: 'paragraph',
      runs: [
        { text: 'See ' },
        { ref: { kind: 'task', id: 'tsk_1' } },
        { text: ' and ' },
        { ref: { kind: 'restricted', id: 'rst_SECRETTOKEN' } },
        { text: ' and ' },
        { ref: { kind: 'task', id: 'tsk_HIDDEN' } },
        { text: ' ' },
        { text: 'site', link: 'https://example.com/x', bold: true },
      ],
    },
    { id: 'b3', type: 'bulleted_list', items: [[{ text: 'one' }], [{ text: 'two' }]] },
    { id: 'b4', type: 'numbered_list', items: [[{ text: 'first' }]] },
    {
      id: 'b5',
      type: 'checklist',
      items: [
        { runs: [{ text: 'done thing' }], checked: true },
        { runs: [{ text: 'open thing' }], checked: false },
      ],
    },
    { id: 'b6', type: 'quote', runs: [{ text: 'wise words' }] },
    { id: 'b7', type: 'callout', tone: 'warning', runs: [{ text: 'careful' }] },
    { id: 'b8', type: 'code', language: 'ts', text: 'const a = 1;' },
    {
      id: 'b9',
      type: 'table',
      header: true,
      rows: [
        ['Name', 'Role'],
        ['Ada', 'Owner'],
      ],
    },
    { id: 'b10', type: 'divider' },
    {
      id: 'b11',
      type: 'embed',
      kind: 'image',
      url: 'https://img.example/a.png',
      title: 'Diagram',
      alt: 'A flow',
    },
  ];

  it('renders every block semantically, with text labels and safe links', () => {
    const { container } = wrap(<DocView content={{ v: 2, blocks }} refs={refs} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Title' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ship it' }).getAttribute('href')).toBe(
      '/workspaces/ws_A/tasks/tsk_1',
    );
    const ext = screen.getByRole('link', { name: /site/ });
    expect(ext.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(ext.getAttribute('target')).toBe('_blank');
    expect(screen.getAllByRole('list').length).toBeGreaterThanOrEqual(3);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(boxes[0]!.getAttribute('aria-readonly')).toBe('true');
    expect(screen.getByText('Warning')).toBeTruthy(); // the callout says what it is in words
    expect(screen.getByText('Code (ts)')).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Role']);
    expect(container.querySelector('hr')).toBeTruthy();
    // An embed is a link card: nothing is fetched or shown from the address.
    expect(container.querySelector('img, iframe, video, object, embed')).toBeNull();
    expect(screen.getByText(/Nothing is loaded from that address/)).toBeTruthy();
    expect(screen.getByText('Description: A flow')).toBeTruthy();
  });

  it('shows restricted and unresolved references as a neutral token with no identifier in the page', () => {
    const { container } = wrap(<DocView content={{ v: 2, blocks }} refs={refs} />);
    expect(screen.getAllByText('Restricted item')).toHaveLength(2);
    const html = container.innerHTML;
    expect(html).not.toContain('rst_SECRETTOKEN');
    expect(html).not.toContain('tsk_HIDDEN');
    expect(html).not.toContain('rst_');
  });

  it('shows only the first blocks of a very long document until asked', () => {
    const many = Array.from({ length: 400 }, (_x, i) => para(`b${i}`, `Line ${i}`));
    const { container } = wrap(<DocView content={{ v: 2, blocks: many }} refs={{}} />);
    expect(container.querySelectorAll('.doc-view-block')).toHaveLength(150);
    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
    expect(container.querySelectorAll('.doc-view-block')).toHaveLength(300);
  });

  it('offers Suggest a change under each block when asked, naming the block', () => {
    const onSuggest = vi.fn();
    wrap(<DocView content={{ v: 2, blocks }} refs={refs} suggest={onSuggest} />);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest a change to block 1' }));
    expect(onSuggest).toHaveBeenCalledWith(blocks[0], 0);
  });
});

// -----------------------------------------------------------------------------------------------

describe('block editor: operations and focus', () => {
  it('adds a block from the menu by keyboard and focuses it; Escape closes the menu', () => {
    editor();
    const add = screen.getByRole('button', { name: 'Add block' });
    fireEvent.click(add);
    const menu = screen.getByRole('menu', { name: 'Add block' });
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(11);
    expect(document.activeElement).toBe(within(menu).getAllByRole('menuitem')[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(add);
    fireEvent.click(add);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Heading' }));
    expect(screen.getByText('Block 3 of 3: Heading')).toBeTruthy();
    expect((document.activeElement as HTMLElement).getAttribute('aria-label') ?? '').toBe('');
    expect(document.activeElement?.id).toMatch(/-text$/);
    expect(screen.getByText('Added Heading as block 3 of 3.')).toBeTruthy();
  });

  it('moves a block up and down, keeps focus on the control used, and announces it', () => {
    editor();
    const down = () => screen.getAllByRole('button', { name: /^Move down block 1/ })[0]!;
    down().focus();
    fireEvent.click(down());
    expect(texts()).toEqual(['Second', 'First']);
    // Block 1 is now "Second"; the moved block is block 2 and the Move down button is disabled there.
    expect(document.activeElement?.textContent).toMatch(/Move up block 2/);
    expect(screen.getByText(/Moved Paragraph to position 2 of 2\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Move up block 2/ }));
    expect(texts()).toEqual(['First', 'Second']);
  });

  it('deletes with an undo message rather than a confirm dialog, and undo puts it back', () => {
    editor();
    fireEvent.click(screen.getAllByRole('button', { name: /^Delete block 1/ })[0]!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(texts()).toEqual(['Second']);
    expect(screen.getByText(/Deleted block 1 \(Paragraph\)\./)).toBeTruthy();
    // Focus moved to a block, not lost.
    expect(document.activeElement && document.activeElement !== document.body).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Undo delete' }));
    expect(texts()).toEqual(['First', 'Second']);
  });

  it('turns a paragraph into a heading and back, keeping its text', () => {
    editor();
    fireEvent.click(screen.getAllByRole('button', { name: /^Make heading block 1/ })[0]!);
    expect((screen.getByLabelText('Heading text') as HTMLTextAreaElement).value).toBe('First');
    fireEvent.change(screen.getByLabelText('Heading level'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /^Make paragraph block 1/ }));
    expect(texts()).toEqual(['First', 'Second']);
  });

  it('edits a checklist, a table, code and a link card with native controls', () => {
    editor(doc({ content: { v: 2, blocks: [] } }));
    const add = (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: 'Add block' }));
      fireEvent.click(screen.getByRole('menuitem', { name }));
    };
    add('Checklist');
    fireEvent.change(screen.getByLabelText('Item 1 text'), { target: { value: 'one' } });
    fireEvent.keyDown(screen.getByLabelText('Item 1 text'), { key: 'Enter' });
    expect(screen.getByLabelText('Item 2 text')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Item 2 text'));
    fireEvent.click(screen.getByLabelText('Item 1 done'));
    add('Table');
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    expect(screen.getAllByLabelText(/^Row \d, column \d$/).length).toBe(6); // header row is "Header, column n"
    expect(screen.getAllByLabelText(/^Header, column \d$/)).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Remove column 3' }));
    expect(screen.getAllByLabelText(/^Header, column \d$/)).toHaveLength(2);
    add('Code');
    fireEvent.change(screen.getByLabelText('Language (optional)'), { target: { value: 'ts' } });
    add('Link card (image, video, or link)');
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'image' } });
    // Images ask for a description and say plainly what an embed is.
    expect(screen.getByLabelText('Describe the image')).toBeTruthy();
    expect(screen.getByText(/Files can't be embedded yet/)).toBeTruthy();
  });

  it('shows the inline syntax help as visible text, not a tooltip', () => {
    editor();
    expect(screen.getByText(/Formatting: \*\*bold\*\*, \*italic\*/)).toBeTruthy();
  });
});

describe('@ mentions in a block', () => {
  it('searches, moves with the arrow keys, and writes the reference token on Enter', async () => {
    vi.spyOn(documents, 'candidates').mockResolvedValue([
      { kind: 'member', id: 'mem_9', name: 'Bea Writer' },
      { kind: 'record', id: 'tsk_7', name: 'Fix [the] bug' },
    ]);
    const save = vi.spyOn(documents, 'saveContent').mockResolvedValue(doc({ content_version: 6 }));
    editor();
    const box = screen.getAllByLabelText('Paragraph text')[0] as HTMLTextAreaElement;
    box.focus();
    fireEvent.change(box, { target: { value: 'Hi @Be', selectionStart: 6 } });
    box.setSelectionRange(6, 6);
    fireEvent.select(box);
    const list = await screen.findByRole('listbox', { name: 'Suggested mentions' });
    expect(within(list).getAllByRole('option')).toHaveLength(2);
    expect(box.getAttribute('aria-controls')).toBe(list.id);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe(
      within(list).getAllByRole('option')[1]!.id,
    );
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('Hi [@Bea Writer](ref:member:mem_9) ');
    expect(screen.queryByRole('listbox')).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    const sent = save.mock.calls[0]![2].content.blocks[0]!;
    expect(sent).toEqual({
      id: 'blk_one',
      type: 'paragraph',
      runs: [{ text: 'Hi ' }, { ref: { kind: 'member', id: 'mem_9' } }, { text: ' ' }],
    });
  });

  it('Escape closes the list without choosing', async () => {
    vi.spyOn(documents, 'candidates').mockResolvedValue([
      { kind: 'record', id: 'tsk_7', name: 'Fix it' },
    ]);
    editor();
    const box = screen.getAllByLabelText('Paragraph text')[0] as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '@Fi' } });
    box.setSelectionRange(3, 3);
    fireEvent.select(box);
    await screen.findByRole('listbox');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box.value).toBe('@Fi');
  });
});

// -----------------------------------------------------------------------------------------------

describe('saving', () => {
  it('saves with the version that was loaded, existing ids and no ids for new blocks, then says Saved', async () => {
    const onSaved = vi.fn();
    const saved = doc({
      content_version: 6,
      content: {
        v: 2,
        blocks: [para('blk_one', 'First!'), para('blk_two', 'Second'), para('blk_new', 'Third')],
      },
    });
    const save = vi.spyOn(documents, 'saveContent').mockResolvedValue(saved);
    editor(doc(), onSaved);
    expect(status()).toContain('Saved');
    fireEvent.change(screen.getAllByLabelText('Paragraph text')[0]!, {
      target: { value: 'First!' },
    });
    expect(status()).toContain('Unsaved changes');
    fireEvent.click(screen.getByRole('button', { name: 'Add block' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Paragraph' }));
    fireEvent.change(screen.getAllByLabelText('Paragraph text')[2]!, {
      target: { value: 'Third' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(save).toHaveBeenCalledOnce();
    const [ws, id, body, , key] = save.mock.calls[0]!;
    expect([ws, id]).toEqual([WS, 'doc_1']);
    expect(body.base_version).toBe(5);
    expect(body.title).toBe('Launch plan');
    expect(body.content.blocks.map((b: Block) => b.id)).toEqual(['blk_one', 'blk_two', undefined]);
    expect(key).toMatch(/^web-/);
    expect(onSaved).toHaveBeenCalledWith(saved);
    await waitFor(() => expect(status()).toBe('✓ Saved'));
    expect(localStorage.length).toBe(0);
    // The next save is against the new version, and the new block has its identifier.
    save.mockResolvedValue(doc({ content_version: 7 }));
    fireEvent.change(screen.getAllByLabelText('Paragraph text')[1]!, { target: { value: 'Two' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(save.mock.calls[1]![2].base_version).toBe(6);
    expect(save.mock.calls[1]![2].content.blocks[2]!.id).toBe('blk_new');
  });

  it('saves with Ctrl+S and Cmd+S', async () => {
    const save = vi.spyOn(documents, 'saveContent').mockResolvedValue(doc({ content_version: 6 }));
    editor();
    const box = screen.getAllByLabelText('Paragraph text')[0]!;
    fireEvent.change(box, { target: { value: 'x' } });
    await act(async () => fireEvent.keyDown(box, { key: 's', ctrlKey: true }));
    fireEvent.change(box, { target: { value: 'xy' } });
    await act(async () => fireEvent.keyDown(box, { key: 's', metaKey: true }));
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('keeps the draft on this device, says so, and retries with the same key when offline', async () => {
    const save = vi
      .spyOn(documents, 'saveContent')
      .mockRejectedValueOnce(err('offline', 0))
      .mockResolvedValueOnce(doc({ content_version: 6 }));
    editor();
    fireEvent.change(screen.getAllByLabelText('Paragraph text')[0]!, {
      target: { value: 'Kept text' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(status()).toMatch(/Couldn't save: you're offline/);
    expect(status()).toMatch(/kept on this device/);
    expect(screen.getByRole('alert').textContent).toMatch(/kept on this device/);
    expect(texts()[0]).toBe('Kept text');
    expect(localStorage.length).toBe(1);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![4]).toBe(save.mock.calls[0]![4]); // replayed, never applied twice
    expect(status()).toBe('✓ Saved');
    expect(localStorage.length).toBe(0);
  });

  it('restores an unsaved draft after a reload with a clear banner, and Discard goes back', async () => {
    const first = editor();
    fireEvent.change(screen.getAllByLabelText('Paragraph text')[1]!, {
      target: { value: 'Half done' },
    });
    first.unmount(); // flushed when the page goes away
    expect(localStorage.getItem(`pm.draft.device.${draftKeyFor(WS, 'doc_1')}`)).toBeTruthy();
    editor();
    expect(screen.getByText('Restored your unsaved changes from this device')).toBeTruthy();
    expect(texts()).toEqual(['First', 'Half done']);
    expect(status()).toContain('Unsaved changes');
    fireEvent.click(screen.getByRole('button', { name: 'Discard restored changes' }));
    expect(texts()).toEqual(['First', 'Second']);
    expect(screen.queryByText(/Restored your unsaved changes/)).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('puts server issues next to the offending block and keeps the text', async () => {
    vi.spyOn(documents, 'saveContent').mockRejectedValue(
      err('validation_failed', 422, {
        issues: [
          { pointer: '/content/blocks/1/runs/0/link', code: 'invalid_url', message: 'Bad link.' },
          { pointer: '/content', code: 'too_many', message: 'Too many blocks.' },
        ],
      }),
    );
    editor();
    fireEvent.change(screen.getAllByLabelText('Paragraph text')[1]!, { target: { value: 'oops' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    const second = screen.getByText('Block 2 of 2: Paragraph').closest('[role="group"]')!;
    expect(within(second as HTMLElement).getByText(/isn't valid/)).toBeTruthy();
    const first = screen.getByText('Block 1 of 2: Paragraph').closest('[role="group"]')!;
    expect(within(first as HTMLElement).queryByText(/isn't valid/)).toBeNull();
    expect(screen.getByText('Too many blocks.')).toBeTruthy(); // at "/": shown with the title
    expect(texts()[1]).toBe('oops');
    expect(status()).toMatch(/Couldn't save: some parts need attention/);
  });

  it('says when it may try again after too many saves', async () => {
    vi.spyOn(documents, 'saveContent').mockRejectedValue(
      err('rate_limited', 429, { retryAfterSeconds: 7 }),
    );
    editor();
    fireEvent.change(screen.getAllByLabelText('Paragraph text')[0]!, { target: { value: 'x' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(status()).toMatch(/Try again in 7 seconds/);
  });

  it('turns read-only, with an explanation and a download, when the document was archived meanwhile', async () => {
    vi.spyOn(documents, 'saveContent').mockRejectedValue(
      err('conflict', 409, { issues: [{ code: 'document_archived', message: 'x' }] }),
    );
    editor();
    fireEvent.change(screen.getAllByLabelText('Paragraph text')[0]!, { target: { value: 'mine' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(screen.getByText('This document is archived, so it is read-only now')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Download my unsaved text' })).toBeTruthy();
    expect(screen.getByText('mine')).toBeTruthy();
    expect(localStorage.length).toBe(1); // the draft stays
  });

  it('turns read-only and keeps the text when permission was lost mid-session', async () => {
    vi.spyOn(documents, 'saveContent').mockRejectedValue(err('forbidden', 403));
    editor();
    fireEvent.change(screen.getAllByLabelText('Paragraph text')[0]!, { target: { value: 'mine' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(screen.getByText("You can't edit this any more")).toBeTruthy();
    expect(screen.getByText('mine')).toBeTruthy();
    expect(localStorage.length).toBe(1);
  });

  it('keeps the text when the document stopped being available (404)', async () => {
    vi.spyOn(documents, 'saveContent').mockRejectedValue(err('not_found', 404));
    editor();
    fireEvent.change(screen.getAllByLabelText('Paragraph text')[0]!, { target: { value: 'mine' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(screen.getByText("This document isn't available to you any more")).toBeTruthy();
    expect(screen.getByText('mine')).toBeTruthy();
  });
});

describe('a newer version exists (409)', () => {
  const latest = doc({
    content_version: 8,
    title: 'Launch plan v2',
    content: {
      v: 2,
      blocks: [
        para('blk_one', 'First (theirs)'),
        para('blk_two', 'Second'),
        para('blk_three', 'Added by them'),
      ],
    },
  });
  const conflict = () =>
    err('conflict', 409, {
      conflict: { current_version: 8 },
      issues: [{ code: 'version_changed', message: 'x' }],
    });

  it('keeps the local text and offers Load latest, Review my changes, and a download', async () => {
    vi.spyOn(documents, 'saveContent').mockRejectedValue(conflict());
    editor();
    fireEvent.change(screen.getAllByLabelText('Paragraph text')[0]!, {
      target: { value: 'My edit' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(screen.getByText('Someone saved a newer version')).toBeTruthy();
    expect(status()).toMatch(/someone saved a newer version/i);
    expect(texts()[0]).toBe('My edit');
    for (const name of ['Load latest', 'Review my changes', 'Download my version'])
      expect(screen.getByRole('button', { name })).toBeTruthy();
  });

  it('Load latest replaces the editor content, keeps a copy of mine, and saves against the new base', async () => {
    const save = vi.spyOn(documents, 'saveContent').mockRejectedValueOnce(conflict());
    vi.spyOn(documents, 'get').mockResolvedValue(latest);
    const createUrl = vi.fn((_b: Blob) => 'blob:x');
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() });
    const onSaved = vi.fn();
    editor(doc(), onSaved);
    fireEvent.change(screen.getAllByLabelText('Paragraph text')[0]!, {
      target: { value: 'My edit' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Load latest' })));
    expect(texts()).toEqual(['First (theirs)', 'Second', 'Added by them']);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Launch plan v2');
    expect(screen.getByText('Your version was kept')).toBeTruthy();
    expect(onSaved).toHaveBeenCalledWith(latest);
    expect(status()).toBe('✓ Saved');
    // The kept copy is a real download of what was typed.
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Download my version' }));
    expect(click).toHaveBeenCalled();
    const blob = createUrl.mock.calls.at(-1)![0] as unknown as Blob;
    expect(await blob.text()).toContain('My edit');
    // Editing again saves against version 8.
    save.mockResolvedValue(doc({ content_version: 9 }));
    fireEvent.change(screen.getAllByLabelText('Paragraph text')[1]!, { target: { value: 'Two' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(save.mock.calls[1]![2].base_version).toBe(8);
  });

  it('Review my changes shows both versions block by block; the person chooses; then saves on the new base', async () => {
    const save = vi.spyOn(documents, 'saveContent').mockRejectedValueOnce(conflict());
    vi.spyOn(documents, 'get').mockResolvedValue(
      doc({
        content_version: 8,
        content: {
          v: 2,
          blocks: [
            para('blk_one', 'First (theirs)'),
            para('blk_two', 'Second (theirs)'),
            para('blk_three', 'Added by them'),
          ],
        },
      }),
    );
    vi.spyOn(documents, 'version').mockResolvedValue({
      ...(versions[0] as DocVersion),
      content: { v: 2, blocks: [para('blk_one', 'First'), para('blk_two', 'Second')] },
      references: {},
    });
    editor();
    fireEvent.change(screen.getAllByLabelText('Paragraph text')[0]!, {
      target: { value: 'First (mine)' },
    });
    fireEvent.change(screen.getAllByLabelText('Paragraph text')[1]!, {
      target: { value: 'Second (mine)' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Review my changes' })),
    );
    expect(screen.getByRole('heading', { name: 'Review my changes' })).toBeTruthy();
    // Both sides changed both blocks, so nothing is chosen for the person.
    const apply = screen.getByRole('button', { name: 'Use these choices' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(screen.getAllByText('First (mine)').length).toBeGreaterThan(0);
    expect(screen.getByText('First (theirs)')).toBeTruthy();
    const groups = screen.getAllByRole('group').filter((g) => g.tagName === 'FIELDSET');
    fireEvent.click(within(groups[0]!).getByLabelText('Keep mine'));
    fireEvent.click(within(groups[1]!).getByLabelText('Use the latest'));
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    expect(texts()).toEqual(['First (mine)', 'Second (theirs)', 'Added by them']);
    save.mockResolvedValue(doc({ content_version: 9 }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(save.mock.calls[1]![2].base_version).toBe(8);
  });
});

describe('merge: block by block', () => {
  const b = (id: string, t: string) => para(id, t);
  it('presets the side only one person changed and asks where both did', () => {
    const base = [b('a', '1'), b('b', '2'), b('c', '3')];
    const mine = [b('a', '1 mine'), b('b', '2'), b('c', '3 mine')];
    const latest = [b('a', '1'), b('b', '2 theirs'), b('c', '3 theirs')];
    const rows = buildReview(base, mine, latest);
    expect(rows.map((r) => [r.id, r.kind, r.preset])).toEqual([
      ['a', 'mine_changed', 'mine'],
      ['b', 'theirs_changed', 'theirs'],
      ['c', 'both_changed', null],
    ]);
    const merged = applyReview(mine, latest, rows, (r) => r.preset ?? 'theirs');
    expect(
      merged.map((x) => (x.type === 'paragraph' ? (x.runs[0] as { text: string }).text : '')),
    ).toEqual(['1 mine', '2 theirs', '3 theirs']);
  });
  it('keeps blocks only I added in place, and reports blocks only they added', () => {
    const base = [b('a', '1')];
    const mine = [b('a', '1'), para(undefined, 'new mine')];
    const latest = [b('a', '1'), b('z', 'theirs added')];
    const rows = buildReview(base, mine, latest);
    expect(rows.map((r) => r.kind).sort()).toEqual(['added_by_me', 'added_by_them']);
    const merged = applyReview(mine, latest, rows, (r) => r.preset ?? 'theirs');
    expect(merged).toHaveLength(3);
    expect(merged[1]!.id).toBeUndefined(); // placed after the block it followed
  });
  it('without a starting version every difference needs a choice', () => {
    const rows = buildReview(null, [b('a', 'x')], [b('a', 'y')]);
    expect(rows).toEqual([expect.objectContaining({ kind: 'differs', preset: null })]);
  });
});

// -----------------------------------------------------------------------------------------------

const versions: DocVersion[] = [
  {
    id: 'dcv_3',
    type: 'document_version',
    number: 5,
    title: 'Launch plan',
    kind: 'suggestion',
    restored_from: null,
    template: null,
    summary: { added: 1, changed: 2, removed: 0 },
    size_bytes: 10,
    hash: 'h5',
    current: true,
    ai_source: true,
    by: { id: 'mem_2', name: 'Bea Writer' },
    at: '2026-10-02T10:00:00.000Z',
  },
  {
    id: 'dcv_2',
    type: 'document_version',
    number: 4,
    title: 'Launch plan',
    kind: 'restore',
    restored_from: 2,
    template: null,
    summary: { added: 0, changed: 0, removed: 3 },
    size_bytes: 10,
    hash: 'h4',
    current: false,
    ai_source: false,
    by: null,
    at: '2026-10-01T10:00:00.000Z',
  },
  {
    id: 'dcv_1',
    type: 'document_version',
    number: 1,
    title: 'Launch plan',
    kind: 'template',
    restored_from: null,
    template: 'page@1',
    summary: { added: 4, changed: 0, removed: 0 },
    size_bytes: 10,
    hash: 'h1',
    current: false,
    ai_source: false,
    by: { id: 'mem_1', name: 'Ada Owner' },
    at: '2026-09-30T10:00:00.000Z',
  },
];

describe('version history', () => {
  const body = (n: number) => ({
    ...versions.find((v) => v.number === n)!,
    content: { v: 2 as const, blocks: [para('blk_x', `Body of ${n}`)] },
    references: {},
  });

  it('lists versions with who, kind, summary, and the Current and AI source markers, and loads more', async () => {
    const list = vi
      .spyOn(documents, 'versions')
      .mockResolvedValueOnce(page(versions.slice(0, 2), 'c2'))
      .mockResolvedValueOnce(page(versions.slice(2)));
    wrap(
      <VersionHistory
        ws={WS}
        doc={doc()}
        canRestore
        dirty={false}
        onRestored={vi.fn()}
        onStale={vi.fn()}
      />,
    );
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('Version 5')).toBeTruthy();
    expect(within(items[0]!).getByText('Current')).toBeTruthy();
    expect(within(items[0]!).getByText('Approved AI source')).toBeTruthy();
    expect(within(items[0]!).getByText('Suggestion accepted')).toBeTruthy();
    expect(within(items[0]!).getByText(/Bea Writer/)).toBeTruthy();
    expect(within(items[0]!).getByText(/\+1 added, 2 changed, 0 removed/)).toBeTruthy();
    expect(within(items[1]!).getByText('Restored from 2')).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Load more versions' })),
    );
    expect(list).toHaveBeenLastCalledWith(WS, 'doc_1', 'c2');
    expect(screen.getByText('Started from template')).toBeTruthy();
  });

  it('opens a version read-only and restores it: a new version, nothing deleted', async () => {
    vi.spyOn(documents, 'versions').mockResolvedValue(page(versions));
    vi.spyOn(documents, 'version').mockImplementation(async (_w, _d, n) => body(n));
    const restore = vi
      .spyOn(documents, 'restoreVersion')
      .mockResolvedValue(doc({ content_version: 6 }));
    const onRestored = vi.fn();
    wrap(
      <VersionHistory
        ws={WS}
        doc={doc()}
        canRestore
        dirty={false}
        onRestored={onRestored}
        onStale={vi.fn()}
      />,
    );
    await screen.findByText('Version 4');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'View version 1' })));
    expect(await screen.findByText('Body of 1')).toBeTruthy();
    expect(screen.getByText('This adds a new version; nothing is deleted.')).toBeTruthy();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Restore this version' })),
    );
    expect(restore).toHaveBeenCalledWith(
      WS,
      'doc_1',
      { version: 1, base_version: 5 },
      expect.anything(),
    );
    expect(onRestored).toHaveBeenCalled();
  });

  it('no restore button for the current version, for read-only viewers, or with unsaved edits', async () => {
    vi.spyOn(documents, 'versions').mockResolvedValue(page(versions));
    vi.spyOn(documents, 'version').mockImplementation(async (_w, _d, n) => body(n));
    const ui = (props: { canRestore: boolean; dirty: boolean }) => (
      <VersionHistory ws={WS} doc={doc()} {...props} onRestored={vi.fn()} onStale={vi.fn()} />
    );
    const { rerender } = wrap(ui({ canRestore: true, dirty: false }));
    await screen.findByText('Version 4');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'View version 5' })));
    expect(await screen.findByText('This is the current version.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restore this version' })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'View version 1' })));
    await screen.findByText('Body of 1');
    rerender(
      <Router>
        <StepUpProvider>{ui({ canRestore: true, dirty: true })}</StepUpProvider>
      </Router>,
    );
    expect(
      (screen.getByRole('button', { name: 'Restore this version' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/Save or discard your unsaved changes first/)).toBeTruthy();
    rerender(
      <Router>
        <StepUpProvider>{ui({ canRestore: false, dirty: false })}</StepUpProvider>
      </Router>,
    );
    expect(screen.queryByRole('button', { name: 'Restore this version' })).toBeNull();
  });

  it('explains an already-current or stale restore instead of failing silently', async () => {
    vi.spyOn(documents, 'versions').mockResolvedValue(page(versions));
    vi.spyOn(documents, 'version').mockImplementation(async (_w, _d, n) => body(n));
    const restore = vi
      .spyOn(documents, 'restoreVersion')
      .mockRejectedValueOnce(
        err('conflict', 409, { issues: [{ code: 'already_current', message: 'x' }] }),
      )
      .mockRejectedValueOnce(
        err('conflict', 409, {
          conflict: { current_version: 9 },
          issues: [{ code: 'version_changed', message: 'x' }],
        }),
      );
    const onStale = vi.fn();
    wrap(
      <VersionHistory
        ws={WS}
        doc={doc()}
        canRestore
        dirty={false}
        onRestored={vi.fn()}
        onStale={onStale}
      />,
    );
    await screen.findByText('Version 4');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'View version 1' })));
    await screen.findByText('Body of 1');
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Restore this version' })),
    );
    expect(screen.getByText('That is already the current version.')).toBeTruthy();
    expect(onStale).not.toHaveBeenCalled();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Restore this version' })),
    );
    expect(screen.getByText(/The document changed/)).toBeTruthy();
    expect(restore).toHaveBeenCalledTimes(2);
    expect(onStale).toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------------------------

describe('suggestions', () => {
  const sugg = (
    id: string,
    state: Suggestion['state'],
    over: Partial<Suggestion> = {},
  ): Suggestion => ({
    id,
    type: 'document_suggestion',
    document: 'doc_1',
    block: 'blk_one',
    base_version: 5,
    state,
    effective_state: state,
    proposed: para(undefined, 'Better first'),
    current: para('blk_one', 'First'),
    references: {},
    note: 'Tighter wording',
    author: { id: 'mem_2', name: 'Bea Writer' },
    decided_by: null,
    decided_at: null,
    applied_version: null,
    created_at: '2026-10-02T10:00:00.000Z',
    version: 0,
    capabilities: { accept: true, reject: true, withdraw: false },
    ...over,
  });

  it('shows current against proposed with the note, author and state in words', async () => {
    vi.spyOn(documents, 'suggestions').mockResolvedValue(page([sugg('dsg_1', 'open')]));
    wrap(<SuggestionsPanel ws={WS} doc={doc()} onApplied={vi.fn()} />);
    expect(await screen.findByText('Bea Writer')).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Suggestions' })).getByText('Open'),
    ).toBeTruthy();
    expect(screen.getByText('Note: Tighter wording')).toBeTruthy();
    expect(screen.getByText('Current text')).toBeTruthy();
    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.getByText('Better first')).toBeTruthy();
  });

  it('accepts and rejects with the right calls, and tells the document to reload on accept', async () => {
    vi.spyOn(documents, 'suggestions').mockResolvedValue(
      page([sugg('dsg_1', 'open'), sugg('dsg_2', 'open')]),
    );
    const decide = vi
      .spyOn(documents, 'decide')
      .mockResolvedValueOnce(sugg('dsg_1', 'accepted'))
      .mockResolvedValueOnce(sugg('dsg_2', 'rejected'));
    const onApplied = vi.fn();
    wrap(<SuggestionsPanel ws={WS} doc={doc()} onApplied={onApplied} />);
    await screen.findAllByText('Bea Writer');
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /^Accept/ })[0]!));
    expect(decide).toHaveBeenCalledWith(WS, 'dsg_1', 'accept', expect.anything());
    expect(onApplied).toHaveBeenCalledOnce();
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /^Reject/ })[1]!));
    expect(decide).toHaveBeenLastCalledWith(WS, 'dsg_2', 'reject', expect.anything());
    expect(onApplied).toHaveBeenCalledOnce();
  });

  it('says a stale suggestion changed nothing, and withdraw is only for the author', async () => {
    vi.spyOn(documents, 'suggestions').mockResolvedValue(
      page([
        sugg('dsg_1', 'stale', { capabilities: { accept: false, reject: true, withdraw: false } }),
        sugg('dsg_2', 'open', { capabilities: { accept: false, reject: false, withdraw: true } }),
      ]),
    );
    const withdraw = vi.spyOn(documents, 'withdraw').mockResolvedValue(sugg('dsg_2', 'withdrawn'));
    wrap(<SuggestionsPanel ws={WS} doc={doc()} onApplied={vi.fn()} />);
    await screen.findAllByText('Bea Writer');
    expect(screen.getByText('Stale')).toBeTruthy();
    expect(
      screen.getByText('This part changed since the suggestion was made. Nothing was applied.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Accept/ })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Withdraw/ })));
    expect(withdraw).toHaveBeenCalledWith(WS, 'dsg_2', expect.anything());
  });

  it('a commenter suggests a change to a block from the read-only page', async () => {
    const d = doc({ capabilities: { ...NONE, comment: true, suggest: true } });
    vi.spyOn(documents, 'get').mockResolvedValue(d);
    stubPageDependencies();
    const suggest = vi.spyOn(documents, 'suggest').mockResolvedValue(sugg('dsg_9', 'open'));
    wrap(<DocumentPage ws={WS} doc="doc_1" />);
    await screen.findByText(/You can read this document and suggest changes/);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Suggest a change to block 2' }));
    const dialog = screen.getByRole('dialog', { name: 'Suggest a change' });
    fireEvent.change(within(dialog).getByLabelText('Paragraph text'), {
      target: { value: 'Second, better' },
    });
    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), {
      target: { value: 'why' },
    });
    await act(async () =>
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send suggestion' })),
    );
    expect(suggest).toHaveBeenCalledWith(
      WS,
      'doc_1',
      {
        block: 'blk_two',
        base_version: 5,
        proposed: { type: 'paragraph', runs: [{ text: 'Second, better' }] },
        note: 'why',
      },
      expect.anything(),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

// -----------------------------------------------------------------------------------------------

function stubPageDependencies(over: { children?: DocSummary[] } = {}) {
  vi.spyOn(documents, 'versions').mockResolvedValue(page(versions));
  vi.spyOn(documents, 'suggestions').mockResolvedValue(page([]));
  vi.spyOn(documents, 'list').mockResolvedValue(page(over.children ?? []));
  vi.spyOn(documents, 'candidates').mockResolvedValue([]);
  vi.spyOn(collaboration, 'summary').mockResolvedValue({
    type: 'collaboration_summary',
    record: { id: 'doc_1', type: 'document' },
    following: false,
    followed_at: null,
    comment_count: 0,
    capabilities: {
      comment: true,
      follow: true,
      see_followers: false,
      request_review: true,
      delegate: false,
    },
    review: null,
  });
  vi.spyOn(collaboration, 'comments').mockResolvedValue(page([]));
}

describe('the document page: what each person sees', () => {
  const headings = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);

  it('an owner sees the editor and every panel in the specified order', async () => {
    vi.spyOn(documents, 'get').mockResolvedValue(
      doc({
        children_count: 1,
        links: [
          { kind: 'task', id: 'tsk_1', label: 'Ship it', path: '/workspaces/ws_A/tasks/tsk_1' },
        ],
        links_restricted: 2,
      }),
    );
    stubPageDependencies({ children: [summary('doc_2', 'Child page')] });
    wrap(<DocumentPage ws={WS} doc="doc_1" />);
    await screen.findByRole('heading', { name: 'Version history' });
    await screen.findByRole('heading', { name: 'Comments' });
    expect(screen.getByRole('heading', { level: 1, name: 'Launch plan' })).toBeTruthy();
    const order = headings();
    const at = (name: string) => order.indexOf(name);
    expect(at('Content')).toBeLessThan(at('Version history'));
    expect(at('Version history')).toBeLessThan(at('Suggestions'));
    expect(at('Suggestions')).toBeLessThan(at('Comments'));
    expect(at('Comments')).toBeLessThan(at('Linked records'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move to trash' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Approve this version as an AI source' }),
    ).toBeTruthy();
    expect(screen.getByText(/Comments are on the whole document/)).toBeTruthy();
    expect(screen.getByText("2 linked items you can't open.")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Child page' })).toBeTruthy();
    expect(screen.getAllByText(/live editing \(4D\)/).length).toBe(2); // comments note and the list of absences
    expect(screen.getByText(/files \(4E\)/)).toBeTruthy();
    expect(screen.getByText(/print dialog/)).toBeTruthy();
  });

  it('a read-only member sees the document and no controls to change it', async () => {
    vi.spyOn(documents, 'get').mockResolvedValue(
      doc({ capabilities: { ...NONE, comment: true, follow: true } }),
    );
    stubPageDependencies();
    wrap(<DocumentPage ws={WS} doc="doc_1" />);
    await screen.findByText(/You can read this document\. You can't edit it\./);
    expect(screen.getByText('First')).toBeTruthy();
    for (const name of [
      'Save',
      'Export…',
      'Archive',
      'Move to trash',
      'Add page',
      'Link records',
      'Save details',
    ])
      expect(screen.queryByRole('button', { name }), name).toBeNull();
    expect(screen.queryByRole('button', { name: /Suggest a change/ })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Approve this version as an AI source' }),
    ).toBeNull();
  });

  it('a share-only guest sees no ancestors, no subpages and only what the capabilities allow', async () => {
    vi.spyOn(documents, 'get').mockResolvedValue(
      doc({ ancestors: [], capabilities: { ...NONE, comment: true, follow: true } }),
    );
    stubPageDependencies();
    wrap(<DocumentPage ws={WS} doc="doc_1" />);
    await screen.findByText(/You can read this document/);
    expect(screen.queryByRole('heading', { name: 'Subpages' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add page' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'AI source' })).toBeNull();
  });

  it('an archived document is read-only with a plain explanation', async () => {
    vi.spyOn(documents, 'get').mockResolvedValue(
      doc({ archived: true, lifecycle_state: 'archived' }),
    );
    stubPageDependencies();
    wrap(<DocumentPage ws={WS} doc="doc_1" />);
    await screen.findByText(/This document is archived, so it is read-only/);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Unarchive' })).toBeTruthy();
    expect(screen.getAllByText('Archived').length).toBeGreaterThan(0);
  });

  it('a trashed or unreadable document says so plainly without saying why', async () => {
    vi.spyOn(documents, 'get').mockRejectedValue(err('not_found', 404));
    wrap(<DocumentPage ws={WS} doc="doc_1" />);
    expect(
      await screen.findByRole('heading', { name: "This document isn't available to you" }),
    ).toBeTruthy();
  });

  it('loads with a status, and an error offers Try again', async () => {
    const get = vi.spyOn(documents, 'get').mockRejectedValueOnce(err('internal_error', 500));
    wrap(<DocumentPage ws={WS} doc="doc_1" />);
    expect(screen.getByText('Loading document…')).toBeTruthy();
    expect(await screen.findByText(/We couldn't load this document/)).toBeTruthy();
    get.mockResolvedValue(doc());
    stubPageDependencies();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Try again' })));
    expect(await screen.findByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('shows state, review overdue and approved AI source as separate text badges', async () => {
    vi.spyOn(documents, 'get').mockResolvedValue(
      doc({
        state: 'current',
        effective_state: 'stale',
        review_due_on: '2026-09-01',
        review_overdue: true,
        ai_source: {
          approved: true,
          version: 5,
          at: '2026-10-02T10:00:00.000Z',
          by: { id: 'mem_1', name: 'Ada Owner' },
        },
      }),
    );
    stubPageDependencies();
    wrap(<DocumentPage ws={WS} doc="doc_1" />);
    await screen.findByRole('button', { name: 'Save' });
    expect(screen.getAllByText('Stale').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Review overdue').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Approved AI source').length).toBeGreaterThan(0);
  });

  it('exports Markdown and downloads exactly what the server returned, with the notes', async () => {
    vi.spyOn(documents, 'get').mockResolvedValue(doc());
    stubPageDependencies();
    const exp = vi.spyOn(documents, 'export').mockResolvedValue({
      type: 'document_export',
      format: 'markdown',
      filename: 'launch-plan.md',
      content_type: 'text/markdown',
      content: '# Launch plan\n\nFirst\n',
      bytes: 21,
      pages: 1,
      notes: { embeds_as_links: 2, restricted_items: 1, pages_omitted: 0, unsupported: ['pdf'] },
    });
    const createUrl = vi.fn((_b: Blob) => 'blob:x');
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    wrap(<DocumentPage ws={WS} doc="doc_1" />);
    const exportButton = await screen.findByRole('button', { name: 'Export…' });
    await act(async () => fireEvent.click(exportButton));
    const dialog = screen.getByRole('dialog', { name: 'Export this document' });
    expect(
      within(dialog).getByText(/Save the HTML export as PDF from your browser's print dialog/),
    ).toBeTruthy();
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Export' })));
    expect(exp).toHaveBeenCalledWith(WS, 'doc_1', { format: 'markdown' }, expect.anything());
    expect(click).toHaveBeenCalled();
    expect(await (createUrl.mock.calls[0]![0] as unknown as Blob).text()).toBe(
      '# Launch plan\n\nFirst\n',
    );
    expect(within(dialog).getByText(/2 embedded items were exported as links/)).toBeTruthy();
    expect(
      within(dialog).getByText(/1 items you can't see were left as "Restricted item"/),
    ).toBeTruthy();
  });
});

describe('details: state, owner, review date', () => {
  const card = (d = doc(), onSaved = vi.fn(), onStale = vi.fn()) =>
    wrap(<DetailsCard ws={WS} doc={d} onSaved={onSaved} onStale={onStale} onMoved={vi.fn()} />);

  it('sends only what changed with the row version as If-Match', async () => {
    vi.spyOn(documents, 'candidates').mockResolvedValue([]);
    const patch = vi
      .spyOn(documents, 'patch')
      .mockResolvedValue(doc({ version: 4, state: 'stale', review_due_on: '2027-01-01' }));
    const onSaved = vi.fn();
    card(doc(), onSaved);
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'stale' } });
    fireEvent.change(screen.getByLabelText('Review date'), { target: { value: '2027-01-01' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save details' })));
    expect(patch).toHaveBeenCalledWith(
      WS,
      'doc_1',
      3,
      { state: 'stale', review_due_on: '2027-01-01' },
      expect.anything(),
    );
    expect(onSaved).toHaveBeenCalled();
    expect(screen.getByText('Details saved.')).toBeTruthy();
  });

  it('on a stale version it reloads and keeps what was typed', async () => {
    vi.spyOn(documents, 'candidates').mockResolvedValue([]);
    vi.spyOn(documents, 'patch').mockRejectedValue(err('precondition_failed', 412));
    const onStale = vi.fn();
    card(doc(), vi.fn(), onStale);
    fireEvent.change(screen.getByLabelText('Review date'), { target: { value: '2027-01-01' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save details' })));
    expect(onStale).toHaveBeenCalled();
    expect(screen.getByText(/This changed while you were working/)).toBeTruthy();
    expect((screen.getByLabelText('Review date') as HTMLInputElement).value).toBe('2027-01-01');
  });

  it('explains a review date that is too far away or not a date, beside the field', async () => {
    vi.spyOn(documents, 'candidates').mockResolvedValue([]);
    vi.spyOn(documents, 'patch').mockRejectedValue(
      err('validation_failed', 422, {
        issues: [{ pointer: '/review_due_on', code: 'too_far', message: 'x' }],
      }),
    );
    card();
    fireEvent.change(screen.getByLabelText('Review date'), { target: { value: '2099-01-01' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save details' })));
    expect(
      screen.getByText('That date is too far away. Choose a nearer review date.'),
    ).toBeTruthy();
    expect(screen.getByLabelText('Review date').getAttribute('aria-invalid')).toBe('true');
  });

  it('is plain facts when the person cannot edit', () => {
    card(doc({ capabilities: { ...NONE } }));
    expect(screen.queryByRole('button', { name: 'Save details' })).toBeNull();
    expect(screen.getByText("You can't change these details.")).toBeTruthy();
  });
});

describe('subpages', () => {
  it('lists children in order and moves one up or down with the location call', async () => {
    const list = vi
      .spyOn(documents, 'list')
      .mockResolvedValue(
        page([summary('doc_a', 'Alpha'), summary('doc_b', 'Bravo'), summary('doc_c', 'Charlie')]),
      );
    const move = vi.spyOn(documents, 'move').mockResolvedValue(doc());
    wrap(<Subpages ws={WS} doc={doc({ children_count: 3 })} onAdd={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByRole('link', { name: 'Alpha' });
    expect(list).toHaveBeenCalledWith(WS, { parent: 'doc_1', limit: 50 });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Move up Charlie' })));
    expect(move).toHaveBeenCalledWith(
      WS,
      'doc_c',
      { parent: 'doc_1', after: 'doc_a' },
      expect.anything(),
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Move down Alpha' })));
    expect(move).toHaveBeenLastCalledWith(
      WS,
      'doc_a',
      { parent: 'doc_1', after: 'doc_b' },
      expect.anything(),
    );
    expect(
      (screen.getByRole('button', { name: 'Move up Alpha' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

// -----------------------------------------------------------------------------------------------

describe('Knowledge', () => {
  const stub = () => {
    vi.spyOn(people, 'people').mockResolvedValue([]);
    return vi.spyOn(documents, 'list').mockImplementation(async (_w, f = {}) => {
      if (f.parent === 'root' && f.scope === 'workspace')
        return page([
          summary('doc_a', 'Handbook', { has_children: true }),
          summary('doc_b', 'Brand voice'),
        ]);
      if (f.parent === 'doc_a')
        return page([summary('doc_c', 'Onboarding', { parent_id: 'doc_a', depth: 1 })]);
      return page([summary('doc_q', 'Result for search')]);
    });
  };

  it('shows the Workspace group, loads children only when a page is opened, and is a real tree', async () => {
    const list = stub();
    wrap(<KnowledgePage ws={WS} />);
    const tree = await screen.findByRole('tree', { name: 'Workspace pages' });
    expect(list).toHaveBeenCalledWith(WS, {
      scope: 'workspace',
      parent: 'root',
      attached: 'none',
      limit: 50,
    });
    expect(list).not.toHaveBeenCalledWith(WS, expect.objectContaining({ parent: 'doc_a' }));
    const items = within(tree).getAllByRole('treeitem');
    expect(items.filter((i) => i.tabIndex === 0)).toHaveLength(1); // one tab stop
    expect(items[0]!.getAttribute('aria-expanded')).toBe('false');
    expect(items[1]!.getAttribute('aria-expanded')).toBeNull(); // no children: not expandable
    items[0]!.focus();
    await act(async () => fireEvent.keyDown(items[0]!, { key: 'ArrowRight' }));
    expect(list).toHaveBeenCalledWith(WS, { parent: 'doc_a', limit: 50 });
    const open = within(tree).getAllByRole('treeitem');
    expect(open[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(open[1]!.getAttribute('aria-level')).toBe('2');
    await act(async () => fireEvent.keyDown(open[0]!, { key: 'ArrowRight' })); // into the first child
    expect(document.activeElement).toBe(open[1]);
    fireEvent.keyDown(open[1]!, { key: 'ArrowLeft' }); // back to the parent
    expect(document.activeElement).toBe(open[0]);
    fireEvent.keyDown(open[0]!, { key: 'ArrowLeft' }); // collapse
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(2);
    fireEvent.keyDown(open[0]!, { key: 'End' });
    expect(document.activeElement?.textContent).toMatch(/Brand voice/);
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement?.textContent).toMatch(/Handbook/);
    // Enter opens the page.
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(window.location.pathname).toBe('/workspaces/ws_A/documents/doc_a');
  });

  it('says plainly when there are no pages and offers a retry when loading fails', async () => {
    vi.spyOn(people, 'people').mockResolvedValue([]);
    const list = vi
      .spyOn(documents, 'list')
      .mockRejectedValueOnce(err('internal_error', 500))
      .mockResolvedValue(page([]));
    wrap(<KnowledgePage ws={WS} />);
    expect(await screen.findByText(/Something went wrong|couldn't finish/i)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
    expect(
      await screen.findByText('No workspace-level pages yet. Use New page to start one.'),
    ).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('searching switches to a flat list, announces the count politely, and limits the query to 100 characters', async () => {
    const list = stub();
    wrap(<KnowledgePage ws={WS} />);
    await screen.findByRole('tree');
    const q = screen.getByLabelText('Search titles') as HTMLInputElement;
    expect(q.maxLength).toBe(100);
    fireEvent.change(q, { target: { value: 'handbook' } });
    await waitFor(() => expect(screen.queryByRole('tree')).toBeNull(), { timeout: 3000 });
    await screen.findByRole('link', { name: 'Result for search' });
    expect(list).toHaveBeenLastCalledWith(
      WS,
      { scope: 'all', q: 'handbook', limit: 50 },
      expect.anything(),
    );
    const live = screen
      .getAllByRole('status')
      .find((s) => /1 page shown/.test(s.textContent ?? ''));
    expect(live).toBeTruthy();
    expect(live!.getAttribute('aria-live')).toBe('polite');
    expect(window.location.search).toContain('q=handbook');
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'overdue' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'sop' } });
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(
        WS,
        { scope: 'all', type: 'sop', state: 'overdue', q: 'handbook', limit: 50 },
        expect.anything(),
      ),
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Clear filters' })));
    expect(await screen.findByRole('tree')).toBeTruthy();
  });

  it('asks which brand owns a new page when there is more than one, and never guesses', async () => {
    stub();
    const create = vi.spyOn(documents, 'create').mockResolvedValue(doc({ id: 'doc_new' }));
    wrap(<KnowledgePage ws={WS} />);
    await screen.findByRole('tree');
    // Without a shell context only the workspace group exists, so a plain dialog has no brand choice.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'New page' })));
    const dialog = screen.getByRole('dialog', { name: 'New page' });
    expect(within(dialog).getByText('It will be created at the workspace level.')).toBeTruthy();
    expect(within(dialog).getByText(/starter gives the page typical headings/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Runbook' } });
    fireEvent.change(within(dialog).getByLabelText('Type'), { target: { value: 'sop' } });
    await act(async () =>
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create page' })),
    );
    expect(create).toHaveBeenCalledWith(
      WS,
      { type: 'sop', title: 'Runbook', starter: true },
      expect.anything(),
      expect.any(String),
    );
    expect(window.location.pathname).toBe('/workspaces/ws_A/documents/doc_new');
  });
});

// -----------------------------------------------------------------------------------------------

describe('projects and tasks', () => {
  it('lists the documents of a project and creates one attached to it', async () => {
    const list = vi.spyOn(documents, 'list').mockResolvedValue(
      page([
        summary('doc_1', 'Brief', {
          doc_type: 'project_brief',
          doc_type_label: 'Project brief',
          state: 'draft',
          effective_state: 'draft',
        }),
      ]),
    );
    const create = vi.spyOn(documents, 'create').mockResolvedValue(doc({ id: 'doc_n' }));
    wrap(<DocumentsSection ws={WS} project="prj_1" noun="project" canCreate />);
    const row = (await screen.findByRole('link', { name: 'Brief' })).closest('li')!;
    expect(list).toHaveBeenCalledWith(WS, { project: 'prj_1', limit: 25 });
    expect(within(row).getByText('Project brief')).toBeTruthy();
    expect(within(row).getByText('Draft')).toBeTruthy();
    expect(within(row).getByText(/Ada Owner/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New document' }));
    const dialog = screen.getByRole('dialog', { name: 'New document' });
    expect(within(dialog).getByText('It will be created on this project.')).toBeTruthy();
    await act(async () =>
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create page' })),
    );
    expect(create).toHaveBeenCalledWith(
      WS,
      { type: 'project_brief', project: 'prj_1', starter: true },
      expect.anything(),
      expect.any(String),
    );
  });

  it('a task section filters by task, says when nothing is attached, and hides New document when it cannot create', async () => {
    const list = vi.spyOn(documents, 'list').mockResolvedValue(page([]));
    wrap(<DocumentsSection ws={WS} task="tsk_1" noun="task" canCreate={false} />);
    expect(await screen.findByText('No documents are attached to this task yet.')).toBeTruthy();
    expect(list).toHaveBeenCalledWith(WS, { task: 'tsk_1', limit: 25 });
    expect(screen.queryByRole('button', { name: 'New document' })).toBeNull();
  });

  it('a project brief cannot be created from a task, and says why', async () => {
    vi.spyOn(documents, 'list').mockResolvedValue(page([]));
    const create = vi.spyOn(documents, 'create');
    wrap(<DocumentsSection ws={WS} task="tsk_1" noun="task" canCreate />);
    await screen.findByText(/No documents are attached/);
    fireEvent.click(screen.getByRole('button', { name: 'New document' }));
    const dialog = screen.getByRole('dialog', { name: 'New document' });
    fireEvent.change(within(dialog).getByLabelText('Type'), { target: { value: 'project_brief' } });
    await act(async () =>
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create page' })),
    );
    expect(within(dialog).getAllByText(/belongs to a project/).length).toBeGreaterThan(0);
    expect(create).not.toHaveBeenCalled();
  });

  it('Mentioned in documents shows title and type only, and an empty state that says nothing is linked', async () => {
    const back = vi.spyOn(documents, 'backlinks');
    back.mockResolvedValueOnce(
      page([
        {
          id: 'doc_1',
          type: 'document',
          title: 'Plan',
          doc_type: 'sop',
          state: 'current',
          via: 'mention',
        },
      ]),
    );
    const { unmount } = wrap(<MentionedInDocuments ws={WS} rec="tsk_1" />);
    const link = await screen.findByRole('link', { name: 'Plan' });
    expect(link.closest('li')!.textContent).toBe('Plan Procedure (SOP) · mentioned');
    unmount();
    back.mockResolvedValueOnce(page([]));
    wrap(<MentionedInDocuments ws={WS} rec="tsk_1" />);
    expect(await screen.findByText('No document mentions or links this yet.')).toBeTruthy();
  });
});

describe('existing surfaces know documents', () => {
  it('a notification about a document links to the document page', () => {
    expect(
      recordPath('ws_A', { id: 'doc_1', type: 'document', title: 'Plan', archived: false }),
    ).toBe('/workspaces/ws_A/documents/doc_1');
    expect(recordPath('ws_A', { id: 'tsk_1', type: 'task', title: 'T', archived: false })).toBe(
      '/workspaces/ws_A/tasks/tsk_1',
    );
  });

  it('My Work, Following lists followed documents with a link, a label, and a filter', async () => {
    const following = vi.spyOn(collaboration, 'following').mockResolvedValue(
      page([
        {
          id: 'doc_1',
          type: 'document' as const,
          title: 'Launch plan',
          status_category: 'active',
          due: '2026-12-01',
          archived: false,
          brand: null,
          followed_at: '2026-10-01T10:00:00.000Z',
        },
      ]),
    );
    wrap(<FollowingTab ws={WS} />);
    const link = await screen.findByRole('link', { name: 'Launch plan' });
    expect(link.getAttribute('href')).toBe('/workspaces/ws_A/documents/doc_1');
    expect(within(link.closest('li')!).getByText('Document')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Documents' })));
    expect(following).toHaveBeenLastCalledWith(WS, { type: 'document' });
  });

  it('Knowledge is a real page now, and the document page has its own route component', () => {
    const knowledgePage = ROUTE_COMPONENTS.knowledge!({ ws: WS });
    expect(knowledgePage.type).toBe(KnowledgePage);
    expect(ROUTE_COMPONENTS.document!({ ws: WS, doc: 'doc_1' }).type).toBe(DocumentPage);
  });
});
