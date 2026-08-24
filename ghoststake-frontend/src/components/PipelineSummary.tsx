"use client";

import Link from "next/link";
import { Figure } from "./Figure";
import { formatAmount, formatApr, formatHealthFactor, healthBand } from "@/lib/format";

/**
 * The product, as one object.
 *
 * Stake, what it earns, what is borrowed against it, and what that debt is
 * funding — in a single reading order, because that order *is* the product.
 *
 * Before this, the health factor lived on one page and positions on another,
 * so the one relationship that makes GhostStake a pipeline rather than two
 * apps in a repository was rendered nowhere. A user could see they had debt
 * and could see they had a position, and nothing said the second was funded
 * by the first.
 */
export function PipelineSummary({
  staked,
  yieldRate,
  accrued,
  borrowed,
  healthFactor,
  liquidatable,
  atRiskInMarkets,
  openPositions,
  decimals,
  symbol,
}: {
  staked: bigint | undefined;
  yieldRate: bigint | undefined;
  accrued: bigint | undefined;
  borrowed: bigint | undefined;
  healthFactor: bigint | undefined;
  liquidatable: boolean | undefined;
  atRiskInMarkets: bigint;
  openPositions: number;
  decimals: number;
  symbol: string;
}) {
  const hasDebt = (borrowed ?? 0n) > 0n;
  const band = healthFactor === undefined ? "safe" : healthBand(healthFactor);
  const tone =
    liquidatable || band === "danger"
      ? "text-negative"
      : band === "caution"
        ? "text-warning"
        : "text-positive";

  return (
    <section className="rounded-card border border-border bg-surface p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-ink">Your pipeline</h2>
        {yieldRate !== undefined && (
          <span className="text-xs text-ink-faint">
            stake earns{" "}
            <span className="tabular text-positive">{formatApr(yieldRate)}</span> while it works
          </span>
        )}
      </div>

      {/* Three steps in the order they happen. The arrows carry the argument:
          nothing is sold, nothing is unwound. */}
      <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_auto_1fr_auto_1fr]">
        <Step
          label="Staked"
          value={staked}
          decimals={decimals}
          symbol={symbol}
          caption={
            accrued !== undefined && accrued > 0n
              ? `+${formatAmount(accrued, decimals, 4)} earned`
              : "earning, and still yours"
          }
          href="/stake"
        />

        <Arrow />

        <Step
          label="Borrowed against it"
          value={borrowed}
          decimals={decimals}
          symbol={symbol}
          caption={hasDebt ? "a lien, not a withdrawal" : "nothing drawn yet"}
          href="/borrow"
          muted={!hasDebt}
        />

        <Arrow />

        <Step
          label="Working in markets"
          value={atRiskInMarkets}
          decimals={decimals}
          symbol={symbol}
          caption={
            openPositions === 0
              ? "no open positions"
              : `${openPositions} open position${openPositions === 1 ? "" : "s"}`
          }
          href="/markets"
          muted={atRiskInMarkets === 0n}
        />
      </div>

      {/* The consequence, stated plainly. A position funded by debt does not
          become someone else's problem when it loses. */}
      {hasDebt && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-raised/40 px-4 py-3">
          <p className="text-xs text-ink-muted">
            {atRiskInMarkets > 0n ? (
              <>
                If these positions lose, the{" "}
                <span className="tabular text-ink">
                  {formatAmount(borrowed!, decimals, 2)} {symbol}
                </span>{" "}
                still stands and is settled from your stake.
              </>
            ) : (
              <>
                Interest accrues every second. Repay or add to your stake to build room.
              </>
            )}
          </p>
          <span className="flex items-baseline gap-2 whitespace-nowrap">
            <span className="text-xs text-ink-faint">health factor</span>
            <span className={`tabular text-base font-medium ${tone}`}>
              {healthFactor === undefined ? "—" : (formatHealthFactor(healthFactor) ?? "—")}
            </span>
          </span>
        </div>
      )}
    </section>
  );
}

function Step({
  label,
  value,
  decimals,
  symbol,
  caption,
  href,
  muted,
}: {
  label: string;
  value: bigint | undefined;
  decimals: number;
  symbol: string;
  caption: string;
  href: string;
  muted?: boolean;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-1 rounded-xl border border-border bg-raised/30 p-4 transition-colors hover:border-border-strong hover:bg-raised/60 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
    >
      <span className="text-xs font-medium tracking-wide text-ink-muted uppercase">{label}</span>
      {value === undefined ? (
        <div className="h-7 w-24 animate-pulse rounded bg-raised" />
      ) : (
        <Figure
          value={formatAmount(value, decimals, 2)}
          unit={symbol}
          size="stat"
          tone={muted ? "muted" : "default"}
        />
      )}
      <span className="text-xs text-ink-faint">{caption}</span>
    </Link>
  );
}

/** Horizontal on wide screens, hidden when the steps stack. */
function Arrow() {
  return (
    <span
      aria-hidden
      className="hidden items-center justify-center text-ink-faint lg:flex"
    >
      →
    </span>
  );
}
