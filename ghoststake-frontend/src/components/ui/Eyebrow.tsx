import type { ComponentPropsWithoutRef, ElementType } from "react";

type Tag = "p" | "span" | "h2" | "h3" | "dt" | "label";

/**
 * The small uppercase label above a figure or a section (GHO-96).
 *
 * The same class string was pasted 25 times. It takes `as` because it sits on
 * six different elements, and the element is the part that matters: a
 * section's label is its heading, a form field's is its `<label>`, and a
 * definition list's is its `<dt>`. Styling one element to look like another
 * is how a screen reader ends up with a page of paragraphs.
 */
export function Eyebrow<T extends Tag = "p">({
  as,
  className = "",
  ...rest
}: { as?: T } & ComponentPropsWithoutRef<T>) {
  // Callers are typed per element through `T`; inside, TypeScript cannot
  // narrow a union of six elements' props, so the spread is widened here.
  const Component: ElementType = as ?? "p";
  const props = rest as Record<string, unknown>;
  return (
    <Component
      className={`text-xs font-medium tracking-wide text-ink-muted uppercase ${className}`.trim()}
      {...props}
    />
  );
}
