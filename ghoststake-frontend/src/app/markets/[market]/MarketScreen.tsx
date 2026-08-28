"use client";

import Link from "next/link";
import { useState } from "react";
import { useConnection } from "wagmi";
import { AppShell, NotConfigured } from "@/components/AppShell";
import { Card } from "@/components/Card";
import { MarketBlock } from "@/components/MarketBlock";
import { useMarketFeeds } from "@/hooks/useMarketFeeds";
import { useMarkets } from "@/hooks/useMarkets";
import { useNow } from "@/hooks/useNow";
import { useMarketParams, useRounds } from "@/hooks/useRounds";
import { useVaultPosition } from "@/hooks/useVaultPosition";
import { anyMarketConfigured } from "@/lib/markets";
import type { SideValue } from "@/lib/rounds";

/**
 * The interactive half of `/markets/[market]`.
 *
 * Renders `MarketBlock`, which is the same view the list page used to show
 * inline — one component, so the two routes cannot drift into two different
 * ideas of what a market looks like.
 */
export function MarketScreen({ market }: { market: string }) {
  const connection = useConnection();

  return (
    <AppShell
      title="Market"
      subtitle="Take a view with borrowed capital — your stake keeps earning"
    >
      {!anyMarketConfigured() ? (
        <NotConfigured what="No market is configured for this network." />
      ) : (
        // No wallet gate. GHO-41 made a market's address its URL precisely so
        // it could be shared, and a shared link that answers with "connect a
        // wallet" defeats the point of having one — the recipient cannot see
        // the thing they were sent. Taking a position still needs a wallet;
        // reading one never did.
        <Body market={market} address={connection.address} />
      )}
    </AppShell>
  );
}

function Body({ market, address }: { market: string; address: `0x${string}` | undefined }) {
  const now = useNow();
  const { markets, isLoading: marketsLoading, isError: marketsError } = useMarkets();
  const params = useMarketParams(markets);
  const feeds = useMarketFeeds(markets);
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
        <p className="text-sm text-ink-muted">
          This market could not be read. The chain is unreachable right now — nothing about your
          positions has changed.
        </p>
      </Card>
    );
  }

  if (marketsLoading || isLoading || position.decimals === undefined) {
    return (
      <Card>
        <div className="h-24 animate-pulse rounded bg-raised" />
      </Card>
    );
  }

  if (!found) {
    return (
      <Card>
        <p className="text-sm text-ink">This address is not a market on this network.</p>
        <p className="mt-2 text-xs text-ink-faint">
          The registry does not list it and it is not configured here. A market delisted since the
          link was shared still appears for anyone holding a position in it — so an empty answer
          here means the address is wrong, not that it was hidden from you.
        </p>
        <Link
          href="/markets"
          className="mt-3 inline-block text-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Back to markets
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
        ← All markets
      </Link>

      <MarketBlock
        market={found}
        params={params.byMarket.get(found.key)}
        feed={feeds.byMarket.get(found.key)}
        rounds={rounds.filter((r) => r.market.key === found.key)}
        address={address}
        position={position}
        now={now}
        taking={taking}
        setTaking={setTaking}
        refetch={refetch}
      />
    </div>
  );
}
