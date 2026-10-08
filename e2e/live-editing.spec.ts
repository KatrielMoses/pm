import { test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  accessible,
  api,
  expect,
  expectNoOverflow,
  giveBrand,
  guestOf,
  liveStatus,
  noLive,
  openLive,
  paragraphs,
  person,
  region,
  removeBrandAccess,
  saveState,
  saveVersion,
  seedPage,
  setup,
  tabTo,
} from './live-support.ts';

/**
 * Phase 4D on desktop and mobile (ADR-0027): two people edit one page at the same time and see
 * each other's text and who is here; a change to a block someone else changed is never silently
 * lost and is settled by a choice, either way; edits made offline are kept and catch up on
 * reconnect; removing a person's access (or trashing the page) ends their editing with their text
 * kept; a read-only guest sees only themselves; a plain save or restore while someone is editing
 * live is refused in plain words. The conflict view passes axe, reflows at 320 px and 200% zoom,
 * works in forced colours and reduced motion, and is operated with the keyboard alone. Every wait
 * is for a state, never for time.
 */

type Who = { ctx: BrowserContext; page: Page };

/** Milo edits `index` offline while Fay changes and saves it; Milo reconnects with a change to review. */
async function conflictOn(fay: Page, milo: Who, index: number, mine: string, theirs: string) {
  await milo.ctx.setOffline(true);
  await expect(liveStatus(milo.page)).toContainText(
    'Offline — your edits are kept on this device and sent when you reconnect',
  );
  await paragraphs(milo.page).nth(index).fill(mine);
  await paragraphs(fay).nth(index).fill(theirs);
  await saveVersion(fay); // returns once the server has Fay's text
  await milo.ctx.setOffline(false);
  await expect(milo.page.getByRole('region', { name: /to review$/ })).toBeVisible();
  await expect(paragraphs(milo.page).nth(index)).toHaveValue(mine); // never overwritten
}

/** Two members editing one page, both connected. */
async function pair(
  browser: Browser,
  fay: Page,
  info: Parameters<typeof setup>[1],
  prefix: string,
  texts: string[],
) {
  const s = await setup(fay, info, prefix);
  const id = await seedPage(fay, s, 'Live notes', texts);
  const milo = await person(browser, fay, s.ws, info, `${prefix}-m`, 'Milo Member', 'Member');
  await giveBrand(fay, s.ws, 'Harbor', 'Milo Member', 'edit');
  await expect
    .poll(async () => (await milo.page.request.get(`${s.base}/documents/${id}`)).status())
    .toBe(200);
  await openLive(fay, s.ws, id, 'Live notes');
  await openLive(milo.page, s.ws, id, 'Live notes');
  return { s, id, milo };
}

