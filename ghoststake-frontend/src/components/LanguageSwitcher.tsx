"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { LOCALE_COOKIE, isLocale, localeNames, locales } from "@/i18n/locale";

/**
 * The language the app is shown in (GHO-128).
 *
 * A cookie, not a URL, so a link someone shares opens in the reader's own
 * language. `router.refresh()` re-renders the server side with the new
 * cookie, which swaps the catalog and the number format together; a figure
 * and the sentence around it can't end up in different languages.
 *
 * Each option is the language's own name ("Español"), not a translation: a
 * Spanish speaker stuck on a Chinese page is looking for "Español".
 */
export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const t = useTranslations("nav");
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <label className={`flex items-center gap-2 text-xs text-ink-faint ${className}`}>
      <span className="sr-only">{t("language")}</span>
      <svg aria-hidden viewBox="0 0 16 16" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.2">
        <circle cx="8" cy="8" r="6.5" />
        <path d="M1.5 8h13M8 1.5c1.8 1.8 2.7 4 2.7 6.5S9.8 12.7 8 14.5M8 1.5C6.2 3.3 5.3 5.5 5.3 8s.9 4.7 2.7 6.5" />
      </svg>
      <select
        value={locale}
        disabled={pending}
        onChange={(event) => {
          const next = event.target.value;
          if (!isLocale(next)) return;
          document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
          startTransition(() => router.refresh());
        }}
        className="min-h-9 min-w-0 flex-1 cursor-pointer rounded-sm border border-border bg-surface px-2 text-xs text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:opacity-50"
      >
        {locales.map((l) => (
          <option key={l} value={l} lang={l}>
            {localeNames[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
