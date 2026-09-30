"use client";

import "./globals.css";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import messages from "../../messages/en.json";
import { defaultLocale as locale } from "@/i18n/locale";

/**
 * A throw in the root layout itself, which `error.tsx` cannot catch because
 * it renders inside that layout (GHO-85).
 *
 * Replaces the whole document, so it brings its own `<html>` and stylesheet.
 * Not the fonts: those are `next/font` variables set by the layout that just
 * failed, and the faces fall back to system ones, which is fine for a page
 * whose only job is to say what happened. A plain `<a>` rather than `Link`,
 * because a full reload is the more likely thing to recover from a broken
 * root.
 *
 * Brings its own messages for the same reason (GHO-116): the provider in the
 * root layout is gone with the layout. The catalog is a static import, so
 * nothing that can fail at runtime stands between this page and its copy.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang={locale} className="h-full antialiased">
      <body className="min-h-full">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Crashed digest={error.digest} retry={retry} />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

/** Split out because `useTranslations` needs the provider above it. */
function Crashed({ digest, retry }: { digest?: string; retry: () => void }) {
  const t = useTranslations("globalError");
  const actions = useTranslations("actions");
  const errors = useTranslations("errors");

  return (
    <>
    <title>{t("metaTitle")}</title>
    <Notice
      eyebrow={t("eyebrow")}
      title={t("title")}
      actions={
        <>
          <Button size="lg" onClick={() => retry()}>
            {actions("tryAgain")}
          </Button>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full reload is the point */}
          <a href="/" className="inline-flex min-h-11 items-center rounded-control border border-border px-5 py-2.5 text-sm text-ink">
            {actions("reload")}
          </a>
        </>
      }
    >
      <p>{t("body")}</p>
      {digest && (
        <p className="text-xs text-ink-faint">
          {errors.rich("reference", {
            digest,
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </p>
      )}
    </Notice>
    </>
  );
}
