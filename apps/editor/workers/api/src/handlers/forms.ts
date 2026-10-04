// Database Forms — Notion-style form view + a publicly-shareable form page
// whose submission creates a database row.
//
// TWO public, UNAUTHENTICATED surfaces (wired BEFORE the /v1 HMAC gate in
// index.ts, exactly like GET /public/page/:id):
//   GET  /public/form/:token         → the form DEFINITION for rendering.
//   POST /public/form/:token/submit  → validate answers + create one row.
//
// Both are gated by an ENABLED `editor.form_shares` row keyed on a random
// urlsafe token (NOT by HMAC, NOT by a user identity). A form's public
// availability == an enabled share row for its kind='form' view.
//
// SECURITY (this file is reachable with no auth, so it is strict):
//   - Only the form's WHITELISTED, non-hidden fields may be written. Any other
//     key in the submission is DROPPED — a submitter can never write an
//     arbitrary property/column.
//   - Each answer is COERCED + VALIDATED against the field's property type
//     (required-missing → error; bad select option → rejected; unknown →
//     dropped). multi_select accepts an array of allowed option ids/names.
//   - person / relation / files / rollup / formula / button / auto props are
//     NOT submittable (excluded from the field set) — see FORM_SUPPORTED_TYPES.
//   - The public GET returns ONLY the schema (labels/types/options) — never any
//     existing row data / PII.
//   - The payload is size- and count-guarded before any DB work.
//
// The pure `*Impl(sql/ds, …)` helpers below carry all the logic and are unit
// tested; the router/index wiring is the thin shell.

import type { Sql } from '../lib/db';
import type { DataSource } from '../datasource/types';
import type { DbProperty, DbView } from './db';

// ---------- shapes ----------

/** Property types a form field may collect in v1. */
export const FORM_SUPPORTED_TYPES = new Set<string>([
  'text',
  'number',
  'select',
  'status',
  'multi_select',
  'date',
  'checkbox',
  'url',
  'email',
  'phone',
]);

/** One field in a form definition (stored in the view config, ordered). */
export interface FormFieldDef {
  propId: string;
  label?: string;
  required?: boolean;
  hidden?: boolean;
}

/** The form definition persisted in a kind='form' view's `config` jsonb. */
export interface FormConfig {
  title?: string;
  description?: string;
  fields: FormFieldDef[];
  submitText?: string;
  confirmationMessage?: string;
  /** Mirror of the share-enabled state (the share row is the source of truth). */
  public?: boolean;
}

/** A select/status/multi option surfaced to the public form. */
export interface FormFieldOption {
  id: string;
  name: string;
  color?: string;
}

/** A single resolved field returned to the public renderer. */
export interface PublicFormField {
  propId: string;
  label: string;
  type: string;
  required: boolean;
  options: FormFieldOption[]; // only for select/status/multi_select; else []
}

/** What GET /public/form/:token returns — schema only, no row data. */
export interface PublicFormDefinition {
  title: string;
  description: string;
  submitText: string;
  confirmationMessage: string;
  fields: PublicFormField[];
}

/** A resolved, enabled form share + its database/view ids. */
export interface FormShareRow {
  token: string;
  databaseId: string;
  viewId: string;
  enabled: boolean;
}

// ---------- limits (size / spam guard) ----------

/** Max fields a single form may expose / accept (guards pathological configs). */
export const FORM_MAX_FIELDS = 100;
/** Max length of a single text-ish answer. */
export const FORM_MAX_TEXT_LEN = 5000;
/** Max options a multi_select answer may carry. */
export const FORM_MAX_MULTI = 50;

// ---------- form config helpers (pure) ----------

/**
 * The DEFAULT field set for a form: every property whose type a form can
 * collect, in `position` order, none hidden / required. Auto + unsupported
 * types (person/relation/files/rollup/formula/button) are excluded.
 */
export function defaultFormFields(properties: DbProperty[]): FormFieldDef[] {
  return [...properties]
    .filter((p) => FORM_SUPPORTED_TYPES.has(p.type))
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
    .map((p) => ({ propId: p.id, required: false, hidden: false }));
}

