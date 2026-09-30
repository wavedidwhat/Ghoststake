import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { connection } from "next/server";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import "./globals.css";
import { Misconfigured } from "@/components/Misconfigured";
import { Providers } from "@/components/providers";
import { configProblems } from "@/lib/config";
import { env } from "@/lib/env";
import { THEME_COLOR } from "@/lib/theme";

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

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("app");
  return {
    metadataBase: new URL(env.appUrl),
    title: t("title"),
    description: t("description"),
  };
}

/**
 * `viewportFit: "cover"` lets the app paint into the rounded corners and the
 * home-bar strip on a notched phone; every fixed element then has to add the
 * safe-area inset itself (the tab bar and the sheets do). `themeColor` is
 * what iOS and Android tint the status bar with, and without it a standalone
 * PWA gets a white band above an olive app.
 *
 * `maximumScale` is deliberately left alone: capping zoom is the oldest
 * accessibility mistake in mobile web, and this app is full of figures
 * someone may well want to enlarge.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: THEME_COLOR,
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page renders per request so it can carry this request's CSP nonce
  // (src/proxy.ts). A prerendered page has no nonce, so under the CSP its own
  // scripts would be blocked and the app would render but never hydrate.
  await connection();
  const locale = await getLocale();

  return (
    <html
      lang={locale}
      className={`${nippo.variable} ${technor.variable} ${tabular.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        {/* Outside the config check so `Misconfigured` can use the catalog
            too: messages are a static import, so they cannot be what a bad
            deployment variable broke. Server components read them through
            src/i18n/request.ts; this is what hands them to client ones. */}
        <NextIntlClientProvider>
        {/* Instead of the app, not around it (GHO-85): with a bad address or
            chain id, the providers would be built against a placeholder, and
            every figure on every page would be a plausible wrong one. */}
        {configProblems.length > 0 ? (
          <Misconfigured problems={configProblems} />
        ) : (
          <Providers>{children}</Providers>
        )}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
