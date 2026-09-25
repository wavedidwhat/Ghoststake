import type { ComponentPropsWithoutRef } from "react";

/**
 * The one button (GHO-96).
 *
 * Before this, every screen pasted its own class string, and the ~20 copies
 * had drifted: nearly all were `rounded-sm` although DESIGN.md gives anything
 * you press `rounded-control`, three "Try again" buttons had no focus ring,
 * and several had no disabled state. A rule that lives in twenty places is
 * twenty chances to break it.
 *
 * Deliberately not for the market sides. Those are `.pressable` slabs in the
 * colour of the side being taken, and belong to `MarketBlock`; this is the
 * neutral `action` green, the outlined secondary, and amber for a fix-it
 * step like switching network.
 */

type Variant = "action" | "outline" | "warning";
type Size = "sm" | "md" | "lg";

const base =
  "inline-flex cursor-pointer items-center justify-center gap-2 rounded-control text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50";

const variants: Record<Variant, string> = {
  action: "bg-action text-ground hover:bg-action-strong",
  outline: "border border-border text-ink hover:border-border-strong hover:bg-raised/60",
  // Fixing something before anything else can happen: the wrong network, a
  // stalled round. Amber, like every other warning, and never for money.
  warning: "bg-warning text-ground hover:opacity-90",
};

const sizes: Record<Size, string> = {
  sm: "px-3 py-1.5",
  md: "px-4 py-2.5",
  // 44px: the size for a button someone reaches for in a hurry, one-thumbed.
  lg: "min-h-11 px-5 py-2.5",
};

/**
 * The class string on its own, for a `<Link>` or `<a>` that should look like
 * a button. `className` is appended, so use it for layout (margin, width),
 * not to override the variant — without a class merger the later rule does
 * not reliably win.
 */
export function buttonClass({
  variant = "action",
  size = "md",
  className = "",
}: { variant?: Variant; size?: Size; className?: string } = {}) {
  return `${base} ${variants[variant]} ${sizes[size]} ${className}`.trim();
}

export function Button({
  variant,
  size,
  className,
  // A `<button>` in a form defaults to submit. None of ours submit a form;
  // they call a handler, and an accidental submit reloads the page mid-sign.
  type = "button",
  ...rest
}: ComponentPropsWithoutRef<"button"> & { variant?: Variant; size?: Size }) {
  return <button type={type} className={buttonClass({ variant, size, className })} {...rest} />;
}

/**
 * A small underlined action that sits in a line of copy — "stop waiting",
 * "track it on the explorer", "change". Not for anything that moves money.
 */
export function TextButton({
  className = "",
  type = "button",
  ...rest
}: ComponentPropsWithoutRef<"button">) {
  return (
    <button
      type={type}
      className={`cursor-pointer text-xs text-ink-faint underline-offset-2 transition-colors hover:text-ink hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none ${className}`.trim()}
      {...rest}
    />
  );
}
