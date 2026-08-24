"use client";

import { formatAmount } from "@/lib/format";
import {
  Phase,
  Side,
  Status,
  entryClosesAt,
  entryOpen,
  formatCountdown,
  multipleFor,
  phaseLabel,
  willVoidOnLock,
  type PhaseValue,
  type Round,
  type SideValue,
} from "@/lib/rounds";

/**
 * One round, with what it is doing right now.
 *
 * The countdown runs to whichever deadline actually matters at this phase —
 * entry closing, then the close, then nothing — rather than always to the
 * lock. A clock counting toward a moment the user cannot act on is decoration.
 */
export function RoundCard({
  id,
  round,
  phase,
  entryCutoff,
  minSidePool,
  rake,
  decimals,
  symbol,
  now,
  yourUp,
  yourDown,
  onStake,
  children,
}: {
  id: bigint;
  round: Round;
  phase: PhaseValue;
  entryCutoff: bigint;
  minSidePool: bigint;
  rake: bigint;
  decimals: number;
  symbol: string;
  now: bigint | undefined;
  yourUp?: bigint;
  yourDown?: bigint;
  onStake?: (side: SideValue) => void;
  children?: React.ReactNode;
}) {
  const canEnter = now !== undefined && entryOpen(round, entryCutoff, now);
  const closesAt = entryClosesAt(round, entryCutoff);

  // Which deadline the clock should be counting to, by phase.
  const deadline =
    phase === Phase.Open ? closesAt : phase === Phase.Cutoff ? round.lockTime : round.closeTime;
  const remaining = now === undefined ? undefined : deadline - now;
  const live = phase === Phase.Open || phase === Phase.Cutoff || phase === Phase.Observation;

  const thin = willVoidOnLock(round, minSidePool);
  const youAreIn = (yourUp ?? 0n) > 0n || (yourDown ?? 0n) > 0n;

  return (
    <article className="rounded-card border border-border bg-surface p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-ink">Round {id.toString()}</span>
          <PhaseChip phase={phase} />
          {youAreIn && (
            <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent">
              You&rsquo;re in
            </span>
          )}
        </div>

        {live && remaining !== undefined && (
          <div className="flex items-baseline gap-2">
            <span className="text-xs text-ink-faint">
              {phase === Phase.Open
                ? "entry closes in"
                : phase === Phase.Cutoff
                  ? "locks in"
                  : "settles in"}
            </span>
            <span className="tabular text-sm font-medium text-ink">
              {formatCountdown(remaining)}
            </span>
          </div>
        )}
      </header>

      {/* The strike, once there is one. Before the lock there is nothing to
          show and inventing a placeholder would imply the round is already
          measuring something. */}
      {round.status !== Status.Open && round.lockPrice > 0n && (
        <p className="mt-3 text-xs text-ink-muted">
          Strike{" "}
          <span className="tabular text-ink">{formatAmount(round.lockPrice, 18, 2)}</span>
          {round.closePrice > 0n && (
            <>
              {" → close "}
              <span className="tabular text-ink">{formatAmount(round.closePrice, 18, 2)}</span>
            </>
          )}
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <SideBlock
          side={Side.Up}
          round={round}
          rake={rake}
          decimals={decimals}
          symbol={symbol}
          yours={yourUp}
          won={round.status === Status.Resolved && round.winner === Side.Up}
          lost={round.status === Status.Resolved && round.winner !== Side.Up}
          canEnter={canEnter}
          onStake={onStake}
        />
        <SideBlock
          side={Side.Down}
          round={round}
          rake={rake}
          decimals={decimals}
          symbol={symbol}
          yours={yourDown}
          won={round.status === Status.Resolved && round.winner === Side.Down}
          lost={round.status === Status.Resolved && round.winner !== Side.Down}
          canEnter={canEnter}
          onStake={onStake}
        />
      </div>

      {/* Said before someone joins the heavier side, not after. A round that
          voids refunds everyone, so this is a "nothing will happen" warning
          rather than a risk warning. */}
      {thin && round.status === Status.Open && (
        <p className="mt-3 text-xs text-warning">
          One side is still under the minimum. If it stays that way the round voids at lock and
          every stake is refunded.
        </p>
      )}

      {phase === Phase.Cutoff && (
        <p className="mt-3 text-xs text-ink-muted">
          Entry closed {entryCutoff.toString()}s before the lock, so nobody can react to the
          strike being taken.
        </p>
      )}

      {children}
    </article>
  );
}

function PhaseChip({ phase }: { phase: PhaseValue }) {
  const style =
    phase === Phase.Open
      ? "bg-positive-soft text-positive"
      : phase === Phase.Cutoff
        ? "bg-warning-soft text-warning"
        : phase === Phase.Observation
          ? "bg-accent-soft text-accent"
          : phase === Phase.Void
            ? "bg-raised text-ink-muted"
            : "bg-raised text-ink-muted";

  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}>
      {phaseLabel(phase)}
    </span>
  );
}

function SideBlock({
  side,
  round,
  rake,
  decimals,
  symbol,
  yours,
  won,
  lost,
  canEnter,
  onStake,
}: {
  side: SideValue;
  round: Round;
  rake: bigint;
  decimals: number;
  symbol: string;
  yours: bigint | undefined;
  won: boolean;
  lost: boolean;
  canEnter: boolean;
  onStake?: (side: SideValue) => void;
}) {
  const pool = side === Side.Up ? round.upPool : round.downPool;
  const multiple = multipleFor(round, side, rake);
  const isUp = side === Side.Up;

  // A settled round marks the winning side and leaves the other plain. The
  // losing side is not coloured red: the outcome is already stated, and
  // painting a loss is a nudge, not information.
  const border = won ? "border-positive/50" : "border-border";

  return (
    <div className={`rounded-xl border bg-raised/40 p-4 ${border}`}>
      <div className="flex items-center justify-between">
        <span className={`text-sm font-medium ${isUp ? "text-positive" : "text-negative"}`}>
          {isUp ? "Up" : "Down"}
        </span>
        {won && <span className="text-xs font-medium text-positive">Won</span>}
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className="tabular text-lg font-medium text-ink">
          {multiple === null ? "—" : `${formatAmount(multiple, 18, 2)}×`}
        </span>
        <span className="text-xs text-ink-faint">if it wins</span>
      </div>

      <p className="mt-1 text-xs text-ink-muted">
        <span className="tabular">{formatAmount(pool, decimals, 2)}</span> {symbol} staked
      </p>

      {yours !== undefined && yours > 0n && (
        <p className="mt-2 text-xs text-ink">
          Yours <span className="tabular">{formatAmount(yours, decimals, 2)}</span> {symbol}
        </p>
      )}

      {canEnter && onStake && (
        <button
          onClick={() => onStake(side)}
          className="mt-3 w-full cursor-pointer rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-border-strong hover:bg-raised focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          Take {isUp ? "Up" : "Down"}
        </button>
      )}

      {/* Deliberately silent when a stake lost. The round result is stated
          once, at the top; repeating it per side is piling on. */}
      {lost && null}
    </div>
  );
}
