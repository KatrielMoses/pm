import { expect, test } from '@playwright/test';
import { createBrand, createWorkspace, expectAccessible, owner } from './support.ts';

test('previews a mapped project import, applies it, exports it, and rolls it back', async ({
  page,
}, info) => {
  await owner(page, info, 'csv', 'Casey Porter');
  const ws = await createWorkspace(page, 'Portability Co');
  await createBrand(page, 'Harbor');
  const response = await page.request.get(`/v1/workspaces/${ws}/brands`);
  const brands = await response.json();
  const brand = brands.data[0].id as string;
  await page.goto(`/workspaces/${ws}/settings/integrations`);
  await page.getByLabel('Record type', { exact: true }).selectOption('project');
  await page.getByLabel(/Column mapping/).fill('{"Summary":"name"}');
  await page.getByLabel('Save mapping name').fill('Legacy projects');
  await page.getByRole('button', { name: 'Save mapping', exact: true }).click();
  await expect(page.getByText('Mapping saved for your account.', { exact: true })).toBeVisible();
  await page.getByLabel(/CSV file/).setInputFiles({
    name: 'projects.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`schema_version,Summary,brand_id\n1,Imported project,${brand}\n`),
  });
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByText('1 valid rows; 0 rows need attention.')).toBeVisible();
  await expectAccessible(page, 'import-preview');
  await page.getByRole('button', { name: 'Apply import', exact: true }).click();
  await expect(page.getByLabel('Import row results')).toContainText('Row 2: Imported');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('workspace-projects.csv');
  await page.getByRole('button', { name: 'Roll back this import', exact: true }).click();
  await expect(
    page.getByText('The import was rolled back where records remained unchanged.', { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await expectAccessible(page, 'portability-narrow');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(
    true,
  );
});
