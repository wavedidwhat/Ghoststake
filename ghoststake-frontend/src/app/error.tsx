"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Button, buttonClass } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";

/**
 * Any render throw below the root layout (GHO-85). Before this there was no
 * boundary at all, and a throw anywhere was a blank page with no way back.
 *
 * States what happened in the app's voice and offers the two things someone
 * can actually do: try again, or leave. No stack trace — the message of a
 * server error is withheld in production anyway, and the digest is what
 * matches it to the server log, so that is what is shown.
 *
 * "Nothing about your positions has changed" is true by construction: a render
 * cannot send a transaction, and it is the first thing someone with money in
 * the app will want to know.
 */
export default function RouteError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = useTranslations("routeError");
  const actions = useTranslations("actions");
  const errors = useTranslations("errors");

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Notice
      eyebrow={t("eyebrow")}
      title={t("title")}
      actions={
        <>
          <Button size="lg" onClick={() => retry()}>
            {actions("tryAgain")}
          </Button>
          <Link href="/" className={buttonClass({ variant: "outline", size: "lg" })}>
            {actions("goToMarkets")}
          </Link>
        </>
      }
    >
      <p>{t("body")}</p>
      {error.digest && (
        <p className="text-xs text-ink-faint">
          {errors.rich("reference", {
            digest: error.digest,
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </p>
      )}
    </Notice>
  );
}
