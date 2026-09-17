"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { MORE_SECTIONS, TAB_LINKS, isCurrent } from "@/lib/nav";
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

  const moreIsCurrent = MORE_SECTIONS.some((section) =>
    section.items.some((item) => isCurrent(pathname, item.href)),
  );

  return (
    <>
      {/*
       * `pb-[env(safe-area-inset-bottom)]` keeps the row above the iOS home
       * bar. Without it the last few pixels of every tab sit under the
       * system gesture area, where a tap either does nothing or goes home.
       */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface pb-[env(safe-area-inset-bottom,0px)] md:hidden"
      >
        <ul className="flex">
          {TAB_LINKS.map((item) => {
            const current = isCurrent(pathname, item.href);
            return (
              <li key={item.href} className="flex-1">
                <Link
                  href={item.href}
                  aria-current={current ? "page" : undefined}
                  className={`flex min-h-[3.25rem] flex-col items-center justify-center gap-0.5 px-1 py-2 text-xs transition-colors ${
                    current ? "text-ink" : "text-ink-muted"
                  }`}
                >
                  {/* The current tab is marked by a rule above the label as
                      well as by colour, so it still reads in greyscale. */}
                  <span
                    aria-hidden="true"
                    className={`h-0.5 w-6 ${current ? "bg-brand" : "bg-transparent"}`}
                  />
                  <span className="display text-[0.8rem] uppercase">{item.label}</span>
                </Link>
              </li>
            );
          })}

          <li className="flex-1">
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-expanded={moreOpen}
              className={`flex min-h-[3.25rem] w-full cursor-pointer flex-col items-center justify-center gap-0.5 px-1 py-2 text-xs transition-colors ${
                moreIsCurrent ? "text-ink" : "text-ink-muted"
              }`}
            >
              <span
                aria-hidden="true"
                className={`h-0.5 w-6 ${moreIsCurrent ? "bg-brand" : "bg-transparent"}`}
              />
              <span className="display text-[0.8rem] uppercase">More</span>
            </button>
          </li>
        </ul>
      </nav>

      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="Everything else">
        <div className="flex flex-col gap-5">
          {MORE_SECTIONS.map((section) => (
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
