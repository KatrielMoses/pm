import { expect, test, type Page } from '@playwright/test';
import {
  createBrand,
  createWorkspace,
  expectAccessible,
  noHorizontalOverflow,
  owner,
} from './support.ts';

/**
 * Phase 2C on desktop, tablet, and mobile: configure a workflow (statuses, a transition with a
 * required field, an approval-gated transition), move a task through it with the transition
 * dialog, approve from the queue, and use custom fields (a formula, advanced fields under "More
 * fields"); every state is accessible, keyboard operable, and reflows to 320 px in forced colors.
 */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });

async function setUp(page: Page, info: Parameters<typeof owner>[1], prefix: string) {
  await owner(page, info, prefix, 'Wren Workflow');
  const ws = await createWorkspace(page, 'Flow Co');
  await createBrand(page, 'Harbor');
  return ws;
}

/** Chooses a target status by its name (the label also says what the change needs). */
async function chooseStatus(page: Page, name: string) {
  const select = page.getByRole('region', { name: 'Status' }).getByLabel('Change status to');
  const value = await select.locator('option', { hasText: name }).getAttribute('value');
  await select.selectOption(value!);
}

async function newTask(page: Page, ws: string, title: string) {
  await page.goto(`/workspaces/${ws}/tasks`);
  await page.getByLabel('New task').fill(title);
  await page.getByRole('button', { name: 'Add task' }).click();
  await page
    .getByRole('tree')
    .getByRole('treeitem', { name: new RegExp(title) })
    .focus();
  await page.keyboard.press('Enter');
  await expect(h1(page)).toHaveText(title);
}

test('configures a workflow and moves a task through required fields and an approval', async ({
  page,
}, info) => {
  const ws = await setUp(page, info, 'wf-flow');
  await page.goto(`/workspaces/${ws}/settings/workflows`);
  await expect(h1(page)).toHaveText('Workflows');
  await expect(page.getByText('The default workflow applies here.').first()).toBeVisible();
  await expectAccessible(page, 'workflows, empty');
  const tasks = page.getByRole('region', { name: 'Task workflow' });
  await tasks.getByRole('button', { name: 'Create a task workflow here' }).click();
  await tasks.getByLabel('Workflow name').fill('Release');
  await tasks.getByRole('button', { name: 'Create workflow' }).click();
  await expect(tasks.getByRole('heading', { name: 'Release' })).toBeVisible();
  // Reorder with buttons (no drag).
  await tasks.getByRole('button', { name: 'Move down To do' }).click();
  await expect(page.getByText('Status moved.')).toBeAttached();
  await tasks.getByRole('button', { name: 'Move up To do' }).click();
  // To do → In progress requires a due date; In progress → Done needs one manager's approval.
  const add = tasks.getByRole('form', { name: 'Add a transition' });
  await add.getByLabel('From').selectOption({ label: 'To do' });
  await add.getByLabel('To', { exact: true }).selectOption({ label: 'In progress' });
  await add.getByRole('checkbox', { name: 'Due date' }).check();
  await add.getByRole('button', { name: 'Add transition' }).click();
  await expect(tasks.getByText(/To do → In progress · requires Due date/)).toBeVisible();
  await add.getByLabel('From').selectOption({ label: 'In progress' });
  await add.getByLabel('To', { exact: true }).selectOption({ label: 'Done' });
  await add.getByRole('checkbox', { name: 'Due date' }).uncheck();
  await add.getByLabel('Approval').selectOption({ label: 'One manager' });
  await add.getByRole('checkbox', { name: /approve their own change/ }).check();
  await add.getByRole('button', { name: 'Add transition' }).click();
  await expect(tasks.getByText(/In progress → Done · approval: one manager/)).toBeVisible();
  await expectAccessible(page, 'workflow configured');

  await newTask(page, ws, 'Ship release notes');
  const status = page.getByRole('region', { name: 'Status' });
  await expect(status.getByText('Release workflow', { exact: false })).toBeVisible();
  await chooseStatus(page, 'In progress');
  await status.getByRole('button', { name: 'Review change…' }).click();
  const dialog = page.getByRole('dialog', { name: 'To do → In progress' });
  await expect(dialog.getByText('Due date (missing)', { exact: false })).toBeAttached();
  await expect(dialog.getByRole('button', { name: 'Apply' })).toHaveCount(0);
  await expectAccessible(page, 'transition dialog, blocked');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  // Fill the requirement, then the change applies.
  await page.getByLabel('Due date').fill('2026-12-01');
  await page.getByRole('button', { name: 'Save task' }).click();
  await expect(page.getByText('Task saved.')).toBeAttached();
  await chooseStatus(page, 'In progress');
  await status.getByRole('button', { name: 'Review change…' }).click();
  await page
    .getByRole('dialog', { name: 'To do → In progress' })
    .getByRole('button', { name: 'Apply' })
    .click();
  await expect(page.getByText('Status changed to In progress.')).toBeAttached();
  // Done needs approval: request it, approve it from the queue (solo workspace, OD-20), apply it.
  await chooseStatus(page, 'Done');
  await status.getByRole('button', { name: 'Review change…' }).click();
  const gated = page.getByRole('dialog', { name: 'In progress → Done' });
  await expect(gated.getByText(/needs approval \(one manager\)/)).toBeVisible();
  await gated.getByRole('button', { name: 'Request approval' }).click();
  await expect(page.getByText('Approval requested.')).toBeAttached();
  const taskUrl = page.url();
  await page.goto(`/workspaces/${ws}/approvals`);
  await expect(h1(page)).toHaveText('Approvals');
  await expectAccessible(page, 'approvals queue');
  await page.getByRole('button', { name: 'Approve In progress to Done' }).click();
  await expect(page.getByText('Approved.')).toBeAttached();
  await page.goto(taskUrl);
  await chooseStatus(page, 'Done');
  await status.getByRole('button', { name: 'Review change…' }).click();
  const ready = page.getByRole('dialog', { name: 'In progress → Done' });
  await expect(ready.getByText('Your request is approved.', { exact: false })).toBeVisible();
  await ready.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Status changed to Done.')).toBeAttached();
  await expect(page.locator('.record-meta').getByText('Done')).toBeVisible();
});

