import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  createBrand,
  createWorkspace,
  expectAccessible as axe,
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
 * Phase 4C on desktop, tablet, and mobile (ADR-0025): a founder and a second member create a brand
 * page from its starter, write with every kind of block, mention a teammate and a task, save, see
 * the version, and hit a newer-version conflict that they settle block by block; restore an
 * earlier version; take a suggestion from a commenter; comment and ask for a review; set state,
 * owner and a past review date; link a record and find the backlink on the task; export Markdown
 * and HTML; archive and trash. A task the second member cannot see is a neutral "Restricted item"
 * for them, in the page and in the export. A read-only member and a share-only guest see only what
 * they may. Every stage passes axe; the pages reflow at 320 px and 200% zoom, with forced colours
 * and reduced motion; one pass uses the keyboard alone; and a draft written offline is kept and
 * saved when the connection returns.
 */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const saveState = (page: Page) => page.locator('#doc-save-state');

async function api(
  page: Page,
  method: 'POST' | 'PATCH' | 'PUT',
  path: string,
  data: unknown,
  ifMatch?: number,
) {
  const origin = new URL(page.url()).origin;
  const me = await page.request.get('/v1/auth/me');
  const r = await page.request.fetch(path, {
    method,
    headers: {
      origin,
      'x-csrf-token': me.headers()['x-csrf-token'] ?? '',
      'idempotency-key': `e2e-${crypto.randomUUID()}`,
      ...(ifMatch !== undefined ? { 'if-match': `"${ifMatch}"` } : {}),
    },
    data,
  });
  expect(r.status(), await r.text()).toBeLessThan(300);
  return (await r.json()).data;
}

async function inviteMember(page: Page, ws: string, email: string, role: string): Promise<void> {
  await page.goto(`/workspaces/${ws}/people/invite`);
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel('Role').selectOption({ label: role });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(h1(page)).toHaveText('People');
}

async function accept(page: Page, email: string, name: string): Promise<void> {
  await openLink(page, linkPath(await waitForMail(email, 'invited')));
  await register(page, email, name);
  await verify(page, email);
  await signedIn(page, email);
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByRole('navigation', { name: 'Primary' }).first()).toBeVisible();
}

async function giveBrand(page: Page, ws: string, brand: string, person: string, level: string) {
  await page.goto(`/workspaces/${ws}`);
  await page.getByRole('link', { name: `Settings for ${brand}` }).click();
  const access = page.getByRole('region', { name: 'Who has access' });
  await access.getByLabel('Give access to').selectOption({ label: person });
  await access.getByLabel('Access level').selectOption(level);
  await access.getByRole('button', { name: 'Review access…' }).click();
  await page
    .getByRole('dialog', { name: 'Give brand access?' })
    .getByRole('button', { name: 'Give access' })
    .click();
  await expect(page.getByText('Access given.')).toBeAttached();
}

async function person(
  browser: Browser,
  founder: Page,
  ws: string,
  info: Parameters<typeof uniqueEmail>[1],
  prefix: string,
  name: string,
  role: string,
): Promise<{ ctx: BrowserContext; page: Page; email: string }> {
  const email = uniqueEmail(prefix, info);
  await inviteMember(founder, ws, email, role);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await accept(page, email, name);
  return { ctx, page, email };
}

/** A founder with a workspace, the brands Harbor (shared) and Vault (private), and a task in each. */
async function setup(page: Page, info: Parameters<typeof uniqueEmail>[1], prefix: string) {
  await owner(page, info, prefix, 'Fay Founder');
  const ws = await createWorkspace(page, 'Docs Co');
  await createBrand(page, 'Harbor');
  const base = `/v1/workspaces/${ws}`;
  const brands = async () =>
    (await (await page.request.get(`${base}/brands`)).json()).data as Array<{
      id: string;
      name: string;
    }>;
  const harbor = (await brands()).find((b) => b.name === 'Harbor')!.id;
  const task = await api(page, 'POST', `${base}/tasks`, {
    brand: harbor,
    title: 'Write launch copy',
  });
  return { ws, base, harbor, task: task as { id: string }, brands };
}

/** A second brand with a task that only the founder can see. */
async function vault(
  page: Page,
  ws: string,
  base: string,
  brands: () => Promise<Array<{ id: string; name: string }>>,
) {
  await page.goto(`/workspaces/${ws}/brands/new`);
  await createBrand(page, 'Vault', 'Leaf');
  const id = (await brands()).find((b) => b.name === 'Vault')!.id;
  return (await api(page, 'POST', `${base}/tasks`, { brand: id, title: 'Secret roadmap' })) as {
    id: string;
  };
}

