import { formatUnits } from "viem";

export const WAD = 10n ** 18n;

/**
 * `CollateralVault.healthFactor` returns `type(uint256).max` for a position
 * with no lien — "cannot be liquidated" expressed as a number, so the getter
 * never divides by zero.
 *
 * That sentinel must never reach the screen. Rendered naively it is a
 * 78-digit figure sitting where a user expects "1.84", which reads as a bug
 * at best and as a broken protocol at worst.
 */
export const NO_DEBT = (1n << 256n) - 1n;

export function hasDebt(healthFactor: bigint): boolean {
  return healthFactor !== NO_DEBT;
}

/**
 * Splits a formatted number into the part that carries the meaning and the
 * tail that only carries precision, so the tail can be rendered dimmer.
 *
 * Taken from the reference dashboards: `$107,843.82` and `31.39686` both
 * grey out everything after the decimal point. It buys a large, glanceable
 * figure without rounding away digits that a user checking a balance
 * against their wallet actually needs.
 */
export function splitFigure(value: string): { lead: string; tail: string } {
  const dot = value.indexOf(".");
  if (dot === -1) return { lead: value, tail: "" };
  return { lead: value.slice(0, dot), tail: value.slice(dot) };
}

/** Token amounts: grouped thousands, fixed decimals, no scientific notation. */
export function formatAmount(
  value: bigint,
  decimals = 18,
  fractionDigits = 4,
): string {
  const asNumber = Number(formatUnits(value, decimals));
  return asNumber.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/** WAD-scaled ratios rendered as a percentage, e.g. 8e17 -> "80.00%". */
export function formatPercent(wad: bigint, fractionDigits = 2): string {
  const asNumber = Number(formatUnits(wad, 18)) * 100;
  return `${asNumber.toFixed(fractionDigits)}%`;
}

/**
 * Health factor as a multiple: 1e18 is exactly the liquidation line.
 * Returns null for the no-debt sentinel — callers must render that case
 * themselves rather than being handed a misleading number.
 */
export function formatHealthFactor(wad: bigint, fractionDigits = 2): string | null {
  if (!hasDebt(wad)) return null;
  return Number(formatUnits(wad, 18)).toFixed(fractionDigits);
}

export type HealthBand = "none" | "safe" | "caution" | "danger";

/**
 * Bands for how loudly to render the health factor.
 *
 * The thresholds are UI-only and deliberately conservative: `danger` starts
 * at 1.2, well above the 1.0 line the contract liquidates at. A user who
 * first hears about their risk *at* the liquidation threshold has already
 * lost the chance to act on it — interest accrues every block, and the gap
 * between "warned" and "liquidated" is the only window they get.
 */
export function healthBand(wad: bigint): HealthBand {
  if (!hasDebt(wad)) return "none";
  if (wad < (WAD * 12n) / 10n) return "danger";
  if (wad < (WAD * 15n) / 10n) return "caution";
  return "safe";
}

/** 0x1234…abcd, for wallet addresses in tight spaces. */
export function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
