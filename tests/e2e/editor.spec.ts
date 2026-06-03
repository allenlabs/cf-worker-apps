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

import { test, expect, type Page, type Locator, type BrowserContext } from '@playwright/test';
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
  // The collab editor shows a `editor-connecting` placeholder until the Yjs
  // websocket provider exists, then swaps in `editor-content` (the real
  // ProseMirror surface). Wait for the connecting placeholder to be gone so we
  // never grab a stale `.ProseMirror` from a previous render.
  await expect(page.getByTestId('editor-connecting')).toHaveCount(0, { timeout: 45_000 });
  const pm = page.locator('.ProseMirror').first();
  await pm.waitFor({ state: 'visible', timeout: 30_000 });
  // contenteditable flips to "true" once TipTap initialises.
  await expect(pm).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
}

/**
 * INPUT-READINESS GATE + robust typer (collab-aware).
 *
 * `contenteditable=true` only means TipTap *mounted*. Typing reliably is harder
 * than it looks here, for two compounding reasons we verified empirically
 * against prod:
 *
 *   1. Cold start: the very first keystroke after the editor mounts can be
 *      dropped while the heavy bundle (KaTeX + many TipTap nodes) and the Yjs
 *      collab provider finish initialising.
 *   2. Caret collapse to doc start: in collab mode the editor's SELECTION
 *      collapses back to the start of the document shortly after each input
 *      (the y-prosemirror sync plugin re-deriving the selection while the
 *      route re-renders on every `onUpdate`/`setSnapshotHtml`). The ProseMirror
 *      view itself is NOT remounted — the node identity is stable — but a fast
 *      `pressSequentially` races that collapse and ends up inserting each char
 *      at position 0, so the text comes out reversed / scrambled (we observed
 *      "abcdefghij" → "jihgfedcba", and a 20-char paragraph → a single stray
 *      char). This is tolerable for a human typing slowly but lethal for
 *      automated bursts.
 *
 * The product works for real users, so this is a TEST-robustness problem, not a
 * product bug: we type one character at a time, and before EACH character we
 * move the caret to the true end of the document (`ControlOrMeta+End`) so the
 * caret collapse can't insert at the front. After each char we read the doc
 * tail and only proceed once it matches the accumulated string — which both
 * defeats the caret collapse and absorbs cold-start drops (a dropped char just
 * fails the check and we resend). No fixed-duration sleeps gate progress; the
 * short settle between keystrokes only lets the caret collapse land before we
 * read back.
 */
async function typeIntoEditor(page: Page, pm: Locator, text: string): Promise<void> {
  // Type one char per (re-anchored) keypress and verify the doc tail after each.
  // We never blindly re-send a char (that duplicates under collab lag); instead
  // we read the doc and only re-anchor+resend the SPECIFIC char that failed to
  // land. If the tail ever diverges (scramble/duplication from a mistimed
  // caret reset), we wipe everything we added and restart the whole word.
  const MAX_WORD_ATTEMPTS = 4;
  for (let attempt = 0; attempt < MAX_WORD_ATTEMPTS; attempt++) {
    await pm.click();
    await page.keyboard.press('ControlOrMeta+End');
    const base = ((await pm.textContent()) ?? '').length;
    let typed = '';
    let scrambled = false;
    for (const ch of text) {
      const expected = typed + ch;
      let landed = false;
      // Up to a few tries to land THIS single char at the doc end.
      for (let i = 0; i < 8 && !landed; i++) {
        await pm.click();
        await page.keyboard.press('ControlOrMeta+End');
        await page.keyboard.type(ch);
        // Let the collab caret-reset settle, then read the result.
        await page.waitForTimeout(120);
        const tail = ((await pm.textContent()) ?? '').slice(base);
        if (tail === expected) {
          landed = true;
        } else if (tail === typed) {
          // Char was dropped (caret reset swallowed it) — loop and resend.
          continue;
        } else {
          // Tail diverged (extra/scrambled char). Bail to a full-word retry.
          scrambled = true;
          break;
        }
      }
      if (scrambled || !landed) {
        scrambled = true;
        break;
      }
      typed = expected;
    }
    if (!scrambled) {
      // Confirm the full word is present at the tail and return.
      await expect
        .poll(async () => ((await pm.textContent()) ?? '').slice(base), { timeout: 10_000 })
        .toBe(text);
      return;
    }
    // Wipe whatever we added this attempt (only the chars past `base`, so we
    // never clobber pre-existing content) and retry the whole word.
    await pm.click();
    await page.keyboard.press('ControlOrMeta+End');
    const extra = ((await pm.textContent()) ?? '').length - base;
    for (let i = 0; i < extra; i++) await page.keyboard.press('Backspace');
    await page.waitForTimeout(150);
  }
  throw new Error(`typeIntoEditor: could not reliably enter "${text}" after ${MAX_WORD_ATTEMPTS} attempts`);
}

