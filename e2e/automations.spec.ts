import { expect, test, type Page } from '@playwright/test';
import { queryUrl } from '@pm/test-support';
import { api, giveBrand, h1, person } from './goals-support.ts';
import { expectNoOverflow, removeBrandAccess, tabTo } from './live-support.ts';
import { createBrand, createWorkspace, expectAccessible, goTo, owner } from './support.ts';

/**
 * Phase 8A browser journeys (desktop, tablet, mobile) against the real web, API, and worker
 * processes and PostgreSQL. Nothing about automations is stubbed: a rule is built from a starter,
 * previewed, turned on, triggered by a real task update, branches and waits (the wait is ended
 * early by moving the stored wake time, as the Phase 7 schedules are), is refused by a real
 * lifecycle rule, and is retried safely once the cause is fixed. Key states are checked with
 * keyboard and axe, 320 px and 200% zoom (half width), forced colours with reduced motion, offline
 * saves, and the loss of access to the automation's brand.
 */

test.use({ timezoneId: 'UTC' });

/** Inspection (and delay time control) past RLS, as the Phase 1 and Phase 7 journeys do. */
const admin = async (sql: string, params: unknown[] = []) =>
  (await queryUrl(process.env.PM_E2E_ADMIN_URL!, sql, params)).rows as Array<Record<string, any>>;

const runOf = async (automation: string) =>
  (
    await admin(
      `SELECT r.status, r.reason, r.wake_at, o.public_id
         FROM automation.automation_run r
         JOIN core.record c ON c.id = r.automation_id
         JOIN exec.operation o ON o.id = r.operation_id
        WHERE c.public_id = $1
        ORDER BY r.created_at DESC LIMIT 1`,
      [automation],
    )
  )[0] as
    { status: string; reason: string | null; wake_at: Date | null; public_id: string } | undefined;

/** Ends a run's wait now (the worker continues it on its next poll). */
const wake = async (automation: string) => {
  await admin(
    `UPDATE automation.automation_run r SET wake_at = now() - interval '1 second'
       FROM core.record c WHERE c.id = r.automation_id AND c.public_id = $1 AND r.wake_at IS NOT NULL`,
    [automation],
  );
  await admin(
    `UPDATE exec.job SET run_at = now() WHERE kind = 'automation.run' AND state = 'queued'`,
  );
};

async function setup(page: Page, info: Parameters<typeof owner>[1], prefix: string) {
  await owner(page, info, prefix, 'Avery Owner');
  const ws = await createWorkspace(page, 'Automate Co');
  await createBrand(page, 'Harbor');
  const base = `/v1/workspaces/${ws}`;
  const brand = (await (await page.request.get(`${base}/brands`)).json()).data[0].id as string;
  const project = await api(page, 'POST', `${base}/projects`, { brand, name: 'Harbor launch' });
  return { ws, base, brand, project };
}

