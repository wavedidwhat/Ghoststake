import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ArrowSquareOut } from "@phosphor-icons/react";

import { explorerAddressUrl, explorerHomeUrl, explorerTxUrl, shortHash } from "@/lib/activity";

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
 *
 * `home` links the explorer's front page instead, for the network badge
 * (GHO-127), which names a chain rather than anything on it.
 */
export function ExplorerLink({
  tx,
  address,
  home,
  children,
  className = "",
}: {
  /** Exactly one of `tx`, `address` or `home`. */
  tx?: string;
  address?: string;
  home?: boolean;
  /** What to show. Defaults to the shortened hash or address. */
  children?: ReactNode;
  className?: string;
}) {
  const t = useTranslations("explorer");
  const href = tx ? explorerTxUrl(tx) : address ? explorerAddressUrl(address) : home ? explorerHomeUrl() : undefined;
  const value = tx ?? address ?? href ?? "";
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
      <span className="sr-only">{t("newTab")}</span>
    </a>
  );
}
