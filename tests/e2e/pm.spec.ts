/**
 * Project Management end-to-end smoke + feature coverage.
 *
 * Runs against the deployed worker at https://projects.allenlabs.org using the
 * shared admin storage-state (see global-setup). Every project it creates uses
 * the `e2e-` identifier prefix so global-teardown → cleanup.ts removes it
 * (cleanup deletes `pm.projects WHERE identifier LIKE 'e2e-%'` and the issues
 * that hang off them).
 *
 * The app is a TanStack Start SSR worker driven by server functions, so we
 * exercise it through the browser (fill + click) rather than a REST API.
 */

import { test, expect } from '@playwright/test';
import { APPS, pmIdentifier } from './lib/fixtures';

const PM = APPS.pm.baseUrl;

test.describe('project-management', () => {
  test('create a project and open its overview', async ({ page }) => {
    const identifier = pmIdentifier('smoke');
    const name = `E2E Smoke ${identifier}`;

    await page.goto(`${PM}/projects/new`);
    const nameField = page.getByTestId('project-name');
    const idField = page.getByTestId('project-identifier');
    // These are React controlled inputs whose `name` onChange auto-slugs the
    // identifier. `.fill()` raced React's batched re-render and submitted empty
    // values, so type char-by-char (gives React time to settle between
    // keystrokes) and assert the values stuck before submitting.
    await nameField.click();
    await nameField.pressSequentially(name, { delay: 15 });
    await idField.click();
    await idField.fill(''); // clear the auto-slug
    await idField.pressSequentially(identifier, { delay: 15 });
    await expect(nameField).toHaveValue(name);
    await expect(idField).toHaveValue(identifier);
    await page.getByTestId('project-submit').click();

    // On success the app navigates to the new project's overview. Waiting for
    // that URL both confirms creation succeeded AND keeps the in-flight
    // createProject server-fn from being aborted by a premature navigation.
    await page.waitForURL(new RegExp(`/projects/${identifier}(/|$)`), {
      timeout: 20_000,
    });
    await expect(page.getByRole('heading', { name })).toBeVisible();

    // And it shows up in the project list (admins see every project).
    await page.goto(`${PM}/projects`);
    await expect(page.getByTestId(`project-row-${identifier}`)).toBeVisible();
  });
});
