// Unit tests for database Forms (handlers/forms.ts):
//   - form config helpers: defaultFormFields / readFormConfig / optionsForProperty
//     / buildPublicDefinition (excludes hidden + unsupported types; resolves
//     labels + options; never leaks row data).
//   - submission validation + coercion: required-missing → error, bad select
//     option → rejected, multi_select array, type coercion, unknown-prop drop.
//   - form_shares SQL impls (token gate, view upsert/enable/disable) via the
//     same fake tagged-template Sql the other handler tests use.
//   - publicFormDefinitionImpl / submitFormImpl routed through a fake DataSource
//     (proves the DataSource path + the row-creation whitelist).

import { describe, it, expect, vi } from 'vitest';
import {
  FORM_SUPPORTED_TYPES,
  defaultFormFields,
  readFormConfig,
  optionsForProperty,
  buildPublicDefinition,
  validateSubmission,
  coerceAnswer,
  generateFormToken,
  formShareByTokenImpl,
  formShareForViewImpl,
  setFormShareImpl,
  publicFormDefinitionImpl,
  submitFormImpl,
  type FormConfig,
} from '@api/handlers/forms';
import type { DbProperty, DbView, DbSchema, DbRow } from '@api/handlers/db';
import type { DataSource } from '@api/datasource/types';
import type { Sql } from '@api/lib/db';

const DB = '11111111-1111-1111-1111-111111111111';
const VIEW = '33333333-3333-3333-3333-333333333333';

function prop(partial: Partial<DbProperty> & { id: string; type: string }): DbProperty {
  return {
    id: partial.id,
    databaseId: DB,
    name: partial.name ?? partial.id,
    type: partial.type,
    config: partial.config ?? {},
    position: partial.position ?? 0,
  };
}

const TEXT = prop({ id: 'p_text', name: 'Title', type: 'text', position: 0 });
const NUM = prop({ id: 'p_num', name: 'Count', type: 'number', position: 1 });
const SEL = prop({
  id: 'p_sel',
  name: 'Status',
  type: 'select',
  position: 2,
  config: { options: [{ id: 'o1', name: 'Open' }, { id: 'o2', name: 'Closed' }] },
});
const MULTI = prop({
  id: 'p_multi',
  name: 'Tags',
  type: 'multi_select',
  position: 3,
  config: { options: [{ id: 't1', name: 'a' }, { id: 't2', name: 'b' }] },
});
const CHECK = prop({ id: 'p_chk', name: 'Agree', type: 'checkbox', position: 4 });
const DATE = prop({ id: 'p_date', name: 'When', type: 'date', position: 5 });
// Unsupported in forms — must be excluded everywhere.
const RELATION = prop({ id: 'p_rel', name: 'Linked', type: 'relation', position: 6 });
const FORMULA = prop({ id: 'p_f', name: 'Calc', type: 'formula', position: 7 });

const ALL_PROPS = [TEXT, NUM, SEL, MULTI, CHECK, DATE, RELATION, FORMULA];

function formView(config: Record<string, unknown>): DbView {
  return { id: VIEW, databaseId: DB, name: 'Form', type: 'form', config, position: 0, sourceDatabaseId: null };
}

// ---------- config helpers ----------

describe('FORM_SUPPORTED_TYPES', () => {
  it('includes the v1 input types and excludes person/relation/files/rollup/formula/button', () => {
    for (const t of ['text', 'number', 'select', 'status', 'multi_select', 'date', 'checkbox', 'url', 'email', 'phone']) {
      expect(FORM_SUPPORTED_TYPES.has(t)).toBe(true);
    }
    for (const t of ['person', 'relation', 'files', 'rollup', 'formula', 'button', 'created_time']) {
      expect(FORM_SUPPORTED_TYPES.has(t)).toBe(false);
    }
  });
});

describe('defaultFormFields', () => {
  it('includes only form-supported props, ordered by position, none required/hidden', () => {
    const fields = defaultFormFields(ALL_PROPS);
    expect(fields.map((f) => f.propId)).toEqual([
      'p_text',
      'p_num',
      'p_sel',
      'p_multi',
      'p_chk',
      'p_date',
    ]);
    expect(fields.every((f) => f.required === false && f.hidden === false)).toBe(true);
  });
});

