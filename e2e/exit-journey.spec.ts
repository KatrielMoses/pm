import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { queryUrl } from '@pm/test-support';
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
  signIn,
  uniqueEmail,
  verify,
  waitForMail,
} from './support.ts';

/**
 * Phase 1 exit gate (BUILD_ROADMAP Phase 1): one person securely creates a workspace with three
 * isolated brands, invites a member and a scoped guest through the real invitation flow, switches
 * contexts, and every change of access takes effect on the next check. Real web/API/worker
 * processes and PostgreSQL; the only fixture is one test-only record type (no product record type
 * exists before Phase 2) inserted past RLS, exactly as the 1D integration suite does.
 *
 * Ten ordered steps share three browser contexts (owner, member, guest). Each step is its own
 * test so each keeps the standard per-test budget; serial mode stops the journey at the first
 * failure instead of continuing on a broken state.
 */

test.describe.configure({ mode: 'serial' });

const admin = (sql: string, params: unknown[] = []) =>
  queryUrl(process.env.PM_E2E_ADMIN_URL!, sql, params);

let ownerCtx: BrowserContext;
let memberCtx: BrowserContext;
let guestCtx: BrowserContext;
let op: Page;
let mp: Page;
let gp: Page;
let ws = '';
let wsId = '';
let ownerEmail = '';
let memberEmail = '';
let guestEmail = '';
let fixtureRecord = '';

const scopeButton = (page: Page) => page.getByRole('button', { name: /^Brand scope:/ });
const heading = (page: Page) => page.getByRole('heading', { level: 1 });
const unavailable = "This page isn't available";

async function chooseScope(page: Page, name: string) {
  await scopeButton(page).click();
  await page.getByRole('listbox', { name: 'Brand scope' }).getByRole('option', { name }).click();
  await expect(page.getByRole('listbox', { name: 'Brand scope' })).toHaveCount(0);
}

async function confirmStepUp(page: Page) {
  const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(stepUp).toBeVisible();
  await stepUp.getByLabel(/^Password/).fill(PASSWORD);
  await stepUp.getByRole('button', { name: 'Confirm' }).click();
  await expect(stepUp).toBeHidden();
}

/** Sign out from the account menu (Expanded/Medium) or the More sheet (Compact). */
async function signOut(page: Page) {
  await expect(page.getByRole('navigation', { name: 'Primary' }).first()).toBeVisible();
  const account = page.getByRole('button', { name: 'Account', exact: true });
  if (await account.isVisible()) {
    await account.click();
    await page
      .getByRole('group', { name: 'Account' })
      .getByRole('button', { name: 'Sign out' })
      .click();
  } else {
    await page.getByRole('button', { name: 'More' }).click();
    await page
      .getByRole('dialog', { name: 'More' })
      .getByRole('button', { name: 'Sign out' })
      .click();
  }
  await expect(heading(page)).toHaveText('Sign in');
}

async function acceptInvitation(page: Page, email: string, name: string) {
  const mail = await waitForMail(email, 'invited');
  await openLink(page, linkPath(mail));
  await expect(heading(page)).toHaveText("You've been invited");
  await register(page, email, name);
  await verify(page, email);
  await signedIn(page, email);
  await expect(heading(page)).toHaveText('Join a workspace');
  await expectAccessible(page, `invitation for ${name}`);
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(heading(page)).not.toHaveText('Join a workspace');
}

const brandId = async (name: string): Promise<string> =>
  (await admin(`SELECT id FROM tenancy.brand WHERE workspace_id = $1 AND name = $2`, [wsId, name]))
    .rows[0].id as string;

const membershipOf = async (email: string): Promise<{ id: string; state: string }> =>
  (
    await admin(
      `SELECT m.id, m.state FROM tenancy.membership m JOIN identity.account a ON a.id = m.account_id
        WHERE m.workspace_id = $1 AND lower(a.primary_email) = lower($2)`,
      [wsId, email],
    )
  ).rows[0] as { id: string; state: string };

test.beforeAll(async ({ browser }, info) => {
  const use = info.project.use as object;
  ownerCtx = await browser.newContext(use);
  memberCtx = await browser.newContext(use);
  guestCtx = await browser.newContext(use);
  op = await ownerCtx.newPage();
  mp = await memberCtx.newPage();
  gp = await guestCtx.newPage();
});

test.afterAll(async () => {
  await Promise.all([ownerCtx?.close(), memberCtx?.close(), guestCtx?.close()]);
});

