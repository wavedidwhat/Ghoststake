/**
 * A placeholder the size of what is loading (GHO-96).
 *
 * Size it to the thing it stands in for, so the layout does not jump when the
 * figure arrives. A `span` rather than a `div` so it is valid anywhere the
 * figure would be — inside a `<p>` or a `<button>` as well as a block.
 */
export function Skeleton({
  className = "",
  shape = "line",
}: {
  /** Size and spacing only; the radius comes from `shape`. */
  className?: string;
  /** `card` when it stands in for a whole card rather than a figure. */
  shape?: "line" | "card";
}) {
  const radius = shape === "card" ? "rounded-card" : "rounded";
  return (
    <span
      aria-hidden="true"
      className={`block animate-pulse bg-raised ${radius} ${className}`.trim()}
    />
  );
}
