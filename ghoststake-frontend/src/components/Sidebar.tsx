"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { isCurrent, sidebarLinks, type NavLink } from "@/lib/nav";
import { useIsOperator } from "@/hooks/useIsOperator";
import { NavIcon } from "./NavIcon";
import { Badge } from "./ui/Badge";

/**
 * Primary navigation from `md` up. Below that it is hidden and `MobileNav`
 * takes over (GHO-59) — the sidebar was a fixed `w-56` with no breakpoint,
 * which left about 170px of content on a 390px screen.
 *
 * The destinations and the reasoning about their order live in `@/lib/nav`,
 * so both navs cannot disagree.
 *
 * Pinned to the window, not the page (GHO-96). In a flex row a child
 * stretches to its tallest sibling, so the sidebar grew to the height of
 * whatever page it sat beside and scrolled away with it — the nav was gone
 * the moment you scrolled a long page. `sticky` + `h-dvh` holds it at
 * window height while the document scrolls. The document still scrolls,
 * rather than an inner `<main>`, because that is what keeps a phone's
 * address bar collapsing, pull-to-refresh, and Next's scroll restoration on
 * back and forward.
 *
 * Icon and label only, nothing else (GHO-100). It used to carry a tagline,
 * five section headings and a note beside every item, which made it tall
 * enough to need its own scrollbar on a laptop and wrapped "Portfolio" into
 * its note. Myriad, the one major prediction market that keeps a sidebar,
 * keeps it to exactly this. It still scrolls if a window is too short for
 * nine rows, but at laptop heights it fits, and a browser test holds it to
 * that.
 */
export function Sidebar() {
  const pathname = usePathname();
  const { main, pinned } = sidebarLinks(useIsOperator());

  return (
    <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-border bg-surface md:flex">
      {/*
       * A wordmark set in Nippo, deliberately a placeholder until Enoch's
       * mark lands (GHO-58). What it replaced — a letter "G" in a rounded
       * square — is one of the most recognisable AI-UI tells there is, and
       * it read as a logo, so nobody would have thought to replace it.
       */}
      <div className="flex h-16 shrink-0 items-center px-5">
        <Link
          href="/"
          className="display text-lg tracking-wide text-brand uppercase focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
        >
          GhostStake
        </Link>
      </div>

      <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-2">
        {main.map((item) => (
          <NavItem key={item.href} item={item} pathname={pathname} />
        ))}
      </nav>

      <div className="flex shrink-0 flex-col gap-0.5 border-t border-border px-3 py-3">
        {pinned.map((item) => (
          <NavItem key={item.href} item={item} pathname={pathname} />
        ))}
        <p className="px-3 pt-2">
          <Badge size="sm">Testnet</Badge>
        </p>
      </div>
    </aside>
  );
}

function NavItem({ item, pathname }: { item: NavLink; pathname: string }) {
  const current = isCurrent(pathname, item.href);
  const row = "flex items-center gap-3 rounded-control px-3 py-2 text-sm";

  if (!item.ready) {
    return (
      <span className={`${row} cursor-not-allowed text-ink-faint`}>
        <NavIcon href={item.href} current={false} className="size-5 shrink-0" />
        <span className="truncate">{item.label}</span>
      </span>
    );
  }

  return (
    <Link
      href={item.href}
      aria-current={current ? "page" : undefined}
      className={`${row} transition-colors focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none ${
        current ? "bg-raised font-medium text-ink" : "text-ink-muted hover:bg-raised/60 hover:text-ink"
      }`}
    >
      <NavIcon href={item.href} current={current} className="size-5 shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}
