import { expect, test, type Page } from '@playwright/test';
import {
  createBrand,
  createWorkspace,
  expectAccessible,
  goTo,
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
 * Phase 3C on desktop, tablet, and mobile: a founder adds tasks to Today from the task page and
 * from Today's lists, orders and locks them by keyboard, schedules a protected focus block (an
 * overlapping block is refused), sees nothing change on the task's dates, goes offline without
 * losing the day, shuts the day down carrying unfinished work to tomorrow, and finds it there.
 * Every stage passes axe; pages reflow at 320 px, the width-class edges, and 200% zoom, with forced
 * colours and reduced motion. A teammate who loses brand access no longer sees that work in Today.
 */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

async function founder(page: Page, info: Parameters<typeof owner>[1], prefix: string) {
  await owner(page, info, prefix, 'Dana Day');
  const ws = await createWorkspace(page, 'Plans Co');
  await createBrand(page, 'Harbor');
  await page.goto(`/workspaces/${ws}/projects`);
  await page.getByRole('button', { name: 'Create a project' }).click();
  const create = page.getByRole('dialog', { name: 'Create project' });
  await create.getByLabel(/^Project name/).fill('Launch');
  await create.getByRole('button', { name: 'Create project' }).click();
  await expect(h1(page)).toHaveText('Launch');
  const prj = /\/projects\/(prj_[0-9A-Z]{26})$/.exec(page.url())![1]!;
  await page.goto(`/workspaces/${ws}/projects/${prj}/tasks`);
  for (const title of ['Write copy', 'Review deck']) {
    await page.getByLabel('New task').fill(title);
    await page.getByRole('button', { name: 'Add task' }).click();
    await expect(page.getByRole('treeitem', { name: new RegExp(title) })).toBeVisible();
  }
  const ids: string[] = [];
  for (const title of ['Write copy', 'Review deck']) {
    await page.goto(`/workspaces/${ws}/projects/${prj}/tasks`);
    await page
      .getByRole('tree')
      .getByRole('treeitem', { name: new RegExp(title) })
      .focus();
    await page.keyboard.press('Enter');
    await expect(h1(page)).toHaveText(title);
    ids.push(/\/tasks\/(tsk_[0-9A-Z]{26})$/.exec(page.url())![1]!);
  }
  return { ws, prj, ids };
}

