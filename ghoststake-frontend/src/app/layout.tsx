import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { connection } from "next/server";
import "./globals.css";
import { Providers } from "@/components/providers";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
