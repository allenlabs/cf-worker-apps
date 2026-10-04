// Suite-wide language picker. Sets the `lang` cookie on .allenlabs.org so
// every other ADHD-suite app sees the user's choice on next nav, then reloads
// so SSR re-renders in the new locale.
import { useT } from "@allenlabs/i18n/react";
import { SUPPORTED_LOCALES, type Locale } from "@allenlabs/i18n";

function setLangCookie(loc: Locale) {
  if (typeof document === "undefined") return;
  const maxAge = 365 * 24 * 60 * 60;
  document.cookie = `lang=${loc}; Path=/; Domain=.allenlabs.org; Max-Age=${maxAge}; SameSite=Lax; Secure`;
}

export function LanguagePicker({ className = "" }: { className?: string }) {
  const { locale, t } = useT();
  return (
    <div className={`flex items-center gap-1 text-xs ${className}`} role="group" aria-label={t("locale.label")}>
      {SUPPORTED_LOCALES.map((loc) => {
        const active = loc === locale;
        return (
          <button
            key={loc}
            type="button"
            aria-pressed={active}
            title={t(`locale.switchTo.${loc}`)}
            onClick={() => {
              setLangCookie(loc);
              if (typeof window !== "undefined") window.location.reload();
            }}
            className={`px-1.5 py-0.5 rounded ${active ? "bg-slate-700 text-slate-100" : "text-slate-400 hover:bg-slate-800"}`}
          >
            {loc === "ko" ? "한" : "EN"}
          </button>
        );
      })}
    </div>
  );
}
