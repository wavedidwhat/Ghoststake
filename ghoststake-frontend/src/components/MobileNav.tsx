"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { TAB_LINKS, isCurrent, moreSections } from "@/lib/nav";
import { useIsOperator } from "@/hooks/useIsOperator";
import { Sheet } from "@/components/Sheet";

/**
 * The phone navigation: four destinations and a More sheet, fixed to the
 * bottom of the screen (GHO-59).
 *
 * Bottom rather than a hamburger at the top, because this app is used one
 * handed on a phone that is mostly out of thumb reach at the top edge. Five
 * targets is the ceiling at 390px: 390 ÷ 5 = 78px each, comfortably over the
 * 44px minimum, and a sixth would start crowding the labels.
 *
 * Everything else — Borrow, Activity, Lend, Liquidate, Operator — lives
 * behind More rather than being dropped. Which four are promoted is GHO-62's
 * call; this only has to make them reachable.
 */
export function MobileNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  // The operator console is listed only for the wallet that owns a market
  // (GHO-62). The route stays reachable by URL for everyone.
  const sections = moreSections(useIsOperator());

  const moreIsCurrent = sections.some((section) =>
    section.items.some((item) => isCurrent(pathname, item.href)),
  );

  return (
    <>
      {/*
       * A floating pill rather than a bar welded to the bottom edge: it
       * reads as a control sitting on the page instead of chrome the page
       * has to work around, and the gap under it is where the iOS home bar
       * goes. The safe-area inset is added to that gap, so the pill rises on
       * a notched phone rather than sitting under the system gesture area,
       * where a tap either does nothing or goes home.
       */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom,0px))] z-40 rounded-card border border-border bg-raised md:hidden"
      >
        <ul className="grid grid-cols-5">
          {TAB_LINKS.map((item) => {
            const current = isCurrent(pathname, item.href);
            return (
              <li key={item.href} className="min-w-0">
                <Link
                  href={item.href}
                  aria-current={current ? "page" : undefined}
                  className={`m-1 flex min-h-[3rem] flex-col items-center justify-center gap-1 rounded-control px-0.5 py-2 text-xs transition-colors ${
                    current ? "bg-ground text-ink" : "text-ink-muted"
                  }`}
                >
                  {/* The current tab is marked by its own filled panel and a
                      rule above the label, not by colour alone, so it still
                      reads in greyscale. */}
                  <span
                    aria-hidden="true"
                    className={`h-0.5 w-5 rounded-full ${current ? "bg-brand" : "bg-transparent"}`}
                  />
                  <span className="display w-full truncate text-center text-[0.65rem] tracking-normal uppercase">
                    {item.short ?? item.label}
                  </span>
                </Link>
              </li>
            );
          })}

          <li className="min-w-0">
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-expanded={moreOpen}
              className={`m-1 flex min-h-[3rem] w-full cursor-pointer flex-col items-center justify-center gap-1 rounded-control px-0.5 py-2 text-xs transition-colors ${
                moreIsCurrent ? "bg-ground text-ink" : "text-ink-muted"
              }`}
            >
              <span
                aria-hidden="true"
                className={`h-0.5 w-5 rounded-full ${moreIsCurrent ? "bg-brand" : "bg-transparent"}`}
              />
              <span className="display w-full truncate text-center text-[0.65rem] tracking-normal uppercase">More</span>
            </button>
          </li>
        </ul>
      </nav>

      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="Everything else">
        <div className="flex flex-col gap-5">
          {sections.map((section) => (
            <div key={section.section}>
              <p className="px-1 pb-2 text-[10px] font-medium tracking-wider text-ink-faint uppercase">
                {section.section}
              </p>
              <div className="flex flex-col">
                {section.items.map((item) =>
                  item.ready ? (
                    <Link
                      key={item.href}
                      href={item.href}
                      // Closed on the tap that navigates rather than in an
                      // effect on `pathname`: a route change is the only way
                      // out of here, and setting state from an effect makes
                      // the sheet flash closed on every unrelated navigation.
                      onClick={() => setMoreOpen(false)}
                      className={`flex min-h-11 items-center justify-between border-b border-border px-1 py-3 text-sm last:border-b-0 ${
                        isCurrent(pathname, item.href) ? "text-ink" : "text-ink-muted"
                      }`}
                    >
                      <span className="display text-base uppercase">{item.label}</span>
                      {item.note && <span className="text-xs text-ink-faint">{item.note}</span>}
                    </Link>
                  ) : (
                    <span
                      key={item.href}
                      className="flex min-h-11 items-center justify-between border-b border-border px-1 py-3 text-sm text-ink-faint last:border-b-0"
                    >
                      <span className="display text-base uppercase">{item.label}</span>
                      {item.note && <span className="text-xs">{item.note}</span>}
                    </span>
                  ),
                )}
              </div>
            </div>
          ))}
        </div>
      </Sheet>
    </>
  );
}
