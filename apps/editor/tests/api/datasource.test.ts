// Unit tests for the Datasource Step 1 refactor:
//   - PostgresDataSource delegates each method to the right db.ts *Impl SQL
//     (asserted via the same fake tagged-template `Sql` the handler tests use).
//   - capabilities(): full native vs external read-only, and that a read-only
//     source refuses mutations.
//   - the shared host guard (lib/host-guard.ts) used to validate external PG
//     connection targets + outbound webhooks.

import { describe, it, expect } from 'vitest';
import {
  PostgresDataSource,
  makePostgresDataSource,
  makeExternalPostgresDataSource,
} from '@api/datasource/postgres';
import {
  NATIVE_CAPABILITIES,
  EXTERNAL_READONLY_CAPABILITIES,
} from '@api/datasource/types';
import {
  isBlockedHost,
  isSafeHttpUrl,
  isSafePostgresConnectionString,
} from '@api/lib/host-guard';
import type { Sql } from '@api/lib/db';

interface Call {
  text: string;
  params: unknown[];
}
/** Same dual-call fake `Sql` the automations/db tests use. */
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
const ROW = '22222222-2222-2222-2222-222222222222';
const VIEW = '33333333-3333-3333-3333-333333333333';
const PROP = '44444444-4444-4444-4444-444444444444';

