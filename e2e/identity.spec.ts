import { expect, test } from '@playwright/test';
import {
  expectAccessible,
  linkPath,
  openLink,
  PASSWORD,
  register,
  signIn,
  signedIn,
  totp,
  uniqueEmail,
  verify,
  waitForMail,
} from './support.ts';

test('registration, email verification, sign-in, and sign-out', async ({ page }, testInfo) => {
  const email = uniqueEmail('journey', testInfo);
  await page.goto('/register');
  await expectAccessible(page, 'register');
  // Invalid submission: summary receives focus, links to fields, input is kept.
  await page.getByLabel(/^Email/).fill('not-an-email');
  await page.getByRole('button', { name: 'Create account' }).click();
  const summary = page.getByRole('alert').filter({ hasText: 'problem' });
  await expect(summary).toBeFocused();
  await expect(page.getByLabel(/^Email/)).toHaveValue('not-an-email');
  await expect(page.getByLabel(/^Email/)).toHaveAttribute('aria-invalid', 'true');
  await expectAccessible(page, 'register with errors');

  await register(page, email);
  await expectAccessible(page, 'check email');
  await verify(page, email);
  await signIn(page, email);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome, E2E Person');
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await expectAccessible(page, 'onboarding');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
});

test('sign-in failure, rate-limit-safe messaging, and keyboard-only operation', async ({
  page,
}, testInfo) => {
  const email = uniqueEmail('keyboard', testInfo);
  await register(page, email);
  await verify(page, email);
  await page.goto('/sign-in');
  await expectAccessible(page, 'sign in');
  // Focus starts on the page heading after navigation; the next Tab reaches the first field.
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel(/^Email/)).toBeFocused();
  await page.keyboard.type(email);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel(/^Password/)).toBeFocused();
  await page.keyboard.type('wrong password!!');
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('alert').filter({ hasText: 'The email or password is incorrect.' }),
  ).toBeVisible();
  await expect(page.getByLabel(/^Email/)).toHaveValue(email); // input preserved
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(page.getByLabel(/^Password/)).toHaveAttribute('type', 'text');
  await page.getByLabel(/^Password/).press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Welcome/);
});

test('password reset is single-use and signs out every session', async ({
  page,
  browser,
}, testInfo) => {
  const email = uniqueEmail('reset', testInfo);
  await register(page, email);
  await verify(page, email);
  const other = await browser.newPage();
  await signIn(other, email);
  await expect(other.getByRole('heading', { level: 1 })).toHaveText(/Welcome/);

  await page.goto('/forgot-password');
  await expectAccessible(page, 'forgot password');
  await page.getByLabel(/^Email/).fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Check your email' })).toBeVisible();
  const link = linkPath(await waitForMail(email, 'reset your'));
  await openLink(page, link);
  await expectAccessible(page, 'reset password');
  await page.getByLabel(/^New password/).fill('a fresh e2e passphrase');
  await page.getByLabel(/^Confirm new password/).fill('a fresh e2e passphrase');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Password changed');
  await openLink(page, link);
  await page.getByLabel(/^New password/).fill('another e2e passphrase');
  await page.getByLabel(/^Confirm new password/).fill('another e2e passphrase');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'already used' })).toBeVisible();
  await other.reload();
  await expect(other.getByRole('heading', { level: 1 })).toHaveText('Sign in');
  await signIn(page, email, 'a fresh e2e passphrase');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Welcome/);
});