test('plan the day: commit, order, lock, focus block, offline, shut down, and carry over', async ({
  page,
}, info) => {
  const { ws, ids } = await founder(page, info, 'today-day');
  // Add both tasks from their pages (the Plan panel); dates never change.
  for (const id of ids) {
    await page.goto(`/workspaces/${ws}/tasks/${id}`);
    const plan = region(page, 'Plan');
    await expect(plan.getByText('Planning never changes the due date or deadline.')).toBeVisible();
    await plan.getByRole('button', { name: 'Add to today' }).click();
    await expect(page.getByText('Added to today.')).toBeAttached();
  }
  await expectAccessible(page, 'task plan panel');
  await goTo(page, 'Today');
  await expect(h1(page)).toHaveText('Today');
  const committed = page.getByRole('list', { name: 'Committed tasks in order' });
  await expect(committed.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByText(/arrive with capacity planning \(3E\)/)).toBeVisible();
  await expectAccessible(page, 'today');
  // Keyboard only: move Review deck to the top, then lock it.
  await committed.getByRole('button', { name: 'Move up Review deck' }).focus();
  await page.keyboard.press('Enter');
  await expect(committed.getByRole('listitem').first()).toContainText('Review deck');
  await committed.getByRole('button', { name: 'Lock Review deck' }).focus();
  await page.keyboard.press('Enter');
  await expect(committed.getByRole('button', { name: 'Unlock Review deck' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(committed.getByRole('button', { name: 'Remove Review deck' })).toBeDisabled();
  // A protected focus block, and a refused overlap.
  const scheduled = region(page, 'Scheduled');
  const form = page.getByRole('form', { name: 'Schedule a block' });
  await form.getByLabel('For').selectOption({ label: 'Write copy' });
  await form.getByLabel('Start').fill('09:00');
  await form.getByLabel('Minutes').fill('60');
  await form.getByLabel('Focus block (protected)').check();
  await form.getByRole('button', { name: 'Schedule' }).click();
  await expect(scheduled.getByText('Focus')).toBeVisible();
  await form.getByLabel('For').selectOption({ label: 'Something else (name it)' });
  await form.getByLabel('Name').fill('Call');
  await form.getByLabel('Start').fill('09:30');
  await form.getByLabel('Minutes').fill('30');
  await form.getByLabel('Focus block (protected)').uncheck();
  await form.getByRole('button', { name: 'Schedule' }).click();
  await expect(form.getByRole('alert')).toHaveText(/overlaps a focus block/);
  // Audit from the top of the page: axe's target-size check counts controls scrolled under the
  // sticky header as obscured (they are full size when on screen).
  await page.evaluate('window.scrollTo(0, 0)');
  await expectAccessible(page, 'today with blocks');
  // Offline: the day stays on screen and a change explains itself.
  await page.context().setOffline(true);
  await committed.getByRole('button', { name: 'Unlock Review deck' }).click();
  await expect(page.getByText(/You're offline/).first()).toBeVisible();
  await page.context().setOffline(false);
  await expect(committed.getByRole('listitem')).toHaveCount(2);
  // Shut down: Write copy carries to tomorrow; the locked Review deck stays.
  await page.getByRole('button', { name: 'Shut down the day…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Shut down the day' });
  await expectAccessible(page, 'shutdown');
  await dialog.getByRole('button', { name: 'Close the day' }).click();
  await expect(page.getByText(/Day closed: 0 done, 1 carried over/)).toBeAttached();
  await expect(page.getByText('This day is closed')).toBeVisible();
  await page.getByRole('button', { name: 'Next day' }).first().click();
  await expect(committed.getByRole('listitem')).toHaveCount(1);
  await expect(committed).toContainText('Write copy');
  await expect(committed).toContainText('carried over');
  // Appearance and reflow.
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.goto(`/workspaces/${ws}/today`);
  await expect(h1(page)).toHaveText('Today');
  await expectAccessible(page, 'today, forced colours');
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });
  const size = page.viewportSize()!;
  for (const width of [320, 599, 600, 1023, 1024, Math.max(320, Math.floor(size.width / 2))])
    for (const path of ['today', `tasks/${ids[0]}`]) {
      await page.setViewportSize({ width, height: size.height });
      await page.goto(`/workspaces/${ws}/${path}`);
      await expect(h1(page)).not.toHaveText('');
      await expect(page.getByText(/^Loading/)).toHaveCount(0);
      expect(await noHorizontalOverflow(page), `${path} at ${width}px`).toBeLessThanOrEqual(0);
    }
});

test('a teammate who loses brand access no longer sees that work in Today @desktop-only', async ({
  page,
  browser,
}, info) => {
  const { ws, ids } = await founder(page, info, 'today-revoke');
  const email = uniqueEmail('today-mate', info);
  await page.goto(`/workspaces/${ws}/people/invite`);
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel('Role').selectOption({ label: 'Member' });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(h1(page)).toHaveText('People');
  const other = await browser.newContext();
  const mate = await other.newPage();
  await openLink(mate, linkPath(await waitForMail(email, 'invited')));
  await register(mate, email, 'Milo Mate');
  await verify(mate, email);
  await signedIn(mate, email);
  await mate.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(h1(mate)).toHaveText('Plans Co');
  await page.goto(`/workspaces/${ws}`);
  await page.getByRole('link', { name: 'Settings for Harbor' }).click();
  const access = page.getByRole('region', { name: 'Who has access' });
  await access.getByLabel('Give access to').selectOption({ label: 'Milo Mate' });
  await access.getByLabel('Access level').selectOption('edit');
  await access.getByRole('button', { name: 'Review access…' }).click();
  await page
    .getByRole('dialog', { name: 'Give brand access?' })
    .getByRole('button', { name: 'Give access' })
    .click();
  await expect(page.getByText('Access given.')).toBeAttached();
  await mate.goto(`/workspaces/${ws}/tasks/${ids[0]}`);
  await region(mate, 'Plan').getByRole('button', { name: 'Add to today' }).click();
  await expect(mate.getByText('Added to today.')).toBeAttached();
  await mate.goto(`/workspaces/${ws}/today`);
  await expect(mate.getByRole('list', { name: 'Committed tasks in order' })).toContainText(
    'Write copy',
  );
  // The owner removes Harbor access; the teammate's next load omits the work entirely.
  await access.getByRole('button', { name: 'Remove access for Milo Mate' }).click();
  await page
    .getByRole('alertdialog', { name: 'Remove brand access?' })
    .getByRole('button', { name: 'Remove access' })
    .click();
  await expect(page.getByText('Access removed.')).toBeAttached();
  await mate.reload();
  await expect(h1(mate)).toHaveText('Today');
  await expect(mate.getByText('Nothing committed yet.', { exact: false })).toBeVisible();
  await expect(mate.getByRole('main')).not.toContainText('Write copy');
  await expectAccessible(mate, 'today after revocation');
  await other.close();
});
