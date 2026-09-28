"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useMarketFeeds } from "@/hooks/useMarketFeeds";
import { useLendingTerms, useRoundTerms } from "@/hooks/useTerms";
import {
  formatAmount,
  formatApr,
  formatDuration,
  formatOptional,
  formatPercent,
  shortenAddress,
} from "@/lib/format";
import type { Market } from "@/lib/markets";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Skeleton } from "@/components/ui/Skeleton";

/**
 * The rules governing a position, read live from the contracts.
 *
 * Before this, a user could see their position and not one rule that governs
 * it: the max LTV was 60%, the liquidation threshold 80% and the liquidation
 * bonus 5%, all enforced on chain, and none of them stated anywhere in the
 * app. The dashboard showed a health factor without ever saying what makes it
 * fall below 1 or what happens then.
 *
 * Everything here comes off the chain rather than out of copy. That is not
 * fussiness: these are the numbers that decide when somebody loses collateral,
 * and a term the UI believes while the contract enforces another is the same
 * class of bug as a hardcoded entry cutoff — with a worse consequence.
 *
 * It is also where the design becomes visible. The gap between the LTV ceiling
 * and the liquidation threshold is a deliberate buffer; the entry cutoff
 * exists to defeat a last-second entry against a known price; a parimutuel
 * pool carries no directional risk for the protocol. All three are arguments
 * for the protocol and none of them were on screen.
 */
export function Terms({
  markets,
  decimals,
  symbol,
}: {
  markets: Market[];
  decimals: number | undefined;
  symbol: string;
}) {
  const t = useTranslations("terms");
  const lending = useLendingTerms();

  return (
    <section aria-labelledby="terms-heading" className="mt-2">
      <div className="mb-3 flex items-center gap-3">
        <Eyebrow as="h2" id="terms-heading">
          {t("heading")}
        </Eyebrow>
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs text-ink-faint">{t("source")}</span>
      </div>

      {lending.isError ? (
        <p className="rounded-card border border-border bg-surface p-5 text-sm text-ink-muted">
          {t("unavailable")}
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <Group title={t("staking.title")}>
            <Term
              name={t("staking.yieldRate")}
              value={formatOptional(lending.yieldRatePerSecond, formatApr)}
            >
              {t("staking.yieldRateNote")}
            </Term>
            <Term name={t("staking.withdrawals")} value={t("staking.withdrawalsValue")}>
              {t("staking.withdrawalsNote")}
            </Term>
          </Group>

          <Group title={t("borrowing.title")}>
            <Term name={t("borrowing.maxLtv")} value={formatOptional(lending.maxLTV, formatPercent)}>
              {t("borrowing.maxLtvNote")}
            </Term>
            <Term
              name={t("borrowing.threshold")}
              value={formatOptional(lending.liquidationThreshold, formatPercent)}
            >
              {lending.maxLTV && lending.liquidationThreshold
                ? t.rich("borrowing.thresholdNoteGap", {
                    gap: formatPercent(lending.liquidationThreshold - lending.maxLTV),
                    figure: (chunks) => <span className="tabular text-ink">{chunks}</span>,
                  })
                : t("borrowing.thresholdNote")}
            </Term>
            <Term
              name={t("borrowing.kink")}
              value={formatOptional(lending.kink, formatPercent)}
            >
              {t("borrowing.kinkNote")}
            </Term>
          </Group>

          <Group title={t("liquidated.title")}>
            <Term
              name={t("liquidated.closeFactor")}
              value={formatOptional(lending.closeFactor, formatPercent)}
            >
              {t("liquidated.closeFactorNote")}
            </Term>
            <Term
              name={t("liquidated.bonus")}
              value={formatOptional(lending.liquidationBonus, formatPercent)}
            >
              {t("liquidated.bonusNote")}
            </Term>
            <Term
              name={t("liquidated.full")}
              value={formatOptional(lending.fullLiquidationThreshold, formatHealthLine)}
            >
              {t("liquidated.fullNote")}
            </Term>
          </Group>
        </div>
      )}

      <RoundTermsTable markets={markets} decimals={decimals} symbol={symbol} />
    </section>
  );
}

