"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { ConnectButton } from "@/components/ConnectButton";
import { useLendingTerms } from "@/hooks/useTerms";
import { formatApr, formatOptional, formatPercent } from "@/lib/format";
import { Skeleton } from "@/components/ui/Skeleton";
import { buttonClass } from "@/components/ui/Button";

/**
 * What GhostStake is, for someone who has nothing.
 *
 * Before this, a first visitor met "Connect a wallet" and a sidebar. Nowhere
 * in the app did it say what the product does — and the mechanism is the
 * unusual part, so an app that asks for a wallet before explaining it is
 * asking for a commitment to something it has not described.
 *
 * The three steps are the pitch and the argument at once: the stake never
 * leaves, the position is funded by a lien against it, and the debt survives
 * the position losing. That last sentence is the one most likely to be skipped
 * and the one most worth saying — a protocol that only advertised the upside
 * would be describing a different product.
 *
 * The figures are read from the contracts, not written here. Same argument as
 * GHO-30: a landing page quoting a yield the vault does not pay is the worst
 * possible place for that particular bug.
 */
export function Landing() {
  const t = useTranslations("landing");
  const terms = useLendingTerms();

  return (
    <div className="mx-auto mt-10 flex max-w-3xl flex-col gap-8">
      <section className="text-center">
        <h2 className="text-2xl font-semibold text-ink">{t("headline")}</h2>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-ink-muted">{t("lede")}</p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <ConnectButton />
          <Link
            href="/"
            className={buttonClass({ variant: "outline" })}
          >
            {t("browseFirst")}
          </Link>
        </div>
        <p className="mt-3 text-xs text-ink-faint">{t("readOnly")}</p>
      </section>

      {/* The pipeline, in the order it runs. Same order as the sidebar and the
          same order as the summary a connected user sees, because the order is
          the product rather than a layout choice. */}
      <section className="grid gap-3 sm:grid-cols-3">
        <Step
          n={1}
          title={t("stake.title")}
          figure={formatOptional(terms.yieldRatePerSecond, formatApr)}
          figureLabel={t("stake.figureLabel")}
        >
          {t("stake.body")}
        </Step>
        <Step
          n={2}
          title={t("borrow.title")}
          figure={formatOptional(terms.maxLTV, (v) => formatPercent(v, 0))}
          figureLabel={t("borrow.figureLabel")}
        >
          {t("borrow.body")}
        </Step>
        <Step
          n={3}
          title={t("view.title")}
          figure={t("view.figure")}
          figureLabel={t("view.figureLabel")}
        >
          {t("view.body")}
        </Step>
      </section>

      {/* Not optional, and not in smaller type than the rest. */}
      <section className="rounded-card border border-border bg-surface p-6">
        <h3 className="text-sm font-medium text-ink">{t("risks.heading")}</h3>
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink-muted">
          <li>{t.rich("risks.debtStands", { lead: (chunks: ReactNode) => <span className="text-ink">{chunks}</span> })}</li>
          <li>{t.rich("risks.interest", { lead: (chunks: ReactNode) => <span className="text-ink">{chunks}</span> })}</li>
          <li>
            {terms.liquidationBonus !== undefined
              ? t.rich("risks.liquidationBonus", {
                  bonus: formatPercent(terms.liquidationBonus, 0),
                  lead: (chunks: ReactNode) => <span className="text-ink">{chunks}</span>,
                })
              : t.rich("risks.liquidation", { lead: (chunks: ReactNode) => <span className="text-ink">{chunks}</span> })}
          </li>
          <li>{t.rich("risks.voided", { lead: (chunks: ReactNode) => <span className="text-ink">{chunks}</span> })}</li>
        </ul>
      </section>

      <p className="text-center text-xs text-ink-faint">{t("testnet")}</p>
    </div>
  );
}

function Step({
  n,
  title,
  figure,
  figureLabel,
  children,
}: {
  n: number;
  title: string;
  figure: string | undefined;
  figureLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-card border border-border bg-surface p-5">
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-ink-faint">{n}</span>
        <h3 className="text-sm font-medium text-ink">{title}</h3>
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        {figure === undefined ? (
          <Skeleton className="h-6 w-16" />
        ) : (
          <span className="tabular text-lg font-medium text-brand">{figure}</span>
        )}
        <span className="text-[11px] text-ink-faint">{figureLabel}</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-muted">{children}</p>
    </div>
  );
}
