import { expect, test, type Page } from '@playwright/test';
import { queryUrl } from '@pm/test-support';
import { api, giveBrand, h1, person } from './goals-support.ts';
import { expectNoOverflow, removeBrandAccess, tabTo } from './live-support.ts';
import { createBrand, createWorkspace, expectAccessible, goTo, owner } from './support.ts';

/**
 * Phase 8B browser journeys (desktop, tablet, mobile) against the real web, API, and worker
 * processes and PostgreSQL. Nothing about agents is stubbed: a profile is created from a starter,
 * scoped, connected to a deterministic local peer (synthetic; never a real agent), tested by the
 * worker after confirmation, turned on, and assigned to a task through the structured preview.
 * Nothing runs an agent (8C). Key states are checked with keyboard and axe, 320 px and 200% zoom
 * (half width), forced colours with reduced motion, and an offline save.
 */

const admin = async (sql: string, params: unknown[] = []) =>
  (await queryUrl(process.env.PM_E2E_ADMIN_URL!, sql, params)).rows as Array<Record<string, any>>;

/** Configures a named synthetic peer on the local connector fixture. */
async function peer(name: string, secret: string) {
  const r = await fetch(`${process.env.PM_E2E_AGENT_URL}/control/peers`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.PM_E2E_AGENT_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name,
      peer: {
        kind: 'api',
        secret,
        tools: [
          { name: 'pm.tasks.get', version: '1' },
          { name: 'pm.documents.draft', version: '1' },
        ],
      },
    }),
  });
  expect(r.status).toBe(204);
  return `${process.env.PM_E2E_AGENT_URL}/peer/${name}`;
}

async function setup(page: Page, info: Parameters<typeof owner>[1], prefix: string) {
  await owner(page, info, prefix, 'Avery Owner');
  const ws = await createWorkspace(page, 'Agent Co');
  await createBrand(page, 'Harbor');
  const base = `/v1/workspaces/${ws}`;
  const brands = (await (await page.request.get(`${base}/brands`)).json()).data as Array<{
    id: string;
    name: string;
  }>;
  const brand = brands.find((b) => b.name === 'Harbor')!.id;
  const task = await api(page, 'POST', `${base}/tasks`, { brand, title: 'Write launch notes' });
  return { ws, base, brand, task: task.id as string };
}

