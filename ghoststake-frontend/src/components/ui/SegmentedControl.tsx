"use client";

/**
 * Two or three mutually exclusive modes of one form — Supply / Withdraw,
 * Borrow / Repay (GHO-96).
 *
 * The three hand-rolled copies had no `type="button"` and nothing telling a
 * screen reader which mode was on; the only signal was a background colour.
 * `aria-pressed` on each option says it.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  /** What the choice is, for assistive tech. Not rendered. */
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1 rounded-control bg-raised p-1">
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`flex-1 cursor-pointer rounded-[calc(var(--radius-control)-0.25rem)] px-3 py-2 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 ${
              on ? "bg-surface text-ink" : "text-ink-muted hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
