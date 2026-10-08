import { expect, test, type Browser, type Page, type Route } from '@playwright/test';
import {
  createBrand,
  createWorkspace,
  expectAccessible,
  linkPath,
  noHorizontalOverflow,
  openLink,
  owner,
  register,
  signedIn,
  uniqueEmail,
  verify,
  waitForMail,
} from './support.ts';

/**
 * Phase 4E on desktop, tablet, and mobile (ADR-0026): upload a text file (keyboard only) and watch
 * it go Uploading → Scanning → Ready, preview it, download it, upload a new version, compare the
 * two, add an external link, and mark a deliverable; an infected upload is Blocked (malware) with
 * no download; a tampered or expired signed URL is refused. Every state passes axe; the task page
 * reflows at 320–1024 px and 200% zoom, with forced colours and reduced motion. On desktop a second
 * person reviews a submitted deliverable through the 4A review card (Accepted by … and locked), and
 * loses the files with their access.
 */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const row = (page: Page, name: string) =>
  card(page, 'Files')
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });

/** The EICAR test string, assembled so this source is not itself flagged. */
const EICAR = [
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$',
  'EICAR-STANDARD-ANTIVIRUS-TEST-FILE',
  '!$H+H*',
].join('');

async function api(page: Page, method: 'POST' | 'PATCH', path: string, data: unknown) {
  const origin = new URL(page.url()).origin;
  const me = await page.request.get('/v1/auth/me');
  const r = await page.request.fetch(path, {
    method,
    headers: {
      origin,
      'x-csrf-token': me.headers()['x-csrf-token'] ?? '',
      'idempotency-key': `e2e-${crypto.randomUUID()}`,
    },
    data,
  });
  expect(r.status(), await r.text()).toBeLessThan(300);
  return (await r.json()).data;
}

/** Holds matching requests until released (to see an in-between state without waiting on time). */
async function hold(page: Page, match: (url: URL) => boolean) {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const held: Array<Promise<void>> = [];
  const handler = (route: Route) => {
    const done = gate.then(() => route.continue());
    held.push(done);
    return done;
  };
  await page.route(match, handler);
  return async () => {
    open();
    await Promise.all(held);
    await page.unroute(match, handler);
  };
}

async function setup(page: Page, info: Parameters<typeof owner>[1], prefix: string) {
  await owner(page, info, prefix, 'Fay Founder');
  const ws = await createWorkspace(page, 'File Co');
  await createBrand(page, 'Harbor');
  const base = `/v1/workspaces/${ws}`;
  const brands = (await (await page.request.get(`${base}/brands`)).json()).data as Array<{
    id: string;
    name: string;
  }>;
  const harbor = brands.find((b) => b.name === 'Harbor')!.id;
  const prj = await api(page, 'POST', `${base}/projects`, { brand: harbor, name: 'Launch' });
  const task = await api(page, 'POST', `${base}/tasks`, {
    project: prj.id,
    title: 'Write launch copy',
  });
  return { ws, base, prj: prj.id as string, tsk: task.id as string };
}

const text = (name: string, body: string) => ({
  name,
  mimeType: 'text/plain',
  buffer: Buffer.from(body),
});

/** Uploads notes.txt by keyboard and waits until it is Ready. */
async function uploadNotes(page: Page) {
  const files = card(page, 'Files');
  await expect(files.getByLabel('Upload a file')).toBeVisible();
  const releasePut = await hold(page, (u) => u.pathname.startsWith('/v1/storage/local/'));
  const releaseList = await hold(
    page,
    (u) => u.pathname.endsWith('/files') && u.searchParams.has('host'),
  );
  const input = files.getByLabel('Upload a file');
  await input.focus();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Space');
  await (await chooser).setFiles(text('notes.txt', 'line one\nline two\n'));
  const progress = files.getByRole('list', { name: 'Uploads in progress' });
  await expect(progress).toContainText(/notes\.txt\s*Uploading \d+%/);
  await releasePut();
  await expect(progress).toContainText(/notes\.txt\s*Scanning/);
  await releaseList();
  await expect(row(page, 'notes.txt').getByText('Ready', { exact: true })).toBeVisible();
  await expect(progress).toHaveCount(0);
}

