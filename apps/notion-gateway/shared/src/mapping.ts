// Canonical home for the consumer-field -> Notion-property mapping logic.
//
// Previously lived in PM's `server/notion.ts`; lifted into the gateway so
// every consumer app gets the same suggestion + payload-building
// behaviour without copy-pasting.
//
// The shape is intentionally string-keyed (no PM-specific TS enums) so
// future apps with their own field catalogues can plug in.

import type { FieldCatalogue, NotionMapping, NotionProperty } from './types';

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * Heuristic auto-mapper:
 *
 *   1. Exact name match (ignoring case / whitespace / underscores /
 *      hyphens) against either the consumer field key OR its label,
 *      provided the Notion property's type is compatible.
 *   2. Otherwise, the first type-compatible property in declaration
 *      order — Notion preserves insertion order in `/v1/databases/:id`.
 *   3. Otherwise null — the user picks in the admin UI.
 *
 * The returned mapping snapshots the matched property's id, name, and
 * type so `buildProperties` can build a payload without re-fetching
 * the database schema on every push.
 */
export function suggestMapping(
  fields: FieldCatalogue,
  notionProps: Record<string, NotionProperty>,
): NotionMapping {
  const propsList = Object.values(notionProps);
  const mapping: NotionMapping = { fields: {} };
  for (const field of fields) {
    const candidates = propsList.filter((p) => field.compatibleTypes.includes(p.type));
    if (candidates.length === 0) {
      mapping.fields[field.key] = null;
      continue;
    }
    const targets = [normalizeName(field.key), normalizeName(field.label)];
    const exact = candidates.find((p) => targets.includes(normalizeName(p.name)));
    // candidates is non-empty so `candidates[0]` always resolves.  We
    // still narrow with `??` so noUncheckedIndexedAccess is happy.
    const chosen = exact ?? candidates[0]!;
    mapping.fields[field.key] = {
      propertyId: chosen.id,
      propertyName: chosen.name,
      propertyType: chosen.type,
    };
  }
  return mapping;
}

// ---------- buildProperties ----------

const MAX_RICH_TEXT_LEN = 2000;

function truncate(s: string, max = MAX_RICH_TEXT_LEN): string {
  return s.length <= max ? s : s.slice(0, max);
}

export interface BuildPropertiesDeps {
  resolvePersonId?: (email: string) => Promise<string | null>;
}

/**
 * Build a single Notion property payload from a raw value + the
 * persisted property type.  Read-only Notion types (formula,
 * created_time, last_edited_time, rollup) and unknown types return
 * `undefined`, which the caller treats as "skip".
 */
export async function buildPropertyValue(
  pmKey: string,
  value: unknown,
  propertyType: string,
  deps: BuildPropertiesDeps = {},
): Promise<Record<string, unknown> | undefined> {
  if (
    propertyType === 'created_time' ||
    propertyType === 'last_edited_time' ||
    propertyType === 'formula' ||
    propertyType === 'rollup'
  ) {
    return undefined;
  }
  // null / empty -> clear the property where supported, skip otherwise.
  if (value === null || value === undefined || value === '') {
    if (propertyType === 'select' || propertyType === 'status') return { [propertyType]: null };
    if (propertyType === 'multi_select') return { multi_select: [] };
    if (propertyType === 'date') return { date: null };
    if (propertyType === 'people') return { people: [] };
    if (propertyType === 'number') return { number: null };
    if (propertyType === 'checkbox') return { checkbox: false };
    if (
      propertyType === 'url' ||
      propertyType === 'email' ||
      propertyType === 'phone_number'
    ) {
      return { [propertyType]: null };
    }
    if (propertyType === 'rich_text' || propertyType === 'title') {
      return { [propertyType]: [] };
    }
    return undefined;
  }

  switch (propertyType) {
    case 'title':
      return {
        title: [{ type: 'text', text: { content: truncate(String(value)) } }],
      };
    case 'rich_text':
      return {
        rich_text: [{ type: 'text', text: { content: truncate(String(value)) } }],
      };
    case 'select':
      return { select: { name: String(value) } };
    case 'status':
      return { status: { name: String(value) } };
    case 'multi_select': {
      const items = Array.isArray(value) ? value : [value];
      return { multi_select: items.map((v) => ({ name: String(v) })) };
    }
    case 'date':
      return { date: { start: String(value) } };
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return { number: null };
      return { number: n };
    }
    case 'checkbox':
      return { checkbox: Boolean(value) };
    case 'url':
      return { url: String(value) };
    case 'email':
      return { email: String(value) };
    case 'phone_number':
      return { phone_number: String(value) };
    case 'people': {
      const email = String(value);
      const id = deps.resolvePersonId ? await deps.resolvePersonId(email) : null;
      if (!id) return undefined;
      return { people: [{ id }] };
    }
    default:
      // Unknown / read-only types — caller skips.
      return undefined;
  }
}

