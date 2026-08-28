"use client";

import Link from "next/link";
import { ConnectButton } from "@/components/ConnectButton";
import { useLendingTerms } from "@/hooks/useTerms";
import { formatApr, formatOptional, formatPercent } from "@/lib/format";

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
  const terms = useLendingTerms();

  return (
    <div className="mx-auto mt-10 flex max-w-3xl flex-col gap-8">
      <section className="text-center">
        <h2 className="text-2xl font-semibold text-ink">
          Take a view without unwinding your savings.
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-ink-muted">
          Most ways of backing an opinion make you sell something first. Here your stake stays
          deposited and keeps earning, and the position is funded by borrowing against it.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <ConnectButton />
          <Link
            href="/markets"
            className="rounded-full border border-border px-4 py-2 text-sm text-ink transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            Browse markets first →
          </Link>
        </div>
        <p className="mt-3 text-xs text-ink-faint">
          Nothing here needs a wallet to read. Connecting is read-only — no transaction is
          proposed.
        </p>
      </section>

      {/* The pipeline, in the order it runs. Same order as the sidebar and the
          same order as the summary a connected user sees, because the order is
          the product rather than a layout choice. */}
      <section className="grid gap-3 sm:grid-cols-3">
        <Step
          n="1"
          title="Stake"
          figure={formatOptional(terms.yieldRatePerSecond, formatApr)}
          figureLabel="simple APR"
        >
          Deposit into the vault. It earns from the moment it lands, and it does not stop
          earning for anything that follows.
        </Step>
        <Step
          n="2"
          title="Borrow against it"
          figure={formatOptional(terms.maxLTV, (v) => formatPercent(v, 0))}
          figureLabel="max LTV"
        >
          Draw against the stake rather than withdrawing it. What you borrow is a lien on the
          position, so the collateral never leaves and never stops working.
        </Step>
        <Step
          n="3"
          title="Take a view"
          figure="parimutuel"
          figureLabel="no order book"
        >
          Stake a side of a market. Odds come from how the pool splits, so the protocol never
          takes the other side of your position.
        </Step>
      </section>

      {/* Not optional, and not in smaller type than the rest. */}
      <section className="rounded-card border border-border bg-surface p-6">
        <h3 className="text-sm font-medium text-ink">What happens when it goes against you</h3>
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink-muted">
          <li>
            <span className="text-ink">A losing round does not clear the debt.</span> The
            position was funded by a lien, and the lien stands whether the view was right or
            wrong. It is settled from your stake.
          </li>
          <li>
            <span className="text-ink">Interest accrues every second.</span> A position left
            open moves your health factor down on its own, with no price needing to move.
          </li>
          <li>
            <span className="text-ink">
              Below a health factor of 1.00 anyone may liquidate you
              {terms.liquidationBonus !== undefined && (
                <> and take {formatPercent(terms.liquidationBonus, 0)} of the collateral they
                seize</>
              )}
              .
            </span>{" "}
            That is what keeps the pool solvent, and it is paid out of your position.
          </li>
          <li>
            <span className="text-ink">A round can be voided.</span> If one side never fills,
            or the price feed cannot be read at settlement, the round refunds everybody in full
            rather than picking a winner.
          </li>
        </ul>
      </section>

      <p className="text-center text-xs text-ink-faint">
        Testnet. The asset is a mock token you can mint for free, and every rule above is
        enforced on chain — the exact figures are on the overview once you connect.
      </p>
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
  n: string;
  title: string;
  figure: string | undefined;
  figureLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-border bg-surface p-5">
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-ink-faint">{n}</span>
        <h3 className="text-sm font-medium text-ink">{title}</h3>
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        {figure === undefined ? (
          <span className="h-6 w-16 animate-pulse rounded bg-raised" />
        ) : (
          <span className="tabular text-lg font-medium text-accent">{figure}</span>
        )}
        <span className="text-[11px] text-ink-faint">{figureLabel}</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-muted">{children}</p>
    </div>
  );
}