/**
 * Read a view's stored `config` jsonb as a FormConfig, filling defaults from the
 * database's properties. Drops field entries whose propId no longer exists or
 * whose type isn't form-supported, so a stale config can never expose a
 * non-submittable property.
 */
export function readFormConfig(view: DbView, properties: DbProperty[]): FormConfig {
  const byId = new Map(properties.map((p) => [p.id, p]));
  const raw = (view.config ?? {}) as Partial<FormConfig> & Record<string, unknown>;
  const rawFields = Array.isArray(raw.fields) ? raw.fields : null;
  let fields: FormFieldDef[];
  if (rawFields) {
    fields = rawFields
      .filter(
        (f): f is FormFieldDef =>
          !!f && typeof (f as FormFieldDef).propId === 'string',
      )
      .filter((f) => {
        const prop = byId.get(f.propId);
        return !!prop && FORM_SUPPORTED_TYPES.has(prop.type);
      })
      .map((f) => ({
        propId: f.propId,
        label: typeof f.label === 'string' ? f.label : undefined,
        required: f.required === true,
        hidden: f.hidden === true,
      }));
  } else {
    fields = defaultFormFields(properties);
  }
  return {
    title: typeof raw.title === 'string' ? raw.title : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    fields,
    submitText: typeof raw.submitText === 'string' ? raw.submitText : undefined,
    confirmationMessage:
      typeof raw.confirmationMessage === 'string' ? raw.confirmationMessage : undefined,
    public: raw.public === true,
  };
}

/** Extract select/status/multi_select options from a property config. */
export function optionsForProperty(prop: DbProperty): FormFieldOption[] {
  const cfg = prop.config as { options?: unknown } | undefined;
  const opts = cfg?.options;
  if (!Array.isArray(opts)) return [];
  return opts
    .filter((o): o is { id: string; name: string; color?: string } => {
      const oo = o as { id?: unknown; name?: unknown };
      return !!o && typeof oo.id === 'string' && typeof oo.name === 'string';
    })
    .map((o) => ({ id: o.id, name: o.name, color: o.color }));
}

/**
 * Resolve a FormConfig + the database properties into the public, renderable
 * definition: only VISIBLE fields, each carrying its label/type/required +
 * (for select-ish types) its allowed options. No row data is included.
 */
export function buildPublicDefinition(
  config: FormConfig,
  properties: DbProperty[],
): PublicFormDefinition {
  const byId = new Map(properties.map((p) => [p.id, p]));
  const fields: PublicFormField[] = [];
  for (const f of config.fields) {
    if (f.hidden) continue;
    const prop = byId.get(f.propId);
    if (!prop || !FORM_SUPPORTED_TYPES.has(prop.type)) continue;
    const isSelectish =
      prop.type === 'select' || prop.type === 'status' || prop.type === 'multi_select';
    fields.push({
      propId: prop.id,
      label: (f.label && f.label.trim()) || prop.name,
      type: prop.type,
      required: f.required === true,
      options: isSelectish ? optionsForProperty(prop) : [],
    });
    if (fields.length >= FORM_MAX_FIELDS) break;
  }
  return {
    title: config.title?.trim() || '',
    description: config.description?.trim() || '',
    submitText: config.submitText?.trim() || 'Submit',
    confirmationMessage:
      config.confirmationMessage?.trim() || 'Thanks! Your response has been recorded.',
    fields,
  };
}

// ---------- submission validation + coercion (pure) ----------

export interface ValidateResult {
  /** The whitelisted, coerced props to write (keyed by propId). */
  props: Record<string, unknown>;
  /** Field-level errors (propId → message). Empty when valid. */
  errors: Record<string, string>;
}

/**
 * Validate + coerce a raw submission against the form's VISIBLE fields.
 *
 *   - Iterates only the form's own fields → unknown/hidden/non-form keys in
 *     `answers` are silently DROPPED (never written).
 *   - required + empty → error.
 *   - per-type coercion (number, checkbox, date, url/email/phone, text) +
 *     allowed-option enforcement for select/status/multi_select.
 *
 * Returns the props map to persist (only when `errors` is empty should the
 * caller proceed to create the row).
 */