test('1. register, verify the email, and sign in', async () => {
  const info = test.info();
  ownerEmail = await owner(op, info, 'exit-owner', 'Ola Owner');
  await expectAccessible(op, 'onboarding');
  // The account exists once, verified, with a hashed password only.
  const acct = await admin(
    `SELECT a.email_verified_at IS NOT NULL AS verified, c.algorithm
       FROM identity.account a JOIN identity.credential c ON c.account_id = a.id
      WHERE lower(a.primary_email) = lower($1)`,
    [ownerEmail],
  );
  expect(acct.rows).toEqual([{ verified: true, algorithm: 'argon2id' }]);
});

test('2. create a workspace', async () => {
  ws = await createWorkspace(op, 'Exit Co');
  wsId = (await admin(`SELECT id FROM tenancy.workspace WHERE public_id = $1`, [ws])).rows[0].id;
  // Deep links (how most pages load) and API responses carry the security headers.
  const page = await op.request.get(`/workspaces/${ws}/home?scope=all`);
  const apiRes = await op.request.get(`/v1/workspaces/${ws}/context`);
  for (const [what, h] of [
    ['deep link', page.headers()],
    ['API', apiRes.headers()],
  ] as const) {
    expect(h['x-content-type-options'], what).toBe('nosniff');
    expect(h['referrer-policy'], what).toBe('no-referrer');
    expect(h['x-frame-options'], what).toBe('DENY');
  }
  expect(page.headers()['content-security-policy']).toContain("default-src 'self'");
  expect(page.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  // No identifiers beyond public IDs, and no session material, in the page URL.
  expect(op.url()).not.toMatch(/token=|[0-9a-f]{8}-[0-9a-f]{4}-7/);
  await expectAccessible(op, 'first brand');
});

test('3. three brands (one sensitive) with archive and restore', async () => {
  await createBrand(op, 'Harbor');
  await expect(heading(op)).toHaveText('Exit Co');
  for (const name of ['Summit', 'Ledger']) {
    await op.goto(`/workspaces/${ws}/brands/new`);
    await createBrand(op, name, 'Star');
  }
  // The home list follows the scope; All shows every brand.
  await op.goto(`/workspaces/${ws}/home?scope=all`);
  const active = op.getByRole('region', { name: /Active brands/ });
  await expect(active.getByRole('listitem')).toHaveCount(3);
  // Ledger becomes sensitive: consequences first, then step-up.
  await active.getByRole('link', { name: 'Settings for Ledger' }).click();
  await expect(heading(op)).toHaveText('Ledger settings');
  await op.getByRole('button', { name: 'Mark as sensitive…' }).click();
  await op
    .getByRole('alertdialog', { name: 'Mark Ledger as sensitive?' })
    .getByRole('button', { name: 'Mark as sensitive' })
    .click();
  await confirmStepUp(op);
  await expect(op.getByText('Ledger is now sensitive.')).toBeAttached();
  // Summit: favorite, archive, restore. The favorite follows the brand's state.
  await op.goto(`/workspaces/${ws}/home?scope=all`);
  await op.getByRole('link', { name: 'Settings for Summit' }).click();
  await op.getByRole('button', { name: 'Add to favorites' }).click();
  await expect(op.getByRole('button', { name: 'In favorites' })).toBeVisible();
  await op.getByRole('button', { name: 'Archive brand…' }).click();
  await op
    .getByRole('alertdialog', { name: 'Archive Summit?' })
    .getByRole('button', { name: 'Archive brand' })
    .click();
  await expect(op.getByText('This brand is archived')).toBeVisible();
  await expectAccessible(op, 'archived brand');
  await op.goto(`/workspaces/${ws}/home?scope=all`);
  await expect(
    op.getByRole('region', { name: /Archived brands/ }).getByRole('listitem'),
  ).toHaveCount(1);
  await op.getByRole('button', { name: 'Restore Summit' }).click();
  await expect(op.getByText('Summit was restored.')).toBeAttached();
  await expect(op.getByRole('region', { name: /Active brands/ }).getByRole('listitem')).toHaveCount(
    3,
  );
  const states = await admin(
    `SELECT name, lifecycle_state::text AS state, is_sensitive AS sensitive FROM tenancy.brand
      WHERE workspace_id = $1 ORDER BY name`,
    [wsId],
  );
  expect(states.rows).toEqual([
    { name: 'Harbor', state: 'active', sensitive: false },
    { name: 'Ledger', state: 'active', sensitive: true },
    { name: 'Summit', state: 'active', sensitive: false },
  ]);
  await expectAccessible(op, 'workspace home after restore');
});

test('4. scope: one brand, several brands, and All survive reload and Back/Forward', async () => {
  await op.goto(`/workspaces/${ws}/home`);
  await chooseScope(op, 'Harbor');
  await expect(op).toHaveURL(/scope=brand(%3A|:)br_/);
  const single = op.url();
  await chooseScope(op, 'All brands');
  await expect(op).toHaveURL(/scope=all/);
  await expect(op.getByRole('region', { name: /Active brands/ }).getByRole('listitem')).toHaveCount(
    3,
  );
  await scopeButton(op).click();
  await op.getByRole('button', { name: 'Select multiple…' }).click();
  const list = op.getByRole('listbox', { name: 'Choose brands' });
  // From All, every brand starts selected; leaving out Ledger keeps Harbor and Summit.
  await list.getByRole('option', { name: 'Ledger' }).click();
  await op.getByRole('button', { name: /^Apply/ }).click();
  await expect(scopeButton(op)).toHaveAccessibleName(/Brand scope: 2 brands/);
  await expect(op).toHaveURL(/scope=brands(%3A|:)br_/);
  await op.reload();
  await expect(scopeButton(op)).toHaveAccessibleName(/Brand scope: 2 brands/);
  await op.goBack();
  await expect(scopeButton(op)).toHaveAccessibleName(/Brand scope: All brands/);
  await op.goBack();
  expect(op.url()).toBe(single);
  await expect(scopeButton(op)).toHaveAccessibleName(/Brand scope: Harbor/);
  await op.goForward();
  await op.goForward();
  await expect(scopeButton(op)).toHaveAccessibleName(/Brand scope: 2 brands/);
  await op.goto(`/workspaces/${ws}/home?scope=all`);
  await expect(scopeButton(op)).toHaveAccessibleName(/Brand scope: All brands/);
  expect(await noHorizontalOverflow(op)).toBeLessThanOrEqual(0);
  await expectAccessible(op, 'scope switching');
});

test('5. invite an internal member through the real invitation flow', async () => {
  const info = test.info();
  memberEmail = uniqueEmail('exit-member', info);
  await op.goto(`/workspaces/${ws}/people/invite`);
  await expect(heading(op)).toHaveText('Invite people');
  await op.getByLabel(/^Email/).fill(memberEmail);
  await op.getByLabel('Role').selectOption({ label: 'Member' });
  await op.getByRole('button', { name: 'Send invitation' }).click();
  await expect(heading(op)).toHaveText('People');
  await expect(op.getByRole('region', { name: 'Invitations' })).toContainText(memberEmail);
  await expectAccessible(op, 'people with a pending invitation');
});

test('6. invite a guest with exactly one shared record and nothing else', async () => {
  const info = test.info();
  // The one fixture: a test-only record type and one record in Harbor (no product record type
  // exists before Phase 2; core.record_type rejects application writes).
  await admin(
    `INSERT INTO core.record_type (record_type, public_id_prefix, owner_module, test_only)
     VALUES ('foundation_fixture', 'fxt', 'fixture', true) ON CONFLICT DO NOTHING`,
  );
  // Two records (Harbor, Summit) are offered to the owner; exactly one is shared.
  const harbor = await brandId('Harbor');
  const summit = await brandId('Summit');
  const rows = await admin(
    `INSERT INTO core.record (id, public_id, record_type, workspace_id, brand_id, source_kind, created_by_actor_type)
     SELECT uuidv7(), 'fxt_' || upper(substr(md5(random()::text), 1, 26)), 'foundation_fixture', $1, b, 'system', 'system'
       FROM unnest($2::uuid[]) AS b
     RETURNING public_id, brand_id`,
    [wsId, [harbor, summit]],
  );
  fixtureRecord = rows.rows.find((r) => r.brand_id === harbor)!.public_id as string;

  guestEmail = uniqueEmail('exit-guest', info);
  await op.goto(`/workspaces/${ws}/people/invite`);
  await op.getByLabel(/^Email/).fill(guestEmail);
  await op.getByRole('radio', { name: /A guest who sees only specific items/ }).check();
  const shared = op.locator('#invite-records');
  await expect(shared.getByRole('checkbox')).toHaveCount(2);
  await shared.getByRole('checkbox', { name: new RegExp(fixtureRecord.slice(-6)) }).check();
  await op.getByRole('button', { name: 'Send invitation' }).click();
  await expect(heading(op)).toHaveText('People');
  await expect(op.getByRole('region', { name: 'Invitations' })).toContainText(guestEmail);
});

test('7. both accept; what the review previews is exactly what is enforced', async () => {
  await acceptInvitation(mp, memberEmail, 'Milo Member');
  await acceptInvitation(gp, guestEmail, 'Gia Guest');
  // A member with no grants sees no brand; the sensitive brand is never implied.
  await mp.goto(`/workspaces/${ws}/home`);
  await expect(heading(mp)).toHaveText('Exit Co');
  await expect(mp.getByRole('region', { name: /Active brands/ }).getByRole('listitem')).toHaveCount(
    0,
  );
  expect((await (await mp.request.get(`/v1/workspaces/${ws}/brands`)).json()).data).toEqual([]);
  // Owner previews giving Harbor; the preview names Harbor and nothing else.
  await op.goto(`/workspaces/${ws}/home?scope=all`);
  await op.getByRole('link', { name: 'Settings for Harbor' }).click();
  const access = op.getByRole('region', { name: 'Who has access' });
  await access.getByLabel('Give access to').selectOption({ label: 'Milo Member' });
  await access.getByLabel('Access level').selectOption('view');
  await access.getByRole('button', { name: 'Review access…' }).click();
  const review = op.getByRole('dialog', { name: 'Give brand access?' });
  await expect(review).toContainText('Harbor');
  await expect(review).not.toContainText('Ledger');
  await expect(review).not.toContainText('Summit');
  await expectAccessible(op, 'access review');
  await review.getByRole('button', { name: 'Give access' }).click();
  await expect(op.getByText('Access given.')).toBeAttached();
  // Enforcement on the member's next request equals the preview: Harbor only.
  await mp.goto(`/workspaces/${ws}/home?scope=all`);
  const brands = mp.getByRole('region', { name: /Active brands/ }).getByRole('listitem');
  await expect(brands).toHaveCount(1);
  await expect(brands).toContainText('Harbor');
  await mp.goto(`/workspaces/${ws}/home?scope=brand:${'br_01J0000000000000000000000Z'}`);
  await expect(mp.getByText("Some brands in that link aren't available to you")).toBeVisible();
  // The member favorites Harbor (removed again when access ends, step 8).
  await mp.goto(`/workspaces/${ws}/home?scope=all`);
  await mp
    .getByRole('link', { name: /Harbor/ })
    .first()
    .click();
  await mp.getByRole('button', { name: 'Add to favorites' }).click();
  await expect(mp.getByRole('button', { name: 'In favorites' })).toBeVisible();
  await expectAccessible(mp, 'member brand page');
  // The guest sees exactly the one shared record: no brands, people, or directory.
  await gp.goto(`/workspaces/${ws}/shared`);
  await expect(heading(gp)).toHaveText('Shared with me');
  const items = gp.getByRole('main').getByRole('listitem');
  await expect(items).toHaveCount(1);
  await expect(items).toContainText('foundation fixture');
  await expect(items).toContainText('Harbor');
  await expectAccessible(gp, 'guest shared items');
  for (const path of ['people', 'teams', 'settings', `brands/new`]) {
    await gp.goto(`/workspaces/${ws}/${path}`);
    await expect(heading(gp)).toHaveText(unavailable);
  }
  const guestApi = await gp.request.get(`/v1/workspaces/${ws}/brands`);
  expect((await guestApi.json()).data).toEqual([]);
  expect((await gp.request.get(`/v1/workspaces/${ws}/people`)).status()).toBe(404);
  const guestShared = (await (await gp.request.get(`/v1/workspaces/${ws}/shared`)).json()).data;
  expect(guestShared.map((r: { id: string }) => r.id)).toEqual([fixtureRecord]);
});

test('8. revoke, suspend, and remove take effect on the next check everywhere', async () => {
  const info = test.info();
  // Revoke: a pending invitation's link stops working.
  const thirdEmail = uniqueEmail('exit-revoked', info);
  await op.goto(`/workspaces/${ws}/people/invite`);
  await op.getByLabel(/^Email/).fill(thirdEmail);
  await op.getByRole('button', { name: 'Send invitation' }).click();
  await expect(heading(op)).toHaveText('People');
  const invites = op.getByRole('region', { name: 'Invitations' });
  await invites.getByRole('button', { name: `Revoke invitation to ${thirdEmail}` }).click();
  await expect(op.getByText(`Invitation to ${thirdEmail} revoked.`)).toBeAttached();
  // The recipient follows the link, creates an account, and finds the invitation unavailable.
  const revokedCtx = await gp
    .context()
    .browser()!
    .newContext(info.project.use as object);
  const rp = await revokedCtx.newPage();
  await openLink(rp, linkPath(await waitForMail(thirdEmail, 'invited')));
  await expect(heading(rp)).toHaveText("You've been invited");
  await register(rp, thirdEmail, 'Rae Revoked');
  await verify(rp, thirdEmail);
  await signedIn(rp, thirdEmail);
  await expect(heading(rp)).toHaveText('Join a workspace');
  await expect(rp.getByText("This invitation isn't available")).toBeVisible();
  await expect(rp.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0);
  await revokedCtx.close();

  // Revoke brand access: the member's next request loses Harbor, including their favorite
  // (cached navigation re-authorizes and omits it) and the brand page itself.
  await mp.goto(`/workspaces/${ws}/favorites`);
  await expect(mp.getByRole('main').getByRole('listitem')).toHaveCount(1);
  await op.goto(`/workspaces/${ws}/home?scope=all`);
  await op.getByRole('link', { name: 'Settings for Harbor' }).click();
  await op
    .getByRole('region', { name: 'Who has access' })
    .getByRole('button', { name: 'Remove access for Milo Member' })
    .click();
  await op
    .getByRole('alertdialog', { name: 'Remove brand access?' })
    .getByRole('button', { name: 'Remove access' })
    .click();
  await expect(op.getByText('Access removed.')).toBeAttached();
  await mp.reload();
  await expect(heading(mp)).toHaveText('Favorites');
  await expect(mp.getByRole('main').getByRole('listitem')).toHaveCount(0);
  await mp.goBack();
  await expect(heading(mp)).toHaveText(unavailable);
  const memberId = (await membershipOf(memberEmail)).id;
  expect(
    (
      await admin(`SELECT count(*)::int AS n FROM views.favorite WHERE owner_membership_id = $1`, [
        memberId,
      ])
    ).rows[0].n,
  ).toBe(0);

  // Suspend the guest: their next request (same session, same pooled server connections) fails.
  await op.goto(`/workspaces/${ws}/people?kind=guest`);
  await op.getByRole('link', { name: 'Access and actions for Gia Guest' }).click();
  await op.getByRole('button', { name: 'Suspend…' }).click();
  await op
    .getByRole('alertdialog', { name: 'Suspend Gia Guest?' })
    .getByRole('button', { name: 'Suspend' })
    .click();
  await confirmStepUp(op);
  await expect(op.getByText('Gia Guest was suspended.', { exact: false })).toBeAttached();
  await gp.reload();
  await expect(heading(gp)).toHaveText(unavailable);
  expect((await gp.request.get(`/v1/workspaces/${ws}/shared`)).status()).toBe(404);
  expect((await membershipOf(guestEmail)).state).toBe('suspended');

  // Remove the member: sessions end, the next UI and API request is signed out, cached pages
  // re-check, and personal lists are erased.
  await op.goto(`/workspaces/${ws}/people`);
  await op.getByRole('link', { name: 'Access and actions for Milo Member' }).click();
  await op.getByRole('button', { name: 'Remove from workspace…' }).click();
  await op
    .getByRole('alertdialog', { name: 'Remove Milo Member?' })
    .getByRole('button', { name: 'Continue' })
    .click();
  await op
    .getByRole('alertdialog', { name: 'Confirm removing Milo Member' })
    .getByRole('button', { name: 'Remove from workspace' })
    .click();
  await confirmStepUp(op);
  await expect(heading(op)).toHaveText('People');
  expect((await mp.request.get(`/v1/workspaces/${ws}/context`)).status()).toBe(401);
  // Back to a page loaded before the removal: the tab learns the session ended and signs out.
  await mp.goBack();
  await expect(heading(mp)).toHaveText('Sign in');
  const after = await admin(
    `SELECT m.state,
            (SELECT count(*)::int FROM identity.session s WHERE s.account_id = m.account_id AND s.revoked_at IS NULL) AS sessions,
            (SELECT count(*)::int FROM views.recent_item r WHERE r.owner_membership_id = m.id) AS recents
       FROM tenancy.membership m WHERE m.id = $1`,
    [memberId],
  );
  expect(after.rows).toEqual([{ state: 'removed', sessions: 0, recents: 0 }]);
});

test('9. last-owner protection, audit trail, and navigation cleanup', async () => {
  // The only owner cannot leave (UI) and cannot be removed or demoted (database).
  await op.goto(`/workspaces/${ws}/settings/access`);
  await expect(
    op.getByText("You're the only owner. Transfer ownership before you can leave."),
  ).toBeVisible();
  await expect(op.getByRole('button', { name: 'Leave workspace…' })).toHaveCount(0);
  const ownerMembership = (await membershipOf(ownerEmail)).id;
  await expect(
    admin(
      `UPDATE tenancy.membership SET state = 'suspended', suspended_at = now(), version = version + 1
        WHERE id = $1`,
      [ownerMembership],
    ),
  ).rejects.toThrow('a workspace must keep at least one active owner');
  await expectAccessible(op, 'sharing and ownership');
  // Every material step of the journey is in the workspace's append-only audit trail.
  const actions = (
    await admin(`SELECT DISTINCT action FROM audit.audit_event WHERE workspace_id = $1`, [wsId])
  ).rows.map((r) => r.action as string);
  for (const a of [
    'workspace.created',
    'brand.created',
    'brand.sensitivity_changed',
    'record.archived',
    'invitation.created',
    'invitation.accepted',
    'invitation.revoked',
    'role_assignment.granted',
    'role_assignment.revoked',
    'membership.suspended',
    'membership.removed',
  ])
    expect(actions, a).toContain(a);
  await expect(
    admin(`UPDATE audit.audit_event SET action = 'x' WHERE workspace_id = $1`, [wsId]),
  ).rejects.toThrow();
  // Navigation cleanup: the owner's lists keep Summit (restored) and nothing removed people own.
  await op.goto(`/workspaces/${ws}/favorites`);
  await expect(op.getByRole('main').getByRole('listitem')).toHaveText([/Summit/]);
  const leftovers = await admin(
    `SELECT count(*)::int AS n FROM views.favorite f JOIN tenancy.membership m ON m.id = f.owner_membership_id
      WHERE f.workspace_id = $1 AND m.state = 'removed'`,
    [wsId],
  );
  expect(leftovers.rows[0].n).toBe(0);
});

test('10. sign out: per-tab state and drafts go, device and appearance stay', async () => {
  // Per-device view state is written for this browser (recent list filter), per-tab state too.
  await op.goto(`/workspaces/${ws}/recent`);
  await expect(heading(op)).toHaveText('Recently viewed');
  const saved = op.waitForResponse(
    (r) => r.url().includes('/view-state/recent.list') && r.request().method() === 'PUT' && r.ok(),
  );
  await op.getByLabel('Type').selectOption('team');
  await saved;
  await op.evaluate("localStorage.setItem('pm.draft.exit.journey', '{}')");
  const before = await op.evaluate<{
    device: string | null;
    appearance: string | null;
    vs: number;
    draft: string | null;
  }>(
    `({ device: localStorage.getItem('pm.device'),
        appearance: localStorage.getItem('pm.appearance'),
        vs: Object.keys(sessionStorage).filter((k) => k.startsWith('pm.vs.')).length,
        draft: localStorage.getItem('pm.draft.exit.journey') })`,
  );
  expect(before.device).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(before.vs).toBeGreaterThan(0);
  expect(before.appearance).not.toBeNull();
  await signOut(op);
  const after = await op.evaluate<{
    device: string | null;
    appearance: string | null;
    vs: number;
    draft: string | null;
  }>(
    `({ device: localStorage.getItem('pm.device'),
        appearance: localStorage.getItem('pm.appearance'),
        vs: Object.keys(sessionStorage).filter((k) => k.startsWith('pm.vs.')).length,
        draft: localStorage.getItem('pm.draft.exit.journey') })`,
  );
  expect(after).toEqual({
    device: before.device,
    appearance: before.appearance,
    vs: 0,
    draft: null,
  });
  // The server session is gone: the next API call is unauthenticated.
  expect((await op.request.get(`/v1/workspaces/${ws}/context`)).status()).toBe(401);
  await expectAccessible(op, 'signed out');
  // Signing in again on this device restores the device-stored view state.
  await signIn(op, ownerEmail);
  await expect(heading(op)).not.toHaveText(/Sign in|Loading/);
  await op.goto(`/workspaces/${ws}/recent`);
  await expect(op).toHaveURL(/type=team/);
  await expect(op.getByLabel('Type')).toHaveValue('team');
});
