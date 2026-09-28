"use client";

import { Toaster as Sonner } from "sonner";

/**
 * Where toasts appear (GHO-104).
 *
 * `sonner` (MIT, zero dependencies, pinned exact) for the queueing, stacking,
 * swipe-to-dismiss and `aria-live` announcements, which are the parts that
 * are easy to get wrong by hand. Its look is switched off (`unstyled`) and
 * replaced with our tokens: one flat surface, a border, no blur or shadow
 * (DESIGN.md).
 *
 * Bottom-right on a desktop. On a phone, bottom-centre and lifted clear of
 * the floating tab bar and the home indicator, so a toast never covers the
 * nav the thumb is heading for.
 */
export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      theme="dark"
      visibleToasts={3}
      // Listed, not piled. The collapsed stack relies on sonner's own styles,
      // which are off here, and with them off the back toast's text showed
      // through the front one. Three at most, so a list stays short.
      expand
      mobileOffset={{ bottom: "calc(6rem + env(safe-area-inset-bottom, 0px))" }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "flex w-full items-start gap-3 rounded-card border border-border bg-raised p-4 text-sm text-ink sm:w-[22rem]",
          title: "font-medium",
          description: "mt-0.5 text-xs text-ink-muted",
          icon: "mt-0.5 shrink-0",
          actionButton:
            "ml-auto shrink-0 cursor-pointer rounded-control bg-action px-3 py-1.5 text-xs font-medium text-ground",
          success: "[&_[data-icon]]:text-positive",
          error: "[&_[data-icon]]:text-negative",
          warning: "[&_[data-icon]]:text-warning",
          loading: "[&_[data-icon]]:text-ink-muted",
        },
      }}
    />
  );
}
