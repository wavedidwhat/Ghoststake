import type { ReactNode } from "react";

/**
 * The phone form of a table row (GHO-59).
 *
 * The four tables in this app — Activity, Positions, Liquidate, and the terms
 * table — were all `min-w-[48rem]` and up inside an `overflow-x-auto`. That
 * kept the *page* from scrolling sideways, which is why it never looked
 * broken, but on a 390px screen it meant every row had to be dragged
 * horizontally to be read. A sideways-scrolling ledger is not a ledger anyone
 * reads.
 *
 * So under `sm` the table is replaced, not shrunk: one block per row, the
 * thing that identifies the row on top, the rest as label/value pairs. The
 * table keeps the same data from `sm` up, where there is room for columns.
 *
 * Both forms render, and CSS hides one. That is deliberate: the alternative
 * is measuring the viewport in JavaScript, which is wrong on the first paint
 * of a server-rendered page and makes the layout depend on hydration.
 */

/** One row, as a block. `title` is whatever names the row in a list. */
export function RowCard({
  title,
  aside,
  children,
}: {
  title: ReactNode;
  /** Top-right: the one figure or status worth reading before the rest. */
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="border-b border-border/60 px-4 py-3 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">{title}</div>
        {aside && <div className="shrink-0 text-right">{aside}</div>}
      </div>
      {children && <dl className="mt-2 flex flex-col gap-1">{children}</dl>}
    </li>
  );
}

/** A label/value pair inside a `RowCard`. */
export function RowField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt className="shrink-0 text-ink-faint">{label}</dt>
      {/* `min-w-0` so a long hash or a wide figure wraps inside the row
          instead of pushing the page wider than the screen. */}
      <dd className="min-w-0 text-right text-ink-muted">{children}</dd>
    </div>
  );
}

/** The `<ul>` the cards live in. Hidden from `sm` up, where the table shows. */
export function RowList({ children }: { children: ReactNode }) {
  return (
    <ul className="divide-border rounded-card border border-border bg-surface sm:hidden">
      {children}
    </ul>
  );
}
