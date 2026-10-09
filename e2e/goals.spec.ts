import { expect, test, type Page } from '@playwright/test';
import {
  expectAccessible,
  goTo,
  linkPath,
  noHorizontalOverflow,
  openLink,
  register,
  signedIn,
  uniqueEmail,
  verify,
  waitForMail,
} from './support.ts';
import {
  accessible,
  api,
  get,
  giveBrand,
  h1,
  person,
  progressOf,
  seed,
  thisQuarter,
} from './goals-support.ts';

/**
 * Phase 5B on desktop and tablet (ADR-0028): a founder creates a goal, key results, links, and
 * check-ins and sees progress with its rule; a second member with narrower access sees a smaller
 * progress figure and no hidden project names; a guest sees no Goals navigation; the portfolio
 * overview, dependencies, and goal coverage render and pass axe at desktop width, 320 px, and 200%
 * zoom, with forced colours and reduced motion, and are operable by keyboard alone.
 */

const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

async function reflow(page: Page, url: string, ready: () => Promise<void>, label: string) {
  const size = page.viewportSize()!;
  // 320 px, and 640 px for 200% zoom of a 1280 px window.
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: size.height });
    await page.goto(url);
    await ready();
    await expect(page.getByText(/^Loading/)).toHaveCount(0);
    expect(await noHorizontalOverflow(page), `${label} at ${width}px`).toBeLessThanOrEqual(0);
    await accessible(page, `${label} at ${width}px`);
  }
  await page.setViewportSize(size);
}

