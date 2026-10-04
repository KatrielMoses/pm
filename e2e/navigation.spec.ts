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
 * Phase 1E: the application shell on desktop, tablet, and mobile: one route registry for every
 * navigation surface, scope in URLs and history, the command palette and shortcuts, favorites,
 * recently viewed, view state, breadcrumbs, titles, themes, and responsive behavior.
 */

async function workspaceWithBrands(page: Page, prefix: string, info: Parameters<typeof owner>[1]) {
  await owner(page, info, prefix, 'Nora Navigator');
  const ws = await createWorkspace(page, 'Shell Co');
  await createBrand(page, 'Alder');
  for (const name of ['Birch', 'Cedar']) {
    await page.goto(`/workspaces/${ws}/brands/new`);
    await createBrand(page, name, 'Star');
  }
  return ws;
}

const scopeButton = (page: Page) => page.getByRole('button', { name: /^Brand scope:/ });

async function chooseScope(page: Page, name: string) {
  await scopeButton(page).click();
  await page.getByRole('listbox', { name: 'Brand scope' }).getByRole('option', { name }).click();
  // The switcher (a sheet on Compact) closes once the server confirmed the scope.
  await expect(page.getByRole('listbox', { name: 'Brand scope' })).toHaveCount(0);
}

/** The page's own Mod key (Command on Apple platforms, Control elsewhere), as the app decides. */
async function mod(page: Page): Promise<'Meta' | 'Control'> {
  const apple = await page.evaluate<boolean>(
    "/mac|iphone|ipad|ipod/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? '')",
  );
  return apple ? 'Meta' : 'Control';
}

async function openPalette(page: Page) {
  await page.keyboard.press(`${await mod(page)}+K`);
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  return page.getByRole('combobox', { name: 'Search commands, pages, and records' });
}

