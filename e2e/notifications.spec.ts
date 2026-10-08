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
 * Phase 4B on desktop, tablet, and mobile (ADR-0024): a founder does things that notify a second
 * member (assign, mention, comment, review). The member sees the bell count, opens the centre,
 * works the four states, searches and groups, and changes their settings (profile, quiet hours,
 * digest, per-type choices, mutes). Browser notifications are only asked for on a click and are
 * shown and acknowledged. An administrator sees delivery health. A permission lost mid-session
 * leaves a row that says so. Every stage passes axe; the pages reflow at 320 px and 200% zoom, with
 * forced colours and reduced motion; and the centre works with the keyboard alone.
 *
 * Notifications come from the real fan-out in the worker process. Two things cannot be produced
 * against the e2e servers and are served by `page.route` instead, and say so where they do: a
 * workspace whose email provider is not configured (the e2e servers capture mail), and failed
 * email deliveries for the administrator's health list.
 */

// A stuck click fails in seconds with its call log, not after the whole test timeout.
test.use({ actionTimeout: 15_000 });

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });

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

async function removeBrand(page: Page, ws: string, brand: string, person: string) {
  await page.goto(`/workspaces/${ws}`);
  await page.getByRole('link', { name: `Settings for ${brand}` }).click();
  await page.getByRole('button', { name: `Remove access for ${person}` }).click();
  await page
    .getByRole('alertdialog', { name: 'Remove brand access?' })
    .getByRole('button', { name: 'Remove access' })
    .click();
  await expect(page.getByText('Access removed.')).toBeAttached();
}

interface Setup {
  ws: string;
  base: string;
  task: { id: string; version: number };
  me: string;
  milo: { ctx: BrowserContext; page: Page; id: string };
  centre: string;
  settings: string;
}

/** A founder with a brand and a task, and Milo, a member with edit access to that brand. */
async function setup(
  page: Page,
  browser: Browser,
  info: Parameters<typeof uniqueEmail>[1],
  prefix: string,
): Promise<Setup> {
  await owner(page, info, prefix, 'Fay Founder');
  const ws = await createWorkspace(page, 'Notify Co');
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
  const email = uniqueEmail(`${prefix}-milo`, info);
  await inviteMember(page, ws, email, 'Member');
  const ctx = await browser.newContext();
  const mp = await ctx.newPage();
  await accept(mp, email, 'Milo Member');
  await giveBrand(page, ws, 'Harbor', 'Milo Member', 'edit');
  const opts = await (await page.request.get(`${base}/views/options/task/assignee`)).json();
  const option = (label: string) =>
    opts.data.options.find((o: { label: string }) => o.label === label).value as string;
  return {
    ws,
    base,
    task: task as { id: string; version: number },
    me: option('Fay Founder'),
    milo: { ctx, page: mp, id: option('Milo Member') },
    centre: `/workspaces/${ws}/notifications`,
    settings: `/workspaces/${ws}/settings/notifications`,
  };
}

/** The founder assigns, mentions, comments, and asks Milo for a review: four things to be told of. */
async function notifyMilo(page: Page, s: Setup) {
  const fresh = async () =>
    (await (await page.request.get(`${s.base}/tasks/${s.task.id}`)).json()).data.version as number;
  await api(page, 'POST', `${s.base}/tasks/${s.task.id}:assign`, {
    assignees: [s.milo.id],
    primary: s.milo.id,
    version: await fresh(),
  });
  await api(page, 'POST', `${s.base}/records/${s.task.id}/comments`, {
    text: 'Please look at this @Milo Member',
    mentions: [{ kind: 'member', id: s.milo.id }],
  });
  await api(page, 'POST', `${s.base}/records/${s.task.id}/reviews`, {
    reviewers: [s.milo.id],
    rule: 'any',
    kind: 'review',
    message: 'Please review the copy.',
    subject_version: await fresh(),
  });
}

const counts = async (page: Page, s: Setup) =>
  (await (await page.request.get(`${s.base}/me/notifications/counts`)).json()).data as {
    unread: number;
    mentions_unread: number;
    reviews_unread: number;
  };

