import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { capture, type Candidate, type InboxItem } from '../src/capture/client.ts';
import { CaptureDialog, DetectedList, InboxPage } from '../src/pages/capture-pages.tsx';
import { Router } from '../src/router.tsx';
import { matchRoute } from '../src/shell/registry.ts';
import { StepUpProvider } from '../src/stepup.tsx';
import { tenancy } from '../src/tenancy/client.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const wrap = (ui: React.ReactNode) =>
  render(
    <Router>
      <StepUpProvider>{ui}</StepUpProvider>
    </Router>,
  );
const cand = (text: string, extra: Partial<Candidate> = {}): Candidate => ({
  text,
  title: text,
  detected: [],
  needs_confirmation: false,
  truncated: false,
  ...extra,
});

describe('capture routes (0E Phase 2E note)', () => {
  it('the Inbox is a live destination; notes and forms are canonical routes', () => {
    expect(matchRoute('/workspaces/ws_A/inbox')).toMatchObject({
      def: { id: 'inbox', phase: null },
    });
    expect(matchRoute('/workspaces/ws_A/notes/note_B')).toMatchObject({ def: { id: 'note' } });
    expect(matchRoute('/workspaces/ws_A/forms/form_C')).toMatchObject({
      def: { id: 'intake_form' },
    });
  });
});