test('a founder creates a goal with key results, links, and check-ins and sees how progress is made @desktop-only', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  const s = await seed(page, info, 'goals');
  await page.goto(`/workspaces/${s.ws}/home`);
  await goTo(page, 'Goals');
  await expect(h1(page)).toHaveText('Goals');
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
  await accessible(page, 'goals, empty');

  // Create a workspace goal whose progress is the average of its key results.
  await page.getByRole('button', { name: 'Create goal' }).first().click();
  const create = page.getByRole('dialog', { name: 'Create goal' });
  await create.getByLabel(/^Title/).fill('Grow signups');
  await create.getByRole('radio', { name: 'Average of key results' }).check();
  await create.getByRole('button', { name: 'Create goal' }).click();
  await expect(h1(page)).toHaveText('Grow signups');
  await accessible(page, 'new goal');

  // A measured key result: 100 of 1,000 is 10%.
  await page.getByRole('button', { name: 'Add key result' }).click();
  const kr = page.getByRole('dialog', { name: 'Add key result' });
  await kr.getByLabel(/^Title/).fill('Reach 1,000 users');
  await kr.getByLabel(/^Unit/).fill('users');
  await kr.getByLabel('Baseline').fill('0');
  await kr.getByLabel('Target').fill('1000');
  await kr.getByLabel('Starting value').fill('100');
  await kr.getByRole('button', { name: 'Add key result' }).click();
  await expect(page.getByRole('heading', { level: 3, name: 'Reach 1,000 users' })).toBeVisible();
  expect(await progressOf(page, 'Progress of key result Reach 1,000 users')).toBe(10);

  // A check-in on it moves the figure to 40%.
  await page.getByRole('button', { name: 'Check in on Reach 1,000 users' }).click();
  const ci = page.getByRole('dialog', { name: 'Check in: Reach 1,000 users' });
  await ci.getByLabel(/^New value/).fill('400');
  await ci.getByRole('button', { name: 'Record check-in' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => progressOf(page, 'Progress of key result Reach 1,000 users')).toBe(40);

  // A key result measured by linked work, linked to the project: 1 of 2 tasks done is 50%.
  await page.getByRole('button', { name: 'Add key result' }).click();
  const kr2 = page.getByRole('dialog', { name: 'Add key result' });
  await kr2.getByLabel(/^Title/).fill('Ship the site');
  await kr2.getByRole('radio', { name: 'Completion of linked work' }).check();
  await kr2.getByRole('button', { name: 'Add key result' }).click();
  await expect(page.getByRole('heading', { level: 3, name: 'Ship the site' })).toBeVisible();
  await page.getByRole('button', { name: 'Link work' }).click();
  const link = page.getByRole('dialog', { name: 'Link work' });
  await link
    .getByRole('combobox', { name: /^Project/ })
    .selectOption({ label: 'Launch site (Harbor)' });
  await link
    .getByRole('combobox', { name: 'Link to' })
    .selectOption({ label: 'Key result: Ship the site' });
  await link.getByRole('button', { name: 'Link work' }).click();
  await expect(region(page, 'Linked work')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Launch site' })).toBeVisible();
  await expect.poll(() => progressOf(page, 'Progress of key result Ship the site')).toBe(50);
  // The average of 40 and 50.
  await expect.poll(() => progressOf(page, 'Progress of Grow signups')).toBe(45);

  // Every figure has its rule in a disclosure; the linked-work one lists the tasks counted.
  const rule = page.getByText('How is this calculated?').first();
  await rule.click();
  await expect(page.getByText(/The plain average of the key results/)).toBeVisible();
  const ship = page.getByRole('heading', { level: 3, name: 'Ship the site' }).locator('xpath=..');
  await ship.getByText('How is this calculated?').click();
  await ship.getByRole('button', { name: 'Show the tasks counted' }).click();
  await expect(ship.getByRole('region', { name: 'Tasks counted' })).toContainText(
    'Draft the homepage',
  );
  await expect(ship.getByRole('region', { name: 'Tasks counted' })).toContainText(
    '1 of 2 tasks you can read are done.',
  );

  // A goal-level check-in, then the append-only history.
  const form = page.getByRole('form', { name: 'Record a check-in' });
  await form.getByRole('radio', { name: 'At risk' }).check();
  await form.getByLabel('Note (optional)').fill('Behind on ads');
  await form.getByRole('button', { name: 'Record check-in' }).click();
  const history = page.getByRole('list', { name: 'Check-in history, newest first' });
  await expect(history).toContainText('Behind on ads');
  await accessible(page, 'goal with key results and history');

  // Keyboard: the edit dialog opens from the keyboard, closes with Escape, and focus returns.
  const edit = page.getByRole('button', { name: 'Edit goal' });
  await edit.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Edit goal' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(edit).toBeFocused();

  // The list shows it with progress and a confidence chip; archive makes the goal read-only.
  await page.goto(`/workspaces/${s.ws}/goals`);
  await expect(page.getByRole('link', { name: 'Grow signups' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Progress of Grow signups' })).toBeVisible();
  await expect(page.locator('.gl-chip', { hasText: 'At risk' }).first()).toBeVisible();
  await accessible(page, 'goals list');
  await page.getByRole('link', { name: 'Grow signups' }).click();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: 'Archive this goal?' })
    .getByRole('button', { name: 'Archive goal' })
    .click();
  await expect(page.getByText('This goal is archived', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit goal' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Record check-in' })).toHaveCount(0);
  await accessible(page, 'archived goal');
  await page.getByRole('button', { name: 'Restore from archive' }).click();
  await expect(page.getByRole('button', { name: 'Edit goal' })).toBeVisible();

  // Trash: move to trash, find it in the Trash section, restore it, and open it again.
  await page.getByRole('button', { name: 'Move to trash' }).click();
  await page
    .getByRole('alertdialog', { name: 'Move this goal to trash?' })
    .getByRole('button', { name: 'Move to trash' })
    .click();
  await expect(h1(page)).toHaveText('Goals');
  await expect(page.getByRole('link', { name: 'Grow signups' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show trash' }).click();
  await page.getByRole('button', { name: 'Restore Grow signups' }).click();
  await expect(page.getByText('Restored Grow signups.')).toBeVisible();
  await accessible(page, 'goals with trash');
  await page.getByRole('link', { name: 'Grow signups' }).click();
  await expect(h1(page)).toHaveText('Grow signups');

  // Reflow.
  await reflow(page, page.url(), () => expect(h1(page)).toHaveText('Grow signups'), 'goal page');
  await reflow(
    page,
    `/workspaces/${s.ws}/goals`,
    () => expect(h1(page)).toHaveText('Goals'),
    'goals list',
  );
});

test('a member with narrower access sees a smaller figure and no hidden names; a guest sees no Goals @desktop-only', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(300_000);
  const s = await seed(page, info, 'goals-vis');
  const q = thisQuarter();
  const goal = await api(page, 'POST', `${s.base}/goals`, {
    title: 'Ship everything',
    status: 'active',
    period: q,
    basis: 'linked_work',
  });
  await api(page, 'POST', `${s.base}/goals/${goal.id}/links`, { target: s.site.id });
  await api(page, 'POST', `${s.base}/goals/${goal.id}/links`, { target: s.secret.id });

  // The founder sees both projects' tasks: 1 of 4 is 25%.
  await page.goto(`/workspaces/${s.ws}/goals/${goal.id}`);
  await expect(h1(page)).toHaveText('Ship everything');
  expect(await progressOf(page, 'Progress of Ship everything')).toBe(25);
  await expect(page.getByRole('link', { name: 'Secret roadmap project' })).toBeVisible();

  // A member who can read Harbor only sees 1 of 2 (50%), and nothing about the Vault project.
  const m = await person(browser, page, s.ws, info, 'goals-vis-m', 'Rae Reader', 'Member');
  await giveBrand(page, s.ws, 'Harbor', 'Rae Reader', 'view');
  const mp = m.page;
  await expect.poll(async () => (await get(mp, `${s.base}/goals/${goal.id}`)).status()).toBe(200);
  await mp.goto(`/workspaces/${s.ws}/goals/${goal.id}`);
  await expect(h1(mp)).toHaveText('Ship everything');
  await expect.poll(() => progressOf(mp, 'Progress of Ship everything')).toBe(50);
  await expect(mp.getByRole('link', { name: 'Launch site' })).toBeVisible();
  await expect(mp.getByText(/linked work you can see|1 linked/).first()).toBeVisible();
  for (const hidden of ['Secret', 'Vault'])
    expect(await mp.content(), hidden).not.toContain(hidden);
  await accessible(mp, 'narrower member, goal page');

  // The member's portfolio and goal coverage name only what they can read.
  await mp.goto(`/workspaces/${s.ws}/projects/portfolio`);
  await expect(mp.getByRole('link', { name: 'Launch site' })).toBeVisible();
  expect(await mp.content()).not.toContain('Secret');
  await mp.goto(`/workspaces/${s.ws}/projects/portfolio?view=orphans`);
  await expect(mp.getByText(/relative to you/)).toBeVisible();
  expect(await mp.content()).not.toContain('Secret');

  // A guest with a share on one task: no Goals or Portfolio navigation, and the API refuses.
  const guestEmail = uniqueEmail('goals-guest', info);
  await api(page, 'POST', `${s.base}/invitations`, {
    email: guestEmail,
    kind: 'guest',
    records: [{ record: s.site.tasks.open, level: 'read' }],
  });
  const gctx = await browser.newContext();
  const gp = await gctx.newPage();
  await openLink(gp, linkPath(await waitForMail(guestEmail, 'invited')));
  await register(gp, guestEmail, 'Gus Guest');
  await verify(gp, guestEmail);
  await signedIn(gp, guestEmail);
  await gp.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(gp).toHaveURL(/\/workspaces\/ws_/);
  await expect(gp.getByRole('navigation', { name: 'Primary' }).first()).toBeVisible();
  await expect(gp.getByRole('link', { name: 'Goals', exact: true })).toHaveCount(0);
  await expect(gp.getByRole('link', { name: 'Portfolio', exact: true })).toHaveCount(0);
  expect((await get(gp, `${s.base}/goals`)).status()).toBe(403);
  await gp.goto(`/workspaces/${s.ws}/goals`);
  await expect(h1(gp)).toHaveText("This page isn't available");
  await gp.goto(`/workspaces/${s.ws}/projects/portfolio`);
  await expect(h1(gp)).toHaveText("This page isn't available");
  await accessible(gp, 'guest, goals not available');

  // Revoked access: a Harbor goal is readable until the member loses Harbor; then its page is the
  // standard "not available" state and says nothing about what was there.
  const harborGoal = await api(page, 'POST', `${s.base}/goals`, {
    title: 'Harbor renewals',
    brand: s.harbor,
    status: 'active',
    period: q,
    basis: 'manual',
  });
  await mp.goto(`/workspaces/${s.ws}/goals/${harborGoal.id}`);
  await expect(h1(mp)).toHaveText('Harbor renewals');
  await giveBrandRemoved(page, s.ws, 'Rae Reader');
  await mp.reload();
  await expect(h1(mp)).toHaveText("This page isn't available");
  expect(await mp.content()).not.toContain('Harbor renewals');
  await m.ctx.close();
  await gctx.close();
});

async function giveBrandRemoved(page: Page, ws: string, who: string) {
  await page.goto(`/workspaces/${ws}`);
  await page.getByRole('link', { name: 'Settings for Harbor' }).click();
  const access = page.getByRole('region', { name: 'Who has access' });
  await access.getByRole('button', { name: `Remove access for ${who}` }).click();
  await page
    .getByRole('alertdialog', { name: 'Remove brand access?' })
    .getByRole('button', { name: 'Remove access' })
    .click();
  await expect(page.getByText('Access removed.')).toBeAttached();
}

test('the portfolio shows health with its rules, dependencies, and goal coverage, accessibly and by keyboard @desktop-only', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  const s = await seed(page, info, 'goals-pf', {
    start_date: '2025-12-01',
    target_date: '2026-01-15',
  });
  // A dependency between the two projects; the site's target date is past, so its health has a reason.
  await api(page, 'POST', `${s.base}/tasks/${s.secret.tasks[0]}/relationships`, {
    kind: 'blocks',
    target: s.site.tasks.open,
  });
  await page.goto(`/workspaces/${s.ws}/projects`);
  await page.getByRole('link', { name: 'Portfolio health' }).click();
  await expect(h1(page)).toHaveText('Portfolio');
  const table = page.getByRole('table');
  await expect(table).toBeVisible();
  await expect(
    page.getByText(/Covers the projects, tasks, goals, and time you can read/),
  ).toBeVisible();
  await expect(
    page.getByText('Money spend and AI usage are not tracked yet', { exact: false }),
  ).toBeVisible();
  await expect(table.getByRole('link', { name: 'Launch site' })).toBeVisible();

  // Keyboard only: the details button opens the rules behind a health value.
  const why = page.getByRole('button', { name: 'Why and details for Launch site' });
  await why.focus();
  await page.keyboard.press('Enter');
  await expect(why).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText(/target date \(2026-01-15\) passed/)).toBeVisible();
  await accessible(page, 'portfolio health, expanded');

  await page.getByRole('link', { name: 'Dependencies', exact: true }).click();
  await expect(page.getByText(/Only dependencies between work you can read/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Secret roadmap project' })).toBeVisible();
  await page.getByText('Show the task dependencies', { exact: false }).first().click();
  await expect(page.getByRole('link', { name: 'Secret task one' })).toBeVisible();
  await accessible(page, 'portfolio dependencies');

  await page.getByRole('link', { name: 'Goal coverage', exact: true }).click();
  await expect(page.getByText(/relative to you/)).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Projects without a goal you can see' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Launch site' })).toBeVisible();
  await accessible(page, 'portfolio goal coverage');

  // Saved portfolios: create one with keyboard and see its health.
  await page.getByRole('link', { name: 'Saved portfolios', exact: true }).click();
  await page.getByRole('button', { name: 'Create portfolio' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Create portfolio' });
  await dlg.getByLabel(/^Name/).fill('Q4 launches');
  await dlg.getByRole('checkbox', { name: /Launch site/ }).check();
  await dlg.getByRole('button', { name: 'Create portfolio' }).click();
  await expect(page.getByRole('heading', { level: 3, name: 'Q4 launches' })).toBeVisible();
  await accessible(page, 'saved portfolios');
  await page.getByRole('button', { name: 'View health of Q4 launches' }).click();
  await expect(page.getByText(/Showing the portfolio/)).toBeVisible();
  await expect(
    page.getByRole('table').getByRole('link', { name: 'Secret roadmap project' }),
  ).toHaveCount(0);

  // Appearance and reflow on every view.
  const base = `/workspaces/${s.ws}/projects/portfolio`;
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  for (const view of ['', '?view=dependencies', '?view=orphans']) {
    await page.goto(`${base}${view}`);
    await expect(h1(page)).toHaveText('Portfolio');
    await expect(page.getByText(/^Loading/)).toHaveCount(0);
    await expectAccessible(page, `portfolio ${view || 'health'}, forced colours`);
  }
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });
  for (const view of ['', '?view=dependencies', '?view=orphans'])
    await reflow(
      page,
      `${base}${view}`,
      () => expect(h1(page)).toHaveText('Portfolio'),
      `portfolio ${view || 'health'}`,
    );
});