/** Waits for the worker's fan-out to deliver at least `n` unread to the person on `page`. */
async function waitForUnread(page: Page, s: Setup, n: number): Promise<number> {
  await expect
    .poll(async () => (await counts(page, s)).unread, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(n);
  return (await counts(page, s)).unread;
}

const bell = (page: Page, n?: number) =>
  n === undefined
    ? page.getByRole('button', { name: /^Notifications, \d+ unread$/ })
    : page.getByRole('button', { name: `Notifications, ${n} unread`, exact: true });

const rowWith = (page: Page, text: string | RegExp) =>
  page
    .getByRole('listitem')
    .filter({ hasText: text })
    .filter({ has: page.getByRole('group') })
    .first();

async function openCentre(page: Page, s: Setup, query = '') {
  await page.goto(`${s.centre}${query}`);
  await expect(h1(page)).toHaveText('Notifications');
  await expect(page.getByText('Loading notifications…')).toHaveCount(0);
}

async function openSettings(page: Page, s: Setup) {
  await page.goto(s.settings);
  await expect(h1(page)).toHaveText('Notification settings');
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Recent deliveries' })).toBeVisible();
}

test('the bell, the centre and the four states between two people', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(300_000);
  const s = await setup(page, browser, info, 'ntf');
  const mp = s.milo.page;
  await notifyMilo(page, s);
  const unread = await waitForUnread(mp, s, 4);

  // The bell says how many are unread; opening it lists the most recent and links on.
  await mp.goto(`/workspaces/${s.ws}/home`);
  await expect(bell(mp, unread)).toBeVisible();
  await bell(mp, unread).click();
  const recent = mp.getByRole('list', { name: 'Recent notifications' });
  await expect(recent.getByRole('listitem').first()).toBeVisible();
  expect(await recent.getByRole('listitem').count()).toBeLessThanOrEqual(5);
  await expect(recent.getByRole('link', { name: 'Write launch copy' }).first()).toBeVisible();
  await expectAccessible(mp, 'bell open with recent notifications');
  await mp.keyboard.press('Escape');
  await expect(bell(mp, unread)).toBeFocused();
  await bell(mp, unread).click();
  await mp.getByRole('link', { name: 'Open notification centre' }).click();
  await expect(h1(mp)).toHaveText('Notifications');
  await expect(mp).toHaveURL(new RegExp(`${s.centre}$`));
  await expect(mp.getByRole('listitem').filter({ hasText: 'mentioned you' }).first()).toBeVisible();
  await expectAccessible(mp, 'notification centre, all');

  // Tabs keep real link semantics; Mentions and Reviews narrow the list.
  const tabs = mp.getByRole('navigation', { name: 'Notifications' });
  await expect(tabs.getByRole('link', { name: /^All/ })).toHaveAttribute('aria-current', 'page');
  await tabs.getByRole('link', { name: /^Mentions/ }).click();
  await expect(tabs.getByRole('link', { name: /^Mentions/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(mp.getByRole('listitem').filter({ hasText: 'mentioned you' })).toHaveCount(1);
  await expect(
    mp
      .getByRole('listitem')
      .filter({ hasText: /review/i })
      .filter({ has: mp.getByRole('group') }),
  ).toHaveCount(0);
  await expectAccessible(mp, 'notification centre, mentions');
  await tabs.getByRole('link', { name: /^Reviews/ }).click();
  await expect(
    mp
      .getByRole('listitem')
      .filter({ hasText: /review/i })
      .first(),
  ).toBeVisible();
  await tabs.getByRole('link', { name: /^Saved/ }).click();
  await expect(mp.getByText(/Nothing saved/)).toBeVisible();

  // Mark read lowers the bell; Save moves it to Saved; Dismiss removes it and Show dismissed finds it.
  await tabs.getByRole('link', { name: /^Mentions/ }).click();
  const mention = rowWith(mp, 'mentioned you');
  await expect(mention.getByText('Unread')).toBeVisible();
  const before = (await counts(mp, s)).unread;
  await mention.getByRole('button', { name: 'Mark read' }).click();
  await expect(mention.getByRole('button', { name: 'Mark unread' })).toBeVisible();
  await expect(bell(mp, before - 1)).toBeVisible();
  await mention.getByRole('button', { name: 'Save' }).click();
  await expect(mention.getByRole('button', { name: 'Unsave' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await tabs.getByRole('link', { name: /^Saved/ }).click();
  await expect(rowWith(mp, 'mentioned you').locator('.ntf-state-saved')).toBeVisible();
  await expectAccessible(mp, 'notification centre, saved');
  await rowWith(mp, 'mentioned you').getByRole('button', { name: 'Unsave' }).click();
  await expect(mp.getByText(/Nothing saved/)).toBeVisible();
  await tabs.getByRole('link', { name: /^Mentions/ }).click();
  await rowWith(mp, 'mentioned you').getByRole('button', { name: 'Dismiss' }).click();
  await expect(mp.getByText('No mentions yet.', { exact: false })).toBeVisible();
  await expect(h1(mp)).toBeVisible();
  await mp.getByLabel('Show dismissed').check();
  const dismissed = rowWith(mp, 'mentioned you');
  await expect(dismissed.locator('.ntf-state', { hasText: 'Dismissed' })).toBeVisible();
  await expectAccessible(mp, 'notification centre, dismissed shown');
  await dismissed.getByRole('button', { name: 'Restore' }).click();
  await mp.getByLabel('Show dismissed').uncheck();
  await expect(rowWith(mp, 'mentioned you')).toBeVisible();

  // Search narrows the list and the count is announced; many comments show how many times.
  await tabs.getByRole('link', { name: /^All/ }).click();
  await mp.getByLabel('Search notifications', { exact: true }).fill('launch');
  await mp.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(mp).toHaveURL(/q=launch/);
  await expect(
    mp.getByRole('status').filter({ hasText: /notifications? match "launch"/ }),
  ).toBeAttached();
  await mp.getByLabel('Search notifications', { exact: true }).fill('zzzzzz');
  await mp.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(mp.getByText('No notifications match these filters.')).toBeVisible();
  await expect(
    mp.getByRole('status').filter({ hasText: 'No notifications match "zzzzzz".' }),
  ).toBeAttached();
  await expectAccessible(mp, 'notification centre, no search results');
  await mp.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rowWith(mp, 'mentioned you')).toBeVisible();

  for (const text of ['Second thought', 'Third thought', 'Fourth thought'])
    await api(page, 'POST', `${s.base}/records/${s.task.id}/comments`, { text, mentions: [] });
  await expect
    .poll(
      async () => {
        const r = await (await mp.request.get(`${s.base}/me/notifications?q=comment`)).json();
        return JSON.stringify(r.data.map((n: { occurrences: number }) => n.occurrences));
      },
      { timeout: 30_000 },
    )
    .toMatch(/[2-9]/);
  await mp.reload();
  await expect(mp.getByText(/\(\d+ times\)/).first()).toBeVisible();
  await mp.getByLabel('Group similar').check();
  await expect(mp).toHaveURL(/group=true/);
  await expect(mp.getByText('Loading notifications…')).toHaveCount(0);
  await expectAccessible(mp, 'notification centre, grouped');
  await mp.getByLabel('Group similar').uncheck();

  // Bulk: select every row and mark them read; the bell reaches zero.
  await mp.getByLabel('Select all shown').check();
  await mp.getByRole('button', { name: 'Mark selected read' }).click();
  await expect(bell(mp, 0)).toBeVisible();
  await expect(mp.locator('.ntf-state-unread')).toHaveCount(0);
  await expectAccessible(mp, 'notification centre, all read');
  await s.milo.ctx.close();
});

test('a permission lost while the centre is open leaves a row that says so', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(300_000);
  const s = await setup(page, browser, info, 'ntf-perm');
  const mp = s.milo.page;
  await notifyMilo(page, s);
  await waitForUnread(mp, s, 4);
  await openCentre(mp, s);
  await expect(
    rowWith(mp, 'mentioned you').getByRole('link', { name: 'Write launch copy' }),
  ).toBeVisible();

  await removeBrand(page, s.ws, 'Harbor', 'Milo Member');
  await expect
    .poll(async () => (await mp.request.get(`${s.base}/tasks/${s.task.id}`)).status(), {
      timeout: 30_000,
    })
    .toBe(404);

  // The row on screen is stale; after a refresh it says only what the server says.
  await mp.reload();
  const gone = mp
    .getByRole('listitem')
    .filter({ hasText: 'You no longer have access to this item' })
    .first();
  await expect(gone).toBeVisible();
  await expect(gone.getByRole('link')).toHaveCount(0);
  await expect(gone.locator('time')).toBeVisible();
  await expect(gone.getByRole('button', { name: 'Mark read' })).toBeVisible();
  await expect(mp.getByText('Write launch copy')).toHaveCount(0);
  await expectAccessible(mp, 'a row whose access was lost');
  const unavailable = mp.getByRole('listitem').filter({
    hasText: 'You no longer have access to this item',
    has: mp.getByRole('group'),
  });
  const left = await unavailable.count();
  expect(left).toBeGreaterThan(0);
  await gone.getByRole('button', { name: 'Dismiss' }).click();
  await expect(unavailable).toHaveCount(left - 1);
  await s.milo.ctx.close();
});

test('settings: profile, quiet hours, digest, per-type choices, mutes, and delivery history', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(300_000);
  const s = await setup(page, browser, info, 'ntf-set');
  const mp = s.milo.page;
  await openSettings(mp, s);
  await expectAccessible(mp, 'notification settings');

  // Email is captured, not delivered, in the e2e servers, and the page says so.
  await expect(mp.getByText(/Email is in test mode/).first()).toBeVisible();

  // Profile: time zone, quiet hours (with their note), weekly digest; saved and still there after a reload.
  await mp.getByLabel('Time zone').selectOption('Europe/Paris');
  await mp.getByLabel('Hold email and browser notifications during quiet hours').check();
  await expect(mp.getByText(/Security notices and the in-app centre are never held/)).toBeVisible();
  await mp.getByLabel('Quiet hours start').fill('21:30');
  await mp.getByLabel('Quiet hours end').fill('06:45');
  await mp.getByLabel('Send me a digest').selectOption('weekly');
  await mp.getByLabel('Weekly digest day').selectOption({ label: 'Friday' });
  await mp.getByLabel('Weekly digest time').fill('10:15');
  await expect(mp.getByText(/one digest at a time/)).toBeVisible();
  await expectAccessible(mp, 'settings with quiet hours and weekly digest');
  await mp.getByRole('button', { name: 'Save settings' }).click();
  await expect(mp.getByRole('status').filter({ hasText: 'Saved.' })).toBeAttached();
  await mp.reload();
  await expect(mp.getByLabel('Time zone')).toHaveValue('Europe/Paris');
  await expect(mp.getByLabel('Quiet hours start')).toHaveValue('21:30');
  await expect(mp.getByLabel('Weekly digest day')).toHaveValue('5');
  await expect(mp.getByLabel('Weekly digest time')).toHaveValue('10:15');

  // Equal quiet-hour times are refused on the page, in words.
  await mp.getByLabel('Quiet hours end').fill('21:30');
  await mp.getByRole('button', { name: 'Save settings' }).click();
  await expect(mp.getByText(/different start and end times/)).toBeVisible();
  await mp.getByLabel('Quiet hours end').fill('06:45');

  // A second tab changes the profile; saving here reloads, keeps the edits, and the next save works.
  const other = await s.milo.ctx.newPage();
  await openSettings(other, s);
  await other.getByLabel('Email me notifications').uncheck();
  await other.getByRole('button', { name: 'Save settings' }).click();
  await expect(other.getByRole('status').filter({ hasText: 'Saved.' })).toBeAttached();
  await other.close();
  await mp.getByLabel('Send me a digest').selectOption('daily');
  await mp.getByRole('button', { name: 'Save settings' }).click();
  await expect(mp.getByRole('alert')).toContainText('kept your edits');
  await expectAccessible(mp, 'settings after a stale save');
  await expect(mp.getByLabel('Send me a digest')).toHaveValue('daily');
  await mp.getByRole('button', { name: 'Save settings' }).click();
  await expect(mp.getByRole('status').filter({ hasText: 'Saved.' })).toBeAttached();
  await mp.reload();
  await expect(mp.getByLabel('Send me a digest')).toHaveValue('daily');
  await expect(mp.getByLabel('Email me notifications')).not.toBeChecked();

  // Per-type choices: security types are always on; a change survives a reload and clears again.
  await expect(mp.getByText("Always on. Security notices can't be muted.").first()).toBeVisible();
  const email = mp.getByLabel('Email for Comment', { exact: true });
  await expect(email).toHaveValue('default');
  await email.selectOption('muted');
  await expect(mp.getByRole('status').filter({ hasText: 'Saved.' }).last()).toBeAttached();
  await mp.reload();
  await expect(mp.getByLabel('Email for Comment', { exact: true })).toHaveValue('muted');
  await mp.getByLabel('Email for Comment', { exact: true }).selectOption('default');
  await expect(mp.getByText(/0 of \d+ saved choices/)).toBeVisible();

  // Mutes: add one for the brand with an expiry, see it by name, remove it.
  await mp.getByLabel('Mute', { exact: true }).selectOption({ label: 'Harbor' });
  await mp.getByLabel('For how long').selectOption('day');
  await mp.getByRole('button', { name: 'Add mute' }).click();
  const mutes = mp.getByRole('list', { name: 'Your mutes' });
  await expect(mutes).toContainText('Brand: Harbor');
  await expect(mutes).toContainText('All notifications');
  await expect(mutes).toContainText('until');
  await expectAccessible(mp, 'settings with a mute');
  await mp.getByRole('button', { name: /^Remove mute: Brand: Harbor/ }).click();
  await expect(mp.getByText("You haven't muted anything.")).toBeVisible();

  // Delivery history never shows content, and delivery health is for administrators only.
  await expect(mp.getByRole('heading', { name: 'Delivery health' })).toHaveCount(0);
  await expectAccessible(mp, 'settings, member view');
  await s.milo.ctx.close();
});

test('email that is not set up is said plainly (served by the browser, the e2e servers capture mail)', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(240_000);
  const s = await setup(page, browser, info, 'ntf-mail');
  await page.route(/\/me\/notification-profile$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const r = await route.fetch();
    const json = await r.json();
    json.data.channels.email = { state: 'not_configured', provider: 'unconfigured' };
    await route.fulfill({ response: r, json });
  });
  await openSettings(page, s);
  const note = "Email isn't set up for this workspace yet, so nothing is sent.";
  await expect(page.getByText(note).first()).toBeVisible();
  for (const name of ['Where you get notifications', 'Time, quiet hours, and digest'])
    await expect(page.getByRole('region', { name })).not.toContainText(/Email is on\.|test mode/);
  await expectAccessible(page, 'settings, email not configured');
  await s.milo.ctx.close();
});

test('browser notifications are asked for on a click, denied is explained, granted is shown and acknowledged', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(300_000);
  const s = await setup(page, browser, info, 'ntf-br');
  const mp = s.milo.page;

  // Denied path: nothing is asked until the click, and the page explains how to re-enable.
  await mp.addInitScript(`
    window.__asked = 0;
    window.Notification = class {
      static permission = 'default';
      static requestPermission() {
        window.__asked++;
        window.Notification.permission = 'denied';
        return Promise.resolve('denied');
      }
    };
  `);
  await openSettings(mp, s);
  expect(await mp.evaluate('window.__asked')).toBe(0);
  await expect(mp.getByRole('button', { name: 'Turn on browser notifications' })).toBeVisible();
  await expectAccessible(mp, 'browser notifications, not asked yet');
  await mp.getByRole('button', { name: 'Turn on browser notifications' }).click();
  await expect(
    mp.locator('.banner-title', {
      hasText: 'Your browser is blocking notifications for this site',
    }),
  ).toBeVisible();
  await expect(mp.getByText(/site settings/)).toBeVisible();
  await expect(mp.getByRole('button', { name: 'Turn on browser notifications' })).toHaveCount(0);
  expect(await mp.evaluate('window.__asked')).toBe(1);
  await expectAccessible(mp, 'browser notifications denied');
  const stored = await (await mp.request.get(`${s.base}/me/notification-profile`)).json();
  expect(stored.data.browser_permission).toBe('denied');

  // Granted path: a fresh page with a granted browser; the next notification is shown, then acknowledged.
  const ctx2 = await browser.newContext();
  const gp = await ctx2.newPage();
  await gp.addInitScript(`
    window.__shown = [];
    window.Notification = class {
      static permission = 'default';
      constructor(title, options) {
        window.__shown.push({ title, ...(options && options.tag ? { tag: options.tag } : {}) });
      }
      static requestPermission() {
        window.Notification.permission = 'granted';
        return Promise.resolve('granted');
      }
      close() {}
    };
  `);
  // Same person: sign in again in the new context.
  const meResp = await (await mp.request.get('/v1/auth/me')).json();
  await signedIn(gp, meResp.data.email);
  await gp.goto(s.settings);
  await expect(h1(gp)).toHaveText('Notification settings');
  await gp.getByRole('button', { name: 'Turn on browser notifications' }).click();
  await expect(
    gp.getByRole('status').filter({ hasText: 'Browser notifications are on.' }),
  ).toBeAttached();
  await expect(gp.getByRole('button', { name: 'Turn off browser notifications' })).toBeVisible();
  await expectAccessible(gp, 'browser notifications on');

  await api(page, 'POST', `${s.base}/records/${s.task.id}/comments`, {
    text: 'Look at the browser notification @Milo Member',
    mentions: [{ kind: 'member', id: s.milo.id }],
  });
  await expect
    .poll(
      async () => {
        await gp.evaluate("document.dispatchEvent(new Event('visibilitychange'))");
        return gp.evaluate('window.__shown.length');
      },
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    )
    .toBeGreaterThan(0);
  const shown = (await gp.evaluate('window.__shown')) as Array<{ title: string; tag?: string }>;
  expect(shown[0]!.tag).toMatch(/^ndl_/);
  // The server was told it was shown, so a later look finds nothing waiting.
  await expect
    .poll(
      async () =>
        (
          (await (await gp.request.get(`${s.base}/me/notifications/browser-pending`)).json())
            .data as unknown[]
        ).length,
    )
    .toBe(0);
  await expect(gp.getByRole('heading', { name: 'Recent deliveries' })).toBeVisible();
  await ctx2.close();
  await s.milo.ctx.close();
});