describe('detected values are explained, never called AI (CAP-010)', () => {
  it('shows each value with the text it came from and options for ambiguous ones', () => {
    render(
      <DetectedList
        detected={[
          {
            field: 'priority',
            text: '!high',
            start: 0,
            end: 5,
            rule: 'priority marker',
            status: 'resolved',
            value: 'high',
            label: '"high"',
          },
          {
            field: 'due_date',
            text: '3/4',
            start: 6,
            end: 9,
            rule: 'numeric date',
            status: 'ambiguous',
            value: null,
            options: [
              { value: '2027-03-04', label: '2027-03-04 (month/day)' },
              { value: '2027-04-03', label: '2027-04-03 (day/month)' },
            ],
          },
          {
            field: 'project',
            text: '+Ghost',
            start: 10,
            end: 16,
            rule: '+project',
            status: 'unresolved',
            value: null,
          },
        ]}
      />,
    );
    expect(screen.getByText(/from “!high”/)).toBeTruthy();
    expect(
      screen.getByText(/choose: 2027-03-04 \(month\/day\) or 2027-04-03 \(day\/month\)/),
    ).toBeTruthy();
    expect(screen.getByText(/“\+Ghost” not found/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bAI\b/);
  });
});

describe('the Capture dialog', () => {
  it('saves a task with no configuration and reports refused files without losing the capture', async () => {
    vi.spyOn(capture, 'preview').mockResolvedValue({
      parser_version: 1,
      ai: false,
      candidates: [cand('call plumber')],
    });
    const save = vi.spyOn(capture, 'save').mockResolvedValue({
      id: 'inb_1',
      type: 'inbox_item',
      batch: null,
      items: [{ id: 'inb_1', text: 'call plumber', outcome: 'saved' }],
      links: 0,
      attachments: [{ name: 'a.pdf', outcome: 'refused', code: 'storage_unavailable' }],
    });
    wrap(<CaptureDialog ws="ws_A" onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText('What do you want to capture?'), {
      target: { value: 'call plumber' },
    });
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Files'), { target: { files: [file] } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(save).toHaveBeenCalledWith(
      'ws_A',
      {
        intent: 'task',
        text: 'call plumber',
        files: [{ name: 'a.pdf', size: 1, type: 'application/pdf' }],
      },
      expect.anything(),
    );
    expect(screen.getByText('1 saved to your Inbox.')).toBeTruthy();
    expect(screen.getByText(/File storage isn't available yet/)).toBeTruthy();
  });

  it('a multi-line paste becomes editable candidates; failed ones stay; offline keeps the text', async () => {
    vi.spyOn(capture, 'preview').mockResolvedValue({
      parser_version: 1,
      ai: false,
      candidates: [cand('Buy milk'), cand('Call Ana; book flights')],
    });
    const save = vi
      .spyOn(capture, 'save')
      .mockResolvedValueOnce({
        id: 'inb_1',
        type: 'inbox_item',
        batch: 'batch:X',
        items: [
          { id: 'inb_1', text: 'Buy milk', outcome: 'saved' },
          { text: 'Call Ana', outcome: 'failed', code: 'too_long' },
        ],
        links: 0,
        attachments: [],
      })
      .mockRejectedValueOnce(
        new ApiError({ code: 'offline', status: 0, message: "You're offline." }),
      );
    wrap(<CaptureDialog ws="ws_A" onClose={() => undefined} />);
    const ta = screen.getByLabelText('What do you want to capture?');
    await act(async () => {
      fireEvent.paste(ta, {
        clipboardData: { getData: () => '- Buy milk\n- Call Ana; book flights' },
      });
    });
    expect(screen.getByLabelText('Item 1')).toHaveProperty('value', 'Buy milk');
    fireEvent.click(screen.getByRole('button', { name: 'Split item 2 at semicolons' }));
    expect(screen.getByLabelText('Item 3')).toHaveProperty('value', 'book flights');
    fireEvent.click(screen.getByRole('button', { name: 'Remove item 3' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save all items' })));
    expect(save.mock.calls[0]![1]).toMatchObject({
      items: [{ text: 'Buy milk' }, { text: 'Call Ana' }],
    });
    expect(screen.getByText('Some items were not saved')).toBeTruthy();
    // Only the failed candidate remains to retry.
    expect(screen.getByLabelText('Item 1')).toHaveProperty('value', 'Call Ana');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save all items' })));
    expect(screen.getByRole('alert').textContent).toMatch(/offline.*Nothing was lost/);
    expect(screen.getByLabelText('Item 1')).toHaveProperty('value', 'Call Ana');
  });
});

describe('the Inbox', () => {
  const item = (over: Partial<InboxItem>): InboxItem => ({
    id: 'inb_1',
    type: 'inbox_item',
    intent: 'task',
    raw_text: 'Renew cert 3/4',
    title: 'Renew cert',
    detected: [],
    source: { kind: 'typed' },
    brand: null,
    triage_state: 'untriaged',
    captured_at: '2026-10-06T10:00:00Z',
    version: 0,
    ...over,
  });

  it('shows the original text and source; triage asks for ambiguous choices and previews before apply', async () => {
    vi.spyOn(capture, 'inbox').mockResolvedValue({
      data: [
        item({
          detected: [
            {
              field: 'due_date',
              text: '3/4',
              start: 11,
              end: 14,
              rule: 'numeric date',
              status: 'ambiguous',
              value: null,
              options: [
                { value: '2027-03-04', label: 'March 4' },
                { value: '2027-04-03', label: 'April 3' },
              ],
            },
          ],
        }),
      ],
      page: { has_more: false },
    });
    vi.spyOn(tenancy, 'listBrands').mockResolvedValue({
      data: [{ id: 'br_A', name: 'Harbor', capabilities: { create_records: true } }],
    } as never);
    const pv = vi
      .spyOn(capture, 'previewTriage')
      .mockResolvedValue({ to: 'task', items: [{ item: 'inb_1', outcome: 'ready' }] });
    const tr = vi
      .spyOn(capture, 'triage')
      .mockResolvedValue({
        id: 'inb_1',
        to: 'task',
        items: [{ item: 'inb_1', outcome: 'applied', record: 'tsk_1' }],
      });
    wrap(<InboxPage ws="ws_A" />);
    await act(async () => undefined);
    const list = screen.getByRole('list', { name: 'Inbox items' });
    expect(within(list).getByText('Renew cert 3/4')).toBeTruthy();
    expect(within(list).getByText(/Typed/)).toBeTruthy();
    fireEvent.click(within(list).getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Brand'), { target: { value: 'br_A' } });
    fireEvent.click(screen.getByRole('radio', { name: 'April 3' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Preview' })));
    expect(pv).toHaveBeenCalledWith('ws_A', {
      items: ['inb_1'],
      to: 'task',
      brand: 'br_A',
      choices: { 'due_date@11': '2027-04-03' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Apply' })));
    expect(tr).toHaveBeenCalled();
  });
});