export function validateSubmission(
  config: FormConfig,
  properties: DbProperty[],
  answers: Record<string, unknown>,
): ValidateResult {
  const byId = new Map(properties.map((p) => [p.id, p]));
  const props: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  for (const f of config.fields) {
    if (f.hidden) continue;
    const prop = byId.get(f.propId);
    if (!prop || !FORM_SUPPORTED_TYPES.has(prop.type)) continue;
    const raw = answers[f.propId];
    const required = f.required === true;

    const isEmpty =
      raw === undefined ||
      raw === null ||
      (typeof raw === 'string' && raw.trim() === '') ||
      (Array.isArray(raw) && raw.length === 0);

    if (isEmpty) {
      if (required) errors[f.propId] = 'required';
      continue; // omit empty optional answers
    }

    const coerced = coerceAnswer(prop, raw);
    if (coerced.error) {
      errors[f.propId] = coerced.error;
      continue;
    }
    if (coerced.value !== undefined) props[f.propId] = coerced.value;
  }

  return { props, errors };
}

interface Coerced {
  value?: unknown;
  error?: string;
}

/** Coerce + validate one answer against a property type. */
export function coerceAnswer(prop: DbProperty, raw: unknown): Coerced {
  switch (prop.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return { error: 'not_a_number' };
      return { value: n };
    }
    case 'checkbox': {
      if (typeof raw === 'boolean') return { value: raw };
      const s = String(raw).trim().toLowerCase();
      if (s === 'true' || s === 'on' || s === '1' || s === 'yes') return { value: true };
      if (s === 'false' || s === 'off' || s === '0' || s === 'no') return { value: false };
      return { error: 'not_a_boolean' };
    }
    case 'select':
    case 'status': {
      const opts = optionsForProperty(prop);
      const s = String(raw).trim();
      const match = opts.find((o) => o.id === s || o.name === s);
      if (!match) return { error: 'invalid_option' };
      // Stored cell value is the option NAME (matches the editor's select cells).
      return { value: match.name };
    }
    case 'multi_select': {
      const list = Array.isArray(raw) ? raw : [raw];
      if (list.length > FORM_MAX_MULTI) return { error: 'too_many_options' };
      const opts = optionsForProperty(prop);
      const out: string[] = [];
      for (const item of list) {
        const s = String(item).trim();
        if (s === '') continue;
        const match = opts.find((o) => o.id === s || o.name === s);
        if (!match) return { error: 'invalid_option' };
        if (!out.includes(match.name)) out.push(match.name);
      }
      return { value: out };
    }
    case 'date': {
      const s = String(raw).trim();
      // Accept ISO date / datetime; reject anything Date can't parse.
      const ms = Date.parse(s);
      if (Number.isNaN(ms)) return { error: 'invalid_date' };
      return { value: s };
    }
    case 'url': {
      const s = String(raw).trim();
      if (s.length > FORM_MAX_TEXT_LEN) return { error: 'too_long' };
      return { value: s };
    }
    case 'email':
    case 'phone':
    case 'text':
    default: {
      const s = String(raw);
      if (s.length > FORM_MAX_TEXT_LEN) return { error: 'too_long' };
      return { value: s };
    }
  }
}

// ---------- form_shares persistence (pure SQL impls) ----------

/** A urlsafe random token for a form share (no padding, no +/). */
export function generateFormToken(rand: () => string = () => crypto.randomUUID()): string {
  return (rand() + rand()).replace(/-/g, '');
}

/**
 * Resolve an ENABLED form share by token (the public gate). Returns null when
 * the token is unknown or the share is disabled — callers map that to 404.
 */
export async function formShareByTokenImpl(
  sql: Sql,
  token: string,
): Promise<FormShareRow | null> {
  const [row] = await sql<
    { token: string; databaseId: string; viewId: string; enabled: boolean }[]
  >`
    SELECT token, database_id AS "databaseId", view_id AS "viewId", enabled
    FROM editor.form_shares
    WHERE token = ${token} AND enabled = true
    LIMIT 1
  `;
  return row ?? null;
}

/** The share row for a view (any enabled state), or null. */
export async function formShareForViewImpl(
  sql: Sql,
  viewId: string,
): Promise<FormShareRow | null> {
  const [row] = await sql<
    { token: string; databaseId: string; viewId: string; enabled: boolean }[]
  >`
    SELECT token, database_id AS "databaseId", view_id AS "viewId", enabled
    FROM editor.form_shares
    WHERE view_id = ${viewId}
    LIMIT 1
  `;
  return row ?? null;
}

