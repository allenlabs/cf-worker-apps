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

import { test, expect, type Page } from '@playwright/test';
import { APPS, pmIdentifier } from './lib/fixtures';

const PM = APPS.pm.baseUrl;

/**
 * Create an e2e- project via the UI and return its identifier. The React
 * controlled inputs auto-slug the identifier and race `.fill()`'s batched
 * re-render, so we type char-by-char and assert the values stuck before
 * submitting, then wait for the success navigation to the overview.
 */
async function createProject(page: Page, label: string): Promise<string> {
  const identifier = pmIdentifier(label);
  const name = `E2E ${identifier}`;
  await page.goto(`${PM}/projects/new`);
  const nameField = page.getByTestId('project-name');
  const idField = page.getByTestId('project-identifier');
  await nameField.click();
  await nameField.pressSequentially(name, { delay: 15 });
  await idField.click();
  await idField.fill('');
  await idField.pressSequentially(identifier, { delay: 15 });
  await expect(nameField).toHaveValue(name);
  await expect(idField).toHaveValue(identifier);
  await page.getByTestId('project-submit').click();
  await page.waitForURL(new RegExp(`/projects/${identifier}(/|$)`), { timeout: 20_000 });
  return identifier;
}

test.describe('project-management', () => {
  test('create a project and open its overview', async ({ page }) => {
    const identifier = await createProject(page, 'smoke');
    await page.goto(`${PM}/projects`);
    await expect(page.getByTestId(`project-row-${identifier}`)).toBeVisible();
  });

  test('command palette (Ctrl-K) opens and navigates', async ({ page }) => {
    await page.goto(`${PM}/projects`);
    // Open with the global shortcut.
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();
    // Filtering narrows the action list.
    await page.getByTestId('cmdk-input').fill('project');
    await expect(page.getByTestId('cmdk-action-newProject')).toBeVisible();
    // Activating an action navigates and closes the palette.
    await page.getByTestId('cmdk-action-newProject').click();
    await page.waitForURL(/\/projects\/new$/, { timeout: 10_000 });
    await expect(page.getByTestId('command-palette')).toHaveCount(0);
  });

  test('"assigned to me" filter hides issues that are not mine', async ({ page }) => {
    const identifier = await createProject(page, 'filter');
    const subject = `E2E unassigned ${Date.now()}`;

    // Create an UNASSIGNED issue (the assignee select defaults to "unassigned").
    await page.goto(`${PM}/projects/${identifier}/issues/new`);
    const subjectField = page.getByTestId('issue-subject');
    await subjectField.click();
    await subjectField.pressSequentially(subject, { delay: 10 });
    await expect(subjectField).toHaveValue(subject);
    await page.getByTestId('issue-submit').click();
    // Success does a full-page redirect to the new issue's detail page.
    await page.waitForURL(new RegExp(`/projects/${identifier}/issues/\\d+$`), {
      timeout: 20_000,
    });

    // assignee=any → the unassigned issue is listed.
    await page.goto(`${PM}/projects/${identifier}/issues?assignee=any&status=all`);
    await expect(page.getByRole('link', { name: subject })).toBeVisible();

    // assignee=me → the unassigned issue is filtered out.
    await page.goto(`${PM}/projects/${identifier}/issues?assignee=me&status=all`);
    await expect(page.getByRole('link', { name: subject })).toHaveCount(0);
    // The filter control reflects the active selection.
    await expect(page.getByTestId('filter-assignee')).toHaveValue('me');
  });
});
