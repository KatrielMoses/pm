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
  PASSWORD,
  register,
  signedIn,
  uniqueEmail,
  verify,
  waitForMail,
} from './support.ts';

/**
 * Phase 3D on desktop, tablet, and mobile: a founder estimates a task, times it (pausing while
 * offline and recovering after a refresh), logs time with a typed duration, submits the week,
 * self-approves it in a one-person workspace (labelled), finds the time locked, unlocks it with a
 * reason and step-up, compares planned with actual, and downloads an export. Every stage passes
 * axe; pages reflow at 320 px, the width-class edges, and 200% zoom, with forced colours and
 * reduced motion; everything works by keyboard. A teammate whose role is lowered keeps seeing
 * their time but can no longer log or edit it.
 */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const timePanel = (page: Page) => page.getByRole('region', { name: 'Time', exact: true });

async function confirmStepUp(page: Page): Promise<void> {
  const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(stepUp).toBeVisible();
  await stepUp.getByLabel(/^Password/).fill(PASSWORD);
  await stepUp.getByRole('button', { name: 'Confirm' }).click();
  await expect(stepUp).toBeHidden();
}

async function founderWithTask(page: Page, info: Parameters<typeof owner>[1], prefix: string) {
  await owner(page, info, prefix, 'Tess Time');
  const ws = await createWorkspace(page, 'Hours Co');
  await createBrand(page, 'Harbor');
  await page.goto(`/workspaces/${ws}/projects`);
  await page.getByRole('button', { name: 'Create a project' }).click();
  const create = page.getByRole('dialog', { name: 'Create project' });
  await create.getByLabel(/^Project name/).fill('Launch');
  await create.getByRole('button', { name: 'Create project' }).click();
  await expect(h1(page)).toHaveText('Launch');
  const prj = /\/projects\/(prj_[0-9A-Z]{26})$/.exec(page.url())![1]!;
  await page.goto(`/workspaces/${ws}/projects/${prj}/tasks`);
  await page.getByLabel('New task').fill('Write copy');
  await page.getByRole('button', { name: 'Add task' }).click();
  await page
    .getByRole('tree')
    .getByRole('treeitem', { name: /Write copy/ })
    .focus();
  await page.keyboard.press('Enter');
  await expect(h1(page)).toHaveText('Write copy');
  const tsk = /\/tasks\/(tsk_[0-9A-Z]{26})$/.exec(page.url())![1]!;
  return { ws, prj, tsk };
}

