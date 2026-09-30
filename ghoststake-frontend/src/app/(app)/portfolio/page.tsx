"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useWallet } from "@/hooks/useWallet";
import { Page } from "@/components/Page";
import { ClaimAllPanel } from "@/components/ClaimAllPanel";
import { buttonClass } from "@/components/ui/Button";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { useClaimables } from "@/hooks/useClaimables";
import { Card, Stat } from "@/components/ui/Card";
import { Figure } from "@/components/ui/Figure";
import { HealthFactorCard } from "@/components/HealthFactor";
import { PipelineSummary } from "@/components/PipelineSummary";
import { Terms } from "@/components/Terms";
import { useVaultPosition } from "@/hooks/useVaultPosition";
import { usePoolStats } from "@/hooks/usePoolStats";
import { useMarkets } from "@/hooks/useMarkets";
import { useRounds } from "@/hooks/useRounds";
import { Phase } from "@/lib/rounds";
import { contractsConfigured } from "@/lib/env";
import { useFormat } from "@/i18n/useFormat";
import { stakeStanding } from "@/lib/stake";
import { activeChain } from "@/lib/wagmi";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Skeleton } from "@/components/ui/Skeleton";

export default function PortfolioPage() {
  const t = useTranslations("portfolio");
  const wallet = useWallet();
  const position = useVaultPosition();

  // Was `/` until GHO-62 moved the market feed there. A lending dashboard is
  // the right home for someone who has money in this protocol and the wrong
  // one for someone deciding whether to.
  //
  // `useWallet` and not `status === "disconnected"`: on a reload wagmi restores
  // the address from storage while it re-checks with the wallet, and branching
  // on the status rendered "connect a wallet" over a page already showing that
  // address's balances (GHO-77). If we have an address, we have a wallet.
  return (
    <Page title={t("title")} subtitle={t("subtitle")}>
      {!wallet.isConnected ? (
        <Disconnected />
      ) : !contractsConfigured ? (
        <NotDeployed />
      ) : position.isError ? (
        <LoadFailed
          title={t("unreadable")}
          onRetry={() => position.refetch()}
          className="mx-auto mt-16 max-w-md text-center"
        >
          {t("unreadableDetail")}
        </LoadFailed>
      ) : (
        <Position position={position} />
      )}
    </Page>
  );
}

function Position({ position }: { position: ReturnType<typeof useVaultPosition> }) {
  const { formatAmount } = useFormat();
  const t = useTranslations("portfolio");
  const vault = useTranslations("vault");
  const { decimals, symbol } = position;
  const standing = stakeStanding(position.totalLedgerValue, position.collateralValue, decimals);

  // Undefined until decimals are known: formatting against a guessed scale
  // produces a plausible number that is wrong by orders of magnitude.
  const amount = (value: bigint | undefined) =>
    value === undefined || decimals === undefined
      ? undefined
      : formatAmount(value, decimals);

  const { address } = useWallet();
  const claimables = useClaimables();

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* What can be collected leads. It is the only thing on this page that
          is someone else's money until they press a button, and it used to be
          findable only by visiting each market in turn. */}
      {address && (
        <div className="lg:col-span-3">
          <ClaimAllPanel
            claims={claimables.claims}
            address={address}
            decimals={position.decimals}
            symbol={position.symbol}
            onClaimed={() => {
              claimables.refetch();
              position.refetch();
            }}
          />
        </div>
      )}

      {/* The pipeline follows, because the relationship between the three
          numbers is the product. Health factor is the detail behind the
          middle step. */}
      <div className="lg:col-span-3">
        <PipelineStrip position={position} standing={standing} />
      </div>

      <div className="lg:col-span-2">
        <HealthFactorCard
          value={position.healthFactor}
          liquidatable={position.isLiquidatable}
        />
      </div>

      <Stat label={t("collateralValue")} hint={t("collateralValueHint")}>
        <PendingFigure value={amount(position.collateralValue)} unit={symbol} />
      </Stat>

      {/* Not toned positive while the ledger is unfunded. Green beside a
          balance says "you gained this", and the panel above has just
          finished explaining that nothing stands behind it — the two would be
          arguing with each other on the same screen. See GHO-55. */}
      <Stat
        label={t("accruedYield")}
        hint={standing && !standing.backed ? t("accruedCredited") : t("accruedSince")}
      >
        <PendingFigure
          value={amount(position.accruedYield)}
          unit={symbol}
          tone={standing && !standing.backed ? "muted" : "positive"}
        />
      </Stat>

      {/* Accounting parentheses: a claim against the position, not a
          balance it holds. */}
      <Stat label={t("debt")} hint={t("debtHint")}>
        {position.lien === undefined || decimals === undefined ? (
          <Skeleton className="h-8 w-32" />
        ) : position.lien === 0n ? (
          <Figure value={formatAmount(0n, decimals)} unit={symbol} size="stat" tone="muted" />
        ) : (
          <Figure
            value={`(${formatAmount(position.lien, decimals)})`}
            unit={symbol}
            // Sized like its siblings. Omitting this fell back to the larger
            // default, so Debt rendered half again as big as every other
            // stat and pushed its unit past the card edge.
            size="stat"
            tone="negative"
          />
        )}
      </Stat>

      <Stat label={vault("stillBorrowable")} hint={vault("stillBorrowableHint")}>
        <PendingFigure value={amount(position.maxBorrowable)} unit={symbol} />
      </Stat>

      {/* Protocol-wide, not this wallet's. Separated by a labelled rule so
          the two are never read as one set of numbers. */}
      <div className="lg:col-span-3">
        <PoolStats decimals={decimals} symbol={symbol} />
      </div>

      {/* Last, because it is reference rather than state — but on this page
          rather than behind a link, because "what are the terms" is the first
          question anyone asks a lending protocol and a page nobody clicks does
          not answer it. See GHO-30. */}
      <div className="lg:col-span-3">
        <TermsSection decimals={decimals} symbol={symbol} />
      </div>
    </div>
  );
}

