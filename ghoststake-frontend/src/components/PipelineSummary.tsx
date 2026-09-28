"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Figure } from "@/components/ui/Figure";
import { formatAmount, formatApr, formatHealthFactor, healthBand } from "@/lib/format";
import type { StakeStanding } from "@/lib/stake";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Skeleton } from "@/components/ui/Skeleton";

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
  const t = useTranslations("pipeline");
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
        <h2 className="text-sm font-medium text-ink">{t("heading")}</h2>
        {yieldRate !== undefined && (
          <span className="text-xs text-ink-faint">
            {t.rich("earns", {
              rate: formatApr(yieldRate),
              figure: (chunks) => <span className="tabular text-positive">{chunks}</span>,
            })}
          </span>
        )}
      </div>

      {/* Three steps in the order they happen. The arrows carry the argument:
          nothing is sold, nothing is unwound. */}
      <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_auto_1fr_auto_1fr]">
        <Step
          label={t("staked")}
          value={staked}
          decimals={decimals}
          symbol={symbol}
          // `staked` is `collateralValue`, which is already capped at what the
          // shares can redeem. Captioning it "+11.5596 earned" therefore said
          // two wrong things at once: that the yield was money, and that it
          // was money on top of the figure above — when the figure above is
          // the whole of what can be withdrawn. See GHO-55.
          caption={captionText(t, stakeCaption(standing, accrued, decimals))}
          captionTone={standing && !standing.backed ? "warning" : undefined}
          href="/stake"
        />

        <Arrow />

        <Step
          label={t("borrowed")}
          value={borrowed}
          decimals={decimals}
          symbol={symbol}
          caption={hasDebt ? t("borrowedCaption") : t("borrowedNone")}
          href="/borrow"
          muted={!hasDebt}
        />

        <Arrow />

        <Step
          label={t("working")}
          value={atRiskInMarkets}
          decimals={decimals}
          symbol={symbol}
          caption={t("openPositions", { count: openPositions })}
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
        <p className="mt-5 rounded-sm border border-warning/30 bg-warning-soft/40 px-4 py-3 text-xs leading-relaxed text-ink-muted">
          {t.rich(yieldRate === undefined ? "unbacked" : "unbackedAt", {
            credited: formatAmount(standing.unbacked, decimals, 4),
            redeemable: formatAmount(standing.redeemable, decimals, 2),
            rate: yieldRate === undefined ? "" : formatApr(yieldRate),
            symbol,
            figure: (chunks) => <span className="tabular text-ink">{chunks}</span>,
          })}
        </p>
      )}

      {/* The consequence, stated plainly. A position funded by debt does not
          become someone else's problem when it loses. */}
      {hasDebt && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-sm border border-border bg-raised/40 px-4 py-3">
          <p className="text-xs text-ink-muted">
            {atRiskInMarkets > 0n
              ? t.rich("ifTheyLose", {
                  amount: formatAmount(borrowed!, decimals, 2),
                  symbol,
                  figure: (chunks) => <span className="tabular text-ink">{chunks}</span>,
                })
              : t("interestAccrues")}
          </p>
          <span className="flex items-baseline gap-2 whitespace-nowrap">
            <span className="text-xs text-ink-faint">{t("healthFactor")}</span>
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
): Caption {
  if (standing === undefined) return { key: "captionEarning" };
  if (!standing.backed) {
    return { key: "captionCredited", amount: formatAmount(standing.unbacked, decimals, 4) };
  }
  // Only reached once the ledger is covered, which is the one situation where
  // "earned" is the right word — the shares can redeem all of it. That is not
  // true of any deployment so far, and this branch is written for the vault
  // being funded rather than pretending it already is.
  return accrued !== undefined && accrued > 0n
    ? { key: "captionEarned", amount: formatAmount(accrued, decimals, 4) }
    : { key: "captionEarning" };
}

type Caption = { key: "captionEarning" } | { key: "captionCredited" | "captionEarned"; amount: string };

function captionText(t: (key: Caption["key"], values?: { amount: string }) => string, caption: Caption): string {
  return caption.key === "captionEarning" ? t(caption.key) : t(caption.key, { amount: caption.amount });
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
      className="group flex flex-col gap-1 rounded-sm border border-border bg-raised/30 p-4 transition-colors hover:border-border-strong hover:bg-raised/60 focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
    >
      <Eyebrow as="span">{label}</Eyebrow>
      {value === undefined ? (
        <Skeleton className="h-7 w-24" />
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
