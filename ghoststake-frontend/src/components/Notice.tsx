import type { ReactNode } from "react";

/**
 * The frame for a screen that stands in for the app: a crash, a 404, a
 * deployment that cannot run (GHO-85).
 *
 * Deliberately not `AppShell`. The shell renders the wallet button and the
 * network guard, both of which read wagmi, and a fallback built from the
 * thing that may have thrown is a fallback that throws. No hooks here either,
 * so the server-rendered screens and the client error boundaries share it.
 */
export function Notice({
  eyebrow,
  title,
  children,
  actions,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">
        <p className="display text-base tracking-wide text-brand uppercase">GhostStake</p>
        <div className="mt-4 rounded-card border border-border bg-surface p-6 sm:p-8">
          <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">{eyebrow}</p>
          <h1 className="display mt-2 text-2xl">{title}</h1>
          <div className="mt-3 space-y-3 text-sm leading-relaxed text-ink-muted">{children}</div>
          {actions && <div className="mt-6 flex flex-wrap gap-3">{actions}</div>}
        </div>
      </div>
    </main>
  );
}

/** The primary action on a notice. */
export const noticePrimary =
  "min-h-11 cursor-pointer rounded-control bg-action px-5 py-2.5 text-sm font-medium text-ground transition-colors hover:bg-action-strong focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none";

/** The secondary action: a way home. */
export const noticeSecondary =
  "inline-flex min-h-11 items-center rounded-control border border-border px-5 py-2.5 text-sm text-ink hover:border-border-strong focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none";
