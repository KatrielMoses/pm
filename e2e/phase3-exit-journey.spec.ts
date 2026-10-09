import { expect, test, type Page } from '@playwright/test';
import {
  createBrand,
  createWorkspace,
  expectAccessible,
  noHorizontalOverflow,
  owner,
} from './support.ts';

/**
 * Phase 3 exit journey (integration review): one founder plans a week across two brands on
 * desktop, tablet, and mobile, and every 3A–3E surface tells the same story. A filtered, grouped
 * view is saved and reopened (3A) and rendered as list, board (a keyboard Move to…), calendar,
 * timeline, Gantt, workload with capacity, timesheet, and activity (3B). Working hours are set by
 * keyboard (3E); Today commits, orders by keyboard, schedules blocks, and shows available time and
 * the over-capacity warning (3C); time is timed and logged and shows in the timesheet and in planned
 * versus actual (3D); time off, a brand reservation, and a cross-brand overlap show on Capacity
 * (3E). Today, workload, and Capacity agree on the day's numbers. Axe passes at each major state
 * (and with forced colours and reduced motion), and the planning pages reflow at 320 px, the
 * width-class edges, and 200% zoom.
 */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const results = (page: Page) => page.getByRole('region', { name: /results$/ });
const count = (page: Page) => page.getByRole('status').filter({ hasText: /tasks?$/ });
const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const timePanel = (page: Page) => page.getByRole('region', { name: 'Time', exact: true });

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
/** Tuesday of next week: always in the future and inside "Next week" and the 14-day workload. */
const nextTuesday = () => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 8);
  return local(d);
};

async function pickLayout(page: Page, label: string) {
  await page.getByLabel('Layout', { exact: true }).selectOption({ label });
  await expect(results(page)).toBeVisible();
}

