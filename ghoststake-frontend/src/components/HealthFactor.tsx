import { Figure } from "./Figure";
import { formatHealthFactor, healthBand, type HealthBand } from "@/lib/format";

const COPY: Record<HealthBand, { label: string; detail: string }> = {
  none: {
    label: "No debt",
    detail: "Nothing is borrowed against this collateral, so it cannot be liquidated.",
  },
  safe: {
    label: "Healthy",
    detail: "Comfortably above the liquidation threshold.",
  },
  caution: {
    label: "Watch",
    detail: "Interest accrues every second. Repay or add collateral to build room.",
  },
  danger: {
    label: "At risk",
    detail:
      "Close to the liquidation threshold. Below 1.00 anyone may liquidate part of this position for a bonus.",
  },
};

const STYLES: Record<HealthBand, { border: string; chip: string }> = {
  none: { border: "border-border", chip: "bg-raised text-ink-muted" },
  safe: { border: "border-border", chip: "bg-positive-soft text-positive" },
  caution: { border: "border-warning/40", chip: "bg-warning-soft text-warning" },
  danger: { border: "border-negative/60", chip: "bg-negative-soft text-negative" },
};

/**
 * Health factor, styled by band rather than at a constant volume: a card that
 * looks the same at 3.0 and at 1.05 conveys nothing, since the number only
 * matters when it is small.
 *
 * Bands come from `healthBand`, which warns above the contract's 1.0 line.
 */
export function HealthFactorCard({ value }: { value: bigint | undefined }) {
  if (value === undefined) {
    return (
      <div className="rounded-card border border-border bg-surface p-6">
        <span className="text-xs font-medium tracking-wide text-ink-muted uppercase">
          Health factor
        </span>
        <div className="mt-3 h-9 w-28 animate-pulse rounded bg-raised" />
      </div>
    );
  }

  const band = healthBand(value);
  const formatted = formatHealthFactor(value);
  const style = STYLES[band];
  const copy = COPY[band];

  return (
    <div className={`rounded-card border bg-surface p-6 ${style.border}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium tracking-wide text-ink-muted uppercase">
          Health factor
        </span>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${style.chip}`}>
          {copy.label}
        </span>
      </div>

      <div className="mt-4 flex items-end gap-3">
        {/* null means no lien, not a formatting failure. See NO_DEBT. */}
        {formatted === null ? (
          <span className="text-figure font-medium text-ink-faint">—</span>
        ) : (
          <Figure
            value={formatted}
            size="display"
            tone={band === "danger" ? "negative" : band === "caution" ? "warning" : "positive"}
          />
        )}
      </div>

      {formatted !== null && <HealthScale value={value} band={band} />}

      <p className="mt-4 text-sm leading-relaxed text-ink-muted">{copy.detail}</p>
    </div>
  );
}

/**
 * Position against a fixed 1.00 liquidation line, so the distance to it is
 * readable. A bar that only fills states a value without placing it.
 */
function HealthScale({ value, band }: { value: bigint; band: HealthBand }) {
  const asNumber = Number(value) / 1e18;
  // Clamped at 3.0. Beyond it the exact figure stops mattering, and letting
  // the scale grow would compress the region near 1.0 that does.
  const position = Math.min(asNumber / 3, 1) * 100;
  const fill = band === "danger" ? "bg-negative" : band === "caution" ? "bg-warning" : "bg-positive";

  return (
    <div className="mt-5">
      <div className="relative h-1.5 rounded-full bg-raised">
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${fill}`}
          style={{ width: `${position}%` }}
        />
        {/* 1.00, at one third of the 0–3 range. */}
        <div className="absolute inset-y-[-4px] left-1/3 w-px bg-border-strong" />
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-ink-faint">
        <span>0</span>
        <span className="ml-[-1rem]">1.00 liquidation</span>
        <span>3.00+</span>
      </div>
    </div>
  );
}
