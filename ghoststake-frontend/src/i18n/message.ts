import type { MessageKeys, Messages, NestedKeyOf, TranslationValues } from "next-intl";

/**
 * Any full key in `messages/en.json`, e.g. `"question.aboveAt"` (GHO-118).
 * Checked by `tsc` against the catalog, the same as a key passed to `t()`.
 */
export type MessageKey = MessageKeys<Messages, NestedKeyOf<Messages>>;

/**
 * A sentence decided outside React: which message, and what goes in it.
 *
 * `lib/` works out *what* to say — which question a round is asking, where a
 * claim stands — and is tested for that without a DOM. It can't call
 * `useTranslations`, and it shouldn't hold English either, so it returns
 * this and the component that renders it translates with a root translator:
 * `t(message.key, message.values)`.
 */
export type Message = { key: MessageKey; values?: TranslationValues };

export function message(key: MessageKey, values?: TranslationValues): Message {
  return values ? { key, values } : { key };
}
