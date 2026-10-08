import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, noHorizontalOverflow } from './support.ts';
import {
  api,
  expectNoOverflow,
  giveBrand,
  h1,
  person,
  removeBrandAccess,
  seedPage,
  setup,
  tabTo,
  type Setup,
} from './live-support.ts';

/**
 * Phase 5A (ADR-0028): permission-aware search in the browser. A founder's work is found across
 * tasks, comments, and pages from the command palette and the search page, with matches marked and
 * the state kept in the address; keyboard alone does everything; the page reflows at 320 px and at
 * 200% zoom, with forced colours and reduced motion, and stays accessible in every state. A second
 * person finds exactly what they may read, loses it the moment access is removed, and cannot tell a
 * hidden record from one that does not exist. A dropped connection keeps the results and recovers.
 */

const rich = (text: string) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** Waits until the worker has indexed everything queued for this person (the page says so too). */
async function indexed(page: Page, base: string) {
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`${base}/search/status`)).json()).data.index as {
          state: string;
          pending: number;
        },
      { message: 'the search index catches up', timeout: 30_000, intervals: [250, 500, 1000] },
    )
    .toMatchObject({ state: 'complete', pending: 0 });
}

async function seed(page: Page, s: Setup, word: string) {
  const task = await api(page, 'POST', `${s.base}/tasks`, {
    brand: s.harbor,
    title: `Reconcile ${word} invoices`,
    description: rich(`Match every ${word} against the ledger before month end.`),
  });
  await api(page, 'POST', `${s.base}/records/${task.id}/comments`, {
    text: `Is the ${word} total final?`,
    mentions: [],
  });
  const doc = await seedPage(page, s, `${word} handbook`, [
    `How we pay a ${word} supplier within thirty days.`,
  ]);
  await indexed(page, s.base);
  return { task: task.id as string, doc };
}

const searchbox = (page: Page) => page.getByRole('searchbox', { name: /Search records/ });
const results = (page: Page) => page.getByRole('list', { name: 'Search results' });
const count = (page: Page) => page.locator('.search-count');

