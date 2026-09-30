"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Phase } from "@/lib/rounds";
import { useFormat } from "@/i18n/useFormat";
import { useMarkets } from "@/hooks/useMarkets";
import { useRounds } from "@/hooks/useRounds";
import { useVaultPosition } from "@/hooks/useVaultPosition";
import { useWallet } from "@/hooks/useWallet";

/**
 * What your money is doing, above the questions it could answer (GHO-78).
 *
 * This is the one thing a prediction market structurally cannot render: the
 * same capital doing two jobs. A stake here is earning yield *and* backing
 * whatever is riding on open rounds, and that sentence is the entire reason
 * this protocol exists rather than being a thinner Polymarket.
 *
 * One bar, because it is one pot. The filled head is what is committed to
 * open questions; the tail is free. Both halves earn the whole time.
 *
 * It degrades rather than disappearing: no wallet gets the sentence without
 * the figures, because the claim is about the product, not about you. What it
 * never does is show a figure it does not have — every number here is either
 * read or absent (GHO-86).
 */
export function MoneyStrip() {
  const { formatAmount, formatHealthFactor, formatPercent } = useFormat();
  const t = useTranslations("moneyStrip");
  const wallet = useWallet();
  const position = useVaultPosition();
  const { markets } = useMarkets();
  const { rounds } = useRounds(markets);

  if (!wallet.isConnected) {
    return (
      <section className="rounded-card border border-border bg-surface p-4">
        <p className="text-sm leading-relaxed text-ink-muted">{t("pitch")}</p>
        <Link
          href="/how-it-works"
          className="mt-2 inline-block text-xs text-ink-faint underline-offset-2 hover:text-ink-muted hover:underline"
        >
          {t("howItWorks")}
        </Link>
      </section>
    );
  }

  const { decimals, symbol } = position;

  // What is riding on questions that have not settled. Only live rounds: a
  // settled one is history and belongs in the portfolio, not in "at stake".
  let atRisk = 0n;
  let open = 0;
  for (const r of rounds) {
    const mine = (r.up ?? 0n) + (r.down ?? 0n);
    if (mine === 0n) continue;
    if (r.phase !== Phase.Resolved && r.phase !== Phase.Void) {
      atRisk += mine;
      open += 1;
    }
  }

  const staked = position.collateralValue;
  const committed =
    staked === undefined || staked === 0n
      ? 0
      : Math.min(100, Number((atRisk * 100n) / staked));

  return (
    <section className="rounded-card border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="tabular text-3xl text-ink">
          {decimals === undefined || staked === undefined ? "…" : formatAmount(staked, decimals, 2)}
        </span>
        <span className="text-xs text-ink-muted">{t("staked", { symbol })}</span>
      </div>

      {/* The committed head of one pot, not two bars: the money is not split,
          it is doing both jobs at once. */}
      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-raised">
        <div className="h-full bg-up" style={{ width: `${committed}%` }} />
      </div>

      <p className="mt-2.5 text-sm leading-relaxed text-ink-muted">
        {decimals === undefined
          ? t("reading")
          : atRisk === 0n
            ? t("nothingRiding")
            : position.yieldRatePerSecond === undefined
              ? t.rich("riding", { amount: formatAmount(atRisk, decimals, 2), count: open, figure: (chunks) => <span className="tabular text-ink">{chunks}</span> })
              : t.rich("ridingEarning", {
                  amount: formatAmount(atRisk, decimals, 2),
                  count: open,
                  rate: formatPercent(annualised(position.yieldRatePerSecond)),
                  figure: (chunks) => <span className="tabular text-ink">{chunks}</span>,
                })}
      </p>

      {position.healthFactor !== undefined && position.lien !== undefined && position.lien > 0n && (
        <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
          <span className="text-xs text-ink-muted">{t("safety")}</span>
          <span className={`tabular text-sm ${position.isLiquidatable ? "text-negative" : "text-up"}`}>
            {formatHealthFactor(position.healthFactor) ?? "—"}
          </span>
          <span className="text-xs text-ink-faint">{t("liquidatedBelow")}</span>
        </div>
      )}
    </section>
  );
}

/** Per-second WAD rate to a yearly one, which is the only rate anybody says. */
function annualised(perSecond: bigint): bigint {
  return perSecond * 31_536_000n;
}