test('AT-632 Phase 8B agent journey: starter, scope, a synthetic connector test, activation, task assignment by preview, offline, accessibility', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  const { ws, task } = await setup(page, info, 'agt8b');
  const name = `dev-${info.project.name}-${info.retry}-${Date.now() % 100000}`;
  const secret = `fixture-secret-${name}`;
  const endpoint = await peer(name, secret);

  // Discoverable from the shell navigation; an empty list explains itself.
  await goTo(page, 'Agents');
  await expect(h1(page)).toHaveText('Agents');
  await expect(page.getByText('No agents yet.')).toBeVisible();
  await expectAccessible(page, 'agents-empty');

  // A starter makes a turned-off draft with no scope.
  const form = page.getByRole('form', { name: 'New agent' });
  await form.getByLabel('Start from').selectOption({ label: 'Development agent' });
  await expect(form.getByText(/Starts turned off with no scope/)).toBeVisible();
  await form.getByRole('button', { name: 'Create agent' }).click();
  await expect(h1(page)).toHaveText('Development agent');
  const id = /\/agents\/(agt_[0-9A-Z]{26})/.exec(page.url())![1]!;
  const missing = page.getByRole('list', { name: 'Missing configuration' });
  await expect(missing.getByText(/Choose at least one brand/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on' })).toBeDisabled();
  // A tool from a later phase is listed, never grantable; the floor cannot be weakened.
  await expect(page.getByLabel(/pm.tests.run/)).toBeDisabled();
  await expect(
    page.getByLabel('Draft content').locator('option', { hasText: 'No approval' }),
  ).toBeDisabled();
  await expectAccessible(page, 'agent-editor-draft');

  // Scope: exactly one brand.
  await page.getByRole('group', { name: 'Brands' }).getByLabel('Harbor').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeAttached();
  await expect(missing.getByText(/Configure and test a connection/)).toBeVisible();

  // The connection: an API peer on the local fixture, tested only after confirmation.
  const conn = page.getByRole('form', { name: 'Connection settings' });
  await conn.getByLabel('Connection type').selectOption('api');
  await conn.getByLabel('Endpoint URL').fill(endpoint);
  await conn.getByLabel(/Shared secret/).fill(secret);
  await conn.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByText('Configured, not tested')).toBeVisible();
  await expect(conn.getByLabel(/Replace the shared secret/)).toHaveValue('');
  await conn.getByRole('button', { name: 'Test connection' }).click();
  const confirm = page.getByRole('dialog', { name: 'Test this connection?' });
  await expect(confirm.getByText(/No task, record, or credential is sent/)).toBeVisible();
  await confirm.getByRole('button', { name: 'Send test' }).click();
  await expect(
    page
      .getByRole('status', { name: 'Connection test' })
      .getByText(/passed · synthetic \(local test agent\)/),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Verified', { exact: true })).toBeVisible();
  const stored = await admin(
    `SELECT c.state, c.verified_synthetic, c.secret_ref IS NOT NULL AS has_ref, c.endpoint_url
       FROM agents.agent_connector c JOIN core.record r ON r.id = c.profile_id WHERE r.public_id = $1`,
    [id],
  );
  expect(stored).toEqual([
    { state: 'verified', verified_synthetic: true, has_ref: true, endpoint_url: endpoint },
  ]);

  // Turned on: ready, synthetic, and nothing runs.
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByText('The agent is on.')).toBeAttached();
  const readiness = page.getByLabel('Readiness').first();
  await expect(readiness.getByText('Ready', { exact: true })).toBeVisible();
  await expect(readiness.getByText(/Verified against a local test agent only/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Active version 1' })).toBeVisible();
  await expect(page.getByText(/Nothing runs yet/).first()).toBeVisible();
  await expectAccessible(page, 'agent-active');

  // Offline: an edit is kept on this device and the person is told.
  const instructions = page.getByLabel('Instructions');
  await instructions.fill('Work only on the assigned task and return drafts.');
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByText(/You are offline. Your edits are kept on this device/).first(),
  ).toBeVisible();
  await expect(instructions).toHaveValue('Work only on the assigned task and return drafts.');
  await page.context().setOffline(false);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeAttached();

  // The task's Agent section: preview first, then assign.
  await page.goto(`/workspaces/${ws}/tasks/${task}`);
  await expect(h1(page)).toHaveText('Write launch notes');
  const section = page.locator('section.ag-task');
  await expect(section.getByText('No agents assigned.')).toBeVisible();
  const assign = section.getByRole('form', { name: 'Assign an agent' });
  await assign.getByLabel('Agent').selectOption({ label: 'Development agent' });
  await assign.getByLabel('Goal').fill('Draft the launch notes from the task.');
  await assign.getByLabel(/Acceptance criteria/).fill('Mentions the date');
  await expect(assign.getByRole('button', { name: 'Assign' })).toBeDisabled();
  await assign.getByRole('button', { name: 'Preview' }).click();
  const preview = assign.getByRole('region', { name: 'Assignment preview' });
  await expect(preview.getByText('Write launch notes')).toBeVisible();
  await expect(preview.getByText('Ready', { exact: true })).toBeVisible();
  await expectAccessible(page, 'task-agent-preview');
  await assign.getByRole('button', { name: 'Assign' }).click();
  const items = section.getByRole('list', { name: 'Assigned agents' });
  await expect(items.getByText('Assigned', { exact: true })).toBeVisible();
  await expect(items.getByText('Draft the launch notes from the task.')).toBeVisible();
  const rows = await admin(
    `SELECT a.state FROM agents.agent_assignment a JOIN core.record r ON r.id = a.task_id WHERE r.public_id = $1`,
    [task],
  );
  expect(rows).toEqual([{ state: 'assigned' }]);
  // No agent run exists: nothing was dispatched.
  expect(
    await admin(
      `SELECT count(*)::int AS n FROM exec.job WHERE kind LIKE 'agent%' AND kind <> 'agents.connector_test'`,
    ),
  ).toEqual([{ n: 0 }]);

  // Keyboard, narrow widths, 200% zoom, forced colours, reduced motion.
  await page.goto(`/workspaces/${ws}/agents/${id}`);
  await expect(h1(page)).toHaveText('Development agent');
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await tabTo(page, "el && el.id === 'ag-e-instructions'");
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  for (const width of [320, Math.max(320, Math.floor(size.width / 2))]) {
    await page.setViewportSize({ width, height: 800 });
    for (const [path, title] of [
      [`/workspaces/${ws}/agents`, 'Agents'],
      [`/workspaces/${ws}/agents/${id}`, 'Development agent'],
      [`/workspaces/${ws}/tasks/${task}`, 'Write launch notes'],
    ] as const) {
      await page.goto(path);
      await expect(h1(page)).toHaveText(title);
      await expectNoOverflow(page, `${title} at ${width}px`);
    }
  }
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await expectAccessible(page, 'task-agents-narrow-forced');
  await page.goto(`/workspaces/${ws}/agents/${id}`);
  await expect(h1(page)).toHaveText('Development agent');
  await expectAccessible(page, 'agent-editor-narrow-forced');
  await page.emulateMedia({ forcedColors: null, reducedMotion: null });
  await page.setViewportSize(size);

  // Withdraw after confirmation.
  await page.goto(`/workspaces/${ws}/tasks/${task}`);
  await section
    .getByRole('list', { name: 'Assigned agents' })
    .getByRole('button', { name: 'Withdraw' })
    .click();
  await page
    .getByRole('alertdialog', { name: 'Withdraw Development agent?' })
    .getByRole('button', { name: 'Withdraw' })
    .click();
  await expect(section.getByText('No agents assigned.')).toBeVisible();

  // An unknown agent is the same opaque answer as a hidden one.
  await page.goto(`/workspaces/${ws}/agents/agt_01HZZZZZZZZZZZZZZZZZZZZZZZ`);
  await expect(h1(page)).toHaveText("This page isn't available");
});

test('AT-633 Phase 8B a member without the agent policy sees agents and readiness but no configuration, and cannot assign outside their access @desktop-only', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180_000);
  const { ws, base, task } = await setup(page, info, 'agt8b-mem');
  await api(page, 'POST', `${base}/agents`, { template: 'research', name: 'Owner research' });
  const mia = await person(browser, page, ws, info, 'agt8b-mia', 'Mia Member', 'Member');
  await mia.page.goto(`/workspaces/${ws}/agents`);
  await expect(h1(mia.page)).toHaveText('Agents');
  await expect(mia.page.getByRole('link', { name: 'Owner research' })).toBeVisible();
  await expect(mia.page.getByRole('form', { name: 'New agent' })).toHaveCount(0);
  await mia.page.getByRole('link', { name: 'Owner research' }).click();
  await expect(h1(mia.page)).toHaveText('Owner research');
  await expect(mia.page.getByLabel('Instructions')).toHaveCount(0);
  await expect(mia.page.getByRole('button', { name: 'Turn on' })).toHaveCount(0);
  await expectAccessible(mia.page, 'agent-member-view');
  // Mia has no access to the task's brand: the task is the one opaque answer.
  await mia.page.goto(`/workspaces/${ws}/tasks/${task}`);
  await expect(h1(mia.page)).toHaveText("This page isn't available");
  await mia.ctx.close();
});