test('estimate, time, log, submit, self-approve, lock, unlock, report, and export a week', async ({
  page,
}, info) => {
  const { ws, prj, tsk } = await founderWithTask(page, info, 'time-week');
  // Planned effort (TIME-003): the task estimate.
  await page.getByLabel('Estimate (minutes)', { exact: true }).fill('180');
  await page.getByRole('button', { name: 'Save task' }).click();
  await expect(
    timePanel(page).getByText('Estimate', { exact: true }).locator('xpath=..'),
  ).toContainText('3:00');
  await expectAccessible(page, 'task time panel');

  // Timer by keyboard: start, then recover it on the Time page after a refresh.
  await timePanel(page).getByRole('button', { name: 'Start timer' }).focus();
  await page.keyboard.press('Enter');
  await expect(timePanel(page).getByRole('button', { name: 'Stop timer' })).toBeVisible();
  await goTo(page, 'Time');
  await expect(h1(page)).toHaveText('Time');
  await page.reload();
  const timer = page.getByRole('region', { name: 'Timer' });
  await expect(timer.getByRole('link', { name: 'Write copy' })).toBeVisible();
  await expect(timer.getByRole('timer')).toHaveText(/^0:0\d:\d\d$/);
  await expect(timer.getByText('Running', { exact: true })).toBeVisible();
  await expectAccessible(page, 'time page with a running timer');

  // Offline pause is kept on the device and synced when the connection returns.
  await page.context().setOffline(true);
  await timer.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByText(/paused on this device/)).toBeAttached();
  await page.context().setOffline(false);
  await expect(timer.getByText('Paused', { exact: true })).toBeVisible();
  await timer.getByRole('button', { name: 'Stop and save' }).click();
  await expect(timer.getByText('No timer is running.')).toBeVisible();

  // Log time with a typed duration on the task (TSK-024, TSK-026).
  await page.goto(`/workspaces/${ws}/tasks/${tsk}`);
  await timePanel(page).locator('summary', { hasText: 'Log time' }).click();
  await timePanel(page)
    .getByLabel(/Time spent/)
    .fill('soon');
  await timePanel(page).getByRole('button', { name: 'Log time' }).click();
  await expect(timePanel(page).getByText(/Enter the time spent/)).toBeVisible();
  await timePanel(page)
    .getByLabel(/Time spent/)
    .fill('1:30');
  await timePanel(page).getByLabel('Billable').check();
  await timePanel(page).getByRole('button', { name: 'Log time' }).click();
  await expect(page.getByText(/Logged 1 hour 30 minutes/)).toBeAttached();
  await expect(
    timePanel(page).getByText('Logged', { exact: true }).locator('xpath=..'),
  ).toContainText('1:30');
  await expect(timePanel(page).getByText('Billable', { exact: true }).first()).toBeVisible();

  // The project's planned versus actual (PRJ-022, TIME-006).
  await page.goto(`/workspaces/${ws}/projects/${prj}/time`);
  await expect(
    timePanel(page).getByText('Task estimates', { exact: true }).locator('xpath=..'),
  ).toContainText('3:00');
  await expect(
    timePanel(page).getByText('Remaining', { exact: true }).locator('xpath=..'),
  ).toContainText('1:30');
  await expectAccessible(page, 'project time');

  // Submit the week; a one-person workspace may self-approve, and it is labelled.
  await page.goto(`/workspaces/${ws}/time`);
  await page.getByRole('button', { name: 'Submit week' }).click();
  await expect(page.getByText('Week submitted for approval.')).toBeAttached();
  await expect(page.getByText('Waiting for approval')).toBeVisible();
  await page.getByRole('link', { name: 'Approvals' }).click();
  await expect(h1(page)).toHaveText('Timesheet approvals');
  await expectAccessible(page, 'approvals');
  await page.getByRole('button', { name: 'Approve Harbor' }).click();
  await expect(page.getByText('Harbor time approved and locked.')).toBeAttached();
  await page.goto(`/workspaces/${ws}/time`);
  await expect(page.getByText('Approved and locked')).toBeVisible();
  await expect(page.getByText(/self-approved/)).toBeVisible();
  const entries = page.getByRole('region', { name: 'Entries' });
  await expect(entries.getByText('Approved (locked)').first()).toBeVisible();
  await expect(entries.getByRole('button', { name: /^Edit / })).toHaveCount(0);

  // Unlock (OD-26): admins only, with a reason and step-up; the week opens again.
  await page.goto(`/workspaces/${ws}/time/approvals`);
  await page.getByRole('button', { name: 'Decided' }).click();
  await page.getByRole('button', { name: 'Unlock…' }).click();
  const unlock = page.getByRole('dialog', { name: 'Unlock Harbor time' });
  await unlock.getByLabel('Reason for unlocking').fill('Client asked for a correction');
  await unlock.getByRole('button', { name: 'Unlock' }).click();
  await confirmStepUp(page);
  await expect(page.getByText(/Unlocked\. The person can change/)).toBeAttached();
  await page.goto(`/workspaces/${ws}/time`);
  await expect(page.getByText('Unlocked: submit again')).toBeVisible();
  await expect(page.getByText(/Client asked for a correction/)).toBeVisible();
  await expect(entries.getByRole('button', { name: /^Edit / }).first()).toBeVisible();

  // Planned versus actual by task, then a CSV download.
  await page.getByRole('link', { name: 'Reports and export' }).click();
  await expect(h1(page)).toHaveText('Planned versus actual');
  await page.getByLabel('Group by').selectOption('task');
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  const table = page.getByRole('table', { name: 'Planned versus actual by task' });
  await expect(table.getByRole('rowheader', { name: 'Write copy' })).toBeVisible();
  await expectAccessible(page, 'time report');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  expect((await download).suggestedFilename()).toMatch(
    /^time-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/,
  );

  // Appearance and reflow.
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.goto(`/workspaces/${ws}/time`);
  await expect(h1(page)).toHaveText('Time');
  await expectAccessible(page, 'time page, forced colours');
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });
  const size = page.viewportSize()!;
  for (const width of [320, 599, 600, 1023, 1024, Math.max(320, Math.floor(size.width / 2))])
    for (const path of ['time', 'time/approvals', 'time/report', `tasks/${tsk}`]) {
      await page.setViewportSize({ width, height: size.height });
      await page.goto(`/workspaces/${ws}/${path}`);
      await expect(h1(page)).not.toHaveText('');
      // Measure once the page's data has rendered (not just its heading).
      await expect(page.getByText(/^Loading/)).toHaveCount(0);
      expect(await noHorizontalOverflow(page), `${path} at ${width}px`).toBeLessThanOrEqual(0);
    }
});

