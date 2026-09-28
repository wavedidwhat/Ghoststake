"use client";

import type { ReactNode } from "react";
import { ConnectButton } from "./ConnectButton";
import { AlertBell } from "./AlertBell";
import { activeChain } from "@/lib/wagmi";

/**
 * A screen's header and body. The frame around it — sidebar, tab bar,
 * network banner — is `app/(app)/layout.tsx`, which stays mounted across
 * navigations (GHO-96). This was `AppShell` and rendered the frame too, so
 * every page rebuilt the sidebar.
 *
 * Two layouts (GHO-59). Under `md` it is a single column with the wordmark
 * and the wallet at the top and a tab bar at the bottom; from `md` up the
 * sidebar returns and the header carries the page title. The phone layout is
 * the default and the desktop one is the `md:` variant, so a new screen is
 * mobile-first by omission rather than by discipline.
 */
export function Page({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <>
    {/*
     * One header, reflowed rather than duplicated.
     *
     * On a phone: the wordmark and the wallet on the first line, the page
     * title on the second. The wordmark has to live here because the
     * sidebar that used to carry it is gone. From `md` up the wordmark
     * drops away (the sidebar has it again) and `order` puts the title
     * left with the wallet on the right, on one line.
     *
     * The first version of this rendered the title twice — once per
     * layout, with CSS hiding one. Two `<h1>`s on a page is wrong for a
     * screen reader whichever one is visible, and the layout test caught
     * it immediately by matching both.
     */}
    <header className="sticky top-0 z-30 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-ground px-4 py-3 md:px-6 md:py-4">
      <span className="display text-base tracking-wide text-brand uppercase md:hidden">
        GhostStake
      </span>

      <div className="ml-auto flex items-center gap-1 md:order-3">
        <AlertBell />
        <ConnectButton />
      </div>

      <div className="w-full md:order-2 md:mr-auto md:w-auto">
        <h1 className="display text-2xl md:text-xl">{title}</h1>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-faint">
          {subtitle ?? activeChain.name}
        </p>
      </div>
    </header>

    {/*
     * Clears the floating tab bar, including the gap it leaves for the
     * home bar. Without it the last control on every page sits under the
     * nav, which is the single most common way a retrofitted bottom bar
     * breaks a form.
     */}
    <main className="flex-1 px-4 py-4 pb-[calc(6rem+env(safe-area-inset-bottom,0px))] md:p-6 md:pb-6">{children}</main>
    </>
  );
}

/** Shown wherever a screen needs a wallet before it can say anything. */
export function NeedsWallet({ what }: { what: string }) {
  return (
    <div className="rounded-card border border-border bg-surface p-6 text-center sm:p-8">
      <h2 className="text-base font-medium text-ink">Connect a wallet</h2>
      <p className="mt-2 text-sm text-ink-muted">{what}</p>
    </div>
  );
}

/** Shown when the addresses for a screen's contracts are not configured. */
export function NotConfigured({ what }: { what: string }) {
  return (
    <div className="rounded-card border border-border bg-surface p-6 text-center sm:p-8">
      <h2 className="text-base font-medium text-ink">Not deployed here</h2>
      <p className="mt-2 text-sm text-ink-muted">{what}</p>
    </div>
  );
}
