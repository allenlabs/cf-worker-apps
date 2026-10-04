/**
 * Cross-app: capture an inbox item, then verify it's visible in the
 * `today.allenlabs.org` inbox panel.  This is the canonical "do I still
 * have the same identity across subdomains?" check.
 */

import { expect, test } from '@playwright/test';
import { APPS, INBOX_E2E_TAG, inboxText } from './lib/fixtures';

test.describe('cross-app', () => {
  test('capture in inbox → visible in today', async ({ page, request }) => {
    const text = inboxText(`cross-app ${Date.now()}`);

    const cap = await request.post(`${APPS.inbox.baseUrl}/api/capture`, {
      data: { text, source: 'web', tags: [INBOX_E2E_TAG] },
    });
    expect(cap.status()).toBe(201);
    const { id } = (await cap.json()) as { id: number };

    await page.goto(`${APPS.today.baseUrl}/`);

    // The inbox panel renders a <details> — it may be collapsed by default;
    // open it to be sure.
    const panel = page.locator('[data-testid="inbox-panel"]');
    await expect(panel).toBeVisible();
    const summary = panel.locator('summary');
    if (await summary.count()) {
      // Click summary to ensure open (no-op if already open).
      await summary.first().click();
    }

    const item = page.locator(`[data-testid="inbox-${id}"]`);
    await expect(item).toBeVisible({ timeout: 20_000 });
    await expect(item).toContainText(text);
  });
});
