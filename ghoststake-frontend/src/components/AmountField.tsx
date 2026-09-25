"use client";

import { useId } from "react";
import { amountProblem } from "@/lib/amount";
import { formatAmount } from "@/lib/format";
import { explorerTxUrl } from "@/lib/activity";
import type { useTransaction } from "@/hooks/useTransaction";
import { useStalled } from "@/hooks/useStalled";
import { TextButton } from "@/components/ui/Button";
import { Eyebrow } from "@/components/ui/Eyebrow";

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
  const problem = amountProblem(value, decimals);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <Eyebrow as="label" htmlFor={id}>
          {label}
        </Eyebrow>
        {max !== undefined && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(toDecimalString(max, decimals))}
            className="cursor-pointer text-xs text-ink-faint transition-colors hover:text-action focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:cursor-not-allowed"
          >
            {maxLabel} <span className="tabular">{formatAmount(max, decimals, 2)}</span>
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 rounded-sm border border-border bg-raised px-3 py-2 focus-within:border-border-strong">
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(sanitise(e.target.value))}
          disabled={disabled}
          inputMode="decimal"
          placeholder="0.00"
          aria-invalid={problem !== null}
          aria-describedby={problem ? `${id}-problem` : undefined}
          className="tabular w-full bg-transparent text-lg text-ink outline-none placeholder:text-ink-faint disabled:cursor-not-allowed disabled:opacity-60"
        />
        <span className="text-sm text-ink-faint">{symbol}</span>
      </div>

      {/* Stated at the field (GHO-86). `parseAmount` has always refused an
          amount with more precision than the token, and every form then
          either disabled its button with no reason or — in the position
          sheet — coerced the refusal to zero. The field is the one place
          that knows both the input and the scale, so it says it. */}
      {problem && (
        <p id={`${id}-problem`} role="alert" className="text-xs text-warning">
          {problem}
        </p>
      )}
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

/**
 * How long a mined transaction gets before the wait is called unusual.
 *
 * Much longer than the wallet-prompt window: a transaction that has been sent
 * is genuinely out of everyone's hands, and offering an escape after eight
 * seconds would suggest something is wrong on a chain simply having a normal
 * minute.
 */
const PENDING_STALL_MS = 45_000;

/**
 * Shared status line for a write, with a way out of both waits.
 *
 * Takes the whole transaction rather than its state, so a caller cannot wire
 * up the message and forget the escape — which is how "signing" and "pending"
 * came to be states with no exit across twelve call sites (GHO-83).
 *
 * Neither escape cancels anything. A wallet holding a request cannot be made
 * to give it back, and a sent transaction is on the chain whatever this app
 * does. What they do is stop the interface being held hostage by a wallet that
 * is not going to answer, and the copy is careful not to promise more.
 */
export function TxStatus({ tx }: { tx: ReturnType<typeof useTransaction> }) {
  const { state, attempt, stopWaiting } = tx;

  const signing = state.status === "signing";
  const pending = state.status === "pending";

  const signingStalled = useStalled(signing, attempt);
  const pendingStalled = useStalled(pending, attempt, PENDING_STALL_MS);
  const stalled = signingStalled || pendingStalled;

  if (state.status === "idle") return null;

  const text =
    state.status === "signing"
      ? "Check your wallet\u2026"
      : state.status === "pending"
        ? "Waiting for confirmation\u2026"
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

  // Only while it is in flight. A confirmed or failed transaction has a hash
  // worth linking too, but by then the row that reports it is the place for
  // that, not a status line that is about to disappear.
  const explorer = pending ? explorerTxUrl(state.hash) : undefined;

  return (
    <div className="flex flex-col items-start gap-0.5">
      <p className={`text-xs ${tone}`} role="status" aria-live="polite">
        {text}
      </p>

      {explorer && (
        <a
          href={explorer}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-ink-faint underline-offset-2 transition-colors hover:text-ink hover:underline"
        >
          Track it on the explorer
        </a>
      )}

      {stalled && (
        <TextButton onClick={stopWaiting}>
          {signingStalled
            ? "Your wallet hasn\u2019t answered \u2014 stop waiting"
            : "Still not confirmed \u2014 stop waiting"}
        </TextButton>
      )}
    </div>
  );
}
