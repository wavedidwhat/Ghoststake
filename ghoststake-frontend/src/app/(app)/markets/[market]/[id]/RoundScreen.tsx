"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { Page } from "@/components/Page";
import { Card } from "@/components/ui/Card";
import { ResolutionPanel } from "@/components/ResolutionPanel";
import { useActivityDecimals } from "@/hooks/useActivity";
import { shortHash } from "@/lib/activity";
import { formatAmount, formatDateTime, formatInteger } from "@/lib/format";
import { winnerKey } from "@/lib/question";
import type { PositionRound } from "@/lib/positions";
import { fetchRounds, type RoundsResponse } from "@/lib/roundsApi";
import { activeChain } from "@/lib/wagmi";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Skeleton } from "@/components/ui/Skeleton";

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
  const t = useTranslations("roundPage");
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
    <Page title={t("title", { id })} subtitle={t("subtitle")}>
      <div className="flex flex-col gap-4">
        <Link
          href={`/markets/${market}`}
          className="text-xs text-ink-faint underline-offset-2 hover:text-ink-muted hover:underline"
        >
          {t("back")}
        </Link>

        {query.isError ? (
          <Card>
            <p className="text-sm text-ink">{t("unreadable")}</p>
            <p className="mt-2 text-xs text-ink-faint">{String(query.error)}</p>
          </Card>
        ) : query.isLoading ? (
          <Card>
            <Skeleton className="h-24" />
          </Card>
        ) : !round ? (
          <Card>
            <p className="text-sm text-ink">{t("missing", { id })}</p>
            <p className="mt-2 text-xs text-ink-faint">
              {query.data
                ? t("missingDetailIndexed", { block: formatInteger(query.data.indexedBlock) })
                : t("missingDetail")}
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
    </Page>
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
  const t = useTranslations("roundPage");
  const sides = useTranslations("round.sides");
  const fmt = (v: string) => (decimals === undefined ? "…" : formatAmount(BigInt(v), decimals, 2));

  return (
    <>
      {/*
       * A round settled by a question puts the claim first, above the pool.
       * The receipt for a price round is "here is the feed round it settled
       * against"; for a question it is the claim, the evidence and the fact
       * that nobody paid to argue — and that is the part somebody following a
       * shared link has come to check.
       */}
      {round.question && (
        <ResolutionPanel question={round.question} decimals={decimals} symbol={symbol} />
      )}

      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <Eyebrow>{t("outcome")}</Eyebrow>
            <p className="mt-1 text-lg font-medium text-ink">
              <Outcome round={round} />
            </p>
          </div>
          <p className="text-right text-xs text-ink-faint">
            <span className="font-mono">{shortHash(market, 6, 4)}</span>
            <br />
            {indexedBlock ? t("indexedTo", { block: formatInteger(indexedBlock) }) : ""}
          </p>
        </div>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <Eyebrow>{t("pool")}</Eyebrow>
          <dl className="mt-3 space-y-2 text-sm">
            <Line label={sides("yes")} value={`${fmt(round.upPool)} ${symbol}`} />
            <Line label={sides("no")} value={`${fmt(round.downPool)} ${symbol}`} />
            <Line label={t("total")} value={`${fmt(round.totalPool)} ${symbol}`} />
            {round.rakeTaken && (
              <Line label={t("rakeTaken")} value={`${fmt(round.rakeTaken)} ${symbol}`} />
            )}
          </dl>
        </Card>

        <Card>
          <Eyebrow>{t("clock")}</Eyebrow>
          <dl className="mt-3 space-y-2 text-sm">
            <Line label={t("opened")} value={formatDateTime(round.openTime)} />
            <Line label={t("locked")} value={formatDateTime(round.lockTime)} />
            <Line label={t("closed")} value={formatDateTime(round.closeTime)} />
          </dl>
        </Card>

        <Card>
          <Eyebrow>{t("price")}</Eyebrow>
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
              label={t("strike")}
              value={
                round.lockPrice === null
                  ? t("strikeNotSet")
                  : formatAmount(BigInt(round.lockPrice), 18, 2)
              }
            />
            <Line
              label={t("close")}
              value={
                round.closePrice === null
                  ? t("closeNotSettled")
                  : formatAmount(BigInt(round.closePrice), 18, 2)
              }
            />
          </dl>
        </Card>

        <Card>
          <Eyebrow>{t("terms")}</Eyebrow>
          <dl className="mt-3 space-y-2 text-sm">
            <Line label={t("status")} value={round.status} />
            <Line label={t("phase")} value={round.phase} />
            <Line label={t("lastTouched")} value={t("block", { block: formatInteger(round.lastBlock) })} />
          </dl>
        </Card>
      </div>
    </>
  );
}

function Outcome({ round }: { round: PositionRound }) {
  const t = useTranslations("roundPage");
  if (round.status === "resolved") {
    // Anything but a Yes reads as No, as it always has: the API's winner is
    // "up" or "down" on a resolved round.
    return <span className="text-positive">{t("won", { winner: winnerKey(round.winner) ?? "no" })}</span>;
  }
  if (round.status === "void") {
    return (
      <span className="text-ink-muted">
        {t("voided")}
        {round.voidReason && (
          <span className="ml-2 text-xs text-ink-faint">{round.voidReason}</span>
        )}
      </span>
    );
  }
  return <span className="text-ink">{t("running", { phase: round.phase })}</span>;
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tabular text-right text-ink">{value}</dd>
    </div>
  );
}
