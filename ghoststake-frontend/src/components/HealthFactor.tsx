import { Figure } from "./Figure";
import { formatHealthFactor, healthBand, type HealthBand } from "@/lib/format";

/**
 * Shown when the contract reports the position liquidatable, which is the
 * authoritative answer — the bands below are only a reading of the ratio.
 */
const LIQUIDATABLE = {
  label: "Liquidatable",
  detail:
    "This position is below the liquidation threshold now. Anyone may repay part of the debt and claim collateral at a bonus until it is healthy again.",
};

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
export function HealthFactorCard({
  value,
  liquidatable = false,
}: {
  value: bigint | undefined;
  liquidatable?: boolean;
}) {
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

  // A liquidatable position always renders at the loudest band, whatever the
  // ratio reads: the contract's answer accounts for the threshold, the
  // ratio's own banding does not.
  const band = liquidatable ? "danger" : healthBand(value);
  const formatted = formatHealthFactor(value);
  const style = STYLES[band];
  const copy = liquidatable ? LIQUIDATABLE : COPY[band];

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

      <div className="mt-4 flex items-end gap-3" aria-live="polite">
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
      {/* The middle label is positioned against the tick, not spaced evenly.
          Under `justify-between` it centred at 50% while the line it names
          sits at 33% — on a risk scale, a marker pointing at the wrong value
          is worse than no marker. */}
      <div className="relative mt-2 h-4 text-[11px] text-ink-faint">
        <span className="absolute left-0">0</span>
        <span className="absolute left-1/3 -translate-x-1/2 whitespace-nowrap">
          1.00 liquidation
        </span>
        <span className="absolute right-0">3.00+</span>
      </div>
    </div>
  );
}
