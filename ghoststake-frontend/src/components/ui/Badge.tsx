import type { ReactNode } from "react";

/**
 * A short status chip — "stalled", "operator", "unverified" (GHO-96).
 *
 * Warning only, for now, because that is the only one the app uses. A brand
 * chip exists (the phase chip) but carries a countdown and lives with it.
 */
export function Badge({
  children,
  size = "md",
}: {
  children: ReactNode;
  size?: "sm" | "md";
}) {
  const sizeClass = size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-0.5 text-xs";
  return (
    <span
      className={`rounded-sm bg-warning/15 font-semibold tracking-wide text-warning uppercase ${sizeClass}`}
    >
      {children}
    </span>
  );
}
