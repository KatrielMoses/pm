import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, PASSWORD, register, signedIn, uniqueEmail, verify } from './support.ts';

/** Phase 1F: own-account Security activity and the reusable lifecycle states. */

/** Extra sign-ins through the API (same browser context), to make the activity list paginate. */
async function extraSignIns(page: Page, email: string, n: number): Promise<void> {
  const origin = new URL(page.url()).origin;
  for (let i = 0; i < n; i++) {
    // The context holds a session cookie, so the synchronizer token must accompany the POST.
    const me = await page.request.get('/v1/auth/me');
    const csrf = me.headers()['x-csrf-token'] ?? '';
    const r = await page.request.post('/v1/auth/sign-in', {
      headers: { origin, 'x-csrf-token': csrf },
      data: { email, password: PASSWORD },
    });
    expect(r.status()).toBe(200);
  }
}

test('security activity lists only my events, masked, with pagination, retry, and offline states', async ({
  page,
}, info) => {
  const email = uniqueEmail('activity', info);
  await register(page, email);
  await verify(page, email);
  await signedIn(page, email);
  await extraSignIns(page, email, 22);
  await page.goto('/account/security');
  const section = page.getByRole('region', { name: 'Security activity' });
  await expect(section.getByRole('list', { name: 'Security events, newest first' })).toBeVisible();
  const items = section.getByRole('listitem');
  await expect(items).toHaveCount(20);
  await expect(section.getByText('Signed in').first()).toBeVisible();
  await expect(section.getByText('This device').first()).toBeVisible();
  const text = (await section.textContent()) ?? '';
  expect(text).not.toContain(email);
  expect(text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/); // never a full address
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // never an internal id
  await expectAccessible(page, 'security activity');
  // Keyboard: "Show older activity" is reachable and appends the next page.
  const older = section.getByRole('button', { name: 'Show older activity' });
  await older.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => items.count()).toBeGreaterThan(20);
  // Error with retry.
  await page.route('**/v1/auth/security-activity**', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'internal_error',
          status: 500,
          message: 'x',
          request_id: 'req_0J8ZK3Q5B8V2N4M6P7R9S0T1HA',
        },
      }),
    }),
  );
  await page.reload();
  await expect(section.getByRole('alert')).toContainText('Something went wrong on our side');
  await page.unroute('**/v1/auth/security-activity**');
  await section.getByRole('button', { name: 'Try again' }).click();
  await expect(items.first()).toBeVisible();
  // Offline: the action explains it needs a connection.
  await page.context().setOffline(true);
  await page.evaluate('window.dispatchEvent(new Event("offline"))');
  await expect(page.getByText("You're offline.", { exact: false }).first()).toBeVisible();
  await page.context().setOffline(false);
});

test('reusable lifecycle states are accessible: keyboard, zoom, reduced motion, high contrast', async ({
  page,
}) => {
  await page.goto('/_harness/lifecycle');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lifecycle components');
  for (const name of [
    'Audit change list',
    'Deleted target',
    'Permission unavailable',
    'Trash metadata',
    'Restore conflicts',
    'Loading',
    'Empty',
    'Error with retry',
    'Offline with retry',
    'Pagination',
    'Permanent deletion',
  ])
    await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
  const changes = page.getByRole('region', { name: 'Audit change list' });
  await expect(changes).toContainText('Changed (the value is never shown)');
  await expect(changes).toContainText('removed when the item was permanently deleted');
  await expect(page.getByRole('region', { name: 'Deleted target' })).toHaveText(/Deleted item/);
  await expectAccessible(page, 'harness');

  // Pagination by keyboard.
  const pager = page.getByRole('region', { name: 'Pagination' });
  await pager.getByRole('button', { name: 'Show more' }).focus();
  await page.keyboard.press('Enter');
  await expect(pager.getByRole('listitem')).toHaveCount(6);

  // Irreversible deletion: keyboard only, typed confirmation, focus returns to the opener.
  const opener = page.getByRole('button', { name: 'Delete permanently…' });
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog', { name: /permanently\?/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expectAccessible(page, 'purge confirmation');
  const confirm = dialog.getByRole('button', { name: 'Delete permanently' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/Type DELETE to confirm/).fill('DELETE');
  await expect(confirm).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  // Reduced motion and forced colors (high contrast) keep everything perceivable.
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lifecycle components');
  await expectAccessible(page, 'harness, forced colors');
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });

  // 200% zoom ≈ half the CSS viewport width: content reflows without horizontal scrolling.
  const size = page.viewportSize()!;
  await page.setViewportSize({
    width: Math.max(320, Math.floor(size.width / 2)),
    height: size.height,
  });
  await page.reload();
  const overflow = await page.evaluate<number>(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth',
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expectAccessible(page, 'harness, 200% zoom');
});