/**
 * axe on the page's own content. The sticky header and the Compact bottom bar are shell chrome
 * that other journeys check; hidden here so a long editor scrolled under them is not reported as
 * "partially obscured" at whatever position the page happens to be scrolled to.
 */
async function accessible(page: Page, label: string) {
  const chrome = (hidden: boolean) =>
    page.evaluate(
      `for (const el of document.querySelectorAll('.bottom-nav, .app-header')) el.style.visibility = '${hidden ? 'hidden' : ''}'`,
    );
  await chrome(true);
  try {
    await axe(page, label);
  } finally {
    await chrome(false);
  }
}

/** No sideways scroll; if there is some, the failure names the elements that stick out. */
async function expectNoOverflow(page: Page, label: string) {
  const over = await noHorizontalOverflow(page);
  if (over <= 0) return;
  const offenders = await page.evaluate<string[]>(`(() => {
    const w = document.documentElement.clientWidth;
    const clipped = (e) => {
      for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o === 'auto' || o === 'scroll' || o === 'hidden') return true;
      }
      return false;
    };
    return [...document.querySelectorAll('body *')]
      .filter((e) => e.getBoundingClientRect().right > w + 1 && !clipped(e))
      .slice(0, 6)
      .map((e) => e.tagName.toLowerCase() + '.' + e.className + ' right=' + Math.round(e.getBoundingClientRect().right) + ' of ' + w);
  })()`);
  expect(offenders, `${label}: ${over}px of sideways scroll`).toEqual([]);
  expect(over, `${label}: sideways scroll with no visible offender`).toBeLessThanOrEqual(0);
}

/**
 * The 4C journeys below cover the plain editor (a saved version, a newer-version conflict, a draft
 * kept on this device). Live editing (4D, ADR-0027) is the default for people who can edit, so
 * these contexts answer the join as the server does when live editing is off (`live_disabled`):
 * the editor falls back to exactly the 4C flow (C10). live-editing.spec.ts covers the live path.
 */
async function withoutLive(ctx: BrowserContext): Promise<void> {
  await ctx.route(/\/documents\/[^/]+\/live\/session$/, (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'conflict',
          message: 'Live editing is not available.',
          issues: [{ pointer: '/', code: 'live_disabled', message: 'Live editing is off.' }],
        },
      }),
    }),
  );
}

const knowledge = (ws: string) => `/workspaces/${ws}/knowledge`;
const docId = (page: Page) => /\/documents\/(doc_[0-9A-Z]{26})/.exec(page.url())![1]!;

async function createPage(
  page: Page,
  ws: string,
  title: string,
  type: string,
  where?: string,
): Promise<string> {
  await page.goto(knowledge(ws));
  await expect(page.getByRole('tree').first())
    .toBeVisible()
    .catch(() => undefined);
  await page.getByRole('button', { name: 'New page' }).click();
  const dialog = page.getByRole('dialog', { name: 'New page' });
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  await dialog.getByLabel('Type', { exact: true }).selectOption({ label: type });
  if (where) await dialog.getByLabel('Belongs to').selectOption({ label: where });
  await dialog.getByRole('button', { name: 'Create page' }).click();
  await expect(h1(page)).toHaveText(title);
  await expect(region(page, 'Content')).toBeVisible();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
  return docId(page);
}

async function openDoc(page: Page, ws: string, id: string, title: string) {
  await page.goto(`/workspaces/${ws}/documents/${id}`);
  await expect(h1(page)).toHaveText(title);
  await expect(region(page, 'Content')).toBeVisible();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
}

async function addBlock(page: Page, kind: string) {
  await page.getByRole('button', { name: 'Add block', exact: true }).click();
  await page.getByRole('menuitem', { name: kind, exact: true }).click();
}

