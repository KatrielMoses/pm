import { expect, test } from '@playwright/test';
import { createWorkspace, expectAccessible, owner } from './support.ts';

test('connects with an API key, sees status, and disconnects', async ({ page }, info) => {
  test.setTimeout(180_000);
  await owner(page, info, 'int', 'Ivy Integrator');
  const ws = await createWorkspace(page, 'Integrations Co');
  await page.goto(`/workspaces/${ws}/settings/integrations`);
  await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Desk loopback');
  await page.getByLabel('API key').fill('loopback-token');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('Status: Connected')).toBeVisible();
  await expect(page.getByText(/Owner:/)).toBeVisible();
  await expect(page.getByText(/Scopes:/)).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByText('Status: Disconnected')).toBeVisible();
  await expect(page.getByText('loopback-token')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name: 'MCP access' })).toBeVisible();
  await expect(page.getByText(/Workspace endpoint:/)).toBeVisible();
  await expectAccessible(page, 'integrations');
});
