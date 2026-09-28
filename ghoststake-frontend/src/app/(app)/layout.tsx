import type { ReactNode } from "react";
import { MobileNav } from "@/components/MobileNav";
import { NetworkGuard } from "@/components/NetworkGuard";
import { Sidebar } from "@/components/Sidebar";
import { Toaster } from "@/components/ui/Toaster";

/**
 * The frame every screen sits in: the sidebar, the phone tab bar and the
 * network banner (GHO-96).
 *
 * This used to be inside `AppShell`, which every screen rendered for itself,
 * so each navigation tore the sidebar down and built a new one. A layout is
 * the one place Next keeps mounted across navigations within it, which is
 * what a frame is.
 *
 * The page's own header (title, wallet) stays with the page in `Page`,
 * because the title is the page's to say and a layout cannot read it without
 * a context that every page would then have to remember to set.
 *
 * `(app)` is a route group: it names this layout without adding a URL
 * segment. `error.tsx`, `not-found.tsx` and `/e2e/throw` sit outside it on
 * purpose — a fallback built from the frame that may have thrown is a
 * fallback that throws (GHO-85).
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <NetworkGuard />
        {children}
      </div>

      <MobileNav />
      {/* In the frame, so a toast outlives the page that raised it (GHO-104). */}
      <Toaster />
    </div>
  );
}