test('Phase 3 exit: one founder plans a week across brands, and every planning surface agrees', async ({
  page,
}, info) => {
  const mobile = info.project.name === 'mobile';
  // Sign in; a workspace with two brands.
  await owner(page, info, 'p3-exit', 'Fran Founder');
  const ws = await createWorkspace(page, 'Plan Co');
  await createBrand(page, 'Harbor');
  const base = `/v1/workspaces/${ws}`;
  await api(page, 'POST', `${base}/brands`, { name: 'Summit' });
  const brands = (await (await page.request.get(`${base}/brands`)).json()).data as Array<{
    id: string;
    name: string;
  }>;
  const brand = (n: string) => brands.find((b) => b.name === n)!.id;

  // A project and tasks with estimates, dates, and the founder as assignee (incidental setup).
  const day = nextTuesday();
  const prj = await api(page, 'POST', `${base}/projects`, {
    brand: brand('Harbor'),
    name: 'Launch',
  });
  const opts = await (await page.request.get(`${base}/views/options/task/assignee`)).json();
  const me = opts.data.options.find((o: { label: string }) => o.label === 'Fran Founder')
    .value as string;
  const ids: Record<string, string> = {};
  for (const [title, where, extra] of [
    [
      'Harbor copy',
      { project: prj.id },
      { estimate_minutes: 300, priority: 'high', deadline: { date: day } },
    ],
    [
      'Summit deck',
      { brand: brand('Summit') },
      { estimate_minutes: 240, priority: 'high', deadline: { date: day } },
    ],
    ['Book venue', { project: prj.id }, { priority: 'low' }],
  ] as const) {
    const t = await api(page, 'POST', `${base}/tasks`, {
      ...where,
      title,
      start_date: day,
      due_date: day,
      ...extra,
    });
    await api(page, 'POST', `${base}/tasks/${t.id}:assign`, {
      assignees: [me],
      primary: me,
      version: t.version,
    });
    ids[title] = t.id;
  }

  // 3E, keyboard only: working hours Monday–Friday (the default 09:00–17:00).
  await page.goto(`/workspaces/${ws}/capacity`);
  await expect(h1(page)).toHaveText('Capacity');
  const hours = card(page, 'My working hours');
  for (const d of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
    await hours.getByRole('checkbox', { name: d }).focus();
    await page.keyboard.press('Space');
  }
  await hours.getByRole('button', { name: 'Save working hours' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Working hours saved.')).toBeAttached();
  await expect(hours.getByText(/40 h a week/)).toBeVisible();
  await expectAccessible(page, 'capacity with working hours');

  // The founder works across both brands: the shell's brand scope becomes All brands.
  await page.getByRole('button', { name: /^Brand scope:/ }).click();
  await page
    .getByRole('listbox', { name: 'Brand scope' })
    .getByRole('option', { name: 'All brands' })
    .click();
  await expect(page.getByRole('listbox', { name: 'Brand scope' })).toHaveCount(0);

  // 3A: a filtered (High priority), grouped (by brand) view, saved and reopened from the list.
  await page.goto(`/workspaces/${ws}/views/new?entity=task`);
  await expect(h1(page)).toHaveText('New task view');
  await expect(count(page)).toHaveText('3 tasks');
  await page.getByRole('button', { name: 'Filters' }).click();
  const filters = page.getByRole('region', { name: 'Filters' });
  await filters.getByRole('button', { name: 'Add condition' }).click();
  const cond = filters.getByRole('group', { name: 'Condition 1' });
  await cond.getByLabel('Field').selectOption({ label: 'Priority' });
  await cond.getByRole('checkbox', { name: 'High' }).check();
  await expect(count(page)).toHaveText('2 tasks');
  await page.getByRole('button', { name: /^Group/ }).click();
  await page.getByLabel('Group by').selectOption({ label: 'Brand' });
  await expect(results(page)).toContainText('Summit');
  await page.getByRole('button', { name: 'Save view…' }).click();
  const save = page.getByRole('dialog', { name: 'Save view' });
  await save.getByLabel('Name').fill('Founder week');
  await save.getByRole('button', { name: 'Save view' }).click();
  await expect(h1(page)).toHaveText('Founder week');
  const viewUrl = page.url();
  await page.goto(`/workspaces/${ws}/views`);
  await page.getByRole('link', { name: 'Founder week' }).click();
  await expect(h1(page)).toHaveText('Founder week');
  await expect(count(page)).toHaveText('2 tasks');
  await expect(results(page).getByText('Book venue')).toHaveCount(0);
  await expectAccessible(page, 'saved view reopened');

  // 3B: the same saved query in every core layout.
  await pickLayout(page, 'Board');
  const board = results(page);
  await board.getByRole('button', { name: 'Move Summit deck' }).focus();
  await page.keyboard.press('Enter');
  const move = page.getByRole('dialog', { name: /Move “Summit deck”/ });
  // A late re-render can take focus back before Enter lands, and then nothing moves. While the
  // dialog is still open, re-take focus and press again; once it closes the move is under way.
  const inProgress = move.getByRole('button', { name: 'In progress' });
  await expect(async () => {
    if (await move.isVisible()) {
      await inProgress.focus();
      await expect(inProgress).toBeFocused({ timeout: 500 });
      await page.keyboard.press('Enter');
    }
    await expect(page.getByText('Summit deck moved to In progress.')).toBeAttached({
      timeout: 4_000,
    });
  }).toPass({ timeout: 30_000, intervals: [250, 1_000] });
  if (mobile) await board.getByLabel('Column').selectOption({ label: 'In progress (1)' });
  await expect(board.getByRole('heading', { name: /In progress \(1\)/ })).toBeVisible();
  // Audit from the top: axe's target-size check counts controls scrolled under the sticky header
  // as obscured (they are full size when on screen), as in today.spec.ts.
  await page.evaluate('window.scrollTo(0, 0)');
  await expectAccessible(page, 'board after a keyboard move');
  await pickLayout(page, 'Calendar');
  await expectAccessible(page, 'calendar layout');
  await pickLayout(page, 'Timeline');
  await expect(
    results(page).getByRole('button', { name: /Harbor copy: .* Change dates/ }),
  ).toBeVisible();
  await pickLayout(page, 'Gantt');
  await expect(
    results(page).getByRole('button', { name: /Summit deck: .* Change dates/ }),
  ).toBeVisible();
  await expectAccessible(page, 'gantt layout');
  // Workload by day: next Tuesday has 9 h of estimates against 8 h of working time.
  await pickLayout(page, 'Workload');
  await page.getByRole('button', { name: 'Layout options' }).click();
  await page.getByLabel('Time buckets').selectOption({ label: 'Day' });
  const grid = page.getByRole('region', { name: 'Workload grid' });
  await expect(grid.getByRole('rowheader', { name: 'Fran Founder' })).toBeVisible();
  await expect(grid.locator('td.workload-over')).toHaveCount(1);
  await expect(grid.locator('td.workload-over')).toContainText('9 h · 2 tasks of 8 h · 1 h over');
  await expectAccessible(page, 'workload with capacity');
  await pickLayout(page, 'Timesheet');
  await pickLayout(page, 'Activity');
  await expect(results(page).getByRole('list').first()).toBeVisible();
  await expectAccessible(page, 'activity layout');

  // 3C + 3E: Today on next Tuesday.
  await page.goto(`/workspaces/${ws}/today`);
  await expect(h1(page)).toHaveText('Today');
  // Step forward one day at a time (from the server's today in the person's zone) by keyboard.
  const now = (await (await page.request.get(`${base}/today/today`)).json()).data.today as string;
  const titles = await page.evaluate(
    ([from, to]) => {
      const out: string[] = [];
      for (
        let t = Date.parse(`${from}T12:00:00Z`) + 86_400_000;
        t <= Date.parse(`${to}T12:00:00Z`);
        t += 86_400_000
      )
        out.push(
          new Date(t).toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            timeZone: 'UTC',
          }),
        );
      return out;
    },
    [now, day] as const,
  );
  expect(titles.length).toBeGreaterThan(0);
  for (const t of titles) {
    await page.getByRole('button', { name: 'Next day', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(h1(page)).toHaveText(t);
  }
  // Today's lists are about the real today (OD-18); the deadline list reaches next week, and its
  // Add buttons commit to the day being planned.
  const due = page.getByRole('region', { name: 'Upcoming deadlines', exact: true });
  for (const t of ['Harbor copy', 'Summit deck']) {
    await due.getByRole('button', { name: `Add ${t} to this day` }).click();
    await expect(page.getByText(`${t} added to ${day}.`)).toBeAttached();
  }
  const committed = page.getByRole('list', { name: 'Committed tasks in order' });
  await expect(committed.getByRole('listitem')).toHaveCount(2);
  // Keyboard only: Summit deck to the top.
  await committed.getByRole('button', { name: 'Move up Summit deck' }).focus();
  await page.keyboard.press('Enter');
  await expect(committed.getByRole('listitem').first()).toContainText('Summit deck');
  // Two blocks in different brands that overlap for an hour (overlap is allowed, and reported).
  const form = page.getByRole('form', { name: 'Schedule a block' });
  for (const [t, start] of [
    ['Harbor copy', '10:00'],
    ['Summit deck', '11:00'],
  ] as const) {
    await form.getByLabel('For').selectOption({ label: t });
    await form.getByLabel('Start').fill(start);
    await form.getByLabel('Minutes').fill('120');
    await form.getByRole('button', { name: 'Schedule' }).click();
    await expect(page.getByText(new RegExp(`^Scheduled ${start}`))).toBeAttached();
  }
  const plan = card(page, 'Plan');
  await expect(plan.getByText('8:00 of 8:00 working time')).toBeVisible();
  const warning = page
    .getByRole('region', { name: 'More planned than available' })
    .or(page.getByText(/9:00 planned against 8:00 available — 1:00 over/));
  await expect(warning.first()).toBeVisible();
  await page.evaluate('window.scrollTo(0, 0)');
  await expectAccessible(page, 'today over capacity');

  // 3E: next week on Capacity: Tuesday over by 1 h, the Harbor/Summit overlap, time off, and a
  // Harbor reservation for the founder (chosen by name).
  await page.goto(`/workspaces/${ws}/capacity`);
  await page.getByRole('button', { name: 'Next week' }).click();
  const byDay = page.getByRole('region', { name: 'Capacity by day' });
  await expect(byDay.getByRole('row').nth(2)).toContainText('Over by 1 h');
  await expect(byDay.getByRole('row').nth(2)).toContainText('8 h');
  await expect(page.getByText(/Harbor and Summit overlap for 1 h/)).toBeVisible();
  const off = card(page, 'My time off');
  const wed = local(new Date(new Date(`${day}T12:00:00`).getTime() + 86_400_000));
  await off.getByLabel('First day').fill(wed);
  await off.getByLabel('Last day').fill(wed);
  await off.getByLabel('Note (optional)').fill('Dentist');
  await off.getByRole('button', { name: 'Add time off' }).click();
  await expect(page.getByText('Time off added.')).toBeAttached();
  await expect(byDay.getByRole('row').nth(3)).toContainText('0 min (time off)');
  const brandCard = card(page, 'Brand reservations and holidays');
  await brandCard.getByLabel('Brand').selectOption({ label: 'Harbor' });
  await brandCard.getByLabel('Person').selectOption({ label: 'Fran Founder' });
  await brandCard.getByLabel('Hours a week').fill('10');
  await brandCard.getByRole('button', { name: 'Reserve time' }).click();
  await expect(page.getByText('Reservation saved.')).toBeAttached();
  await expect(brandCard.getByText(/Fran Founder: 10 h a week/)).toBeVisible();
  await expect(page.getByText(/Harbor and Summit overlap for 1 h/)).toBeVisible();
  await expectAccessible(page, 'capacity with time off, reservation, and overlap');

  // The day's numbers agree across Today, workload, and Capacity (from the same reads).
  const today = await (await page.request.get(`${base}/today/${day}`)).json();
  const cap = await (await page.request.get(`${base}/capacity?from=${day}&to=${day}`)).json();
  const work = await api(page, 'POST', `${base}/tasks:workload`, {
    query: { entity: 'task' },
    today: day,
    from: day,
    to: day,
    bucket: 'day',
  });
  expect(today.data.capacity).toMatchObject({
    available_minutes: 480,
    planned_minutes: 540,
    over_minutes: 60,
  });
  expect(cap.data.days[0]).toMatchObject({ available_minutes: 480, over: 60 });
  expect(work.people[0].capacity[day]).toMatchObject({ available: 480, over: 60 });

  // 3D: time a task, log time, and see it in the timesheet and in planned versus actual.
  await page.goto(`/workspaces/${ws}/tasks/${ids['Harbor copy']}`);
  await expect(h1(page)).toHaveText('Harbor copy');
  await timePanel(page).getByRole('button', { name: 'Start timer' }).click();
  await timePanel(page).getByRole('button', { name: 'Stop timer' }).click();
  await expect(page.getByText(/^Timer stopped\./)).toBeAttached();
  await timePanel(page).locator('summary', { hasText: 'Log time' }).click();
  await timePanel(page)
    .getByLabel(/Time spent/)
    .fill('1:30');
  await timePanel(page).getByRole('button', { name: 'Log time' }).click();
  await expect(page.getByText(/Logged 1 hour 30 minutes/)).toBeAttached();
  await page.goto(`/workspaces/${ws}/time`);
  await expect(h1(page)).toHaveText('Time');
  await expect(page.getByRole('region', { name: 'Entries' })).toContainText('Harbor copy');
  await expectAccessible(page, 'time page with entries');
  await page.goto(viewUrl);
  await expect(h1(page)).toHaveText('Founder week');
  await pickLayout(page, 'Timesheet');
  await expect(results(page)).toContainText('Harbor copy');
  await expect(results(page)).toContainText(/1 h 3\d min|1:3\d/);
  await page.goto(`/workspaces/${ws}/time/report`);
  await expect(h1(page)).toHaveText('Planned versus actual');
  await page.getByLabel('Group by').selectOption('task');
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  const report = page.getByRole('table', { name: 'Planned versus actual by task' });
  await expect(report.getByRole('row', { name: /Harbor copy/ })).toContainText('5:00');
  await expectAccessible(page, 'planned versus actual');

  // Forced colours and reduced motion on Today and Capacity.
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  for (const path of ['today', 'capacity']) {
    await page.goto(`/workspaces/${ws}/${path}`);
    await expect(page.getByText(/^Loading/)).toHaveCount(0);
    await expectAccessible(page, `${path}, forced colours`);
  }
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });

  // Reflow at 320 px, the width-class edges, and 200% zoom (half the CSS width).
  const size = page.viewportSize()!;
  const view = new URL(viewUrl).pathname.replace(`/workspaces/${ws}/`, '');
  for (const width of [320, 599, 600, 1023, 1024, Math.max(320, Math.floor(size.width / 2))]) {
    await page.setViewportSize({ width, height: size.height });
    for (const path of ['today', 'capacity', 'time', view]) {
      await page.goto(`/workspaces/${ws}/${path}`);
      await expect(h1(page)).not.toHaveText('');
      await expect(page.getByText(/^Loading/)).toHaveCount(0);
      expect(await noHorizontalOverflow(page), `${path} at ${width}px`).toBeLessThanOrEqual(0);
    }
  }
});