/**
 * Reads the user's open positions so the summary can say what the borrowed
 * money is actually doing, rather than stopping at "you have debt".
 */
function PipelineStrip({
  position,
  standing,
}: {
  position: ReturnType<typeof useVaultPosition>;
  standing: ReturnType<typeof stakeStanding>;
}) {
  // Every market, not just the listed ones: a position in a market the owner
  // has since delisted is still the user's money at risk, and leaving it out
  // of this summary would understate what is at stake.
  const { markets } = useMarkets();
  const { rounds } = useRounds(markets);

  // The one figure on this page that asserted the scale instead of checking
  // it (GHO-86). `Position` renders before decimals resolve — it is gated on
  // the wallet and on errors, not on the read — so on every first load this
  // strip formatted balances against no scale at all, and `formatAmount` then
  // defaulted to 18. A 6-decimal balance of 10,000 rendered as 0.00.
  const { decimals } = position;
  if (decimals === undefined) {
    return <Skeleton className="h-40" shape="card" />;
  }

  let atRisk = 0n;
  let open = 0;
  for (const r of rounds) {
    const mine = (r.up ?? 0n) + (r.down ?? 0n);
    if (mine === 0n) continue;
    // Only live rounds are "working". A settled one is history and belongs on
    // the markets page, not in a summary of what is currently at stake.
    if (r.phase !== Phase.Resolved && r.phase !== Phase.Void) {
      atRisk += mine;
      open += 1;
    }
  }

  return (
    <PipelineSummary
      staked={position.collateralValue}
      yieldRate={position.yieldRatePerSecond}
      standing={standing}
      accrued={position.accruedYield}
      borrowed={position.lien}
      healthFactor={position.healthFactor}
      liquidatable={position.isLiquidatable}
      atRiskInMarkets={atRisk}
      openPositions={open}
      decimals={decimals}
      symbol={position.symbol}
    />
  );
}

/** Markets are read here rather than in `Terms` so the panel stays a
 *  presentation component and the two market-reading hooks keep one caller. */
function TermsSection({ decimals, symbol }: { decimals: number | undefined; symbol: string }) {
  // The listed ones. Terms are reference material for a decision a user is
  // about to make, and a delisted market is not one they can enter.
  const { listed } = useMarkets();
  return <Terms markets={listed} decimals={decimals} symbol={symbol} />;
}

