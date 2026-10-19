import { expect, test, type Page } from '@playwright/test';
import { fixtureClient, queryUrl, syntheticWav } from '@pm/test-support';
import { api, get, giveBrand, h1, person, seed, type Seed } from './goals-support.ts';
import { expectNoOverflow, tabTo } from './live-support.ts';
import { expectAccessible, PASSWORD } from './support.ts';

/**
 * Phase 7 exit journeys (P7-IR1 §2) on desktop, tablet, and mobile, against the real web, API,
 * and worker processes and PostgreSQL. Only the AI provider and the transcription service are the
 * labelled deterministic fixture (and Google Calendar its HTTP contract fixture); no application
 * authorization or business effect is stubbed. Each journey is independent with its own
 * workspaces: an owner, a narrower member, and other workspaces that must see nothing. Key states
 * are checked with keyboard and axe, 320 px and 200% zoom (half width), forced colours with reduced
 * motion, and offline recovery. Device microphones and real speech quality remain manual checks:
 * the synthetic recordings prove the path, not recognition.
 */

test.use({ timezoneId: 'UTC' });

const GCAL_URL = process.env.PM_E2E_GCAL_URL!;
const GCAL_TOKEN = process.env.PM_E2E_GCAL_TOKEN!;
/** Inspection (and schedule time control) past RLS, as the Phase 1 exit journey does. */
const admin = async (sql: string, params: unknown[] = []) =>
  (await queryUrl(process.env.PM_E2E_ADMIN_URL!, sql, params)).rows as Array<Record<string, any>>;

async function confirmStepUp(page: Page): Promise<void> {
  const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(stepUp).toBeVisible();
  await stepUp.getByLabel(/^Password/).fill(PASSWORD);
  await stepUp.getByRole('button', { name: 'Confirm' }).click();
  await expect(stepUp).toBeHidden();
}

async function enableAi(page: Page, ws: string) {
  await page.goto(`/workspaces/${ws}/settings/ai`);
  await page.getByLabel('Turn on AI for this workspace').check();
  await page.getByRole('button', { name: 'Save AI settings' }).click();
  await confirmStepUp(page);
  await expect(page.getByText('AI is available', { exact: true })).toBeVisible();
}

/** A raw request as the signed-in person (status and body), for refusals the UI never sends. */
async function raw(page: Page, method: 'POST' | 'PATCH', path: string, data: unknown) {
  const me = await page.request.get('/v1/auth/me');
  const r = await page.request.fetch(path, {
    method,
    headers: {
      origin: new URL(page.url()).origin,
      'x-csrf-token': me.headers()['x-csrf-token'] ?? '',
      'idempotency-key': `e2e-${crypto.randomUUID()}`,
    },
    data,
  });
  return { status: r.status(), body: (await r.json().catch(() => null)) as Record<string, any> };
}

const data = async (page: Page, path: string) => (await (await get(page, path)).json()).data;
/** A list response's rows (plain arrays or `{ items }` pages). */
const rows = async <T>(page: Page, path: string): Promise<T[]> => {
  const d = await data(page, path);
  return (Array.isArray(d) ? d : d.items) as T[];
};

/** Another workspace for the signed-in person (created through the API, as the app does). */
async function otherWorkspace(page: Page, name: string): Promise<string> {
  const made = await api(page, 'POST', '/v1/workspaces', {
    name,
    timezone: 'UTC',
    locale: 'en-GB',
    currency: 'EUR',
    week_start: 1,
    first_brand: { name: `${name} brand` },
  });
  return (made.workspace?.id ?? made.id) as string;
}

/** 320 px, half width (200% zoom), forced colours with reduced motion, with axe at each. */
async function reflow(page: Page, url: string, heading: string | RegExp, label: string) {
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  for (const width of [320, Math.max(320, Math.floor(size.width / 2))]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(url);
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
    await expectNoOverflow(page, `${label} at ${width}px`);
  }
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await expectAccessible(page, `${label}-narrow-forced`);
  await page.emulateMedia({ forcedColors: null, reducedMotion: null });
  await page.setViewportSize(size);
}

/** The owner's workspace (Harbor shared, Vault private) with AI on, and a narrower member. */
async function team(
  page: Page,
  browser: Parameters<typeof person>[0],
  info: never,
  prefix: string,
) {
  const s = await seed(page, info, prefix);
  await enableAi(page, s.ws);
  const member = await person(browser, page, s.ws, info, `${prefix}-m`, 'Riley Member', 'Member');
  await giveBrand(page, s.ws, 'Harbor', 'Riley Member', 'edit');
  return { s, member };
}

const projectsNamed = async (page: Page, s: Seed, name: string) =>
  (
    (await data(page, `${s.base}/projects?brand=${s.harbor}`)) as Array<{
      id: string;
      name: string;
    }>
  ).filter((p) => p.name === name);

