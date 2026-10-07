import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
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
 * Phase 4A on desktop, tablet, and mobile (ADR-0023): a founder and a second member comment,
 * reply, mention, react, edit, delete, follow and unfollow (and find followed work under My Work),
 * request and decide a review, see it go stale after the task changes and ask again, and hand a
 * task over. A read-only member and a share-only guest see only what they may. Every stage passes
 * axe; the page reflows at 320 px and 200% zoom, with forced colours and reduced motion; and the
 * composer, post, react, and follow path works with the keyboard alone.
 */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

async function api(
  page: Page,
  method: 'POST' | 'PATCH',
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

/** The recipient opens the mailed link, registers, verifies, signs in, and accepts. */
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

async function setup(page: Page, info: Parameters<typeof uniqueEmail>[1], prefix: string) {
  await owner(page, info, prefix, 'Fay Founder');
  const ws = await createWorkspace(page, 'Talk Co');
  await createBrand(page, 'Harbor');
  const base = `/v1/workspaces/${ws}`;
  const brands = (await (await page.request.get(`${base}/brands`)).json()).data as Array<{
    id: string;
    name: string;
  }>;
  const task = await api(page, 'POST', `${base}/tasks`, {
    brand: brands.find((b) => b.name === 'Harbor')!.id,
    title: 'Write launch copy',
  });
  const opts = await (await page.request.get(`${base}/views/options/task/assignee`)).json();
  const me = opts.data.options.find((o: { label: string }) => o.label === 'Fay Founder')
    .value as string;
  return {
    ws,
    base,
    task: task as { id: string; version: number },
    me,
    url: `/workspaces/${ws}/tasks/${task.id}`,
  };
}

async function openTask(page: Page, url: string, title = 'Write launch copy') {
  await page.goto(url);
  await expect(h1(page)).toHaveText(title);
  await expect(card(page, 'Comments')).toBeVisible();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
}

async function post(page: Page, text: string, button = 'Post comment', label = 'Add a comment') {
  await page.getByLabel(label, { exact: true }).fill(text);
  await page.getByRole('button', { name: button, exact: true }).click();
}

test('comments, replies, mentions, reactions, edit, delete, follow, reviews, and hand-over between two people', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(240_000);
  const { ws, base, task, me, url } = await setup(page, info, 'talk');
  await expect(page.getByRole('main')).toBeVisible();
  const milo = await person(browser, page, ws, info, 'talk-milo', 'Milo Member', 'Member');
  await giveBrand(page, ws, 'Harbor', 'Milo Member', 'edit');
  const mp = milo.page;

  // Founder posts the first comment.
  await openTask(page, url);
  await expectAccessible(page, 'task page with comments, empty');
  await expect(card(page, 'Comments').getByText(/No comments yet/)).toBeVisible();
  await post(page, 'First draft of the copy is ready.');
  const comments = card(page, 'Comments');
  await expect(comments.getByText('First draft of the copy is ready.')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Comment posted.' })).toBeAttached();
  await expectAccessible(page, 'task page with a comment');

  // Milo replies, mentioning the founder with the picker, and reacts.
  await openTask(mp, url);
  await expect(card(mp, 'Comments').getByText('First draft of the copy is ready.')).toBeVisible();
  await mp.getByRole('button', { name: /^Reply/ }).click();
  const reply = mp.getByLabel('Reply to Fay Founder');
  await reply.fill('Looks good @Fay');
  const list = mp.getByRole('listbox', { name: 'Suggested mentions' });
  await expect(list.getByRole('option', { name: /Fay Founder/ })).toBeVisible();
  await expectAccessible(mp, 'mention picker open');
  await mp.keyboard.press('Enter');
  await expect(reply).toHaveValue('Looks good @Fay Founder ');
  await mp.keyboard.type('thanks');
  await mp.getByRole('button', { name: 'Post reply' }).click();
  const thread = card(mp, 'Comments');
  await expect(thread.getByText('thanks', { exact: false })).toBeVisible();
  await expect(thread.locator('.mention', { hasText: '@Fay Founder' })).toBeVisible();
  const reactions = thread.getByRole('group', { name: 'Reactions' }).first();
  await reactions.getByRole('button', { name: 'Thumbs up' }).click();
  await expect(reactions.getByRole('button', { name: 'Thumbs up, 1' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expectAccessible(mp, 'thread with reply, mention, and reaction');

  // Milo edits his reply, then deletes it (confirm dialog; a tombstone stays).
  await mp.getByRole('button', { name: /^Edit/ }).click();
  const edit = mp.getByLabel('Edit your comment');
  await edit.fill('Looks good, thanks!');
  await mp.getByRole('button', { name: 'Save changes' }).click();
  await expect(thread.getByText('Looks good, thanks!')).toBeVisible();
  await expect(thread.getByText(/Edited/)).toBeVisible();
  await mp.getByRole('button', { name: /^History/ }).click();
  await expect(thread.getByRole('list', { name: 'Earlier versions' })).toContainText(
    'Looks good @Fay Founder thanks',
  );
  await mp.getByRole('button', { name: /^Delete/ }).click();
  const confirm = mp.getByRole('alertdialog', { name: 'Delete this comment?' });
  await expectAccessible(mp, 'delete confirmation');
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Delete comment' }).click();
  await expect(thread.getByText('This comment was deleted.')).toBeVisible();
  await expect(thread.getByText('First draft of the copy is ready.')).toBeVisible();

  // Milo posts a fresh reply; the founder sees it, and a draft survives a reload.
  await mp
    .getByRole('button', { name: /^Reply/ })
    .first()
    .click();
  await mp
    .getByLabel(/^Reply to/)
    .fill('Sorry, wrong thread. Final: approve once the title is set.');
  await mp.getByRole('button', { name: 'Post reply' }).click();
  await expect(thread.getByText(/Final: approve/)).toBeVisible();
  await page.reload();
  await expect(card(page, 'Comments').getByText(/Final: approve/)).toBeVisible();
  await page.getByLabel('Add a comment', { exact: true }).fill('A thought I have not sent');
  await page.waitForTimeout(400);
  await page.reload();
  await expect(page.getByLabel('Add a comment', { exact: true })).toHaveValue(
    'A thought I have not sent',
  );
  await expect(page.getByText('Restored your unsent draft from this device.')).toBeVisible();
  await page.getByLabel('Add a comment', { exact: true }).fill('');

  // Following: follow, find it under My Work, unfollow.
  const following = card(page, 'Following');
  await following.getByRole('button', { name: 'Follow', exact: true }).click();
  await expect(following.getByRole('button', { name: 'Follow', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(following.getByText(/You follow this task/).first()).toBeVisible();
  await page.goto(`/workspaces/${ws}/my-work?tab=following`);
  await expect(page.getByRole('link', { name: 'Write launch copy', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Following', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectAccessible(page, 'My Work, Following');
  await page.getByRole('button', { name: 'Projects' }).click();
  await expect(page.getByText(/aren't following any projects/)).toBeVisible();
  await openTask(page, url);
  await card(page, 'Following').getByRole('button', { name: 'Follow', exact: true }).click();
  await expect(
    card(page, 'Following').getByRole('button', { name: 'Follow', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');

  // Review: the founder asks Milo; Milo sees it under My Work, decides, and it settles.
  await page.getByRole('button', { name: 'Request review…' }).click();
  const ask = page.getByRole('dialog', { name: 'Request a review' });
  await ask.getByRole('button', { name: 'Send request' }).click();
  await expect(ask.getByRole('alert')).toContainText('Choose at least one reviewer.');
  await ask.getByLabel('Search people').fill('Milo');
  await ask.getByLabel('Milo Member').check();
  await ask.getByLabel('What are you asking for?').selectOption('approval');
  await ask.getByLabel('Message (optional)').fill('Please sign off on the copy.');
  await expectAccessible(page, 'request review dialog');
  await ask.getByRole('button', { name: 'Send request' }).click();
  const review = card(page, 'Review');
  await expect(review.getByText('Waiting for review')).toBeVisible();
  await expect(review.getByText('Please sign off on the copy.')).toBeVisible();
  await expect(review.getByRole('button', { name: 'Withdraw request…' })).toBeVisible();

  await mp.goto(`/workspaces/${ws}/my-work?tab=reviews`);
  await expect(mp.getByRole('link', { name: 'Write launch copy', exact: true })).toBeVisible();
  await expectAccessible(mp, 'My Work, Reviews');
  await mp.getByRole('link', { name: 'Write launch copy', exact: true }).click();
  await expect(h1(mp)).toHaveText('Write launch copy');
  await card(mp, 'Review').getByRole('button', { name: 'Decide…' }).click();
  const decide = mp.getByRole('dialog', { name: 'Decide on this approval' });
  await decide.getByRole('button', { name: 'Send decision' }).click();
  await expect(decide.getByRole('alert')).toContainText('Choose approve');
  await decide.getByLabel(/^Approve/).check();
  await decide.getByLabel('Note (optional)').fill('Ship it.');
  await expectAccessible(mp, 'decide dialog');
  await decide.getByRole('button', { name: 'Send decision' }).click();
  await expect(card(mp, 'Review').getByText('Approved').first()).toBeVisible();
  await expect(card(mp, 'Review').getByText('Ship it.')).toBeVisible();
  await expect(card(mp, 'Review').getByRole('button', { name: 'Decide…' })).toHaveCount(0);
  await mp.goto(`/workspaces/${ws}/my-work?tab=reviews`);
  await mp.getByRole('checkbox', { name: 'Settled' }).check();
  await expect(mp.getByRole('link', { name: 'Write launch copy', exact: true })).toBeVisible();

  // The task changes, so the settled review is marked and a fresh request is possible; request
  // again, change the task again, and see the stale state with Ask again.
  await page.reload();
  await expect(card(page, 'Review').getByText('Approved').first()).toBeVisible();
  await page.getByRole('button', { name: 'Request review…' }).click();
  await page.getByRole('dialog').getByLabel('Search people').fill('Milo');
  await page.getByRole('dialog').getByLabel('Milo Member').check();
  await page.getByRole('dialog').getByRole('button', { name: 'Send request' }).click();
  await expect(card(page, 'Review').getByText('Waiting for review')).toBeVisible();
  const fresh = await (await page.request.get(`${base}/tasks/${task.id}`)).json();
  await api(
    page,
    'PATCH',
    `${base}/tasks/${task.id}`,
    { version: fresh.data.version, changes: { priority: { base: 'none', value: 'high' } } },
    fresh.data.version,
  );
  await page.reload();
  const stale = card(page, 'Review');
  await expect(stale.getByText('This changed after the review began')).toBeVisible();
  await expectAccessible(page, 'stale review');
  await openTask(mp, url);
  await expect(card(mp, 'Review').getByText('This changed after the review began')).toBeVisible();
  await expect(card(mp, 'Review').getByRole('button', { name: 'Decide…' })).toHaveCount(0);
  await stale.getByRole('button', { name: 'Ask again' }).click();
  await expect(stale.getByText('Waiting for review')).toBeVisible();
  await expect(stale.getByText('This changed after the review began')).toHaveCount(0);
  await stale.getByRole('button', { name: 'Earlier reviews' }).click();
  await expect(stale.getByRole('list', { name: 'Earlier reviews' })).toBeVisible();

  // Hand over: assign the founder, then hand the task to Milo; the history shows it.
  await api(page, 'POST', `${base}/tasks/${task.id}:assign`, {
    assignees: [me],
    primary: me,
    version: (await (await page.request.get(`${base}/tasks/${task.id}`)).json()).data.version,
  });
  await page.reload();
  await page.getByRole('button', { name: 'Hand over…' }).click();
  const hand = page.getByRole('dialog', { name: 'Hand this task over' });
  await hand.getByRole('button', { name: 'Hand over' }).click();
  await expect(hand.getByRole('alert')).toContainText('Choose who takes this over.');
  await hand.getByLabel('Search people').fill('Milo');
  await hand.getByLabel('Milo Member').check();
  await hand.getByLabel('Note (optional)').fill('You know the audience best.');
  await expectAccessible(page, 'hand over dialog');
  await hand.getByRole('button', { name: 'Hand over' }).click();
  const history = card(page, 'Assignment history');
  await expect(history.getByText(/Fay Founder handed this over to Milo Member/)).toBeVisible();
  await expect(history.getByText('You know the audience best.')).toBeVisible();
  await expect(history.getByRole('button', { name: 'Hand over…' })).toHaveCount(0);
  await expectAccessible(page, 'assignment history');
  await milo.ctx.close();
});

test('appearance and reflow: forced colours, reduced motion, 320 px, and 200% zoom', async ({
  page,
}, info) => {
  const { url } = await setup(page, info, 'talk-look');
  await openTask(page, url);
  await post(page, `Long unbroken text ${'abcdefghij'.repeat(30)} and more words to wrap.`);
  await expect(card(page, 'Comments').getByText(/Long unbroken text/)).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.reload();
  await expect(card(page, 'Comments').getByText(/Long unbroken text/)).toBeVisible();
  await expectAccessible(page, 'comments, forced colours and reduced motion');
  const reaction = card(page, 'Comments').getByRole('button', { name: 'Heart' });
  await reaction.click();
  await expect(card(page, 'Comments').getByRole('button', { name: 'Heart, 1' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });
  const size = page.viewportSize()!;
  for (const width of [320, 640, Math.max(320, Math.floor(size.width / 2))]) {
    await page.setViewportSize({ width, height: size.height });
    await page.goto(url);
    await expect(card(page, 'Comments')).toBeVisible();
    await expect(page.getByText(/^Loading/)).toHaveCount(0);
    expect(await noHorizontalOverflow(page), `task page at ${width}px`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 320, height: size.height });
  await page.goto(url);
  await page.getByRole('button', { name: 'Request review…' }).click();
  await expectAccessible(page, 'request dialog at 320 px');
  expect(await noHorizontalOverflow(page), 'request dialog at 320px').toBeLessThanOrEqual(0);
});

/** Moves focus with Tab until the focused element matches; fails if it never does. */
async function tabTo(page: Page, test: string, max = 400) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate<boolean>(`((el) => ${test})(document.activeElement)`)) return;
  }
  throw new Error('keyboard focus never reached the control');
}

test('keyboard only: composer, post, react, follow, and an offline retry', async ({
  page,
  context,
}, info) => {
  const { url } = await setup(page, info, 'talk-kb');
  await openTask(page, url);
  await page.getByRole('heading', { level: 1 }).focus();
  await tabTo(page, "el.tagName === 'TEXTAREA' && el.id.endsWith('-text')");
  await page.keyboard.type('Typed with the keyboard alone');
  await page.keyboard.press('Control+Enter');
  const comments = card(page, 'Comments');
  await expect(comments.getByText('Typed with the keyboard alone')).toBeVisible();
  await expect(page.getByLabel('Add a comment', { exact: true })).toHaveValue('');

  await tabTo(
    page,
    "el.getAttribute('aria-label') === 'Thumbs up' && el.getAttribute('aria-pressed') === 'false'",
  );
  await page.keyboard.press('Space');
  await expect(comments.getByRole('button', { name: 'Thumbs up, 1' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('Space');
  await expect(comments.getByRole('button', { name: 'Thumbs up' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  await page.getByRole('heading', { level: 1 }).focus();
  await tabTo(page, "el.classList.contains('follow-button')");
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Follow', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Offline: the text stays, Retry sends it once the connection is back.
  await page.getByLabel('Add a comment', { exact: true }).fill('Written while offline');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Post comment' }).click();
  const problem = page.getByRole('alert').filter({ hasText: /offline|connection/i });
  await expect(problem).toBeVisible();
  await expect(page.getByLabel('Add a comment', { exact: true })).toHaveValue(
    'Written while offline',
  );
  await expectAccessible(page, 'offline retry');
  await context.setOffline(false);
  await problem.getByRole('button', { name: 'Retry' }).click();
  await expect(comments.getByText('Written while offline')).toBeVisible();
});

test('a read-only member and a share-only guest see only what they may', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180_000);
  const { ws, base, task, url } = await setup(page, info, 'talk-ro');
  await openTask(page, url);
  await post(page, 'A note from the founder.');
  await expect(card(page, 'Comments').getByText('A note from the founder.')).toBeVisible();

  const reader = await person(browser, page, ws, info, 'talk-ro-r', 'Rae Reader', 'Read-only');
  await giveBrand(page, ws, 'Harbor', 'Rae Reader', 'view');
  const rp = reader.page;
  await openTask(rp, url);
  await expect(card(rp, 'Comments').getByText('A note from the founder.')).toBeVisible();
  await expect(rp.getByLabel('Add a comment', { exact: true })).toHaveCount(0);
  await expect(rp.getByText(/you can't add them/)).toBeVisible();
  await expect(rp.getByRole('button', { name: /^Reply/ })).toHaveCount(0);
  await expect(rp.getByRole('button', { name: 'Request review…' })).toHaveCount(0);
  await expect(rp.getByRole('button', { name: 'Hand over…' })).toHaveCount(0);
  await expectAccessible(rp, 'read-only member on the task');

  // The guest has a comment share on this one task: no picker, no reviews, no history.
  const guestEmail = uniqueEmail('talk-ro-g', info);
  await page.goto(url);
  await api(page, 'POST', `${base}/invitations`, {
    email: guestEmail,
    kind: 'guest',
    records: [{ record: task.id, level: 'comment' }],
  });
  const gctx = await browser.newContext();
  const gp = await gctx.newPage();
  await openLink(gp, linkPath(await waitForMail(guestEmail, 'invited')));
  await register(gp, guestEmail, 'Gus Guest');
  await verify(gp, guestEmail);
  await signedIn(gp, guestEmail);
  await gp.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(gp.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0);
  await expect(gp.getByText(/^Loading/)).toHaveCount(0);
  await openTask(gp, url);
  await expect(card(gp, 'Comments').getByText('A note from the founder.')).toBeVisible();
  const box = gp.getByLabel('Add a comment', { exact: true });
  await box.fill('Hello from a guest @');
  await expect(gp.getByRole('listbox')).toHaveCount(0);
  await box.fill('Hello from a guest');
  await gp.getByRole('button', { name: 'Post comment' }).click();
  await expect(card(gp, 'Comments').getByText('Hello from a guest')).toBeVisible();
  await expect(gp.getByRole('heading', { name: 'Review' })).toHaveCount(0);
  await expect(gp.getByRole('heading', { name: 'Assignment history' })).toHaveCount(0);
  await expect(gp.getByRole('button', { name: 'Followers' })).toHaveCount(0);
  await expectAccessible(gp, 'share-only guest on the task');
  await gctx.close();
  await reader.ctx.close();
});
