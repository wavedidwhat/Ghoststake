"use client";

import Link from "next/link";
import { useConnection } from "wagmi";
import { Card, Stat } from "@/components/Card";
import { ConnectButton } from "@/components/ConnectButton";
import { Figure } from "@/components/Figure";
import { HealthFactorCard } from "@/components/HealthFactor";
import { PipelineSummary } from "@/components/PipelineSummary";
import { NetworkGuard } from "@/components/NetworkGuard";
import { Sidebar } from "@/components/Sidebar";
import { Terms } from "@/components/Terms";
import { useVaultPosition } from "@/hooks/useVaultPosition";
import { usePoolStats } from "@/hooks/usePoolStats";
import { useMarkets } from "@/hooks/useMarkets";
import { useRounds } from "@/hooks/useRounds";
import { Phase } from "@/lib/rounds";
import { contractsConfigured } from "@/lib/env";
import { formatAmount, formatApr, formatPercent } from "@/lib/format";
import { activeChain } from "@/lib/wagmi";

export default function DashboardPage() {
  const connection = useConnection();
  const position = useVaultPosition();

  return (
    <div className="flex min-h-screen">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <NetworkGuard />

        <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold">Overview</h1>
            <p className="text-xs text-ink-faint">{activeChain.name}</p>
          </div>
          <ConnectButton />
        </header>

        <main className="flex-1 p-6">
          {connection.status === "disconnected" ? (
            <Disconnected />
          ) : !contractsConfigured ? (
            <NotDeployed />
          ) : position.isError ? (
            <ReadFailed onRetry={() => position.refetch()} />
          ) : (
            <Position position={position} />
          )}
        </main>
      </div>
    </div>
  );
}

function Position({ position }: { position: ReturnType<typeof useVaultPosition> }) {
  const { decimals, symbol } = position;

  // Undefined until decimals are known: formatting against a guessed scale
  // produces a plausible number that is wrong by orders of magnitude.
  const amount = (value: bigint | undefined) =>
    value === undefined || decimals === undefined
      ? undefined
      : formatAmount(value, decimals);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* The pipeline leads, because the relationship between the three
          numbers is the product. Health factor follows as the detail behind
          the middle step. */}
      <div className="lg:col-span-3">
        <PipelineStrip position={position} />
      </div>

      <div className="lg:col-span-2">
        <HealthFactorCard
          value={position.healthFactor}
          liquidatable={position.isLiquidatable}
        />
      </div>

      <Stat label="Collateral value" hint="capped at redeemable">
        <PendingFigure value={amount(position.collateralValue)} unit={symbol} />
      </Stat>

      <Stat label="Accrued yield" hint="since last checkpoint">
        <PendingFigure value={amount(position.accruedYield)} unit={symbol} tone="positive" />
      </Stat>

      {/* Accounting parentheses: a claim against the position, not a
          balance it holds. */}
      <Stat label="Debt" hint="principal + interest">
        {position.lien === undefined || decimals === undefined ? (
          <Skeleton />
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

      <Stat label="Still borrowable" hint="to the LTV ceiling">
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
function PipelineStrip({ position }: { position: ReturnType<typeof useVaultPosition> }) {
  // Every market, not just the listed ones: a position in a market the owner
  // has since delisted is still the user's money at risk, and leaving it out
  // of this summary would understate what is at stake.
  const { markets } = useMarkets();
  const { rounds } = useRounds(markets);

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
      accrued={position.accruedYield}
      borrowed={position.lien}
      healthFactor={position.healthFactor}
      liquidatable={position.isLiquidatable}
      atRiskInMarkets={atRisk}
      openPositions={open}
      decimals={position.decimals!}
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
  const pool = usePoolStats();

  const amount = (value: bigint | undefined) =>
    value === undefined || decimals === undefined ? undefined : formatAmount(value, decimals);

  return (
    <section aria-labelledby="pool-heading" className="mt-2">
      <div className="mb-3 flex items-center gap-3">
        <h2
          id="pool-heading"
          className="text-xs font-medium tracking-wide text-ink-muted uppercase"
        >
          Lending pool
        </h2>
        <span className="h-px flex-1 bg-border" />
        {/* The way in. These figures described a pool nobody outside the seed
            script could join until GHO-39. */}
        <Link
          href="/lend"
          className="text-xs text-ink-faint transition-colors hover:text-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          Supply into it →
        </Link>
      </div>

      {pool.isError ? (
        <Card>
          <p className="text-sm text-ink-muted">Pool figures are unavailable right now.</p>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Total supplied" hint="lender deposits">
            <PendingFigure value={amount(pool.totalSupplied)} unit={symbol} />
          </Stat>
          <Stat label="Total borrowed" hint="outstanding">
            <PendingFigure value={amount(pool.totalBorrowed)} unit={symbol} />
          </Stat>
          <Stat label="Utilization" hint="borrowed / supplied">
            <PendingFigure
              value={pool.utilization === undefined ? undefined : formatPercent(pool.utilization)}
              unit=""
            />
          </Stat>
          <Stat label="Borrow rate" hint="simple, annualised">
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
          <Stat label="Supply rate" hint="what lenders earn">
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
  if (value === undefined) return <Skeleton />;
  return <Figure value={value} unit={unit} size="stat" tone={tone} />;
}

function Skeleton() {
  return <div className="h-8 w-32 animate-pulse rounded bg-raised" />;
}

function Disconnected() {
  return (
    <Card className="mx-auto mt-16 max-w-md text-center">
      <h2 className="text-lg font-semibold">Connect a wallet</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">
        GhostStake reads your position straight from the chain. Connecting is
        read-only — nothing is signed, and no transaction is proposed.
      </p>
      <div className="mt-5 flex justify-center">
        <ConnectButton />
      </div>
    </Card>
  );
}

/**
 * Distinct from an empty position: with no contract to read, zeroes would be
 * indistinguishable from a real position holding nothing.
 */
function NotDeployed() {
  return (
    <Card className="mx-auto mt-16 max-w-md text-center">
      <h2 className="text-lg font-semibold">Contracts not configured</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">
        No addresses are set for {activeChain.name}. Set{" "}
        <code className="text-ink">NEXT_PUBLIC_VAULT_ADDRESS</code> and{" "}
        <code className="text-ink">NEXT_PUBLIC_POOL_ADDRESS</code> once GHO-21
        has deployed.
      </p>
    </Card>
  );
}

function ReadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <Card className="mx-auto mt-16 max-w-md text-center">
      <h2 className="text-lg font-semibold text-warning">Could not read your position</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">
        The RPC call failed. Your position is unchanged — this screen just
        cannot see it right now.
      </p>
      <button
        onClick={onRetry}
        className="mt-5 rounded-full border border-border px-4 py-2 text-sm text-ink transition hover:border-border-strong"
      >
        Try again
      </button>
    </Card>
  );
}
