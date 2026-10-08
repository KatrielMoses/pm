import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import {
  contentTypeOf,
  files,
  formatBytes,
  uploadFile,
  type Comparison,
  type FileItem,
  type FileVersion,
  type StorageStatus,
  type UploadPhase,
} from '../src/files/client.ts';
import { DeliverablesPanel } from '../src/files/deliverables.tsx';
import { ComparisonView, FilesPanel, VersionsDialog } from '../src/files/files-panel.tsx';
import { Router } from '../src/router.tsx';
import { StepUpProvider } from '../src/stepup.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const wrap = (ui: React.ReactNode) =>
  render(
    <Router>
      <StepUpProvider>{ui}</StepUpProvider>
    </Router>,
  );

const WS = 'ws_A';
const storage = (extra: Partial<StorageStatus> = {}): StorageStatus => ({
  object_storage: 'ok',
  malware_scanner: 'ok',
  accepting_uploads: true,
  quota_bytes: 10_737_418_240,
  used_bytes: 1024,
  reserved_bytes: 0,
  objects: 1,
  upload_max_bytes: 104_857_600,
  ...extra,
});
const version = (extra: Partial<FileVersion> = {}): FileVersion => ({
  number: 1,
  name: 'notes.txt',
  kind: 'upload',
  url: null,
  content_type: 'text/plain',
  byte_size: 18,
  sha256: 'a'.repeat(64),
  state: 'ready',
  blocked_reason: null,
  preview: 'text',
  evidence_locked: false,
  created_by: { id: 'mem_1', name: 'Fay' },
  created_at: '2026-10-06T09:00:00.000Z',
  ...extra,
});
const file = (id: string, v: Partial<FileVersion> = {}, extra: Partial<FileItem> = {}) => {
  const cur = version(v);
  return {
    id,
    type: 'file' as const,
    name: cur.name,
    source: cur.kind === 'link' ? ('external' as const) : ('upload' as const),
    host: { kind: 'task' as const, id: 'tsk_1', title: 'Copy' },
    brand: null,
    owner: { id: 'mem_1', name: 'Fay' },
    current: cur,
    versions: [cur],
    can: { upload: true, download: true, rename: true, trash: true },
    created_at: cur.created_at,
    updated_at: cur.created_at,
    version: 1,
    ...extra,
  };
};
const listOf = (data: FileItem[], can_upload = true) => ({
  data,
  host: { kind: 'task' as const, id: 'tsk_1', title: 'Copy' },
  can_upload,
});

describe('files client helpers (4E)', () => {
  it('names types from the allow-list and formats sizes', () => {
    expect(contentTypeOf({ name: 'a.md', type: '' })).toBe('text/markdown');
    expect(contentTypeOf({ name: 'a.ts', type: 'video/mp2t' })).toBe('video/mp2t');
    expect(contentTypeOf({ name: 'a.ts', type: '' })).toBe('text/plain');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });

  it('uploads: hash, session, PUT with progress, complete; a failed PUT retries with a fresh URL', async () => {
    const upload = {
      url: '/v1/storage/local/q.1?sig=x',
      method: 'PUT' as const,
      headers: {},
      expires_at: '',
    };
    const session = {
      id: 'upl_1',
      type: 'upload_session' as const,
      state: 'initiated',
      name: 'n.txt',
      content_type: 'text/plain',
      byte_size: 2,
      rejection: null,
      file: null,
      expires_at: '',
      upload,
      version: 1,
    };
    const init = vi.spyOn(files, 'initiate').mockResolvedValue(session);
    const fresh = vi
      .spyOn(files, 'session')
      .mockResolvedValue({ ...session, upload: { ...upload, url: '/fresh' } });
    vi.spyOn(files, 'complete').mockResolvedValue({
      ...session,
      state: 'completed',
      file: 'file_1',
      upload: null,
    });
    const put = vi
      .fn()
      .mockRejectedValueOnce(new ApiError({ code: 'network', status: 0, message: '' }))
      .mockImplementation((_t: unknown, _b: unknown, p: (n: number) => void) => {
        p(50);
        return Promise.resolve();
      });
    const phases: UploadPhase[] = [];
    const blob = new File(['hi'], 'n.txt', { type: 'text/plain' });
    await uploadFile(
      WS,
      { host: 'tsk_1' },
      blob,
      () => Promise.resolve(null),
      (p) => phases.push(p),
      { put },
    );
    expect(init.mock.calls[0]![1]).toMatchObject({
      host: 'tsk_1',
      name: 'n.txt',
      content_type: 'text/plain',
      byte_size: 2,
      sha256: '8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
    });
    expect(fresh).toHaveBeenCalledWith(WS, 'upl_1');
    expect(put.mock.calls[1]![0]).toMatchObject({ url: '/fresh' });
    expect(phases.map((p) => p.phase)).toEqual([
      'hashing',
      'uploading',
      'uploading',
      'finishing',
      'done',
    ]);
    expect(phases).toContainEqual({ phase: 'uploading', pct: 50 });
  });
});

