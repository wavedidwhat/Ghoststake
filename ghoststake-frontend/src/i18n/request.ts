import { getRequestConfig } from "next-intl/server";
import messages from "../../messages/en.json";
import { locale } from "./locale";
import { pseudoCatalog } from "./pseudo";

/**
 * Where UI copy comes from (GHO-116).
 *
 * One locale, and no locale in the URL. The catalog exists so copy has one
 * place to live and be reviewed against `messages/GLOSSARY.md`, not because a
 * second language is planned. Adding one later means a second messages file
 * and choosing how the locale is picked (a cookie, or `[locale]` routing) —
 * nothing that calls `t()` changes.
 *
 * Imported statically rather than by `import(\`…/${locale}.json\`)`: with one
 * file there is nothing to choose between, and a static import is what lets
 * `global.d.ts` type every key against it.
 */
export default getRequestConfig(async () => ({
  locale,
  // `GHOSTSTAKE_PSEUDO=1` swaps in the pseudo-locale (GHO-120), read per
  // request like `GHOSTSTAKE_E2E`, so one build can be checked both ways.
  // Built once and kept: the catalog is static, so the transform is too.
  messages: process.env.GHOSTSTAKE_PSEUDO === "1" ? (pseudo ??= pseudoCatalog(messages)) : messages,
}));

let pseudo: typeof messages | undefined;
