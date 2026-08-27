"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Primary navigation, ordered as the pipeline runs.
 *
 * Stake → Borrow → Markets is the product in three words, and the order is
 * load-bearing: the collateral is staked first and never leaves, borrowing is
 * secured against it, and only the borrowed funds reach a market. A nav that
 * lists these as unrelated destinations describes a lending app that happens
 * to ship a prediction market.
 *
 * On vocabulary: "stake" means the savings deposit here and nowhere else.
 * A side of a market is a "position". The two are opposite ends of the
 * pipeline and the app used the same word for both, which quietly erased the
 * half the product is named after.
 *
 * Lend sits under its own heading rather than as a fourth pipeline step,
 * because it is not one. A lender is on the other side of the borrow: they
 * fund it, they are paid by it, and they never stake or take a view. Listing
 * it inline would have read as "and then you lend", which is the wrong story
 * about a two-sided market — but leaving it out of the nav is what left the
 * supply side unreachable in the first place (GHO-39).
 */
const NAV = [
  { href: "/", label: "Overview", ready: true },

  { section: "Take a view" },
  { href: "/stake", label: "Stake", ready: true, note: "earn" },
  { href: "/borrow", label: "Borrow", ready: true, note: "against it" },
  { href: "/markets", label: "Markets", ready: true, note: "take a view" },
  { href: "/history", label: "History", ready: false, note: "GHO-17" },

  { section: "Fund it" },
  { href: "/lend", label: "Lend", ready: true, note: "earn the spread" },

  // Last, and separated by what it is rather than by a permission check: the
  // page is reachable by anyone because half of what it does is
  // permissionless, and the contracts say so louder than a hidden link would.
  { section: "Run it" },
  { href: "/operator", label: "Operator", ready: true, note: "run rounds" },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-accent text-sm font-bold text-ground">
            G
          </span>
          <span className="font-semibold text-ink">GhostStake</span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-ink-faint">
          Stake earns. Borrow against it. Take a view — without unwinding.
        </p>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 p-3">
        {NAV.map((item) =>
          "section" in item ? (
            <p
              key={item.section}
              className="mt-3 px-3 pb-1 text-[10px] font-medium tracking-wider text-ink-faint uppercase first:mt-0"
            >
              {item.section}
            </p>
          ) : item.ready ? (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-baseline justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
                pathname === item.href
                  ? "bg-raised font-medium text-ink"
                  : "text-ink-muted hover:bg-raised/60 hover:text-ink"
              }`}
            >
              <span>{item.label}</span>
              {"note" in item && item.note && (
                <span className="text-[11px] text-ink-faint">{item.note}</span>
              )}
            </Link>
          ) : (
            <span
              key={item.href}
              className="flex cursor-not-allowed items-baseline justify-between rounded-lg px-3 py-2 text-sm text-ink-faint"
            >
              <span>{item.label}</span>
              <span className="text-[11px]">{item.note}</span>
            </span>
          ),
        )}
      </nav>

      <div className="border-t border-border px-5 py-4">
        <p className="text-xs leading-relaxed text-ink-faint">
          Testnet. Your stake keeps earning while it backs a position.
        </p>
      </div>
    </aside>
  );
}
