import { expect, test, type Page } from '@playwright/test';
import {
  createBrand,
  createWorkspace,
  expectAccessible,
  noHorizontalOverflow,
  owner,
} from './support.ts';

/**
 * Phase 2B: tasks on desktop, tablet, and mobile. The project Tasks section creates tasks by name
 * and orders them with visible Move/Indent/Outdent actions; the task page carries criteria,
 * checklist, subtasks, labels, links, and dependencies, refuses an unconfirmed incomplete
 * completion, keeps input on conflict and offline, and reflows to 320 px in forced colors.
 */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });

async function projectWithTasks(page: Page, info: Parameters<typeof owner>[1], prefix: string) {
  await owner(page, info, prefix, 'Tara Tasks');
  const ws = await createWorkspace(page, 'Tasks Co');
  await createBrand(page, 'Harbor');
  await page.goto(`/workspaces/${ws}/projects`);
  await page.getByRole('button', { name: 'Create a project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create project' });
  await dialog.getByLabel(/^Project name/).fill('Launch');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(h1(page)).toHaveText('Launch');
  const prj = /\/projects\/(prj_[0-9A-Z]{26})$/.exec(page.url())![1]!;
  await page.goto(`/workspaces/${ws}/projects/${prj}/tasks`);
  await expect(page.getByRole('heading', { name: 'Tasks', level: 2 })).toBeVisible();
  return { ws, prj };
}

async function addTask(page: Page, title: string) {
  await page.getByLabel('New task').fill(title);
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByRole('treeitem', { name: new RegExp(title) })).toBeVisible();
}

test('creates tasks in a project and orders them without dragging', async ({ page }, info) => {
  await projectWithTasks(page, info, 'tsk-first');
  await expect(page.getByText('No tasks in this project yet.')).toBeVisible();
  await expectAccessible(page, 'project tasks, empty');
  await addTask(page, 'Write copy');
  await addTask(page, 'Design hero');
  const tree = page.getByRole('tree', { name: 'Task hierarchy' });
  await expect(tree.getByRole('treeitem')).toHaveCount(2);
  await tree.getByRole('treeitem', { name: /Design hero/ }).focus();
  const actions = page.getByRole('group', { name: 'Actions for Design hero' });
  await actions.getByRole('button', { name: 'Move up' }).click();
  await expect(page.getByText('Design hero moved up.')).toBeAttached();
  await expect(tree.getByRole('treeitem').first()).toContainText('Design hero');
  await tree.getByRole('treeitem', { name: /Write copy/ }).focus();
  await page
    .getByRole('group', { name: 'Actions for Write copy' })
    .getByRole('button', { name: 'Indent' })
    .click();
  await expect(page.getByText('Write copy indented under Design hero.')).toBeAttached();
  await expectAccessible(page, 'project tasks, tree');
  expect(await noHorizontalOverflow(page), 'project tasks').toBeLessThanOrEqual(0);
});