/** Creates a draft from a starter on the list page and opens its builder. */
async function fromStarter(page: Page, ws: string, name: string, starter: string) {
  await page.goto(`/workspaces/${ws}/automations`);
  const form = page.getByRole('form', { name: 'New automation' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Start from').selectOption({ label: starter });
  await form.getByRole('button', { name: 'Create draft' }).click();
  await expect(h1(page)).toHaveText(name);
  return /\/automations\/(auto_[0-9A-Z]{26})/.exec(page.url())![1]!;
}

test('AT-580 Phase 8A automation journey: starter, preview, activation, a real trigger, branch and wait, a refused step, a safe retry, offline, accessibility', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  const { ws, base, brand, project } = await setup(page, info, 'aut8a');
  // Discoverable from the shell navigation.
  await goTo(page, 'Automations');
  await expect(h1(page)).toHaveText('Automations');
  await expect(page.getByText('No automations yet.')).toBeVisible();
  await expect(page.getByText('Plan limit', { exact: true })).toBeVisible();
  await expect(page.getByText('Not available yet')).toBeVisible();
  await expectAccessible(page, 'automations-empty');

  const id = await fromStarter(page, ws, 'Follow up', 'Follow up when a task is done');
  const draft = page.getByRole('form', { name: 'Edit draft' });
  // Future sources and agent workflows are shown where they would be chosen, never usable.
  await expect(
    draft.getByLabel('Trigger').locator('option', { hasText: 'A test result arrives' }),
  ).toBeDisabled();
  // The starter waits a day: wait one minute instead, and fail the run if the follow-up is refused.
  await draft.getByLabel('Minutes to wait').fill('1');
  const followUp = draft.getByRole('group', { name: 'Step 2: follow_up' });
  await followUp.getByLabel('Not permitted').uncheck();
  await followUp.getByLabel('Not valid').uncheck();
  await expect(
    followUp.getByText('Without a fallback, a failed step ends the run as failed.'),
  ).toBeVisible();
  await expect(
    followUp.getByLabel('Action').locator('option', { hasText: 'Run an agent workflow' }),
  ).toBeDisabled();
  // A first step that branches on priority: high-priority work waits and follows up; the rest stops.
  await draft.getByRole('button', { name: 'Add step' }).click();
  const added = draft.getByRole('group', { name: 'Step 3: step3' });
  await added.getByLabel('Kind').selectOption({ label: 'Branch on a condition' });
  await added.getByLabel('If met, go to').selectOption({ label: 'Step "wait"' });
  await added.getByLabel('Otherwise, go to').selectOption({ label: 'Stop' });
  await added.getByRole('button', { name: 'Move up step step3' }).click();
  await draft
    .getByRole('group', { name: 'Step 2: step3' })
    .getByRole('button', { name: 'Move up step step3' })
    .click();
  await expect(draft.getByRole('group', { name: 'Step 1: step3' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on' })).toBeDisabled();
  await draft.getByRole('button', { name: 'Save draft' }).click();
  await expect(draft.getByText('Saved.', { exact: true })).toBeVisible();
  await expectAccessible(page, 'automation-builder');

  // Preview with a real task changes nothing and says what would happen.
  const task = await api(page, 'POST', `${base}/tasks`, {
    brand,
    project: project.id,
    title: 'Harbor press kit',
    priority: 'high',
  });
  await page.getByLabel('Record to try it with').fill(task.id);
  await page.getByRole('button', { name: 'Preview' }).click();
  const preview = page.getByRole('region', { name: 'Preview result' });
  await expect(preview).toContainText('Conditions: met');
  await expect(preview).toContainText('step3 — conditions met');
  await expect(preview).toContainText('wait — would wait');
  expect(
    await admin(
      `SELECT 1 FROM automation.automation_run r JOIN core.record c ON c.id = r.automation_id WHERE c.public_id = $1`,
      [id],
    ),
  ).toEqual([]);

  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByText('Automation is on.')).toBeAttached();
  await expect(page.getByText(/Active · version 1 in use/)).toBeVisible();

  // A real task update triggers it: the branch is met and the run waits without holding anything.
  await api(page, 'POST', `${base}/tasks/${task.id}:complete`, {}, task.version);
  await expect.poll(async () => (await runOf(id))?.reason, { timeout: 30_000 }).toBe('delay');
  // While it waits, the project is archived: the follow-up can no longer be created there.
  await api(page, 'POST', `${base}/projects/${project.id}:archive`, {}, project.version);
  await wake(id);
  await expect.poll(async () => (await runOf(id))?.status, { timeout: 30_000 }).toBe('failed');
  const runId = (await runOf(id))!.public_id;

  // History explains the run and its steps, and offers a retry of the failed step only.
  await page.reload();
  const history = page.getByRole('list', { name: 'Runs' });
  await expect(history.getByText('Failed', { exact: true })).toBeVisible();
  await history.getByRole('link').first().click();
  await expect(h1(page)).toHaveText('Run of Follow up');
  const steps = page.getByRole('region', { name: 'Steps table' });
  for (const node of ['step3', 'wait', 'follow_up']) await expect(steps).toContainText(node);
  await expect(
    page.getByText(/retry runs the failed step again|Earlier steps are kept/),
  ).toBeVisible();
  await expectAccessible(page, 'automation-run-failed');
  // Restore the project, then retry: the follow-up is created exactly once.
  const archived = await (await page.request.get(`${base}/projects/${project.id}`)).json();
  await api(page, 'POST', `${base}/projects/${project.id}:unarchive`, {}, archived.data.version);
  await page.getByRole('button', { name: 'Retry from the failed step' }).click();
  await expect(page.getByText(/^(Queued|Running|Succeeded) · version 1$/)).toBeVisible();
  await expect.poll(async () => (await runOf(id))?.status, { timeout: 30_000 }).toBe('succeeded');
  await page.reload();
  await expect(page.getByText('Succeeded', { exact: true })).toBeVisible();
  const followUps = await admin(
    `SELECT r.source_kind, r.created_by_actor_type
       FROM work.task t JOIN core.record r ON r.id = t.id
       JOIN tenancy.workspace w ON w.id = t.workspace_id
      WHERE t.title = 'Follow up on completed work' AND w.public_id = $1`,
    [ws],
  );
  // Created exactly once, and attributed to the automation rather than to the person.
  expect(followUps).toEqual([{ source_kind: 'automation', created_by_actor_type: 'automation' }]);
  expect(runId).toMatch(/^op_/);

  // Offline: the draft edit is kept and the person is told; back online it saves.
  await page.goto(`/workspaces/${ws}/automations/${id}`);
  const name = page.getByRole('form', { name: 'Edit draft' }).getByLabel('Name');
  await name.fill('Follow up on done work');
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText(/You are offline. Your edits are kept on this device/)).toBeVisible();
  await expect(name).toHaveValue('Follow up on done work');
  await page.context().setOffline(false);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  // The version in use is unchanged until the draft is turned on.
  await expect(page.getByText(/Active · version 1 in use/)).toBeVisible();

  // An unknown automation is the same opaque answer as a hidden one.
  await page.goto(`/workspaces/${ws}/automations/auto_01HZZZZZZZZZZZZZZZZZZZZZZZ`);
  await expect(h1(page)).toHaveText("This page isn't available");

  // Keyboard, narrow widths, 200% zoom, forced colours, reduced motion.
  await page.goto(`/workspaces/${ws}/automations/${id}`);
  await expect(h1(page)).toHaveText('Follow up on done work');
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await tabTo(page, "el && el.id === 'au-edit-name'");
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  for (const width of [320, Math.max(320, Math.floor(size.width / 2))]) {
    await page.setViewportSize({ width, height: 800 });
    for (const [path, title] of [
      [`/workspaces/${ws}/automations`, 'Automations'],
      [`/workspaces/${ws}/automations/${id}`, 'Follow up on done work'],
      [`/workspaces/${ws}/automations/${id}/runs/${runId}`, 'Run of Follow up on done work'],
    ] as const) {
      await page.goto(path);
      await expect(h1(page)).toHaveText(title);
      await expectNoOverflow(page, `${title} at ${width}px`);
    }
  }
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await expectAccessible(page, 'automation-run-narrow-forced');
  await page.goto(`/workspaces/${ws}/automations/${id}`);
  await expect(h1(page)).toHaveText('Follow up on done work');
  await expectAccessible(page, 'automation-builder-narrow-forced');
  await page.emulateMedia({ forcedColors: null, reducedMotion: null });
  await page.setViewportSize(size);
});

test('AT-581 Phase 8A access loss: a brand manager configures an automation, loses the brand, and sees only the opaque view @desktop-only', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(240_000);
  const { ws } = await setup(page, info, 'aut8a-loss');
  const mia = await person(browser, page, ws, info, 'aut8a-mia', 'Mia Manager', 'Member');
  await giveBrand(page, ws, 'Harbor', 'Mia Manager', 'manage');
  const id = await fromStarter(mia.page, ws, 'Mia rule', 'Follow up when a task is done');
  const name = mia.page.getByRole('form', { name: 'Edit draft' }).getByLabel('Name');
  await name.fill('Mia rule, edited');
  // The owner removes Mia's access to Harbor while her edit is unsaved.
  await removeBrandAccess(page, ws, 'Harbor', 'Mia Manager');
  await mia.page.getByRole('button', { name: 'Save draft' }).click();
  await expect(mia.page.getByText('This automation is not available.')).toBeVisible();
  await mia.page.reload();
  await expect(h1(mia.page)).toHaveText("This page isn't available");
  await mia.page.goto(`/workspaces/${ws}/automations`);
  await expect(mia.page.getByText('No automations yet.')).toBeVisible();
  await expectAccessible(mia.page, 'automations-after-access-loss');
  // The owner still sees it, unchanged by the refused edit.
  await page.goto(`/workspaces/${ws}/automations/${id}`);
  await expect(h1(page)).toHaveText('Mia rule');
  await mia.ctx.close();
});
