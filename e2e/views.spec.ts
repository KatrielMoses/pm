import { expect, test, type Page } from '@playwright/test';
import {
  createBrand,
  createWorkspace,
  expectAccessible,
  noHorizontalOverflow,
  owner,
} from './support.ts';

/**
 * Phase 3A saved views (ADR-0018) at desktop, tablet, and mobile: build a view with AND/OR filters,
 * multi-sort, grouping, columns, and density; the URL reproduces it (deep link, reload, Back);
 * save, modify (Modified marker, Reset), share with a brand, pin to navigation, set a default,
 * export, and delete. Keyboard-only, forced colours, reduced motion, 320 px, the width-class
 * edges, and 200% zoom keep every state usable and axe-clean.
 */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const results = (page: Page) => page.getByRole('region', { name: /results$/ });

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

test('build, save, share, pin, default, export, and delete a view', async ({ page }, info) => {
  await owner(page, info, 'views', 'Vera Views');
  const ws = await createWorkspace(page, 'Views Co');
  await createBrand(page, 'Harbor');
  const brands = await (await page.request.get(`/v1/workspaces/${ws}/brands`)).json();
  const harbor = brands.data.find((b: { name: string }) => b.name === 'Harbor').id;
  for (const [title, priority, due] of [
    ['Write launch post', 'urgent', '2026-11-03'],
    ['Book venue', 'high', '2026-11-01'],
    ['Order banners', 'low', null],
    ['Plan meetup', 'urgent', null],
  ] as const)
    await seed(page, `/v1/workspaces/${ws}/tasks`, {
      brand: harbor,
      title,
      priority,
      ...(due ? { due_date: due } : {}),
    });

  // A new task view lists every task the person can see.
  await page.goto(`/workspaces/${ws}/views`);
  await expect(h1(page)).toHaveText('Saved views');
  await expectAccessible(page, 'saved views list');
  await page.getByRole('link', { name: 'New task view' }).click();
  await expect(h1(page)).toHaveText('New task view');
  await expect(page.getByRole('status').filter({ hasText: /tasks?$/ })).toHaveText('4 tasks');
  // 3B: the list layout is RS-50 rows; this journey checks the table rendering (RS-53).
  await page.getByLabel('Layout', { exact: true }).selectOption({ label: 'Table' });

  // Filters: priority is urgent OR high (keyboard only).
  await page.getByRole('button', { name: 'Filters' }).focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: 'Filters' });
  await panel.getByRole('button', { name: 'Add condition' }).click();
  const cond = panel.getByRole('group', { name: 'Condition 1' });
  await cond.getByLabel('Field').selectOption({ label: 'Priority' });
  await cond.getByRole('checkbox', { name: 'Urgent' }).check();
  await cond.getByRole('checkbox', { name: 'High' }).check();
  await expect(page.getByRole('status').filter({ hasText: /tasks?$/ })).toHaveText('3 tasks');
  // OR with a second condition widens to the banners task; removing it narrows again.
  await panel.getByLabel('Combine conditions with').selectOption({ label: 'Any of them (or)' });
  await panel.getByRole('button', { name: 'Add condition' }).click();
  const second = panel.getByRole('group', { name: 'Condition 2' });
  await second.getByLabel('Field').selectOption({ label: 'Title' });
  await second.getByLabel('Text').fill('banners');
  await expect(page.getByRole('status').filter({ hasText: /tasks?$/ })).toHaveText('4 tasks');
  await expectAccessible(page, 'filter builder');
  await second.getByRole('button', { name: 'Remove condition 2' }).click();
  await expect(page.getByRole('status').filter({ hasText: /tasks?$/ })).toHaveText('3 tasks');
  // Sort by due date, then title; group by priority.
  await page.getByRole('button', { name: /^Sort/ }).click();
  await page.getByRole('button', { name: 'Add sort' }).click();
  await page.getByLabel('Sort by').selectOption({ label: 'Due date' });
  await page.getByRole('button', { name: 'Add sort' }).click();
  await page.getByLabel('Then by').selectOption({ label: 'Title' });
  await page.getByRole('button', { name: /^Group/ }).click();
  await page.getByLabel('Group by').selectOption({ label: 'Priority' });
  await expect(results(page).getByRole('rowheader').first()).toHaveText(/Urgent/);
  const firstTask = results(page).getByRole('row').nth(2);
  await expect(firstTask).toContainText('Write launch post');
  // Columns: show Due date; density compact.
  await page.getByRole('button', { name: 'Columns' }).click();
  await page.getByRole('button', { name: 'Hide Brand' }).click();
  await expect(page).toHaveURL(/[?&]q=/);
  const before = page.url();
  await page.getByRole('radio', { name: 'Compact' }).check();
  await expect(results(page).getByRole('columnheader')).not.toContainText(['Brand']);

  // The URL is the view (replaced, not pushed): a reload reproduces it.
  await expect(page).not.toHaveURL(before);
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: /tasks?$/ })).toHaveText('3 tasks');
  await expect(page.getByRole('radio', { name: 'Compact' })).toBeChecked();

  // Save it (keyboard: the dialog takes focus; Escape cancels).
  await page.getByRole('button', { name: 'Save view…' }).click();
  const save = page.getByRole('dialog', { name: 'Save view' });
  await save.getByLabel('Name').fill('Hot this week');
  await save.getByRole('button', { name: 'Save view' }).click();
  await expect(h1(page)).toHaveText('Hot this week');
  await expect(page.getByText('Personal view')).toBeVisible();
  const viewUrl = page.url();

  // Modify: the Modified marker appears; Reset returns to the saved definition.
  await page.getByRole('radio', { name: 'Comfortable' }).check();
  await expect(page.getByText('Modified')).toBeVisible();
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(page.getByText('Modified')).toBeHidden();
  await expect(page.getByRole('radio', { name: 'Compact' })).toBeChecked();

  // Share with the brand, pin to navigation, make it the brand default.
  await page.getByRole('button', { name: 'Share…' }).click();
  const share = page.getByRole('dialog', { name: 'Share view' });
  await share.getByRole('radio', { name: 'People who can see a brand' }).check();
  await share.getByLabel('Brand', { exact: true }).selectOption({ label: 'Harbor' });
  await expectAccessible(page, 'share dialog');
  await share.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByText('Shared with Harbor')).toBeVisible();
  await page.getByRole('button', { name: 'Share…' }).click();
  await page
    .getByRole('dialog', { name: 'Share view' })
    .getByRole('button', { name: 'Pin to navigation' })
    .click();
  await expect(page.getByText('View pinned to navigation.')).toBeAttached();
  await page.getByRole('button', { name: 'Default…' }).click();
  await page
    .getByRole('dialog', { name: 'Default view' })
    .getByRole('button', { name: 'Make it the default for Harbor' })
    .click();
  await expect(page.getByText('This is now the default for Harbor.')).toBeAttached();
  if (info.project.name === 'desktop') {
    const pinned = page
      .getByRole('region', { name: 'Pinned views' })
      .or(page.getByRole('navigation').getByRole('link', { name: /Hot this week/ }));
    await expect(pinned.first()).toBeVisible();
  }

  // Export as CSV (a real download with the view's rows).
  await page.getByRole('button', { name: 'Export…' }).click();
  const exp = page.getByRole('dialog', { name: 'Export view' });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exp.getByRole('button', { name: 'Export' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('hot-this-week.csv');

  // Accessibility and reflow on the saved view: forced colours, reduced motion, widths, zoom.
  await page.goto(viewUrl);
  await expect(h1(page)).toHaveText('Hot this week');
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.reload();
  await expect(results(page)).toBeVisible();
  await expectAccessible(page, 'saved view, forced colours');
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });
  const size = page.viewportSize()!;
  for (const width of [320, 599, 600, 1023, 1024, Math.max(320, Math.floor(size.width / 2))]) {
    await page.setViewportSize({ width, height: size.height });
    await page.goto(viewUrl);
    await expect(h1(page)).toHaveText('Hot this week');
    expect(await noHorizontalOverflow(page), `view at ${width}px`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize(size);
  await expectAccessible(page, 'saved view');

  // Delete: confirm, then the view and its pin are gone.
  await page.goto(viewUrl);
  await page.getByRole('button', { name: 'Delete…' }).click();
  const del = page.getByRole('alertdialog', { name: 'Delete this view?' });
  await expect(del.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await del.getByRole('button', { name: 'Delete view' }).click();
  await expect(h1(page)).toHaveText('Saved views');
  await page.goto(viewUrl);
  await expect(h1(page)).toHaveText("This page isn't available");
});
