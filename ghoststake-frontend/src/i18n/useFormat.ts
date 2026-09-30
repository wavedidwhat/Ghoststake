import { useLocale } from "next-intl";
import { formatFor, type Format } from "@/lib/format";

/**
 * Number and date formatters in the language this page is rendered in
 * (GHO-128). The only way a component should format a figure: importing the
 * formatters directly would need a locale, and a hard-coded one is how a
 * Spanish page ends up printing 1,500 for one and a half thousand.
 */
export function useFormat(): Format {
  return formatFor(useLocale());
}
