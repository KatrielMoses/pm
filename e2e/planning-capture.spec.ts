import { expect, test, type Page } from '@playwright/test';
import { syntheticWav } from '@pm/test-support';
import { api } from './goals-support.ts';
import { expectNoOverflow } from './live-support.ts';
import { createBrand, createWorkspace, expectAccessible, owner, PASSWORD } from './support.ts';

/**
 * Phase 7F browser journeys (desktop, tablet, mobile) against the real API, worker, and the
 * deterministic provider fixture (interpretation and transcription are synthetic and labelled; no
 * provider is called). Capture: interpret typed text with confirmed cost and evidence spans, then
 * upload a synthetic recording, review and edit its transcript, and save both to the Inbox. Plan:
 * a rule-based plan from capacity, reviewed and applied once through a change proposal. Both
 * cover keyboard and screen-reader labels, 320 px and 200% zoom, forced colours, and offline.
 */
async function confirmStepUp(page: Page): Promise<void> {
  const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(stepUp).toBeVisible();
  await stepUp.getByLabel(/^Password/).fill(PASSWORD);
  await stepUp.getByRole('button', { name: 'Confirm' }).click();
  await expect(stepUp).toBeHidden();
}

async function setup(page: Page, info: Parameters<typeof owner>[1], prefix: string) {
  const email = await owner(page, info, prefix, 'Morgan Planner');
  const ws = await createWorkspace(page, 'Plan Co');
  await createBrand(page, 'Harbor');
  const brand = (await (await page.request.get(`/v1/workspaces/${ws}/brands`)).json()).data[0]
    .id as string;
  await page.goto(`/workspaces/${ws}/settings/ai`);
  await page.getByLabel('Turn on AI for this workspace').check();
  await page.getByRole('button', { name: 'Save AI settings' }).click();
  await confirmStepUp(page);
  await expect(page.getByText('AI is available', { exact: true })).toBeVisible();
  return { ws, brand, email };
}

