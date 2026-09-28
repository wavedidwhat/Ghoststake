import { message, type Message } from "@/i18n/message";
import type { QuestionOutcome, RoundQuestion } from "./positions";

/**
 * Reading a claimed outcome (GHO-91).
 *
 * The contract half of this shipped in GHO-80: an outcome is not a reading,
 * it is a claim, bonded, against named evidence, that becomes true only if
 * nobody pays to argue. That sentence is the whole product, and none of it
 * survives being rendered as the word "Yes" with a tick next to it.
 *
 * So everything here answers one question — *should I argue with this?* — and
 * the functions are separate from the component so they can be tested against
 * the states that matter rather than through a DOM.
 */

/**
 * Which answer an outcome is, as its key under `round.sides` ("Yes" / "No"),
 * matching the answers.
 */
export function outcomeKey(outcome: QuestionOutcome | undefined): "yes" | "no" | null {
  if (outcome === "yes") return "yes";
  if (outcome === "no") return "no";
  return null;
}

/** Where a question stands, in one sentence a person would say. */
export function questionHeadline(q: RoundQuestion): Message {
  const answer = outcomeKey(q.outcome);
  switch (q.state) {
    case "open":
      return message("resolution.headline.open");
    case "proposed":
      return answer ? message("resolution.headline.proposedAnswer", { answer }) : message("resolution.headline.proposed");
    case "challenged":
      return message("resolution.headline.challenged");
    case "final":
      return answer ? message("resolution.headline.finalAnswer", { answer }) : message("resolution.headline.final");
    case "abandoned":
      // Not "unresolved", which sounds like it is still coming. Nobody ruled,
      // the bonds went back, and the round now refunds everyone — so the
      // sentence has to say that the waiting is over.
      return message("resolution.headline.abandoned");
    default:
      return message("resolution.headline.unknown");
  }
}

/**
 * Whether a claim can still be argued with, and how long is left.
 *
 * `now` is passed in rather than read from the clock so the caller owns the
 * ticking. A component reading `Date.now()` during render disagrees with the
 * server on first paint, which is a hydration mismatch on every question on
 * screen.
 */
export function challengeWindow(
  q: RoundQuestion,
  now: Date | undefined,
): { open: boolean; secondsLeft: number | null } {
  if (q.state !== "proposed" || !q.challengeClosesAt) return { open: false, secondsLeft: null };
  if (now === undefined) return { open: true, secondsLeft: null };

  const closes = Date.parse(q.challengeClosesAt);
  if (Number.isNaN(closes)) return { open: true, secondsLeft: null };

  const left = Math.floor((closes - now.getTime()) / 1000);
  // Past the deadline the claim is final in substance but the contract has
  // not been told yet — `finalise` is somebody's transaction. Showing a
  // negative countdown, or "1 day left", would both be lies.
  return { open: left > 0, secondsLeft: left > 0 ? left : 0 };
}

/**
 * Whether the person who claimed the outcome had money riding on it.
 *
 * Disclosed rather than forbidden, and the reasoning is worth keeping next to
 * the code that renders it: a ban cannot work, because the banned holder
 * proposes from an address holding nothing while their position sits
 * elsewhere. It stops nobody who is trying, and it *does* stop the people who
 * most care what happened — who are the most likely to report it promptly.
 *
 * So it is shown, and the reader decides. `undefined` means the market could
 * not be read at all, which is not the same as zero.
 */
export function proposerInterest(q: RoundQuestion): "none" | "held" | "unknown" {
  if (q.proposerStake === undefined || q.proposerStake === "") return "unknown";
  try {
    return BigInt(q.proposerStake) > 0n ? "held" : "none";
  } catch {
    return "unknown";
  }
}

/**
 * Whether this claim went the same way as the proposer's own position.
 *
 * The sharper disclosure, and the one worth leading with: a proposer holding
 * *Yes* who claims *Yes* is the case somebody should look at. Which side they
 * held is not on chain — `proposerStake` is their whole stake in the round —
 * so this deliberately does not guess, and the caller passes what it knows.
 */
export function claimFavoursProposer(
  q: RoundQuestion,
  proposerSide: "yes" | "no" | undefined,
): boolean {
  if (proposerSide === undefined) return false;
  return outcomeKey(q.outcome) === proposerSide;
}
