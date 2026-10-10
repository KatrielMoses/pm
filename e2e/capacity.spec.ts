import { expect, test, type Page } from '@playwright/test';
import {
  createBrand,
  createWorkspace,
  expectAccessible,
  linkPath,
  noHorizontalOverflow,
  openLink,
  owner,
  register,
  signedIn,
  uniqueEmail,
  verify,
  waitForMail,
} from './support.ts';

/**
 * Phase 3E on desktop, tablet, and mobile (ADR-0022): a founder sets working hours by keyboard,
 * sees the week's availability against scheduled and estimated work per brand, a cross-brand
 * overlap, time off, a brand holiday, and a reservation; Today shows available time; the workload
 * layout shows capacity. Every stage passes axe; the page reflows at 320 px and 200% zoom, with
 * forced colours and reduced motion. A brand lead sees only that brand's share of the founder's
 * capacity (no other brand's names) and loses it with their access.
 */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

async function api(page: Page, method: 'POST' | 'PATCH', path: string, data: unknown) {
  const origin = new URL(page.url()).origin;
  const me = await page.request.get('/v1/auth/me');
  const r = await page.request.fetch(path, {
    method,
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

const local = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** Tuesday of next week (always in the future, shown by "Next week"). */
const nextTuesday = () => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 8);
  return local(d);
};

async function founder(page: Page, info: Parameters<typeof owner>[1], prefix: string) {
  await owner(page, info, prefix, 'Fay Founder');
  const ws = await createWorkspace(page, 'Load Co');
  await createBrand(page, 'Harbor');
  const base = `/v1/workspaces/${ws}`;
  await api(page, 'POST', `${base}/brands`, { name: 'Summit' });
  const brands = (await (await page.request.get(`${base}/brands`)).json()).data as Array<{
    id: string;
    name: string;
  }>;
  const id = (n: string) => brands.find((b) => b.name === n)!.id;
  const day = nextTuesday();
  const opts = await (await page.request.get(`${base}/views/options/task/assignee`)).json();
  const me = opts.data.options.find((o: { label: string }) => o.label === 'Fay Founder')
    .value as string;
  const tasks: Record<string, string> = {};
  for (const [brand, title, est] of [
    ['Harbor', 'Harbor copy', 300],
    ['Summit', 'Summit deck', 240],
  ] as const) {
    const t = await api(page, 'POST', `${base}/tasks`, {
      brand: id(brand),
      title,
      due_date: day,
      estimate_minutes: est,
    });
    await api(page, 'POST', `${base}/tasks/${t.id}:assign`, {
      assignees: [me],
      primary: me,
      version: t.version,
    });
    tasks[brand] = t.id;
  }
  await api(page, 'POST', `${base}/work-blocks`, {
    task: tasks.Harbor,
    starts_at: `${day}T10:00:00Z`,
    ends_at: `${day}T12:00:00Z`,
    tz: 'UTC',
  });
  await api(page, 'POST', `${base}/work-blocks`, {
    task: tasks.Summit,
    starts_at: `${day}T11:00:00Z`,
    ends_at: `${day}T13:00:00Z`,
    tz: 'UTC',
  });
  return { ws, base, day, me, harbor: id('Harbor') };
}

test('working hours, week capacity, conflicts, time off, holidays, reservations, Today, and workload', async ({
  page,
}, info) => {
  const { ws, base, day } = await founder(page, info, 'cap');
  await page.goto(`/workspaces/${ws}/capacity`);
  await expect(h1(page)).toHaveText('Capacity');
  await expectAccessible(page, 'capacity, unconfigured');

  // Keyboard only: tick Monday–Friday and save.
  const hours = card(page, 'My working hours');
  for (const d of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
    await hours.getByRole('checkbox', { name: d }).focus();
    await page.keyboard.press('Space');
  }
  await hours.getByRole('button', { name: 'Save working hours' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Working hours saved.')).toBeAttached();
  await expect(hours.getByText(/40 h a week/)).toBeVisible();

  // Next week: Tuesday is over-allocated, and Harbor and Summit overlap for an hour.
  await page.getByRole('button', { name: 'Next week' }).click();
  const byDay = page.getByRole('region', { name: 'Capacity by day' });
  await expect(byDay.getByRole('row').nth(2)).toContainText('Over by 1 h');
  await expect(page.getByText(/Harbor and Summit overlap for 1 h/)).toBeVisible();
  const byBrand = page.getByRole('region', { name: 'Capacity by brand' });
  await expect(byBrand.getByRole('rowheader', { name: 'Harbor' })).toBeVisible();
  await expectAccessible(page, 'capacity week');

  // Time off on Wednesday of next week.
  const off = card(page, 'My time off');
  const wed = local(new Date(new Date(`${day}T12:00:00`).getTime() + 86_400_000));
  await off.getByLabel('First day').fill(wed);
  await off.getByLabel('Last day').fill(wed);
  await off.getByLabel('Note (optional)').fill('Dentist');
  await off.getByRole('button', { name: 'Add time off' }).click();
  await expect(page.getByText('Time off added.')).toBeAttached();
  await expect(byDay.getByRole('row').nth(3)).toContainText('0 min (time off)');

  // Reservation and holiday in Harbor.
  const brand = card(page, 'Brand reservations and holidays');
  await brand.getByLabel('Brand').selectOption({ label: 'Harbor' });
  await brand.getByLabel('Person').selectOption({ label: 'Fay Founder' });
  await brand.getByLabel('Hours a week').fill('10');
  await brand.getByRole('button', { name: 'Reserve time' }).click();
  await expect(page.getByText('Reservation saved.')).toBeAttached();
  await expect(brand.getByText(/Fay Founder: 10 h a week/)).toBeVisible();
  await brand.getByLabel('Holiday name').fill('Harbor day');
  await brand.getByRole('button', { name: 'Add holiday' }).click();
  await expect(page.getByText('Holiday added.')).toBeAttached();
  await expectAccessible(page, 'capacity with time off and reservations');

  // Today: available time from working hours (or the honest prompt on a weekend).
  await page.goto(`/workspaces/${ws}/today`);
  await expect(page.getByText(/working time|working hours/).first()).toBeVisible();
  // Workload: capacity under each bucket where it can be seen.
  const grid = await api(page, 'POST', `${base}/tasks:workload`, {
    query: { entity: 'task' },
    today: day,
    from: day,
    to: day,
    bucket: 'day',
  });
  expect(grid.people[0].capacity[day]).toMatchObject({ over: 60 });
  await page.goto(`/workspaces/${ws}/my-work`);
  await page.getByLabel('Layout', { exact: true }).selectOption({ label: 'Workload' });
  await expect(page.getByRole('region', { name: 'Workload grid' })).toContainText(/of /);

  // Appearance and reflow.
  await page.goto(`/workspaces/${ws}/capacity`);
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.reload();
  await expect(h1(page)).toHaveText('Capacity');
  await expectAccessible(page, 'capacity, forced colours');
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });
  const size = page.viewportSize()!;
  for (const width of [320, 599, 1024, Math.max(320, Math.floor(size.width / 2))]) {
    await page.setViewportSize({ width, height: size.height });
    await page.goto(`/workspaces/${ws}/capacity`);
    await expect(card(page, 'My working hours')).toBeVisible();
    await expect(page.getByText(/^Loading/)).toHaveCount(0);
    expect(await noHorizontalOverflow(page), `capacity at ${width}px`).toBeLessThanOrEqual(0);
  }
});

test('a brand lead sees only their brand’s share of the founder’s capacity, and loses it with access @desktop-only', async ({
  page,
  browser,
}, info) => {
  const { ws, me, harbor, base } = await founder(page, info, 'cap-lead');
  await api(page, 'POST', `${base}/capacity-reservations`, {
    brand: harbor,
    member: me,
    minutes_per_week: 600,
    effective_from: local(new Date()),
  });
  const email = uniqueEmail('cap-lead', info);
  await page.goto(`/workspaces/${ws}/people/invite`);
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel('Role').selectOption({ label: 'Member' });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(h1(page)).toHaveText('People');
  const other = await browser.newContext();
  const lead = await other.newPage();
  await openLink(lead, linkPath(await waitForMail(email, 'invited')));
  await register(lead, email, 'Lee Lead');
  await verify(lead, email);
  await signedIn(lead, email);
  await lead.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(h1(lead)).toHaveText('Load Co');
  await page.goto(`/workspaces/${ws}`);
  await page.getByRole('link', { name: 'Settings for Harbor' }).click();
  const access = page.getByRole('region', { name: 'Who has access' });
  await access.getByLabel('Give access to').selectOption({ label: 'Lee Lead' });
  await access.getByLabel('Access level').selectOption('manage');
  await access.getByRole('button', { name: 'Review access…' }).click();
  await page
    .getByRole('dialog', { name: 'Give brand access?' })
    .getByRole('button', { name: 'Give access' })
    .click();
  await expect(page.getByText('Access given.')).toBeAttached();

  await lead.goto(`/workspaces/${ws}/capacity`);
  const team = card(lead, 'Team allocation');
  await expect(team.getByRole('rowheader', { name: 'Fay Founder' })).toBeVisible();
  await expect(lead.getByRole('main')).not.toContainText('Summit');
  await expectAccessible(lead, 'lead capacity');

  // The owner removes Harbor access; the lead's next load has no team section at all.
  await access.getByRole('button', { name: 'Remove access for Lee Lead' }).click();
  await page
    .getByRole('alertdialog', { name: 'Remove brand access?' })
    .getByRole('button', { name: 'Remove access' })
    .click();
  await expect(page.getByText('Access removed.')).toBeAttached();
  await lead.reload();
  await expect(h1(lead)).toHaveText('Capacity');
  await expect(card(lead, 'My working hours')).toBeVisible();
  await expect(lead.getByRole('heading', { name: 'Team allocation' })).toHaveCount(0);
  await expect(lead.getByRole('main')).not.toContainText('Fay Founder');
  await expectAccessible(lead, 'lead capacity after revocation');
  await other.close();
});