/**
 * Build the full `properties` object for a Notion page from a flat
 * field map.  `fields` is the consumer's view of its record — e.g.
 * `{ subject: 'Fix bug', dueDate: '2026-06-01' }` — and `mapping` says
 * which Notion property each key should land in.
 */
export async function buildProperties(
  catalogue: FieldCatalogue,
  fields: Record<string, unknown>,
  mapping: NotionMapping,
  deps: BuildPropertiesDeps = {},
): Promise<Record<string, Record<string, unknown>>> {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const field of catalogue) {
    const target = mapping.fields[field.key];
    if (!target) continue;
    const value = fields[field.key];
    const payload = await buildPropertyValue(field.key, value, target.propertyType, deps);
    if (payload === undefined) continue;
    properties[target.propertyName] = payload;
  }
  return properties;
}

// ---------- inverseMapping (Notion -> consumer) ----------

/**
 * Inverse of `buildPropertyValue`: read a single Notion `PageProperty`
 * union value back into a primitive that consumer apps actually want to
 * see (string / number / boolean / string[]).  Anything we can't reduce
 * cleanly (formula, rollup, files, unique_id, …) returns `undefined`
 * and the caller drops the field from the outbound payload.
 */
export function notionPropertyToPrimitive(
  property: unknown,
): string | number | boolean | string[] | null | undefined {
  if (!property || typeof property !== 'object') return undefined;
  const p = property as { type?: string } & Record<string, unknown>;
  switch (p.type) {
    case 'title': {
      const items = (p.title as Array<{ plain_text?: string }>) ?? [];
      return items.map((it) => it.plain_text ?? '').join('');
    }
    case 'rich_text': {
      const items = (p.rich_text as Array<{ plain_text?: string }>) ?? [];
      return items.map((it) => it.plain_text ?? '').join('');
    }
    case 'select': {
      const sel = p.select as { name?: string } | null | undefined;
      return sel?.name ?? null;
    }
    case 'status': {
      const sel = p.status as { name?: string } | null | undefined;
      return sel?.name ?? null;
    }
    case 'multi_select': {
      const items = (p.multi_select as Array<{ name?: string }>) ?? [];
      return items.map((it) => it.name ?? '').filter((s) => s.length > 0);
    }
    case 'date': {
      const d = p.date as { start?: string; end?: string | null } | null | undefined;
      return d?.start ?? null;
    }
    case 'number': {
      const n = p.number as number | null | undefined;
      return n ?? null;
    }
    case 'checkbox':
      return Boolean(p.checkbox);
    case 'url':
      return (p.url as string | null | undefined) ?? null;
    case 'email':
      return (p.email as string | null | undefined) ?? null;
    case 'phone_number':
      return (p.phone_number as string | null | undefined) ?? null;
    case 'people': {
      const items = (p.people as Array<{ person?: { email?: string } }>) ?? [];
      return items
        .map((it) => it.person?.email ?? '')
        .filter((s) => s.length > 0);
    }
    case 'created_time':
      return (p.created_time as string | undefined) ?? null;
    case 'last_edited_time':
      return (p.last_edited_time as string | undefined) ?? null;
    default:
      // formula / rollup / files / unique_id / unknown — skip.
      return undefined;
  }
}

/**
 * Translate a Notion `properties` map back into a consumer-shaped
 * `{ pmKey: primitive }` payload, driven by the same mapping JSON we use
 * for pushes.  Each PM field looks up its mapped Notion property
 * (matched by `propertyName`, falling back to `propertyId`) and runs the
 * value through `notionPropertyToPrimitive`.
 *
 * Used by the webhook handler to ship Notion-side changes back to the
 * consumer app in the shape it expects.
 */
export function getInverseMapping(
  catalogue: FieldCatalogue,
  mapping: NotionMapping,
  notionProperties: Record<string, unknown>,
): Record<string, string | number | boolean | string[] | null> {
  // Build a (propertyName | propertyId) -> raw-property lookup since
  // either could be stable across schema renames.
  const byName: Record<string, unknown> = {};
  const byId: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(notionProperties)) {
    byName[name] = raw;
    if (raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string') {
      byId[(raw as { id: string }).id] = raw;
    }
  }
  const out: Record<string, string | number | boolean | string[] | null> = {};
  for (const field of catalogue) {
    const target = mapping.fields[field.key];
    if (!target) continue;
    const raw = byName[target.propertyName] ?? byId[target.propertyId];
    if (raw === undefined) continue;
    const primitive = notionPropertyToPrimitive(raw);
    if (primitive === undefined) continue;
    out[field.key] = primitive;
  }
  return out;
}
