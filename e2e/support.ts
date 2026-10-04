import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

export const PASSWORD = 'e2e correct horse battery';

export function uniqueEmail(
  prefix: string,
  testInfo: { project: { name: string }; workerIndex: number },
): string {
  return `${prefix}-${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}@example.test`;
}

interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** Polls the private capture mailbox (never printed or attached to reports). */
export async function waitForMail(to: string, subjectIncludes: string, after = 0): Promise<Mail> {
  const dir = process.env.PM_E2E_MAILBOX!;
  for (let i = 0; i < 100; i++) {
    let files: string[] = [];
    try {
      files = readdirSync(dir).sort();
    } catch {
      // not created yet
    }
    const matches = files
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Mail)
      .filter(
        (m) =>
          m.to.toLowerCase() === to.toLowerCase() &&
          m.subject.toLowerCase().includes(subjectIncludes.toLowerCase()),
      );
    if (matches.length > after) return matches.at(-1)!;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no "${subjectIncludes}" mail`);
}

/** The path + fragment of the one-time link in a captured mail. */
export function linkPath(mail: Mail): string {
  const url = /(https?:\/\/[^\s]+#token=[A-Za-z0-9_-]{43})/.exec(mail.text)![1]!;
  const u = new URL(url);
  return `${u.pathname}${u.hash}`;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function totp(secretB32: string, offsetSteps = 0): string {
  const clean = secretB32.replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offsetSteps));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const o = mac[mac.length - 1]! & 0x0f;
  return ((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

interface AxeViolation {
  id: string;
  help: string;
  impact?: string | null;
  nodes: unknown[];
}

/** Zero serious or critical axe violations (0E A11Y testing protocol). */
export async function expectAccessible(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = (results.violations as AxeViolation[]).filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(
    blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`),
    label,
  ).toEqual([]);
}

export async function register(page: Page, email: string, name = 'E2E Person'): Promise<void> {
  await page.goto('/register');
  await page.getByLabel(/^Name/).fill(name);
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByLabel('I accept the terms of service and privacy notice').check();
  await page.getByLabel(/I'm a person/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Check your email');
}

export async function verify(page: Page, email: string): Promise<void> {
  const mail = await waitForMail(email, 'verify your email');
  await openLink(page, linkPath(mail));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Email confirmed');
  expect(page.url()).not.toContain('token='); // fragment removed after use
}

export async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Signs in and waits until the app has left the sign-in page (session or MFA step). */
export async function signedIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await signIn(page, email, password);
  await page.waitForURL(/\/(onboarding|sign-in\/verify|verify-email)$/);
}

/** Opens an emailed link as a fresh document (as a mail client would), not an in-page hash change. */
export async function openLink(page: Page, path: string): Promise<void> {
  await page.goto('about:blank');
  await page.goto(path);
}

// ---- Workspace helpers (1C/1D) -----------------------------------------------------------

export async function owner(
  page: Page,
  info: Parameters<typeof uniqueEmail>[1],
  prefix: string,
  name = 'E2E Person',
): Promise<string> {
  const email = uniqueEmail(prefix, info);
  await register(page, email, name);
  await verify(page, email);
  await signedIn(page, email);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Welcome, ${name}`);
  return email;
}

export async function createWorkspace(page: Page, name: string): Promise<string> {
  await expect(page.getByRole('heading', { name: 'Create your workspace' })).toBeVisible();
  await page.getByLabel(/^Workspace name/).fill(name);
  await page.getByLabel('Time zone').selectOption('Europe/Lisbon');
  await page.getByLabel('Currency').selectOption('EUR');
  await page.getByLabel('Week starts on').selectOption({ label: 'Monday' });
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Add your first brand');
  return /\/workspaces\/(ws_[0-9A-Z]{26})\//.exec(page.url())![1]!;
}

export async function createBrand(page: Page, name: string, icon = 'Leaf'): Promise<void> {
  await page.getByLabel(/^Brand name/).fill(name);
  await page.getByRole('radio', { name: icon }).check();
  await page.getByRole('button', { name: 'Create brand' }).click();
  await expect(page.getByRole('status').filter({ hasText: `${name} was created.` })).toBeVisible();
}

export const noHorizontalOverflow = (page: Page) =>
  page.evaluate<number>(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth',
  );

/**
 * Follows a shell navigation entry by name on any width class: the sidebar or rail when it shows
 * the link, otherwise the Compact More sheet (RS-05).
 */
export async function goTo(page: Page, name: string): Promise<void> {
  const direct = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', {
    name,
    exact: true,
  });
  if (await direct.first().isVisible()) {
    await direct.first().click();
    return;
  }
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('dialog', { name: 'More' }).getByRole('link', { name, exact: true }).click();
}
