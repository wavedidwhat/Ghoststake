import { formatUnits } from "viem";

export const WAD = 10n ** 18n;

/**
 * `CollateralVault.healthFactor` returns `type(uint256).max` when there is no
 * lien, so the getter never divides by zero. It is a sentinel, not a value —
 * rendered directly it is a 78-digit number where a user expects "1.84".
 */
export const NO_DEBT = (1n << 256n) - 1n;

export function hasDebt(healthFactor: bigint): boolean {
  return healthFactor !== NO_DEBT;
}

/** Splits at the decimal point so the tail can be rendered dimmer. */
export function splitFigure(value: string): { lead: string; tail: string } {
  const dot = value.indexOf(".");
  if (dot === -1) return { lead: value, tail: "" };
  return { lead: value.slice(0, dot), tail: value.slice(dot) };
}

/** Grouped thousands, fixed decimals, never scientific notation. */
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
 * Health factor as a multiple, where 1.00 is the liquidation line.
 *
 * Returns null for the no-debt sentinel: the nullable return is what forces
 * callers to handle that case instead of printing it.
 */
export function formatHealthFactor(wad: bigint, fractionDigits = 2): string | null {
  if (!hasDebt(wad)) return null;
  return Number(formatUnits(wad, 18)).toFixed(fractionDigits);
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

/** 0x1234…abcd, for wallet addresses in tight spaces. */
export function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