test('two editors see each other and the same text; conflicts are settled by choice; offline edits catch up', async ({
  page: fay,
  browser,
}, info) => {
  test.setTimeout(300_000);
  const { s, id, milo } = await pair(browser, fay, info, 'live', ['Alpha', 'Bravo', 'Charlie']);
  const mp = milo.page;

  // ---- Who is here: names the server sent, with a text label and where they are -------------
  await expect(fay.getByRole('list', { name: 'People here' }).getByRole('listitem')).toHaveText([
    'Milo Member (editing)',
  ]);
  await expect(mp.getByRole('list', { name: 'People here' }).getByRole('listitem')).toHaveText([
    'Fay Founder (editing)',
  ]);
  await expect(fay.getByText('1 other editing')).toBeVisible();
  await expect(liveStatus(fay)).toContainText('Live');
  await paragraphs(mp).nth(2).focus();
  await expect(fay.getByText('Milo Member is here')).toBeVisible();
  await accessible(fay, 'live editor with someone else here');

  // ---- Text, new blocks, moves, and deletions reach the other person --------------------------
  await paragraphs(fay).nth(0).fill('Alpha from Fay');
  await expect(paragraphs(mp).nth(0)).toHaveValue('Alpha from Fay');
  await paragraphs(mp).nth(1).fill('Bravo from Milo');
  await expect(paragraphs(fay).nth(1)).toHaveValue('Bravo from Milo');
  await fay.getByRole('button', { name: 'Add block', exact: true }).click();
  await fay.getByRole('menuitem', { name: 'Paragraph', exact: true }).click();
  await paragraphs(fay).last().fill('Delta');
  await expect(paragraphs(mp)).toHaveCount(4);
  await expect(paragraphs(mp).last()).toHaveValue('Delta');
  await mp.getByRole('button', { name: 'Move up block 4' }).click();
  await expect(paragraphs(fay).nth(2)).toHaveValue('Delta');
  await expect(paragraphs(fay).nth(3)).toHaveValue('Charlie');
  await mp.getByRole('button', { name: 'Delete block 3' }).click();
  await expect(paragraphs(fay)).toHaveCount(3);
  await expect(paragraphs(fay).nth(2)).toHaveValue('Charlie');

  // ---- An offline edit to a different block catches up with no conflict ------------------------
  await milo.ctx.setOffline(true);
  await expect(liveStatus(mp)).toContainText(
    'Offline — your edits are kept on this device and sent when you reconnect',
  );
  await paragraphs(mp).nth(0).fill('Alpha, written offline');
  await expect(paragraphs(fay).nth(0)).toHaveValue('Alpha from Fay');
  await milo.ctx.setOffline(false);
  await expect(paragraphs(fay).nth(0)).toHaveValue('Alpha, written offline');
  await expect(liveStatus(mp)).toContainText(/^Live/);
  await expect(mp.getByRole('region', { name: /to review$/ })).toHaveCount(0);

  // ---- The same block changed on both sides: Keep mine ----------------------------------------
  await conflictOn(fay, milo, 2, 'Charlie, Milo offline', 'Charlie, Fay online');
  const review = mp.getByRole('region', { name: /to review$/ });
  await expect(mp.locator('.live-block-note')).toHaveText('Updated by Fay Founder — review');
  await expect(review.getByText('Charlie, Fay online')).toBeVisible();
  await expect(review.getByText('Charlie, Milo offline')).toBeVisible();
  await accessible(mp, 'a change to review');
  await review.getByRole('button', { name: /Keep mine/ }).click();
  await expect(paragraphs(fay).nth(2)).toHaveValue('Charlie, Milo offline');
  await expect(review).toHaveCount(0);
  await expect(mp.locator('.live-block-note')).toHaveCount(0);

  // ---- ... and Take theirs --------------------------------------------------------------------
  await conflictOn(fay, milo, 1, 'Bravo, Milo offline', 'Bravo, Fay online');
  await review.getByRole('button', { name: /Take theirs/ }).click();
  await expect(paragraphs(mp).nth(1)).toHaveValue('Bravo, Fay online');
  await expect(paragraphs(fay).nth(1)).toHaveValue('Bravo, Fay online');
  await expect(review).toHaveCount(0);

  // ---- Save while live makes a version, and the history shows it -------------------------------
  await paragraphs(mp).nth(0).fill('Alpha, final');
  await expect(paragraphs(fay).nth(0)).toHaveValue('Alpha, final');
  await saveVersion(mp);
  const history = region(mp, 'Version history');
  await expect(history.getByText(/^Version \d+$/).first()).toBeVisible();
  await expect(liveStatus(mp)).toContainText('saved just now');
  expect(
    await api(fay, 'POST', `${s.base}/documents/${id}:export`, { format: 'markdown' }),
  ).toBeTruthy();
  await milo.ctx.close();
});

