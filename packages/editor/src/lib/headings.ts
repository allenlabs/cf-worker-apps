/**
 * Slugify a heading's text into a URL-/DOM-id-safe anchor fragment. Lowercases,
 * trims, replaces runs of non-alphanumerics with a single hyphen, and strips
 * leading/trailing hyphens. Keeps Unicode letters/numbers so non-Latin headings
 * still get a meaningful slug. Pure → unit-tested.
 */
export function slugifyHeading(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** One entry in the table-of-contents outline. */
export interface TocEntry {
  /** Heading level (1–3). */
  level: number;
  /** Heading text content. */
  text: string;
  /** The heading node's stable `id` attribute (scroll anchor). */
  id: string;
}

/**
 * Generate a stable, unique heading id. When a heading already has an id, keep
 * it. Otherwise derive a slug from the text; if that slug (or empty text)
 * collides with one already used, append a short suffix so anchors stay unique.
 * `used` is mutated to record the returned id. Pure → unit-tested.
 */
export function ensureHeadingId(
  existing: string | null | undefined,
  text: string,
  used: Set<string>,
): string {
  if (existing && !used.has(existing)) {
    used.add(existing);
    return existing;
  }
  const base = slugifyHeading(text) || 'heading';
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}