/**
 * Round terms, one row per market.
 *
 * A row each rather than one set for the deployment: these are
 * `ParimutuelRound` immutables and every market is its own deployment, so two
 * markets can carry different rakes. One set labelled "the rake" would be
 * right today and quietly wrong the first time somebody lists a market on
 * different terms.
 */
function RoundTermsTable({
  markets,
  decimals,
  symbol,
}: {
  markets: Market[];
  decimals: number | undefined;
  symbol: string;
}) {
  const t = useTranslations("terms.rounds");
  const { terms } = useRoundTerms(markets);
  const feeds = useMarketFeeds(markets);

  if (markets.length === 0) return null;

  return (
    <div className="mt-4 rounded-card border border-border bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-ink">{t("title")}</h3>
        <p className="text-xs text-ink-faint">{t("intro")}</p>
      </div>

      {/* Scrolls in its own box rather than pushing the page sideways. */}
      <div className="mt-4 -mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="text-left text-xs tracking-wide text-ink-muted uppercase">
              <th className="pb-2 font-medium">{t("market")}</th>
              <th className="pb-2 font-medium">{t("rake")}</th>
              <th className="pb-2 font-medium">{t("entryCloses")}</th>
              <th className="pb-2 font-medium">{t("minPerSide")}</th>
            </tr>
          </thead>
          <tbody>
            {terms.map((term, i) => (
              <tr key={term.market} className="border-t border-border">
                {/* The feed's own description, falling back to the address.
                    Never a hardcoded label: the registry stores none, and a
                    copy of a name can disagree with the thing it names. */}
                <td className="py-2 pr-4 text-ink">
                  {feeds.byMarket.get(markets[i].key)?.description || shortenAddress(term.market)}
                </td>
                <td className="tabular py-2 pr-4 text-ink-muted">
                  {term.rake === undefined ? "—" : formatPercent(term.rake)}
                </td>
                <td className="tabular py-2 pr-4 text-ink-muted">
                  {term.entryCutoff === undefined
                    ? "—"
                    : t("beforeLock", { duration: formatDuration(term.entryCutoff) })}
                </td>
                <td className="tabular py-2 text-ink-muted">
                  {term.minSidePool === undefined || decimals === undefined
                    ? "—"
                    : `${formatAmount(term.minSidePool, decimals, 2)} ${symbol}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="mt-4 grid gap-3 text-xs leading-relaxed text-ink-muted sm:grid-cols-3">
        <div>
          <dt className="font-medium text-ink">{t("rake")}</dt>
          <dd>{t("rakeNote")}</dd>
        </div>
        <div>
          <dt className="font-medium text-ink">{t("entryCutoff")}</dt>
          <dd>{t("entryCutoffNote")}</dd>
        </div>
        <div>
          <dt className="font-medium text-ink">{t("minimumPerSide")}</dt>
          <dd>{t("minimumPerSideNote")}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * A WAD health-factor line as a plain multiple, so it reads on the same scale
 * as the health factor above it: "0.8400", not "84.00%". The two are the same
 * number and showing them in different units is how a user concludes their
 * position is safe at 0.9.
 */
function formatHealthLine(wad: bigint): string {
  return formatAmount(wad, 18, 4);
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-card border border-border bg-surface p-5">
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      <dl className="mt-4 space-y-4">{children}</dl>
    </div>
  );
}

/**
 * One term: what it is called, what it is set to, and what it means for you.
 *
 * The sentence is not decoration. "Liquidation bonus 5%" states a fact a user
 * cannot act on; "the discount a liquidator takes on the collateral they
 * seize, paid out of your position" is the same fact in a form that tells them
 * what it costs.
 */
function Term({
  name,
  value,
  children,
}: {
  name: string;
  value: string | undefined;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow as="dt">{name}</Eyebrow>
        {value === undefined ? (
          <Skeleton className="h-4 w-12" />
        ) : (
          <span className="tabular text-sm font-medium text-ink">{value}</span>
        )}
      </div>
      <dd className="mt-1 text-xs leading-relaxed text-ink-faint">{children}</dd>
    </div>
  );
}
