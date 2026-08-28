import type { Metadata } from "next";
import { isAddress } from "viem";
import { notFound } from "next/navigation";
import { feedLabel, pool, price, shortAddress } from "@/lib/marketMeta";
import { fetchRounds } from "@/lib/roundsApi";
import { RoundScreen } from "./RoundScreen";

/**
 * One round, at its own URL (GHO-41).
 *
 * This is the receipt, and the issue is explicit that it has to keep working
 * forever. That is what decides where it reads from: `/markets` and
 * `/markets/[market]` read the chain, because their numbers feed a transaction
 * somebody is about to sign — but the chain only holds the twelve most recent
 * rounds within reach, and a market the registry has delisted disappears from
 * it entirely. A link to round 7 shared in March has to still open in
 * September, so this page reads the indexer, which never forgets.
 */
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ market: string; id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { market, id } = await params;
  if (!isAddress(market)) return { title: "Round · GhostStake" };

  const [label, rounds] = await Promise.all([
    feedLabel(market),
    fetchRounds({ market, limit: 100 }).catch(() => null),
  ]);

  const name = label ?? shortAddress(market);
  const round = rounds?.rounds.find((r) => String(r.id) === id);
  if (!round) {
    return { title: `Round ${id} · ${name} · GhostStake` };
  }

  // The one line worth putting in front of somebody who has been sent a link.
  // A settled round's headline is its outcome; a live one's is what is at
  // stake and whether they can still join.
  const description =
    round.status === "resolved"
      ? `${round.winner === "up" ? "Up" : "Down"} won. Locked at ${price(round.lockPrice)}, closed at ${price(round.closePrice)}.`
      : round.status === "void"
        ? `Voided${round.voidReason ? ` — ${round.voidReason}` : ""}. Every stake was refunded.`
        : `${round.phase}. ${pool(round.upPool)} up against ${pool(round.downPool)} down.`;

  const title = `${name} · round ${round.id} · GhostStake`;
  return { title, description, openGraph: { title, description } };
}

export default async function RoundPage({ params }: Props) {
  const { market, id } = await params;
  if (!isAddress(market) || !/^\d+$/.test(id)) notFound();

  return <RoundScreen market={market} id={id} />;
}
