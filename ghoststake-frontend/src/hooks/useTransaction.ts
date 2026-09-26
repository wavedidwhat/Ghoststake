"use client";

import { useCallback, useRef, useState } from "react";
import { useWriteContract } from "wagmi";
import { useConfig } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

export type TxState =
  | { status: "idle" }
  | { status: "signing" }
  | { status: "pending"; hash: `0x${string}` }
  | { status: "confirmed"; hash: `0x${string}` }
  | { status: "cancelled" }
  // `hash` when it was sent before it failed (GHO-103): a mined revert, or a
  // receipt that could not be read. That is when someone most wants to look
  // it up, and the explorer is where the reason is.
  | { status: "failed"; message: string; hash?: `0x${string}` };

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
  // Bumped per send, so a retry gets its own stall window. See useStalled.
  const [attempt, setAttempt] = useState(0);
  // Which send is live. An abandoned one is still running — a wallet that has
  // the request cannot be made to give it back, and neither writeContractAsync
  // nor waitForTransactionReceipt takes an AbortSignal — so when it settles it
  // must not write over a newer send or over a user who stopped waiting.
  const live = useRef(0);

  const reset = useCallback(() => {
    live.current += 1;
    setState({ status: "idle" });
  }, []);

  /**
   * Stop waiting on a wallet that is not going to answer.
   *
   * It cannot cancel anything: the request is with the wallet, and a sent
   * transaction is on the chain whatever this app does. What it does is give
   * the state a door, which is what "signing" and "pending" did not have
   * (GHO-83). A send abandoned at the prompt may still arrive; a send
   * abandoned while pending certainly will, and the hash stays on screen for
   * exactly that reason.
   */
  const stopWaiting = useCallback(() => {
    live.current += 1;
    setState({ status: "idle" });
  }, []);

  const send = useCallback(
    async (
      request: Parameters<typeof writeContractAsync>[0],
      options?: { onConfirmed?: () => void },
    ): Promise<boolean> => {
      const mine = live.current + 1;
      live.current = mine;
      setAttempt((n) => n + 1);
      setState({ status: "signing" });
      let sent: `0x${string}` | undefined;
      try {
        const hash = await writeContractAsync(request);
        sent = hash;
        if (live.current !== mine) return false;
        setState({ status: "pending", hash });

        const receipt = await waitForTransactionReceipt(config, { hash });
        if (live.current !== mine) return false;
        if (receipt.status === "reverted") {
          // A mined revert is not the same as a failed send: the user paid
          // for it, so say so plainly rather than "something went wrong".
          setState({ status: "failed", message: "The transaction reverted on chain.", hash });
          return false;
        }

        setState({ status: "confirmed", hash });
        options?.onConfirmed?.();
        return true;
      } catch (cause) {
        if (live.current !== mine) return false;
        const message = cause instanceof Error ? cause.message : String(cause);
        if (/user rejected|denied|rejected the request/i.test(message)) {
          setState({ status: "cancelled" });
          return false;
        }
        setState({ status: "failed", message: firstLine(message), hash: sent });
        return false;
      }
    },
    [config, writeContractAsync],
  );

  return { state, attempt, send, reset, stopWaiting };
}

/**
 * Wallet errors arrive as several paragraphs of RPC detail. The first line
 * carries the reason; the rest is noise in a form field.
 */
function firstLine(message: string): string {
  const line = message.split("\n")[0]?.trim();
  return line && line.length > 0 ? line : "The transaction could not be sent.";
}
