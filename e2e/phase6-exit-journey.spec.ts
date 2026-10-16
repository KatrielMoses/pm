import { expect, test, type Locator, type Page } from '@playwright/test';
import { fixtureClient } from '@pm/test-support';
import { accessible, api, h1, person, seed } from './goals-support.ts';
import { tabTo } from './live-support.ts';
import { noHorizontalOverflow, PASSWORD } from './support.ts';

/**
 * Phase 6 exit journey (P6-IR1): a founder connects Google Calendar through the real OAuth
 * redirect, chooses and maps calendars, synchronizes, plans with the events in Today and the
 * calendar view, puts a block on the calendar, has it moved at the provider, settles a conflict,
 * then manages API tokens, webhooks, MCP consent, and a CSV import before disconnecting. A member
 * never sees any of it. Real web, API, and worker processes and PostgreSQL run throughout; only the
 * provider is a deterministic contract fixture (Google OAuth + Calendar v3 over HTTP), namespaced
 * to this test's workspace. Nothing about the application's authorization or answers is stubbed.
 * Every async step waits for an explicit settled state (aria-busy, a status message, or data).
 */

test.use({ timezoneId: 'UTC' });

const GCAL_URL = process.env.PM_E2E_GCAL_URL!;
const GCAL_TOKEN = process.env.PM_E2E_GCAL_TOKEN!;
const FOUNDER_CAL = 'founder@calendar.test';

const card = (page: Page) => page.locator('section.calendar-connection').first();
const settled = async (section: Locator) => expect(section).toHaveAttribute('aria-busy', 'false');
const json = async (page: Page, path: string) => (await (await page.request.get(path)).json()).data;

/** Confirms a step-up when the action asks for one; otherwise waits for the action's own result. */
async function confirmIfAsked(page: Page, result: Locator) {
  const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(stepUp.or(result).first()).toBeVisible();
  if (await stepUp.isVisible()) {
    await stepUp.getByLabel(/^Password/).fill(PASSWORD);
    await stepUp.getByRole('button', { name: 'Confirm' }).click();
    await expect(stepUp).toBeHidden();
  }
  await expect(result).toBeVisible();
}

async function connectGoogle(page: Page, ws: string, name: string, twoWay: boolean) {
  await page.goto(`/workspaces/${ws}/settings/integrations`);
  const google = page.getByRole('region', { name: 'Google Calendar', exact: true });
  await settled(google);
  await google.getByLabel('Connection name').fill(name);
  if (twoWay) await google.getByLabel('Allow moving events (two-way)').check();
  await google.getByRole('button', { name: 'Connect Google Calendar' }).click();
  // The browser leaves for the provider's consent page and comes back through the callback.
  await expect(
    page.getByText('Google Calendar is connected. Choose the calendars to include.'),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/calendar=/);
  await settled(card(page));
}

async function syncNow(page: Page) {
  const c = card(page);
  await settled(c);
  await c.getByRole('button', { name: /^Sync now/ }).click();
  await settled(c);
  await expect(c.getByRole('status')).toContainText(/Synchronized|did not finish/);
}