describe('readFormConfig', () => {
  it('falls back to default fields when config has none', () => {
    const config = readFormConfig(formView({ title: 'T' }), ALL_PROPS);
    expect(config.title).toBe('T');
    expect(config.fields).toHaveLength(6);
  });

  it('drops stored fields whose prop is missing or unsupported', () => {
    const config = readFormConfig(
      formView({
        fields: [
          { propId: 'p_text', required: true },
          { propId: 'p_rel' }, // unsupported → dropped
          { propId: 'gone' }, // missing → dropped
          { propId: 'p_num', hidden: true },
        ],
      }),
      ALL_PROPS,
    );
    expect(config.fields.map((f) => f.propId)).toEqual(['p_text', 'p_num']);
    expect(config.fields[0]!.required).toBe(true);
    expect(config.fields[1]!.hidden).toBe(true);
  });
});

describe('optionsForProperty', () => {
  it('returns select options, [] for non-select / malformed', () => {
    expect(optionsForProperty(SEL).map((o) => o.name)).toEqual(['Open', 'Closed']);
    expect(optionsForProperty(TEXT)).toEqual([]);
    expect(optionsForProperty(prop({ id: 'x', type: 'select', config: { options: 'bad' } }))).toEqual([]);
  });
});

describe('buildPublicDefinition', () => {
  it('omits hidden + unsupported fields, resolves labels + options, leaks no row data', () => {
    const config: FormConfig = {
      title: ' My form ',
      description: '',
      fields: [
        { propId: 'p_text', label: 'Your name', required: true },
        { propId: 'p_sel' },
        { propId: 'p_num', hidden: true }, // hidden → excluded
        { propId: 'p_rel' }, // unsupported → excluded
      ],
      confirmationMessage: '',
    };
    const def = buildPublicDefinition(config, ALL_PROPS);
    expect(def.title).toBe('My form');
    expect(def.submitText).toBe('Submit');
    expect(def.confirmationMessage).toMatch(/Thanks/);
    expect(def.fields.map((f) => f.propId)).toEqual(['p_text', 'p_sel']);
    expect(def.fields[0]).toMatchObject({ label: 'Your name', required: true, type: 'text', options: [] });
    expect(def.fields[1]!.options.map((o) => o.name)).toEqual(['Open', 'Closed']);
  });
});

// ---------- coercion / validation ----------

describe('coerceAnswer', () => {
  it('number', () => {
    expect(coerceAnswer(NUM, '42')).toEqual({ value: 42 });
    expect(coerceAnswer(NUM, 'nope').error).toBe('not_a_number');
  });
  it('checkbox', () => {
    expect(coerceAnswer(CHECK, true)).toEqual({ value: true });
    expect(coerceAnswer(CHECK, 'yes')).toEqual({ value: true });
    expect(coerceAnswer(CHECK, '0')).toEqual({ value: false });
    expect(coerceAnswer(CHECK, 'maybe').error).toBe('not_a_boolean');
  });
  it('select rejects unknown options, stores the option name', () => {
    expect(coerceAnswer(SEL, 'Open')).toEqual({ value: 'Open' });
    expect(coerceAnswer(SEL, 'o2')).toEqual({ value: 'Closed' }); // by id → name
    expect(coerceAnswer(SEL, 'Nope').error).toBe('invalid_option');
  });
  it('multi_select coerces an array of allowed names, rejects bad ones', () => {
    expect(coerceAnswer(MULTI, ['a', 't2'])).toEqual({ value: ['a', 'b'] });
    expect(coerceAnswer(MULTI, ['a', 'bad']).error).toBe('invalid_option');
  });
  it('date rejects unparseable input', () => {
    expect(coerceAnswer(DATE, '2026-06-04')).toEqual({ value: '2026-06-04' });
    expect(coerceAnswer(DATE, 'not-a-date').error).toBe('invalid_date');
  });
});

