import { expect, test, type Page } from '@playwright/test';
import {
  createBrand,
  createWorkspace,
  expectAccessible,
  goTo,
  noHorizontalOverflow,
  linkPath,
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
 * Phase 2A: projects on desktop, tablet, and mobile. The first project needs only a name; the
 * project page has the fixed section order with honest later sections; the hierarchy tree works by
 * keyboard with visible Move/Indent/Outdent actions; settings handle conflicts, offline, archive,
 * restriction, and duplicate; every state is accessible and reflows to 320 px.
 */

const SECTIONS = [
  'Overview',
  'Tasks',
  'Timeline',
  'Calendar',
  'Documents',
  'Files',
  'Activity',
  'Time',
  'Costs',
  'Reports',
  'Settings',
];
const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const sections = (page: Page) => page.getByRole('navigation', { name: 'Project sections' });

async function createProject(page: Page, name: string, brand?: string): Promise<string> {
  const dialog = page.getByRole('dialog', { name: 'Create project' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/^Project name/).fill(name);
  if (brand) await dialog.getByLabel(/^Brand/).selectOption({ label: brand });
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(h1(page)).toHaveText(name);
  return /\/projects\/(prj_[0-9A-Z]{26})$/.exec(page.url())![1]!;
}

test('creates the first useful project without configuration; sections are honest and accessible', async ({
  page,
}, info) => {
  await owner(page, info, 'prj-first', 'Pia Planner');
  const ws = await createWorkspace(page, 'Projects Co');
  await createBrand(page, 'Harbor');
  await goTo(page, 'Projects');
  await expect(h1(page)).toHaveText('Projects');
  await expect(page.getByText('No projects yet.')).toBeVisible();
  await expectAccessible(page, 'projects, empty');
  await page.getByRole('button', { name: 'Create a project' }).click();
  // Single-brand scope: the brand is implied, so the name is the only required field.
  await expect(
    page.getByRole('dialog', { name: 'Create project' }).getByLabel(/^Brand/),
  ).toHaveCount(0);
  const prj = await createProject(page, 'Website relaunch');
  await expect(page).toHaveTitle('Website relaunch · Projects · PM');
  await expect(sections(page).getByRole('link')).toHaveText(SECTIONS);
  await expect(sections(page).getByRole('link', { name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByText('Planned').first()).toBeVisible();
  await expect(page.getByText('Status-based until tasks arrive')).toBeVisible();

  // Overview: a success criterion, an update, and an explicit verification.
  await page.getByLabel('Add a success criterion').fill('Launch page live');
  await page.getByRole('button', { name: 'Add criterion' }).click();
  await expect(page.getByRole('checkbox', { name: /Launch page live/ })).toBeVisible();
  await page.getByLabel('Post an update').fill('Kickoff done');
  await page.getByRole('button', { name: 'Post update' }).click();
  const latest = page.getByRole('region', { name: 'Latest verified update' });
  await expect(latest.getByText('No update has been verified yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Verify this update' }).click();
  await expect(latest.getByText('Kickoff done')).toBeVisible();
  await expectAccessible(page, 'project overview');

  // Timeline is real: phases and milestones as accessible lists.
  await sections(page).getByRole('link', { name: 'Timeline' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${prj}/timeline$`));
  await page.getByLabel('Add a phase').fill('Discovery');
  await page.getByRole('button', { name: 'Add phase' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Phases' })
      .getByRole('listitem')
      .filter({ hasText: /^Discovery/ }),
  ).toBeVisible();
  await page.getByLabel('Add a milestone').fill('Beta');
  await page.getByRole('button', { name: 'Add milestone' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Milestones' })
      .getByRole('listitem')
      .filter({ hasText: /^Beta/ }),
  ).toBeVisible();
  await expectAccessible(page, 'project timeline');

  // Later sections are honest; Tests is addressable but its tab is absent (UXD-14).
  await sections(page).getByRole('link', { name: 'Tasks' }).click();
  await expect(page.getByRole('heading', { name: "Tasks isn't available yet" })).toBeVisible();
  await page.goto(`/workspaces/${ws}/projects/${prj}/tests`);
  await expect(page.getByRole('heading', { name: "Tests isn't available yet" })).toBeVisible();
  await expect(sections(page).getByRole('link', { name: 'Tests' })).toHaveCount(0);

  // The project is in the list, deep-linkable, and reflows on every width class.
  await goTo(page, 'Projects');
  await expect(page.getByRole('link', { name: 'Website relaunch' })).toBeVisible();
  expect(await noHorizontalOverflow(page), 'projects list').toBeLessThanOrEqual(0);
  await page.goto(`/workspaces/${ws}/projects/${prj}`);
  await expect(h1(page)).toHaveText('Website relaunch');
  expect(await noHorizontalOverflow(page), 'project page').toBeLessThanOrEqual(0);
});

test('aggregate scope groups by brand and asks for the brand; the hierarchy tree works by keyboard @desktop-only', async ({
  page,
}, info) => {
  await owner(page, info, 'prj-tree', 'Theo Tree');
  const ws = await createWorkspace(page, 'Tree Co');
  await createBrand(page, 'Harbor');
  await page.goto(`/workspaces/${ws}/brands/new`);
  await createBrand(page, 'Summit', 'Star');
  for (const [name, brand] of [
    ['Launch plan', 'Harbor'],
    ['Launch checklist', 'Harbor'],
    ['Pricing page', 'Summit'],
  ] as const) {
    await page.goto(`/workspaces/${ws}/projects?scope=all`);
    await expect(h1(page)).toHaveText('Projects');
    await page
      .getByRole('button', { name: /^Create (a )?project$/ })
      .first()
      .click();
    await createProject(page, name, brand);
  }
  await page.goto(`/workspaces/${ws}/projects?scope=all`);
  await expect(page.getByRole('region', { name: 'Harbor (2)' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Summit (1)' })).toBeVisible();

  // Hierarchy: one tab stop, arrows and type-ahead, then Indent as a visible action.
  await page.getByRole('button', { name: 'Hierarchy' }).click();
  const tree = page.getByRole('tree', { name: 'Project hierarchy' });
  await expect(tree.getByRole('treeitem')).toHaveCount(3);
  await tree.getByRole('treeitem', { name: /Launch plan/ }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(tree.getByRole('treeitem', { name: /Launch checklist/ })).toBeFocused();
  await page.keyboard.press('p');
  await expect(tree.getByRole('treeitem', { name: /Pricing page/ })).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await expect(tree.getByRole('treeitem', { name: /Launch checklist/ })).toBeFocused();
  const actions = page.getByRole('group', { name: 'Actions for Launch checklist' });
  await actions.getByRole('button', { name: 'Indent' }).click();
  await expect(page.getByText('Launch checklist indented under Launch plan.')).toBeAttached();
  await expect(tree.getByRole('treeitem', { name: /Launch checklist/ })).toHaveAttribute(
    'aria-level',
    '2',
  );
  await expectAccessible(page, 'project tree');
  // Enter opens the focused project; its breadcrumb shows the readable parent.
  await tree.getByRole('treeitem', { name: /Launch checklist/ }).focus();
  await page.keyboard.press('Enter');
  await expect(h1(page)).toHaveText('Launch checklist');
  await expect(
    page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Launch plan' }),
  ).toBeVisible();
});

test('settings: conflict and offline keep input; archive is read-only and reversible; restrict and duplicate', async ({
  page,
}, info) => {
  await owner(page, info, 'prj-settings', 'Sam Settings');
  const ws = await createWorkspace(page, 'Settings Co');
  await createBrand(page, 'Harbor');
  await page.goto(`/workspaces/${ws}/projects`);
  await page.getByRole('button', { name: 'Create a project' }).click();
  const prj = await createProject(page, 'Quarterly review');
  const settings = `/workspaces/${ws}/projects/${prj}/settings`;
  await page.goto(settings);
  await expect(page.getByRole('heading', { name: 'Identity and planning' })).toBeVisible();

  // Conflict: another tab renames first; my input stays and I choose.
  await page.getByLabel(/^Name/).fill('Quarterly business review');
  const tab = await page.context().newPage();
  await tab.goto(settings);
  await tab.getByLabel(/^Name/).fill('Q4 review');
  await tab.getByRole('button', { name: 'Save project' }).click();
  await expect(tab.getByText('Project saved.')).toBeAttached();
  await tab.close();
  await page.getByRole('button', { name: 'Save project' }).click();
  await expect(
    page.getByText('This was changed by someone else while you were editing'),
  ).toBeVisible();
  await expect(page.getByText('name is now “Q4 review”')).toBeVisible();
  await expect(page.getByLabel(/^Name/)).toHaveValue('Quarterly business review');
  await page.getByRole('button', { name: 'Keep my changes' }).click();
  await page.getByRole('button', { name: 'Save project' }).click();
  await expect(page.getByText('Project saved.')).toBeAttached();
  await expect(h1(page)).toHaveText('Quarterly business review');

  // Offline: nothing is sent and the input stays.
  await page.context().setOffline(true);
  await page.evaluate('window.dispatchEvent(new Event("offline"))');
  await page.getByLabel(/^Name/).fill('Offline edit');
  await page.getByRole('button', { name: 'Save project' }).click();
  await expect(page.getByText("You're offline", { exact: false }).first()).toBeVisible();
  await expect(page.getByLabel(/^Name/)).toHaveValue('Offline edit');
  await page.context().setOffline(false);
  await page.evaluate('window.dispatchEvent(new Event("online"))');
  await page.reload();

  // Archive: read-only banner, no edit form; restore brings it back.
  await page.getByRole('button', { name: 'Archive project' }).click();
  await expect(page.getByText('This project is archived')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Identity and planning' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Restore project' }).click();
  await expect(page.getByText('This project is archived')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Identity and planning' })).toBeVisible();

  // Restrict needs a confirmation that explains who keeps access.
  await page.getByRole('button', { name: 'Restrict…' }).click();
  const confirm = page.getByRole('alertdialog', { name: /^Restrict/ });
  await expect(
    confirm.getByText('Brand access, including administrators', { exact: false }),
  ).toBeVisible();
  await confirm.getByRole('button', { name: 'Restrict', exact: true }).click();
  await expect(
    page.getByText('Restricted: only people with explicit project access can see it.'),
  ).toBeVisible();
  await expectAccessible(page, 'project settings, restricted');

  // Duplicate opens the copy; templates and copies never carry people or history.
  await expect(
    page.getByText(
      'People, sharing, updates, decisions, dependencies, and history are never copied.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Duplicate project' }).click();
  await expect(page).not.toHaveURL(new RegExp(prj));
  await expect(h1(page)).toContainText('Quarterly business review');

  // Reduced motion, forced colors, 200% zoom, and 320 px keep settings usable.
  await page.goto(settings);
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Identity and planning' })).toBeVisible();
  await expectAccessible(page, 'project settings, forced colors');
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });
  const size = page.viewportSize()!;
  for (const width of [Math.max(320, Math.floor(size.width / 2)), 320]) {
    await page.setViewportSize({ width, height: size.height });
    await page.goto(settings);
    await expect(page.getByRole('heading', { name: 'Identity and planning' })).toBeVisible();
    expect(await noHorizontalOverflow(page), `settings at ${width}px`).toBeLessThanOrEqual(0);
  }
});

// ---- Recurrence (PRJ-013): every frequency, end conditions, errors, DST intent, permission loss ----

async function recurringProject(page: Page, info: Parameters<typeof owner>[1], prefix: string) {
  await owner(page, info, prefix, 'Rae Recurring');
  const ws = await createWorkspace(page, 'Recurring Co');
  await createBrand(page, 'Harbor');
  await page.goto(`/workspaces/${ws}/projects`);
  await page.getByRole('button', { name: 'Create a project' }).click();
  const prj = await createProject(page, 'Monthly close');
  return { ws, prj, settings: `/workspaces/${ws}/projects/${prj}/settings` };
}

const recurrence = (page: Page) => page.getByRole('region', { name: 'Recurrence' });
const schedules = (page: Page) => page.getByRole('list', { name: 'Recurring schedules' });

async function setUp(
  page: Page,
  r: {
    frequency: 'Daily' | 'Weekly' | 'Monthly' | 'Yearly';
    interval?: string;
    days?: string[];
    monthDay?: string;
    start: string;
    tz: string;
    ends?: { after: string } | { on: string };
  },
) {
  const form = recurrence(page).getByRole('form', { name: 'Set up a recurring schedule' });
  await form.getByLabel('Repeats').selectOption({ label: r.frequency });
  if (r.interval) await form.getByLabel(/^Every how many/).fill(r.interval);
  for (const d of r.days ?? []) await form.getByRole('checkbox', { name: d }).check();
  if (r.monthDay) await form.getByLabel('Day of the month').selectOption(r.monthDay);
  await form.getByLabel(/^First occurrence/).fill(r.start);
  await form.getByLabel('Time zone').selectOption(r.tz);
  if (r.ends && 'after' in r.ends) {
    await form.getByRole('radio', { name: 'After a number of occurrences' }).check();
    await form.getByRole('spinbutton', { name: 'Number of occurrences' }).fill(r.ends.after);
  } else if (r.ends && 'on' in r.ends) {
    await form.getByRole('radio', { name: 'On a date' }).check();
    await form.getByLabel('Last date').fill(r.ends.on);
  }
  await form.getByRole('button', { name: 'Set up recurrence' }).click();
}

test.describe('recurring projects', () => {
  // The viewer's own zone differs from the anchor zone, so local intent and "your time" both show.
  test.use({ timezoneId: 'America/New_York' });

  test('all four frequencies, end conditions, field errors, keyboard use, and DST-stable local time', async ({
    page,
  }, info) => {
    const { settings } = await recurringProject(page, info, 'prj-recur');
    await page.goto(settings);
    await expect(recurrence(page).getByText('This project does not repeat.')).toBeVisible();

    // Errors are field errors, never silently normalized: weekly without days (client), a zero
    // interval and an end date before the start (server).
    await setUp(page, { frequency: 'Weekly', start: '2026-11-02T09:00', tz: 'Europe/Lisbon' });
    await expect(recurrence(page).getByText('Choose at least one day.').first()).toBeVisible();
    await setUp(page, {
      frequency: 'Daily',
      interval: '0',
      start: '2026-11-02T09:00',
      tz: 'Europe/Lisbon',
    });
    await expect(
      recurrence(page).getByText('Use a whole number from 1 to 366.').first(),
    ).toBeVisible();
    await setUp(page, {
      frequency: 'Daily',
      interval: '1',
      start: '2026-11-02T09:00',
      tz: 'Europe/Lisbon',
      ends: { on: '2026-11-01' },
    });
    await expect(
      recurrence(page).getByText('The last date must be on or after the first one.').first(),
    ).toBeVisible();
    await expect(schedules(page)).toHaveCount(0);
    await expectAccessible(page, 'recurrence errors');

    // Daily every 2 days, never ending.
    await page.reload();
    await setUp(page, {
      frequency: 'Daily',
      interval: '2',
      start: '2026-11-02T09:00',
      tz: 'Europe/Lisbon',
    });
    await expect(schedules(page)).toContainText(
      'Every 2 days at 09:00 (Europe/Lisbon), from 2026-11-02',
    );
    // Monthly on day 31, three times (months without a 31st are skipped).
    await page.reload();
    await setUp(page, {
      frequency: 'Monthly',
      monthDay: '31',
      start: '2026-12-31T08:30',
      tz: 'America/New_York',
      ends: { after: '3' },
    });
    await expect(schedules(page)).toContainText(
      'Monthly on day 31 at 08:30 (America/New_York), from 2026-12-31, 3 times',
    );
    // Yearly until a date.
    await page.reload();
    await setUp(page, {
      frequency: 'Yearly',
      start: '2027-01-15T10:00',
      tz: 'Asia/Singapore',
      ends: { on: '2030-01-15' },
    });
    await expect(schedules(page)).toContainText(
      'Yearly at 10:00 (Asia/Singapore), from 2027-01-15, until 2030-01-15',
    );

    // Weekly by keyboard only: Friday 16:00 Lisbon across the 25 October DST change (0A example 5).
    await page.reload();
    const form = recurrence(page).getByRole('form', { name: 'Set up a recurring schedule' });
    await form.getByLabel('Repeats').focus();
    await form.getByLabel('Repeats').selectOption({ label: 'Weekly' });
    await form.getByRole('checkbox', { name: 'Friday' }).focus();
    await page.keyboard.press('Space');
    await expect(form.getByRole('checkbox', { name: 'Friday' })).toBeChecked();
    await form.getByLabel(/^First occurrence/).fill('2026-10-23T16:00');
    await form.getByLabel('Time zone').selectOption('Europe/Lisbon');
    await form.getByLabel(/^First occurrence/).focus();
    await page.keyboard.press('Enter');
    const weekly = schedules(page)
      .getByRole('listitem')
      .filter({ hasText: 'Weekly on Friday at 16:00' });
    // Local intent stays 16:00 Lisbon; New York sees 11:00 before and after (both zones shift).
    await expect(weekly).toContainText('Next: 2026-10-23 16:00 (Europe/Lisbon)');
    await expect(weekly).toContainText('11:00 AM');
    await weekly.getByRole('button', { name: /^Create next occurrence now/ }).click();
    await expect(weekly).toContainText('Next: 2026-10-30 16:00 (Europe/Lisbon)');
    // 30 Oct: Lisbon is UTC+0 (16:00 UTC) while New York is still UTC−4 until 1 Nov: 12:00 PM.
    await expect(weekly).toContainText('12:00 PM');
    await expect(weekly).toContainText('created through 2026-10-23 16:00');

    // Pause and resume are explicit; paused shows no next occurrence.
    await weekly.getByRole('button', { name: /^Pause/ }).click();
    await expect(weekly).toContainText('Paused');
    await expect(weekly).not.toContainText('Next:');
    await weekly.getByRole('button', { name: /^Resume/ }).click();
    await expect(weekly).toContainText('Next:');
    await expect(schedules(page).getByRole('listitem')).toHaveCount(4);
    await expectAccessible(page, 'recurrence schedules');
    expect(await noHorizontalOverflow(page), 'recurrence at this width').toBeLessThanOrEqual(0);
  });
});

test('permission loss: a manager who becomes read-only can no longer pause or generate @desktop-only', async ({
  page,
  browser,
}, info) => {
  const { ws, settings } = await recurringProject(page, info, 'prj-recur-perm');
  // Invite a member and let them accept.
  const email = uniqueEmail('prj-recur-member', info);
  await page.goto(`/workspaces/${ws}/people/invite`);
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel('Role').selectOption({ label: 'Member' });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(h1(page)).toHaveText('People');
  const other = await browser.newContext({ timezoneId: 'Europe/Lisbon' });
  const mp = await other.newPage();
  await openLink(mp, linkPath(await waitForMail(email, 'invited')));
  await register(mp, email, 'Mia Manager');
  await verify(mp, email);
  await signedIn(mp, email);
  await mp.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(h1(mp)).toHaveText('Recurring Co');

  // The owner gives the member manage access to the project (reviewed change).
  await page.goto(settings);
  await page.getByLabel('Give project access to').selectOption({ label: 'Mia Manager' });
  await page.getByLabel('Access level').selectOption({ label: 'Can manage' });
  await page.getByRole('button', { name: 'Review access…' }).click();
  const review = page.getByRole('dialog', { name: 'Give project access?' });
  await review.getByRole('button', { name: 'Give access' }).click();
  const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
  if (await stepUp.isVisible().catch(() => false)) {
    await stepUp.getByLabel(/^Password/).fill(PASSWORD);
    await stepUp.getByRole('button', { name: 'Confirm' }).click();
  }
  await expect(review).toBeHidden();
  // Occurrences are new projects in the brand, so the member also needs edit access to Harbor.
  await page.goto(`/workspaces/${ws}`);
  await page.getByRole('link', { name: 'Settings for Harbor' }).click();
  const access = page.getByRole('region', { name: 'Who has access' });
  await access.getByLabel('Give access to').selectOption({ label: 'Mia Manager' });
  await access.getByLabel('Access level').selectOption('edit');
  await access.getByRole('button', { name: 'Review access…' }).click();
  await page
    .getByRole('dialog', { name: 'Give brand access?' })
    .getByRole('button', { name: 'Give access' })
    .click();
  await expect(page.getByText('Access given.')).toBeAttached();

  // The member sets up a weekly schedule.
  await mp.goto(settings);
  await setUp(mp, {
    frequency: 'Weekly',
    days: ['Monday'],
    start: '2026-11-02T09:00',
    tz: 'Europe/Lisbon',
  });
  const item = schedules(mp).getByRole('listitem').first();
  await expect(item).toContainText('Weekly on Monday at 09:00 (Europe/Lisbon)');

  // The owner makes the member read-only; the member's next action is refused and explained.
  await page.goto(`/workspaces/${ws}/people`);
  await page.getByRole('link', { name: 'Access and actions for Mia Manager' }).click();
  await page.getByLabel('Change role to').selectOption({ label: 'Read-only' });
  await page.getByRole('button', { name: 'Review role change…' }).click();
  await page
    .getByRole('dialog', { name: /Change Mia Manager's role to Read-only/ })
    .getByRole('button', { name: 'Change role' })
    .click();
  await stepUp.getByLabel(/^Password/).fill(PASSWORD);
  await stepUp.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Mia Manager is now Read-only.')).toBeAttached();
  await item.getByRole('button', { name: /^Pause/ }).click();
  await expect(mp.getByText("You don't have permission to do this")).toBeVisible();
  await item.getByRole('button', { name: /^Create next occurrence now/ }).click();
  await expect(mp.getByText("You don't have permission to do this")).toBeVisible();
  // After reloading, the recurrence controls are absent (capabilities follow the new role).
  await mp.reload();
  await expect(mp.getByRole('heading', { name: 'Recurrence' })).toHaveCount(0);
  await other.close();
});
