"use client";

import { Card } from "@/components/Card";
import { useClaimAll } from "@/hooks/useClaimAll";
import { formatAmount } from "@/lib/format";
import {
  claimKey,
  collected,
  signaturesNeeded,
  summarise,
  totalClaimable,
  type Claimable,
} from "@/lib/claims";

/**
 * Everything claimable, in one place, behind one button (GHO-69).
 *
 * Before this, claiming lived per round inside a market's own page: somebody
 * who bet five rounds across two markets had to find each one to collect it,
 * and nothing anywhere added them up.
 *
 * The button is honest about what it costs. There is no batch claim on
 * `ParimutuelRound` — a payout is pull-based, per round, per market — so
 * "Claim all" is one button over N wallet prompts, and the count is stated
 * before anything is signed rather than discovered on the third modal.
 */
export function ClaimAllPanel({
  claims,
  address,
  decimals,
  symbol,
  onClaimed,
}: {
  claims: Claimable[];
  address: `0x${string}`;
  decimals?: number;
  symbol: string;
  onClaimed: () => void;
}) {
  const claimer = useClaimAll(address);
  const total = totalClaimable(claims);
  const run = summarise(claimer.outcomes);
  const amount = (value: bigint) =>
    decimals === undefined ? "…" : formatAmount(value, decimals, 2);

  if (claims.length === 0 && claimer.outcomes.length === 0) return null;

  return (
    <Card>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="display text-xs tracking-wide text-ink-faint uppercase">To claim</p>
          <p className="tabular mt-1 text-figure text-up">
            {amount(total)} <span className="text-base text-ink-faint">{symbol}</span>
          </p>
          <p className="mt-1 text-xs text-ink-muted">
            {claims.length === 0
              ? "Nothing left to collect."
              : `${claims.length} round${claims.length === 1 ? "" : "s"} · ${signaturesNeeded(claims.length)}`}
          </p>
        </div>

        {claims.length > 0 && (
          <button
            type="button"
            disabled={claimer.running}
            onClick={() => void claimer.run(claims).then(onClaimed)}
            className="pressable display min-h-12 cursor-pointer rounded-control bg-up px-5 py-3 text-base text-up-ink uppercase [--edge:var(--color-up-edge)] focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45"
          >
            {claimer.running
              ? `Claiming ${run.claimed + 1} of ${claimer.outcomes.length}…`
              : claims.length === 1
                ? "Claim"
                : "Claim all"}
          </button>
        )}
      </div>

      {/*
       * A payout is pull-based: it sits in the contract until someone
       * collects it. Said once, here, rather than on every round.
       */}
      <p className="mt-3 text-xs text-ink-faint">
        Winnings wait in the contract until they are collected. Any debt on the
        position is settled first; the rest reaches your wallet.
      </p>

      {claimer.outcomes.length > 0 && (
        <ul className="mt-4 divide-y divide-border/60 text-xs">
          {claimer.outcomes.map((outcome) => (
            <li
              key={claimKey(outcome.claim)}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <span className="text-ink-muted">
                Round {outcome.claim.roundId.toString()}
                <span className="tabular ml-2 text-ink">{amount(outcome.claim.amount)}</span>
              </span>

              <span>
                {outcome.state === "claimed" && <span className="text-positive">Claimed</span>}
                {outcome.state === "pending" && <span className="text-ink-faint">Waiting…</span>}
                {outcome.state === "cancelled" && (
                  <span className="text-ink-faint">Not signed</span>
                )}
                {/* A skip is not a failure, and saying so matters: the usual
                    cause is that the money was already collected. */}
                {outcome.state === "skipped" && (
                  <span className="text-warning">Skipped — {outcome.reason}</span>
                )}
                {outcome.state === "failed" && (
                  <span className="text-negative">Failed — {outcome.reason}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {!claimer.running && claimer.outcomes.length > 0 && (
        <p className="mt-3 text-xs text-ink-muted">
          Collected <span className="tabular text-positive">{amount(collected(claimer.outcomes))}</span>{" "}
          {symbol}
          {run.remaining > 0 && ` · ${run.remaining} left to sign`}
          {run.skipped > 0 && ` · ${run.skipped} skipped`}
          {run.failed > 0 && ` · ${run.failed} failed`}
        </p>
      )}
    </Card>
  );
}