/** Types into the focused text box and picks the first suggestion of an @ mention. */
async function mention(
  page: Page,
  box: ReturnType<Page['getByLabel']>,
  query: string,
  option: RegExp,
) {
  await box.pressSequentially(`@${query}`);
  const list = page.getByRole('listbox', { name: 'Suggested mentions' });
  await expect(list.getByRole('option', { name: option })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await list.getByRole('option', { name: option }).click();
}

async function save(page: Page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(saveState(page)).toContainText('Saved');
}

const allText = (page: Page) =>
  page.evaluate<string>(
    `[...document.querySelectorAll('textarea, input')].map((e) => e.value).join('\\n')`,
  );

test('write with every block, conflict, restore, suggest, review, link, export, archive, and trash', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(420_000);
  await withoutLive(page.context());
  const { ws, base, task, brands } = await setup(page, info, 'docs');
  const secret = await vault(page, ws, base, brands);
  const milo = await person(browser, page, ws, info, 'docs-milo', 'Milo Member', 'Member');
  await withoutLive(milo.ctx);
  await giveBrand(page, ws, 'Harbor', 'Milo Member', 'edit');
  const rae = await person(browser, page, ws, info, 'docs-rae', 'Rae Commenter', 'Member');
  // A reader's live view holds a session too, and any live session makes the plain accept of a
  // suggestion answer `live_edit_in_progress` (see the 4D report): this journey is the plain path.
  await withoutLive(rae.ctx);
  await giveBrand(page, ws, 'Harbor', 'Rae Commenter', 'comment');
  const mp = milo.page;
  const rp = rae.page;

  // ---- Create a brand page from its starter -----------------------------------------------
  await page.goto(knowledge(ws));
  await expect(page.getByRole('heading', { name: 'Knowledge', level: 1 })).toBeVisible();
  await expect(page.getByText('No workspace-level pages yet.')).toBeVisible();
  await accessible(page, 'Knowledge, empty');
  const id = await createPage(page, ws, 'Launch brief', 'Brand brief', 'Harbor');
  await expect(page.getByText('Started from template')).toBeVisible();
  await accessible(page, 'a new page from its starter');

  // ---- Write with every block kind ---------------------------------------------------------
  // The starter has headings and lists of its own; the blocks written here come after them.
  const starter = {
    headings: await page.getByLabel('Heading text').count(),
    bullets: await page.getByLabel('Bulleted list: one item per line').count(),
  };
  const heading = (p: Page) => p.getByLabel('Heading text').nth(starter.headings);
  const bullets = (p: Page) =>
    p.getByLabel('Bulleted list: one item per line').nth(starter.bullets);
  await addBlock(page, 'Heading');
  await heading(page).fill('Launch goals');
  await addBlock(page, 'Paragraph');
  const intro = page.getByLabel('Paragraph text').last();
  await intro.fill('We ship **fast** with ');
  await mention(page, intro, 'Milo', /Milo Member/);
  await page.keyboard.type('and track ');
  await mention(page, intro, 'Write', /Write launch copy/);
  await page.keyboard.type('and keep ');
  await mention(page, intro, 'Secret', /Secret roadmap/);
  await expect(intro).toHaveValue(/\[@Milo Member\]\(ref:member:mem_[0-9A-Z]{26}\)/);
  await accessible(page, 'editor with a paragraph and mentions');
  await addBlock(page, 'Bulleted list');
  await bullets(page).fill('Draft copy\nReview copy');
  await addBlock(page, 'Numbered list');
  await page.getByLabel('Numbered list: one item per line').last().fill('First\nSecond');
  await addBlock(page, 'Checklist');
  await page.getByLabel('Item 1 text').last().fill('Book the venue');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Send the invites');
  await page.getByLabel('Item 1 done').last().check();
  await addBlock(page, 'Quote');
  await page.getByLabel('Quote text').last().fill('Ship early, learn early.');
  await addBlock(page, 'Callout');
  await page.getByLabel('Callout style').last().selectOption('warning');
  await page.getByLabel('Callout text').last().fill('Freeze copy on Friday.');
  await addBlock(page, 'Code');
  await page.getByLabel('Language (optional)').last().fill('ts');
  await page.getByLabel('Code', { exact: true }).last().fill('const launch = true;');
  await addBlock(page, 'Table');
  await page.getByLabel('Header, column 1').last().fill('Task');
  await page.getByLabel('Header, column 2').last().fill('Owner');
  await page.getByLabel('Row 2, column 1').last().fill('Copy');
  await page.getByLabel('Row 2, column 2').last().fill('Fay');
  await addBlock(page, 'Divider');
  await addBlock(page, 'Link card (image, video, or link)');
  await page.getByLabel('Address (https://…)').last().fill('https://example.com/brief');
  await page.getByLabel('Title (optional)').last().fill('Reference brief');
  await accessible(page, 'editor with every kind of block');
  await save(page);
  await expect(
    region(page, 'Version history').getByText('Version 2', { exact: true }),
  ).toBeVisible();
  await expect(region(page, 'Version history').getByText('Current', { exact: true })).toBeVisible();
  await expect(
    region(page, 'Version history')
      .getByText(/\+\d+ added/)
      .first(),
  ).toBeVisible();
  await accessible(page, 'saved page with its history');

  // ---- The second member sees the hidden task as a neutral token ---------------------------
  await expect
    .poll(async () => (await mp.request.get(`${base}/documents/${id}`)).status())
    .toBe(200);
  await openDoc(mp, ws, id, 'Launch brief');
  await expect.poll(() => allText(mp)).toContain('[Restricted item](ref:restricted:rst_');
  expect(await allText(mp)).not.toContain('Secret roadmap');
  expect(await allText(mp)).toContain('Write launch copy');
  expect(await mp.content()).not.toContain('Secret roadmap');
  await accessible(mp, 'second member editing with a restricted reference');

  // ---- A newer version: settled block by block ---------------------------------------------
  await bullets(mp).fill('Draft copy\nReview copy\nMilo adds this');
  await save(mp);
  await heading(page).fill('Launch goals v2');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Someone saved a newer version', { exact: true })).toBeVisible();
  await expect(saveState(page)).toContainText("Couldn't save: someone saved a newer version.");
  await expect(heading(page)).toHaveValue('Launch goals v2');
  await accessible(page, 'a newer version exists');
  await page.getByRole('button', { name: 'Review my changes' }).click();
  const review = page.getByRole('region', { name: 'Review my changes' });
  await expect(review).toBeVisible();
  await expect(review.getByText('Only you changed this.')).toBeVisible();
  await expect(review.getByText('Only someone else changed this.')).toBeVisible();
  await accessible(page, 'review my changes');
  await review.getByRole('button', { name: 'Use these choices' }).click();
  await expect(heading(page)).toHaveValue('Launch goals v2');
  await expect(bullets(page)).toHaveValue(/Milo adds this/);
  await save(page);
  await expect(
    region(page, 'Version history').getByText('Version 4', { exact: true }),
  ).toBeVisible();

  // ---- Restore an earlier version: a new version, nothing deleted --------------------------
  const history = region(page, 'Version history');
  await history.getByRole('button', { name: 'View version 2' }).click();
  await expect(history.getByText('This adds a new version; nothing is deleted.')).toBeVisible();
  await accessible(page, 'an earlier version, read-only');
  await history.getByRole('button', { name: 'Restore this version' }).click();
  await expect(history.getByText('Restored from 2')).toBeVisible();
  await expect(history.getByText('Version 5', { exact: true })).toBeVisible();
  await expect(heading(page)).toHaveValue('Launch goals');

  // ---- A commenter suggests a change; the owner accepts it --------------------------------
  await expect
    .poll(async () => (await rp.request.get(`${base}/documents/${id}`)).status())
    .toBe(200);
  await openDoc(rp, ws, id, 'Launch brief');
  await expect(rp.getByText(/You can read this document and suggest changes/)).toBeVisible();
  await expect(rp.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await accessible(rp, 'commenter reading the page');
  await rp
    .locator('.doc-view-block')
    .filter({ hasText: 'Launch goals' })
    .getByRole('button', { name: /Suggest a change/ })
    .click();
  const sugg = rp.getByRole('dialog', { name: 'Suggest a change' });
  await sugg.getByLabel('Heading text').fill('Launch goals, sharper');
  await sugg.getByLabel('Note (optional)').fill('Shorter reads better.');
  await accessible(rp, 'suggest a change dialog');
  await sugg.getByRole('button', { name: 'Send suggestion' }).click();
  await expect(rp.getByRole('dialog')).toHaveCount(0);
  await expect(region(rp, 'Suggestions').getByText('Launch goals, sharper')).toBeVisible();
  await page.reload();
  await expect(region(page, 'Content')).toBeVisible();
  const suggestions = region(page, 'Suggestions');
  await expect(suggestions.getByText('Shorter reads better.')).toBeVisible();
  await expect(suggestions.getByText('Rae Commenter', { exact: true })).toBeVisible();
  await suggestions.getByRole('button', { name: /^Accept/ }).click();
  await expect(heading(page)).toHaveValue('Launch goals, sharper');
  await expect(region(page, 'Version history').getByText('Suggestion accepted')).toBeVisible();
  await expect(page.getByText('Version 6', { exact: true })).toBeVisible();

  // ---- Comment and ask for a review --------------------------------------------------------
  const comments = region(page, 'Comments');
  await expect(
    comments.getByText(
      'Comments are on the whole document. Comments on a specific passage arrive with live editing (4D).',
    ),
  ).toBeVisible();
  await comments.getByLabel('Add a comment', { exact: true }).fill('Ready for a look.');
  await comments.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect(comments.getByText('Ready for a look.')).toBeVisible();
  await page.getByRole('button', { name: 'Request review…' }).click();
  const ask = page.getByRole('dialog', { name: 'Request a review' });
  await ask.getByLabel('Search people').fill('Milo');
  await ask.getByLabel('Milo Member').check();
  await ask.getByRole('button', { name: 'Send request' }).click();
  await expect(region(page, 'Review').getByText('Waiting for review')).toBeVisible();
  await accessible(page, 'comments and a review on a document');

  // ---- State, owner, and a past review date ------------------------------------------------
  const details = region(page, 'Details');
  await details.getByLabel('State').selectOption('current');
  await details.getByLabel('Review date').fill('2026-09-01');
  await details.getByLabel('Search people').fill('Milo');
  await details.getByLabel('Milo Member').check();
  await details.getByRole('button', { name: 'Save details' }).click();
  await expect(details.getByText('Details saved.')).toBeVisible();
  await expect(page.getByText('Review overdue').first()).toBeVisible();
  await expect(page.getByText('Stale').first()).toBeVisible();
  await expect(page.getByText('Milo Member').first()).toBeVisible();
  await accessible(page, 'details with a review overdue badge');

  // ---- Link a record and find the backlink on the task -------------------------------------
  await page.getByRole('button', { name: 'Link records' }).click();
  const link = page.getByRole('dialog', { name: 'Link records' });
  await link.getByLabel(/^Search tasks/).fill('Write launch');
  await link
    .getByLabel(/Write launch copy/)
    .first()
    .check();
  await link.getByRole('button', { name: 'Save links' }).click();
  await expect(
    region(page, 'Linked records').getByRole('link', { name: 'Write launch copy' }),
  ).toBeVisible();
  await page.goto(`/workspaces/${ws}/tasks/${task.id}`);
  const backlinks = region(page, 'Mentioned in documents');
  await expect(backlinks.getByRole('link', { name: 'Launch brief' })).toBeVisible();
  await expect(region(page, 'Documents')).toBeVisible();
  await accessible(page, 'task page with documents');
  await page.goto(`/workspaces/${ws}/tasks/${secret.id}`);
  await expect(
    region(page, 'Mentioned in documents').getByRole('link', { name: 'Launch brief' }),
  ).toBeVisible();

  // ---- Export: what the file holds, and what it leaves out ---------------------------------
  const exportAs = async (p: Page, format: string) => {
    await p.getByRole('button', { name: 'Export…' }).click();
    const dialog = p.getByRole('dialog', { name: 'Export this document' });
    await dialog.getByLabel(format, { exact: true }).check();
    const [download] = await Promise.all([
      p.waitForEvent('download'),
      dialog.getByRole('button', { name: 'Export', exact: true }).click(),
    ]);
    const text = readFileSync((await download.path())!, 'utf8');
    await expect(dialog.getByText(/Exported 1 page/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
    return { text, name: download.suggestedFilename() };
  };
  await openDoc(page, ws, id, 'Launch brief');
  const md = await exportAs(page, 'Markdown');
  expect(md.name).toMatch(/\.md$/);
  expect(md.text).toContain('Launch goals, sharper');
  expect(md.text).toContain('Secret roadmap'); // the founder may read it
  const html = await exportAs(page, 'HTML');
  expect(html.name).toMatch(/\.html$/);
  expect(html.text).toContain('<html');
  expect(html.text).toContain('Freeze copy on Friday.');
  await openDoc(mp, ws, id, 'Launch brief');
  const mine = await exportAs(mp, 'Markdown');
  expect(mine.text).toContain('Launch goals, sharper');
  expect(mine.text).not.toContain('Secret roadmap');
  expect(mine.text).toContain('Restricted item');
  const mineHtml = await exportAs(mp, 'HTML');
  expect(mineHtml.text).not.toContain('Secret roadmap');

  // ---- Archive, unarchive, and trash -------------------------------------------------------
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(
    page.getByText(/This document is archived, so it is read-only/).first(),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await accessible(page, 'archived page');
  await page.getByRole('button', { name: 'Unarchive' }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Move to trash' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Move this document to the trash?' });
  await accessible(page, 'move to trash confirmation');
  await confirm.getByRole('button', { name: 'Move to trash' }).click();
  await expect(h1(page)).toHaveText('Knowledge');
  await expect(page.getByRole('link', { name: 'Launch brief' })).toHaveCount(0);
  await page.goto(`/workspaces/${ws}/documents/${id}`);
  await expect(h1(page)).toHaveText("This document isn't available to you");
  await accessible(page, 'a trashed document');
  await milo.ctx.close();
  await rae.ctx.close();
});

// -----------------------------------------------------------------------------------------------

type Setup = Awaited<ReturnType<typeof setup>>;
const run = (text: string, extra: object = {}) => ({ text, ...extra });
const para = (...runs: object[]) => ({ type: 'paragraph', runs });

/** A document with one of every block, written through the API (faster than typing it). */
async function seedDoc(page: Page, s: Setup, title: string, extra: object[] = []): Promise<string> {
  const created = await api(page, 'POST', `${s.base}/documents`, {
    type: 'page',
    title,
    brand: s.harbor,
    starter: false,
    content: {
      v: 2,
      blocks: [
        { type: 'heading', level: 1, runs: [run('Plan')] },
        para(
          run(`Long unbroken text ${'abcdefghij'.repeat(30)} and more words to wrap. `),
          run('bold', { bold: true }),
        ),
        { type: 'bulleted_list', items: [[run('One')], [run('Two')]] },
        {
          type: 'checklist',
          items: [
            { runs: [run('Done thing')], checked: true },
            { runs: [run('Open thing')], checked: false },
          ],
        },
        { type: 'callout', tone: 'warning', runs: [run('Careful with this')] },
        { type: 'code', language: 'ts', text: `const veryLongLine = '${'x'.repeat(120)}';` },
        {
          type: 'table',
          header: true,
          rows: [
            ['Task', 'Owner'],
            ['Copy', 'Fay'],
          ],
        },
        { type: 'divider' },
        {
          type: 'embed',
          kind: 'link',
          url: `https://example.com/${'path/'.repeat(20)}`,
          title: 'A long link',
          alt: null,
        },
        ...extra,
      ],
    },
  });
  return created.id as string;
}

test('appearance and reflow: forced colours, reduced motion, 320 px, and 200% zoom', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  const s = await setup(page, info, 'docs-look');
  const id = await seedDoc(page, s, 'Look and feel');
  await openDoc(page, s.ws, id, 'Look and feel');
  const size = page.viewportSize()!;

  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.reload();
  await expect(region(page, 'Content')).toBeVisible();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
  await accessible(page, 'editor, forced colours and reduced motion');
  await page.getByRole('button', { name: 'Add block', exact: true }).click();
  await accessible(page, 'add block menu, forced colours');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(
    page.getByText(/This document is archived, so it is read-only/).first(),
  ).toBeVisible();
  await accessible(page, 'read-only page, forced colours and reduced motion');
  await page.getByRole('button', { name: 'Unarchive' }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });

  // Reflow: the editor, the read-only view, and Knowledge at 320 px, a tablet width, and 200% zoom.
  const half = Math.max(320, Math.floor(size.width / 2));
  for (const width of [320, 640, half]) {
    await page.setViewportSize({ width, height: size.height });
    await openDoc(page, s.ws, id, 'Look and feel');
    await expectNoOverflow(page, `editor at ${width}px`);
    await page.goto(knowledge(s.ws));
    await expect(
      page
        .getByRole('tree', { name: 'Workspace pages' })
        .or(page.getByRole('tree', { name: 'Harbor pages' }))
        .first(),
    ).toBeVisible();
    await expectNoOverflow(page, `Knowledge at ${width}px`);
  }
  await page.setViewportSize({ width: 320, height: size.height });
  await openDoc(page, s.ws, id, 'Look and feel');
  await page.getByRole('button', { name: 'Add block', exact: true }).click();
  await accessible(page, 'add block menu at 320 px');
  await expectNoOverflow(page, 'add block menu at 320px');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Export…' }).click();
  await accessible(page, 'export dialog at 320 px');
  await expectNoOverflow(page, 'export dialog at 320px');
  await page.keyboard.press('Escape');
  await api(page, 'POST', `${s.base}/documents/${id}:archive`, {});
  await openDoc(page, s.ws, id, 'Look and feel');
  await expect(
    page.getByText(/This document is archived, so it is read-only/).first(),
  ).toBeVisible();
  await expectNoOverflow(page, 'read-only view at 320px');
  await accessible(page, 'read-only view at 320 px');
  await page.goto(knowledge(s.ws));
  await page.getByRole('button', { name: 'New page' }).click();
  await accessible(page, 'new page dialog at 320 px');
  await expectNoOverflow(page, 'new page dialog at 320px');
});

/** Moves focus with Tab until the focused element matches; fails if it never does. */
async function tabTo(page: Page, test: string, max = 400) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate<boolean>(`((el) => ${test})(document.activeElement)`)) return;
  }
  throw new Error('keyboard focus never reached the control');
}

