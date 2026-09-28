/**
 * The app's one locale (GHO-115).
 *
 * Its own module, apart from `request.ts`, because formatting code runs in
 * the browser too and `request.ts` pulls in `next-intl/server`. Every number,
 * date and message is rendered in this locale rather than the browser's, so a
 * block number and an amount on the same screen can't disagree about what a
 * comma means.
 */
export const locale = "en";

export type Locale = typeof locale;
