import type { ReactNode } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react";

import { explorerAddressUrl, explorerTxUrl, shortHash } from "@/lib/activity";

/**
 * A transaction or contract, linked to the chain's own explorer (GHO-103).
 *
 * The pitch is "anyone can check it", and this is the checking: every hash
 * and every contract that holds or decides money should lead somewhere that
 * isn't us. One component so they all look the same, with the same small
 * arrow that says "this leaves the app", and so none of them builds an
 * explorer URL by hand (a guard in design.test.ts holds that).
 *
 * Where the chain has no explorer (a local anvil) it renders the text
 * unlinked. A link that goes nowhere is worse than none.
 */
export function ExplorerLink({
  tx,
  address,
  children,
  className = "",
}: {
  /** Exactly one of `tx` or `address`. */
  tx?: string;
  address?: string;
  /** What to show. Defaults to the shortened hash or address. */
  children?: ReactNode;
  className?: string;
}) {
  const value = tx ?? address ?? "";
  const href = tx ? explorerTxUrl(tx) : address ? explorerAddressUrl(address) : undefined;
  const label = children ?? <span className="font-mono">{shortHash(value)}</span>;

  if (!href) return <span className={className}>{label}</span>;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={value}
      className={`inline-flex items-center gap-1 underline-offset-2 hover:text-ink hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none ${className}`.trim()}
    >
      {label}
      <ArrowSquareOut aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only">(opens the explorer in a new tab)</span>
    </a>
  );
}
