"use client";

import Link from "next/link";

import { SideArrow } from "@/components/ui/icons";
import { AppShell, NotConfigured } from "@/components/AppShell";
import { Card } from "@/components/ui/Card";
import { useNow } from "@/hooks/useNow";
import { useMarketFeeds, type MarketFeed } from "@/hooks/useMarketFeeds";
import { useSpot, type Spot } from "@/hooks/useSpot";
import { formatAge, formatMove, isNarrow, isStalePrint, priceAge, standingOf } from "@/lib/spot";
import { useMarkets } from "@/hooks/useMarkets";
import { useMarketParams, useRounds } from "@/hooks/useRounds";
import { MoneyStrip } from "@/components/MoneyStrip";
import { questionFor, sideLabel } from "@/lib/question";
import { useVaultAsset } from "@/hooks/useVaultPosition";
import { anyMarketConfigured } from "@/lib/markets";
import { byActivity, formatHorizon, summarise, type Summary } from "@/lib/marketList";
import { formatAmount } from "@/lib/format";
import {
  Phase,
  Side,
  entryClosesAt,
  formatCountdown,
  multipleFor,
  upShare,
  type Round,
} from "@/lib/rounds";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Skeleton } from "@/components/ui/Skeleton";
import { Badge } from "@/components/ui/Badge";

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
export function MarketsScreen() {
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
  const spot = useSpot(markets, feeds.byMarket);
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
        <Skeleton className="h-24" />
      </Card>
    );
  }
  // Captured once narrowed. The narrowing above does not reach into the row
  // callback below, which is where the `!` used to stand in for it (GHO-86).
  const decimals = asset.decimals;

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
      {/* What your money is doing, above the questions it could answer
          (GHO-78). Deliberately first: the product is the two jobs one stake
          does, and a feed of questions alone is a thinner Polymarket. */}
      <MoneyStrip />

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Eyebrow as="h2">Markets</Eyebrow>
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
              spot={spot.byMarket.get(summary.market.key)}
              decimals={decimals}
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
  spot,
  decimals,
  symbol,
  now,
}: {
  summary: Summary;
  feed: MarketFeed | undefined;
  /** The asset's last printed price (GHO-64). Undefined on a question, which
   *  is not settled by one. */
  spot: Spot | undefined;
  decimals: number;
  symbol: string;
  now: bigint | undefined;
}) {
  const { market, params, live } = summary;
  const demo = market.kindHint === "demo" || feed?.isDemo === true;
  // The instrument behind the question. A price feed names itself
  // "GHOSTSTAKE DEMO FEED - ETH / USD", and the part after the dash is the
  // part worth showing. A question's own words are not a feed label and must
  // not be split on a dash it may well contain.
  const label = !feed
    ? "Reading feed…"
    : feed.isQuestion
      ? "Settled by a claim"
      : (feed.description.split(" - ").pop() ?? "Market");

  // What this market is asking. Without a live round there is no strike and
  // no close, so it falls back to naming the instrument rather than inventing
  // a question nobody can answer.
  const question = live
    ? questionFor({
        feed: feed?.description,
        strike: live.round.lockPrice,
        closeTime: live.round.closeTime,
        isQuestion: feed?.isQuestion,
      })
    : label;

  const upMultiple = live && params ? multipleFor(live.round, Side.Up, params.rake) : null;
  const downMultiple = live && params ? multipleFor(live.round, Side.Down, params.rake) : null;

  const closesIn =
    live && params && now !== undefined && live.phase === Phase.Open
      ? entryClosesAt(live.round, params.entryCutoff) - now
      : undefined;

  return (
    <Link
      href={`/markets/${market.address}`}
      className="block cursor-pointer rounded-card border border-border bg-surface p-4 text-left transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
    >
      {/* The question, not the instrument (GHO-78). "ETH / USD" names a feed;
          it does not say what anyone is being asked. The feed's own label
          stays underneath, because which feed settles this is a fact somebody
          checking the market still wants. */}
      <h3 className="display text-base leading-snug text-ink">{question}</h3>

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-xs text-ink-faint">{label}</span>
          {demo && (
            <Badge size="sm">
              Demo feed
            </Badge>
          )}
          {!market.enabled && (
            <span className="rounded-sm bg-raised px-2 py-0.5 text-[11px] text-ink-faint">
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

      {!feed?.isQuestion && (
        <SpotSummary round={live?.round} spot={spot} now={now} />
      )}

      {live ? (
        <>
          <OddsSplit round={live.round} />
          <div className="mt-2 grid grid-cols-2 gap-3">
            <SideSummary
              name="Yes"
              up
              pool={live.round.upPool}
              percent={sharePercent(live.round, true)}
              multiple={upMultiple}
              decimals={decimals}
              symbol={symbol}
            />
            <SideSummary
              name="No"
              up={false}
              pool={live.round.downPool}
              percent={sharePercent(live.round, false)}
              multiple={downMultiple}
              decimals={decimals}
              symbol={symbol}
            />
          </div>
        </>
      ) : (
        <p className="mt-3 text-xs text-ink-faint">No round open right now.</p>
      )}
    </Link>
  );
}

/**
 * The split, as a bar. The same shape as the round card's (GHO-59), smaller,
 * and without the pool figures — a feed is scanned rather than read, and the
 * exact amounts are one tap away on the market itself.
 */
function OddsSplit({ round }: { round: Round }) {
  const share = upShare(round);
  if (share === null) {
    return <p className="mt-3 text-xs text-ink-faint">Nothing staked yet.</p>;
  }

  const yes = Math.round(share);
  return (
    <div className="mt-3 flex items-center gap-3">
      {/* The belief leads; the bar is its picture. Same shape as the round
          card, so a market reads the same in the list and on its own page. */}
      <div className="flex items-baseline gap-1.5">
        <span className="tabular text-2xl text-ink">{yes}%</span>
        <span className="text-xs text-ink-muted">say yes</span>
      </div>

      <div
        className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-down"
        role="img"
        aria-label={`${yes}% of the pool says yes, ${100 - yes}% says no`}
      >
        <div className="h-full bg-up" style={{ width: `${share}%` }} />
      </div>
    </div>
  );
}

function SideSummary({
  name,
  up,
  pool,
  percent,
  multiple,
  decimals,
  symbol,
}: {
  name: string;
  up: boolean;
  pool: bigint;
  /** This side's share of the pool: what the crowd thinks of this answer. */
  percent: number | null;
  multiple: bigint | null;
  decimals: number;
  symbol: string;
}) {
  return (
    <div className="rounded-control border border-border bg-raised/40 px-3 py-2">
      <div className={`display flex items-center gap-1.5 text-sm uppercase ${up ? "text-up" : "text-down"}`}>
        <SideArrow up={up} className="size-2.5" />
        {name}
      </div>
      {/* Never a bare multiple (GHO-78): the crowd being on this side is why
          it pays what it pays, and one number without the other reads as odds
          somebody set. */}
      <p className="tabular mt-1 text-base text-ink">
        {multiple === null ? "—" : `${formatAmount(multiple, 18, 2)}×`}
        {percent !== null && <span className="ml-1.5 text-xs text-ink-muted">{percent}%</span>}
      </p>
      <p className="tabular mt-0.5 text-[11px] text-ink-faint">
        {formatAmount(pool, decimals, 2)} {symbol}
      </p>
    </div>
  );
}

/** A side's share of the pool, rounded, or null when nothing is staked. */
function sharePercent(round: Round, up: boolean): number | null {
  const total = round.upPool + round.downPool;
  if (total === 0n) return null;
  const side = up ? round.upPool : round.downPool;
  return Math.round(Number((side * 100n) / total));
}

/**
 * The asset's price on a list row, with how old it is and which way the live
 * round is leaning.
 *
 * The list showed pools and multiples and no price at all, which is the
 * complaint GHO-64 opens with: a row that says what is at stake but not what
 * it is at stake *on*.
 *
 * "1h change" was asked for and is deliberately not what this shows. The
 * ETH/USD feed publishes on an hourly heartbeat, so a one-hour change and a
 * change-since-last-print are the same number wearing a label that implies a
 * continuous series behind it. What a row can honestly show is the distance
 * from the level this round actually settles against — which is also the more
 * useful number, because it is the one that decides the bet.
 */
function SpotSummary({
  round,
  spot,
  now,
}: {
  round: Round | undefined;
  spot: Spot | undefined;
  now: bigint | undefined;
}) {
  if (!spot) return null;

  const age = priceAge(spot.updatedAt, now);
  const stale = age !== null && isStalePrint(age);
  const { leading, bps } = standingOf(spot.price, round?.lockPrice);

  return (
    <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-xs text-ink-muted">
      <span>
        {stale ? "Last price" : "Now"}{" "}
        <span className="tabular text-ink">{formatAmount(spot.price, 18, 2)}</span>
      </span>
      {age !== null && <span className="text-[11px] text-ink-faint">printed {formatAge(age)}</span>}
      {bps !== null && leading !== null && (
        <span className="tabular">
          {formatMove(bps)}{" "}
          <span className="tabular-none">
            {isNarrow(bps) ? "— too close to call" : `— ${sideLabel(leading)} ahead`}
          </span>
        </span>
      )}
    </p>
  );
}
