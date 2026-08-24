import { splitFigure } from "@/lib/format";

/**
 * A figure with its decimal tail dimmed, so the value stays glanceable
 * without rounding away digits a user may want to check.
 *
 * Always tabular: these poll on a timer, and proportional digits change
 * width as they change value, so the layout would shift on every update.
 */
export function Figure({
  value,
  unit,
  size = "figure",
  tone = "default",
}: {
  value: string;
  unit?: string;
  size?: "figure" | "display" | "stat";
  tone?: "default" | "positive" | "negative" | "warning" | "muted";
}) {
  const { lead, tail } = splitFigure(value);

  const sizeClass = {
    display: "text-display",
    figure: "text-figure",
    stat: "text-2xl",
  }[size];

  const toneClass = {
    default: "text-ink",
    positive: "text-positive",
    negative: "text-negative",
    warning: "text-warning",
    muted: "text-ink-muted",
  }[tone];

  return (
    <span className={`tabular font-medium ${sizeClass} ${toneClass}`}>
      {lead}
      {tail && <span className="opacity-45">{tail}</span>}
      {unit && <span className="ml-1.5 text-base font-normal text-ink-faint">{unit}</span>}
    </span>
  );
}
