import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { documents, type Block, type Doc, type DocVersion } from '../src/docs/client.ts';
import { liveApi, type PresenceEntry } from '../src/docs/live-client.ts';
import { LiveReadView } from '../src/docs/live-view.tsx';
import { VersionHistory } from '../src/docs/panels.tsx';
import { DocumentEditor, draftKeyFor } from '../src/docs/session.tsx';
import { Router } from '../src/router.tsx';
import { StepUpProvider } from '../src/stepup.tsx';
import { apiErr, FakeLive, hashOf } from './live-fake.ts';

const WS = 'ws_A';
const para = (id: string, text: string): Block => ({ id, type: 'paragraph', runs: [{ text }] });
const CAPS = {
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
  owner: null,
  created_by: null,
  updated_by: null,
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
  updated_at: new Date().toISOString(),
  capabilities: { ...CAPS },
  ...over,
});

let fake: FakeLive;
const wrap = (ui: React.ReactNode) =>
  render(
    <Router>
      <StepUpProvider>{ui}</StepUpProvider>
    </Router>,
  );
const editor = (d: Doc = doc(), onSaved = vi.fn(), onDirty = vi.fn()) =>
  wrap(<DocumentEditor ws={WS} doc={d} onSaved={onSaved} onDirty={onDirty} />);
const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const texts = () =>
  screen.getAllByLabelText('Paragraph text').map((t) => (t as HTMLTextAreaElement).value);
const type = (n: number, value: string) =>
  fireEvent.change(screen.getAllByLabelText('Paragraph text')[n]!, { target: { value } });
const live = () => document.querySelector('.live-status')?.textContent ?? '';
const online = (v: boolean) => {
  Object.defineProperty(navigator, 'onLine', { value: v, configurable: true });
  window.dispatchEvent(new Event(v ? 'online' : 'offline'));
};

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.useFakeTimers();
  fake = new FakeLive([para('blk_one', 'First'), para('blk_two', 'Second')]).install();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('joining', () => {
  it('joins in edit mode and shows the server snapshot, newer than the page copy', async () => {
    fake.blocks = [
      para('blk_one', 'First'),
      para('blk_two', 'Second'),
      para('blk_three', 'Added live'),
    ];
    fake.seq = 4;
    editor();
    expect(texts()).toEqual(['First', 'Second']); // the plain editor is there at once
    await settle();
    expect(liveCall('join')).toBe(1);
    expect(fake.joinModes).toEqual(['edit']);
    expect(texts()).toEqual(['First', 'Second', 'Added live']);
    expect(live()).toMatch(/^Live — saved just now/);
    expect(document.querySelector('.live-status [role="status"]')?.getAttribute('aria-live')).toBe(
      'polite',
    );
    expect(fake.eventCalls[0]).toMatchObject({ after: 4, wait: 20 });
  });

  it('makes the title read-only while live and says why', async () => {
    editor();
    await settle();
    expect((screen.getByLabelText('Title') as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByText('The title can be changed when no one is editing live.')).toBeTruthy();
  });
});

const liveCall = (name: 'join' | 'operations' | 'events' | 'checkpoint' | 'leave' | 'heartbeat') =>
  (liveApi[name] as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

describe('local edits', () => {
  it('sends one batch after a pause, with the base hash the server gave', async () => {
    editor();
    await settle();
    const hash = hashOf(fake.blocks[1]!);
    type(1, 'Second, edited');
    await settle(200);
    expect(fake.sent).toHaveLength(0); // still typing
    type(1, 'Second, edited twice');
    await settle(450);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.ops).toEqual([
      {
        op_id: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/),
        kind: 'replace',
        base_hash: hash,
        block: para('blk_two', 'Second, edited twice'),
      },
    ]);
    expect(fake.blocks[1]).toEqual(para('blk_two', 'Second, edited twice'));
    expect(document.getElementById('doc-save-state')?.textContent).toMatch(
      /Your changes are shared live/,
    );
    await settle(1000);
    expect(fake.sent).toHaveLength(1); // nothing more to say: no echo of our own event
  });

  it('adds, moves and deletes by block identifier, with new blocks getting an identifier', async () => {
    editor();
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^Move down/ })[0]!);
    await settle(450);
    expect(fake.sent[0]!.ops).toEqual([
      { op_id: expect.any(String), kind: 'move', block_id: 'blk_two', after: null },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Add block' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Paragraph' }));
    await settle(450);
    const insert = fake.sent[1]!.ops[0]!;
    expect(insert).toMatchObject({ kind: 'insert', after: 'blk_one' });
    expect((insert as { block: Block }).block.id).toMatch(/^b_[A-Za-z0-9]{12}$/);
    fireEvent.click(screen.getAllByRole('button', { name: /^Delete/ })[0]!);
    await settle(450);
    expect(fake.sent[2]!.ops[0]).toMatchObject({ kind: 'delete', block_id: 'blk_two' });
    expect(fake.blocks.map((b) => b.id)).toEqual(['blk_one', expect.stringMatching(/^b_/)]);
  });

  it('keeps one batch in flight and sends what was typed meanwhile in the next', async () => {
    editor();
    await settle();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = fake.operations;
    vi.spyOn(liveApi, 'operations').mockImplementationOnce(async (...a) => {
      await gate;
      return real(...a);
    });
    type(0, 'one');
    await settle(450);
    type(1, 'two');
    await settle(450);
    expect(fake.sent).toHaveLength(0); // first still waiting for its answer
    release();
    await settle(10);
    await settle(450);
    expect(fake.sent).toHaveLength(2);
    expect(
      fake.blocks.map((b) => (b.type === 'paragraph' ? (b.runs[0] as { text: string }).text : '')),
    ).toEqual(['one', 'two']);
  });
});

