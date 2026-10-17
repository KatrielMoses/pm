import { expect, test, type Page } from '@playwright/test';
import { api } from './goals-support.ts';
import { expectNoOverflow, tabTo } from './live-support.ts';
import { createBrand, createWorkspace, expectAccessible, owner, PASSWORD } from './support.ts';

/**
 * Phase 7B browser journey (desktop, tablet, mobile) against the real API, worker, and the
 * deterministic Messages protocol fixture (no provider is called; results are synthetic and
 * labelled). It proves the read-only grounded journey: context preview with AI off, include and
 * exclude, confirmation, a validated answer with working citations, deliberately invalid output
 * shown as unverified, offline recovery, keyboard, narrow widths, zoom, and forced colours.
 */
async function confirmStepUp(page: Page): Promise<void> {
  const stepUp = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(stepUp).toBeVisible();
  await stepUp.getByLabel(/^Password/).fill(PASSWORD);
  await stepUp.getByRole('button', { name: 'Confirm' }).click();
  await expect(stepUp).toBeHidden();
}

async function askAbout(page: Page, question: string): Promise<void> {
  await page.getByLabel('Question').fill(question);
  await page.getByRole('button', { name: 'Estimate cost' }).click();
  const estimate = page.getByRole('region', { name: 'Estimate' });
  await expect(estimate).toContainText('synthetic price');
  const ask = estimate.getByRole('button', { name: 'Ask' });
  await expect(ask).toBeDisabled();
  await estimate.getByLabel(/I confirm this answer may cost up to/).check();
  await ask.click();
}

