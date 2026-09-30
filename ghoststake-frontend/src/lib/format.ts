export const WAD = 10n ** 18n;

/** Anything a Date can be built from: epoch milliseconds, or an ISO string. */
type Instant = Date | number | string;

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
 * Every formatter that writes digits, separators, units or dates, bound to one
 * locale (GHO-128).
 *
 * A factory rather than module functions reading a constant, because the app
 * now renders in the visitor's language and the server renders many visitors
 * at once: a module-level locale would hand one visitor another's separators.
 * Spanish and Portuguese write 1.234,56, and "1,500" read the wrong way is a
 * silently wrong amount. Components get theirs from `useFormat()`; code
 * outside React takes a `Format` from its caller.
 *
 * The separators are applied by hand in `formatFixed` rather than handing a
 * decimal string to `Intl.NumberFormat`: that is exact only in engines with
 * Intl.NumberFormat v3, and an older one converts the string to a Number
 * first, which loses digits past ~17 significant figures silently.
 */
export function formatFor(locale: string): Format {
  const cached = cache.get(locale);
  if (cached) return cached;

  const separators = new Intl.NumberFormat(locale).formatToParts(12345.6);
  const GROUP = separators.find((p) => p.type === "group")?.value ?? "";
  const DECIMAL = separators.find((p) => p.type === "decimal")?.value ?? ".";

  /**
   * Fixed-point render of a scaled integer, done in bigint throughout.
   *
   * Going via `Number` loses precision past ~17 significant digits, and it
   * loses it silently: a balance would print trailing zeros that look exact
   * and are fabricated. Rounding is half-up, matching `toFixed`, unless the
   * caller asks for `"down"` — see `formatHealthFactor` for when that matters.
   */
  function formatFixed(
    value: bigint,
    decimals: number,
    fractionDigits: number,
    rounding: "half-up" | "down" = "half-up",
  ): string {
    const negative = value < 0n;
    const magnitude = negative ? -value : value;

    const unit = 10n ** BigInt(decimals);
    const precision = 10n ** BigInt(fractionDigits);
    const scaled = (magnitude * precision + (rounding === "down" ? 0n : unit / 2n)) / unit;

    const whole = (scaled / precision).toString().replace(/\B(?=(\d{3})+(?!\d))/g, GROUP);
    const fraction =
      fractionDigits > 0 ? `${DECIMAL}${(scaled % precision).toString().padStart(fractionDigits, "0")}` : "";

    return `${negative ? "-" : ""}${whole}${fraction}`;
  }

  /** Splits at the decimal point so the tail can be rendered dimmer. */
  function splitFigure(value: string): { lead: string; tail: string } {
    const dot = value.indexOf(DECIMAL);
    if (dot === -1) return { lead: value, tail: "" };
    return { lead: value.slice(0, dot), tail: value.slice(dot) };
  }

  /** Grouped thousands, fixed decimals, never scientific notation. */
  function formatAmount(value: bigint, decimals: number, fractionDigits = 4): string {
    return formatFixed(value, decimals, fractionDigits);
  }

  /** WAD-scaled ratios as a percentage: 8e17 -> "80.00%". */
  function formatPercent(wad: bigint, fractionDigits = 2): string {
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
   *
   * Rounded down, towards the line, never half-up. Half-up printed 0.995 as
   * "1.00": a position anyone could already liquidate, shown as sitting exactly
   * on the line, beside copy saying liquidation starts *below* 1.00. Every
   * figure within a hundredth of the line was off in the direction that
   * reassures. Rounding down can only ever show a position as slightly less
   * healthy than it is.
   */
  function formatHealthFactor(wad: bigint, fractionDigits = 2): string | null {
    if (!hasDebt(wad)) return null;
    if (wad > HEALTH_DISPLAY_CEILING) return "999+";
    return formatFixed(wad, 18, fractionDigits, "down");
  }

  /**
   * A per-second WAD rate as an annual percentage.
   *
   * Simple, not compounded, because that is how the pool accrues — showing a
   * compounded APY beside a contract that charges simple interest would
   * overstate what a borrower actually pays.
   */
  function formatApr(ratePerSecond: bigint, fractionDigits = 2): string {
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
   *
   * The unit letters come from `Intl` in the app's locale rather than from the
   * catalog (GHO-117): "h", "m" and "s" are the locale's own narrow units, and
   * spelling them in `en.json` would be copying data `Intl` already has.
   */
  function formatDuration(seconds: bigint): string {
    if (seconds === 0n) return formatUnit("second", 0n);

    const hours = seconds / 3600n;
    const minutes = (seconds % 3600n) / 60n;
    const rest = seconds % 60n;

    const parts: string[] = [];
    if (hours > 0n) parts.push(formatUnit("hour", hours));
    if (minutes > 0n) parts.push(formatUnit("minute", minutes));
    // Seconds are dropped once there is an hour on the front: "1h 0m 3s" is
    // precision nobody asked for on a deadline measured in hours.
    if (rest > 0n && hours === 0n) parts.push(formatUnit("second", rest));

    return parts.join(" ");
  }

  /** One quantity in the locale's narrow unit: "5m", "1h", "90s". */
  function formatUnit(name: "hour" | "minute" | "second", value: bigint): string {
    return new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "narrow" }).format(value);
  }

  /**
   * A count — a block number, a number of rounds — grouped the same way as
   * every amount (GHO-117). `toLocaleString()` used the browser's locale, so a
   * German browser showed block 1.234.567 beside an amount of 1,234.
   */
  function formatInteger(value: bigint | number): string {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
  }


  /**
   * A moment in the reader's own time zone, with the month spelled out:
   * "Sep 28, 2026, 2:48:33 PM".
   *
   * Spelled out, not numeric (GHO-117). With one app locale, "9/10/2026" is
   * month-first for everyone, and most of the world reads it as 9 October.
   *
   * The time zone is deliberately the viewer's, as it was: everything that
   * calls this renders from a client-side read, after hydration, so there is
   * no server render in some other zone for it to disagree with.
   */
  function formatDateTime(at: Instant): string {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(at));
  }

  /** A time of day to the second, in the reader's zone: "2:48:33 PM". */
  function formatTime(at: Instant): string {
    return new Intl.DateTimeFormat(locale, { timeStyle: "medium" }).format(new Date(at));
  }

  /** A time of day to the minute, in the reader's zone: "2:48 PM". */
  function formatClock(at: Instant): string {
    return new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(new Date(at));
  }

  /**
   * A time of day in UTC on a 24-hour clock, "13:48:33", for a figure somebody
   * is meant to check against a feed's own timestamps, which are UTC.
   */
  function formatUtcTime(at: Instant): string {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZone: "UTC",
    }).format(new Date(at));
  }

  /**
   * A signed percentage from a plain number: 0.42 → "+0.42%". For figures that
   * are already small numbers (a move in basis points / 100), not WAD ratios.
   *
   * Signed always, including zero: "0.00%" without a sign reads as "no data"
   * next to a figure that does carry one.
   */
  function formatSignedPercent(value: number, fractionDigits = 2): string {
    const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
    const digits = new Intl.NumberFormat(locale, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(Math.abs(value));
    return `${sign}${digits}%`;
  }

  const format = {
    splitFigure,
    formatAmount,
    formatPercent,
    formatHealthFactor,
    formatApr,
    formatDuration,
    formatUnit,
    formatInteger,
    formatDateTime,
    formatTime,
    formatClock,
    formatUtcTime,
    formatSignedPercent,
  };
  cache.set(locale, format);
  return format;
}

export type Format = {
  splitFigure(value: string): { lead: string; tail: string };
  formatAmount(value: bigint, decimals: number, fractionDigits?: number): string;
  formatPercent(wad: bigint, fractionDigits?: number): string;
  formatHealthFactor(wad: bigint, fractionDigits?: number): string | null;
  formatApr(ratePerSecond: bigint, fractionDigits?: number): string;
  formatDuration(seconds: bigint): string;
  formatUnit(name: "hour" | "minute" | "second", value: bigint): string;
  formatInteger(value: bigint | number): string;
  formatDateTime(at: Instant): string;
  formatTime(at: Instant): string;
  formatClock(at: Instant): string;
  formatUtcTime(at: Instant): string;
  formatSignedPercent(value: number, fractionDigits?: number): string;
};

const cache = new Map<string, Format>();

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