test('AT-328 Phase 6 exit journey', async ({ page, browser }, info) => {
  test.setTimeout(420_000);
  const s = await seed(page, info, 'p6exit');
  const gcal = fixtureClient(GCAL_URL, GCAL_TOKEN, s.ws);
  await gcal('setCalendars', [
    { id: FOUNDER_CAL, summary: 'Founder', timeZone: 'UTC', accessRole: 'owner', primary: true },
    { id: 'team@calendar.test', summary: 'Team', timeZone: 'Europe/Lisbon', accessRole: 'reader' },
  ]);
  const today = (await json(page, `${s.base}/today/today`)).day as string;
  await gcal('putEvent', FOUNDER_CAL, {
    id: 'investor',
    summary: 'Investor call',
    start: { dateTime: `${today}T14:00:00Z` },
    end: { dateTime: `${today}T15:00:00Z` },
  });
  await gcal('putEvent', 'team@calendar.test', {
    id: 'standup',
    summary: 'Team standup',
    start: { dateTime: `${today}T09:00:00Z` },
    end: { dateTime: `${today}T09:15:00Z` },
  });

  // Connect, choose calendars, map a brand, and synchronize.
  await connectGoogle(page, s.ws, 'Founder calendar', true);
  const c = card(page);
  await expect(c).toContainText('Live');
  await expect(c).toContainText('Read and move events');
  await accessible(page, 'calendar connected');
  await c.getByLabel('Direction for Founder').selectOption({ label: 'Two-way' });
  await c.getByLabel('Brand for Founder').selectOption({ label: 'Harbor' });
  await c.getByLabel('Include Team').check();
  await expect(
    c.getByLabel('Direction for Team').locator('option', { hasText: 'Two-way' }),
  ).toBeDisabled();
  await c.getByRole('button', { name: 'Save calendars' }).click();
  await settled(c);
  await expect(c.getByRole('status')).toHaveText('Calendars saved.');
  // Keyboard only: reach Sync now with Tab from the top of the page and start it with Enter.
  await page.locator('body').focus();
  await tabTo(page, "!!el && /^Sync now/.test((el.textContent || '').trim())");
  await page.keyboard.press('Enter');
  await settled(c);
  await expect(c.getByRole('status')).toContainText('Synchronized:');
  await expect(c.getByRole('heading', { name: 'Recent synchronization' })).toBeVisible();

  // Today and the calendar view show the founder's own events.
  await page.goto(`/workspaces/${s.ws}/today`);
  await expect(h1(page)).toHaveText('Today');
  const events = page.getByRole('list', { name: 'Calendar events this day' });
  await expect(events).toContainText('Investor call');
  await expect(events).toContainText('Team standup');
  await accessible(page, 'today with meetings');
  await page.goto(`/workspaces/${s.ws}/calendar`);
  await expect(page.getByLabel('External calendar events')).toBeChecked();
  await expect(
    page.locator('.calendar-event.kind-external').filter({ hasText: 'Investor call' }).first(),
  ).toBeAttached();
  await accessible(page, 'calendar view with events');

  // A block on a task with a due date goes onto the two-way calendar.
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  const task = await api(page, 'POST', `${s.base}/tasks`, {
    brand: s.harbor,
    title: 'Write launch notes',
    due_date: today,
    deadline: { date: tomorrow },
  });
  const block = await api(page, 'POST', `${s.base}/work-blocks`, {
    task: task.id,
    starts_at: `${today}T16:00:00Z`,
    ends_at: `${today}T17:00:00Z`,
    tz: 'UTC',
  });
  await page.goto(`/workspaces/${s.ws}/today`);
  await page.getByLabel(/^Calendar for block at/).selectOption({ label: 'Founder' });
  await page.getByRole('button', { name: /^Add to calendar block at/ }).click();
  await expect(page.getByText(/^Block at .+ added to Founder\.$/)).toBeVisible();
  await expect(page.getByText('On Founder')).toBeVisible();
  const providerEvents = (await gcal('listEvents', FOUNDER_CAL)) as Array<{
    id: string;
    summary?: string;
  }>;
  const published = providerEvents.find((e) => e.summary === 'Write launch notes')!;
  expect(published).toBeTruthy();

  // The provider moves the event: the block follows; the task's dates do not (CAL-012/013).
  await gcal('putEvent', FOUNDER_CAL, {
    ...published,
    start: { dateTime: `${today}T18:00:00.000Z`, timeZone: 'UTC' },
    end: { dateTime: `${today}T19:00:00.000Z`, timeZone: 'UTC' },
  });
  await page.goto(`/workspaces/${s.ws}/settings/integrations`);
  await syncNow(page);
  const moved = (
    await page.request.get(`${s.base}/work-blocks?from=${today}&to=${today}`).then((r) => r.json())
  ).data.find((b: { id: string }) => b.id === block.id);
  expect([moved.starts_at, moved.ends_at]).toEqual([
    `${today}T18:00:00.000Z`,
    `${today}T19:00:00.000Z`,
  ]);
  const after = await json(page, `${s.base}/tasks/${task.id}`);
  expect(after.due_date).toBe(today);
  expect(JSON.stringify(after.deadline)).toContain(tomorrow);

  // Both sides change: a visible conflict, settled with the calendar's time.
  await api(
    page,
    'PATCH',
    `${s.base}/work-blocks/${block.id}`,
    { starts_at: `${today}T20:00:00Z`, ends_at: `${today}T21:00:00Z` },
    moved.version,
  );
  const remote = ((await gcal('listEvents', FOUNDER_CAL)) as Array<{ id: string }>).find(
    (e) => e.id === published.id,
  )!;
  await gcal('putEvent', FOUNDER_CAL, {
    ...remote,
    start: { dateTime: `${today}T07:00:00.000Z`, timeZone: 'UTC' },
    end: { dateTime: `${today}T08:00:00.000Z`, timeZone: 'UTC' },
  });
  await syncNow(page);
  const conflict = c.locator('[data-conflict]').first();
  await expect(conflict).toContainText('Calendar time:');
  await expect(conflict).toContainText('Your block:');
  await accessible(page, 'calendar conflict');
  await conflict.getByRole('button', { name: /^Use the calendar's time for/ }).focus();
  await page.keyboard.press('Enter');
  await settled(c);
  await expect(c.getByRole('status')).toContainText("Moved your block to the calendar's time");
  const resolved = (
    await page.request.get(`${s.base}/work-blocks?from=${today}&to=${today}`).then((r) => r.json())
  ).data.find((b: { id: string }) => b.id === block.id);
  expect(resolved.starts_at).toBe(`${today}T07:00:00.000Z`);
  await expect(c.getByText('No conflicts.')).toBeVisible();

  // API tokens: shown once, then revoked.
  await page.goto(`/workspaces/${s.ws}/settings/api`);
  await expect(h1(page)).toHaveText('API and webhooks');
  await page.getByLabel('Name', { exact: true }).fill('Exit token');
  await page.getByRole('button', { name: 'Create token' }).click();
  await confirmIfAsked(page, page.getByTestId('new-token'));
  await expect(page.getByTestId('new-token')).toHaveText(/^pm_/);
  await page.getByRole('button', { name: 'I have copied it' }).click();
  await expect(page.getByTestId('new-token')).toHaveCount(0);
  const tokens = page.getByRole('list', { name: 'API tokens' });
  await expect(tokens).toContainText('Exit token');
  await page.getByRole('button', { name: /^Revoke Exit token/ }).click();
  await confirmIfAsked(page, page.getByText('Exit token revoked. It no longer works.'));
  // Webhooks: an endpoint whose secret is shown once, a test event, and its delivery history.
  const hooks = page.getByRole('region', { name: 'Webhooks' });
  await settled(hooks);
  await hooks.getByLabel('HTTPS endpoint URL').fill('https://127.0.0.1/pm-hooks');
  await hooks.getByRole('checkbox', { name: 'task.created' }).check();
  await hooks.getByRole('button', { name: 'Add endpoint' }).click();
  await confirmIfAsked(page, page.getByTestId('webhook-secret'));
  await expect(page.getByTestId('webhook-secret')).toHaveText(/\S{16,}/);
  await hooks.getByRole('button', { name: /^Send test event to/ }).click();
  await settled(hooks);
  await expect(page.getByText('Test event queued. Its delivery appears below.')).toBeVisible();
  await hooks.getByRole('button', { name: /^Show deliveries for/ }).click();
  await settled(hooks);
  await expect(hooks.locator('[data-delivery]').first()).toBeVisible();
  await accessible(page, 'api and webhooks');

  // MCP: register a client, consent, use it, then revoke consent and lose access at once.
  await page.goto(`/workspaces/${s.ws}/settings/integrations`);
  const mcp = page.getByRole('region', { name: 'MCP access' });
  await mcp.getByLabel('Client name').fill('Desk agent');
  await mcp.getByLabel('HTTPS redirect URI').fill('https://agent.example.test/callback');
  await mcp.getByRole('button', { name: 'Register client' }).click();
  await expect(mcp.getByRole('heading', { name: 'Client secret · shown once' })).toBeVisible();
  await mcp.getByRole('checkbox', { name: 'records:read' }).check();
  await mcp.getByRole('button', { name: 'Grant selected scopes' }).click();
  await expect(mcp.getByText('Consent: active')).toBeVisible();
  await mcp.getByRole('button', { name: 'Generate access token' }).click();
  const issued = mcp.getByRole('status').filter({ hasText: 'Access token · copy now' });
  await expect(issued).toBeVisible();
  const accessToken = (await issued.locator('output').textContent())!.trim();
  const call = () =>
    page.request.post(`${s.base}/mcp`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
  expect((await call()).status()).toBe(200);
  await mcp.getByRole('button', { name: 'Revoke my consent' }).click();
  await expect(mcp.getByText('Consent: revoked')).toBeVisible();
  expect((await call()).status()).toBeGreaterThanOrEqual(400);

  // CSV: preview, import, export, and roll back through the portability panel.
  await page.getByLabel('Record type', { exact: true }).selectOption('project');
  await page.getByLabel(/Column mapping/).fill('{"Summary":"name"}');
  await page.getByLabel(/CSV file/).setInputFiles({
    name: 'projects.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`schema_version,Summary,brand_id\n1,Imported launch,${s.harbor}\n`),
  });
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByText('1 valid rows; 0 rows need attention.')).toBeVisible();
  await page.getByRole('button', { name: 'Apply import', exact: true }).click();
  await expect(page.getByLabel('Import row results')).toContainText('Row 2: Imported');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('workspace-projects.csv');
  await page.getByRole('button', { name: 'Roll back this import', exact: true }).click();
  await expect(
    page.getByText('The import was rolled back where records remained unchanged.', { exact: true }),
  ).toBeVisible();

  // Loss of access: a member sees none of the founder's calendar, tokens, or conflicts.
  const lee = await person(browser, page, s.ws, info, 'p6exit-lee', 'Lee Member', 'Member');
  const p = lee.page;
  const conn = (await json(page, `${s.base}/integrations/connections`)).connections.find(
    (x: { provider: string }) => x.provider === 'google_calendar',
  ).id as string;
  expect(
    (await p.request.get(`${s.base}/integrations/connections/${conn}/calendars`)).status(),
  ).toBe(404);
  expect(
    (
      await p.request.get(
        `${s.base}/integrations/connections/conn_00000000000000000000000000/calendars`,
      )
    ).status(),
  ).toBe(404);
  const leeEvents = await json(
    p,
    `${s.base}/calendar-events?from=${today}T00:00:00.000Z&to=${tomorrow}T00:00:00.000Z`,
  );
  expect(leeEvents).toMatchObject({ events: [], connected: false });
  await p.goto(`/workspaces/${s.ws}/today`);
  await expect(p.getByText('No calendar connected.')).toBeVisible();
  await expect(p.getByText('Investor call')).toHaveCount(0);
  await accessible(p, 'member today');
  await lee.ctx.close();

  // Layout and appearance on the calendar settings: 320 px, 200% zoom, forced colours, reduced motion.
  const size = page.viewportSize()!;
  for (const width of [320, Math.max(320, Math.floor(size.width / 2))]) {
    await page.setViewportSize({ width, height: size.height });
    await page.goto(`/workspaces/${s.ws}/settings/integrations`);
    await settled(card(page));
    expect(await noHorizontalOverflow(page), `integrations at ${width}px`).toBeLessThanOrEqual(0);
    await page.goto(`/workspaces/${s.ws}/today`);
    await expect(h1(page)).toHaveText('Today');
    expect(await noHorizontalOverflow(page), `today at ${width}px`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize(size);
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await page.goto(`/workspaces/${s.ws}/settings/integrations`);
  await settled(card(page));
  await accessible(page, 'integrations, forced colours');
  await page.emulateMedia({ forcedColors: null, reducedMotion: null });

  // Offline: the sync is refused honestly, then works again once back online.
  await page.context().setOffline(true);
  await card(page)
    .getByRole('button', { name: /^Sync now/ })
    .click();
  await settled(card(page));
  await expect(card(page).getByRole('alert')).toBeVisible();
  await page.context().setOffline(false);
  await syncNow(page);

  // Disconnect and remove: the founder's mirrored events leave Today.
  const last = card(page);
  await last.getByLabel('Remove synchronized events').check();
  await last.getByRole('button', { name: /^Disconnect/ }).click();
  await expect(page.getByText(/disconnected\. Synchronized events were removed\./)).toBeVisible();
  await page.goto(`/workspaces/${s.ws}/today`);
  await expect(h1(page)).toHaveText('Today');
  await expect(page.getByText('Investor call')).toHaveCount(0);
});

test('AT-329 provider outage is shown as degraded and recovers (provider-transport failure, fixture-injected)', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  // Only the provider's transport fails here (an injected 503); the application is real.
  const s = await seed(page, info, 'p6outage');
  const gcal = fixtureClient(GCAL_URL, GCAL_TOKEN, s.ws);
  await gcal('setCalendars', [
    { id: FOUNDER_CAL, summary: 'Founder', timeZone: 'UTC', accessRole: 'owner', primary: true },
  ]);
  await connectGoogle(page, s.ws, 'Outage calendar', false);
  await gcal('failNext', 1, 503);
  const c = card(page);
  await c.getByRole('button', { name: /^Sync now/ }).click();
  await settled(c);
  await expect(c.getByRole('status')).toContainText('Synchronization did not finish.');
  await expect(c).toContainText('Degraded');
  await expect(c).toContainText('Google Calendar could not be reached. It will be retried.');
  await accessible(page, 'calendar degraded');
  await syncNow(page);
  await expect(c.getByRole('status')).toContainText('Synchronized:');
  await expect(c).toContainText('Connected');
});
