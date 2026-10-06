import { expect, test, type Page } from '@playwright/test';
import {
  createBrand,
  createWorkspace,
  expectAccessible,
  noHorizontalOverflow,
  owner,
} from './support.ts';

/**
 * Phase 2E exit experience on desktop, tablet, and mobile: a new person creates a workspace and a
 * brand, creates a useful project, captures tasks (button and keyboard, typed and pasted),
 * files them from a daily Inbox into the project, keeps a note and turns it into a task, and
 * submits an intake form, without configuration help. Every stage passes axe; capture survives
 * going offline; pages reflow at 320 px, the width-class edges, 200% zoom, forced colours, and
 * reduced motion.
 */

const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Capture' });

async function firstUse(page: Page, info: Parameters<typeof owner>[1], prefix: string) {
  await owner(page, info, prefix, 'Casey Capture');
  const ws = await createWorkspace(page, 'Capture Co');
  await createBrand(page, 'Harbor');
  return ws;
}

test('first use: brand, project, capture by button and keyboard, paste, daily Inbox, triage into the project', async ({
  page,
}, info) => {
  const ws = await firstUse(page, info, 'cap-first');
  // A useful project.
  await page.goto(`/workspaces/${ws}/projects`);
  await page.getByRole('button', { name: 'Create a project' }).click();
  const create = page.getByRole('dialog', { name: 'Create project' });
  await create.getByLabel(/^Project name/).fill('Spring launch');
  await create.getByRole('button', { name: 'Create project' }).click();
  await expect(h1(page)).toHaveText('Spring launch');
  // Capture from the header button with nothing configured.
  await page.getByRole('button', { name: 'Capture' }).click();
  await dialog(page)
    .getByLabel('What do you want to capture?')
    .fill('Write launch copy tomorrow !high 45m');
  await expect(dialog(page).getByText('Detected by simple rules', { exact: false })).toBeVisible();
  await expect(dialog(page).getByText(/from “!high”/)).toBeVisible();
  await expectAccessible(page, 'capture dialog with detected values');
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog(page).getByText('1 saved to your Inbox.')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  // Keyboard only: the c shortcut opens the same dialog; a multi-line paste becomes candidates.
  // Single-key shortcuts are on for fine pointers (the shell preference); everywhere the button is
  // reachable by keyboard.
  if (test.info().project.name === 'desktop') {
    await page.locator('main').focus();
    await page.keyboard.press('c');
  } else {
    await page.getByRole('button', { name: 'Capture' }).focus();
    await page.keyboard.press('Enter');
  }
  await expect(dialog(page)).toBeVisible();
  const area = dialog(page).getByLabel('What do you want to capture?');
  await area.focus();
  await page.evaluate(`(() => {
    const ta = document.activeElement;
    const data = new DataTransfer();
    data.setData('text', '- Book venue\\n- Order banners; print flyers');
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  })()`);
  await expect(dialog(page).getByLabel('Item 2')).toHaveValue('Order banners; print flyers');
  await dialog(page).getByRole('button', { name: 'Split item 2 at semicolons' }).click();
  await expect(dialog(page).getByLabel('Item 3')).toHaveValue('print flyers');
  await dialog(page).getByRole('button', { name: 'Save all items' }).click();
  await expect(dialog(page).getByText('3 saved to your Inbox.')).toBeVisible();
  await page.keyboard.press('Escape');
  // The daily Inbox: original text and source; file into the project.
  await page.goto(`/workspaces/${ws}/inbox`);
  await expect(h1(page)).toHaveText('Inbox');
  const items = page.getByRole('list', { name: 'Inbox items' });
  await expect(items.getByRole('listitem')).toHaveCount(4);
  await expect(items.getByText('Write launch copy tomorrow !high 45m')).toBeVisible();
  await expectAccessible(page, 'inbox');
  await items.getByRole('checkbox', { name: /Write launch copy/ }).check();
  await page.getByLabel('Brand', { exact: true }).selectOption({ label: 'Harbor' });
  await page.getByLabel('Project (optional)').selectOption({ label: 'Spring launch' });
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByRole('table', { name: 'What will happen' })).toContainText('Ready');
  await expectAccessible(page, 'triage preview');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(h1(page)).toHaveText('Write launch copy');
  await expect(page.getByText('High').first()).toBeVisible();
  // Merge two duplicates with a preview naming the kept one.
  await page.goto(`/workspaces/${ws}/inbox`);
  await items.getByRole('checkbox', { name: /Book venue/ }).check();
  await items.getByRole('checkbox', { name: /Order banners/ }).check();
  await page.getByRole('button', { name: 'Merge…' }).click();
  const merge = page.getByRole('dialog', { name: 'Merge items' });
  await merge.getByRole('button', { name: 'Preview merge' }).click();
  await expect(merge.getByRole('list', { name: 'Merge preview' })).toContainText(
    'Kept: “Book venue”',
  );
  await merge.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(page.getByText('Items merged.')).toBeAttached();
  // Three were left after filing one; merging two of them leaves two.
  await expect(items.getByRole('listitem')).toHaveCount(2);
  // Reflow and appearance.
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await page.reload();
  await expect(h1(page)).toHaveText('Inbox');
  await expectAccessible(page, 'inbox, forced colours');
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });
  const size = page.viewportSize()!;
  for (const width of [320, 599, 600, 1023, 1024, Math.max(320, Math.floor(size.width / 2))]) {
    await page.setViewportSize({ width, height: size.height });
    await page.goto(`/workspaces/${ws}/inbox`);
    await expect(h1(page)).toHaveText('Inbox');
    expect(await noHorizontalOverflow(page), `inbox at ${width}px`).toBeLessThanOrEqual(0);
  }
});

