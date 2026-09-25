/**
 * The stock-loan vault's arithmetic, restated for previews (GHO-97).
 *
 * The contract is the authority; these exist so the screen can say what a
 * transaction will do before it is signed. Each function names the contract
 * line it mirrors, and each rounds the way that line does, so a "max" the
 * screen offers is one the contract accepts rather than one it reverts on by
 * a unit.
 */

const WAD = 10n ** 18n;

export type StockCollateral = {
  token: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
  maxLTV: bigint;
  liquidationThreshold: bigint;
  liquidationBonus: bigint;
  maxAge: bigint;
  liquidationMaxAge: bigint;
  wallet: bigint | undefined;
  allowance: bigint | undefined;
  deposited: bigint | undefined;
  /** Stablecoin units one whole token is worth, per `valueOf`. */
  valuePerToken: bigint | undefined;
  /** The feed's `updatedAt`, seconds. */
  updatedAt: bigint | undefined;
};

/** Stablecoin value of `amount` token units, as `_value` computes it. */
export function valueOfAmount(c: StockCollateral, amount: bigint): bigint | undefined {
  if (c.valuePerToken === undefined) return undefined;
  return (amount * c.valuePerToken) / 10n ** BigInt(c.decimals);
}

export type Summary = {
  value: bigint;
  borrowLimit: bigint;
  liquidationLine: bigint;
  /** Some held token has no value yet (loading or an unusable price). */
  incomplete: boolean;
};

/** `_totals`: skips tokens not held, so an unused token's feed blocks nothing. */
export function summarise(collaterals: StockCollateral[]): Summary {
  let value = 0n;
  let borrowLimit = 0n;
  let liquidationLine = 0n;
  let incomplete = false;
  for (const c of collaterals) {
    if (!c.deposited) continue;
    const v = valueOfAmount(c, c.deposited);
    if (v === undefined) {
      incomplete = true;
      continue;
    }
    value += v;
    borrowLimit += (v * c.maxLTV) / WAD;
    liquidationLine += (v * c.liquidationThreshold) / WAD;
  }
  return { value, borrowLimit, liquidationLine, incomplete };
}

/** Seconds since the feed last published, or undefined if unknown. */
export function priceAge(c: StockCollateral, now: bigint | undefined): bigint | undefined {
  if (c.updatedAt === undefined || now === undefined) return undefined;
  return now > c.updatedAt ? now - c.updatedAt : 0n;
}

/**
 * Held tokens whose price is too old to back new risk (`maxAge`). Borrowing
 * and withdrawing while in debt revert with `StalePrice` while any are.
 * Normal over a weekend; the screen says so rather than failing.
 */
export function stalePrices(collaterals: StockCollateral[], now: bigint | undefined): StockCollateral[] {
  return collaterals.filter((c) => {
    if (!c.deposited) return false;
    const age = priceAge(c, now);
    return age !== undefined && age > c.maxAge;
  });
}

/** The origination fee on a borrow, rounded up as the contract does. */
export function originationFeeOn(amount: bigint, fee: bigint): bigint {
  return (amount * fee + WAD - 1n) / WAD;
}

/**
 * The most that can be borrowed: the largest `x` with
 * `debt + x + fee(x) <= limit`. The fee counts against the limit, so this is
 * less than the headroom by about the fee.
 */
export function maxBorrow(limit: bigint, debt: bigint, fee: bigint): bigint {
  if (limit <= debt) return 0n;
  const room = limit - debt;
  let x = (room * WAD) / (WAD + fee);
  // The ceil in the fee can push the floor estimate one unit over.
  while (x > 0n && x + originationFeeOn(x, fee) > room) x -= 1n;
  return x;
}

/**
 * The most of one token that can be withdrawn while the loan stays within its
 * limit. With no debt, everything: `withdraw` reads no price then.
 */
export function maxWithdraw(c: StockCollateral, summary: Summary, debt: bigint | undefined): bigint {
  const held = c.deposited ?? 0n;
  if (!debt) return held;
  if (c.valuePerToken === undefined || c.valuePerToken === 0n || c.maxLTV === 0n) return 0n;
  if (summary.borrowLimit <= debt) return 0n;
  const room = summary.borrowLimit - debt;
  // Limit lost per token = valuePerToken * maxLTV / WAD; floor so the result
  // never exceeds what the contract will allow.
  const tokens = (room * WAD * 10n ** BigInt(c.decimals)) / (c.valuePerToken * c.maxLTV);
  return tokens < held ? tokens : held;
}

/** Health factor after a debt change, as `healthFactor` computes it. */
export function healthAfter(summary: Summary, debt: bigint): bigint | null {
  if (debt <= 0n) return null;
  return (summary.liquidationLine * WAD) / debt;
}
