import type { Address } from "viem";
import { env } from "./env";

/**
 * Where a market's settlement price comes from — the only thing that differs
 * between the markets this app shows, and the only thing a user has to be
 * told about them.
 *
 * `chainlink`: settlement is pinned to a feed nobody here controls. That is
 * the claim the product makes.
 *
 * `demo`: the price is whatever the operator publishes. Real contracts, real
 * money, real settlement — and a number somebody typed.
 *
 * `unknown`: not yet read from the chain. Rendered as its own state rather
 * than defaulting to either, because guessing wrong in the `chainlink`
 * direction tells someone a hand-set price is a Chainlink one.
 */
export type FeedKind = "chainlink" | "demo" | "unknown";

export type Market = {
  /** Stable identity across renders and reads: the market's own address,
   *  lowercased. Round ids restart at 1 in every market, so nothing keys on
   *  an id alone. */
  key: string;
  address: Address;
  router: Address;
  /** The round length this market is meant to be run at. Advisory — the
   *  registry stores it, nothing enforces it, and a market listed from the
   *  environment has none. */
  horizon?: bigint;
  /** False for a market the registry has delisted. Still shown to anyone
   *  holding a position in it; hidden from the browsing list. */
  enabled: boolean;
  /**
   * What the market's feed is expected to be, before the chain has answered.
   * Only a hint: `useMarketFeeds` reads `feed.description()` and that is the
   * authority. Registry-listed markets have no hint at all, because the
   * registry deliberately stores no label — see `MarketRegistry`.
   */
  kindHint: FeedKind;
};

/**
 * The markets named by environment variables.
 *
 * The whole list before GHO-34, and still the list wherever no registry is
 * configured. Kept rather than deleted because the Sepolia deployment
 * predates the registry, and an app that showed that deployment nothing would
 * be a regression dressed as a feature.
 */
export function envMarkets(): Market[] {
  const out: Market[] = [];

  if (env.marketAddress && env.routerAddress) {
    out.push({
      key: env.marketAddress.toLowerCase(),
      address: env.marketAddress,
      router: env.routerAddress,
      enabled: true,
      kindHint: "chainlink",
    });
  }

  if (env.demoMarketAddress && env.demoRouterAddress) {
    out.push({
      key: env.demoMarketAddress.toLowerCase(),
      address: env.demoMarketAddress,
      router: env.demoRouterAddress,
      enabled: true,
      kindHint: "demo",
    });
  }

  return out;
}

/** Whether this deployment can show any market at all. */
export function anyMarketConfigured(): boolean {
  return Boolean(env.registryAddress) || envMarkets().length > 0;
}
