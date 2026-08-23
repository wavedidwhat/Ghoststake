import { Figure } from "./Figure";
import { formatHealthFactor, healthBand, type HealthBand } from "@/lib/format";

/**
 * The North Star number: "you can always see what's still yours."
 *
 * This component escalates. At rest it is one stat among several; as the
 * position approaches the liquidation line it takes on colour, a border, and
 * a sentence explaining what happens next. That progression is the whole
 * design — a health factor that looks identical at 3.0 and at 1.05 is
 * decoration, because the number only matters when it is small.
 *
 * The bands are UI-side and start well above the contract's 1.0 line. See
 * `healthBand` for why.
 */

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

const STYLES: Record<HealthBand, { border: string; text: string; chip: string }> = {
  none: { border: "border-border", text: "text-ink-muted", chip: "bg-raised text-ink-muted" },
  safe: { border: "border-border", text: "text-positive", chip: "bg-positive-soft text-positive" },
  caution: {
    border: "border-warning/40",
    text: "text-warning",
    chip: "bg-warning-soft text-warning",
  },
  danger: { border: "border-negative/60", text: "text-negative", chip: "bg-negative-soft text-negative" },
};

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
        {/* No lien reads as an em dash, never as the uint256 max sentinel
            the contract returns. See NO_DEBT in lib/format. */}
        {formatted === null ? (
          <span className="text-figure font-medium text-ink-faint">—</span>
        ) : (
          <Figure value={formatted} size="display" tone={
            band === "danger" ? "negative" : band === "caution" ? "warning" : "positive"
          } />
        )}
      </div>

      {formatted !== null && <HealthScale value={value} band={band} />}

      <p className="mt-4 text-sm leading-relaxed text-ink-muted">{copy.detail}</p>
    </div>
  );
}

/**
 * A scale, not a progress bar. The marker sits against a fixed 1.0
 * liquidation line so the distance to it is legible at a glance — a bar that
 * simply fills tells you a value without telling you what it is near.
 */
function HealthScale({ value, band }: { value: bigint; band: HealthBand }) {
  const asNumber = Number(value) / 1e18;
  // Clamped at 3.0: past that the exact figure stops mattering and the
  // marker would otherwise compress the region that does.
  const position = Math.min(asNumber / 3, 1) * 100;
  const fill = band === "danger" ? "bg-negative" : band === "caution" ? "bg-warning" : "bg-positive";

  return (
    <div className="mt-5">
      <div className="relative h-1.5 rounded-full bg-raised">
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${fill}`}
          style={{ width: `${position}%` }}
        />
        {/* The 1.0 liquidation line, at one third of a 0–3 scale. */}
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
