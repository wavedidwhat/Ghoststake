"use client";

import { useConnection, useSwitchChain } from "wagmi";
import { activeChain } from "@/lib/wagmi";

/**
 * A banner rather than a blocking modal: on the wrong network the page behind
 * it is empty anyway, and covering it would hide the explanation for why.
 */
export function NetworkGuard() {
  const connection = useConnection();
  const { switchChain, isPending } = useSwitchChain();

  // The one surface that deliberately still wants `status`, not `useWallet`'s
  // address (GHO-77). Everything else treats a restored-but-unconfirmed address
  // as connected, because there is something true to render. Here the payload is
  // an accusation — "you are on the wrong network" — computed from a `chainId`
  // restored from storage that the wallet has not confirmed. A false alarm sends
  // someone to switch a network they were never on, so this one waits.
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
        className="rounded-sm bg-warning px-3.5 py-1.5 text-sm font-medium text-ground transition hover:opacity-90 disabled:opacity-60"
      >
        {isPending ? "Switching…" : `Switch to ${activeChain.name}`}
      </button>
    </div>
  );
}