test('keyboard only: create, type, add a block, save, and open the history', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  const s = await setup(page, info, 'docs-kb');
  await page.goto(knowledge(s.ws));
  await expect(h1(page)).toHaveText('Knowledge');
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
  await page.getByRole('heading', { level: 1 }).focus();
  await tabTo(page, "el.tagName === 'BUTTON' && el.textContent === 'New page'");
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New page' });
  await expect(dialog.getByLabel('Title', { exact: true })).toBeFocused();
  await page.keyboard.type('Typed by keyboard');
  await tabTo(page, "el.type === 'checkbox'"); // the starter
  await page.keyboard.press('Space');
  await accessible(page, 'new page dialog');
  await tabTo(page, "el.tagName === 'BUTTON' && el.textContent === 'Create page'");
  await page.keyboard.press('Enter');
  await expect(h1(page)).toHaveText('Typed by keyboard');
  await expect(region(page, 'Content')).toBeVisible();
  await expect(page.getByText('This page has no content yet. Add a block to start.')).toBeVisible();

  // Add a block from the menu with the keyboard, type into it, and save with Ctrl+S.
  await page.getByRole('heading', { level: 1 }).focus();
  await tabTo(page, "el.tagName === 'BUTTON' && el.textContent === 'Add block'");
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu', { name: 'Add block' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Paragraph' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Paragraph text')).toBeFocused();
  await page.keyboard.type('Written without a mouse');
  await accessible(page, 'keyboard editing');
  await page.keyboard.press('Control+s');
  await expect(saveState(page)).toContainText('Saved');
  // A second block: move it above the first with the keyboard, and delete it with undo.
  await tabTo(page, "el.tagName === 'BUTTON' && el.textContent === 'Add block'");
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter'); // Heading
  await page.keyboard.type('Top');
  await page.getByRole('button', { name: 'Move up block 2' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Block 1 of 2: Heading')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move down block 1' })).toBeFocused();
  await page.getByRole('button', { name: 'Delete block 1' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Deleted block 1 (Heading).')).toBeVisible();
  await page.getByRole('button', { name: 'Undo delete' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Block 1 of 2: Heading')).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(saveState(page)).toContainText('Saved');

  // Open the history and a version, all with the keyboard.
  const view = page.getByRole('button', { name: 'View version 1' });
  await view.focus();
  await page.keyboard.press('Enter');
  await expect(region(page, 'Version 1')).toBeFocused();
  await accessible(page, 'a version opened with the keyboard');
});

test('offline: the draft is kept on this device, restored after a reload, and saved when back online', async ({
  page,
  context,
}, info) => {
  test.setTimeout(240_000);
  await withoutLive(context);
  const s = await setup(page, info, 'docs-off');
  const id = await seedDoc(page, s, 'Offline notes');
  await openDoc(page, s.ws, id, 'Offline notes');
  const intro = page.getByLabel('Paragraph text').first();

  // An unsaved edit survives a reload with a clear banner, and can be discarded.
  await intro.fill('Edited but never saved');
  await expect(saveState(page)).toContainText('Unsaved changes (kept on this device)');
  await expect
    .poll(() =>
      page.evaluate<number>(
        "Object.keys(localStorage).filter((k) => k.includes('.doc.ws_')).length",
      ),
    )
    .toBe(1);
  await page.reload();
  await expect(page.getByText('Restored your unsaved changes from this device')).toBeVisible();
  await expect(page.getByLabel('Paragraph text').first()).toHaveValue('Edited but never saved');
  await accessible(page, 'restored draft banner');
  await page.getByRole('button', { name: 'Discard restored changes' }).click();
  await expect(page.getByLabel('Paragraph text').first()).toHaveValue(/Long unbroken text/);

  // Edit while offline: saving fails, says the text is kept, and Retry saves it once back online.
  await page.getByLabel('Paragraph text').first().fill('Written while offline');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const problem = page.getByRole('alert').filter({ hasText: /kept on this device/ });
  await expect(problem).toBeVisible();
  await expect(saveState(page)).toContainText("Couldn't save: you're offline");
  await expect(page.getByLabel('Paragraph text').first()).toHaveValue('Written while offline');
  await accessible(page, 'offline, draft kept');
  expect(
    await page.evaluate(
      () => Object.keys(localStorage).filter((k) => k.includes('.doc.ws_')).length,
    ),
  ).toBe(1);
  await context.setOffline(false);
  await problem.getByRole('button', { name: 'Retry' }).click();
  await expect(saveState(page)).toContainText('Saved');
  await page.reload();
  await expect(page.getByLabel('Paragraph text').first()).toHaveValue('Written while offline');
  await expect(page.getByText('Restored your unsaved changes')).toHaveCount(0);
});

test('a read-only member and a share-only guest see only what they may', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(240_000);
  const s = await setup(page, info, 'docs-ro');
  const secret = await vault(page, s.ws, s.base, s.brands);
  const id = await seedDoc(page, s, 'Shared plan', [
    para(run('See '), { ref: { kind: 'task', id: s.task.id } }, run(' and '), {
      ref: { kind: 'task', id: secret.id },
    }),
  ]);
  const reader = await person(browser, page, s.ws, info, 'docs-ro-r', 'Rae Reader', 'Read-only');
  await giveBrand(page, s.ws, 'Harbor', 'Rae Reader', 'view');
  const rp = reader.page;
  await expect
    .poll(async () => (await rp.request.get(`${s.base}/documents/${id}`)).status())
    .toBe(200);
  await openDoc(rp, s.ws, id, 'Shared plan');
  await expect(rp.getByText(/You can read this document\. You can't edit it\./)).toBeVisible();
  await expect(rp.getByRole('link', { name: 'Write launch copy' })).toBeVisible();
  await expect(rp.getByText('Restricted item')).toBeVisible();
  expect(await rp.content()).not.toContain('Secret roadmap');
  expect(await rp.content()).not.toContain('rst_');
  for (const name of [
    'Save',
    'Export…',
    'Archive',
    'Move to trash',
    'Add page',
    'Link records',
    'Save details',
  ])
    await expect(rp.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(rp.getByRole('button', { name: /Suggest a change/ })).toHaveCount(0);
  await expect(rp.getByRole('button', { name: 'Restore this version' })).toHaveCount(0);
  await accessible(rp, 'read-only member on the page');

  // A guest with a comment share on this one document: no tree, no ancestors, no subpages.
  const guestEmail = uniqueEmail('docs-ro-g', info);
  await api(page, 'POST', `${s.base}/invitations`, {
    email: guestEmail,
    kind: 'guest',
    records: [{ record: id, level: 'comment' }],
  });
  const gctx = await browser.newContext();
  const gp = await gctx.newPage();
  await openLink(gp, linkPath(await waitForMail(guestEmail, 'invited')));
  await register(gp, guestEmail, 'Gus Guest');
  await verify(gp, guestEmail);
  await signedIn(gp, guestEmail);
  await gp.getByRole('button', { name: 'Accept invitation' }).click();
  // The button is replaced by "Working…" while the request runs, so wait for where acceptance lands.
  await expect(gp).toHaveURL(/\/workspaces\/ws_/);
  await expect(gp.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0);
  await expect(gp.getByText(/^Loading/)).toHaveCount(0);
  await openDoc(gp, s.ws, id, 'Shared plan');
  await expect(gp.getByText('Restricted item').first()).toBeVisible();
  await expect(gp.getByRole('heading', { name: 'Subpages' })).toHaveCount(0);
  await expect(gp.getByRole('navigation', { name: 'Breadcrumb' })).toHaveCount(0);
  await expect(gp.getByRole('link', { name: 'Knowledge', exact: true })).toHaveCount(0);
  for (const name of ['Save', 'Export…', 'Archive', 'Move to trash', 'Add page', 'Link records'])
    await expect(gp.getByRole('button', { name, exact: true })).toHaveCount(0);
  const box = gp.getByLabel('Add a comment', { exact: true });
  await box.fill('Hello from a guest');
  await gp.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect(region(gp, 'Comments').getByText('Hello from a guest')).toBeVisible();
  await expect(gp.getByRole('heading', { name: 'Assignment history' })).toHaveCount(0);
  await accessible(gp, 'share-only guest on the page');
  await expectNoOverflow(gp, 'page');
  await gctx.close();
  await reader.ctx.close();
});