test('upload, scan, preview, download, version, compare, link, deliverable, and blocked files', async ({
  page,
}, info) => {
  const { ws, prj, tsk } = await setup(page, info, 'files');
  await page.goto(`/workspaces/${ws}/tasks/${tsk}`);
  await expect(h1(page)).toHaveText('Write launch copy');
  const files = card(page, 'Files');
  await expect(files.getByText('No files on this task yet.', { exact: false })).toBeVisible();
  await expectAccessible(page, 'task files, empty');

  await uploadNotes(page);
  const notes = row(page, 'notes.txt');
  await expect(notes).toContainText('TXT');
  await expect(notes).toContainText('1 version');
  await expectAccessible(page, 'task files, ready');

  // Preview by keyboard; Escape closes and focus returns to the opener.
  const previewBtn = notes.getByRole('button', { name: 'Preview notes.txt' });
  await previewBtn.focus();
  await page.keyboard.press('Enter');
  const preview = page.getByRole('dialog', { name: 'Preview: notes.txt' });
  await expect(preview.getByLabel('Preview of notes.txt')).toContainText('line two');
  await expectAccessible(page, 'preview dialog');
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(previewBtn).toBeFocused();

  // Download: the browser receives the file under its own name.
  const download = page.waitForEvent('download');
  await notes.getByRole('link', { name: 'Download notes.txt' }).click();
  expect((await download).suggestedFilename()).toBe('notes.txt');

  // A new version, then compare the two (keyboard only).
  await notes.getByRole('button', { name: 'Upload new version notes.txt' }).click();
  const nv = page.getByRole('dialog', { name: 'New version of notes.txt' });
  await nv
    .getByLabel('File for the new version')
    .setInputFiles(text('notes.txt', 'line one\nline two changed\nline three\n'));
  await expectAccessible(page, 'new version dialog');
  await nv.getByRole('button', { name: 'Upload version' }).click();
  await expect(notes).toContainText('2 versions');
  await expect(notes.getByText('Ready', { exact: true })).toBeVisible();
  const versionsBtn = notes.getByRole('button', { name: 'Versions notes.txt' });
  await versionsBtn.focus();
  await page.keyboard.press('Enter');
  const versions = page.getByRole('dialog', { name: 'Versions of notes.txt' });
  await expect(versions.getByRole('list', { name: 'Versions' }).getByRole('listitem')).toHaveCount(
    2,
  );
  await versions.getByLabel('From').focus();
  await page.keyboard.press('Tab');
  await expect(versions.getByLabel('To')).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  const comparison = versions.getByRole('region', { name: 'Comparison' });
  await expect(comparison).toContainText('Version 1 → version 2');
  await expect(comparison).toContainText('Added: line three');
  await expect(comparison).toContainText('Removed: line two');
  await expectAccessible(page, 'compare dialog');
  await page.keyboard.press('Escape');
  await expect(versionsBtn).toBeFocused();

  // An external link.
  await files.getByRole('button', { name: 'Add external link…' }).click();
  const link = page.getByRole('dialog', { name: 'Add an external link' });
  await link.getByLabel('Link').fill('https://example.com/brief');
  await link.getByLabel('Name (optional)').fill('Brief');
  await expectAccessible(page, 'add link dialog');
  await link.getByRole('button', { name: 'Add link' }).click();
  await expect(row(page, 'Brief').getByText('Link', { exact: true })).toBeVisible();
  await expect(row(page, 'Brief').getByRole('link', { name: /Open link Brief/ })).toBeVisible();

  // An infected upload is blocked, with no download or preview.
  await files.getByLabel('Upload a file').setInputFiles(text('eicar.txt', EICAR));
  const bad = row(page, 'eicar.txt');
  await expect(bad.getByText('Blocked (malware)', { exact: true })).toBeVisible();
  await expect(bad.getByRole('link', { name: /Download/ })).toHaveCount(0);
  await expect(bad.getByRole('button', { name: /Preview/ })).toHaveCount(0);
  await expectAccessible(page, 'task files, blocked');

  // A signed download URL is refused once tampered with or past its expiry.
  const fileId = await page.evaluate(
    async (w) => {
      const r = await fetch(`/v1/workspaces/${w.ws}/files?host=${w.tsk}`);
      const body = (await r.json()) as { data: Array<{ id: string; name: string }> };
      return body.data.find((f) => f.name === 'notes.txt')!.id;
    },
    { ws, tsk },
  );
  const redirect = await page.request.get(`/v1/workspaces/${ws}/files/${fileId}:download`, {
    maxRedirects: 0,
  });
  expect(redirect.status()).toBe(303);
  const signed = new URL(redirect.headers()['location']!);
  expect((await page.request.get(signed.toString())).status()).toBe(200);
  const tampered = new URL(signed);
  tampered.searchParams.set('sig', `${signed.searchParams.get('sig')!.slice(0, -2)}AA`);
  expect([403, 404]).toContain((await page.request.get(tampered.toString())).status());
  const expired = new URL(signed);
  expired.searchParams.set('exp', String(Math.floor(Date.now() / 1000) - 60));
  expect([403, 404]).toContain((await page.request.get(expired.toString())).status());

  // A deliverable expecting a file.
  const dlv = card(page, 'Deliverables');
  await dlv.getByLabel('Deliverable title').fill('Launch copy');
  await dlv.getByLabel('Expected').selectOption({ label: 'A file' });
  await dlv.getByRole('button', { name: 'Add deliverable' }).click();
  const item = dlv.getByRole('listitem').filter({ hasText: 'Launch copy' });
  await expect(item.getByText('Draft', { exact: true })).toBeVisible();
  await item.getByRole('button', { name: 'Submit for review… Launch copy' }).click();
  const submit = page.getByRole('dialog', { name: 'Submit Launch copy for review' });
  await expect(submit.getByLabel('File')).toHaveValue(fileId);
  await expect(submit.getByLabel('File').getByRole('option')).toHaveText(['notes.txt']);
  await expectAccessible(page, 'submit deliverable dialog');
  await page.keyboard.press('Escape');

  // Project: Files tab and the accepted-versus-pending summary.
  await page.goto(`/workspaces/${ws}/projects/${prj}/files`);
  await expect(page.getByRole('heading', { name: 'Files', level: 2 })).toBeVisible();
  await expect(card(page, 'Deliverables')).toContainText('0 accepted · 0 pending review');
  await expect(card(page, 'Deliverables')).toContainText('Launch copy');
  await expect(card(page, 'Files').getByLabel('Upload a file')).toBeVisible();
  await expectAccessible(page, 'project files');

  // Workspace settings show storage usage.
  await page.goto(`/workspaces/${ws}/settings`);
  await expect(card(page, 'File storage')).toContainText(/ of 10\.0 GB used/);

  // Appearance and reflow on the task page.
  await page.goto(`/workspaces/${ws}/tasks/${tsk}`);
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.reload();
  await expect(row(page, 'notes.txt')).toBeVisible();
  await expectAccessible(page, 'task files, forced colours');
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });
  const size = page.viewportSize()!;
  for (const width of [320, 599, 600, 1023, 1024, Math.max(320, Math.floor(size.width / 2))]) {
    await page.setViewportSize({ width, height: size.height });
    await page.goto(`/workspaces/${ws}/tasks/${tsk}`);
    await expect(row(page, 'notes.txt')).toBeVisible();
    await expect(page.getByText(/^Loading/)).toHaveCount(0);
    expect(await noHorizontalOverflow(page), `task files at ${width}px`).toBeLessThanOrEqual(0);
  }
});