describe('validateSubmission', () => {
  const config: FormConfig = {
    fields: [
      { propId: 'p_text', required: true },
      { propId: 'p_num' },
      { propId: 'p_sel' },
    ],
  };

  it('required-missing produces an error and writes no prop', () => {
    const res = validateSubmission(config, ALL_PROPS, { p_num: '5' });
    expect(res.errors.p_text).toBe('required');
  });

  it('drops unknown / hidden / non-form keys — never writes arbitrary props', () => {
    const res = validateSubmission(config, ALL_PROPS, {
      p_text: 'hi',
      p_num: '7',
      p_rel: ['someRowId'], // unsupported prop — not in fields → dropped
      evil: 'rm -rf', // unknown key → dropped
      p_chk: true, // not in this form's fields → dropped
    });
    expect(res.errors).toEqual({});
    expect(res.props).toEqual({ p_text: 'hi', p_num: 7 });
    expect(res.props).not.toHaveProperty('p_rel');
    expect(res.props).not.toHaveProperty('evil');
    expect(res.props).not.toHaveProperty('p_chk');
  });

  it('a bad select option is rejected', () => {
    const res = validateSubmission(config, ALL_PROPS, { p_text: 'x', p_sel: 'Bogus' });
    expect(res.errors.p_sel).toBe('invalid_option');
  });

  it('omits empty optional answers', () => {
    const res = validateSubmission(config, ALL_PROPS, { p_text: 'x', p_num: '' });
    expect(res.errors).toEqual({});
    expect(res.props).toEqual({ p_text: 'x' });
  });
});

// ---------- form_shares SQL impls ----------

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

describe('generateFormToken', () => {
  it('produces a urlsafe token with no dashes', () => {
    const tok = generateFormToken(() => 'aaaa-bbbb-cccc');
    expect(tok).toBe('aaaabbbbccccaaaabbbbcccc');
    expect(tok).not.toMatch(/[-+/=]/);
  });
});

describe('formShareByTokenImpl', () => {
  it('returns an enabled share, null otherwise', async () => {
    const { sql } = fakeSql(() => [
      { token: 'tk', databaseId: DB, viewId: VIEW, enabled: true },
    ]);
    expect(await formShareByTokenImpl(sql, 'tk')).toMatchObject({ token: 'tk', databaseId: DB });
    const { sql: empty } = fakeSql(() => []);
    expect(await formShareByTokenImpl(empty, 'nope')).toBeNull();
  });
});

describe('setFormShareImpl', () => {
  it('inserts a new share with a generated token when none exists', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.startsWith('SELECT')) return []; // formShareForViewImpl → none
      return [{ token: 'newtok', enabled: true }]; // INSERT … RETURNING
    });
    const res = await setFormShareImpl(
      sql,
      { databaseId: DB, viewId: VIEW, enabled: true, createdBy: 'u@x' },
      () => 'zzzz',
    );
    expect(res).toMatchObject({ token: 'newtok', enabled: true, databaseId: DB, viewId: VIEW });
    expect(calls.some((c) => c.text.includes('INSERT INTO editor.form_shares'))).toBe(true);
  });

  it('flips enabled on an existing share (idempotent upsert by view)', async () => {
    const { sql, calls } = fakeSql((text) => {
      if (text.startsWith('SELECT'))
        return [{ token: 'existing', databaseId: DB, viewId: VIEW, enabled: true }];
      return [{ token: 'existing', enabled: false }]; // UPDATE … RETURNING
    });
    const res = await setFormShareImpl(sql, { databaseId: DB, viewId: VIEW, enabled: false });
    expect(res).toMatchObject({ token: 'existing', enabled: false });
    expect(calls.some((c) => c.text.includes('UPDATE editor.form_shares'))).toBe(true);
    expect(calls.some((c) => c.text.includes('INSERT INTO editor.form_shares'))).toBe(false);
  });
});

describe('formShareForViewImpl', () => {
  it('returns the view share row or null', async () => {
    const { sql } = fakeSql(() => [{ token: 't', databaseId: DB, viewId: VIEW, enabled: false }]);
    expect(await formShareForViewImpl(sql, VIEW)).toMatchObject({ enabled: false });
  });
});

// ---------- DataSource-routed GET + submit ----------

