"use client";

import { useId } from "react";
import { formatAmount } from "@/lib/format";
import type { TxState } from "@/hooks/useTransaction";

/**
 * An amount input backed by a bigint, with the balance it is bounded by.
 *
 * The value is held as a string and parsed on submit rather than round-tripped
 * through a number. Parsing to a float first loses precision on anything past
 * ~15 digits and would silently propose an amount the chain rejects — the same
 * class of bug the fourth audit found in the display path.
 */
export function AmountField({
  label,
  value,
  onChange,
  max,
  decimals,
  symbol,
  maxLabel = "Max",
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  max: bigint | undefined;
  decimals: number;
  symbol: string;
  maxLabel?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium tracking-wide text-ink-muted uppercase">
          {label}
        </label>
        {max !== undefined && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(toDecimalString(max, decimals))}
            className="cursor-pointer text-xs text-ink-faint transition-colors hover:text-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed"
          >
            {maxLabel} <span className="tabular">{formatAmount(max, decimals, 2)}</span>
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 rounded-lg border border-border bg-raised px-3 py-2 focus-within:border-border-strong">
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(sanitise(e.target.value))}
          disabled={disabled}
          inputMode="decimal"
          placeholder="0.00"
          className="tabular w-full bg-transparent text-lg text-ink outline-none placeholder:text-ink-faint disabled:cursor-not-allowed disabled:opacity-60"
        />
        <span className="text-sm text-ink-faint">{symbol}</span>
      </div>

      {hint && <p className="text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

/** Digits and a single decimal point. Anything else is dropped as it is typed. */
function sanitise(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const [whole, ...rest] = cleaned.split(".");
  return rest.length > 0 ? `${whole}.${rest.join("")}` : whole;
}

/**
 * bigint to a plain decimal string, exactly.
 *
 * Used by the Max button, so it must not round: proposing a rounded-up maximum
 * produces a transaction the chain refuses, and a rounded-down one silently
 * leaves dust behind.
 */
function toDecimalString(value: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const whole = value / unit;
  const fraction = value % unit;
  if (fraction === 0n) return whole.toString();
  const padded = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${padded}`;
}

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

/** Shared status line for a pending write. */
export function TxStatus({ state }: { state: TxState }) {
  if (state.status === "idle") return null;

  const text =
    state.status === "signing"
      ? "Check your wallet…"
      : state.status === "pending"
        ? "Waiting for confirmation…"
        : state.status === "confirmed"
          ? "Confirmed."
          : state.status === "cancelled"
            ? "Cancelled."
            : state.message;

  const tone =
    state.status === "confirmed"
      ? "text-positive"
      : state.status === "failed"
        ? "text-negative"
        : "text-ink-muted";

  return (
    <p className={`text-xs ${tone}`} role="status" aria-live="polite">
      {text}
    </p>
  );
}
