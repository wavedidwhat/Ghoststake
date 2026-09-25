"use client";

import Link from "next/link";

import { explorerAddressUrl } from "@/lib/activity";
import { formatAmount } from "@/lib/format";
import { questionFor, sideLabel } from "@/lib/question";
import type { Spot } from "@/hooks/useSpot";
import { formatAge, formatMove, isNarrow, isStalePrint, priceAge, standingOf } from "@/lib/spot";
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
  feed,
  isQuestion,
  feedAddress,
  spot,
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
  /** The feed's own description ("ETH / USD"), which is what the round is
   *  about. Without it the question falls back to "The price…" rather than
   *  guessing an asset. */
  feed?: string;
  /** Set when this market settles a claimed outcome rather than a price
   *  (GHO-91). `feed` is then the oracle's own question, used verbatim. */
  isQuestion?: boolean;
  /** The aggregator this market settles against, for the explorer link on
   *  the settlement line (GHO-64). */
  feedAddress?: `0x${string}`;
  /** What the asset is worth right now, in the strike's 18-decimal scale
   *  (GHO-64). Undefined while it loads, or on a market with no price at
   *  all — a question is not settled by one. */
  spot?: Spot;
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

  // The question this round is asking (GHO-78). A market used to be an asset
  // and a direction — "ETH / USD", answered Up or Down — which is not a
  // question anybody outside this codebase thinks in.
  const question = questionFor({
    feed,
    strike: round.lockPrice,
    closeTime: round.closeTime,
    isQuestion,
  });

  return (
    <article className="rounded-card border border-border bg-surface p-4">
      <h3 className="display text-base leading-snug text-ink">{question}</h3>

      <header className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {/* The round's permalink. A card and not a link before GHO-41,
              which meant the smallest shareable thing in the product — one
              round, one outcome — had no address at all. */}
          {href ? (
            <Link
              href={href}
              className="text-xs text-ink-faint underline-offset-4 hover:text-ink-muted hover:underline"
            >
              Round {id.toString()}
            </Link>
          ) : (
            <span className="text-xs text-ink-faint">Round {id.toString()}</span>
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

      {/*
       * The strike, and where the price is against it.
       *
       * ~~Shown only once locked~~ — that was right when the strike did not
       * exist until lock, and GHO-79 made it exist from the first second. The
       * old condition then quietly hid the number the round is *asking about*
       * during the only phase anyone can still act on it.
       */}
      {round.lockPrice > 0n && (
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

      {/* Where it is now, and so which answer is winning (GHO-64). */}
      <SpotLine round={round} phase={phase} spot={spot} now={now} isQuestion={isQuestion} />

      <OddsBar round={round} decimals={decimals} symbol={symbol} />

      <SettlementNote
        round={round}
        feed={feed}
        feedAddress={feedAddress}
        isQuestion={isQuestion}
      />

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

  const yes = Math.round(share);

  return (
    <div className="mt-3">
      {/* The percentage leads and the bar sits beside it, because they are the
          same fact: a figure next to its own picture needs no legend. The
          multiple on each button is the third view of it — what the crowd
          believes is *why* that side pays what it pays. */}
      <div className="flex items-center gap-3">
        <div className="flex items-baseline gap-1.5">
          <span className="tabular text-2xl text-ink">{yes}%</span>
          <span className="text-xs text-ink-muted">say yes</span>
        </div>

        <div
          className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-down"
          role="img"
          aria-label={`${yes}% of the pool says yes, ${100 - yes}% says no`}
        >
          <div className="h-full bg-up" style={{ width: `${share}%` }} />
        </div>
      </div>

      <div className="tabular mt-2 flex justify-between text-xs text-ink-faint">
        <span>
          {formatAmount(round.upPool, decimals, 2)} {symbol} on yes
        </span>
        <span>
          {formatAmount(round.downPool, decimals, 2)} {symbol} on no
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

  // This side's share of the pool: what the crowd thinks of *this* answer,
  // beside what it pays. No surface shows a bare multiple (GHO-78).
  const total = round.upPool + round.downPool;
  const sidePool = isUp ? round.upPool : round.downPool;
  const percent = total === 0n ? null : Math.round(Number((sidePool * 100n) / total));

  // Tinted, not filled. Eight saturated slabs a screen fight the figures that
  // matter, and a filled side stopped tracking its own probability — a 7% Yes
  // read heavier than the 93% No beside it (ADR 0058). A side you already
  // hold fills, because then the colour reports a fact about you rather than
  // competing for a decision.
  const tone = mine
    ? isUp
      ? "bg-up text-up-ink [--edge:var(--color-up-edge)]"
      : "bg-down text-down-ink [--edge:var(--color-down-edge)]"
    : isUp
      ? "bg-up-soft text-up [--edge:var(--color-up-edge)]"
      : "bg-down-soft text-down [--edge:var(--color-down-edge)]";

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onStake ? () => onStake(side) : undefined}
        disabled={disabled || !onStake}
        className={`pressable display flex min-h-14 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-control px-3 py-3 text-lg uppercase focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45 ${tone}`}
      >
        <span className="flex items-center gap-1.5">
          {/* The arrow stays: colour is never the only signal (DESIGN.md), and
              Yes/No have to survive greyscale as much as Up/Down did. */}
          <SideArrow up={isUp} className="size-3" />
          {sideLabel(side)}
        </span>
        <span className="tabular text-xs font-normal normal-case opacity-80">
          {multiple === null
            ? "no odds yet"
            : `${percent}% · pays ${formatAmount(multiple, 18, 2)}×`}
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

/**
 * The live price, and which answer it currently favours.
 *
 * The "done when" of GHO-64 is that a visitor can tell within two seconds
 * what the price is, what the strike is, which side is ahead and how long is
 * left. The strike and the clock were already on the card; this is the other
 * half.
 *
 * Renders nothing rather than a placeholder when either number is missing. A
 * market deployed before GHO-79 has no strike until it locks, and a feed that
 * has never published has no price — both are real states, and a dash where a
 * price should be reads as a broken card.
 */
function SpotLine({
  round,
  phase,
  spot,
  now,
  isQuestion,
}: {
  round: Round;
  phase: PhaseValue;
  spot?: Spot;
  now?: bigint;
  isQuestion?: boolean;
}) {
  const settled = round.status === Status.Resolved || round.status === Status.Void;
  // A settled round has a close price on the line above, which is the number
  // that decided it. Showing today's price beside it would invite reading the
  // wrong one as the outcome.
  if (settled) return null;

  // No strike yet, on a market deployed before GHO-79 — the level is captured
  // when entry closes, not when the round opens. Said out loud rather than
  // left blank: the live Sepolia market is one of these, so "what am I
  // betting against" is a question the card has to answer even when the
  // answer is "not decided yet". A question has no strike at all and is not
  // waiting for one, so it is excluded.
  const awaitingStrike = !isQuestion && round.lockPrice === 0n;

  if (spot === undefined) {
    return awaitingStrike ? <AwaitingStrike phase={phase} /> : null;
  }

  const { leading, bps } = standingOf(spot.price, round.lockPrice);
  const age = priceAge(spot.updatedAt, now);
  // "Now" is a claim about freshness that an hourly feed cannot support. When
  // the print is recent the word is fine; when it is not, the figure is named
  // for what it actually is.
  const stale = age !== null && isStalePrint(age);

  return (
    <>
    {awaitingStrike && <AwaitingStrike phase={phase} />}
    <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-ink-muted">
      <span>
        {stale ? "Last price" : "Now"}{" "}
        <span className="tabular text-ink">{formatAmount(spot.price, 18, 2)}</span>
      </span>

      {/*
       * When the feed printed it. The ETH/USD feed publishes about once an
       * hour, and rounds are an hour long, so a price shown bare under the
       * word "Now" could be fifty-nine minutes old on the one screen where
       * that difference decides a bet.
       */}
      {age !== null && <span className="text-ink-faint">printed {formatAge(age)}</span>}

      {bps !== null && leading !== null && (
        <>
          <span className="tabular">{formatMove(bps)}</span>
          {/*
           * Hedged deliberately when the lead is thin. "Yes is ahead" at
           * +0.01% and at +4% are not the same claim, and an ETH/USD feed
           * crosses a tenth of a percent several times an hour — so stating
           * both the same way would be misleading in one of the two cases.
           */}
          <span>
            {isNarrow(bps) ? "too close to call" : `${sideLabel(leading)} is ahead`}
          </span>
        </>
      )}

      {/*
       * The adapter refuses stale readings, readings from behind a sequencer
       * outage, and readings from a paused feed. A price the contract would
       * not settle on must not be shown as if it would.
       */}
      {!spot.usable && (
        <span className="text-ink-faint">
          (the feed is stale — this is not a price the round could settle on)
        </span>
      )}
    </p>
    </>
  );
}

/**
 * Said when a live round has no strike yet.
 *
 * Markets deployed before GHO-79 capture the level at lock rather than at
 * open, and the live Sepolia market is one of them — so for the whole of the
 * entry window there is genuinely nothing to compare the price against. The
 * card says which, because a price with no reference point and no explanation
 * reads as a missing number rather than as a phase.
 */
function AwaitingStrike({ phase }: { phase: PhaseValue }) {
  // Past the entry window the first wording would be false — entry *has*
  // closed, and the level is being captured rather than waiting on a
  // deadline. Two sentences rather than one, because a card that tells you
  // something you can see is wrong is worse than one that says nothing.
  const text =
    phase === Phase.Open
      ? "Start price is set when entry closes — this round measures the move from there."
      : "Start price is being set now. This round measures the move from there.";

  return <p className="mt-3 text-xs text-ink-muted">{text}</p>;
}

/**
 * How this round will be decided, and by whom.
 *
 * The settlement path is pinned: the round resolves against a specific
 * Chainlink round at a specific second, chosen by rule rather than by us at
 * the time (runbook Part 7.31). That is the strongest honest claim this
 * product makes — it is checkable by a stranger against a source we do not
 * control — and until now it was stated nowhere in the app. A market that
 * cannot say who decides it is asking for trust it has not earned.
 *
 * The time is spelled in UTC. A local time is friendlier and wrong for this
 * one sentence: the reader is being invited to go and check a figure against
 * a public feed, and the feed's own clock is UTC.
 */
function SettlementNote({
  round,
  feed,
  feedAddress,
  isQuestion,
}: {
  round: Round;
  feed?: string;
  feedAddress?: `0x${string}`;
  isQuestion?: boolean;
}) {
  // A question is settled by a named arbiter against written criteria, not by
  // a feed. Saying "settles on the price" there would be plainly false, and
  // the resolution panel already explains the real path (GHO-91).
  if (isQuestion) return null;

  // A void round was not settled on the price — it was cancelled and the
  // stakes handed back, and the feed had nothing to do with it. Claiming
  // otherwise would be flatly false on the one line whose entire purpose is
  // to be checkable. Round 417 on Sepolia is exactly this case.
  if (round.status === Status.Void) return null;

  const at = new Date(Number(round.closeTime) * 1000).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
  });

  const name = feed?.split(" - ").pop() ?? "the price feed";
  const href = feedAddress ? explorerAddressUrl(feedAddress) : undefined;
  // Tense matters here more than it looks. This sentence exists to be
  // checked, and a resolved round that still says "settles" reads as a
  // pending one — which would send somebody to the explorer looking for a
  // future they have already missed.
  const done = round.status === Status.Resolved;

  return (
    <p className="mt-3 border-t border-border pt-3 text-[11px] text-ink-faint">
      {done ? "Settled" : "Settles"} on the {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-ink-muted focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        >
          Chainlink {name}
        </a>
      ) : (
        <>Chainlink {name}</>
      )}{" "}
      price at {at} UTC. Anyone can check it.
    </p>
  );
}
