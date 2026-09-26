import { Question } from "@phosphor-icons/react";

import { AssetLogo } from "@/components/ui/AssetLogo";
import { logoSymbolFor } from "@/lib/marketCategory";

/**
 * The picture that stands for a market: the coin or company behind its price
 * (GHO-102).
 *
 * A market list is scanned, not read. Polymarket, Kalshi, Limitless and
 * Myriad all lead each row with an image for that reason, and ours are the
 * real marks from `AssetLogo`: Tesla's T, not the word "RHTSLA".
 *
 * A question market has no asset behind it, so it gets one neutral glyph of
 * its own. Never a brand its words happen to mention: a question about
 * Tesla is not a Tesla price, and its mark must not say it is.
 *
 * While the feed is still being read, a plain circle the same size holds the
 * place, so the row does not shift when the logo arrives.
 */
export function MarketMark({
  feed,
  size = "md",
}: {
  feed: { description: string; isQuestion: boolean } | undefined;
  size?: "sm" | "md" | "lg";
}) {
  const box = { sm: "size-6", md: "size-8", lg: "size-10" }[size];

  if (!feed) {
    return <span aria-hidden="true" className={`${box} shrink-0 rounded-full bg-raised`} />;
  }

  const symbol = logoSymbolFor(feed);
  if (!symbol) {
    return (
      <span
        aria-hidden="true"
        className={`${box} inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-raised text-ink-muted`}
      >
        <Question weight="bold" className="size-1/2" />
      </span>
    );
  }

  return <AssetLogo symbol={symbol} size={size} />;
}