test('AT-534 Phase 7 exit journey: an authorized brief becomes a reviewed, partly selected plan applied once with AI-draft provenance; stale confirmation is refused; a narrower member and other workspaces see none of it', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(240_000);
  const { s, member } = await team(page, browser, info as never, 'p7plan');
  await api(page, 'POST', `${s.base}/brands/${s.harbor}/labels`, { name: 'Launch' });
  const brief = 'Open the Harbor beta to early customers.';
  const plan = `Plan: ${brief}`;

  // 1. Scoped action, sources and optional choices, the exact cost.
  await page.goto(`/workspaces/${s.ws}/ai/assist`);
  await expect(h1(page)).toHaveText('AI assist');
  await page.getByLabel('Action', { exact: true }).selectOption('draft_project.v1');
  await page.getByLabel('Project brief').fill(brief);
  await page.getByLabel('Harbor', { exact: true }).check();
  await page.getByRole('button', { name: 'Preview context' }).click();
  const sources = page.getByRole('list', { name: 'Context sources' });
  await expect(sources).toContainText('Offer label: Launch');
  await expect(sources).toContainText('Offer member: Riley Member');
  // Vault is outside the chosen scope: nothing from it is listed.
  await expect(sources).not.toContainText('Secret');
  // A choice is optional: omitting one refreshes the preview and it is never sent or used.
  await sources.getByLabel(/Offer member: Fay Founder/).uncheck();
  await expect(sources.getByLabel(/Offer member: Fay Founder/)).not.toBeChecked();
  await expect(sources).toContainText(/Fay Founder.*not used \(user excluded\)/);
  await page.getByRole('button', { name: 'Estimate cost' }).click();
  const estimate = page.getByRole('region', { name: 'Estimate' });
  await expect(estimate).toContainText('synthetic price');
  await expect(estimate.getByLabel(/I confirm this/)).toBeVisible();
  await expectAccessible(page, 'assist-estimate');
  // 2. Clarifying the input drops the confirmation in the page...
  await page.getByLabel('Project brief').fill(`${brief} `);
  await expect(estimate).toBeHidden();
  await page.getByLabel('Project brief').fill(brief);
  // ...and the server refuses a confirmation that no longer matches the input.
  const retrieval = { scope: { brands: [s.harbor] }, include: [], offer_choices: true };
  const m = (await raw(page, 'POST', `${s.base}/ai/context-previews`, retrieval)).body.data;
  const body = {
    action: 'draft_project.v1',
    ...retrieval,
    brief,
    manifest_digest: m.digest,
    confirm_cost: true,
  };
  const est = (await raw(page, 'POST', `${s.base}/ai/assist-estimates`, body)).body.data;
  const stale = await raw(page, 'POST', `${s.base}/ai/assist-runs`, {
    ...body,
    brief: `${brief} And partners.`,
    input_digest: est.input_digest,
  });
  expect(stale.status).toBe(409);
  expect(JSON.stringify(stale.body)).toContain('input_changed');

  // 3. Run the labelled fixture; the result is typed and reviewable; nothing exists yet.
  await page.getByRole('button', { name: 'Preview context' }).click();
  await page.getByRole('button', { name: 'Estimate cost' }).click();
  await estimate.getByLabel(/I confirm this/).check();
  await estimate.getByRole('button', { name: /^Run / }).click();
  const review = page.getByRole('link', { name: 'Review the proposed changes' });
  await expect(review).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Synthetic fixture').first()).toBeVisible();
  expect(await projectsNamed(page, s, plan)).toHaveLength(0);
  await review.click();
  await expect(
    page.getByRole('heading', { name: /Project plan: Open the Harbor beta/ }),
  ).toBeVisible();
  await expect(page.getByText(/AI-generated/).first()).toBeVisible();
  const prp = page.url().split('/').pop()!;
  // Every operation is named, with the people and label it would use.
  await expect(page.getByLabel(/c6 · Add acceptance criterion/)).toBeVisible();
  await expect(page.getByLabel(/c7 · Assign task/)).toBeVisible();
  await expect(page.getByText(/Assign to: Riley Member\./)).toBeVisible();
  await expect(page.getByLabel(/c8 · Add label/)).toBeVisible();
  await expect(page.getByText(/Label: Launch\./)).toBeVisible();
  await expectAccessible(page, 'plan-review');

  // 4. Edit a value, leave the label change out (a dependency-complete subset), approve, apply.
  await page.locator('#prp-c2-title').fill('Define the Harbor beta scope');
  await page.getByLabel(/c8 · Add label/).uncheck();
  await expect(page.getByRole('heading', { name: /Changes \(7 of 8 selected\)/ })).toBeVisible();
  await page.getByRole('button', { name: 'Save edits' }).click();
  await expect(page.getByText(/Saved as revision/)).toBeVisible();
  // Keyboard only: reach Approve with Tab from the top of the page and press Enter.
  await page.locator('body').focus();
  await tabTo(page, "!!el && /^Approve 7 change/.test((el.textContent || '').trim())");
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Approved 7 change\(s\)/).first()).toBeVisible();
  expect(await projectsNamed(page, s, plan)).toHaveLength(0);
  await page.getByRole('button', { name: /^Apply 7 of 8 changes$/ }).click();
  await expect(page.getByText(/^Applied 7 change\(s\)$/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Applied by you · proposed by AI/)).toBeVisible();
  expect(await projectsNamed(page, s, plan)).toHaveLength(1);

  // 5. The real records: estimate, criterion, assignment, dependency, AI-draft origin; the
  // unselected label was not applied.
  await page.getByRole('link', { name: 'Define the Harbor beta scope' }).first().click();
  await expect(h1(page)).toHaveText('Define the Harbor beta scope');
  const scopeTask = page.url().split('/').pop()!;
  const t = await data(page, `${s.base}/tasks/${scopeTask}`);
  expect(t.source.kind).toBe('ai_draft');
  expect(t.estimate_minutes).toBe(120);
  await expect(page.getByText('Drafted with AI')).toBeVisible();
  await expect(page.getByText('Riley Member').first()).toBeVisible();
  await expect(page.getByText('Build the first version').first()).toBeVisible();
  await page.getByRole('link', { name: 'Build the first version' }).first().click();
  await expect(h1(page)).toHaveText('Build the first version');
  await expect(page.getByText('The first version is reviewed by the owner.')).toBeVisible();
  const build = await data(page, `${s.base}/tasks/${page.url().split('/').pop()!}`);
  expect(JSON.stringify(build.labels ?? [])).not.toContain('Launch');
  // Applying again is refused; nothing is created twice.
  const again = await raw(page, 'POST', `${s.base}/ai/proposals/${prp}:apply`, {
    revision: 2,
    fingerprint: '0'.repeat(64),
  });
  expect(again.status).toBeGreaterThanOrEqual(400);
  expect(await projectsNamed(page, s, plan)).toHaveLength(1);
  await reflow(page, `/workspaces/${s.ws}/ai/proposals/${prp}`, /Project plan/, 'applied-plan');

  // 6. The narrower member and the other workspaces see none of it.
  await member.page.goto(`/workspaces/${s.ws}/ai/proposals/${prp}`);
  await expect(member.page.getByRole('heading', { name: 'Proposal not found' })).toBeVisible();
  await member.page.goto(`/workspaces/${s.ws}/ai/proposals`);
  await expect(member.page.getByRole('list', { name: 'Your change proposals' })).toHaveCount(0);
  const memberOwn = await otherWorkspace(member.page, 'Riley Co');
  await member.page.goto(`/workspaces/${memberOwn}/ai/proposals/${prp}`);
  await expect(member.page.getByRole('heading', { name: 'Proposal not found' })).toBeVisible();
  const other = await otherWorkspace(page, 'Other Co');
  await page.goto(`/workspaces/${other}/ai/proposals/${prp}`);
  await expect(page.getByRole('heading', { name: 'Proposal not found' })).toBeVisible();
  await member.ctx.close();
});

