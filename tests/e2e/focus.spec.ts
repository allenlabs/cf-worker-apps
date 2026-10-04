/**
 * Focus: start → note a wobble → done early flow against
 * focus.allenlabs.org.
 *
 * The UI only offers 15/25/45/60-minute presets; the API accepts down to 1
 * minute, so we POST `/api/start` directly with a 1-minute target so the
 * test runs fast.  The "done early" button then takes us through the
 * reflection card path the user actually exercises.
 *
 * Every session's task_text is prefixed `[e2e]` so teardown deletes it.
 */

import { expect, test } from '@playwright/test';
import { APPS, focusTask } from './lib/fixtures';

test.describe('focus.allenlabs.org', () => {
  test('start, distract, end', async ({ page, request }) => {
    const task = focusTask(`tiny focus test ${Date.now()}`);

    // Use the cookie-authed /api/start endpoint to bypass the 15-min minimum
    // in the start form preset.  The server-side schema only requires
    // targetMinutes >= 1.
    const startRes = await request.post(`${APPS.focus.baseUrl}/api/start`, {
      data: { taskText: task, targetMinutes: 1 },
    });
    expect(startRes.status(), `start status (body: ${await startRes.text()})`).toBe(201);
    const { id: sessionId } = (await startRes.json()) as { id: number };
    expect(sessionId).toBeGreaterThan(0);

    // Navigate to focus home — it should now render the active-session view.
    await page.goto(`${APPS.focus.baseUrl}/`);
    await expect(page.locator('[data-testid="active-view"]')).toBeVisible();
    await expect(page.locator('[data-testid="active-view"]')).toContainText(task);
    await expect(page.locator('[data-testid="countdown"]')).toBeVisible();

    // Note a wobble.
    await page.locator('[data-testid="note-wobble"]').click();
    await expect(page.locator('[data-testid="wobble-modal"]')).toBeVisible();
    await page.getByLabel('Wobble label').fill('twitter');
    await page.getByRole('button', { name: 'Note it' }).click();
    await expect(page.locator('[data-testid="wobble-modal"]')).toHaveCount(0);

    // Eventually the wobble-counter should reflect the new value (>=1).
    await expect
      .poll(async () => {
        const txt = (await page.locator('[data-testid="distractions-today"]').textContent()) ?? '';
        const m = txt.match(/(\d+)\s*wobble/);
        return m ? Number(m[1]) : 0;
      }, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);

    // Done early — opens the reflection card.
    await page.locator('[data-testid="done-early"]').click();
    await expect(page.locator('[data-testid="reflection-view"]')).toBeVisible({
      timeout: 15_000,
    });

    // Skip the reflection rather than saving (the Save button only enables
    // once satisfaction is set; the user can always skip).
    await page.getByRole('button', { name: 'Skip' }).click();

    // Back to the start form once no active session remains.
    await expect(page.locator('[data-testid="start-form"]')).toBeVisible({
      timeout: 15_000,
    });
  });
});