function fakeDataSource(schema: DbSchema | null): {
  ds: DataSource;
  created: { databaseId: string; ownerId: string }[];
  updates: { rowId: string; props?: Record<string, unknown> }[];
} {
  const created: { databaseId: string; ownerId: string }[] = [];
  const updates: { rowId: string; props?: Record<string, unknown> }[] = [];
  const ds = {
    schema: vi.fn(async () => schema),
    createRow: vi.fn(async (input: { databaseId: string; ownerId: string }) => {
      created.push(input);
      const row: DbRow = {
        id: 'row-1',
        title: 'Untitled',
        props: {},
        meta: { createdTime: '', lastEditedTime: '', createdById: input.ownerId, createdByName: null },
      };
      return row;
    }),
    updateRow: vi.fn(async (input: { rowId: string; props?: Record<string, unknown> }) => {
      updates.push(input);
      return true;
    }),
  } as unknown as DataSource;
  return { ds, created, updates };
}

const SCHEMA: DbSchema = {
  database: { id: DB, title: 'DB' },
  properties: ALL_PROPS,
  views: [formView({ fields: [{ propId: 'p_text', required: true }, { propId: 'p_num' }, { propId: 'p_rel' }] })],
};
const SHARE = { token: 'tk', databaseId: DB, viewId: VIEW, enabled: true };

describe('publicFormDefinitionImpl', () => {
  it('returns the form schema (excluding the unsupported relation field)', async () => {
    const { ds } = fakeDataSource(SCHEMA);
    const def = await publicFormDefinitionImpl(ds, SHARE);
    expect(def?.fields.map((f) => f.propId)).toEqual(['p_text', 'p_num']);
  });

  it('returns null when the view is not a form', async () => {
    const tableSchema: DbSchema = {
      ...SCHEMA,
      views: [{ ...SCHEMA.views[0]!, type: 'table' }],
    };
    const { ds } = fakeDataSource(tableSchema);
    expect(await publicFormDefinitionImpl(ds, SHARE)).toBeNull();
  });

  it('returns null when schema is missing', async () => {
    const { ds } = fakeDataSource(null);
    expect(await publicFormDefinitionImpl(ds, SHARE)).toBeNull();
  });
});

describe('submitFormImpl', () => {
  it('creates ONE row with only whitelisted, coerced props (drops unknown/unsupported)', async () => {
    const { ds, created, updates } = fakeDataSource(SCHEMA);
    const res = await submitFormImpl(
      ds,
      SHARE,
      { p_text: 'hello', p_num: '12', p_rel: ['x'], evil: 'y' },
      'form-anonymous',
    );
    expect(res).toEqual({ ok: true, rowId: 'row-1' });
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual({ databaseId: DB, ownerId: 'form-anonymous' });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.props).toEqual({ p_text: 'hello', p_num: 12 });
  });

  it('rejects a submission missing a required field (400) without creating a row', async () => {
    const { ds, created } = fakeDataSource(SCHEMA);
    const res = await submitFormImpl(ds, SHARE, { p_num: '1' }, 'form-anonymous');
    expect(res).toEqual({ ok: false, status: 400, errors: { p_text: 'required' } });
    expect(created).toHaveLength(0);
  });

  it('rejects a bad select option (400)', async () => {
    const schema: DbSchema = {
      ...SCHEMA,
      views: [formView({ fields: [{ propId: 'p_sel', required: true }] })],
    };
    const { ds } = fakeDataSource(schema);
    const res = await submitFormImpl(ds, SHARE, { p_sel: 'Bogus' }, 'form-anonymous');
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it('404s when the view is not a form', async () => {
    const tableSchema: DbSchema = { ...SCHEMA, views: [{ ...SCHEMA.views[0]!, type: 'table' }] };
    const { ds } = fakeDataSource(tableSchema);
    const res = await submitFormImpl(ds, SHARE, { p_text: 'x' }, 'form-anonymous');
    expect(res).toMatchObject({ ok: false, status: 404 });
  });

  it('creates a row with no props when all optional answers are blank', async () => {
    const schema: DbSchema = {
      ...SCHEMA,
      views: [formView({ fields: [{ propId: 'p_text' }] })],
    };
    const { ds, created, updates } = fakeDataSource(schema);
    const res = await submitFormImpl(ds, SHARE, {}, 'form-anonymous');
    expect(res).toMatchObject({ ok: true });
    expect(created).toHaveLength(1);
    expect(updates).toHaveLength(0); // no props → no updateRow call
  });
});
