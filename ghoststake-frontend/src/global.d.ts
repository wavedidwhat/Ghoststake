import type messages from "../messages/en.json";

/**
 * Types every `t("…")` key against `messages/en.json` (GHO-116), so a typo or
 * a key removed from the catalog fails `tsc` instead of rendering the key
 * path ("notFound.title") to a user, which is what next-intl does at runtime
 * with a key it cannot find.
 */
declare module "next-intl" {
  interface AppConfig {
    Locale: "en";
    Messages: typeof messages;
  }
}
