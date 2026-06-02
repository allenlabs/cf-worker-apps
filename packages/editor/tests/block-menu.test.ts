import { describe, expect, it } from 'vitest';
import { DragHandle } from '../src/extensions/block-menu';

/**
 * Regression: the DragHandle extension stashes its BlockMenu controller on
 * `this.storage.ctrl` in onCreate and tears it down in onDestroy. TipTap only
 * allocates `this.storage` for an extension that declares an `addStorage()`
 * initialiser — without it, `this.storage` is undefined and BOTH hooks throw
 * "Cannot (set|read) properties of undefined (reading 'ctrl')", which the page
 * error boundary surfaces as "Something went wrong" on the first useEditor
 * re-create (refreshEditorInstance). A deployed-prod Playwright run caught this.
 *
 * This test pins the contract: addStorage must exist and return an object so
 * `this.storage.ctrl = …` has somewhere to land.
 */
describe('DragHandle extension storage', () => {
  it('declares an addStorage initialiser', () => {
    // TipTap stores the raw config under `.config`.
    const config = (DragHandle as unknown as { config: Record<string, unknown> }).config;
    expect(typeof config.addStorage).toBe('function');
  });

  it('addStorage returns a storage bag with a ctrl slot', () => {
    const config = (DragHandle as unknown as {
      config: { addStorage?: () => Record<string, unknown> };
    }).config;
    const storage = config.addStorage?.call({});
    expect(storage).toBeTypeOf('object');
    expect(storage).not.toBeNull();
    // The slot exists (initialised undefined) so onCreate can assign it.
    expect(Object.prototype.hasOwnProperty.call(storage ?? {}, 'ctrl')).toBe(true);
  });
});