async function narrowAndForced(page: Page, url: string, heading: string | RegExp, label: string) {
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

test('AT-513 Phase 7F capture journey: interpret typed text, upload a synthetic recording, edit the transcript, and save both explicitly', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const { ws } = await setup(page, info, 'cap7f');
  await page.goto(`/workspaces/${ws}/today`);
  await page.getByRole('button', { name: 'Capture' }).click();
  const dialog = page.getByRole('dialog', { name: 'Capture' });
  await expect(dialog).toBeVisible();
  const text = 'Book the venue tomorrow high priority #fixture:ok';
  await dialog.getByLabel('What do you want to capture?').fill(text);
  await dialog.getByRole('button', { name: 'Interpret with AI' }).click();
  await expect(dialog.getByText(/could cost up to/)).toBeVisible();
  await expect(dialog.getByText(/synthetic test model/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirm and interpret' }).click();
  const interp = dialog.getByRole('region', { name: 'Interpretation' });
  await expect(interp).toBeVisible({ timeout: 30_000 });
  await expect(interp.locator('mark').first()).toBeVisible();
  await expect(interp.getByRole('list', { name: 'Interpreted values' })).toContainText('priority');
  await expectAccessible(page, 'capture-interpretation');
  await interp.getByRole('checkbox', { name: 'Save with this interpretation' }).check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByLabel('What do you want to capture?')).toHaveValue('', {
    timeout: 15_000,
  });
  const first = (await (await page.request.get(`/v1/workspaces/${ws}/inbox`)).json())
    .data as Array<{
    id: string;
    raw_text: string;
  }>;
  const interpreted = first.find((i) => i.raw_text === text)!;
  const item = (
    await (await page.request.get(`/v1/workspaces/${ws}/inbox/${interpreted.id}`)).json()
  ).data;
  expect(item.interpretation).toMatchObject({ action: 'interpret_capture.v1' });
  // Offline: nothing can be interpreted or recorded, and the dialog says so.
  await page.context().setOffline(true);
  await expect(dialog.getByText("You're offline").first()).toBeVisible();
  await page.context().setOffline(false);
  // Voice: a synthetic recording is uploaded, transcribed, edited, and used as the capture text.
  const wav = Buffer.from(syntheticWav(2, { transcript: 'Call the caterer about Friday' }));
  await dialog.locator('input[type=file][accept*="audio"]').setInputFiles({
    name: 'note.wav',
    mimeType: 'audio/wav',
    buffer: wav,
  });
  const transcript = dialog.getByRole('region', { name: 'Transcript' });
  await expect(transcript).toBeVisible({ timeout: 30_000 });
  await expect(transcript).toContainText(/Synthetic transcript/);
  const box = transcript.getByLabel('Transcript (edit before using)');
  await expect(box).toHaveValue('Call the caterer about Friday');
  await box.fill('Call the caterer about Friday lunch');
  await transcript.getByRole('button', { name: 'Use as capture text' }).click();
  await expect(dialog.getByLabel('What do you want to capture?')).toHaveValue(
    'Call the caterer about Friday lunch',
  );
  await expect(dialog.getByText(/Saved as a voice capture/)).toBeVisible();
  await expectAccessible(page, 'capture-voice');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  // A saved capture clears the text (and its voice reference).
  await expect(dialog.getByLabel('What do you want to capture?')).toHaveValue('', {
    timeout: 15_000,
  });
  await expect(dialog.getByText(/Saved as a voice capture/)).toBeHidden();
  const inbox = await (await page.request.get(`/v1/workspaces/${ws}/inbox`)).json();
  const items = inbox.data as Array<{ raw_text: string; source: { kind: string } }>;
  expect(items.find((i) => i.raw_text === 'Call the caterer about Friday lunch')?.source.kind).toBe(
    'voice',
  );
  await page.keyboard.press('Escape');
  await narrowAndForced(page, `/workspaces/${ws}/today`, /Today|^[A-Z][a-z]+day/, 'capture-entry');
});

test('AT-514 Phase 7F plan journey: a rule-based plan from capacity is reviewed and applied once through a change proposal', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const { ws, brand, email } = await setup(page, info, 'plan7f');
  const base = `/v1/workspaces/${ws}`;
  const profile = (await (await page.request.get(`${base}/me/capacity-profile`)).json()).data;
  await api(
    page,
    'PUT',
    `${base}/me/capacity-profile`,
    { windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })) },
    profile.version,
  );
  const people = (await (await page.request.get(`${base}/people`)).json()).data as Array<{
    id: string;
    email?: string;
    account?: { email?: string };
  }>;
  const me = people.find((x) => (x.email ?? x.account?.email) === email)!.id;
  for (const [title, minutes] of [
    ['Write the launch brief', 90],
    ['Review supplier quotes', 45],
  ] as const) {
    const t = await api(page, 'POST', `${base}/tasks`, { brand, title, estimate_minutes: minutes });
    await api(page, 'POST', `${base}/tasks/${t.id}:assign`, {
      assignees: [me],
      version: t.version,
    });
  }
  const now = new Date();
  const ahead = 7 + ((8 - (now.getUTCDay() || 7)) % 7);
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + ahead))
    .toISOString()
    .slice(0, 10);
  await page.goto(`/workspaces/${ws}/today`);
  await expect(page.getByRole('link', { name: 'Plan this day' })).toBeVisible();
  await page.goto(`/workspaces/${ws}/today/plan?day=${day}`);
  await expect(page.getByRole('heading', { name: 'Plan my day' })).toBeVisible();
  const planned = page.locator('section[aria-labelledby="plan-scheduled"]');
  await expect(planned).toContainText('Write the launch brief', { timeout: 15_000 });
  await expect(planned).toContainText('Review supplier quotes');
  await expect(planned).toContainText('Why here');
  await expectAccessible(page, 'day-plan');
  // Offline: the plan cannot be checked and the person is told.
  await page.context().setOffline(true);
  await expect(page.getByText("You're offline").first()).toBeVisible();
  await page.context().setOffline(false);
  await page.getByRole('button', { name: 'Create plan proposal' }).click();
  await expect(page.getByText(/rule-based planner, not AI/)).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole('heading', { level: 2, name: new RegExp(`Plan for ${day}`) }),
  ).toBeVisible();
  await expectAccessible(page, 'plan-proposal');
  await page.getByRole('button', { name: /^Approve \d+ change/ }).click();
  await page.getByRole('button', { name: /^Apply \d+ of \d+ changes/ }).click();
  await expect(page.getByText(/^Applied \d+ change/).first()).toBeVisible({ timeout: 15_000 });
  const today = (await (await page.request.get(`${base}/today/${day}`)).json()).data;
  expect(
    (today.committed as Array<{ task: { title: string }; source: string }>).map((c) => [
      c.task.title,
      c.source,
    ]),
  ).toEqual(
    expect.arrayContaining([
      ['Write the launch brief', 'plan'],
      ['Review supplier quotes', 'plan'],
    ]),
  );
  await narrowAndForced(page, `/workspaces/${ws}/today/plan?day=${day}`, 'Plan my day', 'day-plan');
});