test('AT-403 Phase 7B grounded journey: preview with AI off, include and exclude, an answer with honest trust labels and working citations, resilience', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await owner(page, info, 'ai7b', 'Riley Ash');
  const ws = await createWorkspace(page, 'Grounded Co');
  await createBrand(page, 'Harbor');
  const brand = (await (await page.request.get(`/v1/workspaces/${ws}/brands`)).json()).data[0]
    .id as string;
  const checklist = await api(page, 'POST', `/v1/workspaces/${ws}/tasks`, {
    brand,
    title: 'Harbor launch checklist',
  });
  const brief = await api(page, 'POST', `/v1/workspaces/${ws}/tasks`, {
    brand,
    title: 'Harbor partner brief',
  });

  // AI is off: the context preview still works, says AI cannot answer, and offers no question.
  await page.goto(`/workspaces/${ws}/ai/ask`);
  await expect(page.getByRole('heading', { name: 'Ask with sources' })).toBeVisible();
  await expect(page.getByText(/Semantic \(meaning-based\) search is not available/)).toBeVisible();
  await page.getByLabel('Also include (optional)').fill(`${checklist.id} ${brief.id}`);
  await page.getByRole('button', { name: 'Preview context' }).click();
  const sources = page.getByRole('list', { name: 'Context sources' });
  await expect(sources).toContainText('S1 · Task: Harbor launch checklist');
  await expect(sources).toContainText('S2 · Task: Harbor partner brief');
  await expect(page.getByText('AI is not available')).toBeVisible();
  await expect(page.getByLabel('Question')).toHaveCount(0);
  await expectAccessible(page, 'ask-ai-off');

  // Turn AI on with the synthetic fixture model (step-up), as an owner does in settings.
  await page.goto(`/workspaces/${ws}/settings/ai`);
  await page.getByLabel('Turn on AI for this workspace').check();
  await page.getByRole('button', { name: 'Save AI settings' }).click();
  await confirmStepUp(page);
  await expect(page.getByText('AI is available', { exact: true })).toBeVisible();

  // Preview, exclude one source (the preview updates), and ask with explicit confirmation.
  await page.goto(`/workspaces/${ws}/ai`);
  await page.getByRole('link', { name: 'Ask with sources' }).click();
  await page.getByLabel('Also include (optional)').fill(`${checklist.id} ${brief.id}`);
  await page.getByRole('button', { name: 'Preview context' }).click();
  await expect(sources).toContainText('S2 · Task: Harbor partner brief');
  await sources.getByLabel(/Task: Harbor partner brief/).uncheck();
  await expect(sources).toContainText('Excluded by you');
  await expect(page.getByText(/1 of 2 listed source\(s\) will be sent/)).toBeVisible();
  await askAbout(page, 'What is planned for the Harbor launch? #fixture:ok');
  const answer = page.locator('section[aria-labelledby="ask-answer-heading"]');
  await expect(answer).toContainText('Completed', { timeout: 30_000 });
  await expect(answer.getByRole('region', { name: 'Facts from the records' })).toContainText(
    'Status',
  );
  // Only record facts and calculations are established; an excerpt is verbatim source text, and
  // every other generated statement is labelled unverified even though it cites a source.
  await expect(
    answer.getByRole('region', { name: 'Exact excerpts from the sources' }),
  ).toBeVisible();
  await expect(
    answer.getByRole('region', { name: 'Unverified statements (generated)' }),
  ).toContainText('quoting the source');
  await expect(answer).toContainText(
    /Only facts and calculations from the records are established/,
  );
  await expect(answer.getByRole('region', { name: 'Unknown' })).toBeVisible();
  await expect(answer).toContainText(/do not guarantee it is true/);
  await expect(answer).not.toContainText('Harbor partner brief');
  await expectAccessible(page, 'ask-answer');
  // A citation opens the record through the person's current access.
  await answer
    .getByRole('link', { name: /S1: Harbor launch checklist/ })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${checklist.id}`));
  await expect(page.getByRole('heading', { name: 'Harbor launch checklist' })).toBeVisible();

  // Deliberately invalid output (a forged citation and a link) is shown as unverified text.
  await page.goto(`/workspaces/${ws}/ai/ask`);
  await page.getByLabel('Also include (optional)').fill(checklist.id);
  await page.getByRole('button', { name: 'Preview context' }).click();
  await expect(sources).toContainText('S1 · Task: Harbor launch checklist');
  await askAbout(page, 'Who approved the budget? #fixture:cite_forged');
  await expect(answer).toContainText('Completed', { timeout: 30_000 });
  const unverified = answer.getByRole('region', { name: 'Unverified statements (generated)' });
  await expect(unverified).toContainText('https://evil.example/collect');
  await expect(unverified.getByRole('link')).toHaveCount(0);
  await expect(answer).toContainText(/did not match the context were removed/);

  // A provider answer that stopped at max_tokens is never shown as an answer, even as valid JSON.
  await askAbout(page, 'Cut off? #fixture:truncate_valid');
  await expect(answer).toContainText('Partial: the answer is incomplete', { timeout: 30_000 });
  await expect(answer).toContainText('The answer is incomplete');
  await expect(answer.getByRole('region', { name: 'Exact excerpts from the sources' })).toHaveCount(
    0,
  );

  // Offline: nothing is sent and the person is told; back online the same action works.
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Preview context' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /Nothing was sent/ })).toBeVisible();
  await page.context().setOffline(false);
  await page.getByRole('button', { name: 'Preview context' }).click();
  await expect(sources).toContainText('S1 · Task: Harbor launch checklist');

  // Keyboard reaches the preview; narrow widths, 200% zoom, forced colours, reduced motion.
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await tabTo(page, "el && el.tagName === 'BUTTON' && el.textContent.includes('Preview context')");
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  for (const width of [320, Math.max(320, Math.floor(size.width / 2))]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/workspaces/${ws}/ai/ask`);
    await page.getByLabel('Also include (optional)').fill(checklist.id);
    await page.getByRole('button', { name: 'Preview context' }).click();
    await expect(sources).toContainText('Harbor launch checklist');
    await expectNoOverflow(page, `Ask with sources at ${width}px`);
  }
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await expectAccessible(page, 'ask-narrow-forced');
  for (const control of await page.locator('.ai-panel button').all()) {
    const box = await control.boundingBox();
    if (box) expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await page.emulateMedia({ forcedColors: null, reducedMotion: null });
  await page.setViewportSize(size);
});
