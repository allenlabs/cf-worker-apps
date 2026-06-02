/**
 * Editor (Notion-style) end-to-end coverage.
 *
 * Runs against the deployed worker at https://editor.allenlabs.org using the
 * shared admin storage-state (see global-setup). Every page it creates carries
 * the `e2e-` title prefix so global-teardown → cleanup.ts removes it
 * (cleanup deletes `editor.pages WHERE title LIKE 'e2e-%'`; children, comments
 * and versions cascade via FKs).
 *
 * The editor is a client-only collaborative (Yjs) TipTap editor mounted after
 * hydration. We exercise it through a real browser:
 *   1. create → type → reload → assert the debounced snapshot persisted;
 *   2. open the same page in a 2nd context → assert one context's edits show
 *      up in the other (proves Yjs multiplayer).
 *
 * Generous timeouts everywhere: collab connect + Cloudflare cold starts can
 * each cost a few seconds, and `retries` is already 1 at the config level.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import path from 'node:path';
import { APPS, EDITOR_E2E_PREFIX } from './lib/fixtures';

const EDITOR = APPS.editor.baseUrl;
const STORAGE_STATE = path.resolve(__dirname, '.auth', 'state.json');

/** Unique e2e- title so cleanup.ts removes the page at teardown. */
function pageTitle(label: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${EDITOR_E2E_PREFIX}${label}-${rand}`;
}

/** Wait for the collaborative editor to be mounted + editable. */
async function waitForEditor(page: Page): Promise<void> {
  const pm = page.locator('.ProseMirror').first();
  await pm.waitFor({ state: 'visible', timeout: 30_000 });
  // contenteditable flips to "true" once TipTap initialises.
  await expect(pm).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
}

/**
 * Create a fresh root page via the sidebar "New page" button and give it a
 * unique e2e- title. The button creates the page server-side then does a
 * full-page nav to /p/<id> (SSR re-reads the cookie). Returns the page URL.
 *
 * Ordering matters: the title is a React controlled input whose initial value
 * is re-seeded ("Untitled") when the page first hydrates and the collaborative
 * editor mounts. So we wait for the editor to be fully mounted/editable BEFORE
 * typing the title — otherwise a hydration re-render races pressSequentially
 * and clobbers the value back to "Untitled".
 */
async function createPage(page: Page, title: string): Promise<string> {
  await page.goto(`${EDITOR}/`, { waitUntil: 'domcontentloaded' });
  // The home route redirects to the FIRST existing page (or renders the empty
  // state) — so after this goto the URL may already be /p/<some-existing-id>.
  // Capture it so we can wait for the new-page click to navigate to a
  // DIFFERENT page id (otherwise waitForURL(/\/p\//) resolves instantly on the
  // pre-existing page and we'd edit the wrong doc).
  const beforePath = new URL(page.url()).pathname;
  const newPage = page.getByTestId('new-page');
  await newPage.waitFor({ state: 'visible', timeout: 30_000 });
  // The click triggers createPage() then window.location.href = /p/<id>; the
  // button can detach mid-navigation, so don't wait for an actionability
  // settle that the nav invalidates. Poll location.pathname until it lands on a
  // /p/<id> that DIFFERS from where we started (home may already have
  // redirected us onto an existing page).
  await newPage.click({ noWaitAfter: true });
  await page.waitForFunction(
    (prev) => /^\/p\/[0-9a-f-]+$/i.test(location.pathname) && location.pathname !== prev,
    beforePath,
    { timeout: 30_000 },
  );
  const url = page.url();

  // Wait for the editor to mount/hydrate first so the title state has settled.
  await waitForEditor(page);

  const titleField = page.getByTestId('page-title');
  // Type the title and assert it stuck; retry once if a late re-render eats it.
  await expect(async () => {
    await titleField.click();
    await titleField.fill('');
    await titleField.pressSequentially(title, { delay: 15 });
    await expect(titleField).toHaveValue(title);
  }).toPass({ timeout: 20_000 });
  // Blur (→ onBlur → updatePage persists the title) by clicking into the editor.
  await page.locator('.ProseMirror').first().click();
  await expect(titleField).toHaveValue(title);
  return url;
}

test.describe('editor', () => {
  test('create page, type, and persist across reload', async ({ page }) => {
    const title = pageTitle('persist');
    const url = await createPage(page, title);
    await waitForEditor(page);

    const para = `e2e-paragraph-${Math.random().toString(36).slice(2, 8)}`;
    const headingText = `e2e-heading-${Math.random().toString(36).slice(2, 8)}`;

    const pm = page.locator('.ProseMirror').first();
    await pm.click();
    await pm.pressSequentially(para, { delay: 10 });
    await page.keyboard.press('Enter');

    // Slash menu → Heading 1. Type "/" then filter to "heading" and pick H1.
    await pm.pressSequentially('/heading', { delay: 20 });
    const h1 = page.getByTestId('slash-item-heading-1');
    await h1.waitFor({ state: 'visible', timeout: 10_000 });
    await h1.click();
    await pm.pressSequentially(headingText, { delay: 10 });

    // Debounced snapshot save is 800ms; give it generous headroom.
    await page.waitForTimeout(2_000);

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForEditor(page);
    const reloaded = page.locator('.ProseMirror').first();
    await expect(reloaded).toContainText(para, { timeout: 20_000 });
    await expect(reloaded).toContainText(headingText, { timeout: 20_000 });
    // The heading text actually rendered as an <h1>.
    await expect(reloaded.locator('h1', { hasText: headingText })).toBeVisible();
  });

  test('realtime: a second browser context sees edits', async ({ page, browser }) => {
    const title = pageTitle('realtime');
    const url = await createPage(page, title);
    await waitForEditor(page);

    // Open the SAME page in an independent browser context (own cookie jar,
    // loaded from the shared storage state) → a second collaborator.
    let ctxB: BrowserContext | null = null;
    try {
      ctxB = await browser.newContext({ storageState: STORAGE_STATE });
      const pageB = await ctxB.newPage();
      await pageB.goto(url, { waitUntil: 'domcontentloaded' });
      await waitForEditor(pageB);

      // Give both Yjs websocket providers a moment to connect to the room's
      // Durable Object and exchange the initial sync step before we mutate —
      // otherwise A's insert can land before B's provider has subscribed.
      await page.waitForTimeout(2_000);

      const marker = `e2e-marker-${Math.random().toString(36).slice(2, 8)}`;
      const pmA = page.locator('.ProseMirror').first();
      await pmA.click();
      await pmA.pressSequentially(marker, { delay: 15 });

      // Yjs should propagate the insert to context B within a few seconds.
      const pmB = pageB.locator('.ProseMirror').first();
      await expect(pmB).toContainText(marker, { timeout: 20_000 });
    } finally {
      if (ctxB) await ctxB.close();
    }
  });
});
