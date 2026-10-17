import { expect, test, type Page } from '@playwright/test';
import { api } from './goals-support.ts';
import { expectNoOverflow, tabTo } from './live-support.ts';
import { createBrand, createWorkspace, expectAccessible, owner, PASSWORD } from './support.ts';

/**
 * Phase 7A browser journey (desktop, tablet, mobile) against the real API, worker, and the
 * deterministic Messages protocol fixture. Every result here is synthetic and labelled so; no AI
 * provider is called and no money is spent. Real-provider validation is a separate, unapproved
 * step (OD-41, DQ-28).
 */
async function confirmStepUp(page: Page): Promise<void> {
  const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(stepUp).toBeVisible();
  await stepUp.getByLabel(/^Password/).fill(PASSWORD);
  await stepUp.getByRole('button', { name: 'Confirm' }).click();
  await expect(stepUp).toBeHidden();
}

async function estimateAndStart(page: Page, request: string): Promise<void> {
  await page.getByLabel(/^Request/).fill(request);
  await page.getByRole('button', { name: 'Estimate cost' }).click();
  const estimate = page.getByRole('region', { name: 'Estimate' });
  await expect(estimate).toContainText('synthetic price');
  const start = estimate.getByRole('button', { name: 'Start test run' });
  await expect(start).toBeDisabled();
  await estimate.getByLabel(/I confirm this run may cost up to/).check();
  await start.click();
  await expect(page.getByRole('heading', { name: 'Current run' })).toBeVisible();
}

test('AT-381 Phase 7A AI journey: off by default, settings with step-up, a synthetic run, cancel, history, resilience', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await owner(page, info, 'ai7a', 'Avery Lane');
  const ws = await createWorkspace(page, 'Gateway Co');
  await createBrand(page, 'Harbor');
  const brand = (await (await page.request.get(`/v1/workspaces/${ws}/brands`)).json()).data[0]
    .id as string;

  // AI is off: the page says so and manual work continues (no AI-only completion gate).
  await page.goto(`/workspaces/${ws}/ai`);
  await expect(page.getByRole('heading', { name: 'AI test runs' })).toBeVisible();
  await expect(page.getByText('AI is not available')).toBeVisible();
  await expect(
    page.getByText(/Every task, project, and plan can be created and completed without it/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Estimate cost' })).toHaveCount(0);
  const task = await api(page, 'POST', `/v1/workspaces/${ws}/tasks`, {
    brand,
    title: 'Manual launch checklist',
  });
  expect(task.id).toMatch(/^tsk_/);
  await expectAccessible(page, 'ai-off');

  // Owner turns AI on with the synthetic fixture model and sets a finite limit (step-up each time).
  await page.getByRole('link', { name: 'AI settings' }).click();
  await expect(page.getByRole('heading', { name: 'Provider and privacy' })).toBeVisible();
  await expect(page.getByText(/Training on workspace content stays excluded/)).toBeVisible();
  await expect(page.getByText(/OD-46/)).toBeVisible();
  await page.getByLabel('Turn on AI for this workspace').check();
  await page.getByRole('button', { name: 'Save AI settings' }).click();
  await confirmStepUp(page);
  await expect(page.getByText('AI is available', { exact: true })).toBeVisible();
  await page.getByLabel('Monthly allowance (USD)').fill('1.00');
  await page.getByLabel('Hard monthly limit (USD)').fill('2.00');
  await page.getByRole('button', { name: 'Save limits' }).click();
  await confirmStepUp(page);
  await expect(page.getByText('Configured for this workspace.')).toBeVisible();
  await expectAccessible(page, 'ai-settings');

  // A synthetic, non-mutating test run: estimate first, explicit confirmation, labelled output.
  await page.getByRole('link', { name: 'AI test runs' }).click();
  await expect(page.getByText('Synthetic test model', { exact: true })).toBeVisible();
  await expect(page.getByText('Remaining allowance')).toBeVisible();
  await estimateAndStart(page, 'Summarize the Harbor launch checklist');
  const current = page
    .getByRole('region', { name: 'Current run' })
    .or(page.locator('section[aria-labelledby="ai-current-heading"]'));
  await expect(current).toContainText('Completed', { timeout: 30_000 });
  await expect(current.getByRole('region', { name: 'Synthetic output' })).toContainText(
    'Synthetic fixture reply',
  );
  await expectAccessible(page, 'ai-run-complete');

  // Cancellation is honest: a call in flight is closed and its cost may still be charged.
  await estimateAndStart(page, 'Wait for this one #fixture:hang');
  await expect(current).toContainText('Running', { timeout: 20_000 });
  await expect(page.getByText(/cannot be recalled/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel run' }).click();
  await expect(current).toContainText(/Cancelling…|Cancelled/);
  await expect(current).toContainText('Cancelled (cost may still be charged)', { timeout: 30_000 });

  // History: the person's own runs, with details and the export.
  const history = page.getByRole('list', { name: 'AI runs' });
  await page.reload();
  await expect(history).toContainText('Completed');
  await history.getByRole('button', { name: /^View/ }).last().click();
  await expect(page.getByRole('region', { name: 'Run details' })).toContainText(
    'Summarize the Harbor launch checklist',
  );
  await expect(page.getByRole('link', { name: /Export your AI history/ })).toHaveAttribute(
    'href',
    /ai_history\.csv$/,
  );

  // Offline: nothing is sent and the person is told; back online the same action works.
  await page.context().setOffline(true);
  await page.getByLabel(/^Request/).fill('Offline attempt');
  await page.getByRole('button', { name: 'Estimate cost' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /Nothing was sent/ })).toBeVisible();
  await page.context().setOffline(false);
  await page.getByRole('button', { name: 'Estimate cost' }).click();
  await expect(page.getByRole('region', { name: 'Estimate' })).toBeVisible();

  // Keyboard reaches the run controls; narrow widths, 200% zoom, forced colours, reduced motion.
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await tabTo(page, "el && el.tagName === 'BUTTON' && el.textContent.includes('Estimate cost')");
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  for (const width of [320, Math.max(320, Math.floor(size.width / 2))]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/workspaces/${ws}/ai`);
    await expect(page.getByRole('list', { name: 'AI runs' })).toContainText('Completed');
    await expectNoOverflow(page, `AI test runs at ${width}px`);
    await page.goto(`/workspaces/${ws}/settings/ai`);
    await expect(page.getByRole('heading', { name: 'Allowance and hard limit' })).toBeVisible();
    await expectNoOverflow(page, `AI settings at ${width}px`);
  }
  await page.goto(`/workspaces/${ws}/ai`);
  await expect(page.getByRole('list', { name: 'AI runs' })).toContainText('Completed');
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await expectAccessible(page, 'ai-narrow-forced');
  for (const control of await page.locator('.ai-panel button').all()) {
    const box = await control.boundingBox();
    if (box) expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await page.emulateMedia({ forcedColors: null, reducedMotion: null });
  await page.setViewportSize(size);
});
