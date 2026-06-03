import { describe, expect, it } from 'vitest';
import {
  clampActiveTab,
  activeAfterRemove,
  activeAfterAdd,
  defaultTabTitle,
} from '../src/lib/tabs';
import { DEFAULT_SLASH_ITEMS } from '../src/lib/slash-items';

describe('clampActiveTab', () => {
  it('keeps an in-range index', () => {
    expect(clampActiveTab(1, 3)).toBe(1);
  });

  it('clamps a too-large index to the last tab', () => {
    expect(clampActiveTab(9, 3)).toBe(2);
  });

  it('clamps a negative / non-finite index to 0', () => {
    expect(clampActiveTab(-2, 3)).toBe(0);
    expect(clampActiveTab(Number.NaN, 3)).toBe(0);
  });

  it('returns 0 when there are no tabs', () => {
    expect(clampActiveTab(2, 0)).toBe(0);
  });

  it('floors a fractional index', () => {
    expect(clampActiveTab(1.8, 3)).toBe(1);
  });
});

describe('activeAfterRemove', () => {
  it('shifts left when removing the active tab (not last)', () => {
    // 3 tabs, active=1, remove index 1 → 2 tabs, active clamped to 1
    expect(activeAfterRemove(1, 1, 3)).toBe(1);
  });

  it('shifts left when removing an earlier tab', () => {
    // active=2, remove index 0 → active becomes 1 in the 2-tab list
    expect(activeAfterRemove(2, 0, 3)).toBe(1);
  });

  it('keeps the active index when removing a later tab', () => {
    expect(activeAfterRemove(0, 2, 3)).toBe(0);
  });

  it('clamps to the new last when removing the last active tab', () => {
    // 3 tabs, active=2, remove 2 → 2 tabs, active clamps to 1
    expect(activeAfterRemove(2, 2, 3)).toBe(1);
  });

  it('returns 0 when removing the only tab', () => {
    expect(activeAfterRemove(0, 0, 1)).toBe(0);
  });
});

describe('activeAfterAdd', () => {
  it('selects the appended (new last) tab', () => {
    expect(activeAfterAdd(2)).toBe(2); // new tab lands at old count
    expect(activeAfterAdd(0)).toBe(0);
  });
});

describe('defaultTabTitle', () => {
  it('is 1-based', () => {
    expect(defaultTabTitle(0)).toBe('Tab 1');
    expect(defaultTabTitle(2)).toBe('Tab 3');
  });
});

describe('Tabs slash item', () => {
  it('is registered with a setTabs-driven command', () => {
    const item = DEFAULT_SLASH_ITEMS.find((i) => i.title === 'Tabs');
    expect(item).toBeDefined();
    expect(item!.icon).toBeTruthy();
    expect(item!.keywords).toContain('tabbed');

    // Exercise the command against a chain stub to confirm it deletes the slash
    // range then calls setTabs (mirrors the synced-block slash test).
    const calls: string[] = [];
    const chain = {
      focus: () => chain,
      deleteRange: () => {
        calls.push('deleteRange');
        return chain;
      },
      setTabs: () => {
        calls.push('setTabs');
        return chain;
      },
      run: () => true,
    };
    item!.command({ editor: { chain: () => chain } as never, range: { from: 1, to: 2 } as never });
    expect(calls).toEqual(['deleteRange', 'setTabs']);
  });
});