describe('remote changes', () => {
  it("applies another person's change at once and keeps focus and caret in the block being edited", async () => {
    editor();
    await settle();
    const first = screen.getAllByLabelText('Paragraph text')[0] as HTMLTextAreaElement;
    first.focus();
    first.setSelectionRange(2, 2);
    fireEvent.select(first);
    fake.externalText('blk_two', 'Second, by Sam');
    await settle(10);
    expect(texts()).toEqual(['First', 'Second, by Sam']);
    expect(document.activeElement).toBe(screen.getAllByLabelText('Paragraph text')[0]);
    expect((document.activeElement as HTMLTextAreaElement).selectionStart).toBe(2);
    expect(fake.sent).toHaveLength(0); // taking theirs sends nothing back
  });

  it('keeps the caret when the block in use is rewritten from outside', async () => {
    editor();
    await settle();
    const first = screen.getAllByLabelText('Paragraph text')[0] as HTMLTextAreaElement;
    first.focus();
    first.setSelectionRange(3, 3);
    fireEvent.select(first); // the caret moved (a browser reports this as it happens)
    fake.externalText('blk_one', 'First, rewritten');
    await settle(10);
    const now = screen.getAllByLabelText('Paragraph text')[0] as HTMLTextAreaElement;
    expect(now).toBe(first); // same element: focus was not lost
    expect(now.value).toBe('First, rewritten');
    expect(document.activeElement).toBe(first);
    expect(now.selectionStart).toBe(3);
  });

  it('never overwrites unsent text: marks the block, and Keep mine sends it against the new hash', async () => {
    editor();
    await settle();
    type(1, 'Second, mine');
    fake.externalText('blk_two', 'Second, by Sam'); // arrives before the pause ends
    await settle(10);
    expect(texts()[1]).toBe('Second, mine');
    expect(document.querySelector('.live-block-note')?.textContent).toBe(
      'Updated by another editor — review',
    );
    const panel = screen.getByRole('region', { name: /1 change to review/ });
    expect(within(panel).getByText('Second, mine')).toBeTruthy();
    expect(within(panel).getByText('Second, by Sam')).toBeTruthy();
    await settle(1000);
    expect(fake.sent).toHaveLength(0); // nothing is sent for a block waiting for a choice
    expect(document.getElementById('doc-save-state')?.textContent).toMatch(/1 change to review/);
    const newHash = hashOf(fake.blocks[1]!);
    fireEvent.click(within(panel).getByRole('button', { name: /Keep mine/ }));
    await settle(10);
    expect(screen.queryByText(/to review/)).toBeNull();
    expect(fake.sent[0]!.ops[0]).toMatchObject({ kind: 'replace', base_hash: newHash });
    expect(fake.blocks[1]).toEqual(para('blk_two', 'Second, mine'));
  });

  it('Take theirs drops my text for that block on purpose and sends nothing', async () => {
    editor();
    await settle();
    type(1, 'Second, mine');
    fake.externalText('blk_two', 'Second, by Sam');
    await settle(10);
    fireEvent.click(screen.getByRole('button', { name: /Take theirs/ }));
    await settle(500);
    expect(texts()).toEqual(['First', 'Second, by Sam']);
    expect(fake.sent).toHaveLength(0);
    expect(screen.queryByText(/Updated by/)).toBeNull();
  });

  it('a refused operation gets the same choice, with the server block as theirs', async () => {
    editor();
    await settle();
    fake.holdEvents = true; // the poll has not told us yet
    fake.quiet = true;
    fake.externalText('blk_two', 'Second, by Sam');
    type(1, 'Second, mine');
    await settle(450);
    expect(fake.sent).toHaveLength(1);
    expect(texts()[1]).toBe('Second, mine');
    const panel = screen.getByRole('region', { name: /1 change to review/ });
    expect(within(panel).getByText('Second, by Sam')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: /Keep mine/ }));
    await settle(450);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]!.ops[0]).toMatchObject({
      kind: 'replace',
      base_hash: hashOf(para('blk_two', 'Second, by Sam')),
    });
    expect(fake.blocks[1]).toEqual(para('blk_two', 'Second, mine'));
  });

  it('a block someone deleted while I changed it waits: Keep mine puts it back, Take theirs removes it', async () => {
    editor();
    await settle();
    type(1, 'Second, mine');
    fake.external({ kind: 'delete', block_id: 'blk_two', base_hash: hashOf(fake.blocks[1]!) });
    await settle(10);
    expect(document.querySelector('.live-block-note')?.textContent).toBe(
      'Deleted by another editor — review',
    );
    expect(texts()).toEqual(['First', 'Second, mine']);
    fireEvent.click(screen.getByRole('button', { name: /Keep mine/ }));
    await settle(450);
    expect(fake.sent[0]!.ops[0]).toMatchObject({
      kind: 'insert',
      after: 'blk_one',
      block: para('blk_two', 'Second, mine'),
    });
    expect(fake.blocks.map((b) => b.id)).toEqual(['blk_one', 'blk_two']);
  });

  it('names who changed it only when the server said who', async () => {
    fake.setPresence([
      { peer: 'me00', you: true, name: 'Ada Owner', mode: 'edit', color: 0, caret_block: null },
      { peer: 'peerB', you: false, name: 'Sam Rivera', mode: 'edit', color: 2, caret_block: null },
    ]);
    editor();
    await settle();
    type(1, 'Second, mine');
    fake.externalText('blk_two', 'Second, by Sam');
    await settle(10);
    expect(document.querySelector('.live-block-note')?.textContent).toBe(
      'Updated by Sam Rivera — review',
    );
  });
});

