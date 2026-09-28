"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useConnection } from "wagmi";
import { Page, NotConfigured } from "@/components/Page";
import { Card } from "@/components/ui/Card";
import { MarketBlock } from "@/components/MarketBlock";
import { useMarketFeeds } from "@/hooks/useMarketFeeds";
import { useSpot } from "@/hooks/useSpot";
import { useMarkets } from "@/hooks/useMarkets";
import { useNow } from "@/hooks/useNow";
import { useMarketParams, useRounds } from "@/hooks/useRounds";
import { useVaultPosition } from "@/hooks/useVaultPosition";
import { anyMarketConfigured } from "@/lib/markets";
import type { SideValue } from "@/lib/rounds";
import { Skeleton } from "@/components/ui/Skeleton";

/**
 * The interactive half of `/markets/[market]`.
 *
 * Renders `MarketBlock`, which is the same view the list page used to show
 * inline — one component, so the two routes cannot drift into two different
 * ideas of what a market looks like.
 */
export function MarketScreen({ market }: { market: string }) {
  const t = useTranslations("market");
  const markets = useTranslations("markets");
  const connection = useConnection();

  return (
    <Page title={t("title")} subtitle={markets("subtitle")}>
      {!anyMarketConfigured() ? (
        <NotConfigured what={markets("notConfigured")} />
      ) : (
        // No wallet gate. GHO-41 made a market's address its URL precisely so
        // it could be shared, and a shared link that answers with "connect a
        // wallet" defeats the point of having one — the recipient cannot see
        // the thing they were sent. Taking a position still needs a wallet;
        // reading one never did.
        <Body market={market} address={connection.address} />
      )}
    </Page>
  );
}

function Body({ market, address }: { market: string; address: `0x${string}` | undefined }) {
  const t = useTranslations("market");
  const now = useNow();
  const { markets, isLoading: marketsLoading, isError: marketsError } = useMarkets();
  const params = useMarketParams(markets);
  const feeds = useMarketFeeds(markets);
  const spot = useSpot(markets, feeds.byMarket);
  const { rounds, isLoading, isError, refetch } = useRounds(markets);
  const position = useVaultPosition();

  const [taking, setTaking] = useState<{ key: string; id: bigint; side: SideValue } | null>(null);

  // The address from the URL, matched against the registry the same way
  // everything else keys a market: lowercased. A checksummed link and a
  // lowercased one are the same market, and a visitor pasting either should
  // land on it.
  const key = market.toLowerCase();
  const found = markets.find((m) => m.key === key);

  if (isError || marketsError) {
    return (
      <Card>
        <p className="text-sm text-ink-muted">{t("unreadable")}</p>
      </Card>
    );
  }

  if (marketsLoading || isLoading || position.decimals === undefined) {
    return (
      <Card>
        <Skeleton className="h-24" />
      </Card>
    );
  }

  if (!found) {
    return (
      <Card>
        <p className="text-sm text-ink">{t("notAMarket")}</p>
        <p className="mt-2 text-xs text-ink-faint">{t("notAMarketDetail")}</p>
        <Link
          href="/markets"
          className="mt-3 inline-block text-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline"
        >
          {t("back")}
        </Link>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/markets"
        className="text-xs text-ink-faint underline-offset-2 hover:text-ink-muted hover:underline"
      >
        {t("allMarkets")}
      </Link>

      <MarketBlock
        market={found}
        params={params.byMarket.get(found.key)}
        feed={feeds.byMarket.get(found.key)}
        spot={spot.byMarket.get(found.key)}
        rounds={rounds.filter((r) => r.market.key === found.key)}
        address={address}
        position={position}
        decimals={position.decimals}
        now={now}
        taking={taking}
        setTaking={setTaking}
        refetch={refetch}
      />
    </div>
  );
}
