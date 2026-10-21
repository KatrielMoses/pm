import { expect, test, type Page } from '@playwright/test';
import { api } from './goals-support.ts';
import { expectNoOverflow, tabTo } from './live-support.ts';
import { createBrand, createWorkspace, expectAccessible, owner } from './support.ts';

/**
 * Phase 7E browser journeys (desktop, tablet, mobile) against the real API and worker. They prove
 * a source-linked cross-brand daily briefing (LA-007), the distinction between claimed completion
 * and evidence, a correction reused in the next briefing, schedule settings with email, and
 * offline recovery, with keyboard, narrow widths, 200% zoom, and forced colours. Briefings are
 * fact-only: no AI provider is configured or called.
 */
async function setup(page: Page, info: Parameters<typeof owner>[1], prefix: string) {
  await owner(page, info, prefix, 'Jordan Reyes');
  const ws = await createWorkspace(page, 'Brief Co');
  await createBrand(page, 'Harbor');
  const brand = (await (await page.request.get(`/v1/workspaces/${ws}/brands`)).json()).data[0]
    .id as string;
  const project = await api(page, 'POST', `/v1/workspaces/${ws}/projects`, {
    brand,
    name: 'Harbor launch',
  });
  const mk = (title: string, extra: Record<string, unknown> = {}) =>
    api(page, 'POST', `/v1/workspaces/${ws}/tasks`, {
      brand,
      project: project.id,
      title,
      ...extra,
    });
  const yesterday = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const overdue = await mk('Harbor overdue checklist', { due_date: yesterday });
  const claimed = await mk('Harbor press kit', { requires_acceptance: true });
  await api(page, 'POST', `/v1/workspaces/${ws}/tasks/${claimed.id}:complete`, {}, claimed.version);
  return { ws, brand, project, overdue, claimed };
}

test('AT-467 Phase 7E briefing journey: cross-brand daily briefing with evidence, claimed versus accepted, a reused note, schedules with email, offline recovery, accessibility', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const { ws, overdue, claimed } = await setup(page, info, 'brf7e');
  await page.goto(`/workspaces/${ws}/briefings`);
  await expect(page.getByRole('heading', { name: 'Briefings', level: 1 })).toBeVisible();
  await expect(page.getByText(/No briefings yet/)).toBeVisible();
  await expectAccessible(page, 'briefings-empty');
  // Generate now: the preview names the scope, window, and the missing baseline first.
  await page.getByRole('button', { name: 'Preview scope and window' }).click();
  const preview = page.getByRole('region', { name: 'Briefing preview' });
  await expect(preview).toContainText('every brand you can read');
  await expect(preview).toContainText('First briefing for this scope');
  await page.getByRole('button', { name: 'Generate briefing' }).click();
  await expect(page.getByRole('heading', { name: 'Daily briefing', level: 1 })).toBeVisible();
  await expect(page.getByText(/first daily briefing for this scope/)).toBeVisible();
  // Claimed completion is labelled, separate from accepted evidence, and linked to its task.
  const claimedRow = page
    .locator('li')
    .filter({ hasText: 'is marked done but has no accepted deliverable' });
  await expect(claimedRow).toContainText('Harbor press kit');
  await expect(claimedRow.getByRole('link', { name: /Task/ })).toHaveAttribute(
    'href',
    `/workspaces/${ws}/tasks/${claimed.id}`,
  );
  const overdueRow = page
    .locator('li')
    .filter({ hasText: 'Harbor overdue checklist' })
    .filter({ hasText: 'still open' });
  await expect(overdueRow.getByText('Fact', { exact: true })).toBeVisible();
  // 8C: the agent-run section states real runs; with none it says so (never "accepted").
  await expect(
    page.getByText(/No agent run on a task you can read returned output for review/),
  ).toBeVisible();
  await expect(page.getByText(/Generated wording is not part of this briefing/)).toBeVisible();
  await expectAccessible(page, 'briefing-detail');
  // A note on the overdue statement, approved for my future briefings.
  await overdueRow.getByRole('button', { name: 'Add a note' }).click();
  await overdueRow.getByLabel(/Your note or correction/).fill('Client agreed the new date.');
  await overdueRow.getByRole('button', { name: 'Propose note' }).click();
  await expect(page.getByText('Note proposed', { exact: false })).toBeVisible();
  await page.goto(`/workspaces/${ws}/settings/briefings`);
  const notes = page.getByRole('list', { name: 'Your briefing notes' });
  await expect(notes).toContainText('Client agreed the new date.');
  await notes.getByRole('button', { name: 'Approve' }).click();
  await expect(notes).toContainText('approved');
  // A schedule in my time zone, with an email link (no content in the email).
  await page.getByLabel('Local time').fill('07:30');
  await page.getByLabel(/Also email me a link/).check();
  await page.getByRole('button', { name: 'Save schedule' }).click();
  const schedules = page.getByRole('list', { name: 'Your schedules' });
  await expect(schedules).toContainText('07:30');
  await expect(schedules).toContainText(/In-app and email/);
  await expect(schedules).toContainText(/Next:/);
  await expectAccessible(page, 'briefing-settings');
  // The next briefing reuses the approved note beside the unchanged statement.
  await page.goto(`/workspaces/${ws}/briefings`);
  await page.getByRole('button', { name: 'Preview scope and window' }).click();
  await expect(page.getByRole('region', { name: 'Briefing preview' })).toContainText(
    'Continues from your briefing',
  );
  await page.getByRole('button', { name: 'Generate briefing' }).click();
  await expect(page.getByText('Your approved note: Client agreed the new date.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Your previous published briefing' })).toBeVisible();
  // The note changed nothing in the record.
  const task = (await (await page.request.get(`/v1/workspaces/${ws}/tasks/${overdue.id}`)).json())
    .data;
  expect(task.status.category).not.toBe('done');
  // Offline: nothing is sent and the person is told; back online it works again.
  await page.goto(`/workspaces/${ws}/briefings`);
  await expect(page.getByRole('list', { name: 'Your briefings' })).toBeVisible();
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Preview scope and window' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /Nothing was sent/ })).toBeVisible();
  await page.context().setOffline(false);
  await page.getByRole('button', { name: 'Preview scope and window' }).click();
  await expect(page.getByRole('region', { name: 'Briefing preview' })).toBeVisible();
  // Keyboard, narrow widths, 200% zoom, forced colours, reduced motion.
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await tabTo(page, "el && el.id === 'brf-kind'");
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  for (const width of [320, Math.max(320, Math.floor(size.width / 2))]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/workspaces/${ws}/briefings`);
    await expect(page.getByRole('heading', { name: 'Briefings', level: 1 })).toBeVisible();
    await expectNoOverflow(page, `Briefings at ${width}px`);
  }
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await expectAccessible(page, 'briefings-narrow-forced');
  for (const control of await page.locator('.ai-panel button').all()) {
    const box = await control.boundingBox();
    if (box) expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await page.emulateMedia({ forcedColors: null, reducedMotion: null });
  await page.setViewportSize(size);
});
