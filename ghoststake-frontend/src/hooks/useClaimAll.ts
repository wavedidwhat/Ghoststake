"use client";

import { useCallback, useState } from "react";
import { useConfig, useWriteContract } from "wagmi";
import { simulateContract, waitForTransactionReceipt } from "wagmi/actions";
import {
  claimAbi,
  orderClaims,
  revertReason,
  type Claimable,
  type ClaimOutcome,
} from "@/lib/claims";
import { activeChain } from "@/lib/wagmi";

/**
 * Claim every winning round, one signature at a time (GHO-69).
 *
 * `ParimutuelRound` has no batch entry point — a payout is pull-based, per
 * round, per market — so this is a queue, not a multicall. That shapes three
 * decisions:
 *
 * 1. **Every claim is simulated first.** A claim that would revert is skipped
 *    rather than sent, so nobody pays gas to be told the money was already
 *    collected. The common causes are real: another tab claimed it, or the
 *    figure was read a block before someone else's transaction landed.
 * 2. **A dismissed wallet prompt stops the run**, and does not mark anything
 *    failed. Dismissing is a normal thing to do, and the rest of the queue is
 *    still there to resume.
 * 3. **Progress is reported per round**, because five signatures with one
 *    spinner is indistinguishable from one signature that hung.
 *
 * Deliberately sequential. Firing five wallet prompts at once produces a stack
 * of modals in some wallets and a silently dropped nonce in others.
 */
export function useClaimAll(address: `0x${string}` | undefined) {
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();

  const [outcomes, setOutcomes] = useState<ClaimOutcome[]>([]);
  const [running, setRunning] = useState(false);

  const reset = useCallback(() => setOutcomes([]), []);

  const run = useCallback(
    async (claims: Claimable[]) => {
      if (!address || claims.length === 0 || running) return;

      const queue = orderClaims(claims);
      setRunning(true);
      setOutcomes(queue.map((claim) => ({ state: "pending", claim })));

      const settle = (index: number, outcome: ClaimOutcome) =>
        setOutcomes((current) => current.map((old, i) => (i === index ? outcome : old)));

      for (const [index, claim] of queue.entries()) {
        // `claimAbi` rather than the generated `parimutuelRoundAbi`: the full
        // ABI overflows viem's overload resolution here (TS2590), and a test
        // pins the narrow one to the generated entry so it cannot drift.
        const claimArgs = [claim.roundId, address] as const;

        // Simulated against the current head rather than the block the
        // claimable figure came from: the point is to find out whether it
        // works *now*.
        //
        // Through `wagmi/actions` rather than a client from `usePublicClient`:
        // that hook's return type is a union across every configured chain and
        // transport, and calling `simulateContract` on it is the second half
        // of the TS2590 explosion (the first was the full ABI).
        try {
          await simulateContract(config, {
            address: claim.market,
            abi: claimAbi,
            functionName: "claim",
            args: claimArgs,
            account: address,
            chainId: activeChain.id,
          });
        } catch (cause) {
          settle(index, { state: "skipped", claim, reason: revertReason(cause) });
          continue;
        }

        try {
          const hash = await writeContractAsync({
            address: claim.market,
            abi: claimAbi,
            functionName: "claim",
            args: claimArgs,
            chainId: activeChain.id,
          });
          const receipt = await waitForTransactionReceipt(config, { hash });

          if (receipt.status === "reverted") {
            // Mined and reverted: the user paid for this one, so it is a
            // failure rather than a skip, and saying otherwise hides a cost.
            settle(index, { state: "failed", claim, reason: null, reverted: true });
            continue;
          }

          settle(index, { state: "claimed", claim, hash });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);

          if (/user rejected|denied|rejected the request/i.test(message)) {
            settle(index, { state: "cancelled", claim });
            // Everything after stays `pending`, which is the truth: it was
            // neither attempted nor refused by the chain.
            break;
          }

          settle(index, { state: "failed", claim, reason: revertReason(cause) });
        }
      }

      setRunning(false);
    },
    [address, config, running, writeContractAsync],
  );

  return { outcomes, running, run, reset };
}
