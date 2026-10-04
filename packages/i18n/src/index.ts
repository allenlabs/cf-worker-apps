// Shared, dependency-free i18n primitives for the Allen Labs suite. Kept
// deliberately small because cold-start bundle size matters on Workers.
//
// Usage in an app:
//   import { createTranslator, mergeDicts, type Locale } from "@allenlabs/i18n";
//   import { commonStrings } from "@allenlabs/i18n/dict/common";
//   const appDict = mergeDicts(commonStrings, myAppStrings);
//   const t = createTranslator(appDict, locale);
//   t("nav.home")  // → "Home" or "홈"

export type Locale = "en" | "ko";

export const SUPPORTED_LOCALES = ["en", "ko"] as const;
export const DEFAULT_LOCALE: Locale = "en";

/** Locale → flat keypath → string. Apps merge common + app-specific. */
export type Dict = Record<Locale, Record<string, string>>;

/**
 * Merge `base` and `extra` so each locale's flat-key map contains both. `extra`
 * wins on collision so apps can override common strings if needed.
 */
export function mergeDicts(base: Dict, extra: Partial<Dict>): Dict {
  const out: Dict = { en: { ...base.en }, ko: { ...base.ko } };
  for (const loc of SUPPORTED_LOCALES) {
    const e = extra[loc];
    if (e) Object.assign(out[loc], e);
  }
  return out;
}

/**
 * Build a translator. Returns `key` unchanged when missing in BOTH the chosen
 * locale and the English fallback — so a missing key shows up as the literal
 * key in dev, which is easy to spot.
 *
 * Interpolation: `t("foo", { count: 3 })` replaces `{count}` in the string.
 */
export type Translator = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export function createTranslator(dict: Dict, locale: Locale): Translator {
  const primary = dict[locale] ?? {};
  const fallback = dict[DEFAULT_LOCALE] ?? {};
  return (key, vars) => {
    const raw = primary[key] ?? fallback[key] ?? key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (_, k: string) =>
      k in vars ? String(vars[k]) : `{${k}}`,
    );
  };
}

/** Narrow an unknown value to a supported Locale, with default fallback. */
export function normalizeLocale(value: unknown): Locale {
  if (typeof value !== "string") return DEFAULT_LOCALE;
  const v = value.toLowerCase().split("-")[0] as string;
  return (SUPPORTED_LOCALES as readonly string[]).includes(v)
    ? (v as Locale)
    : DEFAULT_LOCALE;
}
