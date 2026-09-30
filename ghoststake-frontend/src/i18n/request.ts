import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import en from "../../messages/en.json";
import { LOCALE_COOKIE, defaultLocale, isLocale, negotiate, type Locale } from "./locale";
import { pseudoCatalog } from "./pseudo";

type Catalog = typeof en;

/**
 * Where UI copy comes from (GHO-116), in the visitor's language (GHO-128).
 *
 * The locale is the switcher's cookie, else the browser's Accept-Language,
 * else English; see `locale.ts`. English is the source catalog: it types
 * every key (`global.d.ts`), and every other catalog is laid over it, so a
 * string not yet translated shows in English rather than as its raw key.
 * The catalog tests keep that list at zero, but a missing key must fail as
 * English, never as `roundCard.settlement`.
 */
export default getRequestConfig(async () => {
  const chosen = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale: Locale = isLocale(chosen) ? chosen : (negotiate((await headers()).get("accept-language")) ?? defaultLocale);

  // `GHOSTSTAKE_PSEUDO=1` swaps in the pseudo-locale (GHO-120), read per
  // request like `GHOSTSTAKE_E2E`, so one build can be checked both ways.
  if (process.env.GHOSTSTAKE_PSEUDO === "1") return { locale: defaultLocale, messages: (pseudo ??= pseudoCatalog(en)) };

  return { locale, messages: await catalogFor(locale) };
});

let pseudo: Catalog | undefined;
const merged = new Map<Locale, Catalog>();

async function catalogFor(locale: Locale): Promise<Catalog> {
  if (locale === "en") return en;
  const hit = merged.get(locale);
  if (hit) return hit;
  const own = (await import(`../../messages/${locale}.json`)).default as Partial<Catalog>;
  const catalog = overlay(en, own);
  merged.set(locale, catalog);
  return catalog;
}

/** `base` with every string `over` has replaced, recursively. */
export function overlay<T>(base: T, over: unknown): T {
  if (typeof base !== "object" || base === null) return (typeof over === typeof base ? over : base) as T;
  const out: Record<string, unknown> = {};
  const layer = (over ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(base as Record<string, unknown>)) {
    out[key] = overlay(value, layer[key]);
  }
  return out as T;
}
