import { NextIntlClientProvider, createTranslator } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import messages from "../../messages/en.json";
import { defaultLocale as locale } from "@/i18n/locale";
import type { Message } from "@/i18n/message";

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

const t = createTranslator({ locale, messages });

/**
 * A `Message` from `lib/` as a user reads it (GHO-118). Tests of the helpers
 * that decide what to say assert on the sentence, not on the key, so a
 * wording change in the catalog shows up where the behaviour is tested.
 */
export function translate(message: Message): string {
  return t(message.key, message.values);
}
