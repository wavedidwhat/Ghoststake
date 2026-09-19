"use client";

import { useConnection } from "wagmi";

/**
 * The one answer to "is there a wallet, and whose?".
 *
 * This exists because the app used to answer that question three different
 * ways, and they disagreed in exactly one state (GHO-77):
 *
 * - the overview asked `status === "disconnected"`,
 * - every other page asked `status !== "connected"`,
 * - and the data hooks asked `Boolean(address)`.
 *
 * On a reload, wagmi restores the previous connection from storage and sets
 * `status` to `reconnecting` while it re-checks it with the wallet — but it
 * populates `address` from the persisted connection straight away, and reports
 * `isConnected: !!address` for the same reason. So during that window the data
 * hooks fetched and rendered a real position, the overview rendered it too, and
 * the stake page rendered "Connect a wallet" over the top of it. A returning
 * user saw their own balances and an invitation to connect, at once, under a
 * header that said "Connecting…". If the wallet was slow it was a flash; if the
 * wallet never answered it was permanent.
 *
 * The honest predicate is the one the data already follows: if we have an
 * address, we have a wallet. `status` describes how confident wagmi is about
 * it, which is a different question and is kept separate as `isSettling`.
 */
export function useWallet() {
  const connection = useConnection();

  const common = {
    /**
     * wagmi is still resolving the connection. Only interesting when there is
     * no address yet: with one, there is something true to show instead.
     */
    isSettling: connection.status === "reconnecting" || connection.status === "connecting",
    /**
     * The raw status, for the one caller that genuinely needs certainty rather
     * than an address — see `NetworkGuard`.
     */
    status: connection.status,
    chainId: connection.chainId,
    chain: connection.chain,
  };

  // A discriminated union rather than a loose boolean beside an optional
  // address: `isConnected` is the predicate every surface branches on, and it
  // should narrow `address` for the branch that then renders it. Otherwise each
  // caller re-tests `address` to satisfy the compiler and we are back to two
  // predicates for one question, which is the bug this hook exists to end.
  return connection.address
    ? { ...common, isConnected: true as const, address: connection.address }
    : { ...common, isConnected: false as const, address: undefined };
}
