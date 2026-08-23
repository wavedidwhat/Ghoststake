import type { ReactNode } from "react";

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-card border border-border bg-surface p-5 ${className}`}
    >
      {children}
    </div>
  );
}

/** Label above, figure below. The default density for vault state. */
export function Stat({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium tracking-wide text-ink-muted uppercase">
          {label}
        </span>
        {hint && <span className="text-xs text-ink-faint">{hint}</span>}
      </div>
      <div className="mt-3">{children}</div>
    </Card>
  );
}