test('finds work from the palette and the search page, with the whole state in the address @desktop-only', async ({
  page,
}, info) => {
  const s = await setup(page, info, 'search-founder');
  const { task, doc } = await seed(page, s, 'gannet');
  await page.goto(`/workspaces/${s.ws}`);

  // Keyboard alone: open the palette, type, choose "Search everywhere", land on the results.
  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type('gannet');
  const everywhere = palette.getByRole('option', { name: /Search everywhere for “gannet”/ });
  await expect(everywhere).toBeVisible();
  // The palette also lists results directly (the page and the comment's task), by permission.
  await expect(palette.getByRole('option', { name: /gannet handbook/ })).toBeVisible();
  await everywhere.click();
  await expect(h1(page)).toHaveText('Search');
  await expect(page).toHaveURL(new RegExp(`/workspaces/${s.ws}/search\\?q=gannet$`));
  await expect(results(page)).toBeVisible();
  await expect(count(page)).toContainText('3 results for “gannet”');
  const items = results(page).getByRole('listitem');
  await expect(items).toHaveCount(3);
  // Matches are marked as text, in titles and excerpts.
  await expect(results(page).locator('mark').first()).toHaveText(/gannet/i);
  await expect(
    results(page).getByRole('link', { name: 'Reconcile gannet invoices' }),
  ).toHaveAttribute('href', `/workspaces/${s.ws}/tasks/${task}`);
  await expect(results(page).getByRole('link', { name: 'gannet handbook' })).toHaveAttribute(
    'href',
    `/workspaces/${s.ws}/documents/${doc}`,
  );
  await expect(
    items.filter({ hasText: 'Comment' }).getByText(/in Task “Reconcile gannet invoices”/),
  ).toBeVisible();
  await expectAccessible(page, 'search results');

  // Filters through the keyboard; the address follows, and a reload restores exactly this search.
  const filters = page.getByRole('complementary', { name: 'Filters' });
  await filters.getByRole('checkbox', { name: /^Comments \(\d/ }).focus();
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/kind=comment/);
  await expect(count(page)).toContainText('1 result for “gannet”');
  await page.reload();
  await expect(filters.getByRole('checkbox', { name: /^Comments \(\d/ })).toBeChecked();
  await expect(count(page)).toContainText('1 result for “gannet”');
  await filters.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).toHaveURL(new RegExp(`search\\?q=gannet$`));

  // A phrase and an exclusion, typed into the page's own form.
  await searchbox(page).fill('"match every" -zzz');
  await page.keyboard.press('Enter');
  await expect(count(page)).toContainText('1 result for “"match every" -zzz”');
  await searchbox(page).fill('nothing-matches-this');
  await page.keyboard.press('Enter');
  await expect(count(page)).toContainText('No results for “nothing-matches-this”.');
  await expectAccessible(page, 'search, no results');

  // Opening a result checks access again and lands on the record.
  await searchbox(page).fill('gannet');
  await page.keyboard.press('Enter');
  await results(page).getByRole('link', { name: 'Reconcile gannet invoices' }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${task}$`));
  await expect(h1(page)).toHaveText('Reconcile gannet invoices');

  // Submitted searches are remembered, only for this person, and can be forgotten.
  await page.goto(`/workspaces/${s.ws}/search`);
  const recent = page.getByRole('region', { name: 'Recent searches' });
  await expect(recent.getByRole('link', { name: 'gannet', exact: true })).toBeVisible();
  await expect(recent.getByRole('link', { name: 'nothing-matches-this' })).toBeVisible();
  await expectAccessible(page, 'search, recent searches');
  await recent.getByRole('button', { name: 'Forget the search nothing-matches-this' }).click();
  await expect(recent.getByRole('link', { name: 'nothing-matches-this' })).toHaveCount(0);
  await recent.getByRole('button', { name: 'Clear recent searches' }).click();
  await expect(recent.getByText(/Nothing is remembered while you type/)).toBeVisible();

  // The search page opens with the single `/` key (IA-10) and never while typing.
  await page.goto(`/workspaces/${s.ws}/today`);
  await expect(h1(page)).toHaveText('Today');
  await expect(page.getByRole('navigation', { name: 'Primary' }).first()).toBeVisible();
  await page.locator('body').press('/');
  await expect(h1(page)).toHaveText('Search');
});

test('reflows at 320 px and 200% zoom, with forced colours and reduced motion, and stays accessible @desktop-only', async ({
  page,
}, info) => {
  const s = await setup(page, info, 'search-reflow');
  await seed(page, s, 'osprey');
  await page.goto(`/workspaces/${s.ws}/search?q=osprey`);
  await expect(results(page)).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.reload();
  await expect(results(page)).toBeVisible();
  // Matched text keeps the system mark colours in forced colours (never colour alone: also bold).
  const markStyle = (prop: string) =>
    page.evaluate<string>(
      `getComputedStyle(document.querySelector('.search-results mark')).${prop}`,
    );
  expect(await markStyle('forcedColorAdjust')).toBe('none');
  expect(await markStyle('fontWeight')).toBe('700');
  // Reduced motion: nothing on the page animates or transitions.
  expect(
    await page.evaluate<boolean>(`[...document.querySelectorAll('.search-result, .search-form, .search-filters')].every((e) => {
      const c = getComputedStyle(e);
      return c.animationName === 'none' && /^0s(, 0s)*$/.test(c.transitionDuration);
    })`),
  ).toBe(true);
  await expectAccessible(page, 'search, forced colours and reduced motion');
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });

  const size = page.viewportSize()!;
  // 200% zoom of a 1280 px window is 640 CSS px; 320 px is the narrowest supported width.
  for (const width of [320, 599, 640, 1024, Math.max(320, Math.floor(size.width / 2))]) {
    await page.setViewportSize({ width, height: size.height });
    await page.goto(`/workspaces/${s.ws}/search?q=osprey`);
    await expect(results(page)).toBeVisible();
    await expect(page.getByText(/^Searching/)).toHaveCount(0);
    expect(await noHorizontalOverflow(page), `search at ${width}px`).toBeLessThanOrEqual(0);
    await expectNoOverflow(page, `search at ${width}px`);
  }
  // On Compact the filters collapse into a disclosure that keeps its count and works by keyboard.
  await page.setViewportSize({ width: 320, height: size.height });
  await page.goto(`/workspaces/${s.ws}/search?q=osprey&mine=true`);
  const summary = page.getByText('Filters (1)');
  await expect(summary).toBeVisible();
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Updated')).toBeVisible();
  await expectAccessible(page, 'search on Compact with filters open');
});

test('follows access: results are the person’s own, vanish when access is removed, and hidden looks like unknown @desktop-only', async ({
  page,
  browser,
}, info) => {
  const s = await setup(page, info, 'search-access');
  const { task } = await seed(page, s, 'kestrel');
  const lee = await person(browser, page, s.ws, info, 'search-lee', 'Lee Lead', 'Member');
  const p = lee.page;

  // Without access the person finds nothing, exactly as for a word that exists nowhere.
  await p.goto(`/workspaces/${s.ws}/search?q=kestrel`);
  await expect(count(p)).toContainText('No results for “kestrel”.');
  const hidden = await count(p).innerText();
  await p.goto(`/workspaces/${s.ws}/search?q=qwxzvbnm`);
  await expect(count(p)).toContainText('No results for “qwxzvbnm”.');
  expect(hidden.replace('kestrel', 'X')).toBe(
    (await count(p).innerText()).replace('qwxzvbnm', 'X'),
  );
  await expect(p.getByText('Search is catching up')).toHaveCount(0);
  await expectAccessible(p, 'search, nothing visible');
  // The API says the same thing: no counts, facets, or index state that mention hidden work.
  const raw = await (await p.request.get(`/v1/workspaces/${s.ws}/search?q=kestrel`)).json();
  expect(raw.data).toMatchObject({ total: 0, results: [], facets: { kinds: [], brands: [] } });
  expect(raw.data.index).toMatchObject({ state: 'complete', pending: 0, failed: 0 });
  const opened = await p.request.post(`/v1/workspaces/${s.ws}/search/open`, {
    data: { type: 'task', id: task },
    headers: {
      origin: new URL(p.url()).origin,
      'x-csrf-token': (await p.request.get('/v1/auth/me')).headers()['x-csrf-token'] ?? '',
    },
  });
  expect(opened.status()).toBe(404);

  // Access is given: the same person finds the work at once (no re-indexing involved).
  await giveBrand(page, s.ws, 'Harbor', 'Lee Lead', 'edit');
  await p.goto(`/workspaces/${s.ws}/search?q=kestrel`);
  await expect(count(p)).toContainText('3 results for “kestrel”');
  const link = results(p).getByRole('link', { name: 'Reconcile kestrel invoices' });
  await expect(link).toBeVisible();
  // A search that names the brand is remembered when it is submitted (the brand filter appears
  // only for people who can choose between brands, so this one arrives by its address).
  await p.goto(`/workspaces/${s.ws}/search?q=kestrel&brand=${s.harbor}`);
  await expect(results(p)).toBeVisible();
  await searchbox(p).press('Enter');
  await expect(results(p)).toBeVisible();
  await p.goto(`/workspaces/${s.ws}/search`);
  await expect(
    p.getByRole('region', { name: 'Recent searches' }).getByRole('link', { name: 'kestrel' }),
  ).toBeVisible();
  await p.goBack();
  await expect(results(p)).toBeVisible();

  // Access is removed while the results are on screen: opening the result is refused with the
  // standard not-available page, and the next search shows nothing.
  await removeBrandAccess(page, s.ws, 'Harbor', 'Lee Lead');
  await link.click();
  await expect(p.getByText(/no longer available to you/)).toBeVisible();
  await expect(link).toHaveCount(0);
  await p.goto(`/workspaces/${s.ws}/tasks/${task}`);
  await expect(p.getByRole('heading', { level: 1 })).toHaveText("This page isn't available");
  await p.goto(`/workspaces/${s.ws}/search?q=kestrel`);
  await expect(count(p)).toContainText('No results for “kestrel”.');
  // A remembered search that named the brand leaves the person's list once they lose that brand.
  await p.goto(`/workspaces/${s.ws}/search`);
  await expect(p.getByRole('region', { name: 'Recent searches' })).toBeVisible();
  await expect(
    p.getByRole('region', { name: 'Recent searches' }).getByRole('link', { name: 'kestrel' }),
  ).toHaveCount(0);
  await expect(p.getByText(/Nothing is remembered while you type/)).toBeVisible();
  await expectAccessible(p, 'search after access was removed');
  await lee.ctx.close();
});

test('keeps results through a dropped connection and searches again when it returns @desktop-only', async ({
  page,
  context,
}, info) => {
  const s = await setup(page, info, 'search-offline');
  await seed(page, s, 'plover');
  await page.goto(`/workspaces/${s.ws}/search?q=plover`);
  await expect(results(page)).toBeVisible();
  await context.setOffline(true);
  // The same search again: the earlier results stay, marked as from before the problem.
  await searchbox(page).press('Enter');
  await expect(page.getByText("You're offline", { exact: false }).first()).toBeVisible();
  await expect(results(page)).toBeVisible();
  await expect(page.getByText('These results are from before the problem')).toBeVisible();
  await expectAccessible(page, 'search offline with earlier results');
  // Back online it searches again by itself.
  await context.setOffline(false);
  await expect(page.getByText('These results are from before the problem')).toHaveCount(0);
  await expect(count(page)).toContainText('3 results for “plover”');
  // A different search while offline shows no one else's results, keeps the typed words, and
  // sends nothing; the connection returning runs it.
  await context.setOffline(true);
  await searchbox(page).fill('plover handbook');
  await page.keyboard.press('Enter');
  await expect(page.getByText("You're offline", { exact: false }).first()).toBeVisible();
  await expect(results(page)).toHaveCount(0);
  await expect(searchbox(page)).toHaveValue('plover handbook');
  await expectAccessible(page, 'search offline, new words');
  await context.setOffline(false);
  await expect(count(page)).toContainText('for “plover handbook”');
  await expect(results(page)).toBeVisible();
  await expectAccessible(page, 'search after recovery');
});

test('reaches the search field and every filter with the keyboard alone @desktop-only', async ({
  page,
}, info) => {
  const s = await setup(page, info, 'search-keys');
  await seed(page, s, 'heron');
  await page.goto(`/workspaces/${s.ws}/search`);
  await tabTo(page, `el.matches('input[type="search"]')`);
  await page.keyboard.type('heron');
  await page.keyboard.press('Enter');
  await expect(results(page)).toBeVisible();
  await tabTo(page, `el.matches('aside input[type="checkbox"]')`);
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/kind=/);
  // The select is reached by Tab; choosing in a native select is the browser's own keyboard
  // handling (it differs by platform), so the choice itself is made through the control.
  await tabTo(page, `el.matches('#main select')`);
  await page.locator('#main select:focus').selectOption('any');
  await expect(page).toHaveURL(/state=any/);
  // Every result link is reachable in order and opens by Enter.
  await tabTo(page, `el.closest('.search-result') !== null`);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/(tasks|documents)\//);
});
