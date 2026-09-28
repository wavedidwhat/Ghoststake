import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import messages from "../../messages/en.json";
import { locale } from "@/i18n/locale";

/**
 * Renders to markup with the real catalog, the way the root layout provides
 * it (GHO-117). Unit tests that render a component reading copy go through
 * this, so they assert on the words a user sees rather than on keys.
 */
export function renderWithMessages(ui: ReactNode): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}
