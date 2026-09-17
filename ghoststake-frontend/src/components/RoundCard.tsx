"use client";

import Link from "next/link";

import { formatAmount } from "@/lib/format";
import { SideArrow } from "@/components/icons";
import {
  Phase,
  Side,
  Status,
  entryClosesAt,
  entryOpen,
  formatCountdown,
  multipleFor,
  phaseLabel,
  upShare,
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
  href,
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
  /** Where this round lives on its own (GHO-41). Omitted on the round's own page. */
  href?: string;
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
    <article className="rounded-card border border-border bg-surface p-4">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* The round's permalink. A card and not a link before GHO-41,
              which meant the smallest shareable thing in the product — one
              round, one outcome — had no address at all. */}
          {href ? (
            <Link href={href} className="display text-base uppercase underline-offset-4 hover:underline">
              Round {id.toString()}
            </Link>
          ) : (
            <span className="display text-base uppercase">Round {id.toString()}</span>
          )}
          <PhaseChip phase={phase} />
          {youAreIn && (
            <span className="display rounded-control bg-brand-soft px-2 py-0.5 text-xs text-brand uppercase">
              You&rsquo;re in
            </span>
          )}
        </div>

        {/*
         * The countdown is the loudest thing in the header, and it fills with
         * the brand colour once entry is about to close. That is the one
         * moment urgency is real — after it, no amount of wanting to join
         * changes anything — so it is the one moment the app shows any.
         */}
        {live && remaining !== undefined && (
          <span
            className={`tabular rounded-control px-2.5 py-1 text-base ${
              phase === Phase.Cutoff
                ? "bg-brand text-brand-ink"
                : "bg-raised text-ink"
            }`}
            title={
              phase === Phase.Open
                ? "until entry closes"
                : phase === Phase.Cutoff
                  ? "until the start price is taken"
                  : "until it settles"
            }
          >
            {formatCountdown(remaining)}
          </span>
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

      <OddsBar round={round} decimals={decimals} symbol={symbol} />

      <div className="mt-3 grid grid-cols-2 gap-3">
        <SideButton
          side={Side.Up}
          round={round}
          rake={rake}
          yours={yourUp}
          decimals={decimals}
          symbol={symbol}
          won={round.status === Status.Resolved && round.winner === Side.Up}
          disabled={!canEnter}
          onStake={onStake}
        />
        <SideButton
          side={Side.Down}
          round={round}
          rake={rake}
          yours={yourDown}
          decimals={decimals}
          symbol={symbol}
          won={round.status === Status.Resolved && round.winner === Side.Down}
          disabled={!canEnter}
          onStake={onStake}
        />
      </div>

      {/* Said before someone joins the heavier side, not after. A round that
          voids refunds everyone, so this is a "nothing will happen" warning
          rather than a risk warning. */}
      {thin && round.status === Status.Open && (
        <p className="mt-3 text-xs text-warning">
          One side is still under the minimum. If it stays that way the round voids at lock and
          every position is refunded in full.
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
          ? "bg-brand-soft text-brand"
          : phase === Phase.Void
            ? "bg-raised text-ink-muted"
            : "bg-raised text-ink-muted";

  return (
    <span className={`rounded-sm px-2.5 py-0.5 text-xs font-medium ${style}`}>
      {phaseLabel(phase)}
    </span>
  );
}

/**
 * The split of the pool, as a bar (GHO-59 layout).
 *
 * This is the whole point of the card: where the split sits *is* the
 * information, and it reads before any figure does. A bar that is mostly
 * green says the crowd is on Up, which is also why Up pays less — the two
 * facts are the same fact, and putting them next to each other is the
 * cheapest explanation of parimutuel odds this app can give.
 *
 * Nothing is drawn when no money is in: an empty round has no split, and a
 * half-and-half bar would invent a crowd.
 */
function OddsBar({ round, decimals, symbol }: { round: Round; decimals: number; symbol: string }) {
  const share = upShare(round);
  if (share === null) {
    return (
      <p className="mt-3 text-xs text-ink-faint">
        Nothing staked yet — the first side in sets the odds.
      </p>
    );
  }

  const up = Math.round(share);
  const label = (n: number) => `${n}%`;

  return (
    <div className="mt-3">
      <div
        className="flex h-9 overflow-hidden rounded-control bg-raised"
        role="img"
        aria-label={`${label(up)} of the pool is on Up, ${label(100 - up)} on Down`}
      >
        {/* Each side is at least wide enough to hold its own label, so a
            lopsided round still says which way it is lopsided. */}
        <div
          className="display flex min-w-16 items-center gap-1.5 bg-up px-2.5 text-sm text-up-ink"
          style={{ width: `${share}%` }}
        >
          <SideArrow up className="size-2.5" />
          {label(up)}
        </div>
        <div className="display flex min-w-16 flex-1 items-center justify-end gap-1.5 bg-down px-2.5 text-sm text-down-ink">
          {label(100 - up)}
          <SideArrow up={false} className="size-2.5" />
        </div>
      </div>

      <div className="tabular mt-1.5 flex justify-between text-xs text-ink-faint">
        <span>
          {formatAmount(round.upPool, decimals, 2)} {symbol} up
        </span>
        <span>
          {formatAmount(round.downPool, decimals, 2)} {symbol} down
        </span>
      </div>
    </div>
  );
}

/**
 * One side, as a button you press (GHO-59 layout).
 *
 * The multiple lives on the button rather than beside it, because it is what
 * the press is worth: "Up, pays 1.84×" is one thought. The 4px solid edge
 * underneath is the only depth in the design and the only thing saying
 * "pressable" — no gradient, no glow, no blur.
 */
function SideButton({
  side,
  round,
  rake,
  yours,
  decimals,
  symbol,
  won,
  disabled,
  onStake,
}: {
  side: SideValue;
  round: Round;
  rake: bigint;
  yours: bigint | undefined;
  decimals: number;
  symbol: string;
  won: boolean;
  disabled: boolean;
  onStake?: (side: SideValue) => void;
}) {
  const isUp = side === Side.Up;
  const multiple = multipleFor(round, side, rake);
  const mine = yours !== undefined && yours > 0n;

  const tone = isUp
    ? "bg-up text-up-ink [--edge:var(--color-up-edge)]"
    : "bg-down text-down-ink [--edge:var(--color-down-edge)]";

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onStake ? () => onStake(side) : undefined}
        disabled={disabled || !onStake}
        className={`pressable display flex min-h-14 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-control px-3 py-3 text-lg uppercase focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45 ${tone}`}
      >
        <span className="flex items-center gap-1.5">
          <SideArrow up={isUp} className="size-3" />
          {isUp ? "Up" : "Down"}
        </span>
        <span className="tabular text-xs font-normal normal-case opacity-80">
          {multiple === null ? "no odds yet" : `pays ${formatAmount(multiple, 18, 2)}×`}
        </span>
      </button>

      {/* Whether you are in, and how much, under the button that would add to
          it. A settled winner says so here too, so the result is attached to
          the side rather than only to the round. */}
      <p className="text-center text-xs text-ink-faint">
        {won && <span className="text-positive">Won · </span>}
        {mine ? (
          <>
            yours <span className="tabular text-ink">{formatAmount(yours!, decimals, 2)}</span>{" "}
            {symbol}
          </>
        ) : (
          <span className="opacity-0">—</span>
        )}
      </p>
    </div>
  );
}

