"use client";

import "./globals.css";
import { useEffect } from "react";
import { Notice, noticePrimary } from "@/components/Notice";

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
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">
        <title>Something broke · GhostStake</title>
        <Notice
          eyebrow="Something broke"
          title="The app could not start"
          actions={
            <>
              <button type="button" onClick={() => retry()} className={noticePrimary}>
                Try again
              </button>
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full reload is the point */}
              <a href="/" className="inline-flex min-h-11 items-center rounded-control border border-border px-5 py-2.5 text-sm text-ink">
                Reload
              </a>
            </>
          }
        >
          <p>
            Nothing about your positions has changed — a page failing to render cannot move funds.
          </p>
          {error.digest && (
            <p className="text-xs text-ink-faint">
              Reference <code className="font-mono">{error.digest}</code>
            </p>
          )}
        </Notice>
      </body>
    </html>
  );
}
