import { expect, test } from '@playwright/test';

test('renders the application foundation shell connected to the API', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  const response = await page.goto('/status');
  expect(response?.headers()['content-security-policy']).toContain("default-src 'self'");
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('PM');
  await expect(page.getByTestId('status')).toContainText('Connected');
  await expect(page.getByTestId('build')).toHaveText('Version 0.1.0 · build e2e');
  // The anonymous session probe (GET /v1/auth/me -> 401) is expected; anything else is a defect.
  expect(errors.filter((e) => !/401 \(Unauthorized\)/.test(e))).toEqual([]);
});

test('shows the degraded state with a retry action', async ({ page }) => {
  await page.route('**/v1/status', (route) =>
    route.fulfill({
      json: {
        data: {
          type: 'platform_status',
          status: 'degraded',
          build: { version: '0.1.0', build: 'e2e' },
        },
        meta: {},
      },
    }),
  );
  await page.goto('/status');
  await expect(page.getByTestId('status')).toContainText('Limited service');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('shows the unavailable state when the API fails', async ({ page }) => {
  await page.route('**/v1/status', (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'service_unavailable',
          status: 503,
          message: 'x',
          retryable: true,
          request_id: 'req_0',
          correlation_id: '0',
        },
      },
    }),
  );
  await page.goto('/status');
  await expect(page.getByTestId('status')).toContainText('Service unavailable');
  await expect(page.getByTestId('build')).toHaveCount(0);
});

test('serves the shell for client routes and JSON envelopes for unknown API routes', async ({
  page,
  request,
}) => {
  await page.goto('/some/client/route');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
  const api = await request.get('/v1/unknown');
  expect(api.status()).toBe(404);
  expect((await api.json()).error.code).toBe('not_found');
});