test('delivery health for administrators, with retry (failed deliveries are served by the browser)', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(300_000);
  const s = await setup(page, browser, info, 'ntf-health');
  const failed = {
    id: 'ndl_0123456789ABCDEFGHJKMNPQRS',
    type: 'notification_delivery',
    channel: 'email',
    kind: 'notification',
    state: 'dead',
    attempts: 5,
    failure_class: 'permanent',
    failure_code: 'provider_rejected',
    suppress_reason: null,
    notification: null,
    notification_type: 'mention',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    delivered_at: null,
    recipient: { id: 'mem_x', name: 'Milo Member' },
  };
  let retried = 0;
  await page.route(/\/workspaces\/[^/]+\/notification-deliveries(\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        data: retried ? [] : [failed],
        page: { limit: 10, has_more: false },
        email: 'configured',
        meta: {},
      },
    }),
  );
  await page.route(/\/notification-deliveries\/[^/]+\/retry$/, (route) => {
    retried++;
    return route.fulfill({
      json: { data: { id: failed.id, type: 'notification_delivery', state: 'pending' }, meta: {} },
    });
  });
  await openSettings(page, s);
  const section = page
    .getByRole('heading', { name: 'Delivery health' })
    .locator('xpath=ancestor::section[1]');
  await expect(section.getByText(/Email is set up and sending/)).toBeVisible();
  await expect(section.getByRole('list', { name: 'Failed deliveries' })).toContainText(
    'Milo Member · Email · Mention · Failed, no more tries · A permanent problem: The provider rejected it · 5 attempts',
  );
  await expectAccessible(page, 'delivery health');
  await section.getByRole('button', { name: /^Retry delivery to Milo Member/ }).click();
  await expect(
    section.getByRole('status').filter({ hasText: /Queued again for Milo Member/ }),
  ).toBeAttached();
  await expect(section.getByText('No deliveries have failed.')).toBeVisible();
  expect(retried).toBe(1);
  await expectAccessible(page, 'delivery health after retry');

  // The real endpoint refuses the member, so the section never appears for them.
  const refused = await s.milo.page.request.get(`${s.base}/notification-deliveries`);
  expect(refused.status()).toBe(403);
  await s.milo.ctx.close();
});