describe('PostgresDataSource capabilities', () => {
  it('reports full native capabilities for the internal DB', () => {
    const { sql } = fakeSql(() => []);
    const ds = makePostgresDataSource(sql);
    expect(ds.capabilities()).toEqual(NATIVE_CAPABILITIES);
    expect(ds.capabilities(DB)).toEqual(NATIVE_CAPABILITIES);
    expect(ds.capabilities().readOnly).toBe(false);
    expect(ds.capabilities().canCreateRow).toBe(true);
    expect(ds.capabilities().supportsPageBody).toBe(true);
  });

  it('reports read-only capabilities when constructed with the external profile', () => {
    const { sql } = fakeSql(() => []);
    const ds = new PostgresDataSource(sql, EXTERNAL_READONLY_CAPABILITIES);
    expect(ds.capabilities()).toEqual(EXTERNAL_READONLY_CAPABILITIES);
    expect(ds.capabilities().readOnly).toBe(true);
    expect(ds.capabilities().canCreateRow).toBe(false);
    expect(ds.capabilities().canEditSchema).toBe(false);
  });

  it('a read-only source refuses every mutation without touching the DB', async () => {
    const { sql, calls } = fakeSql(() => []);
    const ds = new PostgresDataSource(sql, EXTERNAL_READONLY_CAPABILITIES);
    await expect(ds.createRow({ databaseId: DB, ownerId: 'u' })).rejects.toThrow(/read-only/);
    await expect(ds.updateRow({ rowId: ROW, props: { a: 1 } })).rejects.toThrow(/read-only/);
    await expect(ds.deleteRow(ROW)).rejects.toThrow(/read-only/);
    await expect(
      ds.createProperty({ databaseId: DB, name: 'X', type: 'text' }),
    ).rejects.toThrow(/read-only/);
    await expect(ds.updateProperty({ id: PROP, name: 'Y' })).rejects.toThrow(/read-only/);
    await expect(ds.deleteProperty(PROP)).rejects.toThrow(/read-only/);
    await expect(ds.createView({ databaseId: DB, type: 'table' })).rejects.toThrow(/read-only/);
    await expect(ds.updateView({ id: VIEW, name: 'Z' })).rejects.toThrow(/read-only/);
    await expect(ds.deleteView(VIEW)).rejects.toThrow(/read-only/);
    // No SQL should have been issued by the refused mutations.
    expect(calls).toHaveLength(0);
  });

  it('a read-only source still allows reads (listRows/listProperties/listViews/schema)', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes("kind FROM editor.pages")) return [{ kind: 'database' }];
      if (text.includes('SELECT id, title FROM editor.pages')) return [{ id: DB, title: 'T' }];
      return [];
    });
    const ds = new PostgresDataSource(sql, EXTERNAL_READONLY_CAPABILITIES);
    await ds.listRows({ databaseId: DB });
    await ds.listProperties(DB);
    await ds.listViews(DB);
    await ds.schema(DB);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('PostgresDataSource delegation (native)', () => {
  it('listRows reads non-archived rows of the database', async () => {
    const { sql, calls } = fakeSql(() => []);
    const ds = makePostgresDataSource(sql);
    await ds.listRows({ databaseId: DB });
    expect(
      calls.some(
        (c) =>
          c.text.includes('FROM editor.pages p') &&
          c.text.includes('p.database_id =') &&
          c.params.includes(DB),
      ),
    ).toBe(true);
  });

  it('listRows passes sourceDatabaseId through (linked view reads the source DB)', async () => {
    const SRC = '55555555-5555-5555-5555-555555555555';
    const { sql, calls } = fakeSql(() => []);
    const ds = makePostgresDataSource(sql);
    await ds.listRows({ databaseId: DB, viewId: VIEW, sourceDatabaseId: SRC });
    // The main row query targets the SOURCE db id, not the requesting db.
    const rowQuery = calls.find((c) => c.text.includes('FROM editor.pages p'));
    expect(rowQuery?.params).toContain(SRC);
  });

  it('createRow inserts a page parented to the database', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT workspace_id')) return [{ workspaceId: 'ws1' }];
      if (text.includes('INSERT INTO editor.pages')) return [{ id: 'newrow', title: 'X' }];
      return [{ id: 'newrow' }];
    });
    const ds = makePostgresDataSource(sql);
    const row = await ds.createRow({ databaseId: DB, ownerId: 'u1', title: 'X' });
    expect(row.id).toBe('newrow');
    expect(calls.some((c) => c.text.includes('INSERT INTO editor.pages'))).toBe(true);
    expect(calls.some((c) => c.text.includes('UPDATE editor.pages') && c.params.includes(DB))).toBe(true);
  });

  it('updateRow merges props into db_props for the row', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('SELECT db_props AS props')) return [{ props: {}, databaseId: DB }];
      return [{ id: ROW }];
    });
    const ds = makePostgresDataSource(sql);
    const ok = await ds.updateRow({ rowId: ROW, props: { p1: 'v' } });
    expect(ok).toBe(true);
    expect(
      calls.some((c) => c.text.includes('SET db_props = db_props ||') && c.params.includes(ROW)),
    ).toBe(true);
  });

  it('deleteRow archives the row', async () => {
    const { sql, calls } = fakeSql(() => [{ id: ROW }]);
    const ds = makePostgresDataSource(sql);
    const ok = await ds.deleteRow(ROW);
    expect(ok).toBe(true);
    expect(calls.some((c) => c.text.includes('SET archived = true') && c.params.includes(ROW))).toBe(true);
  });

  it('createProperty inserts into db_properties', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('MAX(position)')) return [{ maxPos: 2 }];
      return [{ id: PROP, databaseId: DB, name: 'X', type: 'text', config: {}, position: 3 }];
    });
    const ds = makePostgresDataSource(sql);
    const prop = await ds.createProperty({ databaseId: DB, name: 'X', type: 'text' });
    expect(prop.id).toBe(PROP);
    expect(calls.some((c) => c.text.includes('INSERT INTO editor.db_properties'))).toBe(true);
  });

  it('updateProperty / deleteProperty issue the expected statements', async () => {
    const { sql, calls } = fakeSql((text) => {
      // deleteProperty first resolves the owning db, then strips + deletes.
      if (text.includes('SELECT database_id AS "databaseId" FROM editor.db_properties')) {
        return [{ databaseId: DB }];
      }
      return [{ id: PROP }];
    });
    const ds = makePostgresDataSource(sql);
    expect(await ds.updateProperty({ id: PROP, name: 'Y' })).toBe(true);
    expect(await ds.deleteProperty(PROP)).toBe(true);
    expect(calls.some((c) => c.text.includes('UPDATE editor.db_properties'))).toBe(true);
    expect(calls.some((c) => c.text.includes('DELETE FROM editor.db_properties'))).toBe(true);
  });

  it('createView / updateView / deleteView hit editor.db_views', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('MAX(position)')) return [{ maxPos: 0 }];
      if (text.includes('INSERT INTO editor.db_views')) {
        return [{ id: VIEW, databaseId: DB, name: 'Table', type: 'table', config: {}, position: 1, sourceDatabaseId: null }];
      }
      return [{ id: VIEW }];
    });
    const ds = makePostgresDataSource(sql);
    const v = await ds.createView({ databaseId: DB, type: 'table' });
    expect(v.id).toBe(VIEW);
    expect(await ds.updateView({ id: VIEW, name: 'Renamed' })).toBe(true);
    expect(await ds.deleteView(VIEW)).toBe(true);
    expect(calls.some((c) => c.text.includes('INSERT INTO editor.db_views'))).toBe(true);
    expect(calls.some((c) => c.text.includes('UPDATE editor.db_views'))).toBe(true);
    expect(calls.some((c) => c.text.includes('DELETE FROM editor.db_views'))).toBe(true);
  });

  it('schema returns null for a non-database page', async () => {
    const { sql } = fakeSql((text) => {
      if (text.includes('kind FROM editor.pages')) return [{ kind: 'page' }];
      return [];
    });
    const ds = makePostgresDataSource(sql);
    expect(await ds.schema(DB)).toBeNull();
  });

  it('schema bundles db page + properties + views for a database page', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.includes('kind FROM editor.pages')) return [{ kind: 'database' }];
      if (text.includes('SELECT id, title FROM editor.pages')) return [{ id: DB, title: 'My DB' }];
      return [];
    });
    const ds = makePostgresDataSource(sql);
    const schema = await ds.schema(DB);
    expect(schema?.database).toEqual({ id: DB, title: 'My DB' });
    expect(calls.some((c) => c.text.includes('FROM editor.db_properties'))).toBe(true);
    expect(calls.some((c) => c.text.includes('FROM editor.db_views'))).toBe(true);
  });
});

