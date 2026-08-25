import type { Address } from "viem";
import { env } from "./env";

/**
 * Where a market's settlement price comes from — which is the only thing that
 * differs between the markets this app shows, and the only thing a user has to
 * be told about them.
 *
 * `chainlink`: settlement is pinned to a Chainlink feed nobody here controls.
 * That is the claim the product makes and the one worth making.
 *
 * `demo`: the price is whatever the operator publishes. Real contracts, real
 * money, real settlement — and a number somebody typed. A round on a real feed
 * cannot resolve until the feed publishes after its close, and a real feed's
 * heartbeat runs to tens of minutes, so this exists to make a full lifecycle
 * watchable in the time someone will actually watch for.
 */
export type FeedKind = "chainlink" | "demo";

export type Market = {
  /** Stable key for React lists and round identity: round ids restart at 1 in
   *  every market, so `id` alone is not unique across them. */
  key: string;
  label: string;
  kind: FeedKind;
  address: Address;
  router: Address;
};

/**
 * Every market this deployment is configured for, in the order they should be
 * shown. The real-feed market leads: it is the headline, and the demo one is
 * the thing standing next to it.
 *
 * Read from env rather than from a registry contract for now. Turning this
 * into an on-chain `MarketRegistry` read is GHO-34 — this shape is what that
 * will return, so the surfaces above it will not have to change again.
 */
export const markets: Market[] = [
  ...(env.marketAddress && env.routerAddress
    ? [
        {
          key: "live",
          label: "ETH / USD",
          kind: "chainlink" as const,
          address: env.marketAddress,
          router: env.routerAddress,
        },
      ]
    : []),
  ...(env.demoMarketAddress && env.demoRouterAddress
    ? [
        {
          key: "demo",
          label: "ETH / USD",
          kind: "demo" as const,
          address: env.demoMarketAddress,
          router: env.demoRouterAddress,
        },
      ]
    : []),
];

export const marketsConfigured = markets.length > 0;

export function marketByKey(key: string): Market | undefined {
  return markets.find((m) => m.key === key);
}
