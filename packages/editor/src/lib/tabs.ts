/**
 * Pure helpers for the Tabs block — clamping the active index and computing
 * the index after add/remove operations. Kept out of the TipTap node so the
 * logic is unit-testable without a ProseMirror doc.
 */

/** Clamp an active-tab index into `[0, count-1]` (or 0 when there are none). */
export function clampActiveTab(active: number, count: number): number {
  if (count <= 0) return 0;
  if (!Number.isFinite(active) || active < 0) return 0;
  if (active > count - 1) return count - 1;
  return Math.floor(active);
}

/**
 * Active index after removing the tab at `removeAt` from a list of `count`
 * tabs. Removing the active or an earlier tab shifts the selection left so the
 * caret lands on a still-present neighbour; later removals keep the selection.
 */
export function activeAfterRemove(active: number, removeAt: number, count: number): number {
  const nextCount = Math.max(0, count - 1);
  if (nextCount === 0) return 0;
  if (removeAt < active) return clampActiveTab(active - 1, nextCount);
  if (removeAt === active) return clampActiveTab(active, nextCount);
  return clampActiveTab(active, nextCount);
}

/** Active index after appending a tab — selects the newly-added (last) one. */
export function activeAfterAdd(count: number): number {
  return count; // new tab is appended at index === old count
}

/** Default title for the nth (0-based) tab. */
export function defaultTabTitle(index: number): string {
  return `Tab ${index + 1}`;
}