describe('makeExternalPostgresDataSource', () => {
  it('refuses an unsafe / internal connection target before opening a socket', () => {
    expect(() =>
      makeExternalPostgresDataSource({ connectionString: 'postgres://localhost:5432/db' }),
    ).toThrow(/unsafe|internal/i);
    expect(() =>
      makeExternalPostgresDataSource({ connectionString: 'postgres://127.0.0.1/db' }),
    ).toThrow(/unsafe|internal/i);
    expect(() =>
      makeExternalPostgresDataSource({ connectionString: 'postgres://169.254.169.254/db' }),
    ).toThrow(/unsafe|internal/i);
    expect(() =>
      makeExternalPostgresDataSource({ connectionString: 'http://example.com/db' }),
    ).toThrow(/unsafe|internal/i);
  });

  it('builds a read-only source by default for a safe external target', () => {
    const ds = makeExternalPostgresDataSource({
      connectionString: 'postgres://user:pw@db.example.com:5432/app',
    });
    expect(ds.capabilities().readOnly).toBe(true);
    expect(ds).toBeInstanceOf(PostgresDataSource);
    void ds.sql.end?.({ timeout: 0 });
  });

  it('honors readOnly:false to build a writable external source', () => {
    const ds = makeExternalPostgresDataSource({
      connectionString: 'postgres://user:pw@db.example.com/app',
      readOnly: false,
    });
    expect(ds.capabilities().readOnly).toBe(false);
    expect(ds.capabilities().canCreateRow).toBe(true);
    void ds.sql.end?.({ timeout: 0 });
  });
});

describe('host-guard', () => {
  it('isBlockedHost flags loopback / private / link-local / metadata', () => {
    for (const h of [
      'localhost',
      'foo.localhost',
      '127.0.0.1',
      '10.0.0.1',
      '192.168.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '169.254.169.254',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      'metadata.google.internal',
    ]) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });
  it('isBlockedHost allows public hosts', () => {
    for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', 'db.example.com']) {
      expect(isBlockedHost(h)).toBe(false);
    }
  });
  it('isSafeHttpUrl matches the legacy webhook guard rules', () => {
    expect(isSafeHttpUrl('https://example.com/hook')).toBe(true);
    expect(isSafeHttpUrl('http://1.2.3.4/x')).toBe(true);
    expect(isSafeHttpUrl('ftp://example.com')).toBe(false);
    expect(isSafeHttpUrl('http://127.0.0.1/x')).toBe(false);
    expect(isSafeHttpUrl('not a url')).toBe(false);
  });
  it('isSafePostgresConnectionString requires postgres(ql):// + a public host', () => {
    expect(isSafePostgresConnectionString('postgres://db.example.com:5432/app')).toBe(true);
    expect(isSafePostgresConnectionString('postgresql://user:pw@8.8.8.8/app')).toBe(true);
    expect(isSafePostgresConnectionString('postgres://localhost/app')).toBe(false);
    expect(isSafePostgresConnectionString('postgres://10.0.0.1/app')).toBe(false);
    expect(isSafePostgresConnectionString('mysql://db.example.com/app')).toBe(false);
    expect(isSafePostgresConnectionString('https://db.example.com/app')).toBe(false);
    expect(isSafePostgresConnectionString('not a url')).toBe(false);
  });
});
