import { splitFigure } from "@/lib/format";

/**
 * A number rendered large, with the decimal tail dimmed.
 *
 * Both reference dashboards do this — `$107,843.82` and `31.39686` — and the
 * reason it works is that the two halves answer different questions. The
 * integer part is what you glance at; the decimals are what you check
 * against your wallet. Dimming the tail keeps the figure legible at a
 * distance without rounding away digits someone might actually need.
 *
 * Always tabular: these numbers update on a timer, and proportional digits
 * would make the layout twitch on every poll.
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