async function member(
  browser: Browser,
  founder: Page,
  ws: string,
  info: Parameters<typeof owner>[1],
) {
  const email = uniqueEmail('files-milo', info);
  await founder.goto(`/workspaces/${ws}/people/invite`);
  await founder.getByLabel(/^Email/).fill(email);
  await founder.getByLabel('Role').selectOption({ label: 'Member' });
  await founder.getByRole('button', { name: 'Send invitation' }).click();
  await expect(h1(founder)).toHaveText('People');
  const ctx = await browser.newContext();
  const mp = await ctx.newPage();
  await openLink(mp, linkPath(await waitForMail(email, 'invited')));
  await register(mp, email, 'Milo Member');
  await verify(mp, email);
  await signedIn(mp, email);
  await mp.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(mp.getByRole('navigation', { name: 'Primary' }).first()).toBeVisible();
  await founder.goto(`/workspaces/${ws}`);
  await founder.getByRole('link', { name: 'Settings for Harbor' }).click();
  const access = founder.getByRole('region', { name: 'Who has access' });
  await access.getByLabel('Give access to').selectOption({ label: 'Milo Member' });
  await access.getByLabel('Access level').selectOption('edit');
  await access.getByRole('button', { name: 'Review access…' }).click();
  await founder
    .getByRole('dialog', { name: 'Give brand access?' })
    .getByRole('button', { name: 'Give access' })
    .click();
  await expect(founder.getByText('Access given.')).toBeAttached();
  return { ctx, mp, access };
}

