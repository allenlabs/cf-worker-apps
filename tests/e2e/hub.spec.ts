/**
 * Hub: verify the shell loads and exposes the configured app catalog.
 *
 * This is the end-to-end canary that links the suite together:
 * - authentication + root layout render successfully
 * - the app list includes the currently public app set (notably Project Management)
 */

import { expect, test } from '@playwright/test';
import { APPS } from './lib/fixtures';

test.describe('hub.allenlabs.org', () => {
  test('renders app catalog', async ({ page }) => {
    await page.goto(`${APPS.hub.baseUrl}/`);

    await expect(page.getByRole('heading', { name: 'Allen Labs App Shell' })).toBeVisible();
    await expect(page.getByTestId('hub-summary')).toBeVisible();
    await expect(page.getByText('Project Management')).toBeVisible();
    await expect(page.getByTestId('app-card-project-management')).toBeVisible();
    await expect(page.getByTestId('app-card-project-management')).toHaveAttribute(
      'href',
      'https://projects.allenlabs.org',
    );
  });
});
