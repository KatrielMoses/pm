import { expect, test, type Page } from '@playwright/test';
import {
  createBrand,
  createWorkspace,
  expectAccessible,
  noHorizontalOverflow,
  owner,
} from './support.ts';

/**
 * Phase 3B core views (ADR-0020) at desktop, tablet, and mobile: one view engine rendered as list,
 * board, table, calendar, timeline, Gantt, workload, timesheet, and activity for tasks, and
 * portfolio and milestones for projects; board moves through the workflow without dragging; the
 * detail panel keeps the view; My Work and Calendar destinations; axe at every layout, forced
 * colours, reduced motion, and reflow at 320 px and 200% zoom.
 */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const results = (page: Page) => page.getByRole('region', { name: /results$/ });
const count = (page: Page) => page.getByRole('status').filter({ hasText: /(tasks?|projects?)$/ });

async function api(
  page: Page,
  method: 'POST' | 'PATCH',
  path: string,
  data: unknown,
  ifMatch?: number,
) {
  const origin = new URL(page.url()).origin;
  const me = await page.request.get('/v1/auth/me');
  const r = await page.request.fetch(path, {
    method,
    headers: {
      origin,
      'x-csrf-token': me.headers()['x-csrf-token'] ?? '',
      'idempotency-key': `e2e-${crypto.randomUUID()}`,
      ...(ifMatch !== undefined ? { 'if-match': `"${ifMatch}"` } : {}),
    },
    data,
  });
  expect(r.status(), await r.text()).toBeLessThan(300);
  return (await r.json()).data;
}

const iso = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

async function pickLayout(page: Page, label: string) {
  await page.getByLabel('Layout', { exact: true }).selectOption({ label });
}

