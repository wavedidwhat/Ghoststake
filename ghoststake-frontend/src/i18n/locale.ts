/**
 * The languages the app is served in (GHO-128), and how a visitor's is chosen.
 *
 * Its own module, apart from `request.ts`, because the switcher and the
 * formatting code run in the browser too and `request.ts` pulls in
 * `next-intl/server`.
 *
 * No locale in the URL: a shared link opens in the reader's own language, and
 * no route changes. The choice is a cookie set by the switcher; without one,
 * the browser's Accept-Language; without a match, English.
 */
export const locales = ["en", "es", "pt-BR", "zh-Hans"] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";

/** The cookie the language switcher writes. next-intl's own name for it. */
export const LOCALE_COOKIE = "NEXT_LOCALE";

/** Each language in its own words, for the switcher. Not translated: a
 *  Spanish speaker looking for Spanish needs "Español" whatever the page is in. */
export const localeNames: Record<Locale, string> = {
  en: "English",
  es: "Español",
  "pt-BR": "Português (Brasil)",
  "zh-Hans": "简体中文",
};

export function isLocale(value: string | undefined): value is Locale {
  return value !== undefined && (locales as readonly string[]).includes(value);
}

/**
 * The best supported locale for an Accept-Language header, or undefined.
 *
 * Matches on language, then script or region: "pt-PT" gets Brazilian
 * Portuguese rather than English, and any Chinese that isn't written in
 * Traditional script ("zh", "zh-CN", "zh-SG") gets Simplified. Traditional
 * ("zh-TW", "zh-HK", "zh-Hant") is left to fall through to English, because
 * Simplified is a different script, not a dialect.
 */
export function negotiate(acceptLanguage: string | null | undefined): Locale | undefined {
  if (!acceptLanguage) return undefined;
  const wanted = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { tag: tag.toLowerCase(), q: q ? Number(q.slice(2)) : 1 };
    })
    .filter((w) => w.tag && w.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of wanted) {
    const [lang] = tag.split("-");
    if (lang === "en") return "en";
    if (lang === "es") return "es";
    if (lang === "pt") return "pt-BR";
    if (lang === "zh") {
      if (/-(hant|tw|hk|mo)\b/.test(tag)) continue;
      return "zh-Hans";
    }
  }
  return undefined;
}
