import { expect, test, type Page } from '@playwright/test';
import { api } from './goals-support.ts';
import { expectNoOverflow, tabTo } from './live-support.ts';
import { createBrand, createWorkspace, expectAccessible, owner, PASSWORD } from './support.ts';

/**
 * Phase 7C browser journeys (desktop, tablet, mobile) against the real API, worker, and the
 * deterministic Messages protocol fixture (no provider is called; results are synthetic and
 * labelled). They prove one action surface: scoped entry from a task page, extraction with honest
 * labels, offline recovery, and a project plan drafted from a brief, reviewed, edited, and applied
 * once into real records, with keyboard, narrow widths, zoom, and forced colours.
 */
async function confirmStepUp(page: Page): Promise<void> {
  const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(stepUp).toBeVisible();
  await stepUp.getByLabel(/^Password/).fill(PASSWORD);
  await stepUp.getByRole('button', { name: 'Confirm' }).click();
  await expect(stepUp).toBeHidden();
}

async function setup(page: Page, info: Parameters<typeof owner>[1], prefix: string) {
  await owner(page, info, prefix, 'Jordan Reyes');
  const ws = await createWorkspace(page, 'Assist Co');
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
    description: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'We decided to ship on Friday. The vendor risk may delay us. Who signs off?',
            },
          ],
        },
      ],
    },
  });
  await page.goto(`/workspaces/${ws}/settings/ai`);
  await page.getByLabel('Turn on AI for this workspace').check();
  await page.getByRole('button', { name: 'Save AI settings' }).click();
  await confirmStepUp(page);
  await expect(page.getByText('AI is available', { exact: true })).toBeVisible();
  return { ws, brand, project, task };
}

async function runAction(page: Page) {
  await page.getByRole('button', { name: 'Preview context' }).click();
  await expect(page.getByRole('list', { name: 'Context sources' })).toContainText('S1');
  await page.getByRole('button', { name: 'Estimate cost' }).click();
  const estimate = page.getByRole('region', { name: 'Estimate' });
  await expect(estimate).toContainText('synthetic price');
  await estimate.getByLabel(/I confirm this/).check();
  await estimate.getByRole('button', { name: /^Run / }).click();
}

test('AT-447 Phase 7C summary and extraction journey: scoped entry from a task, typed results with honest labels, offline recovery, accessibility', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const { ws, task } = await setup(page, info, 'ai7c');
  // The task page offers AI assist with the task preselected; preview works before anything runs.
  await page.goto(`/workspaces/${ws}/tasks/${task.id}`);
  await page.getByRole('link', { name: 'AI assist' }).click();
  await expect(page.getByRole('heading', { name: 'AI assist' })).toBeVisible();
  await expect(page.getByLabel('Task (optional)')).toHaveValue(task.id);
  await page.getByLabel('Action', { exact: true }).selectOption('extract.v1');
  await expect(page.getByText(/Read-only: nothing changes/)).toBeVisible();
  await expectAccessible(page, 'assist-start');
  await runAction(page);
  const result = page.locator('section[aria-labelledby="assist-result-heading"]');
  await expect(result).toContainText('Completed', { timeout: 30_000 });
  const generated = result.getByRole('region', { name: 'Generated suggestions' });
  await expect(generated).toContainText('Decision (candidate)');
  await expect(generated).toContainText('Risk');
  await expect(generated).toContainText('the source says');
  await expect(result).toContainText(/Every generated item is a suggestion/);
  await expectAccessible(page, 'assist-extract');
  // A summary of the same context, then offline: nothing is sent and the person is told.
  await page.getByLabel('Action', { exact: true }).selectOption('summarize.v1');
  await runAction(page);
  await expect(result.getByRole('region', { name: 'Generated suggestions' })).toContainText(
    'Summary',
    { timeout: 30_000 },
  );
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Preview context' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /Nothing was sent/ })).toBeVisible();
  await page.context().setOffline(false);
  await page.getByRole('button', { name: 'Preview context' }).click();
  await expect(page.getByRole('list', { name: 'Context sources' })).toContainText('S1');
  // Keyboard, narrow widths, 200% zoom, forced colours, reduced motion.
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await tabTo(page, "el && el.id === 'assist-action'");
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  for (const width of [320, Math.max(320, Math.floor(size.width / 2))]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/workspaces/${ws}/ai/assist?task=${task.id}`);
    await expect(page.getByRole('heading', { name: 'AI assist' })).toBeVisible();
    await expectNoOverflow(page, `AI assist at ${width}px`);
  }
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await expectAccessible(page, 'assist-narrow-forced');
  for (const control of await page.locator('.ai-panel button').all()) {
    const box = await control.boundingBox();
    if (box) expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await page.emulateMedia({ forcedColors: null, reducedMotion: null });
  await page.setViewportSize(size);
});

test('AT-448 Phase 7C PRJ-016 journey: a brief becomes an editable plan, a value is changed, and the plan is applied once into real records', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const { ws, brand } = await setup(page, info, 'ai7cp');
  await page.goto(`/workspaces/${ws}/ai/assist`);
  await page.getByLabel('Action', { exact: true }).selectOption('draft_project.v1');
  await page.getByLabel('Project brief').fill('Open the Harbor beta to early customers.');
  await page.getByLabel('Harbor', { exact: true }).check();
  await page.getByRole('button', { name: 'Preview context' }).click();
  await page.getByRole('button', { name: 'Estimate cost' }).click();
  const estimate = page.getByRole('region', { name: 'Estimate' });
  await estimate.getByLabel(/I confirm this/).check();
  await estimate.getByRole('button', { name: /^Run / }).click();
  const review = page.getByRole('link', { name: 'Review the proposed changes' });
  await expect(review).toBeVisible({ timeout: 30_000 });
  await review.click();
  await expect(
    page.getByRole('heading', { name: /Project plan: Open the Harbor beta/ }),
  ).toBeVisible();
  await expect(page.getByText(/AI-generated/)).toBeVisible();
  await expectAccessible(page, 'plan-review');
  // Change a proposed value, save it as a revision, approve, and apply explicitly.
  await page.locator('#prp-c2-title').fill('Define the Harbor beta scope');
  await page.getByRole('button', { name: 'Save edits' }).click();
  await expect(page.getByText(/Saved as revision/)).toBeVisible();
  await page.getByRole('button', { name: /^Approve \d+ change\(s\)$/ }).click();
  await page.getByRole('button', { name: /^Apply \d+ of \d+ changes$/ }).click();
  await expect(page.getByText(/^Applied \d+ change\(s\)$/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Applied by you · proposed by AI/)).toBeVisible();
  // The records exist, as AI drafts the person created.
  const projects = (
    await (await page.request.get(`/v1/workspaces/${ws}/projects?brand=${brand}`)).json()
  ).data as Array<{ name: string; id: string }>;
  const plan = projects.find((p) => p.name === 'Plan: Open the Harbor beta to early customers.')!;
  expect(plan).toBeTruthy();
  await page.getByRole('link', { name: 'Define the Harbor beta scope' }).first().click();
  await expect(page.getByRole('heading', { name: 'Define the Harbor beta scope' })).toBeVisible();
});
