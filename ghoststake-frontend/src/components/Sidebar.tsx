"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { NAV, isCurrent } from "@/lib/nav";

/**
 * Primary navigation from `md` up. Below that it is hidden and `MobileNav`
 * takes over (GHO-59) — the sidebar was a fixed `w-56` with no breakpoint,
 * which left about 170px of content on a 390px screen.
 *
 * The destinations and the reasoning about their order live in `@/lib/nav`,
 * so both navs cannot disagree.
 */
export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-surface md:flex">
      <div className="border-b border-border px-5 py-4">
        {/*
         * A wordmark set in Nippo, deliberately a placeholder until Enoch's
         * mark lands (GHO-58). What it replaced — a letter "G" in a rounded
         * square — is one of the most recognisable AI-UI tells there is, and
         * it read as a logo, so nobody would have thought to replace it.
         */}
        <div className="flex items-center gap-2.5">
          <span className="display text-lg tracking-wide text-brand uppercase">GhostStake</span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-ink-faint">
          Stake earns. Borrow against it. Take a view — without unwinding.
        </p>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 p-3">
        {NAV.map((section) => (
          <div key={section.section} className="flex flex-col gap-0.5">
            {/* Overview is one item and needs no heading over it. */}
            {section.items.length > 0 && section.section !== "Overview" && (
              <p className="mt-3 px-3 pb-1 text-[10px] font-medium tracking-wider text-ink-faint uppercase">
                {section.section}
              </p>
            )}

            {section.items.map((item) =>
              item.ready ? (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isCurrent(pathname, item.href) ? "page" : undefined}
                  className={`flex items-baseline justify-between rounded-sm px-3 py-2 text-sm transition-colors ${
                    isCurrent(pathname, item.href)
                      ? "bg-raised font-medium text-ink"
                      : "text-ink-muted hover:bg-raised/60 hover:text-ink"
                  }`}
                >
                  <span>{item.label}</span>
                  {item.note && <span className="text-[11px] text-ink-faint">{item.note}</span>}
                </Link>
              ) : (
                <span
                  key={item.href}
                  className="flex cursor-not-allowed items-baseline justify-between rounded-sm px-3 py-2 text-sm text-ink-faint"
                >
                  <span>{item.label}</span>
                  {item.note && <span className="text-[11px]">{item.note}</span>}
                </span>
              ),
            )}
          </div>
        ))}
      </nav>

      <div className="border-t border-border px-5 py-4">
        <p className="text-xs leading-relaxed text-ink-faint">
          Testnet. Your stake keeps earning while it backs a position.
        </p>
      </div>
    </aside>
  );
}
