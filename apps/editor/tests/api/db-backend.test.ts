// Unit tests for the Datasource Step 2 backend-selection primitives:
//   - dbBackendImpl: reads editor.pages.db_backend (+ workspace) and falls back
//     to 'postgres' for legacy/unknown values — the basis of the router's
//     dataSourceForDatabase resolver.
//   - createDatabaseImpl: records the chosen backend and, for 'native_do',
//     skips the PG-side property/view seeding (the DO seeds instead) while
//     still creating the lightweight container page on PG. ADDITIVE: the
//     default path is byte-identical to before.

import { describe, it, expect } from 'vitest';
import { dbBackendImpl, createDatabaseImpl } from '@api/handlers/db';
import type { Sql } from '@api/lib/db';

interface Call {
  text: string;
  params: unknown[];
}
function fakeSql(responder: (text: string, params: unknown[]) => unknown[]): {
  sql: Sql;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fn = ((first: unknown, ...params: unknown[]) => {
    if (!Array.isArray(first) || !(first as { raw?: unknown }).raw) {
      return { __assign: first, cols: params };
    }
    const strings = first as unknown as TemplateStringsArray;
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ text, params });
    return Promise.resolve(responder(text, params));
  }) as unknown as Sql & { json: (v: unknown) => unknown };
  (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => ({ __json: v });
  return { sql: fn as Sql, calls };
}

const DB = '11111111-1111-1111-1111-111111111111';
const WS = '99999999-9999-9999-9999-999999999999';

describe('dbBackendImpl', () => {
  it('returns native_do + workspace for a database recorded on the DO backend', async () => {
    const { sql } = fakeSql(() => [{ backend: 'native_do', workspaceId: WS, kind: 'database' }]);
    expect(await dbBackendImpl(sql, DB)).toEqual({ backend: 'native_do', workspaceId: WS });
  });

  it('returns postgres for the default backend value', async () => {
    const { sql } = fakeSql(() => [{ backend: 'postgres', workspaceId: WS, kind: 'database' }]);
    expect(await dbBackendImpl(sql, DB)).toEqual({ backend: 'postgres', workspaceId: WS });
  });

  it('falls back to postgres for a legacy NULL / unknown db_backend', async () => {
    const { sql: nullSql } = fakeSql(() => [{ backend: null, workspaceId: WS, kind: 'database' }]);
    expect(await dbBackendImpl(nullSql, DB)).toEqual({ backend: 'postgres', workspaceId: WS });
    const { sql: weirdSql } = fakeSql(() => [{ backend: 'mystery', workspaceId: WS, kind: 'database' }]);
    expect(await dbBackendImpl(weirdSql, DB)).toEqual({ backend: 'postgres', workspaceId: WS });
  });

  it('returns null when the id is not a database page (or missing)', async () => {
    const { sql: pageSql } = fakeSql(() => [{ backend: 'postgres', workspaceId: WS, kind: 'page' }]);
    expect(await dbBackendImpl(pageSql, DB)).toBeNull();
    const { sql: emptySql } = fakeSql(() => []);
    expect(await dbBackendImpl(emptySql, DB)).toBeNull();
  });
});

describe('createDatabaseImpl backend branching', () => {
  it('postgres (default) seeds the PG Table view + starter properties', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('MAX(position)')) return [{ maxPos: -1 }];
      if (text.includes('INSERT INTO editor.pages')) return [{ id: 'new-db', title: 'T', parentId: null }];
      return [{ id: 'new-db' }];
    });
    const out = await createDatabaseImpl(sql, 'u1', { workspaceId: WS });
    expect(out.id).toBe('new-db');
    // db_backend set to 'postgres'.
    expect(calls.some((c) => c.text.includes("SET kind = 'database'") && c.params.includes('postgres'))).toBe(true);
    // PG seeding happens: a default view + two properties.
    expect(calls.some((c) => c.text.includes('INSERT INTO editor.db_views'))).toBe(true);
    expect(calls.filter((c) => c.text.includes('INSERT INTO editor.db_properties')).length).toBe(2);
  });

  it('native_do creates the PG container page but SKIPS PG view/property seeding', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('MAX(position)')) return [{ maxPos: -1 }];
      if (text.includes('INSERT INTO editor.pages')) return [{ id: 'new-db', title: 'T', parentId: null }];
      return [{ id: 'new-db' }];
    });
    const out = await createDatabaseImpl(sql, 'u1', { workspaceId: WS, backend: 'native_do' });
    expect(out.id).toBe('new-db');
    // The lightweight container page is still created on PG (tree/ACL/search).
    expect(calls.some((c) => c.text.includes('INSERT INTO editor.pages'))).toBe(true);
    // db_backend recorded as 'native_do'.
    expect(calls.some((c) => c.text.includes("SET kind = 'database'") && c.params.includes('native_do'))).toBe(true);
    // NO PG-side view/property seeding for native — the DO owns those.
    expect(calls.some((c) => c.text.includes('INSERT INTO editor.db_views'))).toBe(false);
    expect(calls.some((c) => c.text.includes('INSERT INTO editor.db_properties'))).toBe(false);
  });
});