/**
 * Create / enable / disable the public share for a form view (the "Share form"
 * toggle). Idempotent: upserts on view_id, flipping `enabled`. Returns the
 * resulting share row (the token stays stable across re-enables).
 */
export async function setFormShareImpl(
  sql: Sql,
  input: { databaseId: string; viewId: string; enabled: boolean; createdBy?: string | null },
  rand: () => string = () => crypto.randomUUID(),
): Promise<FormShareRow> {
  const existing = await formShareForViewImpl(sql, input.viewId);
  if (existing) {
    const [row] = await sql<{ token: string; enabled: boolean }[]>`
      UPDATE editor.form_shares SET enabled = ${input.enabled}
      WHERE view_id = ${input.viewId}
      RETURNING token, enabled
    `;
    return {
      token: row?.token ?? existing.token,
      databaseId: input.databaseId,
      viewId: input.viewId,
      enabled: row?.enabled ?? input.enabled,
    };
  }
  const token = generateFormToken(rand);
  const [row] = await sql<{ token: string; enabled: boolean }[]>`
    INSERT INTO editor.form_shares (token, database_id, view_id, enabled, created_by)
    VALUES (${token}, ${input.databaseId}, ${input.viewId}, ${input.enabled},
            ${input.createdBy ?? null})
    RETURNING token, enabled
  `;
  return {
    token: row?.token ?? token,
    databaseId: input.databaseId,
    viewId: input.viewId,
    enabled: row?.enabled ?? input.enabled,
  };
}

// ---------- public GET / POST orchestration (DataSource-routed) ----------

/**
 * Build the public form definition for an enabled token. Resolves the view +
 * properties through the DataSource (so native_do databases work too), reads
 * the form config from the view, and returns SCHEMA ONLY. Returns null when the
 * token/share/view is missing or the view isn't a form (→ 404).
 *
 * `ds` is the backend resolved from `share.databaseId` by the caller.
 */
export async function publicFormDefinitionImpl(
  ds: DataSource,
  share: FormShareRow,
): Promise<PublicFormDefinition | null> {
  const schema = await ds.schema(share.databaseId);
  if (!schema) return null;
  const view = schema.views.find((v) => v.id === share.viewId);
  if (!view || view.type !== 'form') return null;
  const config = readFormConfig(view, schema.properties);
  return buildPublicDefinition(config, schema.properties);
}

export type SubmitOutcome =
  | { ok: true; rowId: string }
  | { ok: false; status: number; errors: Record<string, string> };

/**
 * Validate an anonymous submission against the token's form and, when valid,
 * create exactly ONE row in the database with only the whitelisted, coerced
 * field values. Routes through the passed DataSource so native_do DBs work.
 *
 *   - Drops unknown/hidden/non-form keys (never writes arbitrary props).
 *   - Returns { ok:false, status:400, errors } on validation failure.
 *   - Returns { ok:false, status:404 } when the form/view can't be resolved.
 *
 * `ownerId` attributes the row to an anonymous/"Form" author.
 */
export async function submitFormImpl(
  ds: DataSource,
  share: FormShareRow,
  answers: Record<string, unknown>,
  ownerId: string,
): Promise<SubmitOutcome> {
  const schema = await ds.schema(share.databaseId);
  if (!schema) return { ok: false, status: 404, errors: {} };
  const view = schema.views.find((v) => v.id === share.viewId);
  if (!view || view.type !== 'form') return { ok: false, status: 404, errors: {} };

  const config = readFormConfig(view, schema.properties);
  const { props, errors } = validateSubmission(config, schema.properties, answers);
  if (Object.keys(errors).length > 0) {
    return { ok: false, status: 400, errors };
  }

  // Create the row, then set its whitelisted cell props. A row with no answers
  // (all optional + blank) is still a valid submission (creates an empty row).
  const row = await ds.createRow({ databaseId: share.databaseId, ownerId });
  if (Object.keys(props).length > 0) {
    await ds.updateRow({ rowId: row.id, props });
  }
  return { ok: true, rowId: row.id };
}
