import type { Metadata } from "next";
import { isAddress } from "viem";
import { notFound } from "next/navigation";
import { fetchRounds } from "@/lib/roundsApi";
import { feedLabel, pool, shortAddress } from "@/lib/marketMeta";
import { MarketScreen } from "./MarketScreen";

/**
 * One market, at its own URL (GHO-41).
 *
 * A server component wrapping a client one, and the split is the whole point.
 * Everything interactive here needs a wallet and lives in `MarketScreen`; the
 * only thing this outer file does is produce the metadata a pasted link
 * unfurls with — which cannot be done from a client component, because the
 * crawler reading it never runs any JavaScript.
 *
 * Dynamic rather than prerendered: the set of markets is a registry the owner
 * writes to, so it is not knowable at build time, and the figures in the title
 * move every round.
 */
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ market: string }> };

/**
 * The unfurl.
 *
 * "GhostStake" on every link is the state GHO-41 is fixing: the unit people
 * share is a market, and a link that does not say which one is a link nobody
 * clicks. The label comes from the feed on chain rather than from a stored
 * name — the registry deliberately keeps none — and falls back to the address,
 * which cannot go stale.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { market } = await params;
  if (!isAddress(market)) return { title: "Market · GhostStake" };

  const [label, rounds] = await Promise.all([
    feedLabel(market),
    // Best effort: an indexer that is down should cost the title its detail,
    // not the page its existence.
    fetchRounds({ market, limit: 1 }).catch(() => null),
  ]);

  const name = label ?? shortAddress(market);
  const latest = rounds?.rounds[0];
  const description = latest
    ? `Round ${latest.id} is ${latest.phase}. ${pool(latest.upPool)} up against ${pool(latest.downPool)} down.`
    : `A parimutuel market on ${name}. Stake a side with borrowed capital while your collateral keeps earning.`;

  return {
    title: `${name} · GhostStake`,
    description,
    openGraph: { title: `${name} · GhostStake`, description },
  };
}

export default async function MarketPage({ params }: Props) {
  const { market } = await params;
  // A malformed address is a 404 rather than a page that renders empty and
  // looks like a market with no rounds.
  if (!isAddress(market)) notFound();

  return <MarketScreen market={market} />;
}
