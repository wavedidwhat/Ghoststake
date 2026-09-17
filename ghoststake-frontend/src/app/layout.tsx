import type { Metadata } from "next";
import localFont from "next/font/local";
import { connection } from "next/server";
import "./globals.css";
import { Providers } from "@/components/providers";
import { env } from "@/lib/env";

/*
 * Three self-hosted faces from Fontshare (GHO-58). `next/font/local` serves
 * the official .woff2 files unchanged and adds no network request, which
 * matters twice over here: the ITF Free Font License forbids subsetting and
 * format conversion, and a font fetched from a third party would need another
 * `font-src` in the CSP (GHO-66).
 *
 * Geist was dropped because it is Vercel's default and reads as "scaffold".
 */
const nippo = localFont({
  src: [
    { path: "../fonts/Nippo-400.woff2", weight: "400", style: "normal" },
    { path: "../fonts/Nippo-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-nippo",
  display: "swap",
  // Nippo is display-only, so a missing glyph should fall back to the UI face
  // rather than to a serif.
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"],
});

const technor = localFont({
  src: [
    { path: "../fonts/Technor-400.woff2", weight: "400", style: "normal" },
    { path: "../fonts/Technor-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-technor",
  display: "swap",
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"],
});

const tabular = localFont({
  src: [
    { path: "../fonts/Tabular-400.woff2", weight: "400", style: "normal" },
    { path: "../fonts/Tabular-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-tabular",
  display: "swap",
  fallback: ["ui-monospace", "monospace"],
});

export const metadata: Metadata = {
  metadataBase: new URL(env.appUrl),
  title: "GhostStake",
  description: "Stake, borrow against it, and take a position — without unwinding.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page renders per request so it can carry this request's CSP nonce
  // (src/proxy.ts). A prerendered page has no nonce, so under the CSP its own
  // scripts would be blocked and the app would render but never hydrate.
  await connection();

  return (
    <html
      lang="en"
      className={`${nippo.variable} ${technor.variable} ${tabular.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
