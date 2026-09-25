import type { ReactNode } from "react";
import { Eyebrow } from "./Eyebrow";

/**
 * The frame for a screen that stands in for the app: a crash, a 404, a
 * deployment that cannot run (GHO-85).
 *
 * Deliberately not the app frame (`app/(app)/layout.tsx`) or `Page`. Those
 * render the wallet button and the network guard, both of which read wagmi, and a fallback built from the
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
          <Eyebrow>{eyebrow}</Eyebrow>
          <h1 className="display mt-2 text-2xl">{title}</h1>
          <div className="mt-3 space-y-3 text-sm leading-relaxed text-ink-muted">{children}</div>
          {actions && <div className="mt-6 flex flex-wrap gap-3">{actions}</div>}
        </div>
      </div>
    </main>
  );
}