describe('presence', () => {
  const sam: PresenceEntry = {
    peer: 'peerB',
    you: false,
    name: 'Sam Rivera',
    mode: 'edit',
    color: 2,
    caret_block: 'blk_two',
  };
  const lee: PresenceEntry = {
    peer: 'peerC',
    you: false,
    name: 'Lee Chen',
    mode: 'view',
    color: 5,
    caret_block: null,
  };
  const me: PresenceEntry = {
    peer: 'me00',
    you: true,
    name: 'Ada Owner',
    mode: 'edit',
    color: 0,
    caret_block: null,
  };

  it('lists the people the server named, each with a swatch and a text label, and where they are', async () => {
    fake.setPresence([me, sam, lee]);
    editor();
    await settle();
    const list = screen.getByRole('list', { name: 'People here' });
    const chips = within(list).getAllByRole('listitem');
    expect(chips.map((c) => c.textContent)).toEqual(['Sam Rivera (editing)', 'Lee Chen (viewing)']);
    expect(chips[0]!.querySelector('.live-swatch')?.getAttribute('aria-hidden')).toBe('true');
    expect(chips[0]!.getAttribute('data-color')).toBe('2');
    expect(screen.getByText('1 other editing, 1 viewing')).toBeTruthy();
    expect(screen.getByText('Sam Rivera is here')).toBeTruthy();
  });

  it('shows just "Live" when the server names no one else (a guest or share-only viewer)', async () => {
    editor();
    await settle();
    expect(screen.queryByRole('list', { name: 'People here' })).toBeNull();
    expect(live()).toMatch(/^Live/);
    expect(screen.queryByText(/others? editing/)).toBeNull();
  });

  it('never invents a name for an entry the server sent without one', async () => {
    fake.setPresence([me, { ...sam, name: null }]);
    editor();
    await settle();
    expect(screen.queryByRole('list', { name: 'People here' })).toBeNull();
    expect(screen.queryByText(/Someone/)).toBeNull();
  });

  it('announces joins politely and once, not on every poll', async () => {
    editor();
    await settle();
    fake.setPresence([me, sam]);
    await settle(10);
    const polite = [...document.querySelectorAll('[role="status"][aria-live="polite"]')].map(
      (n) => n.textContent,
    );
    expect(polite).toContain('Someone joined this document.');
    expect(document.querySelectorAll('[aria-live="assertive"], [role="alert"]').length).toBe(0);
  });

  it('tells the server which block I am in, debounced', async () => {
    editor();
    await settle();
    (screen.getAllByLabelText('Paragraph text')[1] as HTMLTextAreaElement).focus();
    await settle(100);
    expect(fake.heartbeat).not.toHaveBeenCalled();
    await settle(500);
    expect(fake.heartbeat).toHaveBeenCalledWith(WS, 'doc_1', {
      session: fake.session,
      caret: 'blk_two',
    });
  });
});