const wav = (seconds: number, transcript: string, scenario?: string) =>
  Buffer.from(syntheticWav(seconds, { transcript, ...(scenario ? { scenario } : {}) }));

test('AT-535 Phase 7 exit journey: typed and spoken capture are interpreted or transcribed, edited, saved explicitly, and triaged with their provenance; bad audio never completes and no audio is kept', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(240_000);
  const { s, member } = await team(page, browser, info as never, 'p7cap');
  const openCapture = async () => {
    await page.goto(`/workspaces/${s.ws}/today`);
    await page.getByRole('button', { name: 'Capture' }).click();
    const dialog = page.getByRole('dialog', { name: 'Capture' });
    await expect(dialog).toBeVisible();
    return dialog;
  };
  const dialog = await openCapture();
  const box = dialog.getByLabel('What do you want to capture?');
  const typed = 'Book the Harbor venue tomorrow high priority #fixture:ok';
  await box.fill(typed);
  await dialog.getByRole('button', { name: 'Interpret with AI' }).click();
  await expect(dialog.getByText(/could cost up to/)).toBeVisible();
  await expect(dialog.getByText(/synthetic test model/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirm and interpret' }).click();
  const interp = dialog.getByRole('region', { name: 'Interpretation' });
  await expect(interp).toBeVisible({ timeout: 30_000 });
  await expect(interp.locator('mark').first()).toBeVisible();
  await expect(interp.getByRole('list', { name: 'Interpreted values' })).toContainText('priority');
  await expectAccessible(page, 'p7-interpretation');
  await interp.getByRole('checkbox', { name: 'Save with this interpretation' }).check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(box).toHaveValue('', { timeout: 15_000 });

  // A recording whose transcription answer is larger than allowed: nothing is kept or offered.
  await dialog.locator('input[type=file][accept*="audio"]').setInputFiles({
    name: 'big.wav',
    mimeType: 'audio/wav',
    buffer: wav(2, 'Too much', 'oversize'),
  });
  await expect(dialog.getByRole('alert').filter({ hasText: /sent more than allowed/ })).toBeVisible(
    {
      timeout: 30_000,
    },
  );
  await expect(dialog.getByRole('region', { name: 'Transcript' })).toHaveCount(0);
  await expect(box).toHaveValue('');
  // A valid recording: review and edit the transcript, use it, save it explicitly.
  await dialog.locator('input[type=file][accept*="audio"]').setInputFiles({
    name: 'note.wav',
    mimeType: 'audio/wav',
    buffer: wav(2, 'Call the caterer about Friday'),
  });
  const transcript = dialog.getByRole('region', { name: 'Transcript' });
  await expect(transcript).toBeVisible({ timeout: 30_000 });
  await expect(transcript).toContainText(/Synthetic transcript/);
  const edit = transcript.getByLabel('Transcript (edit before using)');
  await expect(edit).toHaveValue('Call the caterer about Friday');
  await edit.fill('Call the caterer about Friday lunch');
  await transcript.getByRole('button', { name: 'Use as capture text' }).click();
  await expect(box).toHaveValue('Call the caterer about Friday lunch');
  await expectAccessible(page, 'p7-transcript');
  // Offline: nothing can be recorded or interpreted, and the dialog says so; then recovery.
  await page.context().setOffline(true);
  await expect(dialog.getByText("You're offline").first()).toBeVisible();
  await page.context().setOffline(false);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(box).toHaveValue('', { timeout: 15_000 });
  await page.keyboard.press('Escape');

  // The Inbox keeps the original input and its source; nothing became a task on its own.
  const items = (await data(page, `${s.base}/inbox`)) as Array<{
    id: string;
    raw_text: string;
    source: { kind: string; ref?: string };
  }>;
  const typedItem = items.find((i) => i.raw_text === typed)!;
  const spoken = items.find((i) => i.raw_text === 'Call the caterer about Friday lunch')!;
  expect(spoken.source.kind).toBe('voice');
  expect((await data(page, `${s.base}/inbox/${typedItem.id}`)).interpretation).toMatchObject({
    action: 'interpret_capture.v1',
  });
  // Triage both into Harbor through the Inbox, as a person does.
  for (const text of [typed, 'Call the caterer about Friday lunch']) {
    await page.goto(`/workspaces/${s.ws}/inbox`);
    await expect(h1(page)).toHaveText('Inbox');
    const list = page.getByRole('list', { name: 'Inbox items' });
    await list.getByRole('checkbox', { name: new RegExp(text.slice(0, 20)) }).check();
    await page.getByLabel('Brand', { exact: true }).selectOption({ label: 'Harbor' });
    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByRole('table', { name: 'What will happen' })).toContainText('Ready');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(h1(page)).not.toHaveText('Inbox');
  }
  const tasks = await admin(
    `SELECT t.origin_kind, t.origin_ref, r.source_kind FROM work.task t JOIN core.record r ON r.id = t.id
      WHERE (t.origin_ref->>'inbox') = ANY($1::text[]) ORDER BY t.origin_kind`,
    [[typedItem.id, spoken.id]],
  );
  expect(tasks.map((t) => [t.origin_kind, t.source_kind])).toEqual([
    ['ai_draft', 'ui'],
    ['intake', 'voice'],
  ]);
  expect(tasks[0]!.origin_ref).toMatchObject({ inbox: typedItem.id, run: expect.any(String) });
  // No raw audio remains for any recording in this workspace, whatever its outcome.
  const audio = await admin(
    `SELECT v.state, v.storage_key FROM capture.voice_capture v JOIN tenancy.workspace w ON w.id = v.workspace_id
      WHERE w.public_id = $1 ORDER BY v.created_at`,
    [s.ws],
  );
  expect(audio.map((a) => [a.state, a.storage_key])).toEqual([
    ['failed', null],
    ['saved', null],
  ]);
  // The member never sees the owner's recordings or captures.
  const vcp = spoken.source.ref!;
  expect((await member.page.request.get(`${s.base}/capture/voice/${vcp}`)).status()).toBe(404);
  expect((await member.page.request.get(`${s.base}/inbox/${spoken.id}`)).status()).toBe(404);
  await reflow(page, `/workspaces/${s.ws}/inbox`, 'Inbox', 'p7-inbox');
  await member.ctx.close();
});