test('a teammate whose role is lowered keeps their time visible but can no longer log or edit it @desktop-only', async ({
  page,
  browser,
}, info) => {
  const { ws, tsk } = await founderWithTask(page, info, 'time-revoke');
  const email = uniqueEmail('time-mate', info);
  await page.goto(`/workspaces/${ws}/people/invite`);
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel('Role').selectOption({ label: 'Member' });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(h1(page)).toHaveText('People');
  const other = await browser.newContext();
  const mate = await other.newPage();
  await openLink(mate, linkPath(await waitForMail(email, 'invited')));
  await register(mate, email, 'Mia Mate');
  await verify(mate, email);
  await signedIn(mate, email);
  await mate.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(h1(mate)).toHaveText('Hours Co');
  // The owner gives Harbor edit access.
  await page.goto(`/workspaces/${ws}`);
  await page.getByRole('link', { name: 'Settings for Harbor' }).click();
  const access = page.getByRole('region', { name: 'Who has access' });
  await access.getByLabel('Give access to').selectOption({ label: 'Mia Mate' });
  await access.getByLabel('Access level').selectOption('edit');
  await access.getByRole('button', { name: 'Review access…' }).click();
  await page
    .getByRole('dialog', { name: 'Give brand access?' })
    .getByRole('button', { name: 'Give access' })
    .click();
  await expect(page.getByText('Access given.')).toBeAttached();
  // The teammate logs time.
  await mate.goto(`/workspaces/${ws}/tasks/${tsk}`);
  await timePanel(mate).locator('summary', { hasText: 'Log time' }).click();
  await timePanel(mate)
    .getByLabel(/Time spent/)
    .fill('45m');
  await timePanel(mate).getByRole('button', { name: 'Log time' }).click();
  await expect(mate.getByText(/Logged 45 minutes/)).toBeAttached();
  await expect(timePanel(mate).getByRole('button', { name: /^Edit / })).toBeVisible();
  // The owner lowers the teammate to Read-only.
  await page.goto(`/workspaces/${ws}/people`);
  await page.getByRole('link', { name: 'Access and actions for Mia Mate' }).click();
  await page.getByLabel('Change role to').selectOption({ label: 'Read-only' });
  await page.getByRole('button', { name: 'Review role change…' }).click();
  await page
    .getByRole('dialog', { name: /Change Mia Mate's role to Read-only/ })
    .getByRole('button', { name: 'Change role' })
    .click();
  await confirmStepUp(page);
  await expect(page.getByText('Mia Mate is now Read-only.')).toBeAttached();
  // Next request: the time is still there, read-only; no timer, logging, or editing.
  await mate.reload();
  await expect(
    timePanel(mate).getByText('Logged', { exact: true }).locator('xpath=..'),
  ).toContainText('0:45');
  await expect(timePanel(mate).getByRole('button', { name: 'Start timer' })).toHaveCount(0);
  await expect(timePanel(mate).locator('summary', { hasText: 'Log time' })).toHaveCount(0);
  await expect(timePanel(mate).getByRole('button', { name: /^Edit / })).toHaveCount(0);
  await expectAccessible(mate, 'read-only time');
  await other.close();
});
