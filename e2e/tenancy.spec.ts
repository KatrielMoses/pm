import { expect, test } from '@playwright/test';
import {
  createBrand,
  createWorkspace,
  expectAccessible,
  noHorizontalOverflow,
  owner,
  PASSWORD,
} from './support.ts';

/** Phase 1C: account → workspace → brands, settings, context switching, sensitivity, archive. */

test('owner journey: workspace, three brands, settings, switcher, sensitivity, archive and restore', async ({
  page,
}, info) => {
  await owner(page, info, 'tenancy');
  await expectAccessible(page, 'create workspace');

  // Validation keeps input and focuses the summary.
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('alert')).toContainText('Enter a workspace name');
  const ws = await createWorkspace(page, 'Harbor Studio');
  await expectAccessible(page, 'first brand');

  await createBrand(page, 'Coastline');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Harbor Studio');
  await expectAccessible(page, 'workspace home');
  for (const name of ['Summit', 'Meadow']) {
    await page.getByRole('link', { name: 'Add a brand' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Add a brand');
    await createBrand(page, name, 'Star');
  }
  // Duplicate name (case-insensitive) is refused with a field error; input is kept.
  await page.getByRole('link', { name: 'Add a brand' }).click();
  await page.getByLabel(/^Brand name/).fill('summit');
  await page.getByRole('button', { name: 'Create brand' }).click();
  await expect(page.getByRole('alert')).toContainText('That name is not available');
  await expect(page.getByLabel(/^Brand name/)).toHaveValue('summit');
  await page.getByRole('link', { name: 'Cancel' }).click();

  const active = page.getByRole('region', { name: /Active brands/ });
  await expect(active.getByRole('listitem')).toHaveCount(3);

  // Switcher: one brand, then all brands; the selection persists across reloads.
  const switcher = page.getByLabel('Showing');
  await expect(switcher).toHaveValue(/br_/);
  await switcher.selectOption({ label: 'All brands (3)' });
  await expect(page.getByText('Now showing all 3 brands you can access.')).toBeAttached();
  await page.reload();
  await expect(page.getByLabel('Showing')).toHaveValue('all');
  await page.getByLabel('Showing').selectOption({ label: 'Summit' });
  await page.reload();
  await expect(page.getByLabel('Showing').locator('option:checked')).toHaveText('Summit');

  // Workspace settings: field-merge save with success announcement.
  await page.getByRole('link', { name: 'Workspace settings' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workspace settings');
  await page.getByLabel('Currency').selectOption('USD');
  await page.getByRole('button', { name: 'Save workspace settings' }).click();
  await expect(page.getByText('Workspace settings saved.')).toBeVisible();
  await expectAccessible(page, 'workspace settings');

  // Brand settings: identity, working hours (overlap validation), priorities.
  await page.getByRole('link', { name: 'Brands', exact: true }).click();
  await active.getByRole('link', { name: 'Settings for Summit' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Summit settings');
  await expectAccessible(page, 'brand settings');
  await page.getByLabel('Short name').fill('SMT');
  await page.getByLabel('Status').selectOption('paused');
  await page.getByRole('button', { name: 'Save identity' }).click();
  await expect(page.getByText('Brand identity saved.')).toBeVisible();

  const hours = page.getByRole('region', { name: 'Working hours' });
  await expect(hours).toContainText('Europe/Lisbon');
  const monday = hours.getByRole('group', { name: 'Monday' });
  await monday.getByRole('button', { name: 'Add a time range on Monday' }).click();
  await monday.getByLabel('From (Monday, range 2)').fill('16:00');
  await monday.getByLabel('To (Monday, range 2)').fill('18:00');
  await hours.getByRole('button', { name: 'Save working hours' }).click();
  await expect(hours.getByRole('alert')).toContainText('overlaps another range on Monday');
  await monday.getByLabel('From (Monday, range 2)').fill('17:30');
  const saturday = hours.getByRole('group', { name: 'Saturday' });
  await saturday.getByLabel('Open on Saturday').check();
  await saturday.getByLabel('From (Saturday, range 1)').fill('10:00');
  await saturday.getByLabel('To (Saturday, range 1)').fill('24:00');
  await hours.getByRole('button', { name: 'Save working hours' }).click();
  await expect(page.getByText('Working hours saved.')).toBeVisible();

  const cal = page.getByRole('region', { name: 'Calendar' });
  await cal.getByLabel('Default view').selectOption('month');
  await cal.getByLabel('Show weekends').check();
  await cal.getByRole('button', { name: 'Save calendar settings' }).click();
  await expect(page.getByText('Calendar settings saved.')).toBeVisible();

  const prios = page.getByRole('region', { name: 'Goals and priorities' });
  await prios.getByRole('button', { name: 'Add an entry' }).click();
  await prios.getByLabel('Entry 1', { exact: true }).fill('Open the second shop');
  await prios.getByRole('button', { name: 'Add an entry' }).click();
  await prios.getByLabel('Type of entry 2').selectOption('goal');
  await prios.getByLabel('Entry 2', { exact: true }).fill('Reach 500 subscribers');
  await prios.getByRole('button', { name: 'Move up entry 2' }).click();
  await expect(prios.getByLabel('Entry 1', { exact: true })).toHaveValue('Reach 500 subscribers');
  await prios.getByRole('button', { name: 'Save goals and priorities' }).click();
  await expect(page.getByText('Goals and priorities saved.')).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole('region', { name: 'Goals and priorities' })
      .getByLabel('Entry 1', { exact: true }),
  ).toHaveValue('Reach 500 subscribers');

  // Sensitive brand: consequences first, then step-up (password), then the badge.
  await page.getByRole('button', { name: 'Mark as sensitive…' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Mark Summit as sensitive?' });
  await expect(confirm).toContainText('lose automatic access');
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expectAccessible(page, 'sensitivity confirmation');
  await confirm.getByRole('button', { name: 'Mark as sensitive' }).click();
  const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(stepUp).toBeVisible();
  await stepUp.getByLabel(/^Password/).fill(PASSWORD);
  await stepUp.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Summit is now sensitive.')).toBeAttached();
  await expect(page.locator('.badge-danger').first()).toHaveText('Sensitive');

  // Archive: confirmation starts on Cancel; the brand moves to Archived and leaves the switcher.
  await page.getByRole('button', { name: 'Archive brand…' }).click();
  const archive = page.getByRole('alertdialog', { name: 'Archive Summit?' });
  await expect(archive.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await archive.getByRole('button', { name: 'Archive brand' }).click();
  await expect(page.getByText('This brand is archived')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save identity' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to brands' }).click();
  await expect(
    page.getByRole('region', { name: /Archived brands/ }).getByRole('listitem'),
  ).toHaveCount(1);
  await expect(page.getByLabel('Showing').locator('option')).toHaveText([
    'All brands (2)',
    'Coastline',
    'Meadow',
  ]);
  await expect(page.getByText('Your last selection is no longer available')).toBeVisible();
  await page.getByRole('button', { name: 'Restore Summit' }).click();
  await expect(page.getByText('Summit was restored.')).toBeAttached();
  await expect(
    page.getByRole('region', { name: /Active brands/ }).getByRole('listitem'),
  ).toHaveCount(3);
  await expectAccessible(page, 'workspace home after restore');

  // Nothing internal leaks into the page.
  const html = await page.content();
  expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/);
  expect(html).not.toMatch(/mem_[0-9A-Z]{26}/);
  expect(ws).toMatch(/^ws_/);
});

test('states: not found, conflict, offline, keyboard, zoom, reduced motion, high contrast', async ({
  page,
  browser,
}, info) => {
  await owner(page, info, 'tenancy-states');
  const ws = await createWorkspace(page, 'States Co');
  await createBrand(page, 'Orchard');

  // Not found and no access look the same, including for a well-formed guessed ID.
  await page.goto(`/workspaces/${ws}/brands/br_01J0000000000000000000000Z`);
  await expect(page.getByText("We can't find this brand")).toBeVisible();
  await page.goto('/workspaces/ws_01J0000000000000000000000Z');
  await expect(page.getByText("We can't find this workspace")).toBeVisible();
  await expectAccessible(page, 'not found');

  // A second account cannot open the first owner's workspace.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await owner(otherPage, info, 'tenancy-other');
  await otherPage.goto(`/workspaces/${ws}`);
  await expect(otherPage.getByText("We can't find this workspace")).toBeVisible();
  await other.close();

  // Conflict: another tab changes the same field; my input is kept and I choose.
  await page.goto(`/workspaces/${ws}/settings`);
  await page.getByLabel(/^Workspace name/).fill('States Company');
  const tab = await page.context().newPage();
  await tab.goto(`/workspaces/${ws}/settings`);
  await tab.getByLabel(/^Workspace name/).fill('States Incorporated');
  await tab.getByRole('button', { name: 'Save workspace settings' }).click();
  await expect(tab.getByText('Workspace settings saved.')).toBeVisible();
  await tab.close();
  await page.getByRole('button', { name: 'Save workspace settings' }).click();
  await expect(
    page.getByText('This was changed by someone else while you were editing'),
  ).toBeVisible();
  await expect(page.getByText('name is now “States Incorporated”')).toBeVisible();
  await expect(page.getByLabel(/^Workspace name/)).toHaveValue('States Company');
  await page.getByRole('button', { name: 'Keep my changes' }).click();
  await page.getByRole('button', { name: 'Save workspace settings' }).click();
  await expect(page.getByText('Workspace settings saved.')).toBeVisible();

  // Offline: the save explains nothing was sent and the input stays.
  await page.context().setOffline(true);
  await page.evaluate('window.dispatchEvent(new Event("offline"))');
  await page.getByLabel(/^Workspace name/).fill('Offline Edit');
  await page.getByRole('button', { name: 'Save workspace settings' }).click();
  await expect(page.getByText("You're offline", { exact: false }).first()).toBeVisible();
  await expect(page.getByLabel(/^Workspace name/)).toHaveValue('Offline Edit');
  await page.context().setOffline(false);
  await page.evaluate('window.dispatchEvent(new Event("online"))');

  // Keyboard: switcher is a native select reachable by Tab; links and buttons operate by Enter.
  await page.goto(`/workspaces/${ws}`);
  await page.getByLabel('Showing').focus();
  await expect(page.getByLabel('Showing')).toBeFocused();
  await page.getByRole('link', { name: 'Settings for Orchard' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Orchard settings');
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();

  // Reduced motion and forced colors keep everything perceivable.
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Orchard settings');
  await expectAccessible(page, 'brand settings, forced colors');
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });

  // 200% zoom (half the CSS width) and 320px: content reflows without horizontal scrolling.
  const size = page.viewportSize()!;
  for (const width of [Math.max(320, Math.floor(size.width / 2)), 320]) {
    await page.setViewportSize({ width, height: size.height });
    for (const path of [`/workspaces/${ws}`, `/workspaces/${ws}/settings`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await noHorizontalOverflow(page), `${path} at ${width}px`).toBeLessThanOrEqual(0);
    }
    await page.getByRole('link', { name: 'Brands', exact: true }).click();
    await page.getByRole('link', { name: 'Settings for Orchard' }).click();
    await expect(page.getByRole('region', { name: 'Working hours' })).toBeVisible();
    expect(await noHorizontalOverflow(page), `brand settings at ${width}px`).toBeLessThanOrEqual(0);
    await expectAccessible(page, `brand settings at ${width}px`);
  }
});