describe('connection trouble', () => {
  it('backs off 1s, 2s, 4s while editing locally, then resumes from the last sequence', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter: x1
    editor();
    await settle();
    fake.externalText('blk_two', 'Second v2');
    await settle(10);
    expect(fake.eventCalls.at(-1)!.after).toBe(1);
    const before = fake.eventCalls.length;
    const down = () => new ApiError({ code: 'network', status: 0, message: 'Network error.' });
    fake.failEvents.push(down(), down(), down());
    fake.wake();
    await settle(600); // the poll answers, pauses briefly, then the next call fails
    expect(live()).toMatch(/^Reconnecting…/);
    type(0, 'First, typed while down');
    await settle(450);
    expect(fake.sent).toHaveLength(1); // editing and sending keep working if the poll alone is down
    const calls = () => fake.eventCalls.length - before;
    // the answer at +0, a pause of 0.5 s, the first failed call at +0.5 s
    expect(calls()).toBe(1);
    await settle(900); // +1.5 s: after waiting 1 s the second call (fails)
    expect(calls()).toBe(2);
    await settle(1400); // still waiting out the 2 s
    expect(calls()).toBe(2);
    await settle(200); // the third call (fails), then 4 s
    expect(calls()).toBe(3);
    await settle(3800);
    expect(calls()).toBe(3);
    await settle(300); // the fourth call succeeds
    expect(calls()).toBe(4);
    expect(fake.eventCalls.at(-1)!.after).toBe(fake.seq);
    expect(live()).toMatch(/^Live/);
  });

  it('caps the back-off at 15 seconds', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    editor();
    await settle();
    const down = () => new ApiError({ code: 'network', status: 0, message: 'Network error.' });
    fake.failEvents.push(...Array.from({ length: 5 }, down));
    fake.wake();
    await settle(500 + 1000 + 2000 + 4000 + 8000 + 100); // five failed calls; the next wait is 15 s, not 16
    const calls = fake.eventCalls.length;
    expect(calls).toBeGreaterThanOrEqual(6);
    await settle(14_000);
    expect(fake.eventCalls.length).toBe(calls);
    await settle(1100);
    expect(fake.eventCalls.length).toBe(calls + 1);
  });

  it('rejoins on session_expired and keeps what was typed, sending it afterwards', async () => {
    editor();
    await settle();
    fake.failOps.push(apiErr('conflict', 409, 'session_expired'));
    fake.externalText('blk_one', 'First, by Sam');
    type(1, 'Second, mine');
    await settle(450);
    await settle(10);
    expect(liveCall('join')).toBe(2);
    expect(texts()).toEqual(['First, by Sam', 'Second, mine']);
    await settle(450);
    expect(fake.blocks[1]).toEqual(para('blk_two', 'Second, mine'));
    expect(fake.eventCalls.at(-1)!.session).toBe(fake.session);
  });

  it('offers a changed block as a choice after a resync, instead of dropping typed text', async () => {
    editor();
    await settle();
    vi.spyOn(liveApi, 'operations').mockImplementationOnce(() => new Promise(() => undefined)); // never answers
    type(1, 'Second, mine');
    await settle(450);
    // The server's log no longer reaches back: the next poll is a full snapshot.
    vi.spyOn(liveApi, 'events').mockImplementationOnce(async () => ({
      seq: 9,
      events: [],
      presence: fake.presence,
      presence_tag: 'x',
      resync: {
        seq: 9,
        base_version: 6,
        dirty: true,
        content: { v: 2, blocks: [para('blk_one', 'First'), para('blk_two', 'Second, theirs')] },
        hashes: {
          blk_one: hashOf(para('blk_one', 'First')),
          blk_two: hashOf(para('blk_two', 'Second, theirs')),
        },
        references: {},
      },
    }));
    fake.wake();
    await settle(600);
    expect(texts()[1]).toBe('Second, mine');
    expect(screen.getByRole('region', { name: /1 change to review/ })).toBeTruthy();
  });

  it('stops polling after a minute in a hidden tab and carries on when it is visible again', async () => {
    editor();
    await settle();
    const hidden = (v: boolean) => {
      Object.defineProperty(document, 'visibilityState', {
        value: v ? 'hidden' : 'visible',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    hidden(true);
    await settle(59_000);
    expect(live()).not.toMatch(/paused/);
    await settle(2000);
    expect(live()).toMatch(/updates paused/);
    const calls = fake.eventCalls.length;
    fake.externalText('blk_two', 'Second, while away');
    await settle(5000);
    expect(fake.eventCalls.length).toBe(calls);
    hidden(false);
    await settle(10);
    expect(texts()[1]).toBe('Second, while away');
    expect(live()).not.toMatch(/paused/);
  });

  it('keeps edits in the browser draft while offline, says so, and sends them when back online', async () => {
    editor();
    await settle();
    online(false);
    await settle(10);
    expect(live()).toMatch(
      /^Offline — your edits are kept on this device and sent when you reconnect/,
    );
    type(1, 'Second, written offline');
    await settle(450);
    await settle(300);
    expect(fake.sent).toHaveLength(0);
    const stored = JSON.parse(
      JSON.parse(localStorage.getItem(`pm.draft.${accountKey()}.${draftKeyFor(WS, 'doc_1')}`)!)
        .value,
    );
    expect(stored.blocks[1].text).toBe('Second, written offline');
    expect(stored.live.base.blk_two).toBeTruthy();
    online(true);
    await settle(450);
    expect(fake.blocks[1]).toEqual(para('blk_two', 'Second, written offline'));
    expect(live()).toMatch(/^Live/);
  });

  it('falls back to the plain editor when the live connection keeps failing, keeping the text', async () => {
    editor();
    await settle();
    const down = () => new ApiError({ code: 'service_unavailable', status: 503, message: 'x' });
    fake.failEvents.push(...Array.from({ length: 8 }, down));
    fake.wake();
    await settle(60_000);
    expect(live()).toMatch(/^Editing without live updates \(the live connection keeps failing\)/);
    expect(screen.getByRole('button', { name: 'Try live editing again' })).toBeTruthy();
    expect(texts()).toEqual(['First', 'Second']);
  });
});

const accountKey = () => {
  const k = Object.keys(localStorage).find((x) => x.startsWith('pm.draft.'))!;
  return k.slice('pm.draft.'.length).split('.doc.')[0]!;
};

describe('access ends', () => {
  it('not_found mid-session: stops, never retries, keeps the text, and says so', async () => {
    editor();
    await settle();
    type(1, 'Second, unsent');
    fake.failOps.push(apiErr('not_found', 404));
    await settle(450);
    await settle(10);
    expect(screen.getByText('You no longer have access to this document')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download my unsaved text' })).toBeTruthy();
    expect(screen.getByLabelText('Your last text')).toBeTruthy();
    const calls = [liveCall('operations'), liveCall('events'), liveCall('join')];
    await settle(60_000);
    expect([liveCall('operations'), liveCall('events'), liveCall('join')]).toEqual(calls);
    const kept = Object.entries(localStorage).find(
      ([k]) => k.includes('doc_1') || k.includes('doc.'),
    );
    expect(kept?.[1]).toContain('Second, unsent');
  });

  it('the poll finding the document gone ends the session the same way', async () => {
    editor();
    await settle();
    fake.failEvents.push(apiErr('not_found', 404));
    fake.wake();
    await settle(600);
    expect(screen.getByText('You no longer have access to this document')).toBeTruthy();
  });

  it('an archived document locks it as archived', async () => {
    editor();
    await settle();
    fake.failEvents.push(apiErr('conflict', 409, 'document_archived'));
    fake.wake();
    await settle(600);
    expect(screen.getByText('This document is archived, so it is read-only now')).toBeTruthy();
  });
});

describe('fallback to the plain editor', () => {
  it.each([
    ['live_capacity', 'too many people are editing live right now'],
    ['live_disabled', 'live editing is turned off here'],
    ['document_archived', 'this document is archived'],
  ])('%s: says so politely and the 4C editor keeps working', async (code, reason) => {
    fake.failJoin.push(apiErr('conflict', 409, code));
    const save = vi.spyOn(documents, 'saveContent').mockResolvedValue(doc({ content_version: 6 }));
    const onSaved = vi.fn();
    editor(doc(), onSaved);
    await settle();
    expect(live()).toContain(`Editing without live updates (${reason})`);
    expect(document.querySelector('.live-status [role="status"]')).toBeTruthy();
    expect(liveCall('events')).toBe(0);
    type(0, 'First, plain');
    expect(document.getElementById('doc-save-state')?.textContent).toMatch(/Unsaved changes/);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await settle(10);
    expect(save).toHaveBeenCalledWith(
      WS,
      'doc_1',
      expect.objectContaining({ base_version: 5 }),
      expect.anything(),
      expect.any(String),
    );
    expect(onSaved).toHaveBeenCalled();
    expect(liveCall('checkpoint')).toBe(0);
    expect((screen.getByLabelText('Title') as HTMLInputElement).readOnly).toBe(false);
  });

  it('a non-live save refused because someone edits live is a friendly message, not a raw error', async () => {
    fake.failJoin.push(apiErr('conflict', 409, 'live_capacity'));
    vi.spyOn(documents, 'saveContent').mockRejectedValue(
      apiErr('conflict', 409, 'live_edit_in_progress'),
    );
    editor();
    await settle();
    type(0, 'First, plain');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await settle(10);
    expect(screen.getAllByText(/someone is editing this document live/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/live_edit_in_progress/)).toBeNull();
    expect(texts()[0]).toBe('First, plain');
  });

  it('can try live editing again on request', async () => {
    fake.failJoin.push(apiErr('conflict', 409, 'live_capacity'));
    editor();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Try live editing again' }));
    await settle();
    expect(live()).toMatch(/^Live/);
  });
});

describe('saving a version while live', () => {
  it('Save sends what is pending, then asks for a checkpoint, and shows the new version', async () => {
    const onSaved = vi.fn();
    vi.spyOn(documents, 'get').mockResolvedValue(doc({ content_version: 6 }));
    editor(doc(), onSaved);
    await settle();
    type(1, 'Second, saved');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await settle(10);
    expect(fake.sent).toHaveLength(1); // flushed without waiting for the pause
    expect(liveCall('checkpoint')).toBe(1);
    expect(document.getElementById('doc-save-state')?.textContent).toMatch(/Saved as version 6\./);
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ content_version: 6 }));
    expect(live()).toMatch(/^Live — saved just now/);
  });

  it('Ctrl+S does the same, and says plainly when there was nothing new to save', async () => {
    editor();
    await settle();
    fireEvent.keyDown(screen.getAllByLabelText('Paragraph text')[0]!, { key: 's', ctrlKey: true });
    await settle(10);
    expect(liveCall('checkpoint')).toBe(1);
    expect(document.getElementById('doc-save-state')?.textContent).toMatch(/nothing new to add/);
  });

  it('will not save a version while a change waits for a choice', async () => {
    editor();
    await settle();
    type(1, 'Second, mine');
    fake.externalText('blk_two', 'Second, by Sam');
    await settle(10);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await settle(10);
    expect(liveCall('checkpoint')).toBe(0);
    expect(screen.getAllByText(/Choose what to keep/).length).toBeGreaterThan(0);
  });
});

