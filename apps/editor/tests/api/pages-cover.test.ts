// Unit tests for the Phase 11 cover-image patch path in pages.ts. updatePageImpl
// assembles only the columns present in the patch; we drive it with a fake `Sql`
// tagged-template that records the UPDATE assignment + returns a row.

import { describe, it, expect } from 'vitest';
import { updatePageImpl, type PageFull } from '@api/handlers/pages';
import type { Sql } from '@api/lib/db';

interface Call {
  text: string;
  params: unknown[];
}

/**
 * A fake Sql that:
 *  - answers getPageImpl's SELECT (text contains "snapshot_html AS") with a row,
 *  - expands an object passed to sql(obj, ...cols) into a recorded assignment,
 *  - records the UPDATE and returns a single id row so the patch "succeeds".
 */
function fakeSql(existing: Partial<PageFull>) {
  const calls: Call[] = [];
  let lastAssign: Record<string, unknown> | null = null;
  const sql = ((first: unknown, ...rest: unknown[]) => {
    // sql(obj, ...cols) form — used to expand the SET assignment.
    if (!Array.isArray(first) || !('raw' in (first as object))) {
      lastAssign = first as Record<string, unknown>;
      return { __assign: true };
    }
    const strings = first as unknown as TemplateStringsArray;
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ text, params: rest });
    if (text.includes('snapshot_html AS')) {
      return Promise.resolve([
        {
          id: 'p1',
          workspaceId: 'ws',
          parentId: null,
          title: 'T',
          icon: null,
          cover: existing.cover ?? null,
          snapshotHtml: existing.snapshotHtml ?? '<p></p>',
          kind: 'page',
          databaseId: null,
          public: false,
          restricted: false,
        },
      ]);
    }
    // The UPDATE … RETURNING id path.
    return Promise.resolve([{ id: 'p1' }]);
  }) as unknown as Sql;
  return { sql, calls, getAssign: () => lastAssign };
}

describe('updatePageImpl — cover', () => {
  it('includes cover in the assignment when a cover URL is patched', async () => {
    const { sql, getAssign } = fakeSql({});
    const ok = await updatePageImpl(sql, 'p1', { cover: 'https://r2/x.png' });
    expect(ok).toBe(true);
    expect(getAssign()).toEqual({ cover: 'https://r2/x.png' });
  });

  it('sets cover to null when explicitly cleared', async () => {
    const { sql, getAssign } = fakeSql({ cover: 'https://r2/old.png' });
    const ok = await updatePageImpl(sql, 'p1', { cover: null });
    expect(ok).toBe(true);
    expect(getAssign()).toEqual({ cover: null });
  });

  it('omits cover from the assignment when not provided (no-op patch succeeds)', async () => {
    const { sql, getAssign } = fakeSql({});
    // No fields → updatePageImpl returns "page exists" without assembling an UPDATE.
    const ok = await updatePageImpl(sql, 'p1', {});
    expect(ok).toBe(true);
    expect(getAssign()).toBeNull();
  });
});
