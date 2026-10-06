import { expect, test, type Page } from '@playwright/test';
import {
  createBrand,
  createWorkspace,
  expectAccessible,
  noHorizontalOverflow,
  owner,
} from './support.ts';

/**
 * Phase 2 exit journey (integration review): one person, from nothing, across 2A–2E on desktop,
 * tablet, and mobile. Capture is reachable from every shell route; a captured item becomes work in
 * a useful project; the task carries its intake source, checklist, subtask, reminder, and repeat;
 * the project list orders and bulk-changes tasks with undo; the Inbox keeps the original text. Axe
 * passes at every major state (including forced colours), Capture works keyboard-only, and the key
 * pages reflow at 320 px, the width-class edges, and 200% zoom.
 */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const capture = (page: Page) => page.getByRole('dialog', { name: 'Capture' });
const tree = (page: Page) => page.getByRole('tree', { name: 'Task hierarchy' });

test('Phase 2 exit: capture anywhere, triage into a project, work the task, bulk with undo', async ({
  page,
}, info) => {
  await owner(page, info, 'p2-exit', 'Pat Phase');
  const ws = await createWorkspace(page, 'Exit Co');
  await createBrand(page, 'Harbor');
  // A useful project.
  await page.goto(`/workspaces/${ws}/projects`);
  await page.getByRole('button', { name: 'Create a project' }).click();
  const create = page.getByRole('dialog', { name: 'Create project' });
  await create.getByLabel(/^Project name/).fill('Launch');
  await create.getByRole('button', { name: 'Create project' }).click();
  await expect(h1(page)).toHaveText('Launch');
  const prj = /\/projects\/(prj_[0-9A-Z]{26})$/.exec(page.url())![1]!;

  // Capture is offered on every workspace shell route, with nothing configured.
  for (const path of [
    'home',
    'projects',
    `projects/${prj}`,
    'tasks',
    'inbox',
    'notes',
    'forms',
    'settings/workflows',
  ]) {
    await page.goto(`/workspaces/${ws}/${path}`);
    await expect(h1(page)).toBeVisible();
    await page.getByRole('button', { name: 'Capture' }).click();
    await expect(capture(page)).toBeVisible();
    await capture(page).getByRole('button', { name: 'Close' }).click();
  }
  await page.goto(`/workspaces/${ws}/projects/${prj}`);
  await page.getByRole('button', { name: 'Capture' }).click();
  await capture(page)
    .getByLabel('What do you want to capture?')
    .fill('Draft pricing page tomorrow !high 1h');
  await expect(capture(page).getByText(/from “!high”/)).toBeVisible();
  await capture(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(capture(page).getByText('1 saved to your Inbox.')).toBeVisible();
  await capture(page).getByRole('button', { name: 'Close' }).click();

  // The personal Inbox keeps the original; triage files it into the project.
  await page.goto(`/workspaces/${ws}/inbox`);
  const items = page.getByRole('list', { name: 'Inbox items' });
  await expect(items.getByText('Draft pricing page tomorrow !high 1h')).toBeVisible();
  await items.getByRole('checkbox', { name: /Draft pricing page/ }).check();
  await page.getByLabel('Brand', { exact: true }).selectOption({ label: 'Harbor' });
  await page.getByLabel('Project (optional)').selectOption({ label: 'Launch' });
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByRole('table', { name: 'What will happen' })).toContainText('Ready');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(h1(page)).toHaveText('Draft pricing page');
  await expectAccessible(page, 'task from the Inbox');

  // The task: source, checklist, subtask, reminder, repeat.
  const signals = page.getByRole('region', { name: 'Status signals' });
  await expect(signals).toContainText('Created from intake');
  await page.getByLabel('Add a checklist item').fill('Collect prices');
  await page.getByRole('button', { name: 'Add item' }).click();
  await expect(page.getByRole('checkbox', { name: /Collect prices/ })).toBeVisible();
  await page.getByLabel('Add a subtask').fill('Review copy');
  await page.getByRole('button', { name: 'Add subtask' }).click();
  await expect(
    page.getByRole('region', { name: 'Subtasks' }).getByRole('link', { name: 'Review copy' }),
  ).toBeVisible();
  const personal = page.getByRole('region', { name: 'Reminders and snooze' });
  const d = new Date(Date.now() + 48 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  await personal
    .getByLabel('Remind me at')
    .fill(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`);
  await personal.getByRole('button', { name: 'Add reminder' }).click();
  await expect(page.getByText('Reminder added.')).toBeAttached();
  const repeat = page.getByRole('region', { name: 'Repeat' });
  const form = repeat.getByRole('form', { name: 'Set up a recurring schedule' });
  await form.getByLabel('Repeats').selectOption('daily');
  await form.getByLabel('First occurrence').fill('2027-03-01T09:00');
  await form.getByRole('button', { name: 'Set up recurrence' }).click();
  await expect(page.getByText('Recurrence set up.')).toBeAttached();
  await expectAccessible(page, 'task with interaction sections');

  // The project list: more tasks, ordering by keyboard, bulk with a preview, then undo.
  await page.goto(`/workspaces/${ws}/projects/${prj}/tasks`);
  for (const title of ['Book photographer', 'Send invites']) {
    await page.getByLabel('New task').fill(title);
    await page.getByRole('button', { name: 'Add task' }).click();
    await expect(tree(page).getByRole('treeitem', { name: new RegExp(title) })).toBeVisible();
  }
  await tree(page)
    .getByRole('treeitem', { name: /Send invites/ })
    .focus();
  await page
    .getByRole('group', { name: 'Actions for Send invites' })
    .getByRole('button', { name: 'Move to top' })
    .click();
  await expect(tree(page).getByRole('treeitem').first()).toContainText('Send invites');
  await page.getByRole('button', { name: 'Change several tasks' }).click();
  const bulk = page.getByRole('region', { name: 'Change several tasks' });
  await bulk.getByRole('button', { name: 'Select all shown' }).click();
  await bulk.getByLabel('Action').selectOption('set_priority');
  await bulk.getByLabel('Priority').selectOption('urgent');
  await bulk.getByRole('button', { name: 'Preview change' }).click();
  const preview = page.getByRole('dialog', { name: 'Set priority: preview' });
  await expect(preview.getByRole('row')).toHaveCount(4);
  await expectAccessible(page, 'bulk preview');
  await preview.getByRole('button', { name: /Apply to/ }).click();
  await expect(page.getByText(/Set priority: 3 of 3 changed\./).first()).toBeAttached();
  const toast = page.getByRole('region', { name: 'Undo' });
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText(/Undone:/)).toBeAttached();

  // Keyboard only: Capture opens from the keyboard, focus moves into it, Escape returns it.
  await page.getByRole('button', { name: 'Capture' }).focus();
  await page.keyboard.press('Enter');
  await expect(capture(page).getByLabel('What do you want to capture?')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(capture(page)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Capture' })).toBeFocused();

  // Forced colours and reduced motion keep the project list accessible.
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.reload();
  await expect(tree(page)).toBeVisible();
  await expectAccessible(page, 'project tasks, forced colours');
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });

  // Reflow at 320 px, the width-class edges, and 200% zoom (half the CSS width).
  const size = page.viewportSize()!;
  for (const width of [320, 599, 600, 1023, 1024, Math.max(320, Math.floor(size.width / 2))]) {
    await page.setViewportSize({ width, height: size.height });
    for (const path of ['inbox', `projects/${prj}/tasks`]) {
      await page.goto(`/workspaces/${ws}/${path}`);
      await expect(h1(page)).toBeVisible();
      expect(await noHorizontalOverflow(page), `${path} at ${width}px`).toBeLessThanOrEqual(0);
    }
  }
});