test('one registry drives every navigation surface; destinations are honest and addressable', async ({
  page,
}, info) => {
  const ws = await workspaceWithBrands(page, 'nav-surfaces', info);
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(page.locator('header.app-header')).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
  if (info.project.name === 'mobile') {
    // Compact: exactly five bottom slots (RS-05).
    await expect(nav.getByRole('listitem')).toHaveCount(5);
    await expect(nav.getByRole('button', { name: 'More' })).toBeVisible();
    await expect(nav.getByRole('link')).toHaveText([/Home/, /Today/, /Inbox/, /Work/]);
  } else {
    for (const name of [
      'Home',
      'Today',
      'Inbox',
      'My Work',
      'Projects',
      'Calendar',
      'Knowledge',
      'Goals',
      'Reports',
    ])
      await expect(nav.getByRole('link', { name, exact: true })).toBeAttached();
  }
  // Later destinations are real routes with an honest unavailable state and the scope in the URL.
  for (const [name, path] of [
    ['Today', 'today'],
    ['Reports', 'reports'],
  ] as const) {
    await goTo(page, name);
    await expect(page).toHaveURL(new RegExp(`/workspaces/${ws}/${path}\\?scope=`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    await expect(page.getByText(`${name} isn't available yet`)).toBeVisible();
    await expect(page).toHaveTitle(`${name} · PM`);
  }
  await expectAccessible(page, 'unavailable destination');
  // Every navigation element is a real link (new-tab capable).
  const href = await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Home', exact: true })
    .getAttribute('href');
  expect(href).toMatch(new RegExp(`^/workspaces/${ws}/home\\?scope=`));
});

test('scope lives in the URL: push on change, Back and reload restore it, a record outside scope switches and reverts', async ({
  page,
  context,
}, info) => {
  const ws = await workspaceWithBrands(page, 'nav-scope', info);
  await page.goto(`/workspaces/${ws}/home`);
  await expect(scopeButton(page)).toHaveAccessibleName(/Brand scope: Alder/);
  const first = page.url();
  await chooseScope(page, 'All brands');
  await expect(page).toHaveURL(/scope=all/);
  await expect(
    page.getByRole('region', { name: /Active brands/ }).getByRole('listitem'),
  ).toHaveCount(3);
  // Multi-select with Apply.
  await scopeButton(page).click();
  await page.getByRole('button', { name: 'Select multiple…' }).click();
  const list = page.getByRole('listbox', { name: 'Choose brands' });
  await list.getByRole('option', { name: 'Birch' }).click();
  await page.getByRole('button', { name: /^Apply/ }).click();
  await expect(scopeButton(page)).toHaveAccessibleName(/Brand scope: 2 brands/);
  await expect(page).toHaveURL(/scope=brands%3Abr_|scope=brands:br_/);
  const multi = page.url();
  // Back and Forward restore page and scope together (RS-21 push).
  await page.goBack();
  await expect(page).toHaveURL(/scope=all/);
  await expect(scopeButton(page)).toHaveAccessibleName(/Brand scope: All brands/);
  await page.goBack();
  expect(page.url()).toBe(first);
  await expect(scopeButton(page)).toHaveAccessibleName(/Brand scope: Alder/);
  await page.goForward();
  await page.goForward();
  await expect(scopeButton(page)).toHaveAccessibleName(/Brand scope: 2 brands/);
  // Reload and a new tab with the same URL reproduce the scope.
  await page.reload();
  await expect(scopeButton(page)).toHaveAccessibleName(/Brand scope: 2 brands/);
  const tab = await context.newPage();
  await tab.goto(multi);
  await expect(tab.getByRole('button', { name: /^Brand scope:/ })).toHaveAccessibleName(/2 brands/);
  await tab.close();
  // A tampered scope naming an unknown brand narrows safely without naming anything.
  await page.goto(`/workspaces/${ws}/home?scope=brand:br_01J0000000000000000000000Z`);
  await expect(page.getByText("Some brands in that link aren't available to you")).toBeVisible();
  await expect(page).not.toHaveURL(/br_01J0000000000000000000000Z/);
  // IA-25: opening a brand outside the current scope switches to it; Back restores both.
  await chooseScope(page, 'Alder');
  await expect(page).toHaveURL(/scope=brand/);
  const home = page.url();
  await openPalette(page).then((box) => box.fill('Cedar'));
  await page.getByRole('option', { name: /Cedar/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Cedar settings');
  await expect(page.getByText('Switched to Cedar')).toBeVisible();
  await expect(scopeButton(page)).toHaveAccessibleName(/Brand scope: Cedar/);
  await page.getByRole('button', { name: 'Back to previous scope' }).click();
  await expect(scopeButton(page)).toHaveAccessibleName(/Brand scope: Alder/);
  await page.goBack();
  expect(page.url()).toBe(home);
  await expect(scopeButton(page)).toHaveAccessibleName(/Brand scope: Alder/);
});

test('palette, shortcuts, favorites, recents, breadcrumbs, and titles', async ({ page }, info) => {
  const ws = await workspaceWithBrands(page, 'nav-palette', info);
  await page.goto(`/workspaces/${ws}/home?scope=all`);
  // Palette: Actions first, ">" restricts to actions, records carry their brand marker.
  const box = await openPalette(page);
  await expectAccessible(page, 'palette');
  await box.fill('>');
  await expect(page.getByRole('group').first()).toContainText('Actions');
  await expect(page.getByRole('option', { name: /Today/ })).toHaveCount(0);
  await box.fill('birch');
  const record = page.getByRole('option', { name: /Birch/ });
  await expect(record).toContainText('Brand');
  await box.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Birch settings');
  // Titles exclude brand names (UXD-07); the breadcrumb starts at the brand marker.
  await expect(page).toHaveTitle('Brand settings · PM');
  const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumbs).toContainText('Birch');
  // Favorites: add from the record page, then reorder with buttons and keep focus.
  await page.getByRole('button', { name: 'Add to favorites' }).click();
  await expect(page.getByRole('button', { name: 'In favorites' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.goto(`/workspaces/${ws}/home`);
  await page.getByRole('link', { name: 'Settings for Alder' }).click();
  await page.getByRole('button', { name: 'Add to favorites' }).click();
  await expect(page.getByRole('button', { name: 'In favorites' })).toBeVisible();
  await page.goto(`/workspaces/${ws}/favorites`);
  const favs = page.getByRole('main').getByRole('listitem');
  await expect(favs).toHaveText([/Birch/, /Alder/]);
  await page.getByRole('button', { name: 'Move up Alder' }).click();
  await expect(page.getByText('Alder moved up to position 1.')).toBeAttached();
  await expect(favs).toHaveText([/Alder/, /Birch/]);
  // At the top "Move up" no longer applies, so focus stays on the item with its "Move down".
  await expect(page.getByRole('button', { name: 'Move down Alder' })).toBeFocused();
  await expectAccessible(page, 'favorites');
  // Recently viewed: grouped by day, filterable, selection pruned when filters hide items.
  await page.goto(`/workspaces/${ws}/recent`);
  await expect(page.getByRole('heading', { name: 'Today', level: 2 })).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: /Alder/ })).toBeVisible();
  await page.getByLabel('Select Alder').check();
  await expect(page.getByRole('button', { name: 'Remove selected (1)' })).toBeEnabled();
  await page.getByLabel('Type').selectOption('team');
  await expect(page).toHaveURL(/type=team/);
  await expect(
    page.getByText('1 selected item is no longer shown and was deselected.'),
  ).toBeAttached();
  await expect(page.getByRole('button', { name: 'Remove selected (0)' })).toBeDisabled();
  await page.goBack();
  await expectAccessible(page, 'recently viewed');
  // Keyboard shortcuts (fine pointers only by default; UXD-04).
  if (info.project.name === 'desktop') {
    await page.goto(`/workspaces/${ws}/home`);
    await page.locator('body').press('g');
    await page.locator('body').press('t');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Today');
    await page.locator('body').press('Shift+?');
    const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(help).toContainText(/Ctrl\+K|⌘K/);
    await expect(help).toContainText('G then H');
    await help.getByRole('button', { name: 'Close' }).click();
    // Never while typing.
    await openPalette(page).then((b) => b.fill('gh'));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Today');
    await page.keyboard.press('Escape');
  }
});

test('preferences: theme before first paint, system following, shortcuts off, hidden destinations @desktop-only', async ({
  page,
}, info) => {
  const ws = await workspaceWithBrands(page, 'nav-prefs', info);
  await page.goto('/settings/preferences');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Preferences');
  await expectAccessible(page, 'preferences');
  await page.getByRole('radio', { name: 'Dark' }).check();
  await expect(page.getByText('Theme set to Dark.')).toBeAttached();
  // Before first paint: with the application bundle blocked, only the pre-paint script runs, and
  // it must already apply the stored theme (no flash of the wrong theme; DS-23).
  await page.route('**/assets/*.js', (r) => r.abort());
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
  await page.unroute('**/assets/*.js');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Preferences');
  // System mode follows the operating system live; explicit modes do not.
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
  await page.getByRole('radio', { name: 'Match my device' }).check();
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-color-scheme', 'dark');
  await expectAccessible(page, 'preferences, dark theme');
  // Shortcuts off: single keys stop; Ctrl/⌘+K still works.
  await page.getByRole('radio', { name: 'Off', exact: true }).check();
  await expect(page.getByText('Single-key shortcuts are off.')).toBeAttached();
  await page.goto(`/workspaces/${ws}/home`);
  await page.locator('body').press('g');
  await page.locator('body').press('t');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Shell Co');
  await openPalette(page);
  await page.keyboard.press('Escape');
  // Hidden destinations leave every surface (UXD-20) but stay addressable.
  await page.goto('/settings/preferences');
  await page.getByLabel('Show Goals').uncheck();
  await expect(page.getByText('Goals is hidden.')).toBeAttached();
  await page.goto(`/workspaces/${ws}/home`);
  await expect(
    page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Goals' }),
  ).toHaveCount(0);
  const box = await openPalette(page);
  await box.fill('goals');
  await expect(page.getByRole('option', { name: /Goals/ })).toHaveCount(0);
});

test('read-only members see no administration; removal ends shell access on the next request @no-tablet', async ({
  page,
  browser,
}, info) => {
  const ws = await workspaceWithBrands(page, 'nav-roles', info);
  const email = uniqueEmail('nav-reader', info);
  await page.goto(`/workspaces/${ws}/people/invite`);
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel('Role').selectOption({ label: 'Read-only' });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('People');
  const other = await browser.newContext({ ...(info.project.use as object) });
  const rp = await other.newPage();
  const mail = await waitForMail(email, 'invited');
  await openLink(rp, linkPath(mail));
  await register(rp, email, 'Rory Reader');
  await verify(rp, email);
  await signedIn(rp, email);
  await rp.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(rp.getByRole('heading', { level: 1 })).toBeVisible();
  await rp.goto(`/workspaces/${ws}/home`);
  // Absent, not disabled: no administration, no create actions, nothing hidden in the palette.
  await expect(rp.getByRole('link', { name: 'Workspace settings' })).toHaveCount(0);
  await expect(rp.getByRole('button', { name: 'Create' })).toHaveCount(0);
  const box = await openPalette(rp);
  await box.fill('>');
  await expect(
    rp.getByRole('option', { name: /Add a brand|Invite people|Create a team/ }),
  ).toHaveCount(0);
  await rp.keyboard.press('Escape');
  await rp.goto(`/workspaces/${ws}/settings`);
  await expect(rp.getByRole('heading', { level: 1 })).toHaveText("This page isn't available");
  // The owner removes them; their next request no longer reaches the workspace shell.
  await page.goto(`/workspaces/${ws}/people`);
  await page.getByRole('link', { name: 'Access and actions for Rory Reader' }).click();
  await page.getByRole('button', { name: 'Remove from workspace…' }).click();
  await page
    .getByRole('alertdialog', { name: 'Remove Rory Reader?' })
    .getByRole('button', { name: 'Continue' })
    .click();
  await page
    .getByRole('alertdialog', { name: 'Confirm removing Rory Reader' })
    .getByRole('button', { name: 'Remove from workspace' })
    .click();
  const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
  await stepUp.getByLabel(/^Password/).fill(PASSWORD);
  await stepUp.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('People');
  await rp.goto(`/workspaces/${ws}/recent`);
  await expect(rp.getByRole('heading', { level: 1 })).toHaveText(
    /Sign in|This page isn't available/,
  );
  await other.close();
});

test('responsive boundaries, reflow, zoom, landmarks, skip links, forced colors, short viewports @desktop-only', async ({
  page,
}, info) => {
  const ws = await workspaceWithBrands(page, 'nav-widths', info);
  const expectations: Array<[number, 'bottom' | 'rail' | 'sidebar']> = [
    [599, 'bottom'],
    [600, 'rail'],
    [1023, 'rail'],
    [1024, 'sidebar'],
    [1439, 'sidebar'],
    [1440, 'sidebar'],
    [320, 'bottom'],
  ];
  for (const [width, kind] of expectations) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/workspaces/${ws}/home`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const sidebar = page.locator('nav.app-nav');
    const bottom = page.locator('nav.bottom-nav');
    if (kind === 'bottom') {
      await expect(bottom).toBeVisible();
      await expect(sidebar).toBeHidden();
    } else {
      await expect(sidebar).toBeVisible();
      await expect(bottom).toHaveCount(0);
      const label = sidebar.locator('.nav-label').first();
      if (kind === 'rail') await expect(label).toBeHidden();
      else await expect(label).toBeVisible();
    }
    expect(await noHorizontalOverflow(page), `home at ${width}px`).toBeLessThanOrEqual(0);
  }
  // 400% zoom at 1280 px is a 320 CSS px viewport: everything reflows (checked above) and works.
  await page.setViewportSize({ width: 320, height: 640 });
  await goTo(page, 'Favorites');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Favorites');
  expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(0);
  // Short viewport (phone landscape): sticky header stays under 25% of the height.
  await page.setViewportSize({ width: 800, height: 400 });
  await page.goto(`/workspaces/${ws}/home`);
  const header = await page.locator('header.app-header').boundingBox();
  expect(header!.height).toBeLessThanOrEqual(100);
  // Keyboard: the first Tab reaches the skip link, which moves focus into main.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/workspaces/${ws}/home`);
  // The skip link is the first focusable element and becomes visible when focused.
  const skip = page.getByRole('link', { name: 'Skip to main content' });
  const first = await page.evaluate<string>(
    "document.querySelector('a, button, input, select, textarea')?.textContent ?? ''",
  );
  expect(first).toBe('Skip to main content');
  await skip.focus();
  const box = await skip.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  // Forced colors and reduced motion keep current-page and focus indicators perceivable.
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await page.reload();
  await expectAccessible(page, 'home, forced colors');
  const current = page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Home', exact: true });
  await expect(current).toHaveAttribute('aria-current', 'page');
  // Collapsing the sidebar is remembered on this device.
  await page.getByRole('button', { name: 'Collapse navigation' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Expand navigation' })).toBeVisible();
});
