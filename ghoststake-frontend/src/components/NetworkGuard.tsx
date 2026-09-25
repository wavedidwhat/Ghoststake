"use client";

import { useConnection, useSwitchChain } from "wagmi";
import { useStalled } from "@/hooks/useStalled";
import { useState } from "react";
import { activeChain } from "@/lib/wagmi";
import { Button } from "@/components/ui/Button";

/**
 * A banner rather than a blocking modal: on the wrong network the page behind
 * it is empty anyway, and covering it would hide the explanation for why.
 */
export function NetworkGuard() {
  const connection = useConnection();
  const { switchChain, isPending, error, reset } = useSwitchChain();
  const [attempt, setAttempt] = useState(0);
  const stalled = useStalled(isPending, attempt);

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
      <div className="flex flex-col items-end gap-1">
        <Button
          variant="warning"
          size="sm"
          onClick={() => {
            reset();
            setAttempt((n) => n + 1);
            switchChain({ chainId: activeChain.id });
          }}
          disabled={isPending}
        >
          {isPending ? "Switching…" : `Switch to ${activeChain.name}`}
        </Button>

        {/* This had no error path at all (GHO-83): a rejected switch, or a
            wallet that cannot add the chain, left `isPending` false and showed
            nothing. The button looked broken, which is the single most
            reported symptom of this whole class of bug. */}
        {switchHint(error, stalled) && (
          <span className="text-xs text-warning/80">{switchHint(error, stalled)}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Why the switch did not happen, in the banner's own voice.
 *
 * A dismissed prompt is a normal choice and says so quietly. Anything else is
 * worth naming, because the two common causes need different things from the
 * user: a wallet that has never seen this chain needs it added by hand, and a
 * wallet that is busy needs another moment.
 */
function switchHint(error: Error | null, stalled: boolean): string | undefined {
  if (error) {
    const message = error.message;
    if (/rejected|denied/i.test(message)) return "You declined the switch.";
    if (/unrecognized|not added|4902/i.test(message)) {
      return `Add ${activeChain.name} to your wallet first.`;
    }
    return "Your wallet could not switch networks.";
  }
  if (stalled) return "Your wallet hasn\u2019t answered.";
  return undefined;
}