describe('leaving', () => {
  it('leaves the session on unmount with keepalive, and on pagehide', async () => {
    const { unmount } = editor();
    await settle();
    unmount();
    expect(fake.leave).toHaveBeenCalledWith(WS, 'doc_1', fake.session, true);
    expect(fake.leave).toHaveBeenCalledTimes(1);
  });

  it('leaves once on pagehide and rejoins when restored from the back-forward cache', async () => {
    editor();
    await settle();
    window.dispatchEvent(new Event('pagehide'));
    expect(fake.leave).toHaveBeenCalledTimes(1);
    const show = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(show, 'persisted', { value: true });
    window.dispatchEvent(show);
    await settle();
    expect(liveCall('join')).toBe(2);
  });
});

describe('viewing', () => {
  const view = (d: Doc) => wrap(<LiveReadView ws={WS} doc={d} />);

  it('a reader joins in view mode, sees changes arrive, has nothing to type into, and sees only who the server names', async () => {
    fake.mode = 'view';
    view(doc({ capabilities: { ...CAPS, edit: false } }));
    expect(screen.getByText('First')).toBeTruthy();
    await settle();
    expect(fake.joinModes).toEqual(['view']);
    expect(live()).toBe('Live — viewing');
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    fake.externalText('blk_two', 'Second, live');
    await settle(10);
    expect(screen.getByText('Second, live')).toBeTruthy();
    expect(liveCall('operations')).toBe(0);
    expect(screen.queryByRole('list', { name: 'People here' })).toBeNull();
  });

  it('says nothing and shows the plain page when live is unavailable', async () => {
    fake.failJoin.push(apiErr('conflict', 409, 'live_disabled'));
    view(doc());
    await settle();
    expect(document.querySelector('.live-status')).toBeNull();
    expect(screen.getByText('Second')).toBeTruthy();
  });

  it('a revoked reader is told, and keeps what they had', async () => {
    view(doc());
    await settle();
    fake.failEvents.push(apiErr('not_found', 404));
    fake.wake();
    await settle(600);
    expect(live()).toBe('You no longer have access');
    expect(screen.getByText('Second')).toBeTruthy();
  });
});

