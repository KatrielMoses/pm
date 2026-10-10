import { expect, test, type Page } from '@playwright/test';
import {
  createBrand,
  createWorkspace,
  expectAccessible,
  noHorizontalOverflow,
  owner,
} from './support.ts';

/**
 * Phase 2D (ADR-0016) on desktop, tablet, and mobile: keyboard-only ordering with announcements
 * and undo, inline edits with save states, duplicate hints, bulk preview and report, and on the
 * task page signals, reminders, snooze, reschedule, repeat, and templates. Every stage passes axe;
 * the list and task page reflow at 320 px and at the width-class edges, at 200% zoom, in forced
 * colors, and with reduced motion.
 */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const tree = (page: Page) => page.getByRole('tree', { name: 'Task hierarchy' });
const later = (hours: number) => {
  const d = new Date(Date.now() + hours * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

async function projectless(page: Page, info: Parameters<typeof owner>[1], prefix: string) {
  await owner(page, info, prefix, 'Iris Interaction');
  const ws = await createWorkspace(page, 'Interaction Co');
  await createBrand(page, 'Harbor');
  await page.goto(`/workspaces/${ws}/tasks`);
  await expect(h1(page)).toHaveText('Tasks without a project');
  return ws;
}

async function addTask(page: Page, title: string) {
  await page.getByLabel('New task').fill(title);
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(tree(page).getByRole('treeitem', { name: new RegExp(title) })).toBeVisible();
}

const titles = async (page: Page) =>
  (await tree(page).getByRole('treeitem').allTextContents()).map((t) => t.trim().split(' ')[0]);

test('keyboard ordering with undo, inline edits, duplicates, and bulk changes', async ({
  page,
}, info) => {
  const ws = await projectless(page, info, 'ti-list');
  for (const t of ['Alpha', 'Bravo', 'Charlie']) await addTask(page, t);
  // Duplicate hint while typing an existing title (advisory; adding stays possible).
  await page.getByLabel('New task').fill('alpha');
  await expect(page.getByText('Possible duplicates', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Alpha', exact: true })).toBeVisible();
  await page.getByLabel('New task').fill('');
  await expectAccessible(page, 'task list with signals');

  // Keyboard only: Alt+ArrowUp moves the focused task and announces the new position.
  await tree(page)
    .getByRole('treeitem', { name: /Charlie/ })
    .focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page.getByText('Charlie: Moved to position 2 of 3.')).toBeAttached();
  await expect.poll(() => titles(page)).toEqual(['Alpha', 'Charlie', 'Bravo']);
  // Undo is reachable and announced.
  const toast = page.getByRole('region', { name: 'Undo' });
  await expect(toast).toBeVisible();
  await expectAccessible(page, 'undo toast');
  await toast.getByRole('button', { name: 'Undo' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Undone: Charlie moved.')).toBeAttached();
  await expect.poll(() => titles(page)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  // Move to top / position buttons.
  await tree(page)
    .getByRole('treeitem', { name: /Charlie/ })
    .focus();
  const actions = page.getByRole('group', { name: 'Actions for Charlie' });
  await actions.getByRole('button', { name: 'Move to top' }).click();
  await expect.poll(() => titles(page)).toEqual(['Charlie', 'Alpha', 'Bravo']);

  // Inline edit with a save state.
  await tree(page).getByRole('treeitem', { name: /Bravo/ }).focus();
  await page
    .getByRole('group', { name: 'Actions for Bravo' })
    .getByRole('button', { name: 'Edit in place' })
    .click();
  const editors = page.getByRole('group', { name: 'Edit Bravo' });
  await editors.getByLabel('Priority', { exact: true }).selectOption('high');
  await editors.getByRole('button', { name: 'Save priority' }).click();
  await expect(page.getByText('Priority saved.')).toBeAttached();
  await expectAccessible(page, 'inline editors');

  // Bulk: preview every item, then apply and read the report.
  await page.getByRole('button', { name: 'Change several tasks' }).click();
  const bulk = page.getByRole('region', { name: 'Change several tasks' });
  await bulk.getByRole('button', { name: 'Select all shown' }).click();
  await bulk.getByLabel('Action').selectOption('set_due_date');
  await bulk.getByLabel('Due date').fill('2027-01-15');
  await bulk.getByRole('button', { name: 'Preview change' }).click();
  const dialog = page.getByRole('dialog', { name: 'Set due date: preview' });
  await expect(dialog.getByRole('row')).toHaveCount(4);
  await expectAccessible(page, 'bulk preview');
  await dialog.getByRole('button', { name: 'Apply to 3 tasks' }).click();
  await expect(page.getByText('Set due date: 3 of 3 changed.', { exact: true })).toBeAttached();
  await expect(bulk.getByRole('heading', { name: 'Result' })).toBeVisible();

  // Reflow: forced colors and reduced motion; 320 px, the width-class edges, and 200% zoom.
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.reload();
  await expect(tree(page)).toBeVisible();
  await expectAccessible(page, 'task list, forced colors');
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });
  const size = page.viewportSize()!;
  for (const width of [320, 599, 600, 1023, 1024, Math.max(320, Math.floor(size.width / 2))]) {
    await page.setViewportSize({ width, height: size.height });
    await page.goto(`/workspaces/${ws}/tasks`);
    await expect(tree(page)).toBeVisible();
    expect(await noHorizontalOverflow(page), `task list at ${width}px`).toBeLessThanOrEqual(0);
  }
});

test('task page: signals, reminders, snooze, reschedule, repeat, and templates', async ({
  page,
}, info) => {
  const ws = await projectless(page, info, 'ti-page');
  await addTask(page, 'Quarterly review');
  await tree(page)
    .getByRole('treeitem', { name: /Quarterly review/ })
    .focus();
  await page.keyboard.press('Enter');
  await expect(h1(page)).toHaveText('Quarterly review');
  const url = page.url();

  const sig = page.getByRole('region', { name: 'Status signals' });
  await expect(sig.getByRole('list', { name: 'Signals' })).toContainText('No date');
  await expect(sig.getByRole('heading', { name: 'Missing information' })).toBeVisible();
  await expect(sig).toContainText('Created by a person');
  await expectAccessible(page, 'task page signals');

  // Personal reminder and snooze (only the person sees them; dates are untouched).
  const personal = page.getByRole('region', { name: 'Reminders and snooze' });
  await personal.getByLabel('Remind me at').fill(later(48));
  await personal.getByRole('button', { name: 'Add reminder' }).click();
  await expect(page.getByText('Reminder added.')).toBeAttached();
  await expect(
    personal.getByRole('list', { name: 'Your reminders' }).getByRole('listitem'),
  ).toHaveCount(1);
  await personal.getByLabel('Snooze until').fill(later(24));
  await personal.getByRole('button', { name: 'Snooze' }).click();
  await expect(personal.getByText(/Snoozed until/)).toBeVisible();
  await personal.getByRole('button', { name: 'End snooze' }).click();
  await expect(personal.getByLabel('Snooze until')).toBeVisible();

  // Reschedule with an explicit choice; the deadline is separate.
  await page.getByRole('button', { name: 'Reschedule…' }).click();
  const rd = page.getByRole('dialog', { name: 'Reschedule' });
  await expect(rd.getByRole('radio', { name: /Due date/ })).toBeChecked();
  await rd.getByLabel('New due date').fill('2027-02-01');
  await expectAccessible(page, 'reschedule dialog');
  await rd.getByRole('button', { name: 'Reschedule' }).click();
  await expect(page.getByText('Rescheduled.')).toBeAttached();
  await expect(sig.getByRole('list', { name: 'Signals' })).not.toContainText('No date');

  // Repeat: weekly; create the next occurrence now.
  const repeat = page.getByRole('region', { name: 'Repeat' });
  await expect(repeat.getByText('This task does not repeat.')).toBeVisible();
  const form = repeat.getByRole('form', { name: 'Set up a recurring schedule' });
  await form.getByLabel('Repeats').selectOption('daily');
  await form.getByLabel('First occurrence').fill('2027-03-01T09:00');
  await form.getByRole('button', { name: 'Set up recurrence' }).click();
  await expect(page.getByText('Recurrence set up.')).toBeAttached();
  await repeat.getByRole('button', { name: /Create next occurrence now/ }).click();
  await expect(page.getByText('Next occurrence created.')).toBeAttached();
  await expectAccessible(page, 'repeat section');

  // Save as template, then create a task from it in the list.
  const tpl = page.getByRole('region', { name: 'Template' });
  await tpl.getByLabel('Template name').fill('Review template');
  await tpl.getByRole('button', { name: 'Save as template' }).click();
  await expect(page.getByText(/Saved as a template/)).toBeAttached();
  await page.goto(`/workspaces/${ws}/tasks`);
  await page.getByLabel('Or start from a template').selectOption({ label: 'Review template' });
  await page.getByLabel('New task').fill('From the template');
  await page.getByRole('button', { name: 'Create from template' }).click();
  await expect(page.getByText(/Task created from template/)).toBeAttached();
  await expect(tree(page).getByRole('treeitem', { name: /From the template/ })).toBeVisible();

  // The occurrence and the original reflow at 320 px.
  await page.setViewportSize({ width: 320, height: page.viewportSize()!.height });
  await page.goto(url);
  await expect(h1(page)).toBeVisible();
  expect(await noHorizontalOverflow(page), 'task page at 320px').toBeLessThanOrEqual(0);
  await expectAccessible(page, 'task page at 320px');
});

/** Seeds through the API in the signed-in context (synchronizer token and idempotency key). */
async function seed(page: Page, path: string, data: unknown) {
  const origin = new URL(page.url()).origin;
  const me = await page.request.get('/v1/auth/me');
  const r = await page.request.post(path, {
    headers: {
      origin,
      'x-csrf-token': me.headers()['x-csrf-token'] ?? '',
      'idempotency-key': `e2e-${crypto.randomUUID()}`,
    },
    data,
  });
  expect(r.status(), await r.text()).toBeLessThan(300);
  return (await r.json()).data;
}

test('bulk status offers the project workflow’s custom statuses and previews each target', async ({
  page,
}, info) => {
  const ws = await projectless(page, info, 'ti-custom');
  const brands = await (await page.request.get(`/v1/workspaces/${ws}/brands`)).json();
  const brand = brands.data.find((b: { name: string }) => b.name === 'Harbor').id;
  const prj = await seed(page, `/v1/workspaces/${ws}/projects`, { brand, name: 'Custom flow' });
  await seed(page, `/v1/workspaces/${ws}/workflows`, {
    scope: `project:${prj.id}`,
    record_kind: 'task',
    name: 'Studio',
    statuses: [
      { name: 'Inbox', category: 'planned' },
      { name: 'Polishing', category: 'active' },
      { name: 'Released', category: 'done' },
    ],
  });
  for (const title of ['Cut trailer', 'Mix audio'])
    await seed(page, `/v1/workspaces/${ws}/tasks`, { project: prj.id, title });
  await page.goto(`/workspaces/${ws}/projects/${prj.id}/tasks`);
  await expect(tree(page).getByRole('treeitem')).toHaveCount(2);
  await page.getByRole('button', { name: 'Change several tasks' }).click();
  const bulk = page.getByRole('region', { name: 'Change several tasks' });
  await bulk.getByRole('button', { name: 'Select all shown' }).click();
  await bulk.getByLabel('Action').selectOption('set_status');
  const status = bulk.getByLabel('Status');
  await expect(status.locator('option', { hasText: 'Polishing (custom)' })).toHaveCount(1);
  await expect(status.locator('option', { hasText: 'In progress' })).toHaveCount(0);
  await status.selectOption({ label: 'Polishing (custom)' });
  await expectAccessible(page, 'bulk status with custom statuses');
  await bulk.getByRole('button', { name: 'Preview change' }).click();
  const dialog = page.getByRole('dialog', { name: 'Set status: preview' });
  await expect(dialog.getByRole('columnheader', { name: 'Proposed status' })).toBeVisible();
  await expect(
    dialog.getByRole('row', { name: /Cut trailer Polishing Will change/ }),
  ).toBeVisible();
  await expectAccessible(page, 'bulk status preview');
  await dialog.getByRole('button', { name: 'Apply to 2 tasks' }).click();
  await expect(page.getByText('Set status: 2 of 2 changed.', { exact: true })).toBeAttached();
  await expect(tree(page).getByRole('treeitem', { name: /Cut trailer/ })).toContainText(
    'Polishing',
  );
  for (const width of [320, 600]) {
    await page.setViewportSize({ width, height: page.viewportSize()!.height });
    await page.reload();
    await expect(tree(page)).toBeVisible();
    expect(await noHorizontalOverflow(page), `custom statuses at ${width}px`).toBeLessThanOrEqual(
      0,
    );
  }
});
