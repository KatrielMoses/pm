import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, noHorizontalOverflow } from './support.ts';
import { api, expectNoOverflow, giveBrand, h1, person, setup, type Setup } from './live-support.ts';

/**
 * Phase 5C (ADR-0030): the metrics page in the browser. A founder reads a figure with the rule
 * behind it, the records it is made of, and an export; keyboard alone does everything; the page
 * reflows at 320 px and 200% zoom, with forced colours and reduced motion, and stays accessible in
 * every state. A second person sees only the work they may read, and the same page says nothing
 * about work they may not.
 */

async function seed(page: Page, s: Setup) {
  const project = await api(page, 'POST', `${s.base}/projects`, {
    brand: s.harbor,
    name: 'Gannet',
  });
  const make = (title: string, estimate: number) =>
    api(page, 'POST', `${s.base}/tasks`, {
      brand: s.harbor,
      project: project.id,
      title,
      estimate_minutes: estimate,
    });
  const a = await make('Draft brief', 60);
  await make('Review copy', 120);
  await make('Publish', 30);
  await api(page, 'POST', `${s.base}/tasks/${a.id}:complete`, {}, a.version);
  return { project: project.id as string, done: a.id as string };
}

const metric = (page: Page) => page.getByLabel('Metric', { exact: true });
const headline = (page: Page) => page.locator('.metric-headline');

test('reads a figure with its rule, the records behind it, and an export, with the state in the address @desktop-only', async ({
  page,
}, info) => {
  const s = await setup(page, info, 'metrics-founder');
  const { done } = await seed(page, s);
  await page.goto(`/workspaces/${s.ws}/metrics`);
  await expect(h1(page)).toHaveText('Metrics');
  await expect(
    page.getByRole('heading', { level: 2, name: /Completion \(by task count\)/ }),
  ).toBeVisible();
  await expect(headline(page)).toHaveText('33%');
  await expect(page.getByText('Complete', { exact: true })).toBeVisible();
  await expectAccessible(page, 'metrics, completion');

  // The rule: what is counted, rolled up, and not claimed.
  const how = page.getByText('How this is counted');
  await how.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Leaf tasks that are done/)).toBeVisible();
  await expect(page.getByText(/not value delivered|not value/)).toBeVisible();

  // The records behind the figure, by keyboard; each links to the task.
  await page.getByRole('button', { name: /Done tasks \(1\)/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/member=numerator/);
  await expect(page.getByRole('heading', { level: 3, name: 'Done tasks (1)' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Draft brief' })).toHaveAttribute(
    'href',
    `/workspaces/${s.ws}/tasks/${done}`,
  );
  await expectAccessible(page, 'metrics, records');

  // The weighted version is a different, labelled figure; unestimated work is named, not guessed.
  await page.locator('#metric-version').selectOption({ label: 'Completion (weighted by estimate)' });
  await expect(page).toHaveURL(/version=2/);
  await expect(headline(page)).toHaveText('29%');
  // A source that does not exist yet is unavailable, never zero.
  await metric(page).selectOption({ label: 'Test results (not available yet)' });
  await expect(page.getByText('Not available until phase 9B')).toBeVisible();
  await expect(page.getByText('Not available yet', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download as CSV' })).toHaveCount(0);
  await expectAccessible(page, 'metrics, unavailable');

  // A windowed metric reads its window in the workspace zone, and the export is the same figure.
  await page.goto(
    `/workspaces/${s.ws}/metrics?metric=work.cycle_time&from=2026-01-01&to=2026-01-31`,
  );
  await expect(page.getByText(/2026-01-01 to 2026-01-31 \(31 days, /)).toBeVisible();
  await expect(page.getByText('Nothing to measure yet')).toBeVisible();
  const csv = await page.request.get(
    `/v1/workspaces/${s.ws}/metrics/work.cycle_time/export?from=2026-01-01&to=2026-01-31`,
  );
  expect(csv.status()).toBe(200);
  expect(csv.headers()['content-type']).toContain('text/csv');
  expect(await csv.text()).toContain('metric,work.cycle_time');
});

test('reflows at 320 px and 200% zoom, with forced colours and reduced motion, and stays accessible @desktop-only', async ({
  page,
}, info) => {
  const s = await setup(page, info, 'metrics-reflow');
  await seed(page, s);
  await page.goto(`/workspaces/${s.ws}/metrics`);
  await expect(headline(page)).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.reload();
  await expect(headline(page)).toBeVisible();
  await expectAccessible(page, 'metrics, forced colours and reduced motion');
  expect(
    await page.evaluate<boolean>(`[...document.querySelectorAll('.metric-result, .metric-controls, .metric-drill')].every((e) => {
      const c = getComputedStyle(e);
      return c.animationName === 'none' && /^0s(, 0s)*$/.test(c.transitionDuration);
    })`),
  ).toBe(true);
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });
  const size = page.viewportSize()!;
  for (const width of [320, 599, 640, 1024, Math.max(320, Math.floor(size.width / 2))]) {
    await page.setViewportSize({ width, height: size.height });
    await page.goto(`/workspaces/${s.ws}/metrics`);
    await expect(headline(page)).toBeVisible();
    expect(await noHorizontalOverflow(page), `metrics at ${width}px`).toBeLessThanOrEqual(0);
    await expectNoOverflow(page, `metrics at ${width}px`);
  }
  await page.setViewportSize({ width: 320, height: size.height });
  await page.goto(`/workspaces/${s.ws}/metrics?metric=work.workload`);
  await expect(page.getByRole('heading', { level: 2, name: /Workload/ })).toBeVisible();
  await expectAccessible(page, 'metrics on Compact');
});

test('shows a person only the work they may read, and the same page says nothing of the rest @desktop-only', async ({
  page,
  browser,
}, info) => {
  const s = await setup(page, info, 'metrics-access');
  await seed(page, s);
  const lee = await person(browser, page, s.ws, info, 'metrics-lee', 'Lee Lead', 'Member');
  const p = lee.page;
  await p.goto(`/workspaces/${s.ws}/metrics`);
  await expect(p.getByText('Nothing to measure yet')).toBeVisible();
  await expect(p.getByText(/33%/)).toHaveCount(0);
  await expectAccessible(p, 'metrics, nothing visible');
  const raw = await (
    await p.request.get(`/v1/workspaces/${s.ws}/metrics/project.completion`)
  ).json();
  expect(raw.data).toMatchObject({ state: 'empty', parts: { numerator: 0, denominator: 0 } });
  // An unknown project and a hidden one are refused in the same words.
  const a = await p.request.get(
    `/v1/workspaces/${s.ws}/metrics/project.completion?project=prj_00000000000000000000000000`,
  );
  expect(a.status()).toBe(422);
  await giveBrand(page, s.ws, 'Harbor', 'Lee Lead', 'edit');
  await p.goto(`/workspaces/${s.ws}/metrics`);
  await expect(headline(p)).toHaveText('33%');
});