test('task page: criteria gate completion, checklist, subtasks, links, conflict, and offline', async ({
  page,
}, info) => {
  const { ws } = await projectWithTasks(page, info, 'tsk-page');
  await addTask(page, 'Ship pricing');
  await page
    .getByRole('tree')
    .getByRole('treeitem', { name: /Ship pricing/ })
    .focus();
  await page.keyboard.press('Enter');
  await expect(h1(page)).toHaveText('Ship pricing');
  await expect(
    page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Launch' }),
  ).toBeVisible();
  const tsk = /\/tasks\/(tsk_[0-9A-Z]{26})$/.exec(page.url())![1]!;
  await expectAccessible(page, 'task page');

  // A required criterion blocks completion; the owner may override with a reason.
  await page.getByLabel('Criterion').fill('Prices reviewed');
  await page.getByRole('button', { name: 'Add criterion' }).click();
  await expect(page.getByRole('checkbox', { name: /Prices reviewed/ })).toBeVisible();
  await page.getByLabel('Add a checklist item').fill('Draft table');
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.getByRole('checkbox', { name: /Draft table/ }).click();
  await expect(page.getByText('Item done.')).toBeAttached();
  await expect(page.getByRole('checkbox', { name: /Draft table/ })).toBeChecked();
  await page.getByRole('button', { name: 'Complete', exact: true }).click();
  await expect(page.getByText(/not met|criteria/i).first()).toBeVisible();
  await page.getByRole('button', { name: 'Complete anyway…' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Complete with an override?' });
  await dialog.getByLabel('Reason').fill('Reviewed in standup');
  await dialog.getByRole('button', { name: 'Complete anyway' }).click();
  await expect(page.getByText('Completed with an override')).toBeVisible();
  await page.getByRole('button', { name: 'Reopen' }).click();
  await expect(page.getByText('Task reopened.')).toBeAttached();

  // Subtask and a safe link.
  await page.getByLabel('Add a subtask').fill('Check currency');
  await page.getByRole('button', { name: 'Add subtask' }).click();
  await expect(
    page.getByRole('region', { name: 'Subtasks' }).getByRole('link', { name: 'Check currency' }),
  ).toBeVisible();
  await page.getByLabel('Web address').fill('javascript:alert(1)');
  await page.getByRole('button', { name: 'Add link' }).click();
  await expect(page.getByRole('region', { name: 'Links' }).getByText('No links.')).toBeVisible();
  await page.getByLabel('Web address').fill('https://example.com/pricing');
  await page.getByRole('button', { name: 'Add link' }).click();
  await expect(page.getByRole('link', { name: /example\.com\/pricing/ })).toHaveAttribute(
    'rel',
    /noopener/,
  );

  // Conflict: another tab renames first; my input stays and I choose.
  const url = `/workspaces/${ws}/tasks/${tsk}`;
  await page.reload();
  await page.locator('#tf-title').fill('Ship pricing v2');
  const tab = await page.context().newPage();
  await tab.goto(url);
  await tab.locator('#tf-title').fill('Pricing go-live');
  await tab.getByRole('button', { name: 'Save task' }).click();
  await expect(tab.getByText('Task saved.')).toBeAttached();
  await tab.close();
  await page.getByRole('button', { name: 'Save task' }).click();
  await expect(
    page.getByText('This was changed by someone else while you were editing'),
  ).toBeVisible();
  await expect(page.locator('#tf-title')).toHaveValue('Ship pricing v2');
  await page.getByRole('button', { name: 'Keep my changes' }).click();
  await page.getByRole('button', { name: 'Save task' }).click();
  await expect(page.getByText('Task saved.')).toBeAttached();

  // Offline: nothing is sent and the input stays.
  await page.context().setOffline(true);
  await page.evaluate('window.dispatchEvent(new Event("offline"))');
  await page.locator('#tf-title').fill('Offline edit');
  await page.getByRole('button', { name: 'Save task' }).click();
  await expect(page.getByText("You're offline", { exact: false }).first()).toBeVisible();
  await expect(page.locator('#tf-title')).toHaveValue('Offline edit');
  await page.context().setOffline(false);
  await page.evaluate('window.dispatchEvent(new Event("online"))');

  // History is a projection of the audit ledger.
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'History' }).getByRole('listitem').first(),
  ).toBeVisible();

  // Forced colors, 200% zoom, and 320 px keep the task page usable.
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.reload();
  await expect(h1(page)).toBeVisible();
  await expectAccessible(page, 'task page, forced colors');
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });
  const size = page.viewportSize()!;
  for (const width of [Math.max(320, Math.floor(size.width / 2)), 320]) {
    await page.setViewportSize({ width, height: size.height });
    await page.goto(url);
    await expect(h1(page)).toBeVisible();
    expect(await noHorizontalOverflow(page), `task page at ${width}px`).toBeLessThanOrEqual(0);
  }
});

test('projectless tasks have their own entry path', async ({ page }, info) => {
  await owner(page, info, 'tsk-loose', 'Lou Loose');
  const ws = await createWorkspace(page, 'Loose Co');
  await createBrand(page, 'Harbor');
  await page.goto(`/workspaces/${ws}/tasks`);
  await expect(h1(page)).toHaveText('Tasks without a project');
  await expect(page.getByText('No tasks without a project.')).toBeVisible();
  await addTask(page, 'Renew domain');
  await expectAccessible(page, 'projectless tasks');
});