test('AT-642 Phase 8B review 01: an assigner downgraded to view leaves their assignment blocked on the task panel, with no hidden scope counted @desktop-only', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180_000);
  const { ws, base, brand, task } = await setup(page, info, 'agt8b-r01');
  const name = `r01-${info.retry}-${Date.now() % 100000}`;
  const secret = `fixture-secret-${name}`;
  const endpoint = await peer(name, secret);
  // A ready external agent (synthetic fixture), configured by the owner through the API.
  const made = await api(page, 'POST', `${base}/agents`, { template: 'development' });
  await api(
    page,
    'PATCH',
    `${base}/agents/${made.id}`,
    { draft: { ...made.draft, scope: { brands: [brand] } } },
    made.version,
  );
  await api(page, 'POST', `${base}/agents/${made.id}/connector`, {
    kind: 'api',
    endpoint_url: endpoint,
    secret,
  });
  const current = (await (await page.request.get(`${base}/agents/${made.id}`)).json()).data;
  await api(page, 'POST', `${base}/agents/${made.id}:activate`, {}, current.version);
  const t = await api(page, 'POST', `${base}/agents/${made.id}/connector:test`, { confirm: true });
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`${base}/agents/${made.id}/connector-tests/${t.test.id}`)
          ).json()
        ).data.test.state,
      { timeout: 30_000 },
    )
    .toBe('passed');
  const mia = await person(browser, page, ws, info, 'agt8b-r01-mia', 'Mia Member', 'Member');
  await giveBrand(page, ws, 'Harbor', 'Mia Member', 'edit');
  await mia.page.goto(`/workspaces/${ws}/tasks/${task}`);
  await expect(h1(mia.page)).toHaveText('Write launch notes');
  await api(mia.page, 'POST', `${base}/tasks/${task}/agents`, {
    profile: made.id,
    goal: 'Draft the notes.',
  });
  await page.goto(`/workspaces/${ws}/tasks/${task}`);
  const section = page.locator('section.ag-task');
  const items = section.getByRole('list', { name: 'Assigned agents' });
  await expect(items.getByText('Assigned', { exact: true })).toBeVisible();
  // Mia keeps view access (she still reads the task) but can no longer assign on it.
  await removeBrandAccess(page, ws, 'Harbor', 'Mia Member');
  await giveBrand(page, ws, 'Harbor', 'Mia Member', 'view');
  await page.goto(`/workspaces/${ws}/tasks/${task}`);
  await expect(items.getByText('Blocked', { exact: true })).toBeVisible();
  await expect(items.getByText(/can no longer assign agents on this task/)).toBeVisible();
  await expect(items).not.toContainText(/more items?|you cannot open\b/);
  await expectAccessible(page, 'task-agent-blocked-assigner');
  // Mia reads the task and sees it blocked too, with no assign form.
  await mia.page.goto(`/workspaces/${ws}/tasks/${task}`);
  const hers = mia.page.locator('section.ag-task');
  await expect(
    hers.getByRole('list', { name: 'Assigned agents' }).getByText('Blocked', { exact: true }),
  ).toBeVisible();
  await expect(hers.getByRole('form', { name: 'Assign an agent' })).toHaveCount(0);
  await mia.ctx.close();
});
