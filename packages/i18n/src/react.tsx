// React glue: I18nProvider seeds the resolved locale + dict into context;
// useT() returns a memoised translator. Safe in SSR and CSR.

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import {
  createTranslator,
  type Dict,
  type Locale,
  type Translator,
} from "./index";

type Ctx = { locale: Locale; t: Translator };

const I18nContext = createContext<Ctx | null>(null);

export function I18nProvider({
  locale,
  dict,
  children,
}: {
  locale: Locale;
  dict: Dict;
  children: ReactNode;
}) {
  const value = useMemo<Ctx>(
    () => ({ locale, t: createTranslator(dict, locale) }),
    [locale, dict],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * `const { t, locale } = useT()`. Throws if called outside an I18nProvider —
 * forces every consumer to wire the provider once at the root.
 */
export function useT(): Ctx {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT() used outside <I18nProvider>");
  return ctx;
}
