"use client";

import { useConnection } from "wagmi";
import { useMarkets } from "@/hooks/useMarkets";
import { useMarketParams } from "@/hooks/useRounds";

/**
 * Whether the connected wallet owns any market on this deployment (GHO-62).
 *
 * Used only to decide whether the navigation lists the operator console. It
 * is not a permission check and must never be used as one: the contracts
 * decide who may open a round, and half of what the console does is
 * permissionless anyway (GHO-28). The page stays reachable by URL for
 * everybody — what this removes is an admin link from a bettor's nav.
 *
 * Owner is read from the markets themselves rather than from an env var,
 * because the env var would be a second source of truth for something the
 * chain already states, and the two would drift the first time ownership
 * moved.
 *
 * False while loading, deliberately. A link that appears a second after the
 * page settles is worse than one that appears on the next navigation — it
 * moves the thing under the finger that is already reaching for it.
 */
export function useIsOperator(): boolean {
  const connection = useConnection();
  const markets = useMarkets();
  const params = useMarketParams(markets.markets);

  const address = connection.address?.toLowerCase();
  if (!address) return false;

  for (const market of markets.markets) {
    const owner = params.byMarket.get(market.key)?.owner;
    if (owner && owner.toLowerCase() === address) return true;
  }
  return false;
}