describe('restoring a version while someone edits live', () => {
  it('shows a friendly sentence', async () => {
    const v = (n: number): DocVersion => ({
      id: `ver_${n}`,
      type: 'document_version',
      number: n,
      title: 'Launch plan',
      kind: 'save',
      restored_from: null,
      template: null,
      summary: { added: 0, changed: 1, removed: 0 },
      size_bytes: 10,
      hash: 'h',
      current: n === 5,
      ai_source: false,
      by: { id: 'mem_1', name: 'Ada Owner' },
      at: '2026-10-02T10:00:00.000Z',
    });
    vi.spyOn(documents, 'versions').mockResolvedValue({
      data: [v(5), v(4)],
      page: { limit: 20, has_more: false },
    });
    vi.spyOn(documents, 'version').mockResolvedValue({
      ...v(4),
      content: { v: 2, blocks: [para('blk_one', 'Old')] },
      references: {},
    });
    vi.spyOn(documents, 'restoreVersion').mockRejectedValue(
      apiErr('conflict', 409, 'live_edit_in_progress'),
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
    await settle(10);
    await settle(50);
    const row = screen.getAllByRole('listitem').find((l) => /Version 4/.test(l.textContent ?? ''))!;
    fireEvent.click(within(row).getByRole('button', { name: /View/ }));
    await settle(10);
    fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }));
    await settle(10);
    expect(screen.getByText('Someone is editing live. Restore after they finish.')).toBeTruthy();
    expect(onStale).not.toHaveBeenCalled();
  });
});

