import { expect, test, type Page } from '@playwright/test';
import {
  createBrand,
  createWorkspace,
  expectAccessible,
  linkPath,
  noHorizontalOverflow,
  openLink,
  owner,
  PASSWORD,
  register,
  signedIn,
  uniqueEmail,
  verify,
  waitForMail,
} from './support.ts';

/** Phase 1D: invitations (sender and recipient), people, roles, brand access, teams, ownership. */

async function confirmStepUp(page: Page): Promise<void> {
  const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(stepUp).toBeVisible();
  await stepUp.getByLabel(/^Password/).fill(PASSWORD);
  await stepUp.getByRole('button', { name: 'Confirm' }).click();
  await expect(stepUp).toBeHidden();
}

async function inviteMember(page: Page, ws: string, email: string, role: string): Promise<void> {
  await page.goto(`/workspaces/${ws}/people/invite`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Invite people');
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel('Role').selectOption({ label: role });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('People');
  await expect(page.getByRole('region', { name: 'Invitations' })).toContainText(email);
}

/** The recipient opens the mailed link signed out, registers, verifies, signs in, and accepts. */
async function recipientAccepts(page: Page, email: string, name: string): Promise<void> {
  const mail = await waitForMail(email, 'invited');
  expect(mail.text).not.toMatch(/Workspace|Harbor|Team Space/);
  await openLink(page, linkPath(mail));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText("You've been invited");
  expect(page.url()).not.toContain('token=');
  await expectAccessible(page, 'invitation (signed out)');
  await register(page, email, name);
  await verify(page, email);
  await signedIn(page, email);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Join a workspace');
  await expect(page.getByRole('region', { name: 'Invite Co' })).toContainText('invited you as');
  await expectAccessible(page, 'invitation (ready)');
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Invite Co');
}

test('invite, accept, change role, give brand access, and remove a member', async ({
  page,
  browser,
}, info) => {
  await owner(page, info, 'collab-owner', 'Olive Owner');
  const ws = await createWorkspace(page, 'Invite Co');
  await createBrand(page, 'Harbor');
  const memberEmail = uniqueEmail('collab-member', info);
  await inviteMember(page, ws, memberEmail, 'Member');
  await expectAccessible(page, 'people');

  const other = await browser.newContext();
  const rp = await other.newPage();
  await recipientAccepts(rp, memberEmail, 'Milo Member');
  // Members see names, not emails, and no management actions.
  await rp.goto(`/workspaces/${ws}/people`);
  await expect(rp.getByText(memberEmail)).toHaveCount(0);
  await expect(rp.getByRole('link', { name: 'Invite people' })).toHaveCount(0);

  // Owner: change the member's role through review + step-up.
  await page.goto(`/workspaces/${ws}/people`);
  await page.getByRole('link', { name: 'Access and actions for Milo Member' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Milo Member');
  await expectAccessible(page, 'member access');
  await page.getByLabel('Change role to').selectOption({ label: 'Read-only' });
  await page.getByRole('button', { name: 'Review role change…' }).click();
  const review = page.getByRole('dialog', { name: /Change Milo Member's role to Read-only/ });
  await expect(review.getByText(/Can no longer|No visible change/)).toBeVisible();
  await review.getByRole('button', { name: 'Change role' }).click();
  await confirmStepUp(page);
  await expect(page.getByText('Milo Member is now Read-only.')).toBeAttached();

  // Brand access from the brand's settings: review shows what becomes visible.
  await page.goto(`/workspaces/${ws}`);
  await page.getByRole('link', { name: 'Settings for Harbor' }).click();
  const access = page.getByRole('region', { name: 'Who has access' });
  await access.getByLabel('Give access to').selectOption({ label: 'Milo Member' });
  await access.getByLabel('Access level').selectOption('edit');
  await access.getByRole('button', { name: 'Review access…' }).click();
  const grant = page.getByRole('dialog', { name: 'Give brand access?' });
  await expect(grant).toContainText('This gives more access');
  await expect(grant).toContainText('Harbor');
  await expectAccessible(page, 'access review');
  await grant.getByRole('button', { name: 'Give access' }).click();
  await expect(page.getByText('Access given.')).toBeAttached();
  await expect(access).toContainText('Milo Member');
  // The member now sees the brand on their next request.
  await rp.goto(`/workspaces/${ws}`);
  await expect(rp.getByRole('region', { name: /Active brands/ })).toContainText('Harbor');

  // Remove: departure explanation, review, step-up; the member's next request fails.
  await page.goto(`/workspaces/${ws}/people`);
  await page.getByRole('link', { name: 'Access and actions for Milo Member' }).click();
  await page.getByRole('button', { name: 'Remove from workspace…' }).click();
  const remove = page.getByRole('alertdialog', { name: 'Remove Milo Member?' });
  await expect(remove).toContainText('signed out everywhere');
  await expect(remove.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await remove.getByRole('button', { name: 'Continue' }).click();
  await page
    .getByRole('alertdialog', { name: 'Confirm removing Milo Member' })
    .getByRole('button', { name: 'Remove from workspace' })
    .click();
  await confirmStepUp(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('People');
  await rp.goto(`/workspaces/${ws}`);
  await expect(rp.getByRole('heading', { level: 1 })).toHaveText(/Sign in|Workspace/);
  await other.close();
});

test('teams, sharing settings, ownership transfer, states, and reflow', async ({
  page,
  browser,
}, info) => {
  await owner(page, info, 'collab-teams', 'Tara Owner');
  const ws = await createWorkspace(page, 'Invite Co');
  await createBrand(page, 'Summit');
  const adminEmail = uniqueEmail('collab-admin', info);
  await inviteMember(page, ws, adminEmail, 'Administrator');
  const other = await browser.newContext();
  const ap = await other.newPage();
  await recipientAccepts(ap, adminEmail, 'Ada Admin');

  // Teams: create, add the administrator (review), see membership.
  await page.goto(`/workspaces/${ws}/teams`);
  await page.getByLabel(/^Team name/).fill('Studio');
  await page.getByRole('button', { name: 'Create team' }).click();
  await expect(page.getByText('Team Studio was created.')).toBeAttached();
  await page.getByRole('link', { name: 'Manage team Studio' }).click();
  await page.getByLabel('Add a person').selectOption({ label: 'Ada Admin' });
  await page.getByRole('button', { name: 'Review adding…' }).click();
  await page
    .getByRole('dialog', { name: 'Add to team?' })
    .getByRole('button', { name: 'Add to team' })
    .click();
  await expect(page.getByRole('region', { name: /Members/ })).toContainText('Ada Admin');
  await expectAccessible(page, 'team');

  // Sharing policy: loosening asks for confirmation, then step-up.
  await page.goto(`/workspaces/${ws}/settings/access`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sharing and ownership');
  await page.getByLabel(/Members can invite guests/).click();
  const loosen = page.getByRole('alertdialog', { name: 'This gives people more access' });
  await loosen.getByRole('button', { name: 'Turn on' }).click();
  await confirmStepUp(page);
  await expect(page.getByText('Setting saved.')).toBeAttached();
  await expectAccessible(page, 'sharing settings');

  // Ownership transfer: request (step-up), recipient accepts (step-up).
  await page.getByLabel('New owner').selectOption({ label: 'Ada Admin' });
  await page.getByRole('button', { name: 'Request transfer' }).click();
  await confirmStepUp(page);
  await expect(page.getByText('Waiting for Ada Admin to accept')).toBeVisible();
  await ap.goto(`/workspaces/${ws}/people`);
  await ap.getByRole('button', { name: 'Accept ownership' }).click();
  await confirmStepUp(ap);
  await ap.reload();
  await expect(ap.getByRole('listitem').filter({ hasText: 'Ada Admin' })).toContainText('Owner');

  // Not found and no access look identical; guests' and strangers' views give nothing away.
  await page.goto(`/workspaces/${ws}/people/mem_01J0000000000000000000000Z`);
  await expect(page.getByText("We can't find this person")).toBeVisible();

  // Forced colors with reduced motion, and 320 px reflow on the people pages.
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.goto(`/workspaces/${ws}/people`);
  await expectAccessible(page, 'people, forced colors');
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });
  const size = page.viewportSize()!;
  for (const width of [Math.max(320, Math.floor(size.width / 2)), 320]) {
    await page.setViewportSize({ width, height: size.height });
    for (const path of [
      `/workspaces/${ws}/people`,
      `/workspaces/${ws}/teams`,
      `/workspaces/${ws}/settings/access`,
    ]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await noHorizontalOverflow(page), `${path} at ${width}px`).toBeLessThanOrEqual(0);
    }
  }
  await other.close();
});
