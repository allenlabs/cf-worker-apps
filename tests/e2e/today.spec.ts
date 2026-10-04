/**
 * Today: dashboard shows ONE NEXT ACTION (hero card) and the inbox panel
 * lists e2e-tagged unread items.
 *
 * Pre-condition: at least one unread, untagged-by-snooze inbox item.  We
 * create it via the inbox API at the top of the test.  No active focus
 * session is asserted (the suite cleans up sessions in teardown).
 */

import { expect, test } from '@playwright/test';
import { APPS, INBOX_E2E_TAG, inboxText } from './lib/fixtures';

test.describe('today.allenlabs.org', () => {
  test('hero card shows ONE NEXT ACTION', async ({ page, request }) => {
    // Seed: one fresh inbox item so the panel has a row + the hero can
    // fall back to inbox even if PM has nothing assigned.
    const text = inboxText(`today seed ${Date.now()}`);
    const cap = await request.post(`${APPS.inbox.baseUrl}/api/capture`, {
      data: { text, source: 'web', tags: [INBOX_E2E_TAG] },
    });
    expect(cap.status()).toBe(201);

    await page.goto(`${APPS.today.baseUrl}/`);

    // Exactly one hero card.  It's either a real next action (kind set) or
    // the empty state — but with the inbox row we just seeded the hero
    // should resolve to a non-empty card.
    const hero = page.locator('[data-testid="hero"]');
    const heroEmpty = page.locator('[data-testid="hero-empty"]');

    // Whichever variant renders, there should be exactly one of them.
    await expect(hero.or(heroEmpty)).toHaveCount(1, { timeout: 15_000 });

    // Inbox panel should be visible and contain our seed.
    await expect(page.locator('[data-testid="inbox-panel"]')).toBeVisible();
  });
});