/**
 * Prove the editor accepts input before the real test work. Types a short probe
 * via the robust typer (which inherently tolerates cold-start drops + the caret
 * reset), asserts it landed intact, then clears it so the caller starts clean.
 */
async function waitForEditorInputReady(page: Page): Promise<void> {
  const pm = page.locator('.ProseMirror').first();
  const PROBE = 'readyprobe';
  await typeIntoEditor(page, pm, PROBE);
  await expect(pm).toContainText(PROBE, { timeout: 10_000 });
  // Clear the probe.
  await pm.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await expect
    .poll(async () => (await pm.textContent())?.trim() ?? '', { timeout: 15_000 })
    .toBe('');
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
    test.setTimeout(120_000);
    const title = pageTitle('persist');
    const url = await createPage(page, title);
    await waitForEditor(page);
    // Prove the editor actually accepts keystrokes before we type for real —
    // absorbs cold-start + collab-connect keystroke drops.
    await waitForEditorInputReady(page);

    const para = `e2e-paragraph-${Math.random().toString(36).slice(2, 8)}`;
    const headingText = `e2e-heading-${Math.random().toString(36).slice(2, 8)}`;

    const pm = page.locator('.ProseMirror').first();
    // Robust, caret-anchored typing (see typeIntoEditor): the collab editor
    // collapses the selection to the doc start after each input, so a naive
    // burst would scramble/reverse the text.
    await typeIntoEditor(page, pm, para);
    await expect(pm).toContainText(para, { timeout: 20_000 });
    await pm.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('Enter');

    // Turn the new line into a Heading 1 via the "/" slash command menu, then
    // type the heading text. This is the core Notion-style affordance: typing
    // "/" opens a tippy popup whose list is rendered by @tiptap/react's
    // ReactRenderer; we filter to "heading 1" and click `slash-item-heading-1`.
    //
    // This path guards the slash-menu fix: the popup previously rendered an
    // empty `.react-renderer` in production because the host route's fresh
    // inline props rebuilt the editor on every re-render (in collab mode that's
    // constant), tearing down EditorContent's `contentComponent` and orphaning
    // the popup's React portal. The package now keys the editor on structural
    // flags only (live callbacks read via refs), so the editor is stable and the
    // portal renders.
    await pm.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('/');
    // The popup mounts to document.body; wait for the React-rendered list.
    const slashMenu = page.locator('.ae-slash-menu');
    await expect(slashMenu).toBeVisible({ timeout: 10_000 });
    // Filter to Heading 1 and pick it.
    await page.keyboard.type('heading 1');
    const headingItem = page.getByTestId('slash-item-heading-1');
    await expect(headingItem).toBeVisible({ timeout: 10_000 });
    await headingItem.click();
    await expect(pm.locator('h1')).toHaveCount(1, { timeout: 10_000 });
    await typeIntoEditor(page, pm, headingText);
    await expect(pm.locator('h1', { hasText: headingText })).toBeVisible({ timeout: 20_000 });

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
    test.setTimeout(120_000);
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

      // Gate BOTH contexts on real input-readiness. The probe loop here doubles
      // as the "providers connected + initial sync exchanged" signal: a
      // keystroke can only round-trip once A's provider is live, and we wait
      // for B's editor to be input-ready too so it has subscribed to the room
      // before A mutates.
      await waitForEditorInputReady(pageB);
      await waitForEditorInputReady(page);

      const marker = `e2e-marker-${Math.random().toString(36).slice(2, 8)}`;
      const pmA = page.locator('.ProseMirror').first();
      // Robust caret-anchored typing into context A (see typeIntoEditor).
      await typeIntoEditor(page, pmA, marker);
      // Confirm A actually captured the full marker locally before expecting
      // it to propagate (guards against a partial-keystroke false negative).
      await expect(pmA).toContainText(marker, { timeout: 20_000 });

      // Yjs should propagate the insert to context B. Generous web-first wait.
      const pmB = pageB.locator('.ProseMirror').first();
      await expect(pmB).toContainText(marker, { timeout: 30_000 });
    } finally {
      if (ctxB) await ctxB.close();
    }
  });
});
