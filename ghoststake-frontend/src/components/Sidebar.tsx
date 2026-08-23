"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The left rail from the Stakent reference. Sections that do not exist yet
 * are rendered as disabled with the issue that will build them, rather than
 * omitted — it keeps the shape of the finished app visible during a demo,
 * and a dead link is worse than a labelled one.
 */
const NAV = [
  { href: "/", label: "Dashboard", ready: true },
  { href: "/vault", label: "Vault", ready: false, note: "GHO-18" },
  { href: "/borrow", label: "Borrow", ready: false, note: "GHO-18" },
  { href: "/rounds", label: "Rounds", ready: false, note: "GHO-18" },
  { href: "/history", label: "History", ready: false, note: "GHO-17" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface/40">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="grid size-8 place-items-center rounded-lg bg-accent text-sm font-bold text-ground">
          G
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">GhostStake</div>
          <div className="text-xs text-ink-faint">Stake. Borrow. Position.</div>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5 px-3 py-2">
        {NAV.map((item) =>
          item.ready ? (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-lg px-3 py-2 text-sm transition ${
                pathname === item.href
                  ? "bg-raised font-medium text-ink"
                  : "text-ink-muted hover:text-ink"
              }`}
            >
              {item.label}
            </Link>
          ) : (
            <span
              key={item.href}
              className="flex cursor-not-allowed items-center justify-between rounded-lg px-3 py-2 text-sm text-ink-faint"
            >
              {item.label}
              <span className="text-[10px] tracking-wide uppercase">{item.note}</span>
            </span>
          ),
        )}
      </nav>

      <div className="mt-auto p-4">
        <div className="rounded-card border border-border bg-surface p-3 text-xs leading-relaxed text-ink-faint">
          Read-only. Deposits, borrowing, and positions land in GHO-18.
        </div>
      </div>
    </aside>
  );
}
