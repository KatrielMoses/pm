import { expect, test, type Page } from '@playwright/test';
import { accessible, api, giveBrand, h1, person, seed } from './goals-support.ts';

/**
 * Phase 5 final integration journey (5A search, 5B goals, 5C metrics, 5D dashboards): a founder and
 * a member with narrower access read the same workspace through the dashboard, the metrics page,
 * search, and the goal, and every surface agrees on what each person may read, changes together
 * when access changes, and says nothing about the rest. Each page is accessible at every state.
 */

const widgetRegion = (page: Page, title: string) =>
  page.getByRole('region', { name: title, exact: true }).first();
const openFact = (page: Page) =>
  page
    .locator('.metric-facts div')
    .filter({ has: page.locator('dt', { hasText: /^Open$/ }) })
    .locator('dd');
const value = (page: Page, title: string) =>
  widgetRegion(page, title).locator('.ins-value').first();

async function figures(page: Page, ws: string, dash: string, label: string) {
  await page.goto(`/workspaces/${ws}/dashboards/${dash}`);
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
  await accessible(page, `dashboard ${label}`);
}

test('search, goals, metrics, and dashboards agree on what each person may read, and change together @desktop-only', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(300_000);
  const s = await seed(page, info, 'p5final');
  const goal = await api(page, 'POST', `${s.base}/goals`, {
    title: 'Ship the site',
    period: { kind: 'quarter', year: 2026, index: 4 },
    basis: 'linked_work',
    brand: s.harbor,
  });
  await api(page, 'POST', `${s.base}/goals/${goal.id}/links`, { target: s.site.id });
  const dash = await api(page, 'POST', `${s.base}/dashboards`, {
    title: 'Everything',
    kind: 'owner',
    layout: {
      widgets: [
        { id: 'open', metric: 'tasks.open', params: {} },
        { id: 'age', metric: 'work.aging', params: {} },
      ],
    },
  });
  const lee = await person(browser, page, s.ws, info, 'p5final-lee', 'Lee Lead', 'Member');
  const p = lee.page;

  // The founder reads three open tasks everywhere; the metrics page says the same.
  await figures(page, s.ws, dash.id, 'founder');
  await expect(value(page, 'Open tasks')).toHaveAttribute('aria-label', 'Open tasks: 3');
  await expect(value(page, 'Task aging')).toHaveAttribute('aria-label', 'Task aging: 3');
  await page.goto(`/workspaces/${s.ws}/metrics?metric=work.age`);
  await expect(openFact(page)).toHaveText('3');
  // The records behind the aging widget are the three tasks, by name, to the founder only.
  await page.goto(`/workspaces/${s.ws}/dashboards/${dash.id}`);
  await widgetRegion(page, 'Task aging').getByRole('button', { name: 'Show records' }).click();
  const records = page.getByRole('dialog', { name: /Records behind/ });
  await expect(records).toContainText('Secret task one');
  await expect(records.getByRole('link', { name: 'Publish the homepage' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Without access the member reads nothing on any surface, and the same words as an empty workspace.
  await p.goto(`/workspaces/${s.ws}/metrics?metric=work.age`);
  await expect(p.getByText('Nothing to measure yet')).toBeVisible();
  await expect(p.getByText('Secret')).toHaveCount(0);
  await accessible(p, 'metrics, no access');
  await p.goto(`/workspaces/${s.ws}/search?q=secret`);
  await expect(p.locator('.search-count')).toContainText('No results for “secret”.');
  const hidden = await p.request.get(`${s.base}/goals/${goal.id}`);
  expect(hidden.status()).toBe(404);
  const unknown = await p.request.get(`${s.base}/goals/goal_00000000000000000000000000`);
  expect(unknown.status()).toBe(404);

  // Access is given to Harbor only: smaller figures, no vault names, on every surface at once.
  await giveBrand(page, s.ws, 'Harbor', 'Lee Lead', 'edit');
  await p.goto(`/workspaces/${s.ws}/metrics?metric=work.age`);
  await expect(openFact(p)).toHaveText('1');
  await expect(p.getByText('Secret')).toHaveCount(0);
  await accessible(p, 'metrics, Harbor only');
  const viaApi = await (await p.request.get(`${s.base}/metrics/work.age`)).json();
  expect(viaApi.data.value.open).toBe(1);
  expect(JSON.stringify(viaApi)).not.toMatch(/Secret/);
  await expect
    .poll(
      async () =>
        (await (await p.request.get(`${s.base}/search/status`)).json()).data.index.pending,
      {
        message: 'the search index catches up',
        timeout: 30_000,
        intervals: [250, 500, 1000],
      },
    )
    .toBe(0);
  await p.goto(`/workspaces/${s.ws}/search?q=homepage`);
  await expect(p.getByRole('list', { name: 'Search results' })).toContainText(
    'Publish the homepage',
  );

  // Revoking the brand takes it all away on the next request.
  await page.goto(`/workspaces/${s.ws}`);
  await page.getByRole('link', { name: 'Settings for Harbor' }).click();
  const access = page.getByRole('region', { name: 'Who has access' });
  await access.getByRole('button', { name: 'Remove access for Lee Lead' }).click();
  await page
    .getByRole('alertdialog', { name: 'Remove brand access?' })
    .getByRole('button', { name: 'Remove access' })
    .click();
  await expect(page.getByText('Access removed.')).toBeAttached();
  await p.goto(`/workspaces/${s.ws}/metrics?metric=work.age`);
  await expect(p.getByText('Nothing to measure yet')).toBeVisible();
  const after = await (await p.request.get(`${s.base}/metrics/work.age`)).json();
  expect(after.data.value.open).toBe(0);
  await expect(h1(p)).toHaveText('Metrics');
});
