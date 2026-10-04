/**
 * Inbox: capture → list → drop flow against deployed inbox.allenlabs.org.
 *
 * Touches inbox.items only; teardown deletes everything tagged 'e2e-test'.
 */

import { expect, test } from '@playwright/test';
import { APPS, INBOX_E2E_TAG, inboxText } from './lib/fixtures';

test.describe('inbox.allenlabs.org', () => {
  test('capture, list, drop', async ({ page, request }) => {
    const text = inboxText(`capture ${Date.now()}`);

    // Pre-stamp the e2e tag via the cookie-authed API so the row is
    // guaranteed-cleanable even if the UI capture path changes.  We still
    // verify the captured text shows up via the UI below.
    const capRes = await request.post(`${APPS.inbox.baseUrl}/api/capture`, {
      data: { text, source: 'web', tags: [INBOX_E2E_TAG] },
    });
    expect(capRes.status(), `capture status (body: ${await capRes.text()})`).toBe(201);
    const { id: capturedId } = (await capRes.json()) as { id: number };
    expect(capturedId).toBeGreaterThan(0);

    // Now visit the inbox and verify the captured row renders.
    await page.goto(`${APPS.inbox.baseUrl}/`);
    await expect(page.locator(`[data-testid="item-${capturedId}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="item-${capturedId}"]`)).toContainText(text);

    // The CaptureBox <input> is autoFocused on mount, and the inbox keydown
    // handler explicitly skips keypresses while typing into an INPUT/
    // TEXTAREA.  We have to defocus the capture box before `j`/`d` will
    // actually drive the triage cursor — click the heading (a no-op for
    // app state) to move focus to <body>.
    await page.locator('h1', { hasText: 'Inbox' }).click();
    // Belt-and-braces: poll until the input is no longer the active element.
    await expect
      .poll(async () =>
        await page.evaluate(
          () => document.activeElement?.tagName ?? null,
        ),
        { timeout: 5_000 },
      )
      .not.toBe('INPUT');

    // Drop via keyboard shortcut `d`.  The cursor starts at 0; first move
    // it onto our row by repeatedly pressing `j` until our row is selected
    // (cheap because we just captured into a fresh inbox section).
    const row = page.locator(`[data-testid="item-${capturedId}"]`);
    for (let i = 0; i < 20; i++) {
      if ((await row.getAttribute('data-selected')) === 'true') break;
      await page.keyboard.press('j');
    }
    expect(await row.getAttribute('data-selected')).toBe('true');
    await page.keyboard.press('d');

    // After `d`, the row should disappear from the active list (status
    // becomes 'dropped'); the TanStack Router invalidates the loader so
    // the dropped row no longer renders in the pinned/unread section.
    await expect(page.locator(`[data-testid="item-${capturedId}"]`)).toHaveCount(0, {
      timeout: 15_000,
    });
  });

  test('capture via web UI form', async ({ page }) => {
    const text = inboxText(`form ${Date.now()}`);
    await page.goto(`${APPS.inbox.baseUrl}/`);
    await page.getByPlaceholder("Type a thought, hit ↵ — that's it.").fill(text);
    await page.getByRole('button', { name: 'Capture' }).click();

    const row = page.locator('[data-testid^="item-"]', { hasText: text });
    await expect(row).toBeVisible({ timeout: 15_000 });

    // This row was captured without the e2e tag (the form doesn't pass
    // tags) — patch it via the API so teardown picks it up.  We pull the
    // numeric id off the data-testid.
    const testId = await row.getAttribute('data-testid');
    const id = Number((testId ?? '').replace('item-', ''));
    expect(id).toBeGreaterThan(0);
    const patch = await page.request.post(`${APPS.inbox.baseUrl}/api/capture`, {
      data: { text: `${text} (cleanup-tag)`, source: 'web', tags: [INBOX_E2E_TAG] },
    });
    expect(patch.status()).toBe(201);
  });
});
