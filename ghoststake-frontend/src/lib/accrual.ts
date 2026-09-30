/**
 * Interest that accrues between reading a debt and the transaction landing.
 *
 * Every lending view the app reads — `lienOf`, `maxBorrowable`, `debtOf`,
 * `positionOf` — prices debt at the pool's *stored* index. Every write that
 * matters calls `accrue()` first, so by the time a borrow or repay is judged
 * the debt is larger by whatever interest built up since anyone last touched
 * the pool. The backend has the same gap and closes it (`AccruedBorrowIndex`);
 * the screens read the chain directly and have to allow for it here.
 *
 * Two symptoms, both only for someone who already owes something:
 *
 * - **Borrow Max reverted.** Max was exactly the stored headroom, and the
 *   pending interest pushed the new debt over the line (`ExceedsMaxLTV`,
 *   `ExceedsBorrowLimit`).
 * - **Repay all left dust.** Paying exactly the debt read leaves the interest
 *   since then owing: 8 millionths of a dollar, on chain, the first time
 *   (runbook Part 7.104). On the staking vault a lien of any size still blocks
 *   share transfers and turns a withdrawal into an exit.
 *
 * The stock-loan screen fixed the second one inline; `/borrow` never got it.
 * One margin, one place, both directions.
 *
 * 0.1% of the debt covers the interest of about 1.8 days unaccrued at 20%
 * APR, far longer than a pool that anyone uses goes untouched. The `+ 1` is
 * for a debt so small that 0.1% rounds to nothing.
 */
export function accrualMargin(debt: bigint): bigint {
  return debt > 0n ? debt / 1000n + 1n : 0n;
}

/**
 * What "repay all" should send: the debt read plus the margin, capped at the
 * wallet. Both vaults cap a repayment at what is owed and take only that, so
 * the extra is never spent.
 */
export function payOffAmount(debt: bigint, wallet: bigint): bigint {
  const buffered = debt + accrualMargin(debt);
  return buffered < wallet ? buffered : wallet;
}

/**
 * A borrow ceiling read at the stored index, less the margin, so Max is an
 * amount the contract will still accept once it has accrued.
 */
export function borrowHeadroom(ceiling: bigint, debt: bigint): bigint {
  const margin = accrualMargin(debt);
  return ceiling > margin ? ceiling - margin : 0n;
}
