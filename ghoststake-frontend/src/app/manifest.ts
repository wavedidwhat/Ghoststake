import type { MetadataRoute } from "next";

import { BACKGROUND_COLOR, THEME_COLOR } from "@/lib/theme";

/**
 * Enough of a web app manifest that "Add to Home Screen" gives a real icon
 * and a dark splash rather than a screenshot of the page (GHO-58).
 *
 * `purpose: "maskable"` matters on Android, which crops an icon to whatever
 * shape the launcher uses. The maskable file keeps the mark inside the 80%
 * safe zone; the plain one does not, so it must not claim to be maskable or
 * the arrows get their tips cut off.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "GhostStake",
    short_name: "GhostStake",
    description: "Stake, borrow against it, and take a position — without unwinding.",
    start_url: "/",
    display: "standalone",
    background_color: BACKGROUND_COLOR,
    theme_color: THEME_COLOR,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