test('a second person accepts a deliverable through review, then loses the files with access @desktop-only', async ({
  page,
  browser,
}, info) => {
  const { ws, tsk, prj } = await setup(page, info, 'files-rv');
  const { ctx, mp, access } = await member(browser, page, ws, info);

  await page.goto(`/workspaces/${ws}/tasks/${tsk}`);
  await uploadNotes(page);
  const dlv = card(page, 'Deliverables');
  await dlv.getByLabel('Deliverable title').fill('Launch copy');
  await dlv.getByRole('button', { name: 'Add deliverable' }).click();
  const item = dlv.getByRole('listitem').filter({ hasText: 'Launch copy' });
  await item.getByRole('button', { name: 'Submit for review… Launch copy' }).click();
  const submit = page.getByRole('dialog', { name: 'Submit Launch copy for review' });
  await expect(submit.getByLabel('File')).toBeVisible();
  await submit.getByLabel('Note (optional)').fill('First draft.');
  await submit.getByLabel('Search people').fill('Milo');
  await submit.getByLabel('Milo Member').check();
  await submit.getByRole('button', { name: 'Submit for review' }).click();
  await expect(submit).toHaveCount(0);
  await expect(item.getByText('Ready for review', { exact: true })).toBeVisible();
  await expect(item).toContainText('Version 1: notes.txt');
  await expect(item).toContainText('submitted by Fay Founder');
  await expect(item.getByText('Waiting for review')).toBeVisible();
  await expectAccessible(page, 'deliverable submitted');

  // Milo decides through the 4A review card.
  await mp.goto(`/workspaces/${ws}/tasks/${tsk}`);
  const mitem = card(mp, 'Deliverables').getByRole('listitem').filter({ hasText: 'Launch copy' });
  await mitem.getByRole('button', { name: 'Decide…' }).click();
  const decide = mp.getByRole('dialog', { name: 'Decide on this approval' });
  await decide.getByLabel(/^Approve/).check();
  await decide.getByRole('button', { name: 'Send decision' }).click();
  await expect(mitem.getByText('Accepted', { exact: true })).toBeVisible();
  await expect(mitem).toContainText('Accepted by Milo Member on');
  await expect(mitem).toContainText('Version 1 is locked.');
  await expect(mitem.getByRole('button', { name: /Submit/ })).toHaveCount(0);
  await expectAccessible(mp, 'deliverable accepted');

  await page.goto(`/workspaces/${ws}/projects/${prj}/files`);
  await expect(card(page, 'Deliverables')).toContainText('1 accepted · 0 pending review');

  // Milo loses Harbor: the files are gone and the old file URL is not found.
  const fileId = await mp.evaluate(
    async (w) => {
      const r = await fetch(`/v1/workspaces/${w.ws}/files?host=${w.tsk}`);
      return ((await r.json()) as { data: Array<{ id: string }> }).data[0]!.id;
    },
    { ws, tsk },
  );
  await page.goto(`/workspaces/${ws}`);
  await page.getByRole('link', { name: 'Settings for Harbor' }).click();
  await access.getByRole('button', { name: 'Remove access for Milo Member' }).click();
  await page
    .getByRole('alertdialog', { name: 'Remove brand access?' })
    .getByRole('button', { name: 'Remove access' })
    .click();
  await expect(page.getByText('Access removed.')).toBeAttached();
  await mp.reload();
  await expect(card(mp, 'Files')).toHaveCount(0);
  await expect(mp.getByRole('main')).not.toContainText('notes.txt');
  const gone = await mp.request.get(`/v1/workspaces/${ws}/files/${fileId}:download`, {
    maxRedirects: 0,
  });
  expect(gone.status()).toBe(404);
  expect((await mp.request.get(`/v1/workspaces/${ws}/files/${fileId}`)).status()).toBe(404);
  await expectAccessible(mp, 'files after revocation');
  await ctx.close();
});