test('offline: the centre explains, puts a change back, and Retry works when the connection returns', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(300_000);
  const s = await setup(page, browser, info, 'ntf-off');
  const mp = s.milo.page;
  await notifyMilo(page, s);
  await waitForUnread(mp, s, 4);
  await openCentre(mp, s);
  const row = rowWith(mp, 'mentioned you');
  await expect(row.getByText('Unread')).toBeVisible();
  await s.milo.ctx.setOffline(true);
  await expect(mp.getByText(/You're offline\. What you see may be out of date/)).toBeVisible();
  await row.getByRole('button', { name: 'Mark read' }).click();
  const problem = mp.getByRole('alert').filter({ hasText: /offline/i });
  await expect(problem).toBeVisible();
  await expect(row.getByText('Unread')).toBeVisible(); // put back
  await expectAccessible(mp, 'centre offline');
  await s.milo.ctx.setOffline(false);
  await problem.getByRole('button', { name: 'Retry' }).click();
  await expect(row.getByRole('button', { name: 'Mark unread' })).toBeVisible();
  await expect(mp.getByRole('alert')).toHaveCount(0);

  // Settings offline: edits stay on the page, and Save works once the connection returns.
  await openSettings(mp, s);
  await mp.getByLabel('Send me a digest').selectOption('off');
  await s.milo.ctx.setOffline(true);
  await mp.getByRole('button', { name: 'Save settings' }).click();
  const saveProblem = mp.getByRole('alert').filter({ hasText: /Your edits are kept here/ });
  await expect(saveProblem).toBeVisible();
  await expect(mp.getByLabel('Send me a digest')).toHaveValue('off');
  await s.milo.ctx.setOffline(false);
  await saveProblem.getByRole('button', { name: 'Retry' }).click();
  await expect(mp.getByRole('status').filter({ hasText: 'Saved.' })).toBeAttached();
  await s.milo.ctx.close();
});

test('appearance and reflow: forced colours, reduced motion, 320 px, and 200% zoom', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(300_000);
  const s = await setup(page, browser, info, 'ntf-look');
  const mp = s.milo.page;
  await notifyMilo(page, s);
  await waitForUnread(mp, s, 4);
  await openCentre(mp, s);
  await mp.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await mp.reload();
  await expect(rowWith(mp, 'mentioned you')).toBeVisible();
  await expectAccessible(mp, 'centre, forced colours and reduced motion');
  await mp.goto(s.settings);
  await expect(mp.getByRole('heading', { name: 'Recent deliveries' })).toBeVisible();
  await expectAccessible(mp, 'settings, forced colours and reduced motion');
  await mp.emulateMedia({ reducedMotion: null, forcedColors: null });

  const size = mp.viewportSize()!;
  for (const width of [320, 640, Math.max(320, Math.floor(size.width / 2))]) {
    await mp.setViewportSize({ width, height: size.height });
    for (const url of [s.centre, s.settings]) {
      await mp.goto(url);
      await expect(mp.getByText(/^Loading/)).toHaveCount(0);
      await expect(mp.getByRole('listitem').first()).toBeVisible();
      expect(await noHorizontalOverflow(mp), `${url} at ${width}px`).toBeLessThanOrEqual(0);
    }
  }
  await mp.setViewportSize({ width: 320, height: size.height });
  await mp.goto(s.centre);
  await expect(rowWith(mp, 'mentioned you')).toBeVisible();
  await expectAccessible(mp, 'centre at 320 px');
  await bell(mp).click();
  await expect(mp.getByRole('list', { name: 'Recent notifications' })).toBeVisible();
  await expectAccessible(mp, 'bell open at 320 px');
  expect(await noHorizontalOverflow(mp), 'bell open at 320px').toBeLessThanOrEqual(0);
  await s.milo.ctx.close();
});

