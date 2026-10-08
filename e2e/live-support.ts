import {
  expect as baseExpect,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import {
  createBrand,
  createWorkspace,
  expectAccessible as axe,
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

/** CI is several times slower than a laptop: states are waited for longer, never slept on. */
export const expect = baseExpect.configure({ timeout: 15_000 });

/** Helpers for the 4D live editing journeys: people, a seeded page, and waiting for live state. */

type Info = Parameters<typeof uniqueEmail>[1];

export const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
export const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
export const liveStatus = (page: Page) => page.locator('.live-status');
export const saveState = (page: Page) => page.locator('#doc-save-state');
export const paragraphs = (page: Page) => page.getByLabel('Paragraph text');

export async function api(
  page: Page,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  data?: unknown,
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
    ...(data !== undefined ? { data } : {}),
  });
  expect(r.status(), await r.text()).toBeLessThan(300);
  const text = await r.text();
  return text ? JSON.parse(text).data : undefined;
}

async function inviteMember(page: Page, ws: string, email: string, role: string): Promise<void> {
  await page.goto(`/workspaces/${ws}/people/invite`);
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel('Role').selectOption({ label: role });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(h1(page)).toHaveText('People');
}

async function accept(page: Page, email: string, name: string): Promise<void> {
  await openLink(page, linkPath(await waitForMail(email, 'invited')));
  await register(page, email, name);
  await verify(page, email);
  await signedIn(page, email);
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByRole('navigation', { name: 'Primary' }).first()).toBeVisible();
}

export async function giveBrand(
  page: Page,
  ws: string,
  brand: string,
  person: string,
  level: string,
) {
  await page.goto(`/workspaces/${ws}`);
  await page.getByRole('link', { name: `Settings for ${brand}` }).click();
  const access = page.getByRole('region', { name: 'Who has access' });
  await access.getByLabel('Give access to').selectOption({ label: person });
  await access.getByLabel('Access level').selectOption(level);
  await access.getByRole('button', { name: 'Review access…' }).click();
  await page
    .getByRole('dialog', { name: 'Give brand access?' })
    .getByRole('button', { name: 'Give access' })
    .click();
  await expect(page.getByText('Access given.')).toBeAttached();
}

/** The owner removes a person's access to a brand (their next request is refused). */
export async function removeBrandAccess(page: Page, ws: string, brand: string, person: string) {
  await page.goto(`/workspaces/${ws}`);
  await page.getByRole('link', { name: `Settings for ${brand}` }).click();
  const access = page.getByRole('region', { name: 'Who has access' });
  await access.getByRole('button', { name: `Remove access for ${person}` }).click();
  await page
    .getByRole('alertdialog', { name: 'Remove brand access?' })
    .getByRole('button', { name: 'Remove access' })
    .click();
  await expect(page.getByText('Access removed.')).toBeAttached();
}

export async function person(
  browser: Browser,
  founder: Page,
  ws: string,
  info: Info,
  prefix: string,
  name: string,
  role: string,
): Promise<{ ctx: BrowserContext; page: Page; email: string }> {
  const email = uniqueEmail(prefix, info);
  await inviteMember(founder, ws, email, role);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await accept(page, email, name);
  return { ctx, page, email };
}

/** A guest who may only read (or comment on) one document, in their own browser context. */
export async function guestOf(
  browser: Browser,
  founder: Page,
  base: string,
  info: Info,
  prefix: string,
  name: string,
  doc: string,
  level: 'read' | 'comment',
): Promise<{ ctx: BrowserContext; page: Page }> {
  const email = uniqueEmail(prefix, info);
  await api(founder, 'POST', `${base}/invitations`, {
    email,
    kind: 'guest',
    records: [{ record: doc, level }],
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await openLink(page, linkPath(await waitForMail(email, 'invited')));
  await register(page, email, name);
  await verify(page, email);
  await signedIn(page, email);
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page).toHaveURL(/\/workspaces\/ws_/);
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0);
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
  return { ctx, page };
}

export async function setup(page: Page, info: Info, prefix: string) {
  await owner(page, info, prefix, 'Fay Founder');
  const ws = await createWorkspace(page, 'Live Co');
  await createBrand(page, 'Harbor');
  const base = `/v1/workspaces/${ws}`;
  const brands = (await (await page.request.get(`${base}/brands`)).json()).data as Array<{
    id: string;
    name: string;
  }>;
  return { ws, base, harbor: brands.find((b) => b.name === 'Harbor')!.id };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

const para = (text: string) => ({ type: 'paragraph', runs: [{ text }] });

/** A page of plain paragraphs, written through the API. */
export async function seedPage(page: Page, s: Setup, title: string, texts: string[]) {
  const created = await api(page, 'POST', `${s.base}/documents`, {
    type: 'page',
    title,
    brand: s.harbor,
    starter: false,
    content: { v: 2, blocks: texts.map(para) },
  });
  return created.id as string;
}

/** Opens the page and waits until live editing is connected (or says why not). */
export async function openLive(page: Page, ws: string, id: string, title: string) {
  await page.goto(`/workspaces/${ws}/documents/${id}`);
  await expect(h1(page)).toHaveText(title);
  await expect(region(page, 'Content')).toBeVisible();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
  await expect(liveStatus(page)).toContainText(/^Live/);
}

export async function accessible(page: Page, label: string) {
  const chrome = (hidden: boolean) =>
    page.evaluate(
      `for (const el of document.querySelectorAll('.bottom-nav, .app-header')) el.style.visibility = '${hidden ? 'hidden' : ''}'`,
    );
  await chrome(true);
  try {
    await axe(page, label);
  } finally {
    await chrome(false);
  }
}

/** No sideways scroll; if there is some, the failure names what sticks out. */
export async function expectNoOverflow(page: Page, label: string) {
  const over = await noHorizontalOverflow(page);
  if (over <= 0) return;
  const offenders = await page.evaluate<string[]>(`(() => {
    const w = document.documentElement.clientWidth;
    const clipped = (e) => {
      for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o === 'auto' || o === 'scroll' || o === 'hidden') return true;
      }
      return false;
    };
    return [...document.querySelectorAll('body *')]
      .filter((e) => e.getBoundingClientRect().right > w + 1 && !clipped(e))
      .slice(0, 6)
      .map((e) => e.tagName.toLowerCase() + '.' + e.className + ' right=' + Math.round(e.getBoundingClientRect().right) + ' of ' + w);
  })()`);
  expect(offenders, `${label}: ${over}px of sideways scroll`).toEqual([]);
  expect(over, `${label}: sideways scroll with no visible offender`).toBeLessThanOrEqual(0);
}

/** Moves focus with Tab until the focused element matches; fails if it never does. */
export async function tabTo(page: Page, test: string, max = 400) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate<boolean>(`((el) => ${test})(document.activeElement)`)) return;
  }
  throw new Error('keyboard focus never reached the control');
}

/** Saves a version through the live Save and waits for the server's answer. */
export async function saveVersion(page: Page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(saveState(page)).toContainText(/Saved as version \d+\./);
}

export const noLive = async (ctx: BrowserContext): Promise<void> => {
  await ctx.route(/\/documents\/[^/]+\/live\/session$/, (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'conflict',
          message: 'Live editing is not available.',
          issues: [{ pointer: '/', code: 'live_disabled', message: 'Live editing is off.' }],
        },
      }),
    }),
  );
};
