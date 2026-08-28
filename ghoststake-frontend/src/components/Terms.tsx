"use client";

import { useMarketFeeds } from "@/hooks/useMarketFeeds";
import { useLendingTerms, useRoundTerms } from "@/hooks/useTerms";
import {
  formatAmount,
  formatApr,
  formatDuration,
  formatPercent,
  shortenAddress,
} from "@/lib/format";
import type { Market } from "@/lib/markets";

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
/**
 * Formats a term, or undefined while it is still loading.
 *
 * Explicitly rather than `value && format(value)`, which evaluates to `0n` for
 * a zero-valued term and renders a raw bigint. Zero is a legitimate setting
 * for several of these — a market may be listed with no rake, and a vault may
 * be deployed with no liquidation bonus — so "falsy" and "not loaded yet" are
 * genuinely different questions here.
 */
function shown(value: bigint | undefined, format: (v: bigint) => string): string | undefined {
  return value === undefined ? undefined : format(value);
}

export function Terms({
  markets,
  decimals,
  symbol,
}: {
  markets: Market[];
  decimals: number | undefined;
  symbol: string;
}) {
  const lending = useLendingTerms();

  return (
    <section aria-labelledby="terms-heading" className="mt-2">
      <div className="mb-3 flex items-center gap-3">
        <h2 id="terms-heading" className="text-xs font-medium tracking-wide text-ink-muted uppercase">
          Terms
        </h2>
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs text-ink-faint">read from the contracts</span>
      </div>

      {lending.isError ? (
        <p className="rounded-card border border-border bg-surface p-5 text-sm text-ink-muted">
          The contract terms are unavailable right now.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <Group title="Staking">
            <Term
              name="Yield rate"
              value={shown(lending.yieldRatePerSecond, formatApr)}
            >
              Simple, not compounding — yield never folds back into the earning
              base, so what you earn is a function of stake and time and nothing
              else.
            </Term>
            <Term name="Withdrawals" value="anytime">
              Staking is not locked. A withdrawal is limited only by what your
              debt allows: enough collateral has to stay to keep the position
              above the liquidation threshold.
            </Term>
          </Group>

          <Group title="Borrowing">
            <Term name="Max LTV" value={shown(lending.maxLTV, formatPercent)}>
              The most you may borrow against your stake. A borrow that would
              cross this is refused rather than allowed and then liquidated.
            </Term>
            <Term
              name="Liquidation threshold"
              value={shown(lending.liquidationThreshold, formatPercent)}
            >
              {lending.maxLTV && lending.liquidationThreshold ? (
                <>
                  Where the health factor reaches 1.00 and liquidation becomes
                  possible. The{" "}
                  <span className="tabular text-ink">
                    {formatPercent(lending.liquidationThreshold - lending.maxLTV)}
                  </span>{" "}
                  gap above the LTV ceiling is deliberate: it is the room a
                  position has to accrue interest before anyone can touch it.
                </>
              ) : (
                "Where the health factor reaches 1.00 and liquidation becomes possible."
              )}
            </Term>
            <Term
              name="Utilization kink"
              value={shown(lending.kink, formatPercent)}
            >
              Where the borrow rate stops rising gently and starts rising
              steeply, so lenders are paid to refill a pool that is running dry.
            </Term>
          </Group>

          <Group title="If you are liquidated">
            <Term
              name="Close factor"
              value={shown(lending.closeFactor, formatPercent)}
            >
              The most of your debt one liquidation may clear. It caps what a
              single price dip costs you — the rest of the position survives it.
            </Term>
            <Term
              name="Liquidator bonus"
              value={shown(lending.liquidationBonus, formatPercent)}
            >
              The discount a liquidator takes on the collateral they seize, paid
              out of your position. It is what makes anyone show up to close an
              underwater loan, which is what keeps the pool solvent.
            </Term>
            <Term
              name="Full liquidation below"
              value={shown(lending.fullLiquidationThreshold, formatHealthLine)}
            >
              Below this health factor the close-factor cap is lifted and the
              whole lien may be cleared at once. It is derived on chain from the
              threshold and the bonus, not configured — it is precisely the
              point where a capped liquidation stops making a position healthier.
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
  const { terms } = useRoundTerms(markets);
  const feeds = useMarketFeeds(markets);

  if (markets.length === 0) return null;

  return (
    <div className="mt-4 rounded-card border border-border bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-ink">Taking a position</h3>
        <p className="text-xs text-ink-faint">
          Odds come from how the pool splits, so the protocol never takes the
          other side of your view.
        </p>
      </div>

      {/* Scrolls in its own box rather than pushing the page sideways. */}
      <div className="mt-4 -mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="text-left text-xs tracking-wide text-ink-muted uppercase">
              <th className="pb-2 font-medium">Market</th>
              <th className="pb-2 font-medium">Rake</th>
              <th className="pb-2 font-medium">Entry closes</th>
              <th className="pb-2 font-medium">Min per side</th>
            </tr>
          </thead>
          <tbody>
            {terms.map((t, i) => (
              <tr key={t.market} className="border-t border-border">
                {/* The feed's own description, falling back to the address.
                    Never a hardcoded label: the registry stores none, and a
                    copy of a name can disagree with the thing it names. */}
                <td className="py-2 pr-4 text-ink">
                  {feeds.byMarket.get(markets[i].key)?.description || shortenAddress(t.market)}
                </td>
                <td className="tabular py-2 pr-4 text-ink-muted">
                  {t.rake === undefined ? "—" : formatPercent(t.rake)}
                </td>
                <td className="tabular py-2 pr-4 text-ink-muted">
                  {t.entryCutoff === undefined
                    ? "—"
                    : `${formatDuration(t.entryCutoff)} before lock`}
                </td>
                <td className="tabular py-2 text-ink-muted">
                  {t.minSidePool === undefined || decimals === undefined
                    ? "—"
                    : `${formatAmount(t.minSidePool, decimals, 2)} ${symbol}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="mt-4 grid gap-3 text-xs leading-relaxed text-ink-muted sm:grid-cols-3">
        <div>
          <dt className="font-medium text-ink">Rake</dt>
          <dd>
            Taken from the losing pool at settlement, so it is already inside
            the odds you were shown rather than deducted from a win afterwards.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-ink">Entry cutoff</dt>
          <dd>
            Entry closes before the round locks so nobody can take a side in the
            last second against a price they can already see moving.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-ink">Minimum per side</dt>
          <dd>
            A round whose losing side never reaches this is voided and every
            stake is refunded in full — a one-sided pool has nothing to pay a
            winner from.
          </dd>
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

function Group({ title, children }: { title: string; children: React.ReactNode }) {
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
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-xs font-medium tracking-wide text-ink-muted uppercase">{name}</dt>
        {value === undefined ? (
          <span className="h-4 w-12 animate-pulse rounded bg-raised" />
        ) : (
          <span className="tabular text-sm font-medium text-ink">{value}</span>
        )}
      </div>
      <dd className="mt-1 text-xs leading-relaxed text-ink-faint">{children}</dd>
    </div>
  );
}