test('notes convert to tasks after confirmation; intake forms; capture survives going offline', async ({
  page,
}, info) => {
  const ws = await firstUse(page, info, 'cap-notes');
  await page.getByRole('button', { name: 'Capture' }).click();
  await dialog(page).getByRole('radio', { name: 'Note' }).check();
  await dialog(page)
    .getByLabel('What do you want to capture?')
    .fill('Pricing ideas\nTry a yearly plan');
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog(page).getByText('1 saved to your notes.')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await page.goto(`/workspaces/${ws}/notes`);
  await page.getByRole('link', { name: 'Pricing ideas' }).click();
  await expect(h1(page)).toHaveText('Pricing ideas');
  await page.getByLabel('Brand', { exact: true }).selectOption({ label: 'Harbor' });
  await expect(page.getByRole('button', { name: 'Create task' })).toBeDisabled();
  await page.getByRole('checkbox', { name: /I want to create this task/ }).check();
  await page.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByText('Created a task from this note.')).toBeAttached();
  await expect(
    page.getByRole('list', { name: 'Created from this note' }).getByRole('link'),
  ).toHaveCount(1);
  await expectAccessible(page, 'note with conversion');
  // Intake forms: create one and submit a request.
  await page.goto(`/workspaces/${ws}/forms`);
  await page.getByLabel('Brand', { exact: true }).selectOption({ label: 'Harbor' });
  await page.getByLabel('Form name').fill('Design requests');
  await page.getByRole('button', { name: 'Create form' }).click();
  await page.getByRole('link', { name: 'Design requests' }).click();
  await page.getByLabel('What do you need?').fill('New landing page');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByText('Request received.')).toBeAttached();
  await expectAccessible(page, 'intake form');
  await page.goto(`/workspaces/${ws}/inbox`);
  await expect(
    page.getByRole('list', { name: 'Inbox items' }).getByText(/Intake form/),
  ).toBeVisible();
  // Offline: the capture is kept and saves after reconnecting.
  await page.getByRole('button', { name: 'Capture' }).click();
  await dialog(page).getByLabel('What do you want to capture?').fill('Offline thought');
  await page.context().setOffline(true);
  await page.evaluate('window.dispatchEvent(new Event("offline"))');
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('Nothing was lost');
  await expect(dialog(page).getByLabel('What do you want to capture?')).toHaveValue(
    'Offline thought',
  );
  await page.context().setOffline(false);
  await page.evaluate('window.dispatchEvent(new Event("online"))');
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog(page).getByText('1 saved to your Inbox.')).toBeVisible();
});