test('the conflict view: axe, 320 px and 200% zoom, forced colours, reduced motion, and the keyboard alone', async ({
  page: fay,
  browser,
}, info) => {
  test.setTimeout(300_000);
  const { milo } = await pair(browser, fay, info, 'live-a11y', ['Alpha', 'Bravo']);
  const mp = milo.page;
  await conflictOn(fay, milo, 1, 'Bravo, mine', 'Bravo, theirs');
  const review = mp.getByRole('region', { name: /to review$/ });
  const size = mp.viewportSize()!;

  await mp.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await accessible(mp, 'conflict view, forced colours and reduced motion');
  // Forced colours: the marker and the panel are outlined, not coloured backgrounds alone.
  const border = (sel: string) =>
    mp.evaluate<string>(
      `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).borderTopWidth`,
    );
  expect(await border('.live-block-note')).toBe('1px');
  expect(await border('.live-review')).not.toBe('0px');
  // Reduced motion: nothing is animated, and "Updated" is a static label.
  expect(await mp.evaluate<number>('document.getAnimations().length')).toBe(0);
  await expect(mp.locator('.live-block-note')).toHaveText('Updated by Fay Founder — review');
  await mp.emulateMedia({ reducedMotion: null, forcedColors: null });

  // 320 px, and the width a 200% zoom leaves: the choices and the presence chips wrap.
  for (const width of [320, Math.max(320, Math.floor(size.width / 2))]) {
    await mp.setViewportSize({ width, height: size.height });
    // A reload also shows that the unsent text and its change to review come back from this device.
    await mp.reload();
    await expect(region(mp, 'Content')).toBeVisible();
    await expect(review).toBeVisible();
    await expect(paragraphs(mp).nth(1)).toHaveValue('Bravo, mine');
    await expectNoOverflow(mp, `conflict view at ${width}px`);
    await accessible(mp, `conflict view at ${width}px`);
  }
  await mp.setViewportSize(size);

  // The keyboard alone: reach Keep mine with Tab and choose it with Enter; focus lands back in the block.
  await tabTo(mp, "el.tagName === 'BUTTON' && /^Keep mine/.test(el.textContent)");
  await expect(review.getByRole('button', { name: /Keep mine/ })).toBeFocused();
  await mp.keyboard.press('Enter');
  await expect(review).toHaveCount(0);
  await expect(paragraphs(mp).nth(1)).toBeFocused();
  await expect(paragraphs(fay).nth(1)).toHaveValue('Bravo, mine');
  // Save is a button too; Ctrl+S saves a version from the text box.
  await mp.keyboard.press('Control+s');
  await expect(saveState(mp)).toContainText(/Saved as version \d+\./);
  await milo.ctx.close();
});

test("removing a person's access, or trashing the page, ends live editing and keeps their text", async ({
  page: fay,
  browser,
}, info) => {
  test.setTimeout(300_000);
  const { s, id, milo } = await pair(browser, fay, info, 'live-gone', ['Alpha', 'Bravo']);
  const rae = await person(browser, fay, s.ws, info, 'live-gone-r', 'Rae Member', 'Member');
  await giveBrand(fay, s.ws, 'Harbor', 'Rae Member', 'edit');
  await openLive(fay, s.ws, id, 'Live notes');
  await expect
    .poll(async () => (await rae.page.request.get(`${s.base}/documents/${id}`)).status())
    .toBe(200);
  await openLive(rae.page, s.ws, id, 'Live notes');
  await expect(fay.getByRole('list', { name: 'People here' }).getByRole('listitem')).toHaveCount(2);

  // Milo is typing offline when the owner removes his access; when he reconnects his next request is refused.
  await milo.ctx.setOffline(true);
  await expect(liveStatus(milo.page)).toContainText('Offline');
  await paragraphs(milo.page).nth(1).fill('Bravo, typed offline');
  await removeBrandAccess(fay, s.ws, 'Harbor', 'Milo Member');
  await milo.ctx.setOffline(false);
  await expect(milo.page.getByText('You no longer have access to this document')).toBeVisible();
  await expect(milo.page.getByRole('button', { name: 'Download my unsaved text' })).toBeVisible();
  await expect(milo.page.getByLabel('Your last text')).toContainText('Bravo, typed offline');
  await accessible(milo.page, 'access ended');
  // Their text is also on this device.
  expect(
    await milo.page.evaluate<boolean>(
      "Object.entries(localStorage).some(([k, v]) => k.includes('.doc.') && v.includes('typed offline'))",
    ),
  ).toBe(true);

  // The page is trashed while Rae is editing (offline, with text not sent yet).
  await rae.ctx.setOffline(true);
  await expect(liveStatus(rae.page)).toContainText('Offline');
  await paragraphs(rae.page).nth(0).fill('Alpha, edited as it went');
  await api(fay, 'POST', `${s.base}/documents/${id}:trash`, {});
  await rae.ctx.setOffline(false);
  await expect(rae.page.getByText('You no longer have access to this document')).toBeVisible();
  await expect(rae.page.getByLabel('Your last text')).toContainText('Alpha, edited as it went');
  await milo.ctx.close();
  await rae.ctx.close();
});

