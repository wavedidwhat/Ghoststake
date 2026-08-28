"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { Card } from "@/components/Card";
import { useActivityDecimals } from "@/hooks/useActivity";
import { shortHash } from "@/lib/activity";
import { formatAmount } from "@/lib/format";
import type { PositionRound } from "@/lib/positions";
import { fetchRounds, type RoundsResponse } from "@/lib/roundsApi";
import { activeChain } from "@/lib/wagmi";

/**
 * One round's receipt.
 *
 * Read from the API rather than the chain, unlike every other market surface.
 * A settled round cannot change, so the indexer's confirmation lag costs
 * nothing — and the chain cannot answer this at all past the twelve-round
 * window the contract reads leave reachable, or for a market the registry has
 * delisted. A receipt that expires is not a receipt.
 */
export function RoundScreen({ market, id }: { market: string; id: string }) {
  const decimals = useActivityDecimals();

  const query = useQuery<RoundsResponse>({
    queryKey: ["round", activeChain.id, market.toLowerCase(), id],
    // The endpoint lists rounds rather than serving one, so this asks for a
    // page and picks. Worth naming as a limitation: a round older than the
    // hundred most recent in its market is not reachable here, and the fix is
    // a `/rounds/{market}/{id}` endpoint rather than a larger limit.
    queryFn: () => fetchRounds({ market, limit: 100 }),
    staleTime: 15_000,
  });

  const round = query.data?.rounds.find((r) => String(r.id) === id);

  return (
    <AppShell title={`Round ${id}`} subtitle="What was staked, what settled it, and who won">
      <div className="flex flex-col gap-4">
        <Link
          href={`/markets/${market}`}
          className="text-xs text-ink-faint underline-offset-2 hover:text-ink-muted hover:underline"
        >
          ← This market
        </Link>

        {query.isError ? (
          <Card>
            <p className="text-sm text-ink">Could not read this round.</p>
            <p className="mt-2 text-xs text-ink-faint">{String(query.error)}</p>
          </Card>
        ) : query.isLoading ? (
          <Card>
            <div className="h-24 animate-pulse rounded bg-raised" />
          </Card>
        ) : !round ? (
          <Card>
            <p className="text-sm text-ink">No round {id} on this market.</p>
            <p className="mt-2 text-xs text-ink-faint">
              Round ids restart at 1 in every market, so a round 7 exists in each of them and this
              is not the one you meant — or the indexer has not reached it yet
              {query.data
                ? ` (it has read to block ${query.data.indexedBlock.toLocaleString()})`
                : ""}
              .
            </p>
          </Card>
        ) : (
          <Detail
            round={round}
            market={market}
            decimals={decimals.assetDecimals}
            symbol={decimals.assetSymbol}
            indexedBlock={query.data?.indexedBlock}
          />
        )}
      </div>
    </AppShell>
  );
}

function Detail({
  round,
  market,
  decimals,
  symbol,
  indexedBlock,
}: {
  round: PositionRound;
  market: string;
  decimals?: number;
  symbol: string;
  indexedBlock?: number;
}) {
  const fmt = (v: string) => (decimals === undefined ? "…" : formatAmount(BigInt(v), decimals, 2));

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">Outcome</p>
            <p className="mt-1 text-lg font-medium text-ink">
              <Outcome round={round} />
            </p>
          </div>
          <p className="text-right text-xs text-ink-faint">
            <span className="font-mono">{shortHash(market, 6, 4)}</span>
            <br />
            {indexedBlock ? `Indexed to block ${indexedBlock.toLocaleString()}.` : ""}
          </p>
        </div>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">The pool</p>
          <dl className="mt-3 space-y-2 text-sm">
            <Line label="Up" value={`${fmt(round.upPool)} ${symbol}`} />
            <Line label="Down" value={`${fmt(round.downPool)} ${symbol}`} />
            <Line label="Total" value={`${fmt(round.totalPool)} ${symbol}`} />
            {round.rakeTaken && (
              <Line label="Rake taken" value={`${fmt(round.rakeTaken)} ${symbol}`} />
            )}
          </dl>
        </Card>

        <Card>
          <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">The clock</p>
          <dl className="mt-3 space-y-2 text-sm">
            <Line label="Opened" value={new Date(round.openTime).toLocaleString()} />
            <Line label="Locked" value={new Date(round.lockTime).toLocaleString()} />
            <Line label="Closed" value={new Date(round.closeTime).toLocaleString()} />
          </dl>
        </Card>

        <Card>
          <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">The price</p>
          <dl className="mt-3 space-y-2 text-sm">
            {/* The two reads the settlement is pinned to. Shown because they
                are the whole basis of the result — a round page that states an
                outcome without the prices behind it is asking to be trusted. */}
            {/* Formatted, not raw. The API sends every uint256 as a decimal
                string so nothing loses precision in transit, and rendering
                that string is how "2,000.00" reaches a page as
                2000000000000000000000. The oracle normalises every feed to 18
                decimals, so a price is WAD here whatever the aggregator
                underneath reports. */}
            <Line
              label="Strike (at lock)"
              value={
                round.lockPrice === null
                  ? "not locked yet"
                  : formatAmount(BigInt(round.lockPrice), 18, 2)
              }
            />
            <Line
              label="Close"
              value={
                round.closePrice === null
                  ? "not settled yet"
                  : formatAmount(BigInt(round.closePrice), 18, 2)
              }
            />
          </dl>
        </Card>

        <Card>
          <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">Terms</p>
          <dl className="mt-3 space-y-2 text-sm">
            <Line label="Status" value={round.status} />
            <Line label="Phase" value={round.phase} />
            <Line label="Last touched" value={`block ${round.lastBlock.toLocaleString()}`} />
          </dl>
        </Card>
      </div>
    </>
  );
}

function Outcome({ round }: { round: PositionRound }) {
  if (round.status === "resolved") {
    return <span className="text-positive">{round.winner === "up" ? "Up won" : "Down won"}</span>;
  }
  if (round.status === "void") {
    return (
      <span className="text-ink-muted">
        Voided — every stake refunded
        {round.voidReason && (
          <span className="ml-2 text-xs text-ink-faint">{round.voidReason}</span>
        )}
      </span>
    );
  }
  return <span className="text-ink">Still running · {round.phase}</span>;
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tabular text-right text-ink">{value}</dd>
    </div>
  );
}
