"use client";

import { useCallback, useState } from "react";
import { useWriteContract } from "wagmi";
import { useConfig } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

export type TxState =
  | { status: "idle" }
  | { status: "signing" }
  | { status: "pending"; hash: `0x${string}` }
  | { status: "confirmed"; hash: `0x${string}` }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

/**
 * One write, tracked from the wallet prompt through to a mined receipt.
 *
 * The distinction that matters is between *sent* and *confirmed*. wagmi's
 * `writeContract` resolves as soon as the wallet returns a hash, which is
 * before anything has happened on chain — treating that as success is how a
 * UI ends up showing a position that does not exist yet. So this waits for
 * the receipt and only then reports `confirmed`.
 *
 * A user dismissing the wallet prompt is `cancelled`, not `failed`. It is a
 * normal thing to do and should not be dressed up as an error.
 */
export function useTransaction() {
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const [state, setState] = useState<TxState>({ status: "idle" });

  const reset = useCallback(() => setState({ status: "idle" }), []);

  const send = useCallback(
    async (
      request: Parameters<typeof writeContractAsync>[0],
      options?: { onConfirmed?: () => void },
    ): Promise<boolean> => {
      setState({ status: "signing" });
      try {
        const hash = await writeContractAsync(request);
        setState({ status: "pending", hash });

        const receipt = await waitForTransactionReceipt(config, { hash });
        if (receipt.status === "reverted") {
          // A mined revert is not the same as a failed send: the user paid
          // for it, so say so plainly rather than "something went wrong".
          setState({ status: "failed", message: "The transaction reverted on chain." });
          return false;
        }

        setState({ status: "confirmed", hash });
        options?.onConfirmed?.();
        return true;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (/user rejected|denied|rejected the request/i.test(message)) {
          setState({ status: "cancelled" });
          return false;
        }
        setState({ status: "failed", message: firstLine(message) });
        return false;
      }
    },
    [config, writeContractAsync],
  );

  return { state, send, reset };
}

/**
 * Wallet errors arrive as several paragraphs of RPC detail. The first line
 * carries the reason; the rest is noise in a form field.
 */
function firstLine(message: string): string {
  const line = message.split("\n")[0]?.trim();
  return line && line.length > 0 ? line : "The transaction could not be sent.";
}