test('a read-only guest sees changes and only themselves; a plain save or restore while someone edits live says so', async ({
  page: fay,
  browser,
}, info) => {
  test.setTimeout(300_000);
  const s = await setup(fay, info, 'live-guest');
  const id = await seedPage(fay, s, 'Shared notes', ['Alpha', 'Bravo']);
  // A second member whose editor has no live connection (live off for them) saves the plain way.
  const milo = await person(browser, fay, s.ws, info, 'live-guest-m', 'Milo Member', 'Member');
  await giveBrand(fay, s.ws, 'Harbor', 'Milo Member', 'edit');
  await noLive(milo.ctx);
  await expect
    .poll(async () => (await milo.page.request.get(`${s.base}/documents/${id}`)).status())
    .toBe(200);
  await openLive(fay, s.ws, id, 'Shared notes');

  // A guest with a read share: live view of changes, no names, no list of people.
  const guest = await guestOf(browser, fay, s.base, info, 'live-guest-g', 'Gus Guest', id, 'read');
  await guest.page.goto(`/workspaces/${s.ws}/documents/${id}`);
  await expect(guest.page.getByRole('heading', { level: 1 })).toHaveText('Shared notes');
  await expect(liveStatus(guest.page)).toHaveText('Live — viewing');
  await expect(guest.page.getByRole('list', { name: 'People here' })).toHaveCount(0);
  await expect(guest.page.getByText('Fay Founder')).toHaveCount(0);
  await paragraphs(fay).nth(1).fill('Bravo, seen live');
  await expect(guest.page.getByText('Bravo, seen live')).toBeVisible();
  await expect(guest.page.getByRole('textbox')).toHaveCount(0);
  await accessible(guest.page, 'a guest following live');
  // Fay, a member, is told who the guest is (the server sends names the member may see).
  await expect(fay.getByRole('list', { name: 'People here' }).getByRole('listitem')).toHaveText([
    'Gus Guest (viewing)',
  ]);
  await expect(liveStatus(fay)).toContainText(/^Live/);

  // A first version, so there is something to restore.
  await saveVersion(fay);
  await paragraphs(fay).nth(0).fill('Alpha, version two');
  await saveVersion(fay);
  await milo.page.goto(`/workspaces/${s.ws}/documents/${id}`);
  await expect(region(milo.page, 'Content')).toBeVisible();
  await expect(liveStatus(milo.page)).toContainText('Editing without live updates');
  const history = region(milo.page, 'Version history');
  await history.getByRole('button', { name: 'View version 1' }).click();
  await history.getByRole('button', { name: 'Restore this version' }).click();
  await expect(
    history.getByText('Someone is editing live. Restore after they finish.'),
  ).toBeVisible();
  await paragraphs(milo.page).nth(1).fill('Bravo, plain save');
  await milo.page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(milo.page.getByText(/someone is editing this document live/i).first()).toBeVisible();
  await expect(paragraphs(milo.page).nth(1)).toHaveValue('Bravo, plain save'); // kept
  await accessible(milo.page, 'a plain save refused while someone edits live');
  await guest.ctx.close();
  await milo.ctx.close();
});
