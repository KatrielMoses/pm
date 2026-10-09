import { expect, test } from '@playwright/test';
import { expectAccessible } from './support.ts';
import { api, get, giveBrand, h1, person, progressOf, seed, thisQuarter } from './goals-support.ts';
import { removeBrandAccess } from './live-support.ts';

/**
 * Phase 5 exit journey (5A search × 5B goals and portfolios): a founder's work reaches a second
 * person only through what they may read, on search, the goal, and the portfolio at once; a word
 * that exists only in private work looks like a word nobody wrote; and removing access, trashing
 * work, and indexing delays are all shown on both surfaces truthfully.
 */

async function indexed(page: Parameters<typeof get>[0], base: string) {
  await expect
    .poll(async () => (await (await get(page, `${base}/search/status`)).json()).data.index, {
      timeout: 30_000,
      intervals: [250, 500, 1000],
    })
    .toMatchObject({ state: 'complete', pending: 0 });
}

test('search, goals, and portfolios agree on what each person may read, and change together @desktop-only', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(240_000);
  const s = await seed(page, info, 'phase5');
  const goal = await api(page, 'POST', `${s.base}/goals`, {
    title: 'Flagship programme',
    period: thisQuarter(),
    basis: 'linked_work',
  });
  await api(page, 'POST', `${s.base}/goals/${goal.id}/links`, { target: s.site.id });
  await api(page, 'POST', `${s.base}/goals/${goal.id}/links`, { target: s.secret.id });
  await indexed(page, s.base);

  // The founder finds work in both brands, and the goal counts all of it.
  await page.goto(`/workspaces/${s.ws}/search?q=homepage`);
  await expect(page.locator('.search-count')).toContainText('2 results');
  await page.goto(`/workspaces/${s.ws}/search?q=secret`);
  await expect(page.locator('.search-count')).toContainText('results for “secret”');

  const lee = await person(browser, page, s.ws, info, 'phase5-lee', 'Lee Lead', 'Member');
  await giveBrand(page, s.ws, 'Harbor', 'Lee Lead', 'edit');
  const p = lee.page;
  await p.goto(`/workspaces/${s.ws}/search?q=homepage`);
  await expect(p.locator('.search-count')).toContainText('2 results for “homepage”');
  // Private work is a word nobody wrote: the same message and the same absence as nonsense.
  await p.goto(`/workspaces/${s.ws}/search?q=secret`);
  await expect(p.locator('.search-count')).toContainText('No results for “secret”.');
  const hidden = await p.locator('.search-count').innerText();
  await p.goto(`/workspaces/${s.ws}/search?q=qwxzvbnm`);
  await expect(p.locator('.search-count')).toContainText('No results for “qwxzvbnm”.');
  expect(hidden.replace('secret', 'X')).toBe(
    (await p.locator('.search-count').innerText()).replace('qwxzvbnm', 'X'),
  );
  await expectAccessible(p, 'phase 5: search with hidden work');

  // The goal shows Lee a smaller figure and no private names; the API says the same.
  await p.goto(`/workspaces/${s.ws}/goals/${goal.id}`);
  await expect(h1(p)).toHaveText('Flagship programme');
  await expect(p.getByRole('main')).not.toContainText(/Secret|Vault/);
  const leeView = await (await get(p, `${s.base}/goals/${goal.id}`)).json();
  expect(JSON.stringify(leeView)).not.toMatch(/Secret|Vault/);
  expect(await progressOf(p, 'Progress of Flagship programme')).toBe(50);

  // Trashing finished work changes search and the goal together (the figure is computed per viewer).
  await api(page, 'POST', `${s.base}/tasks/${s.site.tasks.open}:trash`, {});
  await p.reload();
  await expect.poll(() => progressOf(p, 'Progress of Flagship programme')).toBe(100);
  await p.goto(`/workspaces/${s.ws}/search?q=publish`);
  await expect(p.locator('.search-count')).toContainText('No results for “publish”.');

  // Removing Harbor access removes the work everywhere on the next request.
  await removeBrandAccess(page, s.ws, 'Harbor', 'Lee Lead');
  await p.goto(`/workspaces/${s.ws}/search?q=homepage`);
  await expect(p.locator('.search-count')).toContainText('No results for “homepage”.');
  await p.goto(`/workspaces/${s.ws}/goals/${goal.id}`);
  await expect(p.getByRole('main')).not.toContainText('Launch site');
  await expectAccessible(p, 'phase 5: after access was removed');
  await lee.ctx.close();
});