describe('FilesPanel (4E)', () => {
  it('shows each state as text, and offers download only for ready files', async () => {
    vi.spyOn(files, 'storage').mockResolvedValue(storage());
    vi.spyOn(files, 'list').mockResolvedValue(
      listOf([
        file('file_1'),
        file('file_2', { name: 'scan.txt', state: 'scanning', preview: 'none' }),
        file('file_3', {
          name: 'bad.txt',
          state: 'blocked',
          blocked_reason: 'malware',
          preview: 'none',
        }),
        file('file_4', {
          name: 'deck.pptx',
          preview: 'none',
          content_type: 'application/vnd.ms-powerpoint',
        }),
        file('file_5', {
          name: 'Brief',
          kind: 'link',
          url: 'https://example.com',
          state: 'link',
          preview: 'none',
        }),
      ]),
    );
    wrap(<FilesPanel ws={WS} host="tsk_1" />);
    const row = async (name: string) =>
      (await screen.findByRole('heading', { name, level: 3 })).closest('li')!;
    expect(within(await row('notes.txt')).getByText('Ready')).toBeTruthy();
    expect(
      within(await row('notes.txt')).getByRole('link', { name: /Download\s*notes\.txt/ }),
    ).toBeTruthy();
    expect(within(await row('scan.txt')).getByText('Scanning')).toBeTruthy();
    expect(within(await row('scan.txt')).queryByRole('link', { name: /Download/ })).toBeNull();
    expect(within(await row('bad.txt')).getByText('Blocked (malware)')).toBeTruthy();
    expect(within(await row('bad.txt')).queryByRole('link', { name: /Download/ })).toBeNull();
    // Degraded: no preview for this type, but the download is still offered.
    expect(within(await row('deck.pptx')).getByText(/No preview for this type/)).toBeTruthy();
    expect(
      within(await row('deck.pptx')).getByRole('link', { name: /Download\s*deck\.pptx/ }),
    ).toBeTruthy();
    expect(within(await row('Brief')).getByText('Link')).toBeTruthy();
    expect(screen.getByLabelText('Upload a file')).toBeTruthy();
  });

  it('has no upload control without permission, and an honest banner without storage', async () => {
    vi.spyOn(files, 'storage').mockResolvedValue(storage());
    vi.spyOn(files, 'list').mockResolvedValue(listOf([], false));
    wrap(<FilesPanel ws={WS} host="tsk_1" noun="on this task" />);
    await screen.findByText(/No files on this task yet/);
    expect(screen.queryByLabelText('Upload a file')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add external link…' })).toBeNull();
    cleanup();
    vi.spyOn(files, 'storage').mockResolvedValue(
      storage({ accepting_uploads: false, malware_scanner: 'not_configured' }),
    );
    vi.spyOn(files, 'list').mockResolvedValue(listOf([], true));
    wrap(<FilesPanel ws={WS} host="tsk_1" />);
    await screen.findByText("Malware scanning isn't set up here");
    expect(screen.queryByLabelText('Upload a file')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add external link…' })).toBeTruthy();
  });

  it('upload flow: Uploading n% then Scanning; over quota explains usage', async () => {
    vi.spyOn(files, 'storage').mockResolvedValue(
      storage({ used_bytes: 1_048_576, quota_bytes: 2_097_152 }),
    );
    vi.spyOn(files, 'list').mockResolvedValue(listOf([]));
    let finish!: () => void;
    const upload = vi.fn(
      (_ws: string, _t: unknown, _f: File, _s: unknown, on: (p: UploadPhase) => void) =>
        new Promise<never>((resolve, reject) => {
          on({ phase: 'uploading', pct: 40 });
          finish = () =>
            reject(new ApiError({ code: 'usage_limit_reached', status: 403, message: 'x' }));
          void resolve;
        }),
    );
    wrap(<FilesPanel ws={WS} host="tsk_1" upload={upload as unknown as typeof uploadFile} />);
    const input = await screen.findByLabelText('Upload a file');
    fireEvent.change(input, { target: { files: [new File(['x'], 'big.txt')] } });
    expect(await screen.findByText('Uploading 40%')).toBeTruthy();
    await act(async () => finish());
    expect(await screen.findByText('Failed')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(
      /Over quota: this workspace has used 1\.0 MB of 2\.0 MB/,
    );
    expect(screen.getByRole('button', { name: /Try again\s*uploading big\.txt/ })).toBeTruthy();
  });

  it('preview dialog: text shown in a pre; Escape closes and focus returns', async () => {
    vi.spyOn(files, 'storage').mockResolvedValue(storage());
    vi.spyOn(files, 'list').mockResolvedValue(listOf([file('file_1')]));
    vi.spyOn(files, 'preview').mockResolvedValue({
      kind: 'object',
      url: '/v1/storage/local/o.1?sig=x',
      expires_at: null,
      disposition: 'inline',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('line one\nline two'));
    wrap(<FilesPanel ws={WS} host="tsk_1" />);
    const open = await screen.findByRole('button', { name: /Preview\s*notes\.txt/ });
    open.focus();
    fireEvent.click(open);
    const dialog = await screen.findByRole('dialog', { name: 'Preview: notes.txt' });
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Preview of notes.txt').textContent).toContain(
        'line two',
      ),
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(open);
  });
});

describe('comparison (4E)', () => {
  const cmp = (extra: Partial<Comparison> = {}): Comparison => ({
    from: version(),
    to: version({ number: 2, byte_size: 30 }),
    same_content: false,
    size_change: 12,
    mode: 'lines',
    reason: null,
    lines: [
      { op: 'same', text: 'line one' },
      { op: 'remove', text: 'line two' },
      { op: 'add', text: 'line two changed' },
    ],
    ...extra,
  });

  it('labels each changed line with text and a sign, not colour alone', () => {
    render(<ComparisonView c={cmp()} />);
    const region = screen.getByRole('region', { name: 'Comparison' });
    expect(region.textContent).toContain('1 line added, 1 removed.');
    expect(region.textContent).toContain('Removed: line two');
    expect(region.textContent).toContain('Added: line two changed');
    expect(region.textContent).toContain('+');
    expect(region.textContent).toContain('−');
  });

  it('falls back to a metadata comparison', () => {
    render(<ComparisonView c={cmp({ mode: 'metadata', reason: 'format', lines: null })} />);
    expect(screen.getByText(/this type has no line comparison/)).toBeTruthy();
  });

  it('the versions dialog compares the chosen pair', async () => {
    const f = file('file_1', {}, { versions: [version(), version({ number: 2 })] });
    const compare = vi.fn().mockResolvedValue(cmp());
    wrap(<VersionsDialog ws={WS} file={f} onClose={() => undefined} compare={compare} />);
    expect((screen.getByLabelText('From') as HTMLSelectElement).value).toBe('1');
    expect((screen.getByLabelText('To') as HTMLSelectElement).value).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    await screen.findByRole('region', { name: 'Comparison' });
    expect(compare).toHaveBeenCalledWith(WS, 'file_1', 1, 2);
  });
});

describe('DeliverablesPanel (4E)', () => {
  it('shows states as text and the acceptance record with its lock', async () => {
    vi.spyOn(files, 'deliverables').mockResolvedValue({
      counts: { accepted: 1, pending: 0, changes_requested: 0, rejected: 0, draft: 1 },
      data: [
        {
          id: 'dlv_1',
          type: 'deliverable',
          title: 'Launch copy',
          expected_type: 'file',
          state: 'accepted',
          task: { id: 'tsk_1', title: 'Copy' },
          created_by: null,
          versions: [
            {
              number: 1,
              source: 'file',
              url: null,
              file: { id: 'file_1', version: 1, name: 'notes.txt' },
              note: null,
              state: 'accepted',
              review: null,
              accepted_by: { id: 'mem_2', name: 'Milo' },
              accepted_at: '2026-10-06T09:00:00.000Z',
              evidence_locked: true,
              submitted_by: { id: 'mem_1', name: 'Fay' },
              created_at: '2026-10-05T09:00:00.000Z',
            },
          ],
          can: { submit: false, review: true },
          created_at: '',
          updated_at: '',
          version: 3,
        },
        {
          id: 'dlv_2',
          type: 'deliverable',
          title: 'Hero image',
          expected_type: 'any',
          state: 'draft',
          task: { id: 'tsk_1', title: 'Copy' },
          created_by: null,
          versions: [],
          can: { submit: true, review: true },
          created_at: '',
          updated_at: '',
          version: 1,
        },
      ],
    });
    wrap(<DeliverablesPanel ws={WS} tsk="tsk_1" canCreate />);
    expect(await screen.findByText('Accepted')).toBeTruthy();
    expect(screen.getByText(/Accepted by Milo on/).textContent).toContain('Version 1 is locked.');
    expect(screen.getByText('Draft')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Submit for review…\s*Hero image/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Launch copy/ })).toBeNull();
    expect(screen.getByLabelText('Deliverable title')).toBeTruthy();
  });
});
