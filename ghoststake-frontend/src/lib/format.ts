export const WAD = 10n ** 18n;

/**
 * `CollateralVault.healthFactor` returns `type(uint256).max` when there is no
 * lien, so the getter never divides by zero. It is a sentinel, not a value —
 * rendered directly it is a 78-digit number where a user expects "1.84".
 */
export const NO_DEBT = (1n << 256n) - 1n;

/**
 * Above this, a health factor stops carrying information — the position is
 * simply unencumbered — and the digits become noise in display type.
 */
const HEALTH_DISPLAY_CEILING = 999n * WAD;

export function hasDebt(healthFactor: bigint): boolean {
  return healthFactor !== NO_DEBT;
}

/**
 * Fixed-point render of a scaled integer, done in bigint throughout.
 *
 * Going via `Number` loses precision past ~17 significant digits, and it
 * loses it silently: a balance would print trailing zeros that look exact
 * and are fabricated. Rounding is half-up, matching `toFixed`.
 */
function formatFixed(value: bigint, decimals: number, fractionDigits: number): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;

  const unit = 10n ** BigInt(decimals);
  const precision = 10n ** BigInt(fractionDigits);
  const scaled = (magnitude * precision + unit / 2n) / unit;

  const whole = (scaled / precision).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction =
    fractionDigits > 0 ? `.${(scaled % precision).toString().padStart(fractionDigits, "0")}` : "";

  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** Splits at the decimal point so the tail can be rendered dimmer. */
export function splitFigure(value: string): { lead: string; tail: string } {
  const dot = value.indexOf(".");
  if (dot === -1) return { lead: value, tail: "" };
  return { lead: value.slice(0, dot), tail: value.slice(dot) };
}

/** Grouped thousands, fixed decimals, never scientific notation. */
export function formatAmount(value: bigint, decimals = 18, fractionDigits = 4): string {
  return formatFixed(value, decimals, fractionDigits);
}

/** WAD-scaled ratios as a percentage: 8e17 -> "80.00%". */
export function formatPercent(wad: bigint, fractionDigits = 2): string {
  // x/1e18 as a percentage is x/1e16, so the scale shifts by two.
  return `${formatFixed(wad, 16, fractionDigits)}%`;
}

/**
 * Health factor as a multiple, where 1.00 is the liquidation line.
 *
 * Returns null for the no-debt sentinel: the nullable return is what forces
 * callers to handle that case instead of printing it. Values above the
 * display ceiling are capped — a dust lien can push the ratio past 1e20,
 * which is both meaningless and unreadable at display size.
 */
export function formatHealthFactor(wad: bigint, fractionDigits = 2): string | null {
  if (!hasDebt(wad)) return null;
  if (wad > HEALTH_DISPLAY_CEILING) return "999+";
  return formatFixed(wad, 18, fractionDigits);
}

export type HealthBand = "none" | "safe" | "caution" | "danger";

/**
 * How loudly to render the health factor.
 *
 * UI-only thresholds, set above the contract's 1.0 liquidation line on
 * purpose: warning a user exactly when liquidation becomes possible leaves
 * them no time to add collateral or repay.
 */
export function healthBand(wad: bigint): HealthBand {
  if (!hasDebt(wad)) return "none";
  if (wad < (WAD * 12n) / 10n) return "danger";
  if (wad < (WAD * 15n) / 10n) return "caution";
  return "safe";
}

/**
 * A per-second WAD rate as an annual percentage.
 *
 * Simple, not compounded, because that is how the pool accrues — showing a
 * compounded APY beside a contract that charges simple interest would
 * overstate what a borrower actually pays.
 */
export function formatApr(ratePerSecond: bigint, fractionDigits = 2): string {
  const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
  return formatPercent(ratePerSecond * SECONDS_PER_YEAR, fractionDigits);
}

/**
 * A whole number of seconds as something readable: "15s", "2m", "1m 30s".
 *
 * The contract's timing immutables are all `uint64` seconds. Rendering an
 * entry cutoff as "15" leaves the unit to be guessed, and the guesses that
 * matter here — seconds against blocks — differ by an order of magnitude.
 *
 * Never abbreviates past the hour: a resolve deadline of 90 minutes reads
 * better as "1h 30m" than as "1.5h", which invites the reader to wonder what
 * was rounded.
 */
export function formatDuration(seconds: bigint): string {
  if (seconds === 0n) return "0s";

  const hours = seconds / 3600n;
  const minutes = (seconds % 3600n) / 60n;
  const rest = seconds % 60n;

  const parts: string[] = [];
  if (hours > 0n) parts.push(`${hours}h`);
  if (minutes > 0n) parts.push(`${minutes}m`);
  // Seconds are dropped once there is an hour on the front: "1h 0m 3s" is
  // precision nobody asked for on a deadline measured in hours.
  if (rest > 0n && hours === 0n) parts.push(`${rest}s`);

  return parts.join(" ");
}

/**
 * Formats a value that may not have loaded yet, or undefined if it has not.
 *
 * Exists because the idiomatic `value && format(value)` is wrong for every
 * quantity in this app: for `0n` it evaluates to `0n` rather than to a string,
 * so a zero renders as a raw bigint. Zero is a legitimate setting for several
 * contract terms — a market may be listed with no rake, a vault deployed with
 * no liquidation bonus — so "falsy" and "not loaded yet" are genuinely
 * different questions, and a loading skeleton must never stand in for a real
 * value of zero.
 *
 * `tsc` catches the `&&` version at the call site. This is what to write
 * instead.
 */
export function formatOptional(
  value: bigint | undefined,
  format: (v: bigint) => string,
): string | undefined {
  return value === undefined ? undefined : format(value);
}

/** 0x1234…abcd, for wallet addresses in tight spaces. */
export function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
