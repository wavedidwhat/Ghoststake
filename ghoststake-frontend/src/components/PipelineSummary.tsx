"use client";

import Link from "next/link";
import { Figure } from "./Figure";
import { formatAmount, formatApr, formatHealthFactor, healthBand } from "@/lib/format";
import type { StakeStanding } from "@/lib/stake";

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
  standing,
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
  /** Ledger against redeemable. See lib/stake.ts. */
  standing: StakeStanding | undefined;
  /** `accruedYield` — pending since the last checkpoint. */
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
          // `staked` is `collateralValue`, which is already capped at what the
          // shares can redeem. Captioning it "+11.5596 earned" therefore said
          // two wrong things at once: that the yield was money, and that it
          // was money on top of the figure above — when the figure above is
          // the whole of what can be withdrawn. See GHO-55.
          caption={stakeCaption(standing, accrued, decimals)}
          captionTone={standing && !standing.backed ? "warning" : undefined}
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

      {/* Said once, properly, where people actually read — the health panel's
          "capped at redeemable" was already honest and is further down the
          page. The rate is named here too: 11.71 moving at four decimals
          reads as volatile until you know it is 5% APR on 21,000, which is
          2.88 a day. */}
      {standing && !standing.backed && (
        <p className="mt-5 rounded-xl border border-warning/30 bg-warning-soft/40 px-4 py-3 text-xs leading-relaxed text-ink-muted">
          Your ledger credits{" "}
          <span className="tabular text-ink">
            {formatAmount(standing.unbacked, decimals, 4)} {symbol}
          </span>{" "}
          of yield{yieldRate !== undefined && <> at {formatApr(yieldRate)}</>}. Nothing funds it
          yet, so it is not withdrawable and does not count as collateral — the{" "}
          <span className="tabular text-ink">
            {formatAmount(standing.redeemable, decimals, 2)} {symbol}
          </span>{" "}
          above is what the vault can actually redeem today.
        </p>
      )}

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

/**
 * What to say under the staked figure.
 *
 * Three states, and the middle one is the whole issue: a ledger crediting
 * yield that no assets stand behind is not "earned", and it is not "not yet"
 * either — nothing is scheduled to fund it. It is credited, and that is the
 * word for it.
 */
function stakeCaption(
  standing: StakeStanding | undefined,
  accrued: bigint | undefined,
  decimals: number,
): string {
  if (standing === undefined) return "earning, and still yours";
  if (!standing.backed) {
    return `+${formatAmount(standing.unbacked, decimals, 4)} credited, not redeemable`;
  }
  // Only reached once the ledger is covered, which is the one situation where
  // "earned" is the right word — the shares can redeem all of it. That is not
  // true of any deployment so far, and this branch is written for the vault
  // being funded rather than pretending it already is.
  return accrued !== undefined && accrued > 0n
    ? `+${formatAmount(accrued, decimals, 4)} earned`
    : "earning, and still yours";
}

function Step({
  label,
  value,
  decimals,
  symbol,
  caption,
  captionTone,
  href,
  muted,
}: {
  label: string;
  value: bigint | undefined;
  decimals: number;
  symbol: string;
  caption: string;
  captionTone?: "warning";
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
      <span className={`text-xs ${captionTone === "warning" ? "text-warning" : "text-ink-faint"}`}>
        {caption}
      </span>
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
