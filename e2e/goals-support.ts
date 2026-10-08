import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  createBrand,
  createWorkspace,
  expectAccessible,
  linkPath,
  openLink,
  owner,
  register,
  signedIn,
  uniqueEmail,
  verify,
  waitForMail,
} from './support.ts';

/** Helpers for the 5B journeys: a founder with brands, projects, and tasks; narrower members. */

type Info = Parameters<typeof uniqueEmail>[1];

export const h1 = (page: Page) => page.getByRole('heading', { level: 1 });

export async function api(
  page: Page,
  method: 'POST' | 'PATCH' | 'PUT',
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

/** A GET as the signed-in person; returns the raw response for status checks. */
export const get = (page: Page, path: string) => page.request.get(path);

export async function inviteMember(page: Page, ws: string, email: string, role: string) {
  await page.goto(`/workspaces/${ws}/people/invite`);
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel('Role').selectOption({ label: role });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(h1(page)).toHaveText('People');
}

export async function accept(page: Page, email: string, name: string) {
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

export interface Seed {
  ws: string;
  base: string;
  harbor: string;
  vault: string;
  /** Harbor: "Launch site" with one finished and one open task. */
  site: { id: string; tasks: { done: string; open: string } };
  /** Vault (private to the founder): "Secret roadmap project" with two open tasks. */
  secret: { id: string; tasks: string[] };
}

/** The founder, a workspace, the shared brand Harbor and the private brand Vault, with work in both. */
export async function seed(
  page: Page,
  info: Info,
  prefix: string,
  siteDates: Record<string, string> = {},
): Promise<Seed> {
  await owner(page, info, prefix, 'Fay Founder');
  const ws = await createWorkspace(page, 'Goals Co');
  await createBrand(page, 'Harbor');
  await page.goto(`/workspaces/${ws}/brands/new`);
  await createBrand(page, 'Vault', 'Leaf');
  const base = `/v1/workspaces/${ws}`;
  const brands = (await (await get(page, `${base}/brands`)).json()).data as Array<{
    id: string;
    name: string;
  }>;
  const harbor = brands.find((b) => b.name === 'Harbor')!.id;
  const vault = brands.find((b) => b.name === 'Vault')!.id;
  const site = await api(page, 'POST', `${base}/projects`, {
    brand: harbor,
    name: 'Launch site',
    ...siteDates,
  });
  const done = await api(page, 'POST', `${base}/tasks`, {
    brand: harbor,
    project: site.id,
    title: 'Draft the homepage',
  });
  await api(page, 'POST', `${base}/tasks/${done.id}:complete`, {}, done.version);
  const open = await api(page, 'POST', `${base}/tasks`, {
    brand: harbor,
    project: site.id,
    title: 'Publish the homepage',
  });
  const secret = await api(page, 'POST', `${base}/projects`, {
    brand: vault,
    name: 'Secret roadmap project',
  });
  const s1 = await api(page, 'POST', `${base}/tasks`, {
    brand: vault,
    project: secret.id,
    title: 'Secret task one',
  });
  const s2 = await api(page, 'POST', `${base}/tasks`, {
    brand: vault,
    project: secret.id,
    title: 'Secret task two',
  });
  return {
    ws,
    base,
    harbor,
    vault,
    site: { id: site.id, tasks: { done: done.id, open: open.id } },
    secret: { id: secret.id, tasks: [s1.id, s2.id] },
  };
}

/** The current calendar quarter, as the goal API takes it. */
export function thisQuarter() {
  const now = new Date();
  return {
    kind: 'quarter' as const,
    year: now.getFullYear(),
    index: Math.floor(now.getMonth() / 3) + 1,
  };
}

/** axe on the page's own content (shell chrome is covered by the shell journeys). */
export async function accessible(page: Page, label: string) {
  await expectAccessible(page, label);
}

export const progressOf = async (page: Page, name: string) =>
  Number(
    await page
      .getByRole('progressbar', { name, exact: true })
      .first()
      .getAttribute('aria-valuenow'),
  );
