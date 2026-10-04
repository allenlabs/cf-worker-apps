/**
 * Context: save snapshot via API → list → view the per-snapshot page.
 *
 * Snapshot save isn't a UI flow on the deployed site (snapshots are
 * created by the CLI / browser ext / POST /api/save).  The browser surface
 * is the list + restore-view, so this spec exercises that.
 */

import { expect, test } from '@playwright/test';
import { APPS, contextName } from './lib/fixtures';

test.describe('context.allenlabs.org', () => {
  test('save, list, view', async ({ page, request }) => {
    const name = contextName(`save list view ${Date.now()}`);

    const saveRes = await request.post(`${APPS.context.baseUrl}/api/save`, {
      data: {
        name,
        notes: 'e2e snapshot — safe to delete',
        payload: { cwd: '/tmp/e2e', branch: 'e2e-main', files: ['README.md'] },
      },
    });
    expect(saveRes.status(), `save status (body: ${await saveRes.text()})`).toBe(201);
    const { id } = (await saveRes.json()) as { id: number; name: string };
    expect(id).toBeGreaterThan(0);

    // List view should now include this row.
    await page.goto(`${APPS.context.baseUrl}/`);
    const row = page.locator(`[data-testid="row-${id}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText(name);

    // Click through to the restore view (the snapshot detail page).
    await page.locator(`[data-testid="link-${id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/${id}$`));
    // The detail page renders the name somewhere visible.
    await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
  });
});
