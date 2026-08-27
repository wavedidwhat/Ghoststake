import { WAD } from "./format";

/**
 * The supply side of `BorrowLiquidityPool`, as pure functions.
 *
 * Same argument as `operator.ts`: every rule here restates a guard or a
 * formula in the contract, and a restatement that drifts is a UI proposing a
 * transaction that reverts. Keeping them out of the component means the
 * drift is testable.
 *
 * The one idea worth stating up front, because the whole surface is built
 * around it: **utilization is simultaneously a lender's yield and their exit
 * risk.** High utilization means the pool is lending out most of its cash, so
 * the supply rate is high — and it means the cash is not there to withdraw.
 * Those are not two facts to show in two places. They are one number read
 * twice, and a lender who is shown only the first reading has been sold the
 * upside of a position without the term that comes with it.
 */

/**
 * What a supplier can actually take out right now.
 *
 * `withdraw` reverts with `InsufficientSupplyBalance` above the balance and
 * `InsufficientLiquidity` above the cash on hand, so the reachable maximum is
 * the lower of the two. Offering the balance as the maximum when the cash is
 * not there produces a Max button that proposes a reverting transaction —
 * and a lender finding out that way is how a protocol loses a lender
 * permanently.
 */
export function maxWithdraw(balance: bigint, available: bigint): bigint {
  return balance < available ? balance : available;
}

/**
 * A supplier's share of the pool, WAD-scaled.
 *
 * Measured against `totalSupplied` — the claims on the pool — rather than
 * against the cash on hand, which is what is left after borrowing and would
 * read as a share above 100% at any real utilization.
 */
export function shareOfPool(balance: bigint, totalSupplied: bigint): bigint {
  if (totalSupplied === 0n) return 0n;
  return (balance * WAD) / totalSupplied;
}

/**
 * Utilization after a change to the pool's cash, WAD-scaled.
 *
 * `delta` is signed: positive to supply, negative to withdraw. Computed the
 * way the contract computes it — `borrowed / (available + borrowed)`, where
 * `available` is the token balance — so the preview and the chain agree.
 *
 * Worth previewing rather than leaving as a surprise, because the effect runs
 * against the lender's instinct: supplying into a pool *lowers* the rate you
 * are supplying at. A lender who watches their APR drop the moment they
 * deposit, with nothing having said it would, reasonably concludes the number
 * they were shown was a lie.
 */
export function utilizationAfter(borrowed: bigint, available: bigint, delta: bigint): bigint {
  if (borrowed === 0n) return 0n;
  const cash = available + delta;
  // A withdrawal larger than the cash on hand cannot happen — the contract
  // refuses it — but the preview is fed a half-typed field, so clamp rather
  // than return a negative denominator and a nonsense percentage.
  const denominator = (cash < 0n ? 0n : cash) + borrowed;
  if (denominator === 0n) return 0n;
  return (borrowed * WAD) / denominator;
}

export type LendWarning = {
  /** Stable key, so a list of these can be rendered and tested by identity. */
  code: "exit-blocked" | "exit-limited" | "past-kink";
  text: string;
};

/**
 * What a lender should know about their position before they are asked to
 * add to it, whether or not anything has gone wrong yet.
 *
 * Not error states. `exit-limited` fires on a perfectly healthy pool doing
 * exactly what a lending pool is for, and it is still the single most
 * important thing to say to somebody about to put money in.
 */
export function lendWarnings({
  balance,
  available,
  utilization,
  kink,
}: {
  balance: bigint;
  available: bigint;
  utilization: bigint;
  kink: bigint;
}): LendWarning[] {
  const warnings: LendWarning[] = [];

  if (balance > 0n && available === 0n) {
    warnings.push({
      code: "exit-blocked",
      text:
        "Every token in the pool is out on loan, so nothing can be withdrawn right now. " +
        "Your balance keeps earning, and liquidity returns as borrowers repay.",
    });
  } else if (balance > available) {
    warnings.push({
      code: "exit-limited",
      text:
        "More of your balance is out on loan than the pool holds in cash, so only part of it " +
        "can be withdrawn right now. The rest returns as borrowers repay.",
    });
  }

  // The kink is where the curve turns steep, by design: past it the rate has
  // to both deter borrowing and pull supply in. Saying so turns a high APR
  // from bait into a description of a pool under strain.
  if (utilization > kink) {
    warnings.push({
      code: "past-kink",
      text:
        "The pool is lent out past its target, which is why the rate is high. The same fact " +
        "makes exiting harder: the rate is steep here to pull supply in and slow borrowing down.",
    });
  }

  return warnings;
}

/**
 * The reason a withdrawal cannot be submitted, or null if it can.
 *
 * Separate from the warnings above: these are blocking, and each one maps to
 * a named revert in the contract rather than to advice.
 */
export function withdrawProblem(
  amount: bigint,
  balance: bigint,
  available: bigint,
): "over-balance" | "over-liquidity" | null {
  if (amount > balance) return "over-balance";
  if (amount > available) return "over-liquidity";
  return null;
}