function PoolStats({ decimals, symbol }: { decimals: number | undefined; symbol: string }) {
  const { formatAmount, formatApr, formatPercent } = useFormat();
  const t = useTranslations("portfolio.pool");
  const pool = usePoolStats();

  const amount = (value: bigint | undefined) =>
    value === undefined || decimals === undefined ? undefined : formatAmount(value, decimals);

  return (
    <section aria-labelledby="pool-heading" className="mt-2">
      <div className="mb-3 flex items-center gap-3">
        <Eyebrow as="h2" id="pool-heading">
          {t("heading")}
        </Eyebrow>
        <span className="h-px flex-1 bg-border" />
        {/* The way in. These figures described a pool nobody outside the seed
            script could join until GHO-39. */}
        <Link
          href="/lend"
          className="text-xs text-ink-faint transition-colors hover:text-action focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        >
          {t("supplyInto")}
        </Link>
      </div>

      {pool.isError ? (
        <Card>
          <p className="text-sm text-ink-muted">{t("unavailable")}</p>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label={t("totalSupplied")} hint={t("totalSuppliedHint")}>
            <PendingFigure value={amount(pool.totalSupplied)} unit={symbol} />
          </Stat>
          <Stat label={t("totalBorrowed")} hint={t("totalBorrowedHint")}>
            <PendingFigure value={amount(pool.totalBorrowed)} unit={symbol} />
          </Stat>
          <Stat label={t("utilization")} hint={t("utilizationHint")}>
            <PendingFigure
              value={pool.utilization === undefined ? undefined : formatPercent(pool.utilization)}
              unit=""
            />
          </Stat>
          <Stat label={t("borrowRate")} hint={t("borrowRateHint")}>
            <PendingFigure
              value={
                pool.borrowRatePerSecond === undefined
                  ? undefined
                  : formatApr(pool.borrowRatePerSecond)
              }
              unit=""
            />
          </Stat>
          {/* Lower than the borrow rate by two effects at once: only the
              borrowed fraction earns anything, and the protocol keeps a
              reserve cut of what it does earn. */}
          <Stat label={t("supplyRate")} hint={t("supplyRateHint")}>
            <PendingFigure
              value={
                pool.supplyRatePerSecond === undefined
                  ? undefined
                  : formatApr(pool.supplyRatePerSecond)
              }
              unit=""
              tone="positive"
            />
          </Stat>
        </div>
      )}
    </section>
  );
}

function PendingFigure({
  value,
  unit,
  tone,
}: {
  value: string | undefined;
  unit: string;
  tone?: "positive" | "muted";
}) {
  if (value === undefined) return <Skeleton className="h-8 w-32" />;
  return <Figure value={value} unit={unit} size="stat" tone={tone} />;
}

/**
 * A portfolio is per-address, so this one genuinely needs a wallet — unlike
 * the old `/`, which gated the whole product behind one (GHO-44).
 *
 * The explainer is not repeated here. It has its own page now (GHO-62) and
 * stays readable whether or not a wallet is connected.
 */
function Disconnected() {
  const t = useTranslations("portfolio");
  return (
    <div className="mx-auto mt-10 max-w-md text-center">
      <h2 className="display text-xl uppercase">{t("connect")}</h2>
      <p className="mt-3 text-sm leading-relaxed text-ink-muted">{t("connectDetail")}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-3">
        <Link
          href="/"
          className={buttonClass({ variant: "outline", className: "display uppercase" })}
        >
          {t("browseMarkets")}
        </Link>
        <Link
          href="/how-it-works"
          className={buttonClass({ variant: "outline", className: "display uppercase" })}
        >
          {t("howItWorks")}
        </Link>
      </div>
    </div>
  );
}

/**
 * Distinct from an empty position: with no contract to read, zeroes would be
 * indistinguishable from a real position holding nothing.
 */
function NotDeployed() {
  const t = useTranslations("portfolio");
  return (
    <Card className="mx-auto mt-16 max-w-md text-center">
      <h2 className="text-lg font-semibold">{t("notDeployed")}</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">
        {t.rich("notDeployedDetail", {
          chain: activeChain.name,
          code: (chunks) => <code className="text-ink">{chunks}</code>,
        })}
      </p>
    </Card>
  );
}

