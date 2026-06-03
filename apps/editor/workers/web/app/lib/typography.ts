// Phase 18: per-page typography presentation.
//
// A page carries a `font` ('default' | 'serif' | 'mono') and a `smallText`
// flag. These are purely presentational: they map to CSS classes applied on
// the page/editor container so the editor + rendered content pick them up.
// Kept as a pure module so the mapping is unit-testable.

export type PageFont = 'default' | 'serif' | 'mono';

/**
 * A page icon is an IMAGE when it's a URL (uploaded/linked) rather than an
 * emoji glyph. Uploaded files come back as absolute R2 URLs (http/https) or
 * `/files/` relative paths; everything else (emoji) renders as text.
 */
export function isImageIcon(icon: string | null | undefined): boolean {
  if (!icon) return false;
  return /^https?:\/\//.test(icon) || icon.startsWith('/files/');
}

/** The selectable fonts, in menu order. */
export const PAGE_FONTS: PageFont[] = ['default', 'serif', 'mono'];

/** Coerce an arbitrary stored value to a known font (default fallback). */
export function normalizeFont(value: string | null | undefined): PageFont {
  return value === 'serif' || value === 'mono' ? value : 'default';
}

/**
 * Build the className for a page container from its typography settings. The
 * `default` font contributes no class (the app's base font wins); `serif`/`mono`
 * map to `ae-page-serif` / `ae-page-mono`; small text adds `ae-page-small`.
 * Returns a single space-joined string (empty when everything is default).
 */
export function pageTypographyClass(font: string | null | undefined, smallText: boolean | undefined): string {
  const classes: string[] = [];
  const f = normalizeFont(font);
  if (f === 'serif') classes.push('ae-page-serif');
  else if (f === 'mono') classes.push('ae-page-mono');
  if (smallText) classes.push('ae-page-small');
  return classes.join(' ');
}
