import { expect, test, type Page } from '@playwright/test';
import { goTo, noHorizontalOverflow } from './support.ts';
import { accessible, api, get, giveBrand, h1, person, seed } from './goals-support.ts';

/**
 * Phase 5D on desktop (ADR-0031): a founder builds a dashboard, reads figures with their scope,
 * source, and freshness, opens the records behind one, filters, edits the layout by keyboard,
 * exports, and trashes and restores it; a member with narrower access sees smaller figures and no
 * hidden names; a report shared with someone opens for them and stops opening when revoked; scheduling
 * needs recipients first (guests are covered by the API and integration tests). Pages pass axe at desktop width, 320 px, and 200% zoom, with forced
 * colours and reduced motion, and are operable by keyboard alone.
 */

async function reflow(page: Page, url: string, ready: () => Promise<void>, label: string) {
  const size = page.viewportSize()!;
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

test('a founder builds a dashboard, reads figures with their labels, and works it by keyboard @desktop-only', async ({
  page,
}, info) => {
  test.setTimeout(300_000);
  const s = await seed(page, info, 'ins');
  await page.goto(`/workspaces/${s.ws}/home`);
  await goTo(page, 'Reports');
  await expect(h1(page)).toHaveText('Reports');
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
  await accessible(page, 'reports, empty');

  // Create an owner dashboard with the suggested widgets.
  await page.getByRole('button', { name: 'New dashboard' }).click();
  const create = page.getByRole('dialog', { name: 'New dashboard' });
  await create.getByLabel(/^Title/).fill('Everything');
  await create.getByLabel('Kind').selectOption('owner');
  await create.getByRole('button', { name: 'Create dashboard' }).click();
  await expect(h1(page)).toHaveText('Everything');
  const open = page.getByRole('region', { name: 'Open tasks', exact: true }).first();
  await expect(open).toBeVisible();
  // Three tasks are open (Harbor: one open; Vault: two) and the figure says what it covers.
  await expect(open.getByLabel('Open tasks by group')).toBeVisible();
  await expect(open).toContainText('Work you can read in every brand you can access');
  await expect(open).toContainText('Computed from current records');
  await expect(open).toContainText('Source: Tasks and projects');
  await accessible(page, 'dashboard');

  // The same data as a table, then the records behind it, all by keyboard.
  await open.getByText('View data').click();
  await expect(open.getByRole('table', { name: 'Open tasks: data' })).toBeVisible();
  const records = open.getByRole('button', { name: 'Show records' });
  await records.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: /Records behind/ });
  await expect(dialog.getByRole('link', { name: 'Publish the homepage' })).toBeVisible();
  await expect(dialog).toContainText('Secret task one');
  await accessible(page, 'dashboard records');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(records).toBeFocused();

  // Filters narrow the figures and say which widgets they do not apply to.
  await page.getByText('Filters').first().click();
  await page.getByLabel('Brand', { exact: true }).selectOption({ label: 'Harbor' });
  await expect(open.locator('.ins-value')).toHaveAttribute('aria-label', 'Open tasks: 1');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(open.locator('.ins-value')).toHaveAttribute('aria-label', 'Open tasks: 3');

  // Layout editing from the keyboard: move a widget down, announce it, and save.
  await page.getByRole('button', { name: 'Edit widgets' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit widgets' });
  await expect(editor.getByText('Loading the metric catalog')).toHaveCount(0);
  const first = editor.getByRole('button', { name: /^Move .* down$/ }).first();
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(editor.getByText(/moved to position 2/)).toBeVisible();
  await editor.getByRole('button', { name: 'Save widgets' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Export downloads a file; trash, find it in Trash, and restore it.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export all as CSV' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);
  await expect(page.getByText('Exported CSV.')).toBeVisible();
  await page.getByRole('button', { name: 'Move to trash' }).click();
  await page
    .getByRole('alertdialog', { name: 'Move this dashboard to trash?' })
    .getByRole('button', { name: 'Move to trash' })
    .click();
  await expect(h1(page)).toHaveText('Reports');
  await expect(page.getByRole('link', { name: 'Everything' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show trash' }).click();
  await page.getByRole('button', { name: 'Restore Everything' }).click();
  await expect(page.getByText('Restored Everything.')).toBeVisible();
  await page.getByRole('link', { name: 'Everything' }).click();
  await expect(h1(page)).toHaveText('Everything');

  const url0 = page.url();
  // Home carries the situation overview for the brands in scope, and a project has its own
  // Reports section with its figures and saved dashboards.
  await page.goto(`/workspaces/${s.ws}/home`);
  const overview = page.getByRole('region', { name: /at a glance|Across your brands/ });
  await expect(overview).toBeVisible();
  await expect(overview.getByRole('region', { name: 'Open tasks', exact: true })).toContainText(
    'Computed from current records',
  );
  await accessible(page, 'home overview');
  await page.goto(`/workspaces/${s.ws}/projects/${s.site.id}/reports`);
  await expect(page.getByRole('heading', { name: 'This project at a glance' })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Open tasks', exact: true }).locator('.ins-value'),
  ).toHaveAttribute('aria-label', 'Open tasks: 1');
  await expect(page.getByText('Nothing saved for this project yet.')).toBeVisible();
  await accessible(page, 'project reports');
  await page.goto(url0);

  // Appearance and reflow.
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await accessible(page, 'dashboard, forced colours and reduced motion');
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });
  const url = page.url();
  await reflow(page, url, () => expect(h1(page)).toHaveText('Everything'), 'dashboard');
  await reflow(
    page,
    `/workspaces/${s.ws}/reports`,
    () => expect(h1(page)).toHaveText('Reports'),
    'reports list',
  );
});

test('narrower access gives smaller figures and no hidden names; shares open and close reports; scheduling needs recipients @desktop-only', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(300_000);
  const s = await seed(page, info, 'ins-vis');
  const viewer = await person(browser, page, s.ws, info, 'ins-viewer', 'Vera Viewer', 'Member');
  await giveBrand(page, s.ws, 'Harbor', 'Vera Viewer', 'view');
  const dash = await api(page, 'POST', `${s.base}/dashboards`, {
    title: 'Shared overview',
    kind: 'owner',
    layout: {
      widgets: [
        { id: 'open', metric: 'tasks.open' },
        { id: 'byproject', metric: 'tasks.open', params: { group_by: 'project' } },
      ],
    },
  });

  // The founder sees both projects; the member sees only Harbor's, and never the secret names.
  await page.goto(`/workspaces/${s.ws}/dashboards/${dash.id}`);
  const grouped = page.getByLabel('Open tasks by group').first();
  await expect(grouped).toContainText('Secret roadmap project');
  await viewer.page.goto(`/workspaces/${s.ws}/dashboards/${dash.id}`);
  await expect(h1(viewer.page)).toHaveText('Shared overview');
  await expect(viewer.page.getByLabel('Open tasks by group').first()).toContainText('Launch site');
  await expect(viewer.page.locator('main')).not.toContainText('Secret');
  await expect(viewer.page.locator('main')).not.toContainText('Vault');
  // The member's export holds the same narrower figures.
  const csv = await get(viewer.page, `${s.base}/dashboards/${dash.id}/export?format=csv`);
  expect(csv.status()).toBe(200);
  expect(await csv.text()).not.toContain('Secret');
  await accessible(viewer.page, 'dashboard as a narrower member');

  // A report in Vault is not even listed to the member, until it is shared; revoking closes it.
  const report = await api(page, 'POST', `${s.base}/reports`, {
    title: 'Vault digest',
    brand: s.vault,
    layout: { widgets: [{ id: 'open', metric: 'tasks.open' }] },
  });
  await viewer.page.goto(`/workspaces/${s.ws}/reports/${report.id}`);
  await expect(viewer.page.getByText(/may have been moved or deleted/i)).toBeVisible();
  await page.goto(`/workspaces/${s.ws}/reports/${report.id}`);
  await page.getByRole('button', { name: 'Share' }).click();
  const share = page.getByRole('dialog', { name: 'Share this report' });
  await share.getByLabel('Share with').selectOption({ label: 'Vera Viewer' });
  await share.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(
    share.getByRole('list', { name: 'People this report is shared with' }),
  ).toContainText('Vera Viewer');
  await viewer.page.goto(`/workspaces/${s.ws}/reports/${report.id}`);
  await expect(h1(viewer.page)).toHaveText('Vault digest');
  // A share opens the saved report; the numbers are still the member's own (nothing in Vault).
  await expect(viewer.page.getByLabel('Open tasks: 0')).toBeVisible();
  await expect(viewer.page.getByRole('button', { name: 'Schedule' })).toHaveCount(0);
  await expect(viewer.page.getByRole('button', { name: 'Share' })).toHaveCount(0);
  await accessible(viewer.page, 'shared report');
  await share.getByRole('button', { name: 'Revoke the share with Vera Viewer' }).click();
  await expect(share.getByText('Not shared with anyone.')).toBeVisible();
  await viewer.page.reload();
  await expect(viewer.page.getByText(/may have been moved or deleted/i)).toBeVisible();
  await share.getByRole('button', { name: 'Done' }).click();

  // Scheduling needs recipients first, then shows the schedule in words.
  await page.getByRole('button', { name: 'Schedule' }).click();
  const sched = page.getByRole('dialog', { name: 'Schedule delivery' });
  await sched.getByLabel('Send this report on a schedule').check();
  await sched.getByRole('button', { name: 'Save schedule' }).click();
  await expect(sched.getByRole('alert')).toContainText(/who receives the report/i);
  await sched.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Recipients' }).click();
  const rec = page.getByRole('dialog', { name: 'Recipients' });
  await rec.getByLabel(/Fay Founder/).check();
  await rec.getByRole('button', { name: 'Save recipients' }).click();
  await page.getByRole('button', { name: 'Schedule' }).click();
  const sched2 = page.getByRole('dialog', { name: 'Schedule delivery' });
  await sched2.getByLabel('Send this report on a schedule').check();
  await sched2.getByLabel('How often').selectOption('daily');
  await sched2.getByRole('button', { name: 'Save schedule' }).click();
  await expect(page.getByText(/Every day at 08:00/)).toBeVisible();
  await accessible(page, 'scheduled report');

  await viewer.ctx.close();
});
