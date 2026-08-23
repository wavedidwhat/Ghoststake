"use client";

import { useConnection, useSwitchChain } from "wagmi";
import { activeChain } from "@/lib/wagmi";

/**
 * A banner, not a blocking modal.
 *
 * On the wrong network every contract read returns nothing, so the page
 * behind this is empty anyway — but blocking it outright would also hide the
 * one thing that explains why. The banner names the network the user is on,
 * the one they need, and switches for them.
 */
export function NetworkGuard() {
  const connection = useConnection();
  const { switchChain, isPending } = useSwitchChain();

  if (connection.status !== "connected") return null;
  if (connection.chainId === activeChain.id) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-warning/30 bg-warning-soft px-6 py-3">
      <p className="text-sm text-warning">
        <span className="font-medium">Wrong network.</span> GhostStake is deployed on{" "}
        {activeChain.name}
        {connection.chain ? ` — your wallet is on ${connection.chain.name}.` : "."}
      </p>
      <button
        onClick={() => switchChain({ chainId: activeChain.id })}
        disabled={isPending}
        className="rounded-full bg-warning px-3.5 py-1.5 text-sm font-medium text-ground transition hover:opacity-90 disabled:opacity-60"
      >
        {isPending ? "Switching…" : `Switch to ${activeChain.name}`}
      </button>
    </div>
  );
}
