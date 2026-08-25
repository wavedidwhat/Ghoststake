import { Phase, Status, type PhaseValue, type Round } from "./rounds";

/**
 * What an operator can do to a round right now, and what they should be
 * warned about before they do it.
 *
 * Kept away from the chain deliberately: every rule here is a restatement of
 * a guard in `ParimutuelRound`, and a restatement that drifts is a console
 * offering a button that reverts. Pure functions mean the drift is testable.
 */

export const Action = {
  /** Nothing to do; the round is waiting on the clock or on someone else. */
  None: "none",
  Lock: "lock",
  Resolve: "resolve",
  /** Locked, past the resolve deadline: owner-only refund. */
  VoidUnsettled: "void-unsettled",
  /** Never locked, past the lock window: anyone may unwind it. */
  VoidUnlocked: "void-unlocked",
} as const;

export type ActionValue = (typeof Action)[keyof typeof Action];

/** Whether the contract lets any address call this, or only the owner. */
export function isOwnerOnly(action: ActionValue): boolean {
  return action === Action.VoidUnsettled;
}

export type Timing = {
  entryCutoff: bigint;
  lockWindow: bigint;
  resolveDeadline: bigint;
};

/**
 * The one action a round needs next, or none.
 *
 * Mirrors the contract's ordering rather than the UI's convenience:
 *
 * - Open/Cutoff before `lockTime` — nothing to do but wait.
 * - Past `lockTime`, inside the window — **Lock**. `lockRound` itself voids a
 *   thin round, so this is still the right button when a side is short; the
 *   warning says what will happen.
 * - Past `lockTime + lockWindow` and still unlocked — **VoidUnlocked**.
 *   `lockRound` would void it too, but voiding says what it is doing.
 * - Locked, past `closeTime` — **Resolve**, whether or not a usable feed
 *   round exists yet. Whether one does is the resolve helper's question, and
 *   answering it needs the chain.
 * - Locked, past `closeTime + resolveDeadline` — **VoidUnsettled**. Still
 *   offered alongside a resolve that may now succeed: the deadline is a
 *   permission to refund, not an instruction to.
 */
export function actionFor(round: Round, phase: PhaseValue, timing: Timing, now: bigint): ActionValue {
  if (phase === Phase.Resolved || phase === Phase.Void || phase === Phase.None) return Action.None;

  if (round.status === Status.Open) {
    if (now < round.lockTime) return Action.None;
    if (now > round.lockTime + timing.lockWindow) return Action.VoidUnlocked;
    return Action.Lock;
  }

  if (round.status === Status.Locked) {
    if (now < round.closeTime) return Action.None;
    if (now > round.closeTime + timing.resolveDeadline) return Action.VoidUnsettled;
    return Action.Resolve;
  }

  return Action.None;
}

export type Warning = {
  /** Stable key, so a list of these can be rendered and tested by identity. */
  code: "thin-side" | "lock-window-closing" | "lock-window-missed" | "resolve-deadline-closing";
  text: string;
};

/**
 * What is about to go wrong, while there is still time to act on it.
 *
 * Deadlines warn inside a window rather than only once they have passed,
 * because "you missed it" is not information anyone can use. The window is
 * a fraction of the deadline itself, so a 60-second lock window warns with
 * 20 seconds left and an hour-long resolve deadline warns with 20 minutes.
 */
export function warningsFor(
  round: Round,
  phase: PhaseValue,
  timing: Timing,
  minSidePool: bigint,
  now: bigint,
): Warning[] {
  const out: Warning[] = [];
  if (phase === Phase.Resolved || phase === Phase.Void || phase === Phase.None) return out;

  if (round.status === Status.Open) {
    // Checked before the oracle in `lockRound`, so this is what actually
    // happens to a one-sided round: it voids and everyone is refunded.
    if (round.upPool < minSidePool || round.downPool < minSidePool) {
      out.push({
        code: "thin-side",
        text: "A side is under the minimum, so locking this round will void it and refund everyone.",
      });
    }

    const windowEnds = round.lockTime + timing.lockWindow;
    if (now > windowEnds) {
      out.push({
        code: "lock-window-missed",
        text: "The lock window has passed. This round can no longer be locked — only voided.",
      });
    } else if (now >= round.lockTime && windowEnds - now <= timing.lockWindow / 3n) {
      out.push({
        code: "lock-window-closing",
        text: "The lock window is about to close. Miss it and the round voids, whatever is staked.",
      });
    }
  }

  if (round.status === Status.Locked) {
    const deadline = round.closeTime + timing.resolveDeadline;
    if (now >= round.closeTime && now <= deadline && deadline - now <= timing.resolveDeadline / 3n) {
      out.push({
        code: "resolve-deadline-closing",
        text: "The resolve deadline is approaching. Past it the round can be voided instead of settled.",
      });
    }
  }

  return out;
}