test('one engine, every core layout, board moves, detail panel, and My Work', async ({
  page,
}, info) => {
  await owner(page, info, 'core', 'Cora Views');
  const ws = await createWorkspace(page, 'Core Views Co');
  await createBrand(page, 'Harbor');
  const base = `/v1/workspaces/${ws}`;
  const brands = await (await page.request.get(`${base}/brands`)).json();
  const harbor = brands.data.find((b: { name: string }) => b.name === 'Harbor').id;
  const prj = await api(page, 'POST', `${base}/projects`, {
    brand: harbor,
    name: 'Launch',
    target_date: iso(30),
  });
  await api(page, 'POST', `${base}/projects/${prj.id}/milestones`, {
    name: 'Beta ready',
    due_date: iso(10),
  });
  const opts = await (await page.request.get(`${base}/views/options/task/assignee`)).json();
  const me = opts.data.options.find((o: { label: string }) => o.label === 'Cora Views')
    .value as string;
  const made: Record<string, { id: string; version: number }> = {};
  for (const [title, extra] of [
    [
      'Draft copy',
      { start_date: iso(1), due_date: iso(3), estimate_minutes: 120, priority: 'high' },
    ],
    [
      'Design banner',
      { start_date: iso(2), due_date: iso(5), estimate_minutes: 60, deadline: { date: iso(6) } },
    ],
    ['Book venue', { due_date: iso(4), priority: 'urgent' }],
  ] as const) {
    const t = await api(page, 'POST', `${base}/tasks`, { project: prj.id, title, ...extra });
    const a = await api(page, 'POST', `${base}/tasks/${t.id}:assign`, {
      assignees: [me],
      primary: me,
      version: t.version,
    });
    made[title] = { id: t.id, version: a.version ?? t.version + 1 };
  }
  await api(page, 'POST', `${base}/tasks/${made['Draft copy']!.id}/relationships`, {
    kind: 'blocks',
    target: made['Design banner']!.id,
  });
  await api(page, 'POST', `${base}/time-entries`, {
    target: made['Draft copy']!.id,
    work_date: iso(0),
    duration_minutes: 45,
  });

  // List (default), then every task layout over the same view.
  await page.goto(`/workspaces/${ws}/views/new?entity=task`);
  await expect(h1(page)).toHaveText('New task view');
  await expect(count(page)).toHaveText('3 tasks');
  await expect(
    results(page).getByRole('button', { name: 'Draft copy', exact: true }),
  ).toBeVisible();
  await expectAccessible(page, 'list layout');

  // Board by status: Move to… (no dragging) uses the workflow transition.
  await pickLayout(page, 'Board');
  const board = results(page);
  await expect(board.getByRole('heading', { name: /To do/ })).toBeVisible();
  await board.getByRole('button', { name: 'Move Book venue' }).click();
  const move = page.getByRole('dialog', { name: /Move “Book venue”/ });
  await expectAccessible(page, 'board move dialog');
  await move.getByRole('button', { name: 'In progress' }).click();
  await expect(page.getByText('Book venue moved to In progress.')).toBeAttached();
  // Compact shows one column at a time with a switcher (RS-51).
  if (info.project.name === 'mobile')
    await board.getByLabel('Column').selectOption({ label: 'In progress (1)' });
  await expect(board.getByRole('heading', { name: /In progress \(1\)/ })).toBeVisible();
  await expectAccessible(page, 'board layout');

  // Detail panel keeps the view (VIEW-023) on wider widths; Escape closes it.
  if (info.project.name !== 'mobile') {
    const before = page.url();
    await board.getByRole('button', { name: 'Draft copy', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Draft copy' });
    await expect(panel.getByRole('link', { name: 'Open full page' })).toBeVisible();
    await expect(page).toHaveURL(/item=tsk_/);
    await expectAccessible(page, 'detail panel');
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page).not.toHaveURL(/item=/);
    expect(new URL(page.url()).searchParams.get('q')).toBe(new URL(before).searchParams.get('q'));
  }

  // Table (frozen first column) and calendar (tasks and deadlines).
  await pickLayout(page, 'Table');
  await expect(results(page).getByRole('columnheader', { name: 'Title' })).toBeVisible();
  await pickLayout(page, 'Calendar');
  await page.getByLabel('Show', { exact: true }).selectOption('agenda');
  await expect(
    results(page).getByRole('button', { name: /Design banner, deadline/ }),
  ).toBeVisible();
  await expect(results(page).getByText('Beta ready')).toBeVisible();
  await expectAccessible(page, 'calendar agenda');

  // Timeline: change dates without dragging; the deadline never changes.
  await pickLayout(page, 'Timeline');
  await results(page)
    .getByRole('button', { name: /Draft copy: .* Change dates/ })
    .click();
  const shift = page.getByRole('dialog', { name: /Change dates of “Draft copy”/ });
  await shift.getByLabel(/Move by days/).fill('2');
  await shift.getByRole('button', { name: 'Move dates' }).click();
  await expect(
    page.getByText(/Draft copy moved 2 days later\. The deadline did not change\./),
  ).toBeAttached();
  await expectAccessible(page, 'timeline layout');
  await pickLayout(page, 'Gantt');
  await expect(results(page).getByText(/blocks Design banner/)).toBeVisible();
  // Dependency-aware rescheduling is explicit: the blocked task moves only when chosen.
  await results(page)
    .getByRole('button', { name: /Draft copy: .* Change dates/ })
    .click();
  const g = page.getByRole('dialog', { name: /Change dates of “Draft copy”/ });
  await g.getByLabel(/Move by days/).fill('1');
  await g
    .getByRole('checkbox', { name: /Also move the 1 task it blocks \(Design banner\)/ })
    .check();
  await g.getByRole('button', { name: 'Move dates' }).click();
  await expect(
    page.getByText(/1 blocked task moved with it\. The deadline did not change\./),
  ).toBeAttached();

  // Workload, timesheet, and activity read from the same query.
  await pickLayout(page, 'Workload');
  await expect(results(page).getByRole('rowheader', { name: 'Cora Views' })).toBeVisible();
  await expectAccessible(page, 'workload layout');
  await pickLayout(page, 'Timesheet');
  await expect(
    results(page)
      .getByRole('cell', { name: '45 min' })
      .or(results(page).getByText('0 h 45 min'))
      .first(),
  ).toBeVisible();
  await pickLayout(page, 'Activity');
  await expect(results(page).getByRole('list').first()).toBeVisible();
  await expectAccessible(page, 'activity layout');

  // Save the board layout as a view; the layout comes back with it.
  await pickLayout(page, 'Board');
  await page.getByRole('button', { name: 'Save view…' }).click();
  const save = page.getByRole('dialog', { name: 'Save view' });
  await save.getByLabel('Name').fill('Launch board');
  await save.getByRole('button', { name: 'Save view' }).click();
  await expect(h1(page)).toHaveText('Launch board');
  await page.reload();
  await expect(page.getByLabel('Layout', { exact: true })).toHaveValue('board');

  // Projects: portfolio with progress, and milestones.
  await page.goto(`/workspaces/${ws}/views/new?entity=project&layout=portfolio`);
  await expect(results(page).getByText(/Progress/)).toBeVisible();
  await expectAccessible(page, 'portfolio layout');
  await pickLayout(page, 'Milestones');
  await expect(results(page).getByText('Beta ready')).toBeVisible();

  // My Work and Calendar destinations.
  await page.goto(`/workspaces/${ws}/my-work`);
  await expect(h1(page)).toHaveText('My Work');
  await expect(count(page)).toHaveText('3 tasks');
  await page.getByRole('link', { name: 'Following' }).click();
  await expect(page.getByText(/You aren't following anything yet/)).toBeVisible();
  await page.goto(`/workspaces/${ws}/calendar`);
  await expect(h1(page)).toHaveText('Calendar');
  await expectAccessible(page, 'calendar destination');

  // Appearance and reflow on the board.
  await page.goto(`/workspaces/${ws}/my-work`);
  await pickLayout(page, 'Board');
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.reload();
  await expect(results(page)).toBeVisible();
  await expectAccessible(page, 'board, forced colours');
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });
  const size = page.viewportSize()!;
  for (const width of [320, 599, 600, 1023, 1024, Math.max(320, Math.floor(size.width / 2))]) {
    await page.setViewportSize({ width, height: size.height });
    for (const layout of ['Board', 'Calendar', 'Timeline']) {
      await page.goto(`/workspaces/${ws}/my-work`);
      await expect(h1(page)).toHaveText('My Work');
      await pickLayout(page, layout);
      await expect(results(page)).toBeVisible();
      expect(await noHorizontalOverflow(page), `${layout} at ${width}px`).toBeLessThanOrEqual(0);
    }
  }
});
