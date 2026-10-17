import { expect, test, type Page } from '@playwright/test';
import { api } from './goals-support.ts';
import { expectNoOverflow, tabTo } from './live-support.ts';
import { createBrand, createWorkspace, expectAccessible, owner, PASSWORD } from './support.ts';

/**
 * Phase 7D browser journey (desktop, tablet, mobile) against the real API, worker, and the
 * deterministic Messages protocol fixture (no provider is called; the proposal is synthetic and
 * labelled). It proves review before change: a proposal from a previewed context, an editable
 * diff, dependency feedback, edits kept across a reload, approval of exactly what was reviewed,
 * an explicit atomic Apply with honest provenance, offline recovery, keyboard, narrow widths, zoom,
 * and forced colours.
 */
async function confirmStepUp(page: Page): Promise<void> {
  const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(stepUp).toBeVisible();
  await stepUp.getByLabel(/^Password/).fill(PASSWORD);
  await stepUp.getByRole('button', { name: 'Confirm' }).click();
  await expect(stepUp).toBeHidden();
}

async function propose(page: Page, ws: string, ids: string[]): Promise<void> {
  await page.goto(`/workspaces/${ws}/ai/ask`);
  await page.getByLabel('Also include (optional)').fill(ids.join(' '));
  await page.getByRole('button', { name: 'Preview context' }).click();
  await expect(page.getByRole('list', { name: 'Context sources' })).toContainText('S2');
  await page.getByLabel('Question').fill('Plan the follow-up work #fixture:ok');
  await page.getByRole('button', { name: 'Estimate cost' }).click();
  const estimate = page.getByRole('region', { name: 'Estimate' });
  await estimate.getByLabel(/I confirm this answer may cost up to/).check();
  await estimate.getByRole('button', { name: 'Propose changes (synthetic fixture)' }).click();
  const review = page.getByRole('link', { name: 'Review the proposed changes' });
  await expect(review).toBeVisible({ timeout: 30_000 });
  await review.click();
  await expect(page.getByRole('heading', { name: 'Plan the follow-up' })).toBeVisible();
}

test('AT-423 Phase 7D proposal journey: review, edit, select, approve, and explicitly apply; outcome, provenance, resilience', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await owner(page, info, 'ai7d', 'Morgan Vale');
  const ws = await createWorkspace(page, 'Proposal Co');
  await createBrand(page, 'Harbor');
  const brand = (await (await page.request.get(`/v1/workspaces/${ws}/brands`)).json()).data[0]
    .id as string;
  const project = await api(page, 'POST', `/v1/workspaces/${ws}/projects`, {
    brand,
    name: 'Harbor launch',
  });
  const task = await api(page, 'POST', `/v1/workspaces/${ws}/tasks`, {
    brand,
    project: project.id,
    title: 'Harbor launch checklist',
  });

  await page.goto(`/workspaces/${ws}/settings/ai`);
  await page.getByLabel('Turn on AI for this workspace').check();
  await page.getByRole('button', { name: 'Save AI settings' }).click();
  await confirmStepUp(page);
  await expect(page.getByText('AI is available', { exact: true })).toBeVisible();

  await propose(page, ws, [project.id, task.id]);
  const url = page.url();
  await expect(page.getByText(/This proposal is AI-generated/)).toBeVisible();
  await expect(page.getByText('Synthetic fixture')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Changes \(5 of 5 selected\)/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Priority/ }).first()).toBeVisible();
  // Nothing has changed yet: the task keeps its priority.
  const before = await (await page.request.get(`/v1/workspaces/${ws}/tasks/${task.id}`)).json();
  expect(before.data.priority).toBe('none');
  await expectAccessible(page, 'proposal-review');

  // Dependency feedback: deselecting the parent task blocks approval and says why.
  await page.getByLabel(/c1 · Create task/).uncheck();
  await expect(page.getByText(/Change c2 needs change c1/)).toBeVisible();
  await page.getByRole('button', { name: 'Discard edits' }).click();
  await expect(page.getByLabel(/c1 · Create task/)).toBeChecked();

  // An edit is kept across a reload, then saved as a new revision (approval needs a fresh review).
  const c3Priority = page.locator('#prp-c3-priority');
  await c3Priority.selectOption('low');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Save edits' })).toBeVisible();
  await expect(c3Priority).toHaveValue('low');
  await page.getByRole('button', { name: 'Save edits' }).click();
  await expect(page.getByText(/revision 2/).first()).toBeVisible();

  // Offline: the approval is not sent and the person is told; back online it works.
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Approve 5 change(s)' }).click();
  await expect(page.getByRole('alert')).toContainText(/offline/i);
  await page.context().setOffline(false);
  await page.getByRole('button', { name: 'Approve 5 change(s)' }).click();
  await expect(page.getByText(/Approved 5 change\(s\) of revision 2/)).toBeVisible();

  // Apply is explicit and atomic; the outcome names who applied and that AI proposed.
  await page.getByRole('button', { name: 'Apply 5 of 5 changes' }).click();
  await expect(page.getByText('Applied 5 change(s)')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Applied by you · proposed by AI/)).toBeVisible();
  const after = await (await page.request.get(`/v1/workspaces/${ws}/tasks/${task.id}`)).json();
  expect(after.data.priority).toBe('low');
  await expectAccessible(page, 'proposal-applied');
  await page.getByRole('link', { name: 'Draft the follow-up plan' }).first().click();
  await expect(page.getByRole('heading', { name: 'Draft the follow-up plan' })).toBeVisible();

  // The list shows the applied proposal; keyboard reaches the review controls.
  await page.goto(`/workspaces/${ws}/ai/proposals`);
  await expect(page.getByRole('link', { name: 'Plan the follow-up' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Your change proposals' })).toContainText('Applied');
  await propose(page, ws, [project.id, task.id]);
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await tabTo(page, "el && el.type === 'checkbox'");

  // Narrow widths, 200% zoom (half width), forced colours, reduced motion.
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  for (const width of [320, Math.max(320, Math.floor(size.width / 2))]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Plan the follow-up' })).toBeVisible();
    await expectNoOverflow(page, `Change proposal at ${width}px`);
  }
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await expectAccessible(page, 'proposal-narrow-forced');
  for (const control of await page.locator('.ai-panel button').all()) {
    const box = await control.boundingBox();
    if (box) expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await page.emulateMedia({ forcedColors: null, reducedMotion: null });
  await page.setViewportSize(size);
});
