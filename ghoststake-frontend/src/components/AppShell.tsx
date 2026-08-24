"use client";

import type { ReactNode } from "react";
import { ConnectButton } from "./ConnectButton";
import { NetworkGuard } from "./NetworkGuard";
import { Sidebar } from "./Sidebar";
import { activeChain } from "@/lib/wagmi";

/**
 * The frame every screen sits in.
 *
 * Extracted once there was more than one page: the shell was duplicated in
 * the dashboard, and a second copy is how the nav and the network banner
 * start disagreeing between routes.
 */
export function AppShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <NetworkGuard />

        <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold">{title}</h1>
            <p className="text-xs text-ink-faint">{subtitle ?? activeChain.name}</p>
          </div>
          <ConnectButton />
        </header>

        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}

/** Shown wherever a screen needs a wallet before it can say anything. */
export function NeedsWallet({ what }: { what: string }) {
  return (
    <div className="rounded-card border border-border bg-surface p-8 text-center">
      <h2 className="text-base font-medium text-ink">Connect a wallet</h2>
      <p className="mt-2 text-sm text-ink-muted">{what}</p>
    </div>
  );
}

/** Shown when the addresses for a screen's contracts are not configured. */
export function NotConfigured({ what }: { what: string }) {
  return (
    <div className="rounded-card border border-border bg-surface p-8 text-center">
      <h2 className="text-base font-medium text-ink">Not deployed here</h2>
      <p className="mt-2 text-sm text-ink-muted">{what}</p>
    </div>
  );
}
