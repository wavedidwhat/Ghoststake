"use client";

import NetworkArbitrumOne from "@web3icons/react/icons/networks/NetworkArbitrumOne";
import NetworkArbitrumSepolia from "@web3icons/react/icons/networks/NetworkArbitrumSepolia";
import NetworkEthereum from "@web3icons/react/icons/networks/NetworkEthereum";
import NetworkRobinhood from "@web3icons/react/icons/networks/NetworkRobinhood";
import NetworkSepolia from "@web3icons/react/icons/networks/NetworkSepolia";
import { useTranslations } from "next-intl";

import { activeChain, chainShortName } from "@/lib/chains";
import { Badge } from "./ui/Badge";
import { ExplorerLink } from "./ui/ExplorerLink";

/**
 * The chain this app runs on, with its mark, beside the wallet (GHO-127).
 *
 * Before this the only sign of Robinhood Chain was a "Testnet" chip in a
 * sidebar that phones never see, and the chain name in faint type under the
 * title on the pages that had no subtitle of their own. Where a protocol
 * lives is part of what it is: the stock prices are Robinhood Chain's, and
 * the pitch only makes sense there.
 *
 * It names the app's chain, never the wallet's. A wallet on another network
 * is the wrong-network banner's job (`NetworkGuard`), and a badge that
 * followed the wallet would name a chain the app has no contracts on.
 *
 * Marks come from `@web3icons/react`, already in the bundle for token logos
 * (GHO-97). A chain with no mark (anvil) gets a plain dot, never a guess:
 * another chain's logo there would be a false claim about where money is.
 * The mark is the branded one, since the app has a single dark ground and
 * Robinhood's neon reads on it.
 *
 * On a phone the name drops to screen readers only, because the header row
 * already carries the wordmark, the bell and the wallet. The mark and the
 * Testnet chip stay at every size: whether this is real money is the one
 * thing a phone user must not have to hunt for.
 *
 * Also at the foot of the sidebar, where the bare "Testnet" chip used to be,
 * `compact` there: "Robinhood Chain", the chip and the arrow come to about
 * 240px and the sidebar is 224, and the header beside it already has the name.
 */
const MARKS: Record<number, typeof NetworkRobinhood> = {
  4663: NetworkRobinhood,
  46630: NetworkRobinhood,
  42161: NetworkArbitrumOne,
  421614: NetworkArbitrumSepolia,
  1: NetworkEthereum,
  11155111: NetworkSepolia,
};

/** Whether a chain has a real mark. Exported for tests. */
export function hasChainMark(chainId: number): boolean {
  return chainId in MARKS;
}

export function ChainBadge({ compact = false }: { compact?: boolean }) {
  const t = useTranslations("chain");
  const Mark = MARKS[activeChain.id];
  const name = chainShortName(activeChain);

  return (
    <ExplorerLink
      home
      className="shrink-0 whitespace-nowrap rounded-full border border-border bg-surface px-2 py-1 text-xs font-medium text-ink-muted"
    >
      <span className="inline-flex items-center gap-1.5" title={t("runsOn", { chain: activeChain.name })}>
        {Mark ? (
          <Mark variant="branded" className="size-4 shrink-0" aria-hidden="true" />
        ) : (
          <span className="size-2 shrink-0 rounded-full bg-ink-faint" aria-hidden="true" />
        )}
        {/*
         * Two spans rather than `sr-only sm:not-sr-only`: that utility resets
         * white-space, so the name wrapped in the sidebar, and a nowrap child
         * inside a 1px `sr-only` box still measures its full width and pokes
         * past a phone's edge (the layout test's overflow guard caught it).
         */}
        {compact ? (
          <span className="sr-only">{name}</span>
        ) : (
          <>
            <span className="sr-only sm:hidden">{name}</span>
            <span className="hidden whitespace-nowrap sm:inline">{name}</span>
          </>
        )}
        {activeChain.testnet && <Badge size="sm">{t("testnet")}</Badge>}
      </span>
    </ExplorerLink>
  );
}