describe('invalid blocks', () => {
  it('a refused block is marked, nothing else is lost, and typing again tries again', async () => {
    editor();
    await settle();
    fake.failOps.push(
      new ApiError({
        code: 'validation_failed',
        status: 422,
        message: 'x',
        issues: [{ pointer: '/ops/0/block/runs/0/text', code: 'too_long', message: 'Too long.' }],
      }),
    );
    type(1, 'Second, too long');
    await settle(450);
    expect(screen.getByText(/This is too long/)).toBeTruthy();
    await settle(2000);
    expect(fake.sent).toHaveLength(1); // not resent in a loop
    type(1, 'Second, shorter');
    await settle(450);
    expect(fake.sent).toHaveLength(2);
    expect(screen.queryByText(/This is too long/)).toBeNull();
  });
});

describe('retries and reloads', () => {
  it('a rate limit waits as long as the server said, and retries the same operations (same identifiers)', async () => {
    editor();
    await settle();
    fake.failOps.push(
      new ApiError({ code: 'rate_limited', status: 429, message: 'x', retryAfterSeconds: 3 }),
    );
    type(1, 'Second, edited');
    await settle(450);
    expect(fake.sent).toHaveLength(1);
    await settle(2000);
    expect(fake.sent).toHaveLength(1);
    await settle(1100);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]!.ops[0]!.op_id).toBe(fake.sent[0]!.ops[0]!.op_id);
    expect(fake.blocks[1]).toEqual(para('blk_two', 'Second, edited'));
  });

  it('a lost answer is safe: the retried batch does not apply twice', async () => {
    editor();
    await settle();
    const real = fake.operations;
    vi.spyOn(liveApi, 'operations').mockImplementationOnce(async (...a) => {
      await real(...a); // the server applied it, the answer never arrived
      throw new ApiError({ code: 'network', status: 0, message: 'Network error.' });
    });
    type(1, 'Second, edited');
    await settle(450);
    await settle(1500);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]!.ops[0]!.op_id).toBe(fake.sent[0]!.ops[0]!.op_id);
    expect(fake.log.filter((e) => e.kind === 'replace')).toHaveLength(1);
    expect(texts()).toEqual(['First', 'Second, edited']);
    expect(screen.queryByText(/to review/)).toBeNull();
  });

  it('a change waiting for a choice survives a reload and is offered again, never overwritten', async () => {
    const first = editor();
    await settle();
    type(1, 'Second, mine');
    fake.externalText('blk_two', 'Second, by Sam');
    await settle(10);
    expect(screen.getByRole('region', { name: /1 change to review/ })).toBeTruthy();
    first.unmount();
    cleanup();
    await settle(10);
    expect(fake.blocks[1]).toEqual(para('blk_two', 'Second, by Sam'));
    // The page loads again: its copy of the document is the old version.
    editor();
    await settle(10);
    expect(texts()[1]).toBe('Second, mine');
    expect(screen.getByRole('region', { name: /1 change to review/ })).toBeTruthy();
    await settle(2000);
    expect(fake.blocks[1]).toEqual(para('blk_two', 'Second, by Sam')); // nothing was sent over it
    expect(screen.queryByText('Restored your unsaved changes from this device')).toBeNull();
  });
});

describe('the unsaved-changes guard', () => {
  it('reports dirty while changes are unsent and clean once the server has them', async () => {
    const onDirty = vi.fn();
    editor(doc(), vi.fn(), onDirty);
    await settle();
    type(1, 'Second, edited');
    expect(onDirty).toHaveBeenLastCalledWith(true);
    await settle(450);
    expect(onDirty).toHaveBeenLastCalledWith(false);
  });
});