/**
 * A round's schedule from the three windows an operator actually thinks in,
 * plus the lead that makes it survive being signed.
 *
 * `openRound` rejects an `openTime` in the past, and the gap between signing
 * and mining eats a short lead — a round opened with a ten-second lead has
 * already failed by the time the transaction lands on a public chain. So the
 * lead is explicit, previewed, and never zero by default.
 */
export function scheduleFrom(
  now: bigint,
  leadSeconds: bigint,
  entryWindow: bigint,
  observation: bigint,
): { openTime: bigint; lockTime: bigint; closeTime: bigint } {
  const openTime = now + leadSeconds;
  return {
    openTime,
    lockTime: openTime + entryWindow,
    closeTime: openTime + entryWindow + observation,
  };
}

/**
 * Whether a schedule will be accepted, checked the way the contract checks it.
 *
 * `openRound` reverts with `InvalidSchedule` for all three of these, and a
 * reverted transaction costs gas and tells the operator nothing about which
 * rule they broke.
 */
export function scheduleProblem(
  schedule: { openTime: bigint; lockTime: bigint; closeTime: bigint },
  entryCutoff: bigint,
  now: bigint,
): string | null {
  if (schedule.openTime < now) {
    return "The open time is already in the past. Increase the lead.";
  }
  if (schedule.lockTime <= schedule.openTime + entryCutoff) {
    return `The entry window must be longer than the ${entryCutoff}s entry cutoff, or the round opens with entry already closed.`;
  }
  if (schedule.closeTime <= schedule.lockTime) {
    return "The observation window must be longer than zero.";
  }
  return null;
}

/**
 * Find the feed round a resolve has to name: the last one published at or
 * before `closeTime`.
 *
 * Binary search over feed round ids, because a feed on a 20-second heartbeat
 * has published tens of thousands of rounds by the time anyone settles
 * anything, and walking back from the latest is one request per round.
 *
 * `readRound` is injected so this is testable without a chain, and returns
 * `null` for an id that holds no data — which is not the same as one that
 * holds an old price. Chainlink proxies return no data below the current
 * phase's first round, so empty ids sit in the *middle* of the range, not
 * only past the end.
 *
 * # Why the search is over a predicate rather than over timestamps
 *
 * The first version seeded the search by walking back in doubling steps and
 * got the seeding wrong on every feed whose history does not start at id 1.
 * The fix is to notice that this predicate —
 *
 *     P(id) = the id holds no data, OR its price is at or before the close
 *
 * — is true for every id below the answer and false for every id above it.
 * Empty ids below the phase floor are `true` and sort with the low half;
 * rounds published after the close are `false` and sort with the high half.
 * That is monotone across the whole range, which is the only property a
 * binary search needs, and it needs no seeding at all.
 *
 * Returns `null` when there is nothing to settle against — the feed has not
 * published since the close, or its history begins after it. Both mean wait,
 * and saying so beats returning a candidate the adapter will refuse.
 *
 * The round returned always has a successor published strictly after the
 * close, which is the other half of what the adapter verifies: the id above
 * the answer fails the predicate, and failing it means existing *and* being
 * after the close.
 */
export async function findCloseRound(
  readRound: (id: bigint) => Promise<{ updatedAt: bigint } | null>,
  latestRoundId: bigint,
  closeTime: bigint,
): Promise<bigint | null> {
  const latest = await readRound(latestRoundId);
  if (!latest) return null;

  // Nothing published since the close, so no round can be both the last one
  // before it and have a successor after it.
  if (latest.updatedAt <= closeTime) return null;

  const holds = async (id: bigint) => {
    const round = await readRound(id);
    return round === null || round.updatedAt <= closeTime;
  };

  // Invariant: P(lo) is true, P(hi) is false. Id 0 exists on no feed, so it
  // holds no data and satisfies P — which makes it a valid floor without a
  // read.
  let lo = 0n;
  let hi = latestRoundId;
  while (hi - lo > 1n) {
    const mid = lo + (hi - lo) / 2n;
    if (await holds(mid)) lo = mid;
    else hi = mid;
  }

  if (lo === 0n) return null;
  // `lo` satisfies P, which is either "at or before the close" or "holds no
  // data". Only the first is an answer.
  const answer = await readRound(lo);
  return answer === null ? null : lo;
}
