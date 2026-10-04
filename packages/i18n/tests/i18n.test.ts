import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  createTranslator,
  mergeDicts,
  normalizeLocale,
  type Dict,
} from "../src/index";
import {
  LANG_COOKIE_NAME,
  buildLangCookie,
  resolveLocale,
} from "../src/server";
import { commonStrings } from "../src/dictionaries/index";

const base: Dict = {
  en: { greet: "Hello, {name}", lone: "english only" },
  ko: { greet: "{name}님 안녕하세요" },
};

describe("createTranslator", () => {
  it("returns the localised string with interpolation", () => {
    const t = createTranslator(base, "ko");
    expect(t("greet", { name: "Allen" })).toBe("Allen님 안녕하세요");
  });

  it("falls back to English when the key is missing in the chosen locale", () => {
    const t = createTranslator(base, "ko");
    expect(t("lone")).toBe("english only");
  });

  it("returns the key itself when missing in BOTH locales (dev signal)", () => {
    const t = createTranslator(base, "en");
    expect(t("nope.absent")).toBe("nope.absent");
  });

  it("preserves placeholder when the interpolation var is missing", () => {
    const t = createTranslator(base, "en");
    expect(t("greet", { other: "x" })).toBe("Hello, {name}");
  });

  it("handles the no-vars call", () => {
    const t = createTranslator(base, "en");
    expect(t("greet")).toBe("Hello, {name}");
  });
});

describe("mergeDicts", () => {
  it("merges per-locale flat maps with extra winning", () => {
    const out = mergeDicts(base, {
      en: { greet: "Howdy {name}", extra: "x" },
    });
    const t = createTranslator(out, "en");
    expect(t("greet", { name: "A" })).toBe("Howdy A");
    expect(t("extra")).toBe("x");
    expect(t("lone")).toBe("english only");
  });

  it("leaves a locale untouched when extra omits it", () => {
    const out = mergeDicts(base, { en: { added: "y" } });
    expect(out.ko.greet).toBe("{name}님 안녕하세요");
  });
});

describe("normalizeLocale", () => {
  it("accepts a supported short code", () => {
    expect(normalizeLocale("ko")).toBe("ko");
  });

  it("strips region tags (e.g. en-US -> en)", () => {
    expect(normalizeLocale("en-US")).toBe("en");
  });

  it("falls back for unsupported / non-strings", () => {
    expect(normalizeLocale("fr")).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale(42)).toBe(DEFAULT_LOCALE);
  });
});

describe("resolveLocale", () => {
  const mk = (
    h: Record<string, string> = {},
  ): Request => new Request("https://x.test/", { headers: h });

  it("prefers the cookie over everything else", () => {
    const r = mk({
      cookie: `${LANG_COOKIE_NAME}=ko; other=v`,
      "accept-language": "en-US",
    });
    expect(resolveLocale(r, "en")).toBe("ko");
  });

  it("falls back to JWT-supplied locale when no cookie", () => {
    const r = mk({ "accept-language": "en-US" });
    expect(resolveLocale(r, "ko")).toBe("ko");
  });

  it("falls back to Accept-Language when no cookie or JWT locale", () => {
    const r = mk({ "accept-language": "ko-KR,en;q=0.5" });
    expect(resolveLocale(r)).toBe("ko");
  });

  it("decodes URL-encoded cookie values", () => {
    const r = mk({ cookie: `${LANG_COOKIE_NAME}=${encodeURIComponent("ko")}` });
    expect(resolveLocale(r)).toBe("ko");
  });

  it("returns the default for empty input", () => {
    expect(resolveLocale(mk())).toBe(DEFAULT_LOCALE);
  });
});

describe("buildLangCookie", () => {
  it("builds a suite-wide cookie with the given domain", () => {
    const c = buildLangCookie("ko", { domain: ".allenlabs.org" });
    expect(c).toContain("lang=ko");
    expect(c).toContain("Domain=.allenlabs.org");
    expect(c).toContain("Path=/");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
  });

  it("omits the Domain attribute when not provided", () => {
    expect(buildLangCookie("en")).not.toContain("Domain=");
  });

  it("respects a custom maxAgeDays", () => {
    expect(buildLangCookie("en", { maxAgeDays: 1 })).toContain(
      "Max-Age=86400",
    );
  });
});

describe("commonStrings dictionary", () => {
  it("declares every common key for every supported locale", () => {
    const keys = Object.keys(commonStrings.en);
    for (const loc of SUPPORTED_LOCALES) {
      for (const k of keys) {
        expect(
          commonStrings[loc][k],
          `missing ${loc}.${k}`,
        ).toBeTypeOf("string");
      }
    }
  });
});