const FOUNDER_CAL = 'founder@calendar.test';

/** Google Calendar through the real OAuth redirect against the contract fixture. */
async function connectCalendar(page: Page, ws: string) {
  await page.goto(`/workspaces/${ws}/settings/integrations`);
  const google = page.getByRole('region', { name: 'Google Calendar', exact: true });
  await expect(google).toHaveAttribute('aria-busy', 'false');
  await google.getByLabel('Connection name').fill('Founder calendar');
  await google.getByRole('button', { name: 'Connect Google Calendar' }).click();
  await expect(
    page.getByText('Google Calendar is connected. Choose the calendars to include.'),
  ).toBeVisible();
}

async function syncCalendar(page: Page, ws: string) {
  await page.goto(`/workspaces/${ws}/settings/integrations`);
  const card = page.locator('section.calendar-connection').first();
  await expect(card).toHaveAttribute('aria-busy', 'false');
  await card.getByRole('button', { name: /^Sync now/ }).click();
  await expect(card).toHaveAttribute('aria-busy', 'false');
  await expect(card.getByRole('status')).toContainText('Synchronized:');
}

test('AT-536 Phase 7 exit journey: a realistic Today plan with capacity, a meeting, estimates, a dependency, and locked work; a meeting synced after approval is refused atomically, rebased explicitly, and applied exactly once', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(240_000);
  const { s, member } = await team(page, browser, info as never, 'p7day');
  const gcal = fixtureClient(GCAL_URL, GCAL_TOKEN, s.ws);
  await gcal('setCalendars', [
    { id: FOUNDER_CAL, summary: 'Founder', timeZone: 'UTC', accessRole: 'owner', primary: true },
  ]);
  const profile = await data(page, `${s.base}/me/capacity-profile`);
  await api(
    page,
    'PUT',
    `${s.base}/me/capacity-profile`,
    { windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })) },
    profile.version,
  );
  const people = (await data(page, `${s.base}/people`)) as Array<{
    id: string;
    display_name?: string;
    name?: string;
  }>;
  const me = people.find((p) => (p.display_name ?? p.name) === 'Fay Founder')!.id;
  const task = async (title: string, extra: Record<string, unknown> = {}) => {
    const t = await api(page, 'POST', `${s.base}/tasks`, { brand: s.harbor, title, ...extra });
    await api(page, 'POST', `${s.base}/tasks/${t.id}:assign`, {
      assignees: [me],
      version: t.version,
    });
    return t;
  };
  await task('Write the launch brief', { estimate_minutes: 90, priority: 'urgent' });
  await task('Review supplier quotes', { estimate_minutes: 45 });
  await task('Unestimated follow-up');
  const blocked = await task('Ship the build', { estimate_minutes: 30 });
  const blocker = await api(page, 'POST', `${s.base}/tasks`, {
    brand: s.harbor,
    title: 'Approve the build',
  });
  await api(page, 'POST', `${s.base}/tasks/${blocker.id}/relationships`, {
    kind: 'blocks',
    target: blocked.id,
  });
  const now = new Date();
  const ahead = 7 + ((8 - (now.getUTCDay() || 7)) % 7);
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + ahead))
    .toISOString()
    .slice(0, 10);
  // Locked work and a meeting already on the day.
  await api(page, 'POST', `${s.base}/work-blocks`, {
    title: 'Board prep',
    starts_at: `${day}T13:00:00Z`,
    ends_at: `${day}T14:00:00Z`,
    tz: 'UTC',
    locked: true,
  });
  await connectCalendar(page, s.ws);
  await gcal('putEvent', FOUNDER_CAL, {
    id: 'investor',
    summary: 'Investor call',
    start: { dateTime: `${day}T10:00:00Z` },
    end: { dateTime: `${day}T11:00:00Z` },
  });
  await syncCalendar(page, s.ws);

  // Preview: capacity, the meeting and locked block taken out, reasons, and what is not planned.
  await page.goto(`/workspaces/${s.ws}/today/plan?day=${day}`);
  await expect(page.getByRole('heading', { name: 'Plan my day' })).toBeVisible();
  const planned = page.locator('section[aria-labelledby="plan-scheduled"]');
  await expect(planned).toContainText('Write the launch brief', { timeout: 15_000 });
  await expect(planned).toContainText('Review supplier quotes');
  await expect(planned).toContainText('Why here');
  const notPlanned = page.locator('section[aria-labelledby="plan-unscheduled"]');
  await expect(notPlanned).toContainText('Unestimated follow-up');
  await expect(notPlanned).toContainText('Ship the build');
  await expect(page.locator('section[aria-labelledby="plan-blocks"]')).toContainText('Locked');
  const preview = (await raw(page, 'POST', `${s.base}/planning/day-plan-previews`, { day })).body
    .data;
  // 8 working hours less the one-hour meeting is the capacity the plan uses.
  expect(preview.totals.capacity_minutes).toBe(420);
  expect(preview.unscheduled.map((u: { code: string }) => u.code).sort()).toEqual([
    'blocked',
    'missing_estimate',
  ]);
  await expectAccessible(page, 'p7-day-plan');

  // Create, approve; then a meeting is synced before Apply.
  await page.getByRole('button', { name: 'Create plan proposal' }).click();
  await expect(page.getByText(/rule-based planner, not AI/)).toBeVisible({ timeout: 15_000 });
  const prpUrl = page.url();
  await page.getByRole('button', { name: /^Approve \d+ change/ }).click();
  await expect(page.getByText(/^Approved \d+ change/).first()).toBeVisible();
  await gcal('putEvent', FOUNDER_CAL, {
    id: 'press',
    summary: 'Press briefing',
    start: { dateTime: `${day}T09:00:00Z` },
    end: { dateTime: `${day}T10:00:00Z` },
  });
  await syncCalendar(page, s.ws);
  const blocksFromPlan = async () =>
    (
      (await data(page, `${s.base}/work-blocks?from=${day}&to=${day}`)) as Array<{
        source?: string;
      }>
    ).filter((b) => b.source === 'plan').length;
  // The page shows the stale basis; an Apply is refused atomically and explained.
  await page.goto(prpUrl);
  await expect(page.getByText('Your day changed since this plan was made').first()).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: /^Apply \d+ of \d+ changes/ }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: /Your day changed since this plan was made/ }),
  ).toBeVisible();
  const prp = prpUrl.split('/').pop()!;
  const current = await data(page, `${s.base}/ai/proposals/${prp}`);
  const refused = await raw(page, 'POST', `${s.base}/ai/proposals/${prp}:apply`, {
    revision: current.revision,
    fingerprint: current.fingerprint,
  });
  expect(refused.status).toBe(409);
  expect(JSON.stringify(refused.body)).toContain('plan_changed');
  expect(await blocksFromPlan()).toBe(0);
  // Explicit rebase and a fresh approval, then exactly one application.
  await page.getByRole('button', { name: 'Use my current day' }).click();
  await expect(page.getByRole('button', { name: 'Use my current day' })).toHaveCount(0);
  // The rebased plan names the conflict on the block; approving it as is is refused.
  await page.getByRole('button', { name: /^Approve \d+ change/ }).click();
  const overlap = page.getByRole('alert').filter({ hasText: /overlaps a meeting/ });
  await expect(overlap).toBeVisible();
  const key = /Change (c\d+): This time overlaps a meeting/.exec(
    (await overlap.textContent())!,
  )![1]!;
  // Move that block to a free slot (14:00, its length kept), save the revision, approve again.
  const start = page.locator(`#prp-${key}-starts_at`);
  const end = page.locator(`#prp-${key}-ends_at`);
  const minutes =
    (Date.parse(`${await end.inputValue()}Z`) - Date.parse(`${await start.inputValue()}Z`)) /
    60_000;
  const to = (m: number) =>
    new Date(Date.parse(`${day}T14:00:00Z`) + m * 60_000).toISOString().slice(0, 16);
  await start.fill(to(0));
  await end.fill(to(minutes));
  await page.getByRole('button', { name: 'Save edits' }).click();
  await expect(page.getByText(/Saved as revision/)).toBeVisible();
  await page.getByRole('button', { name: /^Approve \d+ change/ }).click();
  await expect(page.getByText(/^Approved \d+ change/).first()).toBeVisible();
  await page.getByRole('button', { name: /^Apply \d+ of \d+ changes/ }).click();
  await expect(page.getByText(/^Applied \d+ change/).first()).toBeVisible({ timeout: 15_000 });
  const placed = await blocksFromPlan();
  expect(placed).toBeGreaterThan(0);
  await page.reload();
  await expect(page.getByText(/^Applied \d+ change/).first()).toBeVisible();
  expect(await blocksFromPlan()).toBe(placed);
  // A meeting added after the commit is a later event: the plan stays applied, nothing reruns.
  await gcal('putEvent', FOUNDER_CAL, {
    id: 'late',
    summary: 'Late addition',
    start: { dateTime: `${day}T15:00:00Z` },
    end: { dateTime: `${day}T15:30:00Z` },
  });
  await syncCalendar(page, s.ws);
  await page.goto(prpUrl);
  await expect(page.getByText(/^Applied \d+ change/).first()).toBeVisible();
  expect(await blocksFromPlan()).toBe(placed);
  // The member never sees the owner's plan.
  await member.page.goto(prpUrl);
  await expect(member.page.getByRole('heading', { name: 'Proposal not found' })).toBeVisible();
  await reflow(page, `/workspaces/${s.ws}/today/plan?day=${day}`, 'Plan my day', 'p7-plan');
  // Offline: the plan cannot be checked and the person is told; back online it works.
  await page.context().setOffline(true);
  await expect(page.getByText("You're offline").first()).toBeVisible();
  await page.context().setOffline(false);
  await member.ctx.close();
});

