"use client";

import Link from "next/link";
import { AppShell, NotConfigured } from "@/components/AppShell";
import { Card } from "@/components/Card";
import { useNow } from "@/hooks/useNow";
import { useMarketFeeds, type MarketFeed } from "@/hooks/useMarketFeeds";
import { useMarkets } from "@/hooks/useMarkets";
import { useMarketParams, useRounds } from "@/hooks/useRounds";
import { useVaultAsset } from "@/hooks/useVaultPosition";
import { anyMarketConfigured } from "@/lib/markets";
import { byActivity, formatHorizon, summarise, type Summary } from "@/lib/marketList";
import { formatAmount } from "@/lib/format";
import { Phase, Side, entryClosesAt, formatCountdown, multipleFor } from "@/lib/rounds";

/**
 * Readable without a wallet, deliberately.
 *
 * This page used to render "Connect a wallet" to anyone who had not, which
 * made the app's entire public surface a button. Everything on it — pools,
 * multiples, phase, countdown — is public chain state that reads perfectly
 * well without knowing who is looking, and every comparable platform lets you
 * read a market before you have an account, because the market *is* the pitch.
 *
 * `useRounds` was already built for this: the per-address batch is separately
 * gated and simply yields undefined stakes, so a disconnected visitor gets the
 * pools and no "your position" line. The only thing that needed a connection
 * was the asset's decimals, and those were being fetched through
 * `useVaultPosition` — a per-address hook asked a question that is not about
 * an address. See GHO-44.
 */
export default function RoundsPage() {
  return (
    <AppShell title="Markets" subtitle="Take a view with borrowed capital — your stake keeps earning">
      {!anyMarketConfigured() ? (
        <NotConfigured what="No market is configured for this network." />
      ) : (
        <RoundsScreen />
      )}
    </AppShell>
  );
}

/**
 * The browsing surface: what there is to have a view on, then the rounds of
 * whichever one you picked.
 *
 * A list, not a single market, because a list is what makes someone open the
 * app when they hold no position. One market is a page you visit when you
 * already know what you want.
 */
function RoundsScreen() {
  const now = useNow();
  const { markets, listed, isLoading: marketsLoading, isError: marketsError } = useMarkets();
  const params = useMarketParams(markets);
  const feeds = useMarketFeeds(markets);
  const { rounds, isLoading, isError } = useRounds(markets);
  const asset = useVaultAsset();

  if (isError || marketsError) {
    return (
      <Card>
        <p className="text-sm text-ink-muted">
          Markets could not be read. The chain is unreachable right now — nothing about your
          positions has changed.
        </p>
      </Card>
    );
  }

  if (marketsLoading || isLoading || asset.decimals === undefined) {
    return (
      <Card>
        <div className="h-24 animate-pulse rounded bg-raised" />
      </Card>
    );
  }

  if (markets.length === 0) {
    return (
      <Card>
        <p className="text-sm text-ink-muted">
          The registry lists no markets yet. Adding one is a transaction, not a redeploy.
        </p>
      </Card>
    );
  }

  // A market a user holds a position in is always shown, even if the owner
  // has delisted it. Delisting hides a market from browsing; it does not
  // settle anyone's stake, and hiding it from the holder would.
  const holdings = new Set(
    rounds.filter((r) => (r.up ?? 0n) + (r.down ?? 0n) > 0n).map((r) => r.market.key),
  );
  const visible = markets.filter((m) => m.enabled || holdings.has(m.key));

  const summaries = visible
    .map((market) => summarise(market, rounds, params.byMarket.get(market.key)))
    .sort(byActivity);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xs font-medium tracking-wide text-ink-muted uppercase">Markets</h2>
          <span className="h-px flex-1 bg-border" />
          {listed.length !== visible.length && (
            <span className="text-[11px] text-ink-faint">
              includes {visible.length - listed.length} delisted you hold
            </span>
          )}
        </div>

        <div className="flex flex-col gap-2">
          {summaries.map((summary) => (
            <MarketRow
              key={summary.market.key}
              summary={summary}
              feed={feeds.byMarket.get(summary.market.key)}
              decimals={asset.decimals!}
              symbol={asset.symbol}
              now={now}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

/**
 * One market in the list: what it prices, on what cadence, and what is at
 * stake.
 *
 * A link, not a button. It was a button with the selection held in React
 * state, which is exactly the complaint GHO-41 makes: reload and you were back
 * at the top of the list, and "look at this market" meant "open the app, click
 * Markets, pick the second one". The market's own address is the URL now.
 */
function MarketRow({
  summary,
  feed,
  decimals,
  symbol,
  now,
}: {
  summary: Summary;
  feed: MarketFeed | undefined;
  decimals: number;
  symbol: string;
  now: bigint | undefined;
}) {
  const { market, params, live } = summary;
  const demo = market.kindHint === "demo" || feed?.isDemo === true;
  const label = feed ? (feed.description.split(" - ").pop() ?? "Market") : "Reading feed…";

  const upMultiple = live && params ? multipleFor(live.round, Side.Up, params.rake) : null;
  const downMultiple = live && params ? multipleFor(live.round, Side.Down, params.rake) : null;

  const closesIn =
    live && params && now !== undefined && live.phase === Phase.Open
      ? entryClosesAt(live.round, params.entryCutoff) - now
      : undefined;

  return (
    <Link
      href={`/markets/${market.address}`}
      className="block cursor-pointer rounded-card border border-border bg-surface p-4 text-left transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-sm font-medium text-ink">{label}</span>
          {demo && (
            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-warning uppercase">
              Demo feed
            </span>
          )}
          {!market.enabled && (
            <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-ink-faint">
              delisted — you hold a position
            </span>
          )}
          {market.horizon !== undefined && (
            <span className="text-[11px] text-ink-faint">
              {formatHorizon(market.horizon)} rounds
            </span>
          )}
        </div>

        {closesIn !== undefined && (
          <span className="text-[11px] text-ink-faint">
            entry closes in{" "}
            <span className="tabular text-ink">{formatCountdown(closesIn)}</span>
          </span>
        )}
      </div>

      {live ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <SideSummary
            name="Up"
            pool={live.round.upPool}
            multiple={upMultiple}
            decimals={decimals}
            symbol={symbol}
          />
          <SideSummary
            name="Down"
            pool={live.round.downPool}
            multiple={downMultiple}
            decimals={decimals}
            symbol={symbol}
          />
        </div>
      ) : (
        <p className="mt-3 text-xs text-ink-faint">No round open right now.</p>
      )}
    </Link>
  );
}

function SideSummary({
  name,
  pool,
  multiple,
  decimals,
  symbol,
}: {
  name: string;
  pool: bigint;
  multiple: bigint | null;
  decimals: number;
  symbol: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 rounded-lg bg-raised/40 px-3 py-2">
      <span className="text-xs text-ink-muted">{name}</span>
      <span className="flex items-baseline gap-2">
        <span className="tabular text-xs text-ink-faint">
          {formatAmount(pool, decimals, 0)} {symbol}
        </span>
        {/* A live quote, not a promise: it moves with every entry, and an
            empty side has no multiple at all rather than an infinite one. */}
        <span className="tabular text-sm text-ink">
          {multiple === null ? "—" : `${formatAmount(multiple, 18, 2)}×`}
        </span>
      </span>
    </div>
  );
}