test('custom fields: a formula, advanced fields under "More fields", keyboard, forced colors, and 320 px', async ({
  page,
}, info) => {
  const ws = await setUp(page, info, 'wf-fields');
  await page.goto(`/workspaces/${ws}/settings/fields`);
  await expect(h1(page)).toHaveText('Custom fields');
  await expectAccessible(page, 'fields, empty');
  const add = page.getByRole('region', { name: 'Add a field' });
  await add.getByLabel('Field name').fill('Points');
  await add.getByLabel('Type').selectOption({ label: 'Number' });
  await add.getByRole('button', { name: 'Add field' }).click();
  await expect(page.getByText('Field added.')).toBeAttached();
  await add.getByLabel('Field name').fill('Root cause');
  await add.getByLabel('Type').selectOption({ label: 'Text' });
  await add.getByLabel('Show').selectOption({ label: 'Under More fields' });
  await add.getByRole('button', { name: 'Add field' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Fields at this scope' })
      .locator('strong', { hasText: 'Root cause' }),
  ).toBeVisible();
  // The formula references the Points field by its ID (shown in the hint).
  await add.getByLabel('Field name').fill('Double points');
  await add.getByLabel('Type').selectOption({ label: 'Formula' });
  const hint = (await add.getByText(/Points = \{fld_/).textContent())!;
  const ref = /Points = (\{fld_[0-9A-Z]{26}\})/.exec(hint)![1]!;
  await add.getByLabel('Formula').fill(`${ref} * 2`);
  await add.getByRole('button', { name: 'Check formula' }).click();
  await expect(add.getByText('Result type: number', { exact: false })).toBeVisible();
  await add.getByRole('button', { name: 'Add field' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Fields at this scope' })
      .locator('strong', { hasText: 'Double points' }),
  ).toBeVisible();
  await expectAccessible(page, 'fields configured');

  await newTask(page, ws, 'Estimate me');
  const section = page.getByRole('region', { name: 'Custom fields' });
  await expect(section.getByText('Waiting for inputs')).toBeVisible();
  await section.getByLabel('Points').fill('4');
  await section.getByRole('button', { name: 'Save fields' }).click();
  await expect(page.getByText('Fields saved.')).toBeAttached();
  await expect(section.getByText('8', { exact: true })).toBeVisible();
  // Advanced fields: hidden until "More fields", then keyboard reachable and searchable.
  await expect(section.getByLabel('Root cause')).toHaveCount(0);
  const more = section.getByRole('button', { name: 'More fields (1)' });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(section.getByRole('button', { name: 'Fewer fields' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await section.getByLabel('Find a field').fill('root');
  await section.getByLabel('Root cause').fill('Flaky network');
  await section.getByRole('button', { name: 'Save fields' }).click();
  await expect(page.getByText('Fields saved.')).toBeAttached();
  await expectAccessible(page, 'record fields');
  // Invalid input is a field error, focused.
  await section.getByLabel('Points').fill('lots');
  await section.getByRole('button', { name: 'Save fields' }).click();
  await expect(section.getByText('Enter a number.')).toBeVisible();
  await expect(section.getByLabel('Points')).toBeFocused();

  const url = page.url();
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.reload();
  await expect(page.getByRole('region', { name: 'Custom fields' })).toBeVisible();
  await expectAccessible(page, 'record fields, forced colors');
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });
  const size = page.viewportSize()!;
  for (const width of [Math.max(320, Math.floor(size.width / 2)), 320]) {
    await page.setViewportSize({ width, height: size.height });
    for (const path of [
      url,
      `/workspaces/${ws}/settings/fields`,
      `/workspaces/${ws}/settings/workflows`,
    ]) {
      await page.goto(path);
      await expect(h1(page)).toBeVisible();
      expect(await noHorizontalOverflow(page), `${path} at ${width}px`).toBeLessThanOrEqual(0);
    }
  }
});
