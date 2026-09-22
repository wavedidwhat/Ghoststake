/**
 * Reading an amount someone typed, and saying why one cannot be read.
 *
 * Pure, and apart from AmountField, so the rule and the message about the rule
 * are one module and can be tested together (GHO-86): the bug was a refusal
 * nobody explained, which is what happens when the two drift apart.
 */

/** Parses the field back to a bigint. Returns null for anything unusable. */
export function parseAmount(input: string, decimals: number): bigint | null {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed === ".") return null;

  const [whole = "0", fraction = ""] = trimmed.split(".");
  // Extra precision is rejected rather than truncated: silently dropping a
  // digit changes the amount the user asked for.
  if (fraction.length > decimals) return null;

  try {
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  } catch {
    return null;
  }
}

/**
 * Why `input` cannot be used as an amount of a `decimals`-place token, or null
 * if it can — or if it is simply not finished yet ("" or "."), which is a
 * field being typed into, not a mistake.
 */
export function amountProblem(input: string, decimals: number): string | null {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed === ".") return null;
  const fraction = trimmed.split(".")[1] ?? "";
  if (fraction.length > decimals) {
    return decimals === 0
      ? "This token has no decimal places."
      : `This token has ${decimals} decimal places; that amount has ${fraction.length}.`;
  }
  return parseAmount(trimmed, decimals) === null ? "Not an amount." : null;
}
