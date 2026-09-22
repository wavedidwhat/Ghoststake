"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Notice, noticePrimary, noticeSecondary } from "@/components/Notice";

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
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Notice
      eyebrow="Something broke"
      title="This page could not be shown"
      actions={
        <>
          <button type="button" onClick={() => retry()} className={noticePrimary}>
            Try again
          </button>
          <Link href="/" className={noticeSecondary}>
            Go to markets
          </Link>
        </>
      }
    >
      <p>
        The app hit an error drawing this screen. Nothing about your positions has changed — a page
        failing to render cannot move funds.
      </p>
      {error.digest && (
        <p className="text-xs text-ink-faint">
          Reference <code className="font-mono">{error.digest}</code>
        </p>
      )}
    </Notice>
  );
}
