import { getRequestConfig } from "next-intl/server";
import messages from "../../messages/en.json";

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
export const locale = "en";

export default getRequestConfig(async () => ({ locale, messages }));