test('TOTP enrollment through step-up, recovery codes, and MFA sign-in', async ({
  page,
}, testInfo) => {
  const email = uniqueEmail('totp', testInfo);
  await register(page, email);
  await verify(page, email);
  await signedIn(page, email);
  await page.goto('/account/security');
  await expectAccessible(page, 'account security');

  await page.getByRole('button', { name: 'Set up two-step verification' }).click();
  const dialog = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(/^Password/)).toBeFocused();
  await expectAccessible(page, 'step-up dialog');
  await dialog.getByLabel(/^Password/).fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  // The original action resumed automatically after verification.
  const key = (await page.locator('code.secret').textContent())!.replace(/\s/g, '');
  await expectAccessible(page, 'totp enrollment');
  await page.getByLabel(/^Code from your app/).fill(totp(key));
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
  await expectAccessible(page, 'recovery codes');
  const codes = await page.locator('.codes code').allTextContents();
  expect(codes).toHaveLength(10);
  await expect(page.getByRole('button', { name: 'Done' })).toBeDisabled();
  await page.getByLabel("I've saved these codes somewhere safe").check();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText("You'll enter a code from your authenticator app")).toBeVisible();

  // Sign in again: password, then the code (the next time step avoids replay of the confirm code).
  await page.goto('/onboarding');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, email);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Two-step verification');
  await expectAccessible(page, 'mfa challenge');
  await page.getByLabel(/^Authenticator code/).fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByLabel(/^Authenticator code/)).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel(/^Authenticator code/).fill(totp(key, 1));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Welcome/);

  // Recovery code path, single use.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, email);
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await page.getByLabel(/^Recovery code/).fill(codes[0]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Welcome/);
});

test('remote sign-out takes effect on the other device next request', async ({
  page,
  browser,
}, testInfo) => {
  const email = uniqueEmail('remote', testInfo);
  await register(page, email);
  await verify(page, email);
  await signIn(page, email);
  const phone = await browser.newPage();
  await signIn(phone, email);
  await expect(phone.getByRole('heading', { level: 1 })).toHaveText(/Welcome/);
  await page.goto('/account/security');
  await page.getByRole('button', { name: /^Sign out .+, signed in/ }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByRole('button', { name: 'Sign out' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Signed out', { exact: true })).toBeVisible();
  await phone.goto('/account/security');
  await expect(phone.getByRole('heading', { level: 1 })).toHaveText('Sign in');
  // Sign out everywhere: destructive confirmation starts on Cancel.
  await page.getByRole('button', { name: 'Sign out everywhere' }).click();
  const all = page.getByRole('alertdialog');
  await expect(all.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await all.getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
});

test('step-up continuation preserves the action and resumes it (recovery code regeneration)', async ({
  page,
}, testInfo) => {
  const email = uniqueEmail('stepup', testInfo);
  await register(page, email);
  await verify(page, email);
  await signedIn(page, email);
  await page.goto('/account/security');
  await page.getByRole('button', { name: 'Set up two-step verification' }).click();
  await page
    .getByRole('dialog')
    .getByLabel(/^Password/)
    .fill(PASSWORD);
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  const key = (await page.locator('code.secret').textContent())!.replace(/\s/g, '');
  await page.getByLabel(/^Code from your app/).fill(totp(key));
  await page.getByRole('button', { name: 'Turn on' }).click();
  await page.getByLabel("I've saved these codes somewhere safe").check();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Create new recovery codes' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create new codes' }).click();
  const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
  await stepUp.getByLabel('Authenticator app code').check();
  await stepUp.getByRole('textbox').fill(totp(key, 1));
  await stepUp.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
});

test('verification links handle used and invalid tokens; pages reflow at 320 px', async ({
  page,
}, testInfo) => {
  const email = uniqueEmail('links', testInfo);
  await register(page, email);
  const mail = await waitForMail(email, 'verify your email');
  await openLink(page, linkPath(mail));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Email confirmed');
  await openLink(page, linkPath(mail));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('This link was already used');
  await page.goto('/verify-email/confirm');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText("This link isn't valid");
  await expectAccessible(page, 'invalid link');
  await page.setViewportSize({ width: 320, height: 640 });
  for (const path of ['/sign-in', '/register', '/forgot-password']) {
    await page.goto(path);
    const overflow = await page.evaluate<number>(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});