test('AT-537 Phase 7 exit journey: fact-only cross-brand and narrower briefings with evidence, claimed versus accepted work, an approved personal note reused until its evidence changes, a regeneration, and a scheduled in-app occurrence', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(240_000);
  const { s, member } = await team(page, browser, info as never, 'p7brf');
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const overdue = await api(page, 'POST', `${s.base}/tasks`, {
    brand: s.harbor,
    project: s.site.id,
    title: 'Harbor overdue checklist',
    due_date: twoDaysAgo,
  });
  await api(page, 'POST', `${s.base}/tasks`, {
    brand: s.vault,
    project: s.secret.id,
    title: 'Vault overdue secret',
    due_date: twoDaysAgo,
  });
  const claimed = await api(page, 'POST', `${s.base}/tasks`, {
    brand: s.harbor,
    project: s.site.id,
    title: 'Harbor press kit',
    requires_acceptance: true,
  });
  await api(page, 'POST', `${s.base}/tasks/${claimed.id}:complete`, {}, claimed.version);

  // The founder's cross-brand daily briefing: facts with evidence, claimed separate from accepted.
  await page.goto(`/workspaces/${s.ws}/briefings`);
  await expect(page.getByRole('heading', { name: 'Briefings', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Preview scope and window' }).click();
  await expect(page.getByRole('region', { name: 'Briefing preview' })).toContainText(
    'every brand you can read',
  );
  await page.getByRole('button', { name: 'Generate briefing' }).click();
  await expect(page.getByRole('heading', { name: 'Daily briefing', level: 1 })).toBeVisible();
  const first = page.url();
  await expect(page.getByText('Harbor overdue checklist').first()).toBeVisible();
  await expect(page.getByText('Vault overdue secret').first()).toBeVisible();
  const claimedRow = page
    .locator('li')
    .filter({ hasText: 'is marked done but has no accepted deliverable' });
  await expect(claimedRow).toContainText('Harbor press kit');
  await expect(page.getByText(/Generated wording is not part of this briefing/)).toBeVisible();
  await expectAccessible(page, 'p7-briefing');
  // Follow a statement's evidence to the record it rests on.
  const overdueRow = page
    .locator('li')
    .filter({ hasText: 'Harbor overdue checklist' })
    .filter({ hasText: 'still open' });
  await overdueRow.getByRole('list', { name: 'Evidence' }).getByRole('link').first().click();
  await expect(h1(page)).toHaveText('Harbor overdue checklist');
  await page.goto(first);
  // Annotate the statement; approve the personal note.
  await overdueRow.getByRole('button', { name: 'Add a note' }).click();
  await overdueRow.getByLabel(/Your note or correction/).fill('Client agreed the new date.');
  await overdueRow.getByRole('button', { name: 'Propose note' }).click();
  await expect(page.getByText('Note proposed', { exact: false })).toBeVisible();
  await page.goto(`/workspaces/${s.ws}/settings/briefings`);
  const notes = page.getByRole('list', { name: 'Your briefing notes' });
  await notes.getByRole('button', { name: 'Approve' }).click();
  await expect(notes).toContainText('approved');
  // A regeneration keeps the window and is visibly distinct.
  await page.goto(first);
  await page.getByRole('button', { name: 'Regenerate (same window)' }).click();
  await expect(page.getByText('Regenerates')).toBeVisible();
  expect(page.url()).not.toBe(first);
  // The next briefing reuses the approved note beside the unchanged statement.
  await page.goto(`/workspaces/${s.ws}/briefings`);
  await page.getByRole('button', { name: 'Preview scope and window' }).click();
  await expect(page.getByRole('region', { name: 'Briefing preview' })).toContainText(
    'Continues from your briefing',
  );
  await page.getByRole('button', { name: 'Generate briefing' }).click();
  await expect(page.getByText('Your approved note: Client agreed the new date.')).toBeVisible();
  // The note is a personal annotation: the record is unchanged. Once the evidence changes the
  // note is not reused (it is stale, never a canonical override).
  const task = await data(page, `${s.base}/tasks/${overdue.id}`);
  expect(task.due_date).toBe(twoDaysAgo);
  await api(
    page,
    'PATCH',
    `${s.base}/tasks/${overdue.id}`,
    {
      version: task.version,
      changes: { title: { base: task.title, value: 'Harbor overdue checklist (v2)' } },
    },
    task.version,
  );
  await page.goto(`/workspaces/${s.ws}/briefings`);
  await page.getByRole('button', { name: 'Preview scope and window' }).click();
  await page.getByRole('button', { name: 'Generate briefing' }).click();
  await expect(page.getByRole('heading', { name: 'Daily briefing', level: 1 })).toBeVisible();
  await expect(
    page.getByText('Harbor overdue checklist (v2)').filter({ visible: true }).first(),
  ).toBeVisible();
  await expect(page.getByText('Your approved note: Client agreed the new date.')).toHaveCount(0);

  // The narrower member: their own briefing, nothing from Vault, and not the founder's.
  await member.page.goto(`/workspaces/${s.ws}/briefings`);
  await member.page.getByRole('button', { name: 'Preview scope and window' }).click();
  await member.page.getByRole('button', { name: 'Generate briefing' }).click();
  await expect(
    member.page.getByRole('heading', { name: 'Daily briefing', level: 1 }),
  ).toBeVisible();
  await expect(
    member.page.getByText('Harbor overdue checklist (v2)').filter({ visible: true }).first(),
  ).toBeVisible();
  await expect(member.page.getByText('Vault overdue secret')).toHaveCount(0);
  await member.page.goto(first);
  await expect(member.page.getByText('This briefing could not be shown')).toBeVisible();

  // A scheduled occurrence delivered in-app (the schedule is due now; the worker sweeps it).
  const schedule = await api(page, 'POST', `${s.base}/ai/briefing-schedules`, {
    kind: 'brand_daily',
    scope: { brand: s.harbor },
    timezone: 'UTC',
    local_time: '00:00',
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    channels: ['in_app'],
  });
  await admin(
    `UPDATE ai.briefing_schedule SET next_run_at = date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      WHERE public_id = $1`,
    [schedule.id],
  );
  await expect
    .poll(
      async () =>
        (await rows<{ trigger: string; state: string }>(page, `${s.base}/ai/briefings`)).filter(
          (b) => b.trigger === 'schedule' && b.state === 'published',
        ).length,
      { timeout: 120_000, intervals: [2_000] },
    )
    .toBe(1);
  await expect
    .poll(
      async () =>
        (await rows<{ notification_type: string }>(page, `${s.base}/me/notifications`)).filter(
          (n) => n.notification_type === 'briefing_ready',
        ).length,
      { timeout: 30_000, intervals: [1_000] },
    )
    .toBe(1);
  await page.goto(`/workspaces/${s.ws}/notifications`);
  await expect(page.getByText('Your briefing is ready').first()).toBeVisible();
  // The member was not notified of the founder's briefing.
  expect(
    (await rows<{ notification_type: string }>(member.page, `${s.base}/me/notifications`)).filter(
      (n) => n.notification_type === 'briefing_ready',
    ),
  ).toHaveLength(0);
  // Keyboard, reflow, forced colours, offline recovery.
  await page.goto(`/workspaces/${s.ws}/briefings`);
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await tabTo(page, "el && el.id === 'brf-kind'");
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Preview scope and window' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /Nothing was sent/ })).toBeVisible();
  await page.context().setOffline(false);
  await page.getByRole('button', { name: 'Preview scope and window' }).click();
  await expect(page.getByRole('region', { name: 'Briefing preview' })).toBeVisible();
  await reflow(page, `/workspaces/${s.ws}/briefings`, 'Briefings', 'p7-briefings');
  await member.ctx.close();
});

test('AT-538 Phase 7 exit journey: with AI off, every AI, speech, and assist surface says so truthfully, and manual capture, triage, task editing, Today planning, and briefings keep working', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  // AI is off by default in a new workspace (and unconfigured deployments look the same).
  const s = await seed(page, info, 'p7off');
  // Assist: sources can be reviewed, nothing can be run, and the page says why.
  await page.goto(`/workspaces/${s.ws}/ai/assist`);
  await page.getByLabel('Action', { exact: true }).selectOption('summarize.v1');
  await page.getByLabel('Also include (optional)').fill(s.site.tasks.open);
  await page.getByRole('button', { name: 'Preview context' }).click();
  await expect(page.getByText('AI is not available').first()).toBeVisible();
  await expect(
    page.getByText(/You can still review these sources and work without AI/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Estimate cost' })).toHaveCount(0);
  await expectAccessible(page, 'p7-assist-off');
  // Capture: no interpretation or recording is offered, and the text says so; manual save works.
  await page.goto(`/workspaces/${s.ws}/today`);
  await page.getByRole('button', { name: 'Capture' }).click();
  const dialog = page.getByRole('dialog', { name: 'Capture' });
  await expect(dialog.getByRole('button', { name: 'Interpret with AI' })).toHaveCount(0);
  await expect(
    dialog.getByText(/Detected values above still come from simple rules/),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Record a note' })).toHaveCount(0);
  await expect(dialog.getByText(/type or paste your note/i)).toBeVisible();
  await expectAccessible(page, 'p7-capture-off');
  const box = dialog.getByLabel('What do you want to capture?');
  await box.fill('Order the stage banners');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(box).toHaveValue('', { timeout: 15_000 });
  await page.keyboard.press('Escape');
  // Triage into a task, then edit it as usual.
  await page.goto(`/workspaces/${s.ws}/inbox`);
  const list = page.getByRole('list', { name: 'Inbox items' });
  await list.getByRole('checkbox', { name: /Order the stage banners/ }).check();
  await page.getByLabel('Brand', { exact: true }).selectOption({ label: 'Harbor' });
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(h1(page)).toHaveText('Order the stage banners');
  const tsk = page.url().split('/').pop()!;
  const t = await data(page, `${s.base}/tasks/${tsk}`);
  await api(
    page,
    'PATCH',
    `${s.base}/tasks/${tsk}`,
    { version: t.version, changes: { estimate_minutes: { base: null, value: 60 } } },
    t.version,
  );
  // Today planning is rule-based: it needs no provider.
  const profile = await data(page, `${s.base}/me/capacity-profile`);
  await api(
    page,
    'PUT',
    `${s.base}/me/capacity-profile`,
    { windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })) },
    profile.version,
  );
  const people = (await data(page, `${s.base}/people`)) as Array<{
    id: string;
    display_name?: string;
    name?: string;
  }>;
  const me = people.find((p) => (p.display_name ?? p.name) === 'Fay Founder')!.id;
  const fresh = await data(page, `${s.base}/tasks/${tsk}`);
  await api(page, 'POST', `${s.base}/tasks/${tsk}:assign`, {
    assignees: [me],
    version: fresh.version,
  });
  const now = new Date();
  const ahead = 7 + ((8 - (now.getUTCDay() || 7)) % 7);
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + ahead))
    .toISOString()
    .slice(0, 10);
  await page.goto(`/workspaces/${s.ws}/today/plan?day=${day}`);
  await expect(page.locator('section[aria-labelledby="plan-scheduled"]')).toContainText(
    'Order the stage banners',
    { timeout: 15_000 },
  );
  await page.getByRole('button', { name: 'Create plan proposal' }).click();
  await expect(page.getByText(/rule-based planner, not AI/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /^Approve \d+ change/ }).click();
  await page.getByRole('button', { name: /^Apply \d+ of \d+ changes/ }).click();
  await expect(page.getByText(/^Applied \d+ change/).first()).toBeVisible({ timeout: 15_000 });
  // Briefings are fact-only and need no provider.
  await page.goto(`/workspaces/${s.ws}/briefings`);
  await page.getByRole('button', { name: 'Preview scope and window' }).click();
  await page.getByRole('button', { name: 'Generate briefing' }).click();
  await expect(page.getByRole('heading', { name: 'Daily briefing', level: 1 })).toBeVisible();
  await expect(page.getByText(/Generated wording is not part of this briefing/)).toBeVisible();
  // Offline and back: the manual product recovers.
  await page.goto(`/workspaces/${s.ws}/inbox`);
  await expect(h1(page)).toHaveText('Inbox');
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Capture' }).click();
  await expect(page.getByText("You're offline").first()).toBeVisible();
  await page.context().setOffline(false);
  await page.keyboard.press('Escape');
  await reflow(page, `/workspaces/${s.ws}/ai/assist`, 'AI assist', 'p7-assist-off');
});
