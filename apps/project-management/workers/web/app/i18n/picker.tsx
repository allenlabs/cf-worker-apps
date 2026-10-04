// Suite-wide language picker. Sets the `lang` cookie on .allenlabs.org so the
// switch is instant AND propagates to every other ADHD-suite app on the next
// navigation, then forces a full reload so SSR re-renders in the new locale.
//
// We deliberately write the cookie client-side (document.cookie) instead of
// hitting a server endpoint: the cookie domain is a parent of the page's host
// (projects.allenlabs.org → .allenlabs.org), which the browser allows. No
// round-trip needed.
//
// Durable persistence to the auth profile (so a new device sees the same
// language) lives on the auth-web side, where the user is same-origin with
// /api/auth/update-user. Here we only set the cookie.

import { useT } from "@allenlabs/i18n/react";
import { SUPPORTED_LOCALES, type Locale } from "@allenlabs/i18n";

function setLangCookie(loc: Locale) {
  if (typeof document === "undefined") return;
  const maxAge = 365 * 24 * 60 * 60;
  // Suite-wide cookie scope. Same-origin pages set it without a redirect.
  const cookie = `lang=${loc}; Path=/; Domain=.allenlabs.org; Max-Age=${maxAge}; SameSite=Lax; Secure`;
  document.cookie = cookie;
}

export function LanguagePicker({ className = "" }: { className?: string }) {
  const { locale, t } = useT();
  return (
    <div
      className={`flex items-center gap-1 text-xs ${className}`}
      role="group"
      aria-label={t("locale.label")}
    >
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
              // Full reload so SSR re-renders in the new locale. Router-only
              // navigation would keep the loader-cached `locale` in context.
              if (typeof window !== "undefined") window.location.reload();
            }}
            className={`px-1.5 py-0.5 rounded ${
              active
                ? "bg-white/25 text-white"
                : "text-white/70 hover:bg-white/15"
            }`}
          >
            {loc === "ko" ? "한" : "EN"}
          </button>
        );
      })}
    </div>
  );
}