/** Moves focus with Tab until the focused element matches; fails if it never does. */
async function tabTo(page: Page, test: string, max = 400) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate<boolean>(`((el) => ${test})(document.activeElement)`)) return;
  }
  throw new Error('keyboard focus never reached the control');
}

test('keyboard only: the bell, the centre rows, a bulk action, and the settings form', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(300_000);
  const s = await setup(page, browser, info, 'ntf-kb');
  const mp = s.milo.page;
  await notifyMilo(page, s);
  const unread = await waitForUnread(mp, s, 4);
  await openCentre(mp, s);

  // The bell opens with Enter, lists, and Escape returns focus to it.
  await mp.getByRole('heading', { level: 1 }).focus();
  await tabTo(mp, "el.getAttribute('aria-label') === 'Notifications, " + unread + " unread'");
  await mp.keyboard.press('Enter');
  await expect(mp.getByRole('list', { name: 'Recent notifications' })).toBeVisible();
  await mp.keyboard.press('Escape');
  await expect(bell(mp, unread)).toBeFocused();

  // A row's actions are reachable in order and work with Enter; focus moves on after a dismiss.
  await mp.getByRole('heading', { level: 1 }).focus();
  await tabTo(mp, "el.textContent === 'Mark read' && el.closest('[role=group]') !== null");
  await mp.keyboard.press('Enter');
  await expect(bell(mp, unread - 1)).toBeVisible();
  await tabTo(mp, "el.textContent === 'Dismiss' && el.closest('li') !== null");
  const dismissedId = await mp.evaluate("document.activeElement.closest('li').id");
  await mp.keyboard.press('Enter');
  await expect(mp.locator(`#${dismissedId}`)).toHaveCount(0);
  await expect
    .poll(() =>
      mp.evaluate("document.activeElement && document.activeElement.id.startsWith('ntf-row-')"),
    )
    .toBe(true);

  // Select a row with Space and act on the selection with Enter.
  await tabTo(mp, "el.type === 'checkbox' && el.classList.contains('ntf-check')");
  await mp.keyboard.press('Space');
  await expect(mp.getByText('1 selected')).toBeVisible();
  await tabTo(mp, "el.textContent === 'Dismiss selected'");
  await mp.keyboard.press('Enter');
  await expect(mp.getByText('1 selected')).toHaveCount(0);
  await expect(mp.getByRole('heading', { level: 2, name: 'All' })).toBeFocused();

  // Settings: tab to the digest select, change it with the keyboard, and save with Enter.
  await mp.goto(s.settings);
  await expect(mp.getByRole('heading', { name: 'Recent deliveries' })).toBeVisible();
  await mp.getByRole('heading', { level: 1 }).focus();
  await tabTo(mp, "el.id === 'nset-cadence'");
  await mp.keyboard.press('w'); // type-ahead picks Weekly without opening the list
  await expect(mp.getByLabel('Send me a digest')).toHaveValue('weekly');
  await tabTo(mp, "el.textContent === 'Save settings'");
  await mp.keyboard.press('Enter');
  await expect(mp.getByRole('status').filter({ hasText: 'Saved.' })).toBeAttached();
  await s.milo.ctx.close();
});
